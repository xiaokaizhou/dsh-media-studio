import type { Context } from '@deepseek-ai/cordis'
// Side-effect import — pulls in the `webServer: WebServer` augmentation on
// the cordis Context type so TypeScript knows ctx.webServer exists.
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import type { CanvasStore } from './canvas-store'
import { getMediaStudioHandles, log, type MediaStudioHandles } from './service-state'
import { executeNodeRefresh, migrateInaccessibleResultUrl, postProcessCanvasPatch, backfillVideoPosters } from './tools'

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

function mimeFor(p: string): string {
  return MEDIA_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * Cache-Control for media assets.
 *
 * `immutable` tells the browser HTTP cache the body will never change for
 * this URL, so it must NOT issue conditional revalidation (If-None-Match /
 * If-Modified-Since) within max-age. The filenames we hand out are stable
 * per node (`llm-multimodal-<ts>-<rand>` from the multimodal plugin, or
 * `<assetId>.<ext>` from the asset library) so this assumption holds for
 * the lifetime of the URL.
 *
 * `private` because the body is a user-local file served from
 * 127.0.0.1/<sourcePath>; shared caches must not store it.
 *
 * `max-age=86400` (24h) gives repeat views of the same node a pure cache
 * hit with zero socket traffic — the dominant cost on a canvas with many
 * revisits.
 */
const MEDIA_CACHE_CONTROL = 'private, max-age=86400, immutable'

/**
 * Weak ETag for a media file. Uses inode + mtimeMs + size as the fingerprint;
 * cheap to compute (a single `stat`) and stable across processes. Weak ETag
 * (`W/"..."`) is correct here: the body is byte-identical across same-ETag
 * responses served from different segments of a Range request, which is
 * exactly the case weak ETags are designed for.
 */
function etagFor(target: string, st: import('node:fs').Stats): string {
  const h = createHash('sha1')
  h.update(String(st.ino))
  h.update(':')
  h.update(String(Math.floor(st.mtimeMs)))
  h.update(':')
  h.update(String(st.size))
  return `W/"${h.digest('hex').slice(0, 16)}"`
}

/**
 * Best-effort background faststart for MP4 files whose `moov` box isn't
 * already at the head of the file. Runs at most once per file — after a
 * successful rewrite we drop a `.faststarted` sibling so future requests
 * skip the check entirely.
 *
 * Why we do this in the media proxy (vs. only in video-cover.ts): existing
 * project assets (migrated from /tmp by older code paths, or written before
 * the prepareVideoForCanvas faststart landed) have moov at the tail. Without
 * faststart, browsers must download the whole file before <video> knows
 * its duration — which is the "点击播放需要 10 秒" symptom on legacy clips.
 *
 * Strategy:
 *   1. Probe the first 64 bytes for the `ftyp` box signature (cheap, single
 *      read). Non-mp4 files bail immediately.
 *   2. Probe byte 64 for `moov`. If present, the file is already faststart —
 *      mark it and skip.
 *   3. Otherwise spawn ffmpeg with `-c copy -movflags +faststart` to a sibling
 *      `.faststart.mp4`, then atomic-rename over the original.
 *   4. Drop a `.faststarted` sidecar file (size + mtime fingerprint) so the
 *      next request short-circuits the probe.
 *
 * All work is async, fire-and-forget — the current HTTP response is served
 * from the existing (unfaststarted) bytes so the user sees the same content.
 * The next request after the rewrite completes gets faststart bytes.
 *
 * Failures are logged and never block serving. The user always gets bytes.
 */
async function maybeBackgroundFaststart(target: string): Promise<void> {
  if (!/\.mp4$/i.test(target)) return
  const fsPromises = await import('node:fs/promises')
  const sidecar = `${target}.faststarted`

  // Sidecar fingerprint present → already processed; skip the probe + write.
  let hasSidecar = false
  try { hasSidecar = Boolean(await fsPromises.readFile(sidecar, 'utf8')) } catch { /* no sidecar */ }
  if (hasSidecar) return

  let fd: import('node:fs/promises').FileHandle | null = null
  try {
    fd = await fsPromises.open(target, 'r')
    const headBuf = Buffer.alloc(8)
    await fd.read(headBuf, 0, 8, 0)
    if (headBuf.slice(4, 8).toString('latin1') !== 'ftyp') return
    // ftyp box can be 16-32 bytes; moov, if at the head, follows immediately
    // after the ftyp box. Reading at offset 64 covers the worst-case ftyp
    // size plus any leading padding without spending a second syscall.
    const moovBuf = Buffer.alloc(4)
    await fd.read(moovBuf, 0, 4, 64)
    if (moovBuf.toString('latin1') === 'moov') return
  } catch { return } finally {
    try { await fd?.close() } catch { /* ignore */ }
  }

  // Not faststart — rewrite in the background. Use the same ffmpeg call as
  // video-cover.ts so behaviour stays consistent across the codebase.
  log.info(`[media-studio] media-file: moov-in-tail detected, background-faststarting "${target}"`)
  try {
    const tmp = `${target}.faststart.mp4`
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG_BIN(), ['-y', '-i', target, '-c', 'copy', '-movflags', '+faststart', tmp], {
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      proc.stderr.on('data', (c) => { stderr += c.toString() })
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr.slice(-200)}`)))
      proc.on('error', reject)
    })
    await fsPromises.rename(tmp, target)
    // Drop the sidecar with the post-rewrite fingerprint.
    const fresh = await fsPromises.stat(target)
    await fsPromises.writeFile(sidecar, `${fresh.size}:${Math.floor(fresh.mtimeMs)}\n`)
    log.info(`[media-studio] media-file: faststart complete for "${target}"`)
  } catch (e) {
    try { await fsPromises.unlink(`${target}.faststart.mp4`) } catch { /* ignore */ }
    log.warn(`[media-studio] media-file: background faststart failed for "${target}": ${(e as Error).message}`)
  }
}

/** Resolve ffmpeg binary lazily; mirrors video-cover.ts's FFMPEG() env override. */
function FFMPEG_BIN(): string {
  return process.env.FFMPEG_PATH || 'ffmpeg'
}

/** Stream a local file with basic HTTP Range support (media seeking). */
async function serveMediaFile(target: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let st
  try {
    st = await stat(target)
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"error":"not found"}')
    return
  }
  // Background faststart for legacy mp4s whose moov sits at the tail. Only
  // mp4s are touched; everything else bails immediately inside the helper.
  // Non-blocking — we serve the current bytes and the next request gets the
  // rewritten file.
  void maybeBackgroundFaststart(target)
  const mime = mimeFor(target)
  const total = st.size
  const etag = etagFor(target, st)
  const range = req.headers.range

  // Conditional GET: client already has this version (ETag matched). Return
  // 304 with no body so the browser uses its cache. For Range requests we
  // don't honour If-Range here — Chrome / Safari fall back to a full 200 on
  // miss, which is acceptable because `immutable` already prevents this path
  // from firing inside max-age in the common case.
  if (!range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      'ETag': etag,
      'Cache-Control': MEDIA_CACHE_CONTROL,
      'Accept-Ranges': 'bytes',
    })
    res.end()
    return
  }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : total - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        end = Math.min(end, total - 1)
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': MEDIA_CACHE_CONTROL,
          'ETag': etag,
        })
        createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res)
        return
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': MEDIA_CACHE_CONTROL,
    'ETag': etag,
  })
  createReadStream(target).on('error', () => res.destroy()).pipe(res)
}

/** True when `target` is `root` itself or sits underneath it. Compares
 *  resolved absolute paths with a separator guard so `/a/bc` never counts
 *  as being inside `/a/b`. */
function isUnderRoot(target: string, root: string): boolean {
  const r = resolve(root)
  return target === r || target.startsWith(r + sep)
}

/**
 * Trusted tool-output allow-list: the sibling dsh-llm-multimodal plugin
 * writes produced media to `/tmp/llm-multimodal-<kind>-<timestamp>.<ext>`
 * (kind optional, e.g. `llm-multimodal-1788633784331.png` or
 * `llm-multimodal-tts-1788634334017.mp3`). These are host-tool outputs, not
 * user-supplied paths, so the media proxy serves them even though they sit
 * outside workspaceRoot / mediaRoots. Filenames may carry a numeric
 * timestamp (`llm-multimodal-1788633784331.png`), a kind prefix
 * (`llm-multimodal-tts-1788634334017.mp3`), or a descriptive label chosen
 * by callers / E2E harnesses (`llm-multimodal-i2v-fixed.mp4`). We accept
 * any single-level filename under the fixed prefix and reject path
 * separators, `..` segments, and `/private/tmp` symlink variants.
 */
const LLM_MULTIMODAL_TMP_RE = /^\/tmp\/llm-multimodal-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.\w{2,6}$/

/** Whether `requested` is a trusted dsh-llm-multimodal temp output path. */
export function isLlmMultimodalTmpPath(requested: string): boolean {
  return LLM_MULTIMODAL_TMP_RE.test(requested)
}

/**
 * In-flight dedupe for background /tmp migrations: the same node is often
 * requested repeatedly (multiple media elements, re-mounts), and
 * migrateInaccessibleResultUrl is not idempotent between two concurrent
 * runs (it would copy the file twice and write the index twice). One
 * migration per path at a time is enough.
 */
const tmpMigrateInflight = new Map<string, Promise<void>>()

/**
 * Migrate a rendered multimodal temp output into the ACTIVE project's asset
 * directory in the background. Reuses the same machinery the canvas patch
 * post-process runs, so the URL ends up rewritten to
 * `projects/<id>/assets/<kind>/<file>` — persistent and searchable.
 *
 * Non-fatal: any failure is logged and the served bytes are unaffected.
 */
async function migrateTmpMediaNode(path: string, handles: MediaStudioHandles): Promise<void> {
  const projectId = handles.projectStore?.activeCanvasId?.()
  if (!projectId) return
  const pending = tmpMigrateInflight.get(path)
  if (pending) return pending
  const run = (async (): Promise<void> => {
    const store = handles.canvasStore
    const snap = store.snapshot(projectId)
    const node = snap.graph.nodes.find((n) => {
      const raw = (n.data as Record<string, unknown> | undefined)?.resultUrl
      return typeof raw === 'string' && (raw === path || raw === `file://${path}`)
    })
    if (!node || !['image', 'video', 'music'].includes(node.type)) return
    const meta = handles.projectStore?.snapshot?.()?.projects.find((p) => p.id === projectId)
    await migrateInaccessibleResultUrl(
      projectId,
      handles.workspaceRoot,
      handles.mediaRoots ?? [],
      store,
      node.id,
      node.type,
      meta?.sourcePath,
    )
  })()
  const guarded = run
    .catch((e: unknown) => {
      log.warn(`[media-studio] background /tmp migration failed: ${(e as Error)?.message ?? String(e)}`)
    })
    .finally(() => { tmpMigrateInflight.delete(path) })
  tmpMigrateInflight.set(path, guarded)
  return guarded
}

