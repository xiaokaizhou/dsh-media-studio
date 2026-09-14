import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { CanvasStore, type CanvasOp, type CanvasSnapshot, type CanvasNode } from './canvas-store'
import { join, extname, dirname } from 'node:path'
import { mkdir, writeFile, stat, readdir, unlink } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { getMediaStudioHandles, log } from './service-state'
import { prepareVideoForCanvas, extractPosterInPlace, resolveLocalVideoPath } from './video-cover'
import { prepareImageForCanvas, prepareAudioForCanvas } from './image-cover'

/**
 * Tiny in-process semaphore. Caps the number of in-flight `task` calls to
 * `n`; the rest queue. Used to throttle `prepareVideoForCanvas` (which
 * spawns ffmpeg) so a single batch of N videos doesn't open N parallel
 * ffmpeg processes. Exported so tests can verify the gate.
 */
export function pLimit<T>(n: number): (task: () => Promise<T>) => Promise<T> {
  let active = 0
  const queue: Array<() => void> = []
  const next = (): void => {
    while (active < n && queue.length > 0) {
      const wake = queue.shift()!
      active += 1
      wake()
    }
  }
  return (task) => new Promise<T>((resolve, reject) => {
    queue.push(() => {
      task().then(
        (v) => { active -= 1; next(); resolve(v) },
        (e) => { active -= 1; next(); reject(e) },
      )
    })
    next()
  })
}

/** Max parallel `prepareVideoForCanvas` calls inside one `postProcessCanvasPatch`.
 *  Two is the sweet spot: keeps wall-clock roughly half of serial while not
 *  flooding the disk with parallel ffmpeg rewrites. */
const PREPARE_VIDEO_LIMIT = pLimit(2)

/**
 * M5-⑤ — garbage-collect orphan media files in the project's asset
 * directory. Runs after every `postProcessCanvasPatch` so a long agent
 * iteration that calls `canvas_graph_patch` / refresh dozens of times
 * doesn't leave behind stale `v-*.mp4` / `v-*.poster.jpg` /
 * `v-*.thumb.jpg` / `a-*.mp3` / `img-*.png` files from earlier random-
 * id generations. Files whose basename appears as a referenced
 * `resultUrl` / `poster` value on any loaded canvas are kept; every
 * other stable-prefixed file in the directory is removed.
 *
 * Safety: we never touch files outside `assets/<kind>/` of the target
 * project, and the GC runs after the new persist is already scheduled
 * — a crash between unlink and the next agent patch leaves a few
 * extra files behind but never drops a referenced one.
 */
export async function gcOrphanMedia(
  store: CanvasStore,
  projectId: string,
  sourcePath: string | undefined,
): Promise<{ removed: number; scanned: number }> {
  // Use the canvas store's view of referenced paths. Walking the live
  // `canvases` Map without cloneGraph keeps this O(N × nodes) but with
  // constant memory.
  const refs = store.collectReferencedMediaPaths()
  // The set of "all currently-referenced relative paths" we want to
  // protect. Files on disk are referenced by absolute path; we need to
  // match them against the bare filename portion of the stored value
  // (the values look like `projects/<id>/assets/clips/v-<hex>.mp4`).
  // Comparing basenames is enough because we only ever look inside one
  // project's directory at a time.
  const refBasenames = new Set<string>()
  for (const r of refs) {
    if (typeof r !== 'string') continue
    const idx = r.lastIndexOf('/')
    if (idx >= 0) refBasenames.add(r.slice(idx + 1))
  }

  const projectDir = sourcePath
    ? join(sourcePath, 'assets')
    : join(store.workspaceRootPublic, 'projects', projectId, 'assets')
  // The "stable" prefixes the helpers in video-cover.ts / image-cover.ts
  // produce. Anything matching these prefixes in the project asset dir
  // was created by `prepare*` and is fair game for GC.
  const STABLE_PREFIXES = ['v-', 'a-', 'i-']
  const KINDS = ['clips', 'characters', 'scenes', 'audio']

  let removed = 0
  let scanned = 0
  for (const kind of KINDS) {
    const dir = join(projectDir, kind)
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch { /* directory absent — nothing to GC */ continue }
    for (const entry of entries) {
      // Only touch stable-prefixed files; ignore unrelated user assets.
      if (!STABLE_PREFIXES.some((p) => entry.startsWith(p))) continue
      scanned += 1
      if (refBasenames.has(entry)) continue
      try {
        await unlink(join(dir, entry))
        removed += 1
      } catch { /* race with another writer; skip silently */ }
    }
  }
  return { removed, scanned }
}
import {
  registerCanvasAsset,
  type AssetKind,
  listAssets,
  updateAssetMeta,
  deleteAsset,
  copyAssetToProject,
  scanCanvasRefs,
  ASSET_CATEGORY_DIR,
  newAssetId,
  newAssetFileName,
  assetExtFor,
  loadAssetIndex,
  writeAssetIndex,
} from './asset-store'
import { ProjectDeleteBlockedError } from './project-store'
import { runSearch, addSoftRefToCanvas, resolveAsset } from './search'

/**
 * Canvas workflow rules — appended to every media-studio / canvas_*
 * tool description so the model sees them on every request. The rules
 * ride the plugin itself (not the agent preset) so published users get
 * them automatically without editing their preset. Keep this block
 * terse: it is multiplied by N tool schemas in every prompt.
 *
 * CANVAS WORKFLOW RULES (apply to every media-studio / canvas_* call):
 * 1. NEW PROJECT → CREATE FIRST. When the user's intent is to start a new
 *    project, call media_studio_create_project. The plugin broadcasts a
 *    `project-focused` SSE event that auto-activates the sidebar Media
 *    Studio tab; do not ask the user to open it.
 * 2. CANVAS OPS WITHOUT SIDEBAR → AUTO-OPEN. The Media Studio client-side
 *    listener activates the sidebar tab when the first canvas_* call lands.
 * 3. CONTENT → NODES. Generated content (prompts, scripts, images, music,
 *    video) MUST land on a canvas node, not stay only in chat. After
 *    generate_image / generate_video / generate_music, use canvas_graph_patch
 *    with batchAddMedia to attach the resultUrl to a node.
 * 4. NO EMPTY NODES. After canvas_node_add('text' | 'note'), immediately
 *    follow up with canvas_node_update to fill data.text / data.content. For
 *    image/video/music nodes, use canvas_refresh_node (fills resultUrl from
 *    prompt). Empty nodes show as placeholder cards and should be filled
 *    before moving on.
 * 5. NO ORPHAN NODES. When adding a non-seed node, include a `connect` op
 *    in the same canvas_graph_patch batch linking the new node to its
 *    predecessor (from: prevId, to: newId). Skip only for the first/seed
 *    node or when the user explicitly asks for an isolated node.
 */
const CANVAS_RULES =
  'CANVAS WORKFLOW RULES (apply to every media-studio / canvas_* call):\n' +
  '1. NEW PROJECT → CREATE FIRST. When the user\'s intent is to start a new project, call media_studio_create_project. The plugin broadcasts a `project-focused` SSE event that auto-activates the sidebar Media Studio tab; do not ask the user to open it.\n' +
  '2. CANVAS OPS WITHOUT SIDEBAR → AUTO-OPEN. The Media Studio client-side listener activates the sidebar tab when the first canvas_* call lands.\n' +
  '3. CONTENT → NODES. Generated content (prompts, scripts, images, music, video) MUST land on a canvas node, not stay only in chat. After generate_image / generate_video / generate_music, use canvas_graph_patch with batchAddMedia to attach the resultUrl to a node.\n' +
  '4. NO EMPTY NODES. After canvas_node_add(\'text\' | \'note\'), immediately follow up with canvas_node_update to fill data.text / data.content. For image/video/music nodes, use canvas_refresh_node (fills resultUrl from prompt). Empty nodes show as placeholder cards and should be filled before moving on.\n' +
  '5. NO ORPHAN NODES. When adding a non-seed node, include a `connect` op in the same canvas_graph_patch batch linking the new node to its predecessor (from: prevId, to: newId). Skip only for the first/seed node or when the user explicitly asks for an isolated node.'

/** Map a canvas node type to the asset-library kind for auto-registration.
 *  Canvas `music` nodes hold audio → 'audio' in the library. */
export function assetKindForNodeType(nodeType: CanvasNode['type']): AssetKind | null {
  switch (nodeType) {
    case 'image': return 'character'  // default; project callers can override
    case 'video': return 'clip'
    case 'music': return 'audio'
    default: return null
  }
}

/** Walk a batch of patch ops and pick out newly-added or updated media nodes
 *  (image / video / music) that carry a `resultUrl`. Text / note nodes never
 *  hold media so we skip them. `postNodes` is the canvas graph after the
 *  patch has been applied — we read from it because `updateNode` only sends
 *  the changed fields. */