/**
 * Allow-list check for the media-file proxy.
 *
 * `workspaceRoot` is always allowed; `mediaRoots` adds the directories a host
 * admin opted into (typically the project folder an agent writes generated
 * media to). Everything else is refused — a relative `path` query still
 * resolves against `workspaceRoot`, so `../../../etc/passwd` stays a 403.
 *
 * When `projectRoots` is provided, a `requested` of the form
 * `projects/<id>/<rest>` is rewritten to `<root>/<rest>` (where `<root>` is
 * the project's sourcePath from `projectRoots`). This is how the canvas
 * client can keep using the existing `projects/<id>/assets/<kind>/<file>`
 * URL convention while the bytes themselves live inside the user's project
 * directory instead of the workspace.
 */
export function resolveMediaTarget(
  requested: string,
  workspaceRoot: string,
  mediaRoots: readonly string[] = [],
  projectRoots: Record<string, string> = {},
): { ok: true; target: string } | { ok: false } {
  const wsRoot = resolve(workspaceRoot)
  // Per-project rewrite: projects/<id>/assets/<rest> → <sourcePath>/assets/<rest>
  const projMatch = /^projects\/([^/]+)\/(.+)$/.exec(requested)
  if (projMatch) {
    const [, projId, rest] = projMatch
    const sourcePath = projectRoots[projId]
    if (sourcePath) {
      const target = resolve(sourcePath, rest)
      if (isUnderRoot(target, sourcePath)) return { ok: true, target }
      return { ok: false }
    }
  }
  const target = resolve(wsRoot, requested)
  const roots = [wsRoot, ...mediaRoots.filter((r) => typeof r === 'string' && r.trim() !== '')]
  return roots.some((r) => isUnderRoot(target, r)) ? { ok: true, target } : { ok: false }
}

/**
 * Register canvas-related HTTP routes under `ctx.webServer`. Pattern:
 * `ctx.webServer.register({ kind, path, handler })`. The harness's webServer
 * service also exposes a static-serve path; we own the canvas API surface.
 *
 * After the multimodal refactor this routes module exposes ONLY canvas +
 * media-proxy routes. The `/api/media-studio/models` and
 * `/api/media-studio/providers` endpoints are gone: the dsh-llm-multimodal
 * plugin owns the LLM-facing UI; media-studio is a pure canvas plugin.
 *
 * SSE wire shape (per canvas):
 *   data: {"type":"canvas-patch","canvasId":"...","version":42,"graph":{...},"patch":[...]}\n\n
 *   data: {"type":"heartbeat"}\n\n   (every 15s; SSE intermediaries drop idle conns)
 *
 * The SSE handler is the source of truth for the canvas tab — the agent's
 * `canvas_graph_patch` tool persists + bumps `version`, then we push the
 * updated graph to every connected tab.
 */
export function registerCanvasRoutes(ctx: Context): () => void {
  const wserver = ctx.webServer

  const store = getMediaStudioHandles().canvasStore
  const sseClients = getMediaStudioHandles().sseClients

  // Unified SSE endpoint — a single EventSource carries both canvas patches
  // and project-registry events. Before this, the client opened TWO long-lived
  // connections (/canvas/sse + /projects/sse); together with DSH core's own
  // 3-4 SSE streams that hit the HTTP/1.1 six-connection-per-host limit,
  // every short request (rename, delete, status polling) was queued behind
  // the SSE sockets and never got a connection — which made dialog buttons
  // stick in "处理中…" and left the modal backdrop up forever. One socket
  // here frees a connection for short-lived REST calls.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/sse',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const canvasId = url.searchParams.get('canvasId') || 'main'
      const handles = getMediaStudioHandles()

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`: connected to unified stream (canvas="${canvasId}")\n\n`)

      // Initial canvas snapshot.
      const snap = store.snapshot(canvasId)
      res.write(`event: canvas-patch\ndata: ${JSON.stringify({
        type: 'canvas-patch', canvasId, version: snap.version, graph: snap.graph, patch: [],
      })}\n\n`)

      // Initial registry snapshot. Send immediately if the store exists
      // (even if still booting — snapshot() returns the current state);
      // the next broadcast will deliver the fully-loaded registry.
      const ps = handles.projectStore
      if (ps) {
        try {
          res.write(`event: registry-changed\ndata: ${JSON.stringify({ registry: ps.snapshot(), recentLimit: ps.getRecentLimit() })}\n\n`)
        } catch { /* store not ready — next broadcast catches it */ }
      }

      // Register with BOTH broadcast sets so canvas patches and project
      // events flow down the same socket.
      sseClients.add(res)
      handles.projectSseClients?.add(res)

      const ping = setInterval(() => {
        try { res.write(`data: {"type":"heartbeat"}\n\n`) } catch { /* client gone */ }
      }, 15_000)

      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
        handles.projectSseClients?.delete(res)
      })
    },
  })

  // Snapshot endpoint — the canvas tab falls back to a plain fetch if SSE
  // is blocked by an intermediate proxy.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/state',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const canvasId = url.searchParams.get('canvasId') || 'main'
      const snap = store.snapshot(canvasId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(snap))
    },
  })

  // Patch endpoint — the client (and any external automation) can POST
  // a batch of ops. The host's store.apply() runs the same lint / atomicity
  // guard the agent's `canvas_graph_patch` tool uses; on success the SSE
  // broadcast fires so every connected tab updates.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/patch',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string; ops?: unknown[] }
            // Support canvasId in both body and query param for API consistency
            const reqUrl = new URL(req.url || '/', 'http://localhost')
            const canvasId = body.canvasId || reqUrl.searchParams.get('canvasId') || 'main'
            const ops = Array.isArray(body.ops) ? body.ops : []
            const result = store.apply(canvasId, ops as never)
            // Shared post-processing (pin remote URLs → migrate inaccessible →
            // auto-register assets). Same code path as the agent tool so REST
            // patches don't leave provider URLs to expire into broken cards.
            const issues = await postProcessCanvasPatch(store, canvasId, ops as never, result.issues)
            // `store.apply` already broadcasts the new graph to every SSE
            // client (the canvas tab) — no second push here.
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({
              ok: true,
              applied: result.patch.length,
              version: result.version,
              lintOk: result.lintOk,
              issues,
            }))
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
          }
        })()
      })
    },
  })

  // Auto-arrange — re-layout all nodes by topological flow depth. Same
  // algorithm as the client's bottom-right wand button and the agent tool
  // `canvas_auto_arrange`. Exposed as REST so the frontend can call it
  // without going through the agent tool runtime.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/auto-arrange',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string }
          const reqUrl = new URL(req.url || '/', 'http://localhost')
          const canvasId = body.canvasId || reqUrl.searchParams.get('canvasId') || 'main'
          const result = store.autoArrange(canvasId)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            applied: result.patch.length,
            version: result.version,
            lintOk: result.lintOk,
            issues: result.issues,
            persistError: result.persistError,
          }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
        }
      })
    },
  })

  // Media file proxy — host tools store generated media as local filesystem
  // paths (…/web-jobs/x.png); the browser can't load those directly, so the
  // client maps stored resultUrls onto this route (see canvas-api mediaSrc).
  // Scope-locked to the plugin workspace root; Range-enabled so <video>
  // seeking works.
  //
  // Trusted dsh-llm-multimodal temp outputs (/tmp/llm-multimodal-*) are
  // served as a RENDER fallback only — resolveMediaTarget deliberately does
  // NOT include them, because the canvas patch post-process reuses that
  // function as its migration probe and must keep /tmp "inaccessible" so
  // produced media gets copied into the project's asset directory
  // (persistent + searchable) instead of lingering in a temp dir.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/media-file',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const requested = url.searchParams.get('path') ?? ''
      if (!requested) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"missing path"}')
        return
      }
      const handles = getMediaStudioHandles()
      const projectRoots = handles.projectStore?.allSourcePaths?.() ?? {}
      const resolved = resolveMediaTarget(requested, handles.workspaceRoot, handles.mediaRoots ?? [], projectRoots)
      if (!resolved.ok) {
        if (!isLlmMultimodalTmpPath(requested)) {
          res.writeHead(403, { 'Content-Type': 'application/json' })
          res.end('{"ok":false,"error":"forbidden: path is outside workspaceRoot and every configured mediaRoots entry"}')
          return
        }
        // Render fallback for a multimodal temp output. Serve the bytes
        // immediately, then migrate the node into the project assets in the
        // background (idempotent, deduped, non-fatal) so the canvas stops
        // depending on /tmp as soon as the node is rendered.
        void migrateTmpMediaNode(requested, handles)
      }
      void serveMediaFile(resolved.ok ? resolved.target : resolve(requested), req, res)
    },
  })

  // Refresh endpoint — client calls this when a user clicks the refresh button
  // on a node with upstream connections. Delegates to the same logic as the
  // agent tool (executeNodeRefresh) so both paths share one implementation.
  // executeNodeRefresh now reaches the dsh-llm-multimodal plugin's
  // generate_image / generate_video / generate_tts / generate_music tools
  // via ctx.tools.execute().
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/refresh',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string; nodeId?: string }
          const reqUrl = new URL(req.url || '/', 'http://localhost')
          const canvasId = body.canvasId || reqUrl.searchParams.get('canvasId') || 'main'
          const nodeId = String(body.nodeId ?? reqUrl.searchParams.get('nodeId') ?? '').trim()
          getMediaStudioHandles().logger?.debug?.(`[media-studio] refresh: canvasId=${canvasId} nodeId=${nodeId}`)
          if (!nodeId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'nodeId is required' }))
            return
          }
          const store = getMediaStudioHandles().canvasStore
          // Use a generous timeout (5 min) instead of req.on('close') — the
          // latter fires after the response is sent, which would abort a
          // generation that already completed. The timeout guards against
          // truly stuck generations (provider API hang).
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
          try {
            const result = await executeNodeRefresh(store, canvasId, nodeId, controller.signal, ctx)
            getMediaStudioHandles().logger?.debug?.(`[media-studio] refresh: done, ok=${result.ok} kind=${result.kind}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } finally {
            clearTimeout(timeout)
          }
        } catch (e) {
          getMediaStudioHandles().logger?.error?.(`[media-studio] refresh: error ${(e as Error).message}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
          }
        }
      })
    },
  })

  // Backfill missing video posters. Iterates every video node in the canvas
  // and, for any node whose data.poster is empty, runs prepareVideoForCanvas
  // to attach (or extract) a cover image and patch the node's data. The
  // intended caller is either the agent (after discovering a session of
  // legacy video nodes with no cover) or the GUI (a one-click "修复视频封面"
  // action when a scan finds blank video cards).
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/backfill-video-posters',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        void (async () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string }
            const reqUrl = new URL(req.url || '/', 'http://localhost')
            const canvasId = body.canvasId || reqUrl.searchParams.get('canvasId') || 'main'
            const handles = getMediaStudioHandles()
            const projectStore = handles.projectStore
            const projectId = (() => {
              if (!projectStore) return canvasId
              const snap = projectStore.snapshot?.()
              if (snap && snap.projects.some((p) => p.id === canvasId)) return canvasId
              return projectStore.activeCanvasId?.() ?? canvasId
            })()
            const sourcePath = projectStore?.resolveSourcePath?.(projectId)
            const result = await backfillVideoPosters(
              projectId,
              handles.workspaceRoot,
              sourcePath,
              handles.canvasStore,
            )
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, ...result }))
          } catch (e) {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
            }
          }
        })()
      })
    },
  })

  // ── Service Worker: /api/media-studio/service-worker.js ──────────────────
  // Serves the preheat SW so the browser can register it with
  // `navigator.serviceWorker.register('/api/media-studio/service-worker.js')`.
  // The SW intercepts media-file requests and serves cached headers on range
  // hits, turning "click → stream" into "click → instant playback".
  //
  // Path resolution: after tsdown bundles everything into a single CJS
  // `lib/index.js`, `import.meta.url` still resolves to that bundle file —
  // so computing `../lib/service-worker.js` from it points at a non-existent
  // `lib/lib/service-worker.js` and the route silently fails to register (the
  // catch below swallows it). The SW lives in the SAME directory as the
  // bundle (`lib/service-worker.js`, an independent ES-module output from
  // tsdown's second entry), so we resolve against `__dirname` (CJS) with an
  // import.meta.dirname fallback for future ESM targets.
  try {
    const here = typeof __dirname !== 'undefined'
      ? __dirname
      : dirname(fileURLToPath(import.meta.url))
    const swPath = resolve(here, 'service-worker.js')
    const swBody = readFileSync(swPath, 'utf8')
    if (swBody) {
      wserver.register({
        kind: 'exact',
        path: '/api/media-studio/service-worker.js',
        handler: (_req, res) => {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Service-Worker-Allowed': '/',
            'Cache-Control': 'public, max-age=86400',
          })
          res.end(swBody)
        },
      })
    } else {
      log.warn('[media-studio] service-worker.js is empty — SW preheat disabled')
    }
  } catch (e) {
    log.warn('[media-studio] sw route setup failed: ' + (e as Error).message)
  }

  // Return a noop disposer — the webServer.unregister handles cleanup
  // when the plugin fiber is disposed; we don't need custom teardown.
  return () => {}
}