export function collectMediaNodesFromOps(
  ops: CanvasOp[],
  postNodes: CanvasNode[],
): { nodeId: string; nodeType: CanvasNode['type'] }[] {
  const out: { nodeId: string; nodeType: CanvasNode['type'] }[] = []
  for (const op of ops) {
    if (op.op === 'addNode') {
      if (op.data?.resultUrl && (op.type === 'image' || op.type === 'video' || op.type === 'music')) {
        const nodeId = op.nodeId || ''
        if (nodeId) out.push({ nodeId, nodeType: op.type })
      }
    } else if (op.op === 'updateNode') {
      const merged = postNodes.find((n) => n.id === op.id)
      if (merged && merged.data?.resultUrl && (merged.type === 'image' || merged.type === 'video' || merged.type === 'music')) {
        out.push({ nodeId: merged.id, nodeType: merged.type })
      }
    } else if (op.op === 'batchAddMedia') {
      for (const item of op.items) {
        const nodeId = item.nodeId || ''
        if (nodeId && (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')) {
          const nodeType: CanvasNode['type'] = item.kind === 'audio' ? 'music' : item.kind
          out.push({ nodeId, nodeType })
        }
      }
    }
  }
  return out
}

/** Try to auto-register a newly-patched node's media into the project asset
 *  library. Returns null on success (or if no registration was needed), or
 *  a `warn:`-prefixed advisory string on failure — the same shape the lint
 *  pass already uses in `issues`, so the agent sees one unified list. Never
 *  throws — a failed auto-register must not break the canvas patch the agent
 *  just applied. */
async function tryAutoRegisterAsset(
  projectId: string,
  sourcePath: string | undefined,
  nodeId: string,
  nodeType: CanvasNode['type'],
): Promise<string | null> {
  const kind = assetKindForNodeType(nodeType)
  if (!kind) return null
  const mst = getMediaStudioHandles()
  try {
    await registerCanvasAsset({
      wsRoot: mst.workspaceRoot,
      roots: mst.mediaRoots ?? [],
      canvasStore: mst.canvasStore,
      projectId,
      sourcePath,
      canvasNodeId: nodeId,
      kind,
    })
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `node "${nodeId}" (${nodeType}) has resultUrl but auto-register failed: ${msg}. ` +
      `Call POST /api/media-studio/assets/register with {projectId, kind, canvasNodeId} to link it.`
  }
}

/**
 * Migrate one canvas node whose resultUrl points to a file outside the
 * media-file proxy's allow-list (e.g. a `file:///tmp/…` path, an absolute
 * POSIX path under a directory not in `mediaRoots`, or a non-proxy URL the
 * dsh-llm-multimodal plugin handed back). Copies the file into the project's
 * asset directory and rewrites resultUrl to the project-relative
 * `projects/<id>/assets/<kind>/<file>` path the proxy understands.
 *
 * Non-fatal: any failure is logged and returned as an advisory string so
 * the canvas patch itself is never rolled back.
 *
 * For video nodes we optionally also register the poster/thumb if one is
 * present; for audio we just copy the single file.
 */
export async function migrateInaccessibleResultUrl(
  projectId: string,
  wsRoot: string,
  roots: string[],
  canvasStore: CanvasStore,
  nodeId: string,
  nodeType: CanvasNode['type'],
  sourcePath?: string,
): Promise<string | null> {
  const snap = canvasStore.snapshot(projectId)
  const node = snap.graph.nodes.find((n) => n.id === nodeId)
  if (!node) return null
  const raw = (node.data as { resultUrl?: unknown }).resultUrl
  if (typeof raw !== 'string' || !raw) return null
  const src = raw.trim()

  // Nothing to migrate for URLs the browser can already render directly
  // (remote https, in-memory data:/blob:) — those go through untouched.
  if (/^(https?:|data:|blob:|\/api\/)/i.test(src)) return null
  // Already a project-relative path the proxy resolves correctly.
  if (src.startsWith('projects/') || src.startsWith('assets/')) return null

  // Convert the stored URL into an absolute local path the migration can
  // read. file:// gets the prefix stripped; bare absolute POSIX paths pass
  // through. Everything else (relative paths, etc.) is left alone and the
  // proxy will fail at render-time — same as before — instead of us
  // guessing.
  let localPath: string | null = null
  if (src.startsWith('file://')) {
    localPath = src.slice('file://'.length)
  } else if (src.startsWith('/')) {
    localPath = src
  } else if (/^[a-zA-Z]:[\\/]/.test(src)) {
    // Windows-style absolute path. The proxy and node fs handle this
    // uniformly when it points at a real file; we just pass through.
    localPath = src
  } else {
    // Relative path / unknown scheme. Skip — the existing UI flow handles
    // it (the card simply won't render until the agent rewrites it).
    return null
  }

  // Probe via the proxy: if the URL already resolves to a file the proxy
  // can serve, no work needed. This keeps every URL the proxy accepts
  // untouched (zero-copy, zero-overhead).
  const { resolveMediaTarget } = await import('./routes')
  // Use the public accessor — previously this reached into the private
  // `canvasSourcePaths` map via a type assertion, which broke encapsulation
  // and would silently fail if the field was renamed.
  const projectRoots = canvasStore.allSourcePaths()
  const probe = resolveMediaTarget(localPath, wsRoot, roots, projectRoots)
  if (probe.ok) return null // already accessible — nothing to do

  // Read the source file.
  let bytes: Buffer
  try {
    bytes = await import('node:fs/promises').then((m) => m.readFile(localPath))
  } catch (e) {
    log.warn(`[media-studio] migrateInaccessibleResultUrl: cannot read "${localPath}": ${(e as Error).message}`)
    return `node "${nodeId}" resultUrl is inaccessible (${localPath}) — file not found or permission denied`
  }
  if (!bytes || bytes.length === 0) {
    return `node "${nodeId}" resultUrl points to empty file (${localPath})`
  }

  // Determine kind + ext.
  const kind = assetKindForNodeType(nodeType)
  if (!kind) return null // text/note — skip
  const ext = extname(localPath).replace(/^\./, '').toLowerCase() || assetExtFor(localPath, kind)
  const assetId = newAssetId()
  const fileName = newAssetFileName(assetId, ext)
  const catDir = join(sourcePath ? join(sourcePath, 'assets') : join(wsRoot, 'projects', projectId, 'assets'), ASSET_CATEGORY_DIR[kind])
  await mkdir(catDir, { recursive: true })
  await writeFile(join(catDir, fileName), bytes)

  // Update index so future searches / syncs pick it up.
  const assetRoot = sourcePath ? join(sourcePath, 'assets') : join(wsRoot, 'projects', projectId, 'assets')
  const indexFile = sourcePath ? '.index.json' : 'index.json'
  const index = await loadAssetIndex(assetRoot, indexFile)
  const now = new Date().toISOString()
  const label = (node.label || '').trim().slice(0, 64) || `${kind}-${assetId.slice(2, 6)}`
  index.assets.push({
    id: assetId,
    kind,
    name: label,
    file: fileName,
    bytes: bytes.length,
    origin: { type: 'canvas', canvasNodeId: nodeId },
    createdAt: now,
    updatedAt: now,
  })
  await writeAssetIndex(assetRoot, index, indexFile)

  // Rewrite the node URL so the client can render it.
  const projectRelative = `projects/${projectId}/assets/${ASSET_CATEGORY_DIR[kind]}/${fileName}`
  const updateOp: CanvasOp = { op: 'updateNode', id: nodeId, data: { resultUrl: projectRelative } }
  try {
    canvasStore.apply(projectId, [updateOp])
    log.debug(`[media-studio] migrated node "${nodeId}" resultUrl → ${projectRelative}`)
  } catch (e) {
    log.warn(`[media-studio] migrateInaccessibleResultUrl: failed to apply update for "${nodeId}": ${(e as Error).message}`)
    return `node "${nodeId}" migrated to assets but failed to update node: ${(e as Error).message}`
  }

  // Video nodes also need a cover/poster — without one the canvas card
  // shows a blank thumbnail (LazyVideo renders only the poster image before
  // the first click, never the <video> element). Previously this step was
  // skipped here, so any /tmp video file moved by the media-file proxy
  // fallback landed in the project without a poster. Run prepareVideoForCanvas
  // against the freshly-copied local path to attach (or extract) a poster.
  if (nodeType === 'video') {
    try {
      const localTarget = sourcePath
        ? join(sourcePath, 'assets', ASSET_CATEGORY_DIR[kind], fileName)
        : join(wsRoot, 'projects', projectId, 'assets', ASSET_CATEGORY_DIR[kind], fileName)
      const prepared = await prepareVideoForCanvas(localTarget, {
        wsRoot,
        projectId,
        sourcePath,
      })
      const posterUpdate: CanvasOp = { op: 'updateNode', id: nodeId, data: {} }
      const data = posterUpdate.data as Record<string, unknown>
      // If prepareVideoForCanvas rewrote to a stable filename, propagate it;
      // otherwise keep the projectRelative path we just wrote.
      if (prepared.url && prepared.url !== projectRelative) {
        data.resultUrl = prepared.url
      }
      if (prepared.poster) {
        data.poster = prepared.poster
      }
      if (Object.keys(data).length > 0) {
        canvasStore.apply(projectId, [posterUpdate])
        log.debug(`[media-studio] migrated video "${nodeId}" attached cover poster=${prepared.poster ?? '(none)'} url=${prepared.url}`)
      }
    } catch (e) {
      log.warn(`[media-studio] migrateInaccessibleResultUrl: video cover prep failed for "${nodeId}": ${(e as Error).message}`)
      // Non-fatal — the video file is already in place and playable.
    }
  }

  return null // success
}

/**
 * Convert an absolute local thumbnail path back into a canvas-storable URL.
 * Mirrors the shape `prepareVideoForCanvas` emits so the node's data.poster
 * goes through the same media-file proxy the browser already knows.
 *
 *  • `<sourcePath>/assets/clips/<file>.thumb.jpg` → `assets/clips/<file>.thumb.jpg`
 *    (the legacy bare form — same convention the existing nodes use, so
 *    `mediaSrc` rewrites it through `projects/<id>/...`).
 *  • `<sourcePath>/<other>`                      → `projects/<id>/<other>`
 *  • outside sourcePath                           → fall back to file:// form
 *    so the existing media-file proxy can serve it anyway.
 */
function thumbnailPathToUrl(absThumb: string, sourcePath: string | undefined, projectId: string): string {
  if (sourcePath) {
    const rel = absThumb.startsWith(sourcePath + '/') ? absThumb.slice(sourcePath.length + 1) : null
    if (rel && rel.startsWith('assets/')) return rel
    if (rel) return `projects/${projectId}/${rel}`
  }
  return `file://${absThumb}`
}

/**
 * Backfill missing posters for every video node in a canvas. Designed to be
 * called as a one-shot recovery after a session discovers that video cards
 * have no data.poster (typically because the videos were written to the
 * project directory by a path that bypassed `prepareVideoForCanvas`, or
 * because `canvas_node_update` rewrote the resultUrl without triggering
 * the post-process's cover step).
 *
 * Strategy (in-place, never moves the video):
 *   • If `data.poster` is already set, skip (idempotent).
 *   • Resolve the node's `resultUrl` to an absolute local path via
 *     `resolveLocalVideoPath` (handles `projects/<id>/...`,
 *     `assets/...`, `file://...`, absolute paths).
 *   • Extract the first frame as `<video>.thumb.jpg` next to the video
 *     with ffmpeg — no rename, no copy.
 *   • Patch the node's `data.poster` with the thumbnail URL in the same
 *     shape the canvas uses (`assets/clips/...` or `projects/<id>/...`).
 *     `resultUrl` is never changed.
 *
 * Returns per-node advisory strings so the caller can surface failures in
 * the response payload. Doesn't touch nodes whose URL can't be resolved
 * locally (https URLs the agent still has the canonical path for, etc.)
 * — those are out of scope for an in-place backfill.
 */
export async function backfillVideoPosters(
  projectId: string,
  wsRoot: string,
  sourcePath: string | undefined,
  canvasStore: CanvasStore,
): Promise<{ processed: number; succeeded: number; issues: string[] }> {
  void wsRoot
  const snap = canvasStore.snapshot(projectId)
  const issues: string[] = []
  let processed = 0
  let succeeded = 0
  for (const node of snap.graph.nodes) {
    if (node.type !== 'video') continue
    const data = node.data as Record<string, unknown>
    const poster = data.poster
    if (typeof poster === 'string' && poster.trim()) continue // already set
    const raw = data.resultUrl
    if (typeof raw !== 'string' || !raw.trim()) continue
    const localVideo = resolveLocalVideoPath(raw, sourcePath, projectId)
    if (!localVideo) {
      // Remote URL we can't reach without re-downloading (and the user
      // may have meant to keep that URL anyway). Don't process — the
      // dedicated `canvas_refresh_node` flow handles the live regenerate
      // case. Surface as a silent skip rather than a noisy warn.
      continue
    }
    processed++
    try {
      const absThumb = await extractPosterInPlace(localVideo)
      if (!absThumb) {
        issues.push(`warn: backfillVideoPosters could not produce a poster for "${node.id}" (${raw})`)
        continue
      }
      const posterUrl = thumbnailPathToUrl(absThumb, sourcePath, projectId)
      canvasStore.apply(projectId, [{ op: 'updateNode', id: node.id, data: { poster: posterUrl } }])
      succeeded++
    } catch (e) {
      issues.push(`warn: backfillVideoPosters failed for "${node.id}" (${raw}): ${(e as Error).message}`)
    }
  }
  return { processed, succeeded, issues }
}

/**
 * Pin a remote (http/https) URL into the project's asset directory. Provider
 * URLs from image/video/music generators frequently expire (OpenAI ~2 h,
 * many others 1 h or less) — the moment the user comes back to the canvas
 * the URL is dead and the card shows a broken image. We pull the bytes
 * synchronously during the canvas_graph_patch call so the stored resultUrl
 * always points at a file the local proxy can serve indefinitely.
 *
 * Only invoked for batchAddMedia (the path agents use to "publish" a
 * generated asset). For updateNode-driven refreshes, the same machinery
 * runs through `migrateInaccessibleResultUrl` — but refresh already runs
 * synchronously on the host, so URL expiration isn't a concern there.
 *
 * Returns:
 *   • `{ ok: true, url }` — the URL was downloaded; the caller should rewrite
 *     the node's resultUrl to `url`.
 *   • `{ ok: false }` — the URL was skipped (already a local file path or
 *     a data: URL). The caller should leave the original url in place.
 */
export async function pinRemoteResultUrl(
  url: string,
  projectId: string,
  wsRoot: string,
  sourcePath: string | undefined,
  kind: AssetKind,
): Promise<{ ok: boolean; url?: string; error?: string }> {
  if (!url) return { ok: false }
  const trimmed = url.trim()
  if (!/^https?:\/\//i.test(trimmed)) return { ok: false } // already local / data:

  // Pick an extension from the URL path; fall back to a kind default. The
  // MIME sniff from the response headers would be more accurate, but the
  // common cases (provider returns .png / .jpg / .mp4 / .mp3 / .webm) all
  // carry the right extension in the URL.
  let ext = ''
  try {
    const u = new URL(trimmed)
    const last = u.pathname.split('/').pop() ?? ''
    const dot = last.lastIndexOf('.')
    if (dot >= 0 && dot < last.length - 1) ext = last.slice(dot + 1).toLowerCase()
  } catch { /* bad URL — fall through */ }
  if (!ext) ext = assetExtFor(trimmed, kind)
  if (!ext) return { ok: false, error: `cannot infer extension for ${kind} url` }

  const assetId = newAssetId()
  const fileName = newAssetFileName(assetId, ext)
  const assetRoot = sourcePath ? join(sourcePath, 'assets') : join(wsRoot, 'projects', projectId, 'assets')
  const catDir = join(assetRoot, ASSET_CATEGORY_DIR[kind])
  const dest = join(catDir, fileName)

  try {
    // Cap the response body at 50 MB so a misbehaving provider can't fill
    // the disk. Most generated media is < 10 MB; 50 MB leaves headroom
    // for short clips / high-res images without becoming a DoS vector.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60_000)
    const res = await fetch(trimmed, { signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok) {
      return { ok: false, error: `download failed: HTTP ${res.status} for ${trimmed}` }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (!buf.length) return { ok: false, error: `downloaded 0 bytes from ${trimmed}` }
    if (buf.length > 50 * 1024 * 1024) {
      return { ok: false, error: `download too large (${buf.length} bytes) — refusing to pin` }
    }
    await mkdir(catDir, { recursive: true })
    await writeFile(dest, buf)

    // Register the asset so the library panel + cross-project search
    // pick it up immediately. We don't carry a label here because the
    // caller (batchAddMedia flow) controls the node label.
    try {
      const index = await loadAssetIndex(assetRoot, sourcePath ? '.index.json' : 'index.json')
      const now = new Date().toISOString()
      index.assets.push({
        id: assetId,
        kind,
        name: fileName,
        file: fileName,
        bytes: buf.length,
        origin: { type: 'pinned', sourceUrl: trimmed },
        createdAt: now,
        updatedAt: now,
      })
      await writeAssetIndex(assetRoot, index, sourcePath ? '.index.json' : 'index.json')
    } catch (e) {
      log.warn(`[media-studio] pinRemoteResultUrl: failed to update index (file is still pinned): ${(e as Error).message}`)
    }

    return { ok: true, url: `projects/${projectId}/assets/${ASSET_CATEGORY_DIR[kind]}/${fileName}` }
  } catch (e) {
    const msg = (e as Error).message
    log.warn(`[media-studio] pinRemoteResultUrl: ${trimmed} → ${msg}`)
    return { ok: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//
// After the multimodal refactor the `dsh-media-studio` plugin no longer owns
// any LLM-facing tools. The five `generate_*` tools (text / image / video /
// tts / music) all live in the sibling `dsh-llm-multimodal` plugin, which
// also owns the `llm-multimodal` settings namespace and the matching
// settings card.
//
// This file owns FOUR canvas-only tools:
//   - canvas_graph_view      — read canvas snapshot
//   - canvas_graph_patch     — atomic batched canvas mutation
//   - canvas_auto_arrange    — re-layout by topological depth
//   - canvas_refresh_node    — click-regenerate one media node (delegates to
//                              the multimodal plugin's tools via
//                              ctx.tools.execute)
// ─────────────────────────────────────────────────────────────────────────────

// ── Refresh: shared between the agent tool + the client HTTP route ────────

/**
 * Assemble a regeneration prompt from the upstream nodes of `nodeId`.
 *
 * Only the **first layer** of upstreams is read (edges whose target is this
 * node) — grandparents must be connected explicitly if their content should
 * reach this node.
 *
 * `labelPrefix: true` (default) emits `[<label>]: <content>` per upstream so
 * an image/video model can tell which source each chunk came from.
 * `labelPrefix: false` emits the raw content — **required for TTS / music**,
 * where the prefix would be read aloud ("[剧本]: 我还是来晚了").
 */
export function buildRefreshContext(
  nodeId: string,
  graph: CanvasSnapshot['graph'],
  opts?: { labelPrefix?: boolean },
): string {
  const withLabels = opts?.labelPrefix !== false
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return ''

  // Collect upstream edges (edges where this node is the target).
  const upstreamIds = graph.edges
    .filter((e) => e.target === nodeId)
    .map((e) => e.source)

  if (upstreamIds.length === 0) return ''

  const parts: string[] = []
  for (const id of upstreamIds) {
    const up = graph.nodes.find((n) => n.id === id)
    if (!up) continue
    const label = up.label || up.type
    let content = ''
    if (up.type === 'text' || up.type === 'note') {
      content = (up.data.text as string | undefined) ?? (up.data.content as string | undefined) ?? ''
    } else if (up.type === 'image' || up.type === 'video') {
      // Prefer the authored intent; `prompt` is what agents write.
      content = (up.data.deltaIntent as string | undefined) ?? (up.data.prompt as string | undefined) ?? ''
    } else if (up.type === 'music') {
      content = (up.data.text as string | undefined) ?? (up.data.deltaIntent as string | undefined) ?? ''
    }
    if (withLabels) {
      parts.push(content ? `[${label}]: ${content}` : `[${label}]: (no text content)`)
    } else if (content) {
      parts.push(content)
    }
  }

  return parts.join('\n')
}

/**
 * Resolve a stored media reference (`http(s)://`, `data:`, `file://`,
 * `projects/...` project-relative, or absolute path) to something the
 * multimodal provider can consume.
 *
 * `asDataUri: true` reads the file from disk and inlines it as a Base64 Data
 * URI — required for image inputs because upstream APIs cannot reach
 * localhost or filesystem paths.
 * `asDataUri: false` returns an absolute local path (or the original URL) —
 * used for `clone_audio`, which accepts local paths directly.
 */
function resolveMediaRef(raw: string, wsRoot: string, asDataUri: boolean): string | null {
  if (!raw) return null
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('data:')) {
    return raw
  }

  let filePath: string | null = null
  if (raw.startsWith('file://')) {
    filePath = raw.slice(7)
  } else if (raw.startsWith('projects/')) {
    // projects/<canvasId>/<relativePath> → <wsRoot>/<relativePath>
    filePath = join(wsRoot, raw.split('/').slice(2).join('/'))
  } else if (raw.startsWith('/')) {
    filePath = raw
  }
  if (!filePath) return null

  if (!asDataUri) return filePath
  try {
    const buf = readFileSync(filePath)
    const ext = extname(filePath).toLowerCase().replace('.', '') || 'png'
    const isAudio = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'].includes(ext)
    const mime = isAudio
      ? `audio/${ext === 'mp3' ? 'mpeg' : ext}`
      : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png')
    return `data:${mime};base64,${buf.toString('base64')}`
  } catch {
    return null
  }
}

/** One resolvable media reference contributed by a first-layer upstream node. */
export interface UpstreamRef {
  /** Id of the upstream node that owns the media. */
  nodeId: string
  /** Resolved URL (http(s) / data URI / absolute path). */
  url: string
  /** Semantic edge label, e.g. '首帧参考' | '尾帧衔接' | '角色锚'. */
  label?: string
  /** `data.role` of the upstream node, e.g. 'keyframe' | 'character-sheet'. */
  role?: string
  /** True when the media is a video poster rather than a real image node. */
  poster?: boolean
}

/**
 * Collect **every** first-layer upstream media reference of `nodeId`.
 *
 * Images come from upstream `image` nodes (`resultUrl`) plus `video` nodes'
 * `data.poster` (first frame) — both are valid visual references. Audios come
 * from upstream `music` nodes (`resultUrl`) and are used as TTS voice-clone
 * seeds so a character's timbre propagates down the graph.
 *
 * Ordering follows edge order; callers pick first/last frame by edge label.
 */
export function collectUpstreamRefs(
  nodeId: string,
  graph: CanvasSnapshot['graph'],
  wsRoot: string,
): { images: UpstreamRef[]; audios: string[] } {
  const images: UpstreamRef[] = []
  const audios: string[] = []

  for (const e of graph.edges) {
    if (e.target !== nodeId) continue
    const up = graph.nodes.find((n) => n.id === e.source)
    if (!up) continue
    const role = up.data.role as string | undefined

    if (up.type === 'image') {
      const url = resolveMediaRef((up.data.resultUrl as string | undefined) ?? '', wsRoot, true)
      if (url) images.push({ nodeId: up.id, url, label: e.label, role })
    } else if (up.type === 'video') {
      // A video's poster is its first frame — usable as a visual reference
      // (e.g. chaining clip N's opening frame into clip N+1).
      const url = resolveMediaRef((up.data.poster as string | undefined) ?? '', wsRoot, true)
      if (url) images.push({ nodeId: up.id, url, label: e.label, role, poster: true })
    } else if (up.type === 'music') {
      const url = resolveMediaRef((up.data.resultUrl as string | undefined) ?? '', wsRoot, false)
      if (url) audios.push(url)
    }
  }

  return { images, audios }
}

/**
 * Collect upstream image node resultUrls for I2I (image-to-image) and I2V
 * (image-to-video) workflows. Returns an array of publicly accessible URLs or
 * Base64 Data URIs that can be passed directly to the multimodal plugin's
 * `image` parameter. Local file paths (projects/... or file://...) are read
 * and converted to Base64 Data URIs because upstream APIs (Agnes etc.)
 * cannot access localhost or filesystem paths.
 */
export function collectUpstreamImageUrls(
  nodeId: string,
  graph: CanvasSnapshot['graph'],
  wsRoot: string,
): string[] {
  return collectUpstreamRefs(nodeId, graph, wsRoot).images.map((r) => r.url)
}

/**
 * Map a canvas node type to the multimodal tool name. The dsh-llm-multimodal
 * plugin owns the generators — `generate_image` / `generate_video` /
 * `generate_tts` / `generate_music`. Music nodes split by role: dub nodes
 * (data.dub === true) go to generate_tts (dialogue voice-over), everything
 * else to generate_music (BGM / sound effects).
 */
function toolNameForNodeType(kind: 'image' | 'video' | 'music', data?: Record<string, unknown>): string {
  switch (kind) {
    case 'image': return 'generate_image'
    case 'video': return 'generate_video'
    case 'music': return data?.dub === true ? 'generate_tts' : 'generate_music'
  }
}

/**
 * One call into the multimodal plugin. We use the harness's
 * `ctx.tools.execute(...)` (declared on the cordis Context through
 * `@deepseek-ai/dsh-tools`'s `ToolRuntime`) rather than calling the
 * multimodal plugin's internals — that is the documented plugin boundary
 * and stays robust if dsh-llm-multimodal evolves its internals.
 */
async function callMultimodal(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ ok: boolean; url?: string; model?: string; coverUrl?: string; code?: string; message?: string }> {
  try {
    // The tool shape, per dsh-tools, is `{ name, arguments, signal, callId }`.
    // For our purposes the harness mints a callId; we just pass our signal.
    const exec = await (ctx.tools as unknown as {
      execute: (input: { name: string; arguments: unknown; signal: AbortSignal; callId?: string }) => Promise<unknown>
    }).execute({
      name,
      arguments: args,
      signal,
    })
    const out = (exec as { value?: unknown; isError?: boolean })?.value ?? exec
    // `coverUrl` is set by `dsh-llm-multimodal/generate_video` when the
    // provider response carries a sibling image — media-studio's video-cover
    // pipeline uses it to embed the first frame into the MP4 so project
    // directories stay clean (no sibling .thumb.jpg).
    const v = out as { success?: boolean; videoUrl?: string; url?: string; model?: string; message?: string; coverUrl?: string }
    if (v && v.success) {
      const url = v.videoUrl || v.url
      return { ok: true, url, model: v.model, coverUrl: v.coverUrl }
    }
    return { ok: false, code: 'multimodal-failed', message: v?.message || JSON.stringify(out).slice(0, 200) }
  } catch (e) {
    return { ok: false, code: 'multimodal-threw', message: (e as Error).message }
  }
}

/** Execute the node refresh logic. Used by both the agent tool and the HTTP
 *  route so they share the same code path. */
export async function executeNodeRefresh(
  store: CanvasStore,
  canvasId: string,
  nodeId: string,
  signal: AbortSignal,
  ctx: Context,
): Promise<{ ok: boolean; code?: string; message?: string; prompt?: string; kind: string; url?: string }> {
  // Read current snapshot
  const snap = store.snapshot(canvasId)
  const node = snap.graph.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, code: 'node-not-found', message: `node "${nodeId}" not found`, kind: 'image' }

  // The previous version required an upstream edge here. That was wrong
  // for the common agent flow: it often creates a media node as the
  // terminus of a pipeline (or as a one-off after generating content),
  // stores the prompt in data.prompt, and calls canvas_refresh_node with
  // zero upstream. The refresh path already falls back to basePrompt when
  // no upstream context is available — so we let any image/video/music
  // node refresh, regardless of edges, as long as it carries a usable
  // prompt (or upstream text it can lift from). Empty nodes still fail
  // with a clear "nothing to refresh" error so the agent knows to set
  // data.prompt first.
  const kind = node.type as 'image' | 'video' | 'music'
  const basePrompt = ((node.data.prompt as string | undefined) ?? '').trim()
  const context = buildRefreshContext(nodeId, snap.graph)
  // Label-free variant for TTS / music — otherwise the spoken output would
  // literally include "[剧本]: " prefixes.
  const rawContext = buildRefreshContext(nodeId, snap.graph, { labelPrefix: false })
  if (!basePrompt && !context) {
    return {
      ok: false,
      code: 'no-prompt',
      message: `node "${nodeId}" has no prompt and no upstream text; call canvas_node_update(id, {prompt: '...'}) first`,
      kind,
    }
  }

  // Set running status optimistically (sync patch so the tab reflects immediately)
  const runningOp: CanvasOp = { op: 'updateNode', id: nodeId, data: { status: 'running' as const } }
  try {
    store.apply(canvasId, [runningOp])
  } catch { /* non-fatal — keep going */ }

  // Helper: mark the node as errored and return the failure payload.
  // Previously the image/video/music failure paths returned directly,
  // leaving the node stuck in "running" forever because only the catch
  // block reset status to "error".
  const fail = (code: string, message: string) => {
    try {
      store.apply(canvasId, [{ op: 'updateNode', id: nodeId, data: { status: 'error' as const, errorMsg: message } }])
    } catch { /* ignore — best-effort status reset */ }
    return { ok: false, code, message, kind }
  }

  try {
    let resultUrl: string | undefined
    let newPrompt: string
    /** Video-only: optional poster path produced by prepareVideoForCanvas */
    let videoPoster: string | null = null

    // Collect **all** first-layer upstream media references — every upstream
    // image (and video poster) is a valid visual reference, and upstream
    // audio can seed a TTS voice clone.
    const wsRoot = getMediaStudioHandles().workspaceRoot
    const upstream = collectUpstreamRefs(nodeId, snap.graph, wsRoot)
    const upstreamImageUrls = upstream.images.map((r) => r.url)
    const negativePrompt = (node.data.negativePrompt as string | undefined)?.trim()

    if (kind === 'image') {
      newPrompt = basePrompt
        ? `${basePrompt}\n\nContext from upstream nodes:\n${context || '(no upstream text content)'}\n\nRegenerate the image keeping the original style and subject.`
        : `Generate an image that illustrates: ${context || '(empty)'}`
      const imageArgs: Record<string, unknown> = { prompt: newPrompt }
      // dsh-tools' snapshot validator rejects `undefined` property values
      // ("tool execution arguments must be losslessly JSON-serializable"),
      // so only attach keys that actually have a value.
      const imgModel = node.data.model as string | undefined
      if (imgModel) imageArgs.model = imgModel
      // Pass **every** upstream image as I2I / multi-image composition
      // reference — `generate_image.image` is an array.
      if (upstreamImageUrls.length > 0) {
        imageArgs.image = upstreamImageUrls
      }
      // Keep the whole film on one canvas size (consistency anchor).
      const imgSize = node.data.size as string | undefined
      if (imgSize) imageArgs.size = imgSize
      if (negativePrompt) imageArgs.negative_prompt = negativePrompt
      const r = await callMultimodal(ctx, 'generate_image', imageArgs, signal)
      if (!r.ok || !r.url) return fail(r.code || 'image-failed', r.message || 'no url')
      // Drop whatever the multimodal plugin returned (CDN URL / base64 /
      // file:// path) into a stable local file. When the project has a
      // sourcePath set, this lands the bytes inside the user's project
      // tree under `<sourcePath>/assets/<kind>/`; otherwise we fall back
      // to `<wsRoot>/web-jobs/` (same shape as videos).
      //
      // Kind inference: explicit `data.assetKind` → tag scan → characterRef
      // → misc fallback. See `inferImageKindDir` in image-cover.ts for the
      // priority chain. New asset categories are added by extending the
      // `AssetKindDir` union there — nothing else needs to change.
      const preparedImg = await prepareImageForCanvas(r.url, {
        wsRoot,
        projectId: canvasId,
        sourcePath: store.getSourcePath(canvasId),
        nodeHints: {
          characterRef: node.data.characterRef,
          tags: node.data.tags as readonly string[] | undefined,
          category: node.data.assetKind as string | undefined,
          // Prompt + upstream text drives the last-resort semantic scan —
          // e.g. "character design sheet" prompts land in characters/ even
          // when the agent never set data.assetKind.
          content: `${basePrompt}\n${context}`,
        },
      })
      resultUrl = preparedImg.url
    } else if (kind === 'video') {
      newPrompt = basePrompt
        ? `${basePrompt}\n\nContext from upstream nodes:\n${context || '(no upstream text content)'}\n\nRegenerate the video keeping the original style and subject.`
        : `Generate a short video that illustrates: ${context || '(empty)'}`
      const videoArgs: Record<string, unknown> = {
        prompt: newPrompt,
        duration: (node.data.duration as number | undefined) || 5,
        size: (node.data.size as string | undefined) || '1280x720',
      }
      const vidModel = node.data.model as string | undefined
      if (vidModel) videoArgs.model = vidModel
      if (negativePrompt) videoArgs.negative_prompt = negativePrompt

      // ── Multi-frame I2V ──────────────────────────────────────────────
      // NOT just the first image: every first-layer upstream image is a
      // valid reference. Edge labels pick out the special ones:
      //   '首帧参考' → first frame (defaults to the first upstream image)
      //   '尾帧衔接' → last frame  (enables native first+last-frame mode,
      //                            i.e. real shot-to-shot continuity)
      // Everything else becomes a multi-image reference set.
      //
      // generate_video supports: image (single I2V), keyframes (array) and
      // mode = 'text' | 'ti2vid' | 'keyframe' | 'keyframes' | 'reference'.
      const explicitMode = node.data.videoMode as string | undefined
      const imgs = upstream.images
      const firstFrame =
        imgs.find((r) => r.label === '首帧参考' || r.label === 'first-frame') ?? imgs[0]
      const lastFrame =
        imgs.find((r) => r.label === '尾帧衔接' || r.label === '尾帧' || r.label === 'last-frame')
      const refFrames = imgs.filter((r) => r !== firstFrame && r !== lastFrame)

      if (firstFrame) videoArgs.image = firstFrame.url
      if (lastFrame && firstFrame) {
        videoArgs.mode = explicitMode ?? 'keyframes'
        videoArgs.keyframes = [firstFrame.url, lastFrame.url]
      } else if (refFrames.length > 0 && firstFrame) {
        videoArgs.mode = explicitMode ?? 'reference'
        videoArgs.keyframes = [firstFrame.url, ...refFrames.map((r) => r.url)]
      } else if (explicitMode) {
        videoArgs.mode = explicitMode
      }
      const r = await callMultimodal(ctx, 'generate_video', videoArgs, signal)
      if (!r.ok || !r.url) return fail(r.code || 'video-failed', r.message || 'no url')
      // prepareVideoForCanvas may rewrite r.url to a local copy under
      // web-jobs/ AND optionally attach (or extract) a poster. Failures are
      // non-fatal — we always fall back to the provider URL.
      const wsRoot = getMediaStudioHandles().workspaceRoot
      const prepared = await prepareVideoForCanvas(r.url, {
        wsRoot,
        projectId: canvasId,
        // When the project has a sourcePath, the video lands in
        // `<sourcePath>/assets/clips/<file>` and we return the
        // `projects/<id>/assets/clips/<file>` URL convention.
        sourcePath: store.getSourcePath(canvasId),
        // Prefer the typed `coverUrl` field returned by dsh-llm-multimodal;
        // `providerExtras` is a belt-and-suspenders fallback for providers
        // that stuff the cover URL into an unmodeled JSON field.
        coverUrl: r.coverUrl,
        providerExtras: r,
      })
      resultUrl = prepared.url
      videoPoster = prepared.poster
    } else if (kind === 'music') {
      // Upstream text wins over the node's own `data.prompt` (this is the
      // documented music contract). Raw, unlabelled text — the labels exist
      // only to disambiguate sources for vision models, not to be spoken.
      newPrompt = rawContext || basePrompt || '(no upstream text content)'
      // dsh-llm-multimodal separates TTS from music models: dialogue /
      // voice-over nodes (data.dub === true) are dubbed via generate_tts,
      // BGM / sound-effect nodes go through generate_music.
      const isDub = node.data?.dub === true
      const musicTool = isDub ? 'generate_tts' : 'generate_music'
      const audioArgs: Record<string, unknown> = { text: newPrompt }
      const voice = node.data.voice as string | undefined
      if (voice) audioArgs.voice = voice
      const speed = node.data.speed as number | undefined
      if (speed) audioArgs.speed = speed
      // Per-character dubbing: carry the voice-clone seed + stable name so
      // the character's own voice is cloned once and reused by name.
      for (const k of ['clone_audio', 'voice_name', 'clone_voice_id'] as const) {
        const v = node.data[k] as string | undefined
        if (v) audioArgs[k] = v
      }
      // No explicit seed → inherit the timbre from an upstream audio node
      // (e.g. a reference dub node the character's voice was cloned from).
      // Only the first upstream audio is used; cloning from many at once is
      // not supported by the provider.
      if (isDub && !audioArgs.clone_audio && upstream.audios.length > 0) {
        audioArgs.clone_audio = upstream.audios[0]
        // Reuse the same cloned voice by name so later shots stay on-timbre.
        if (!audioArgs.voice_name) {
          audioArgs.voice_name =
            (node.data.characterRef as string | undefined) || (node.data.voice_name as string | undefined) || nodeId
        }
      }
      const r = await callMultimodal(ctx, musicTool, audioArgs, signal)
      if (!r.ok || !r.url) return fail(r.code || 'music-failed', r.message || 'no url')
      // Persist the audio into a stable local file (same as the image/video
      // refresh paths): provider URLs from TTS / music models expire quickly
      // (OpenAI ~2h), so keeping the raw URL would leave the card broken as
      // soon as the link dies. Falls back to the original URL on download
      // failure so a transient network error never blanks the node.
      const preparedAudio = await prepareAudioForCanvas(r.url, {
        wsRoot,
        projectId: canvasId,
        sourcePath: store.getSourcePath(canvasId),
      })
      resultUrl = preparedAudio.url
    } else {
      return fail('not-supported', `refresh not supported for kind "${kind}"`)
    }

    // ── Write-back policy ────────────────────────────────────────────────
    // Refresh is strictly one-way: it consumes upstream nodes and writes
    // ONLY to `nodeId`. Upstream nodes are never mutated — not even when the
    // generated result differs from what their prompt asked for. Consistency
    // is fixed by editing the upstream *source* intentionally (which then
    // requires a downstream re-run), never by back-writing from a child.
    //
    // The compiled prompt lands in `data.lastPrompt` (audit trail) while
    // `data.prompt` keeps the authored intent. Previously the compiled
    // prompt overwrote `data.prompt`, so every re-refresh re-ingested the
    // previous "Context from upstream nodes:" block and the prompt grew
    // without bound.
    const updateOp: CanvasOp = {
      op: 'updateNode',
      id: nodeId,
      data: {
        status: 'done' as const,
        resultUrl,
        lastPrompt: newPrompt,
        ...(kind === 'video' && videoPoster ? { poster: videoPoster } : {}),
        ...(kind === 'music' ? { text: newPrompt } : {}),
      },
    }
    store.apply(canvasId, [updateOp])

    return { ok: true, kind, prompt: newPrompt, url: resultUrl }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const code = 'unknown'
    log.error(`[media-studio] executeNodeRefresh: error ${code} ${msg}`)
    const errOp: CanvasOp = {
      op: 'updateNode',
      id: nodeId,
      data: { status: 'error' as const, errorMsg: msg },
    }
    try { store.apply(canvasId, [errOp]) } catch { /* ignore */ }
    return { ok: false, code, message: msg, kind }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration — canvas_graph_* + auto-arrange + refresh node
// ─────────────────────────────────────────────────────────────────────────────

/** Canvas id tools fall back to: the active project's canvas when a project
 *  registry exists (M0), else the plugin default (`main`). */
function resolveCanvasId(): string {
  const mst = getMediaStudioHandles()
  const active = mst.projectStore?.activeCanvasId() ?? null
  return active || mst.defaultCanvasId || 'main'
}

/**
 * `canvas_graph_view` — read the current canvas snapshot. Agents should
 * call this before `canvas_graph_patch` so they don't operate blind.
 */
export function registerCanvasViewTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_view',
      description: 'Read the current canvas graph (nodes + edges + regions) for a canvas. Returns JSON; pass canvasId to disambiguate when the user has multiple canvases open (blank → the active project\'s canvas, else the plugin default).\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `canvas version ${(value as { version: number }).version}: ${(value as { graph: { nodes: unknown[] } }).graph.nodes.length} nodes, ${(value as { graph: { edges: unknown[] } }).graph.edges.length} edges`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        return store.snapshot(canvasId) as unknown as JsonValue
      },
    }),
  )
}

/**
 * Shared post-processing for every canvas patch — agent tool AND REST API
 * both call this so behaviour is identical regardless of entry point.
 *
 * Steps (all best-effort; failures surface as `warn:` strings):
 *   1. Pin remote https resultUrls (batchAddMedia items) into the project
 *      assets directory so provider links don't expire into broken cards.
 *   2. Migrate any remaining inaccessible urls (file:///tmp, absolute paths
 *      outside the media-file proxy allow-list).
 *   3. Auto-register media nodes into the project asset library.
 *
 * Returns the combined issues array (lint issues + post-process advisories).
 */
export async function postProcessCanvasPatch(
  store: CanvasStore,
  canvasId: string,
  ops: CanvasOp[],
  baseIssues: string[],
): Promise<string[]> {
  const issues = [...baseIssues]
  const mst = getMediaStudioHandles()
  const projectStore = mst.projectStore

  // The target canvas id IS the project id for registered projects (canvas
  // files live at canvases/<id>.json and project ids are stable). Resolve
  // against the registry first so patching a non-active canvas pins / migrates
  // / registers into THAT project — previously we always used
  // `activeCanvasId()`, which misplaced files and rewrote node URLs to the
  // wrong project whenever an agent passed an explicit canvasId for a
  // non-active project. Unregistered canvases (legacy `main`) fall back to the
  // active project to preserve the old behaviour.
  const projectId = (() => {
    if (!projectStore) return null
    const snap = projectStore.snapshot?.()
    if (snap && snap.projects.some((p) => p.id === canvasId)) return canvasId
    return projectStore.activeCanvasId?.() ?? null
  })()
  if (!projectId) return issues

  const sourcePath = projectStore?.resolveSourcePath?.(projectId)

  // 1. Pin remote https URLs from batchAddMedia items.
  //    Videos are intentionally skipped here — they go through
  //    prepareVideoForCanvas in step 1.5 below, which downloads the file
  //    into web-jobs/ AND produces a poster in one pass.
  const pinnedNodeIds = new Set<string>()
  for (const op of ops) {
    if (op.op !== 'batchAddMedia') continue
    for (const item of op.items) {
      if (item.kind === 'video') continue
      if (typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) continue
      const kind: AssetKind | null = item.kind === 'audio' ? 'audio' : item.kind === 'image' ? 'character' : null
      if (!kind) continue
      const pinned = await pinRemoteResultUrl(item.url, projectId, mst.workspaceRoot, sourcePath, kind)
      if (pinned.ok && pinned.url) {
        const nid = item.nodeId
        if (nid) {
          pinnedNodeIds.add(nid)
          try {
            store.apply(canvasId, [{ op: 'updateNode', id: nid, data: { resultUrl: pinned.url } }])
          } catch (e) {
            issues.push(`warn: pinned node "${nid}" to local but rewrite failed: ${(e as Error).message}`)
          }
        } else {
          issues.push(`warn: pinned media url but batchAddMedia item has no nodeId; the node still references the original URL`)
        }
      } else if (pinned.error) {
        issues.push(`warn: could not pin remote url "${item.url.slice(0, 80)}": ${pinned.error} (the canvas still references the original URL; re-run canvas_graph_patch once the provider recovers)`)
      }
    }
  }

  // 1.5 Prepare video covers for batchAddMedia video nodes.
  //     prepareVideoForCanvas downloads the video into web-jobs/ and either
  //     embeds the provider cover + keeps an external poster, or extracts
  //     the first frame as a .thumb.jpg. Without this step, video cards
  //     created via batchAddMedia have no data.poster and the frontend
  //     LazyVideo renders a blank card (it never mounts <video> before the
  //     first click, so even an embedded attached_pic is invisible).
  //     sourcePath/projectId are passed so sourcePath projects keep their
  //     media inside the user's project tree (assets/clips/) instead of the
  //     shared web-jobs/ directory.
  //
  //     M3-② batching: every successful prepare pushes an updateNode op
  //     into `pendingVideoOps`; a single trailing `store.apply` writes all
  //     of them in one pass (one cloneGraph, one broadcast, one debounced
  //     disk write). The previous per-video apply cost N clones / N
  //     broadcasts / N writes for an N-video patch — see test
  //     `post-process-batching.test.ts`.
  const pendingVideoOps: CanvasOp[] = []
  for (const op of ops) {
    if (op.op !== 'batchAddMedia') continue
    for (const item of op.items) {
      if (item.kind !== 'video') continue
      if (typeof item.url !== 'string' || !item.url.trim()) continue
      const nid = item.nodeId
      if (!nid) continue
      // Read the current resultUrl in case an earlier step rewrote it.
      const curSnap = store.snapshot(canvasId)
      const node = curSnap.graph.nodes.find((n) => n.id === nid)
      const rawUrl = (node?.data.resultUrl as string | undefined) ?? item.url
      try {
        const prepared = await prepareVideoForCanvas(rawUrl, {
          wsRoot: mst.workspaceRoot,
          projectId: canvasId,
          sourcePath,
          coverUrl: item.coverUrl,
          providerExtras: item,
        })
        const updateData: Record<string, unknown> = { resultUrl: prepared.url }
        if (prepared.poster) updateData.poster = prepared.poster
        pendingVideoOps.push({ op: 'updateNode', id: nid, data: updateData })
      } catch (e) {
        issues.push(`warn: video cover preparation failed for node "${nid}": ${(e as Error).message} (card will show without a poster)`)
      }
    }
  }
  if (pendingVideoOps.length > 0) {
    try { store.apply(canvasId, pendingVideoOps) } catch (e) { issues.push(`warn: batched video poster apply failed: ${(e as Error).message}`) }
  }

  // 1.6 Backfill missing video posters when an existing video node's
  //     `resultUrl` was rewritten via `updateNode` (or via the migration in
  //     step 2) but no `poster` was attached. This catches the common agent
  //     flow where a video node is created empty, then later filled by a
  //     separate patch that just sets `data.resultUrl` to the local file
  //     path — without this step the canvas card shows blank until the user
  //     manually refreshes the node.
  //
  //     M3-② batching (see step 1.5 header): all backfill updates land
  //     in a single trailing `store.apply`.
  const pendingBackfillOps: CanvasOp[] = []
  for (const op of ops) {
    if (op.op !== 'updateNode') continue
    const nid = op.id
    if (!nid) continue
    const curSnap = store.snapshot(canvasId)
    const node = curSnap.graph.nodes.find((n) => n.id === nid)
    if (!node || node.type !== 'video') continue
    const data = node.data as Record<string, unknown>
    const newResultUrl = (op.data?.resultUrl as string | undefined) ?? (data.resultUrl as string | undefined)
    if (!newResultUrl || typeof newResultUrl !== 'string' || !newResultUrl.trim()) continue
    // Already has a poster and the resultUrl didn't change — nothing to do.
    const hasPoster = typeof data.poster === 'string' && (data.poster as string).trim() !== ''
    const urlChanged = op.data?.resultUrl !== undefined
    if (hasPoster && !urlChanged) continue
    try {
      const prepared = await prepareVideoForCanvas(newResultUrl, {
        wsRoot: mst.workspaceRoot,
        projectId: canvasId,
        sourcePath,
      })
      const updateData: Record<string, unknown> = {}
      if (prepared.url && prepared.url !== newResultUrl) updateData.resultUrl = prepared.url
      if (prepared.poster && !hasPoster) updateData.poster = prepared.poster
      if (Object.keys(updateData).length > 0) {
        pendingBackfillOps.push({ op: 'updateNode', id: nid, data: updateData })
      }
    } catch (e) {
      issues.push(`warn: video cover backfill failed for node "${nid}": ${(e as Error).message}`)
    }
  }
  if (pendingBackfillOps.length > 0) {
    try { store.apply(canvasId, pendingBackfillOps) } catch (e) { issues.push(`warn: batched video backfill apply failed: ${(e as Error).message}`) }
  }

  // 2. Migrate inaccessible resultUrls + 3. auto-register assets
  //
  // NOTE: kept in series on purpose. Each migrate/register call internally
  // does a full canvas snapshot + (for migration) a single-op store.apply
  // → full cloneGraph + persist + broadcast. The P0-① persist coalescer
  // (added in M3) folds the resulting burst of applies into one disk
  // write regardless of order. Running these in parallel actually
  // observed duplicate-asset races in the project library (two register
  // tasks both seeing the same origin-less source and both writing new
  // asset rows); the series path stays until the lib writes are
  // idempotency-guarded (see M5 stable-filename work).
  {
    const postSnap = store.snapshot(canvasId)
    const mediaNodes = collectMediaNodesFromOps(ops, postSnap.graph.nodes)
    for (const { nodeId, nodeType } of mediaNodes) {
      const adv = await migrateInaccessibleResultUrl(
        projectId, mst.workspaceRoot, mst.mediaRoots ?? [], store, nodeId, nodeType, sourcePath,
      )
      if (adv) issues.push(adv)
    }
    // Nodes whose https URL was already pinned in step 1 are already indexed
    // (origin: pinned) by pinRemoteResultUrl — re-registering them here would
    // copy the bytes a second time into the library and produce duplicate
    // assets. Skip them.
    for (const { nodeId, nodeType } of mediaNodes) {
      if (pinnedNodeIds.has(nodeId)) continue
      const adv = await tryAutoRegisterAsset(projectId, sourcePath, nodeId, nodeType)
      if (adv) issues.push(adv)
    }
  }

  // Step 4 — M5-⑤ orphan media GC. Runs after every successful
  // post-process so a long agent iteration of canvas_graph_patch +
  // refresh doesn't accumulate v-*/a-*/img-* files in the project's
  // asset directory. Best-effort: errors here are advisory only — the
  // patch already succeeded and the user sees their nodes either way.
  try {
    await gcOrphanMedia(store, projectId, sourcePath)
  } catch (e) {
    issues.push(`warn: orphan media GC failed: ${(e as Error).message}`)
  }

  return issues
}

/**
 * `canvas_graph_patch` — batched, atomic canvas mutation. This is the
 * primary tool the agent uses to "operate the canvas" from conversation.
 */
export function registerCanvasPatchTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_patch',
      description:
        'Prefer the single-node / single-region tools (`canvas_node_view` / `canvas_node_add` / `canvas_node_update` / `canvas_node_rename` / `canvas_node_delete` / `canvas_region_add` / `canvas_region_update` / `canvas_region_delete` / `canvas_region_fit`) when you only need to touch one object — they have strict schemas so the LLM is less likely to typo them, and return smaller payloads. Use this tool only when batching 2+ ops that must be atomic together (e.g. "create node + connect + rename" in one shot). Ops: addNode (type: text|image|video|music|note, label, data?, position?, regionId?, nodeId? — position optional: auto-placed in a free grid slot when omitted, or inside the given region\'s grid when regionId is set; nodeId lets a later op in the same batch reference this node); updateNode (id, data); renameNode (id, label); deleteNode (id); moveNode (id, position); connect (from, to, branch?, label? — label gives the edge a human-readable meaning, e.g. "角色清单来源"); deleteEdge (id); addRegion (label, kind?, id?, x?, y?, w?, h? — a named container box; position/size optional: auto-stacks below existing regions with defaults 640×400); updateRegion (id, label?, kind?, x?, y?, w?, h?); deleteRegion (id — removes only the box, nodes stay); fitRegion (id — snap the box tightly around its member nodes; regions also auto-grow as nodes are added with regionId); batchAddMedia (items: [{kind, url, prompt?, model?, position?, regionId?, nodeId?}]). On reject, the whole batch fails — fix the lint hint and retry.\n\n' +
        'Data contract (non-blocking, but you should follow it):\n' +
        '  • text nodes MUST carry data.text (non-empty string)\n' +
        '  • note nodes MUST carry data.content (non-empty string)\n' +
        '  • image/video/music nodes are filled by a later refresh_node call (resultUrl arrives then)\n' +
        '  • region membership: nodes created with regionId carry data.region automatically; put data.region in updateNode to move a node into a region\n' +
        'If you omit data.text or data.content, the node still gets created — but the lint pass will emit a warning, and the rendered card will show an "empty" placeholder to the user. After creating any text/note node you MUST follow up with updateNode(id, {text|content: ...}) or include data.text / data.content inline in the same addNode op. Never rely on the empty placeholder.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        ops: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { applied: number; version: number; lintOk: boolean; issues: string[] }
          const advisoryCount = v.issues.filter((s) => s.startsWith('warn:')).length
          const advisorySuffix = advisoryCount > 0
            ? `; ${advisoryCount} media registration advisory(ies)`
            : ''
          return [{
            type: 'text' as const,
            text: `applied ${v.applied} ops → version ${v.version}; lint: ${v.lintOk ? 'pass' : 'warnings'}${advisorySuffix}`,
          }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const ops = Array.isArray(args.ops) ? (args.ops as unknown as CanvasOp[]) : []
        if (ops.length === 0) throw new Error('canvas_graph_patch: ops must be a non-empty array')
        if (ops.length > 60) throw new Error(`canvas_graph_patch: batch too large (${ops.length} ops, max 60)`)
        const result = store.apply(canvasId, ops)

        // Shared post-processing (pin remote URLs → migrate inaccessible →
        // auto-register assets). Extracted so the REST API endpoint follows
        // the exact same code path — previously REST patches skipped these
        // steps, leaving provider URLs to expire into broken cards.
        const issues = await postProcessCanvasPatch(store, canvasId, ops, result.issues)

        return {
          applied: result.patch.length,
          version: result.version,
          lintOk: result.lintOk,
          issues,
        }
      },
    }),
  )
}

/**
 * `canvas_auto_arrange` — re-layout nodes by topological depth. All nodes by
 * default; pass `regionId` to re-arrange ONLY the nodes inside that region
 * (constrained within the region bounds), so per-region tidy-ups never
 * break a partitioned canvas.
 */
export function registerAutoArrangeTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_auto_arrange',
      description: 'Auto-arrange nodes by topological flow depth (columns ordered by BFS from sources, nodes stacked vertically within each column). Mirrors the client\'s bottom-right wand button. Pass regionId to arrange only the nodes inside that region (kept within the region box) — use this for per-region tidy-ups so a partitioned layout stays intact.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        regionId: { type: 'string', description: 'Optional region id — when set, only nodes whose data.region matches are re-arranged, constrained inside the region bounds.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `auto-arranged → version ${(value as { version: number }).version}; lint: ${(value as { lintOk: boolean }).lintOk ? 'pass' : 'warnings'}`,
        }],
      },
      async execute(args) {
        const store = getMediaStudioHandles().canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const regionId = typeof args.regionId === 'string' && args.regionId.trim() ? args.regionId.trim() : undefined
        const result = store.autoArrange(canvasId, regionId ? { regionId } : undefined)
        return {
          applied: result.patch.length,
          version: result.version,
          lintOk: result.lintOk,
          issues: result.issues,
        }
      },
    }),
  )
}

/** The tool output shape — a single prompt + whether it had upstream content. */
const refreshNodeOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      ok: { type: 'boolean' as const },
      code: { type: 'string' as const },
      message: { type: 'string' as const },
      prompt: { type: 'string' as const },
      kind: { type: 'string' as const },
      url: { type: 'string' as const },
    },
  },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: (value as { ok: boolean; prompt?: string; url?: string; message?: string }).ok
      ? `refreshed node "${(value as { kind: string }).kind}": ${(value as { url: string }).url?.slice(0, 80) || ''}`
      : `refresh failed: ${(value as { message: string }).message}`,
  }],
} satisfies { schema: ValueSchemaSpec; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }

export function registerCanvasRefreshNodeTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_refresh_node',
      description:
        'Refresh a canvas node by regenerating its media through the dsh-llm-multimodal plugin (generate_image / generate_video / generate_tts / generate_music). Sets status to "running" during generation and updates resultUrl on completion.\n\n' +
        'UPSTREAM-DRIVEN, ONE-WAY: the node is recompiled from ALL of its first-layer upstream nodes (edges whose target is this node) — upstream text/prompt is concatenated as context, upstream IMAGES are all passed as visual references, and upstream AUDIO seeds a TTS voice clone. Refresh NEVER writes to any upstream node; it only writes the target node. The compiled prompt is stored in data.lastPrompt; data.prompt keeps the authored intent and is NOT overwritten (so repeated refreshes are idempotent).\n\n' +
        'IMAGE nodes: prompt = data.prompt + upstream context; every upstream image node (and video poster) is passed as generate_image.image[] (multi-image I2I / composition). Honors data.size and data.negativePrompt.\n\n' +
        'VIDEO nodes: prompt = data.prompt + upstream context; duration/size from data. Multi-frame I2V via edge labels — the upstream image labelled "首帧参考" is the first frame, the one labelled "尾帧衔接" is the last frame (native first+last-frame generation, produces real shot continuity); any remaining upstream images are passed as a reference set (mode "reference"). Set data.videoMode to force "text" | "ti2vid" | "keyframe" | "keyframes" | "reference". Honors data.negativePrompt.\n\n' +
        'MUSIC nodes: upstream text (raw, unlabelled) wins over data.prompt — dialogue/voice-over nodes (data.dub: true) re-run generate_tts, other music nodes re-run generate_music. Honors data.voice, data.speed, data.voice_name, data.clone_audio, data.clone_voice_id; when a dub node has an upstream music node and no explicit data.clone_audio, that upstream audio is used as the voice-clone seed so the character timbre propagates.\n\n' +
        'ASSET CLASSIFICATION (image nodes only, optional but recommended): before/after refreshing an image node, set data.assetKind to the asset-library bucket the generated image belongs to — "character" (人物设定/立绘), "scene" (场景/背景), "prop" (道具), "conceptart" (概念设计), "reference" (参考图). When set, the downloaded file lands in the matching <project>/assets/<kind>/ subdirectory (or <wsRoot>/web-jobs/ for projects without a sourcePath). The file is NOT auto-registered into the asset-library index — the project library only tracks character/scene/audio/clip categories, so refresh-produced media stays visible on the canvas and in cross-project search (catalog "canvas") but appears in the library panel only after media_studio_register_asset. Video nodes always land in assets/clips/; music/TTS in assets/audio/.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        nodeId: { type: 'string', description: 'The node id to refresh. Must exist on the canvas.' },
      },
      output: refreshNodeOutput,
      async execute(args, exec) {
        const mst = getMediaStudioHandles()
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.nodeId).trim()
        if (!nodeId) return { ok: false, code: 'missing-node-id', message: 'nodeId is required', kind: 'image' }
        return executeNodeRefresh(mst.canvasStore, canvasId, nodeId, exec.signal, ctx)
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-node CRUD tools (M5) — the agent's preferred entry for one-off
// mutations. Each tool wraps a single op through `store.apply()` so it
// reuses the same atomicity / SSE / persist / lint path as
// `canvas_graph_patch`. Reserve `canvas_graph_patch` for multi-op batches.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `canvas_node_view` — read one node by id. The cheapest way to verify a
 * node exists or fetch its current data after an SSE event (no mutation
 * path, no store.apply call).
 */
export function registerCanvasNodeViewTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_node_view',
      description:
        'Read one canvas node by id without any mutation. Use this to verify a node exists, or to fetch its current data after an SSE event (cheaper than reading the whole snapshot). Returns the full node + current version.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The node id to look up. Required.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; node?: { id: string; label: string; type: string }; version: number }).ok
            ? `node "${(value as { node: { id: string; label: string } }).node.id}" [(value as { node: { type: string } }).node.type] "${(value as { node: { label: string } }).node.label}" — version ${(value as { version: number }).version}`
            : `not found: ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.id).trim()
        if (!nodeId) return { ok: false, code: 'missing-node-id', message: 'id is required' }
        const snap = store.snapshot(canvasId)
        const node = snap.graph.nodes.find((n) => n.id === nodeId)
        if (!node) return { ok: false, code: 'node-not-found', message: `node "${nodeId}" not found on canvas "${canvasId}"` }
        return { ok: true, node: node as unknown as JsonValue, version: snap.version } as unknown as JsonValue
      },
    }),
  )
}

/**
 * `canvas_node_add` — create a single node. The store auto-generates an id
 * when `nodeId` is omitted, or returns `{ ok:false, code:'duplicate-node-id' }`
 * when the provided id already exists. Position defaults to the store's
 * `defaultSlot` auto-placement grid.
 */
export function registerCanvasNodeAddTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_node_add',
      description:
        'Add a single canvas node. The store auto-places it (defaultSlot grid) when `position` is omitted, and auto-generates a unique id when `nodeId` is omitted — the generated id is returned in the response so you can reference it in follow-ups.\n\n' +
        'When `nodeId` IS provided and already exists, returns `{ ok: false, code: "duplicate-node-id" }` instead of silently upgrading. To mutate an existing node use `canvas_node_update` / `canvas_node_rename`.\n\n' +
        'Does NOT auto-register as an asset — that\'s only for media nodes with a `resultUrl`, and the existing `canvas_graph_patch` tool handles that via `batchAddMedia`. Use this for placeholders and incremental builds; if you need auto-registration call `media_studio_register_asset` separately.',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        type: {
          type: 'string' as const,
          enum: ['text', 'image', 'video', 'music', 'note'] as const,
          description: 'Node type. Must be one of: text, image, video, music, note.',
        },
        label: { type: 'string', description: 'User-facing label. Required, non-empty.' },
        data: {
          type: 'object' as const,
          additionalProperties: true as const,
          description: 'Free-form data attached to the node. Defaults to {}. For image nodes, set data.assetKind to classify the output into a library bucket — "character" (人物设定/立绘), "scene" (场景/背景), "prop" (道具), "conceptart" (概念设计), "reference" (参考图). Files land in <project>/assets/<assetKind>s/ and are indexed as library assets. Optional data.tags (string array) and data.characterRef (legacy) also influence bucket choice when assetKind is unset.',
        },
        position: {
          type: 'object' as const,
          additionalProperties: false as const,
          description: 'Optional explicit position {x, y} in px. When omitted the store auto-places the node.',
          properties: {
            x: { type: 'number' as const },
            y: { type: 'number' as const },
          },
        },
        nodeId: { type: 'string', description: 'Optional explicit id. When omitted the store generates one. If provided and already exists, returns code:"duplicate-node-id".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; node?: { id: string; label: string } }).ok
            ? `added node "${(value as { node: { id: string; label: string } }).node.id}" [(value as { node: { label: string } }).node.label] → version ${(value as { version: number }).version}`
            : `add failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const type = args.type as CanvasNode['type'] | undefined
        const label = typeof args.label === 'string' ? args.label.trim() : ''
        const data = (typeof args.data === 'object' && args.data !== null && !Array.isArray(args.data)) ? (args.data as Record<string, unknown>) : {}
        const position = (typeof args.position === 'object' && args.position !== null && !Array.isArray(args.position))
          ? (args.position as { x: number; y: number })
          : undefined
        const nodeId = (typeof args.nodeId === 'string' && args.nodeId.trim()) ? args.nodeId.trim() : undefined
        if (!type) return { ok: false, code: 'missing-type', message: 'type is required (text|image|video|music|note)' } as unknown as JsonValue
        if (!label) return { ok: false, code: 'missing-label', message: 'label is required (non-empty string)' } as unknown as JsonValue
        try {
          // Default the status to 'idle' for media nodes so the card renders
          // a clean "no image yet" placeholder instead of looking like a
          // permanent error when the agent hasn't attached a resultUrl yet
          // (the very common "create → fill later via canvas_refresh_node"
          // flow). Without this, nodes without data.status render with
          // `status-${undefined}` which doesn't match any rule and gets
          // stuck on an empty shell — the "media node added but won't load"
          // report.
          const initialData: Record<string, unknown> = { ...data }
          if ((type === 'image' || type === 'video' || type === 'music') && !initialData.status) {
            initialData.status = 'idle'
          }
          // If the caller passed an https:// resultUrl directly in data,
          // pin it into the project assets before storing — same defensive
          // copy the batchAddMedia path does, so agents who skip the
          // batchAddMedia helper don't end up with a URL that expires
          // under the user's feet.
          const rawUrl = initialData.resultUrl
          if (typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl.trim()) && (type === 'image' || type === 'video' || type === 'music')) {
            const projectId = mst.projectStore?.activeCanvasId?.() ?? null
            const sourcePath = (() => {
              if (!projectId || !mst.projectStore) return undefined
              const snap = mst.projectStore.snapshot?.()
              if (!snap) return undefined
              return snap.projects.find((p) => p.id === projectId)?.sourcePath
            })()
            const kind: AssetKind | null = type === 'image' ? 'character' : type === 'video' ? 'clip' : 'audio'
            if (projectId && kind) {
              const pinned = await pinRemoteResultUrl(rawUrl, projectId, mst.workspaceRoot, sourcePath, kind)
              if (pinned.ok && pinned.url) {
                initialData.resultUrl = pinned.url
              }
            }
          }
          const result = store.apply(canvasId, [{
            op: 'addNode',
            type,
            label,
            data: Object.keys(initialData).length > 0 ? initialData : undefined,
            ...(position ? { position } : {}),
            ...(nodeId ? { nodeId } : {}),
          }])
          const node = result.graph.nodes[result.graph.nodes.length - 1]
          return { ok: true, node: node as unknown as JsonValue, version: result.version, lintOk: result.lintOk, issues: result.issues } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('duplicate node id')) return { ok: false, code: 'duplicate-node-id', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_node_update` — shallow-merge `data` into one node. To REMOVE a key,
 * use `canvas_graph_patch` with the key set to `undefined` (this tool merges,
 * never deletes).
 */
export function registerCanvasNodeUpdateTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_node_update',
      description:
        'Shallow-merge `data` into the node\'s existing `data` map (same semantics as the `updateNode` op in `canvas_graph_patch`). Keys not present in `data` are preserved.\n\n' +
        'To remove a key from data, use `canvas_graph_patch` with the key set to `undefined` (or delete-and-recreate the node with `canvas_node_delete` + `canvas_node_add`).\n\n' +
        'Returns the full merged node so you can verify the result without a follow-up view call.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The node id to update. Required.' },
        data: {
          type: 'object' as const,
          additionalProperties: true as const,
          description: 'Data to shallow-merge into the node. Required.',
        },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; node?: { id: string } }).ok
            ? `updated node "${(value as { node: { id: string } }).node.id}" → version ${(value as { version: number }).version}`
            : `update failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.id).trim()
        const data = (typeof args.data === 'object' && args.data !== null && !Array.isArray(args.data)) ? (args.data as Record<string, unknown>) : undefined
        if (!nodeId) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        if (!data) return { ok: false, code: 'missing-data', message: 'data is required (object to merge)' } as unknown as JsonValue
        try {
          // If the update is setting an https resultUrl on an image/video/music
          // node, pin it locally first — same defensive copy the add / patch
          // paths do — so an LLM that writes the URL via canvas_node_update
          // instead of canvas_graph_patch doesn't bypass expiration handling.
          const extraIssues: string[] = []
          const node = store.snapshot(canvasId).graph.nodes.find((n) => n.id === nodeId)
          const rawUrl = data.resultUrl
          if (node && (node.type === 'image' || node.type === 'video' || node.type === 'music') && typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl.trim())) {
            const projectId = mst.projectStore?.activeCanvasId?.() ?? null
            const sourcePath = (() => {
              if (!projectId || !mst.projectStore) return undefined
              const snap = mst.projectStore.snapshot?.()
              if (!snap) return undefined
              return snap.projects.find((p) => p.id === projectId)?.sourcePath
            })()
            const kind: AssetKind | null = node.type === 'image' ? 'character' : node.type === 'video' ? 'clip' : 'audio'
            if (projectId && kind) {
              const pinned = await pinRemoteResultUrl(rawUrl, projectId, mst.workspaceRoot, sourcePath, kind)
              if (pinned.ok && pinned.url) {
                data.resultUrl = pinned.url
              } else if (pinned.error) {
                extraIssues.push(`warn: could not pin remote url "${rawUrl.slice(0, 80)}": ${pinned.error}`)
              }
            }
          }
          const result = store.apply(canvasId, [{ op: 'updateNode', id: nodeId, data }])
          const merged = result.graph.nodes.find((n) => n.id === nodeId)
          const issues = [...result.issues, ...extraIssues]
          return { ok: true, node: merged as unknown as JsonValue, version: result.version, lintOk: result.lintOk, issues } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'node-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_node_rename` — change only the label field of one node.
 */
export function registerCanvasNodeRenameTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_node_rename',
      description:
        'Change the label of one node. Only the `label` field is touched; `data` and all other fields are preserved.\n\n' +
        'Returns the full updated node so you can verify the new label without a follow-up view call.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The node id to rename. Required.' },
        label: { type: 'string', description: 'New label. Required, non-empty.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; node?: { id: string; label: string } }).ok
            ? `renamed node "${(value as { node: { id: string; label: string } }).node.id}" → "${(value as { node: { label: string } }).node.label}" — version ${(value as { version: number }).version}`
            : `rename failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.id).trim()
        const label = typeof args.label === 'string' ? args.label.trim() : ''
        if (!nodeId) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        if (!label) return { ok: false, code: 'missing-label', message: 'label is required (non-empty string)' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{ op: 'renameNode', id: nodeId, label }])
          const node = result.graph.nodes.find((n) => n.id === nodeId)
          return { ok: true, node: node as unknown as JsonValue, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'node-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_node_delete` — delete one node. All edges connected to this node
 * (where it's source OR target) are automatically removed as part of the
 * deletion (inherited from `store.apply`). To keep edges and orphan the node,
 * the agent must not call this tool — use `canvas_graph_patch` with
 * `deleteEdge` ops first, then delete the node.
 */
export function registerCanvasNodeDeleteTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_node_delete',
      description:
        'Delete one node from the canvas. All edges connected to this node (where it\'s source OR target) are automatically removed as part of the deletion — this is the existing store behavior inherited via `store.apply()`.\n\n' +
        'To keep edges and orphan the node, the agent must not call this tool: instead use `canvas_graph_patch` with `deleteEdge` ops first, then optionally delete the node.\n\n' +
        'Returns the deleted node id + new version so the agent can chain follow-ups.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The node id to delete. Required.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; deletedId?: string }).ok
            ? `deleted node "${(value as { deletedId: string }).deletedId}" → version ${(value as { version: number }).version}`
            : `delete failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.id).trim()
        if (!nodeId) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{ op: 'deleteNode', id: nodeId }])
          return { ok: true, deletedId: nodeId, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'node-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Project management tools (Agent-side wrappers over the REST endpoints
// registered in project-routes.ts). These exist so the agent can drive the
// multi-project layer directly — without these, the agent was only able to
// operate the canvas of whichever project happened to be active in the GUI.
//
// All writes funnel through ProjectStore's single-writer queue; all
// mutations emit registry-changed / project-open / project-deleted on the
// projects SSE so any open Media Studio tab refreshes.
//
// Output shape mirrors the REST endpoints:
//   list / create / open / rename → { ok, project, registry, recentLimit? }
//   delete → { ok, result, registry } | { ok:false, code:'project-referenced', dependents }
// ─────────────────────────────────────────────────────────────────────────────

function requireProjectStore(): NonNullable<ReturnType<typeof getMediaStudioHandles>['projectStore']> {
  const ps = getMediaStudioHandles().projectStore
  if (!ps) throw new Error('media_studio: projectStore is not initialized (plugin not ready?)')
  return ps
}

/**
 * `canvas_region_add` — create one region (a named container box). Regions
 * give a partitioned canvas: group related nodes inside a box and label it
 * so the user can read which block is the flow, which are the character
 * assets, the scene assets, the storyboard, etc. Regions carry no content
 * themselves; node membership is declared via `data.region` (auto-set when
 * the node is created with a regionId).
 */
export function registerCanvasRegionAddTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_region_add',
      description:
        'Add one region (a named container box) to the canvas. Regions partition the canvas into labeled areas — use them to group nodes into clear blocks (flow overview, script, character assets, scene assets, storyboard, media/audio). The region auto-stacks below existing regions when x/y are omitted, with default size 640×400 (w/h optional).\n\n' +
        'Membership: after adding the region, create nodes with the same `regionId` (addNode/batchAddMedia regionId) or set data.region via canvas_node_update — region-aware auto-arrange and the grid placement then treat them as inside this box.\n\n' +
        'Deleting a region never deletes nodes — it only removes the box.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        label: { type: 'string', description: 'Region title rendered in the box header. Required, non-empty.' },
        kind: { type: 'string', description: 'Optional classification used for tinting: e.g. flow | script | characters | scenes | storyboard | media | generic.' },
        id: { type: 'string', description: 'Optional explicit region id. When omitted the store generates one (returned in the response).' },
        x: { type: 'number', description: 'Optional left coordinate (px). Omitted → auto-stack below the lowest existing region.' },
        y: { type: 'number', description: 'Optional top coordinate (px). Omitted → auto-stack below the lowest existing region.' },
        w: { type: 'number', description: 'Optional width (px). Default 640.' },
        h: { type: 'number', description: 'Optional height (px). Default 400.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; region?: { id: string; label: string } }).ok
            ? `added region "${(value as { region: { id: string; label: string } }).region.id}" (${(value as { region: { label: string } }).region.label}) → version ${(value as { version: number }).version}`
            : `add region failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const label = typeof args.label === 'string' ? args.label.trim() : ''
        const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : undefined
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined
        const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
        if (!label) return { ok: false, code: 'missing-label', message: 'label is required (non-empty string)' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{
            op: 'addRegion',
            label,
            ...(kind ? { kind } : {}),
            ...(id ? { id } : {}),
            ...(num(args.x) !== undefined ? { x: num(args.x) } : {}),
            ...(num(args.y) !== undefined ? { y: num(args.y) } : {}),
            ...(num(args.w) !== undefined ? { w: num(args.w) } : {}),
            ...(num(args.h) !== undefined ? { h: num(args.h) } : {}),
          }])
          const region = result.graph.regions[result.graph.regions.length - 1]
          return { ok: true, region: region as unknown as JsonValue, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('duplicate region id')) return { ok: false, code: 'duplicate-region-id', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_region_update` — change a region's label / kind / bounds.
 */
export function registerCanvasRegionUpdateTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_region_update',
      description:
        'Update one region: change its label, kind, or x/y/w/h bounds. Only provided fields change (shallow update). Nodes inside keep their positions even when the box moves — move the box first, then re-arrange with canvas_auto_arrange(regionId) if you want them to follow.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The region id to update. Required.' },
        label: { type: 'string', description: 'New region title.' },
        kind: { type: 'string', description: 'New classification (flow | script | characters | scenes | storyboard | media | generic …).' },
        x: { type: 'number', description: 'New left coordinate (px).' },
        y: { type: 'number', description: 'New top coordinate (px).' },
        w: { type: 'number', description: 'New width (px).' },
        h: { type: 'number', description: 'New height (px).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; region?: { id: string; label: string } }).ok
            ? `updated region "${(value as { region: { id: string; label: string } }).region.id}" → version ${(value as { version: number }).version}`
            : `update region failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const id = String(args.id).trim()
        const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
        if (!id) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{
            op: 'updateRegion',
            id,
            ...(typeof args.label === 'string' ? { label: args.label } : {}),
            ...(typeof args.kind === 'string' ? { kind: args.kind } : {}),
            ...(num(args.x) !== undefined ? { x: num(args.x) } : {}),
            ...(num(args.y) !== undefined ? { y: num(args.y) } : {}),
            ...(num(args.w) !== undefined ? { w: num(args.w) } : {}),
            ...(num(args.h) !== undefined ? { h: num(args.h) } : {}),
          }])
          const region = result.graph.regions.find((r) => r.id === id)
          return { ok: true, region: region as unknown as JsonValue, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'region-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_region_delete` — remove a region box. Nodes keep their positions
 * and edges; only the container is removed.
 */
export function registerCanvasRegionDeleteTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_region_delete',
      description:
        'Delete one region (the container box) from the canvas. Nodes and edges inside are untouched — only the box and its label disappear. Deleting a region does NOT cascade to nodes.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The region id to delete. Required.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; deletedId?: string }).ok
            ? `deleted region "${(value as { deletedId: string }).deletedId}" → version ${(value as { version: number }).version}`
            : `delete region failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const id = String(args.id).trim()
        if (!id) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{ op: 'deleteRegion', id }])
          return { ok: true, deletedId: id, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'region-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

/**
 * `canvas_region_fit` — snap a region box to the tight bounding box of its
 * member nodes (small padding + header). Regions already grow automatically
 * as nodes are added with `regionId`; this is for tidying up after nodes
 * were dragged in/out manually.
 */
export function registerCanvasRegionFitTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_region_fit',
      description:
        'Fit one region\'s box tightly around its member nodes (small padding, header band on top). ' +
        'Regions auto-grow as nodes are added with regionId, so this is only needed after manual node ' +
        'drags leave members outside the box. Empty regions are left untouched.\n\n' +
        CANVAS_RULES,
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        id: { type: 'string', description: 'The region id to fit. Required.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args: unknown, value: unknown) => [{
          type: 'text' as const,
          text: (value as { ok: boolean; region?: { id: string; x: number; y: number; w: number; h: number } }).ok
            ? `fitted region "${(value as { region: { id: string; x: number; y: number; w: number; h: number } }).region.id}" → ` +
              `${(value as { region: { x: number; y: number; w: number; h: number } }).region.w}×${(value as { region: { h: number } }).region.h} ` +
              `at (${(value as { region: { x: number; y: number } }).region.x},${(value as { region: { y: number } }).region.y}) → version ${(value as { version: number }).version}`
            : `fit region failed: ${(value as { code: string; message: string }).code} — ${(value as { message: string }).message}`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const id = String(args.id).trim()
        if (!id) return { ok: false, code: 'missing-id', message: 'id is required' } as unknown as JsonValue
        try {
          const result = store.apply(canvasId, [{ op: 'fitRegion', id }])
          const region = result.graph.regions.find((r) => r.id === id)
          return { ok: true, region, version: result.version } as unknown as JsonValue
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('not found')) return { ok: false, code: 'region-not-found', message: msg } as unknown as JsonValue
          return { ok: false, code: 'apply-failed', message: msg } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioListProjectsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_list_projects',
      description:
        'List every registered media-studio project (active + recent ≤ recentLimit + all). ' +
        'Returns the registry snapshot the GUI shows in the "项目" menu. Read-only.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { projects: unknown[]; activeId: string | null; recent: string[] }
          return [{
            type: 'text' as const,
            text: `${v.projects.length} project(s); active=${v.activeId ?? '(none)'}; recent=[${v.recent.join(', ')}]`,
          }]
        },
      },
      async execute() {
        const ps = requireProjectStore()
        await ps.ready()
        const snap = ps.snapshot()
        return { ok: true, ...snap, recentLimit: ps.getRecentLimit() } as unknown as JsonValue
      },
    }),
  )
}

export function registerMediaStudioCreateProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_create_project',
      description:
        'Create a new media-studio project. Without `sourcePath` the project lives in the legacy ' +
        'workspace layout and is fully owned by media-studio. With `sourcePath` (an absolute host ' +
        'directory the agent or user chose) the project\'s canvas + assets are placed INSIDE that ' +
        'user-owned directory; media-studio only owns the registry entry. The new project is also ' +
        'activated and pushed to the front of `recent`.\n\n' +
        'AUTO-FOCUS: after this tool returns, the plugin broadcasts a `project-focused` SSE event ' +
        'that the Media Studio client-side listener picks up to activate the sidebar Media Studio ' +
        'tab. No further GUI action is required.\n\n' +
        CANVAS_RULES,
      parameters: {
        name: { type: 'string', description: 'Display name (optional; auto-default "未命名项目 N" when blank). Max 64 chars; no \\ / : * ? " < > |.' },
        sourcePath: { type: 'string', description: 'Optional absolute host directory the project\'s data lives under. Pass the path returned by media_studio_pick_folder, or omit for a managed workspace project.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { id: string; name: string }; error?: string }
          return [{
            type: 'text' as const,
            text: v.ok ? `created project "${v.project!.name}" (id=${v.project!.id})` : `create failed: ${v.error}`,
          }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        try {
          const sourcePath = typeof args.sourcePath === 'string' && args.sourcePath.trim() ? args.sourcePath.trim() : undefined
          const meta = await ps.createProject(typeof args.name === 'string' ? args.name : undefined, sourcePath)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, code: 'create-failed', error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioPickFolderTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_pick_folder',
      description:
        'macOS only: open the native NSOpenPanel so the user can choose a host directory; ' +
        'returns the absolute POSIX path (or { canceled: true }). The path can then be passed ' +
        'to `media_studio_create_project({ sourcePath })` to make the chosen directory a real ' +
        'project. On non-macOS hosts the tool returns { ok:false, code:"unsupported-platform" }.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; canceled?: boolean; path?: string | null; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `pick failed: ${v.error}` }]
          return [{ type: 'text' as const, text: v.canceled ? 'user canceled' : `selected: ${v.path}` }]
        },
      },
      async execute() {
        if (process.platform !== 'darwin') {
          return { ok: false, code: 'unsupported-platform', error: 'native folder picker is only available on macOS' } as unknown as JsonValue
        }
        const { spawn } = await import('node:child_process')
        const script = 'set selectedFolder to choose folder with prompt "选择项目文件夹"\nPOSIX path of selectedFolder\n'
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const useLaunchctl = uid !== null
        const cmd = useLaunchctl ? 'launchctl' : 'osascript'
        const args: string[] = useLaunchctl ? ['asuser', String(uid), 'osascript'] : []
        return await new Promise<{ ok: boolean; canceled?: boolean; path?: string | null; error?: string }>((resolve) => {
          const proc = spawn(cmd, [...args, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
          proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
          proc.on('close', (code: number | null) => {
            if (code === 0) { resolve({ ok: true, canceled: false, path: out.trim() || null }); return }
            if (code === null || /User canceled|-128|InterruptedError/i.test(err)) {
              resolve({ ok: true, canceled: true, path: null })
              return
            }
            resolve({ ok: false, error: `osascript failed (code ${code}): ${err.trim() || out.trim()}` })
          })
          proc.on('error', (e) => resolve({ ok: false, error: e.message }))
        })
      },
    }),
  )
}

export function registerMediaStudioOpenProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_open_project',
      description:
        'Activate an existing project (bumping it to the front of `recent` and restoring its canvas ' +
        'from disk). Subsequent canvas_graph_* tool calls without an explicit canvasId will land on ' +
        'this project\'s canvas. Returns the refreshed registry so the agent can verify activeId.\n\n' +
        'AUTO-FOCUS: same as media_studio_create_project — broadcasts a `project-focused` SSE event ' +
        'that activates the sidebar Media Studio tab. No further GUI action is required.\n\n' +
        CANVAS_RULES,
      parameters: {
        projectId: { type: 'string', description: 'Project id (p-… format).', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { id: string; name: string }; error?: string }
          return [{
            type: 'text' as const,
            text: v.ok ? `opened project "${v.project!.name}" (id=${v.project!.id})` : `open failed: ${v.error}`,
          }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        if (!id) return { ok: false, error: 'projectId is required' }
        try {
          const meta = await ps.openProject(id)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioRenameProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_rename_project',
      description:
        'Rename a project. id is immutable — only `name` changes. When the project has a user-owned ' +
        '`sourcePath` (created via the folder picker or migrated from a legacy canvas) the on-disk ' +
        'directory is renamed in lock-step and projects.json is updated; existing references survive ' +
        'the rename. Fails with a clear error when the target directory already exists.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        name: { type: 'string', description: 'New display name. 1–64 chars; no \\ / : * ? " < > |.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { name: string }; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `renamed → "${v.project!.name}"` : `rename failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        const name = typeof args.name === 'string' ? args.name : ''
        if (!id) return { ok: false, error: 'projectId is required' }
        try {
          const meta = await ps.renameProject(id, name)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioDeleteProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_delete_project',
      description:
        'Delete a project. Default mode is `trash` (recoverable under <wsRoot>/trash/) and default ' +
        'cascade is `cancel` — when other projects soft-reference this one\'s assets, the call returns ' +
        '`{ ok:false, code:"project-referenced", dependents:{...} }` so you can pick a cascade mode ' +
        'and retry. Modes: mode=`trash`|`permanent`; cascade=`cancel`|`break-refs`|`migrate-shared`. ' +
        '`migrate-shared` copies referenced assets into the __shared library and rewrites the ' +
        'referencing nodes\' `assetRef.projectId` so nothing breaks. `break-refs` marks every ' +
        'referencing node `brokenAsset:true`. `cancel` is the safe default.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        mode: { type: 'string', description: '"trash" (default, recoverable) or "permanent".' },
        cascade: { type: 'string', description: '"cancel" (default), "break-refs", or "migrate-shared".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; code?: string; error?: string; dependents?: { totalRefs?: number }; result?: { deletedId: string; switchedTo: string | null } }
          if (v.ok) return [{ type: 'text' as const, text: `deleted ${v.result!.deletedId}; switchedTo=${v.result!.switchedTo ?? '(none)'}` }]
          if (v.code === 'project-referenced') return [{ type: 'text' as const, text: `delete blocked: ${v.dependents?.totalRefs ?? 0} soft reference(s); choose a cascade mode and retry` }]
          return [{ type: 'text' as const, text: `delete failed: ${v.error ?? '(unknown)'}` }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        if (!id) return { ok: false, error: 'projectId is required' }
        const mode = args.mode === 'permanent' ? 'permanent' as const : 'trash' as const
        const cascadeRaw = String(args.cascade ?? 'cancel')
        const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
        try {
          const result = await ps.deleteProject(id, mode, cascade as 'cancel' | 'break-refs' | 'migrate-shared')
          return { ok: true, result, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          if (e instanceof ProjectDeleteBlockedError) {
            return { ok: false, code: 'project-referenced', dependents: e.dependents, error: e.message } as unknown as JsonValue
          }
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset library management tools (Agent-side wrappers over asset-routes.ts).
// All asset mutations emit `asset-changed` on the projects SSE so any open
// Media Studio tab refreshes its library panel.
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_KIND_VALUES = ['character', 'scene', 'audio', 'clip'] as const
function asAssetKind(v: unknown): AssetKind | null {
  return typeof v === 'string' && (ASSET_KIND_VALUES as readonly string[]).includes(v) ? (v as AssetKind) : null
}

export function registerMediaStudioListAssetsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_list_assets',
      description:
        'List every asset in a project\'s library (categories: character / scene / audio / clip). ' +
        'Returns the metadata stored in assets/.index.json — file paths, tags, origin, copyOf ' +
        'provenance. The 4 categories correspond to the 4 tabs the GUI shows in the asset panel.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; assets?: unknown[]; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `${v.assets!.length} asset(s)` : `list failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        if (!pid) return { ok: false, error: 'projectId is required' }
        try {
          const assets = await listAssets(mst.workspaceRoot, pid, ps.resolveSourcePath(pid))
          return { ok: true, projectId: pid, assets } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioRegisterAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_register_asset',
      description:
        'Promote a canvas node\'s media into a project\'s asset library. Idempotent: re-registering ' +
        'the same canvasNodeId returns the existing asset instead of creating a duplicate. The node\'s ' +
        'media file is copied into <project>/assets/<kind>/<assetId>.<ext> and registered in the index. ' +
        '`kind` is the asset-library category (character / scene / audio / clip); canvas node type → ' +
        'default kind mapping is image→character, video→clip, music→audio.',
      parameters: {
        projectId: { type: 'string', description: 'Project id the node belongs to.', required: true },
        canvasNodeId: { type: 'string', description: 'Canvas node id to register from.', required: true },
        kind: { type: 'string', description: 'Asset category: "character" | "scene" | "audio" | "clip".', required: true },
        name: { type: 'string', description: 'Optional display name (defaults to the node label).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; created?: boolean; asset?: { id: string; name: string }; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `register failed: ${v.error}` }]
          return [{ type: 'text' as const, text: `${v.created ? 'created' : 'updated'} asset "${v.asset!.name}" (id=${v.asset!.id})` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const nodeId = String(args.canvasNodeId ?? '').trim()
        const kind = asAssetKind(args.kind)
        if (!pid || !nodeId) return { ok: false, error: 'projectId and canvasNodeId are required' }
        if (!kind) return { ok: false, error: `kind must be one of: ${ASSET_KIND_VALUES.join(', ')}` }
        try {
          const r = await registerCanvasAsset({
            wsRoot: mst.workspaceRoot,
            roots: mst.mediaRoots ?? [],
            canvasStore: mst.canvasStore,
            projectId: pid,
            sourcePath: ps.resolveSourcePath(pid),
            canvasNodeId: nodeId,
            kind,
            name: typeof args.name === 'string' ? args.name : undefined,
          })
          return { ok: true, created: r.created, asset: r.asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioUpdateAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_update_asset',
      description:
        'Update an asset\'s display name and/or tags. The underlying file (named <assetId>.<ext>) ' +
        'is untouched — rename never breaks references. Tags are capped at 12 entries.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        assetId: { type: 'string', description: 'Asset id (a-… format).', required: true },
        name: { type: 'string', description: 'Optional new display name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag list (max 12 entries, replaces existing).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; asset?: { name: string }; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `updated asset "${v.asset!.name}"` : `update failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        if (!pid || !aid) return { ok: false, error: 'projectId and assetId are required' }
        const patch: { name?: string; tags?: string[] } = {}
        if (args.name !== undefined) patch.name = String(args.name)
        if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map((x) => String(x)).slice(0, 12)
        try {
          const asset = await updateAssetMeta(mst.workspaceRoot, pid, aid, patch, ps.resolveSourcePath(pid))
          return { ok: true, asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioDeleteAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_delete_asset',
      description:
        'Delete one asset. cascade="cancel" (default) refuses when other projects hold soft refs on ' +
        'this asset and returns `{ ok:false, dependents:{...} }` so the agent can re-decide. ' +
        'cascade="migrate-shared" copies the asset into __shared and rewrites references. ' +
        'cascade="break-refs" marks every referencing canvas node `brokenAsset:true`.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        assetId: { type: 'string', description: 'Asset id.', required: true },
        cascade: { type: 'string', description: '"cancel" (default), "break-refs", or "migrate-shared".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; error?: string; dependents?: { totalRefs?: number }; result?: { deletedId: string } }
          if (v.ok) return [{ type: 'text' as const, text: `deleted asset ${v.result!.deletedId}` }]
          return [{ type: 'text' as const, text: `delete failed: ${v.error ?? 'blocked'} (${v.dependents?.totalRefs ?? 0} ref(s))` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        if (!pid || !aid) return { ok: false, error: 'projectId and assetId are required' }
        const cascadeRaw = String(args.cascade ?? 'cancel')
        const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
        try {
          // Preflight so the agent sees a structured "blocked" payload matching the
          // project-level contract — the underlying deleteAsset throws AssetDeleteBlockedError
          // (we surface it as ok:false) and runScan returns the same dependents info.
          const projectIds = ps.snapshot().projects.map((p) => p.id)
          const hits = scanCanvasRefs(mst.canvasStore, projectIds.filter((x) => x !== pid), pid, aid)
          const totalRefs = hits.reduce((s, x) => s + x.nodeIds.length, 0)
          if (totalRefs > 0 && cascade === 'cancel') {
            return { ok: false, dependents: { totalRefs, hits }, error: 'asset is referenced by other projects; choose a cascade mode' } as unknown as JsonValue
          }
          const result = await deleteAsset(mst.workspaceRoot, mst.canvasStore, pid, aid, cascade as 'cancel' | 'break-refs' | 'migrate-shared', projectIds, ps.resolveSourcePath(pid))
          return { ok: true, result } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioCopyAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_copy_asset',
      description:
        'Hard-copy an asset (file + index entry) from one project to another. Returns the new ' +
        'asset\'s id in the target project — use that with `media_studio_search_assets` or ' +
        '`canvas_graph_patch` (data.assetRef) to soft-reference it without copying again. ' +
        'Cross-project soft refs are NOT made by this tool; this only duplicates the bytes.',
      parameters: {
        projectId: { type: 'string', description: 'Source project id.', required: true },
        assetId: { type: 'string', description: 'Source asset id.', required: true },
        targetProjectId: { type: 'string', description: 'Destination project id.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; created?: boolean; asset?: { id: string; name: string }; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `copy failed: ${v.error}` }]
          return [{ type: 'text' as const, text: `${v.created ? 'copied' : 'updated'} asset "${v.asset!.name}" → id=${v.asset!.id}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        const target = String(args.targetProjectId ?? '').trim()
        if (!pid || !aid || !target) return { ok: false, error: 'projectId, assetId and targetProjectId are required' }
        try {
          const r = await copyAssetToProject(
            mst.workspaceRoot,
            pid,
            aid,
            target,
            ps.resolveSourcePath(pid),
            ps.resolveSourcePath(target),
          )
          return { ok: true, created: r.created, asset: r.asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Global search tool — wraps runSearch() and optionally drops a soft-reference
// node into the current project's canvas for the top hit.
// ─────────────────────────────────────────────────────────────────────────────

export function registerMediaStudioSearchAssetsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_search_assets',
      description:
        'Cross-project search across every project\'s asset library + finished canvas media nodes ' +
        '(catalog: "library" / "canvas"). Results are grouped into "current" (matches in the active ' +
        'project) and "other" (matches elsewhere). `alreadyRefCount` shows how many soft refs the ' +
        'scope project already holds for each match. When `addSoftRef=true` and exactly one item is ' +
        'supplied via `addAssetKey`, a soft-reference node is appended to the current canvas ' +
        '(`data.assetRef = { projectId, assetId }`) — no file is copied.',
      parameters: {
        q: { type: 'string', description: 'Search query (matches name > tags > prompt; substring, token AND).', required: true },
        scopeProjectId: { type: 'string', description: 'Scope project id (defaults to the active project).' },
        limit: { type: 'number', description: 'Max results per group (1–50, default 20).' },
        addSoftRef: { type: 'boolean', description: 'If true, also add a soft-reference node for the chosen asset.' },
        addAssetKey: { type: 'string', description: 'The exact `key` field from a previous search result (e.g. "library:p-abc:a-xyz"). Required when addSoftRef=true.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; hitCount?: number; addedNodeId?: string; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `search failed: ${v.error}` }]
          const tail = v.addedNodeId ? `; soft-ref node ${v.addedNodeId} added` : ''
          return [{ type: 'text' as const, text: `${v.hitCount} hit(s)${tail}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        await ps.ready()
        const q = String(args.q ?? '')
        const scope = typeof args.scopeProjectId === 'string' && args.scopeProjectId.trim()
          ? args.scopeProjectId.trim()
          : (ps.activeCanvasId() ?? null)
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
        let result
        try {
          result = await runSearch({
            wsRoot: mst.workspaceRoot,
            canvasStore: mst.canvasStore,
            projects: ps.snapshot().projects,
            q,
            scopeProjectId: scope,
            limitPerGroup: limit,
          })
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
        let addedNodeId: string | undefined
        if (args.addSoftRef && typeof args.addAssetKey === 'string' && args.addAssetKey) {
          // Decode "<catalog>:<owner>:<id>" — catalog 'canvas' isn't supported here
          // (canvas-node refs come through canvas_graph_patch + assetRef).
          const m = /^([^:]+):([^:]+):(.+)$/.exec(args.addAssetKey)
          if (!m) return { ok: false, error: `invalid addAssetKey "${args.addAssetKey}"` }
          const [, catalog, ownerId, assetId] = m
          if (catalog !== 'library') return { ok: false, error: 'addSoftRef only supports catalog=library results' }
          try {
            const asset = await resolveAsset(mst.workspaceRoot, ownerId, assetId, ps.resolveSourcePath(ownerId))
            const targetCanvas = scope ?? ps.activeCanvasId() ?? 'main'
            const r = addSoftRefToCanvas(mst.canvasStore, targetCanvas, mst.workspaceRoot, ownerId, asset, ps.resolveSourcePath(ownerId))
            addedNodeId = r.nodeId
          } catch (e) {
            return { ok: false, error: (e as Error).message } as unknown as JsonValue
          }
        }
        return { ok: true, hitCount: result.hitCount, groups: result.groups, addedNodeId } as unknown as JsonValue
      },
    }),
  )
}
