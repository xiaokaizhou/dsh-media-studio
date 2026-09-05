/**
 * Asset library — metadata + categorized files for every project.
 *
 * Layout per project (and for the shared library):
 *
 *   <ws>/projects/<projectId>/assets/
 *     characters/  <assetId>.<ext>     # 人物资产
 *     scenes/      <assetId>.<ext>     # 场景资产
 *     audio/       <assetId>.<ext>     # 音频资产
 *     clips/       <assetId>.<ext>     # 视频片段
 *     index.json                       # asset metadata (never binary)
 *
 * File names are `<assetId>.<ext>` — decoupled from the display `name`, so
 * renaming an asset never breaks the file or any reference to it.
 *
 * M0 shipped the read/write surface + category mapping used by the project
 * store (templates, deletion cascades). M2 adds registration (canvas node →
 * library hard copy), metadata updates, hard-copy-across-projects, deletion
 * with dependency preflights, and the shared-library migration helper.
 *
 * This module deliberately does NOT import project-store (keeps the module
 * graph acyclic); callers supply wsRoot/mediaRoots/canvasStore/registry ids.
 */

import { readFile, writeFile, mkdir, copyFile, rm, stat } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CanvasStore, CanvasOp } from './canvas-store'
import { resolveMediaTarget } from './routes'
import { getMediaStudioHandles } from './service-state'

export const ASSET_KINDS = ['character', 'scene', 'audio', 'clip'] as const
export type AssetKind = (typeof ASSET_KINDS)[number]

/** Folder name per asset kind inside an assets root. */
export const ASSET_CATEGORY_DIR: Record<AssetKind, string> = {
  character: 'characters',
  scene: 'scenes',
  audio: 'audio',
  clip: 'clips',
}

export type AssetOrigin =
  | { type: 'generated'; model?: string; prompt?: string }
  | { type: 'canvas'; canvasNodeId?: string }
  | { type: 'imported'; sourcePath?: string }
  | { type: 'pasted' }
  /** Asset relocated into the shared library when its owner project was
   *  deleted but other projects still referenced it. */
  | { type: 'migrated'; fromProject: string }
  /** Asset pulled from a remote URL during a canvas patch (provider URLs
   *  expire; we copy the bytes so the canvas never breaks later). */
  | { type: 'pinned'; sourceUrl: string }

/** SharedAssetOrigin — legacy alias for origin.type === 'migrated'. */
export type SharedAssetOrigin = { fromProject: string }

export interface AssetMeta {
  width?: number
  height?: number
  durationS?: number
}

export interface Asset {
  /** Stable asset id. Also the file base name: <id>.<ext>. */
  id: string
  kind: AssetKind
  /** Display name (searchable, editable). */
  name: string
  /** File name inside the kind folder (id.<ext>). */
  file: string
  tags?: string[]
  bytes?: number
  meta?: AssetMeta
  origin?: AssetOrigin
  /** Provenance when this asset is a hard copy of another project's asset. */
  copyOf?: { projectId: string; assetId: string }
  createdAt: string
  updatedAt: string
}

export interface AssetIndexFile {
  version: number
  assets: Asset[]
}

const INDEX_VERSION = 1

// ── path helpers / ids ─────────────────────────────────────────────────────

export function projectAssetRoot(wsRoot: string, projectId: string): string {
  return join(wsRoot, 'projects', projectId, 'assets')
}

/**
 * Like `projectAssetRoot` but honors a project-supplied source path so assets
 * live in the user-owned project directory rather than the media-studio
 * workspace. Pass `undefined` to fall back to the legacy wsRoot layout
 * (used by projects that pre-date the sourcePath migration).
 */
export function projectAssetRootAt(sourcePath: string | undefined, wsRoot: string, projectId: string): string {
  return sourcePath ? join(sourcePath, 'assets') : projectAssetRoot(wsRoot, projectId)
}
export function sharedAssetRoot(wsRoot: string): string {
  return join(wsRoot, 'shared-assets')
}
export function newAssetId(): string {
  return `a-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}
export function newAssetFileName(assetId: string, ext: string): string {
  return `${assetId}.${ext}`
}

/** Read <root>/<indexFile>; never throws — absent/corrupt returns empty.
 *  Default index file name is `index.json`; the source-path variant uses
 *  `.index.json` (hidden) so user-visible asset dirs stay clean. */
export async function loadAssetIndex(root: string, indexFile: string = 'index.json'): Promise<AssetIndexFile> {
  try {
    const raw = await readFile(join(root, indexFile), 'utf8')
    const parsed = JSON.parse(raw) as AssetIndexFile
    if (parsed && Array.isArray(parsed.assets)) return { version: INDEX_VERSION, assets: parsed.assets }
  } catch { /* absent/corrupt — empty below */ }
  return { version: INDEX_VERSION, assets: [] }
}

/** Write <root>/<indexFile> (creates root). Never rejects — logs only. */
export async function writeAssetIndex(root: string, index: AssetIndexFile, indexFile: string = 'index.json'): Promise<void> {
  try {
    await mkdir(root, { recursive: true })
    await writeFile(join(root, indexFile), JSON.stringify(index, null, 2), 'utf8')
  } catch (e) {
    getMediaStudioHandles().logger?.warn?.(`[media-studio] writeAssetIndex(${root}) failed: ${(e as Error).message}`)
  }
}

export function validateAssetName(name: string): string | null {
  const n = name.trim()
  if (!n) return 'asset name is required'
  if (n.length > 64) return 'asset name must be at most 64 characters'
  return null
}

/** List assets of a project (or of the shared root with id "__shared").
 *  Honors `sourcePath` for per-project lookup; the shared root stays
 *  inside the workspace regardless of sourcePath. */
export async function listAssets(wsRoot: string, projectId: string, sourcePath?: string): Promise<Asset[]> {
  const root = projectId === '__shared'
    ? sharedAssetRoot(wsRoot)
    : projectAssetRootAt(sourcePath, wsRoot, projectId)
  const indexFile = projectId === '__shared' ? 'index.json' : (sourcePath ? '.index.json' : 'index.json')
  const index = await loadAssetIndex(root, indexFile)
  return index.assets
}

// ── source media → local bytes ─────────────────────────────────────────────

/** Guess a file extension from a raw media source (path / mime / kind). */
export function assetExtFor(raw: string | undefined, kind: AssetKind): string {
  if (typeof raw === 'string' && raw) {
    const noQuery = raw.split(/[?#]/, 1)[0]
    const m = /\.([a-z0-9]{2,5})$/i.exec(noQuery ?? '')
    if (m && /^(png|jpe?g|webp|gif|avif|bmp|svg|mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(m[1])) {
      return m[1].toLowerCase()
    }
    const mime = /^data:([^;,]+)/i.exec(raw)
    if (mime) {
      const t = mime[1].toLowerCase()
      if (t === 'image/jpeg') return 'jpg'
      if (t.startsWith('image/')) return t.slice('image/'.length) || 'png'
      if (t === 'video/quicktime') return 'mov'
      if (t.startsWith('video/')) return t.slice('video/'.length) || 'mp4'
      if (t === 'audio/mpeg') return 'mp3'
      if (t.startsWith('audio/')) return t.slice('audio/'.length) || 'mp3'
    }
  }
  if (kind === 'scene' || kind === 'character') return 'png'
  if (kind === 'clip') return 'mp4'
  return 'mp3'
}

/** Decode a media source to bytes. Returns null when unresolvable / out of
 *  the allow-list (`roots` = workspaceRoot + mediaRoots). */
export async function readSourceBytes(
  wsRoot: string,
  roots: string[],
  raw: string,
): Promise<{ bytes: Buffer; ext: string } | null> {
  const src = raw.trim()
  if (!src) return null
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',')
    const meta = comma >= 0 ? src.slice(5, comma) : ''
    const payload = comma >= 0 ? src.slice(comma + 1) : src
    try {
      const bytes = meta.includes(';base64')
        ? Buffer.from(payload, 'base64')
        : Buffer.from(decodeURIComponent(payload), 'utf8')
      if (bytes.length === 0) return null
      return { bytes, ext: '' }
    } catch {
      return null
    }
  }
  if (/^https?:\/\//i.test(src)) {
    try {
      const res = await fetch(src, { signal: AbortSignal.timeout(20_000) })
      if (!res.ok) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length === 0) return null
      return { bytes, ext: '' }
    } catch {
      return null
    }
  }
  // Local file. Strip file:// and map media-file proxy forms to a path.
  let target = src
  if (target.startsWith('file://')) target = target.slice('file://'.length)
  const proxy = /^\/api\/media-studio\/media-file\?path=([^&]+)/i.exec(target)
  if (proxy) target = decodeURIComponent(proxy[1])
  const resolved = resolveMediaTarget(target, wsRoot, roots)
  if (!resolved.ok) return null
  try {
    const st = await stat(resolved.target)
    if (!st.isFile()) return null
    const bytes = await readFile(resolved.target)
    if (bytes.length === 0) return null
    return { bytes, ext: extname(resolved.target).replace(/^\./, '').toLowerCase() }
  } catch {
    return null
  }
}

// ── registration ───────────────────────────────────────────────────────────

export interface RegisterInput {
  wsRoot: string
  roots: string[]
  canvasStore: CanvasStore
  /** Owning project (its canvas must hold `canvasNodeId`). */
  projectId: string
  /** Project sourcePath; when set, assets land under `<sourcePath>/assets/`
   *  with a hidden `.index.json` instead of the legacy wsRoot layout. */
  sourcePath?: string
  canvasNodeId: string
  kind: AssetKind
  name?: string
}

/** Register a canvas media node into its project's library (hard copy of the
 *  file). Idempotent: re-registering the same node returns the existing asset
 *  (created:false). */
export async function registerCanvasAsset(input: RegisterInput): Promise<{ asset: Asset; created: boolean }> {
  const snap = input.canvasStore.peek(input.projectId)
  const node = snap?.graph.nodes.find((n) => n.id === input.canvasNodeId)
  if (!node) throw new Error(`register: canvas node "${input.canvasNodeId}" not found in project "${input.projectId}"`)
  const raw = (node.data as { resultUrl?: unknown }).resultUrl
  if (typeof raw !== 'string' || !raw) throw new Error('register: node has no resultUrl (nothing to save)')

  const root = projectAssetRootAt(input.sourcePath, input.wsRoot, input.projectId)
  const indexFile = input.sourcePath ? '.index.json' : 'index.json'
  const index = await loadAssetIndex(root, indexFile)
  const existing = index.assets.find(
    (a) => a.origin?.type === 'canvas' && (a.origin as { canvasNodeId?: string }).canvasNodeId === input.canvasNodeId,
  )
  if (existing) return { asset: existing, created: false }

  const read = await readSourceBytes(input.wsRoot, input.roots, raw)
  if (!read) throw new Error('register: source media could not be read (unresolvable path/URL or out of workspace scope)')
  const ext = read.ext || assetExtFor(raw, input.kind)
  const id = newAssetId()
  const file = newAssetFileName(id, ext)
  const catDir = join(root, ASSET_CATEGORY_DIR[input.kind])
  await mkdir(catDir, { recursive: true })
  await writeFile(join(catDir, file), read.bytes)

  const now = new Date().toISOString()
  const label = (input.name?.trim() || node.label || '').trim().slice(0, 64) || `${input.kind}-${id.slice(2, 6)}`
  const asset: Asset = {
    id,
    kind: input.kind,
    name: label,
    file,
    bytes: read.bytes.length,
    origin: { type: 'canvas', canvasNodeId: input.canvasNodeId },
    createdAt: now,
    updatedAt: now,
  }
  index.assets.push(asset)
  await writeAssetIndex(root, index, indexFile)
  return { asset, created: true }
}

/** Update name/tags of an asset entry (file never touched). */
export async function updateAssetMeta(
  wsRoot: string,
  projectId: string,
  assetId: string,
  patch: { name?: string; tags?: string[] },
  sourcePath?: string,
): Promise<Asset> {
  const root = projectAssetRootAt(sourcePath, wsRoot, projectId)
  const indexFile = sourcePath ? '.index.json' : 'index.json'
  const index = await loadAssetIndex(root, indexFile)
  const a = index.assets.find((x) => x.id === assetId)
  if (!a) throw new Error(`asset "${assetId}" not found in project "${projectId}"`)
  if (patch.name !== undefined) {
    const err = validateAssetName(patch.name)
    if (err) throw new Error(err)
    a.name = patch.name.trim()
  }
  if (patch.tags !== undefined) a.tags = patch.tags
  a.updatedAt = new Date().toISOString()
  await writeAssetIndex(root, index)
  return { ...a }
}

// ── soft-reference scanning (used by deletion preflights) ──────────────────

export interface AssetHit {
  refProjectId: string
  refProjectName?: string
  assetId: string
  nodeIds: string[]
}

/** Scan canvases for soft references to assets owned by `ownerProjectId`.
 *  `assetIdFilter` narrows to one asset (asset-level deletion). */
export function scanCanvasRefs(
  canvasStore: CanvasStore,
  projectIds: string[],
  ownerProjectId: string,
  assetIdFilter?: string,
): AssetHit[] {
  const hits: AssetHit[] = []
  for (const pid of projectIds) {
    if (pid === ownerProjectId) continue
    const snap = canvasStore.peek(pid)
    if (!snap) continue
    const perAsset = new Map<string, string[]>()
    for (const n of snap.graph.nodes) {
      const ref = (n.data as { assetRef?: { projectId?: string; assetId?: string } }).assetRef
      if (!ref || ref.projectId !== ownerProjectId || typeof ref.assetId !== 'string' || !ref.assetId) continue
      if (assetIdFilter && ref.assetId !== assetIdFilter) continue
      const list = perAsset.get(ref.assetId) ?? []
      list.push(n.id)
      perAsset.set(ref.assetId, list)
    }
    for (const [assetId, nodeIds] of perAsset) hits.push({ refProjectId: pid, assetId, nodeIds })
  }
  return hits
}

export class AssetDeleteBlockedError extends Error {
  constructor(public readonly hits: AssetHit[]) {
    super(`asset is soft-referenced by other projects (${hits.reduce((s, h) => s + h.nodeIds.length, 0)} reference(s))`)
    this.name = 'AssetDeleteBlockedError'
  }
}

function applyRefUpdates(canvasStore: CanvasStore, hits: AssetHit[], patch: { brokenAsset?: boolean; status?: string; errorMsg?: string; assetRef?: { projectId: string; assetId: string } }): number {
  const byCanvas = new Map<string, CanvasOp[]>()
  let total = 0
  for (const h of hits) {
    for (const nodeId of h.nodeIds) {
      const ops = byCanvas.get(h.refProjectId) ?? []
      ops.push({ op: 'updateNode', id: nodeId, data: patch })
      byCanvas.set(h.refProjectId, ops)
    }
  }
  for (const [pid, ops] of byCanvas) {
    try {
      canvasStore.apply(pid, ops)
      total += ops.length
    } catch (e) {
      getMediaStudioHandles().logger?.warn?.(`[media-studio] asset ref update on "${pid}" failed: ${(e as Error).message}`)
    }
  }
  return total
}

/**
 * Delete one asset.
 *
 * cascade: 'cancel' (default, throws when referenced) | 'break-refs' (mark
 * referencing nodes broken) | 'migrate-shared' (move file into the shared
 * library + rewrite refs to __shared, then remove the local copy).
 */
export async function deleteAsset(
  wsRoot: string,
  canvasStore: CanvasStore,
  ownerProjectId: string,
  assetId: string,
  cascade: 'cancel' | 'break-refs' | 'migrate-shared',
  projectIds: string[],
  sourcePath?: string,
): Promise<{ deleted: boolean; brokenNodes: number; migrated: boolean }> {
  const root = projectAssetRootAt(sourcePath, wsRoot, ownerProjectId)
  const indexFile = sourcePath ? '.index.json' : 'index.json'
  const index = await loadAssetIndex(root, indexFile)
  const a = index.assets.find((x) => x.id === assetId)
  if (!a) throw new Error(`asset "${assetId}" not found in project "${ownerProjectId}"`)

  const hits = scanCanvasRefs(canvasStore, projectIds, ownerProjectId, assetId)
  let brokenNodes = 0
  let migrated = false
  if (hits.length > 0) {
    if (cascade === 'cancel') throw new AssetDeleteBlockedError(hits)
    if (cascade === 'break-refs') {
      brokenNodes = applyRefUpdates(canvasStore, hits, { brokenAsset: true, status: 'error', errorMsg: '素材已从源项目删除' })
    } else if (cascade === 'migrate-shared') {
      // 1. ensure the file lives in the shared root
      const sharedRoot = sharedAssetRoot(wsRoot)
      const destDir = join(sharedRoot, ASSET_CATEGORY_DIR[a.kind])
      await mkdir(destDir, { recursive: true })
      const dest = join(destDir, a.file)
      try {
        await copyFile(join(root, ASSET_CATEGORY_DIR[a.kind], a.file), dest)
      } catch { /* source already gone — rewrite refs only */ }
      const sharedIndex = await loadAssetIndex(sharedRoot)
      if (!sharedIndex.assets.some((x) => x.id === a.id)) {
        sharedIndex.assets.push({ ...a, origin: { type: 'migrated', fromProject: ownerProjectId }, updatedAt: new Date().toISOString() })
        await writeAssetIndex(sharedRoot, sharedIndex)
      }
      // 2. rewrite referencing nodes to the shared library
      brokenNodes = applyRefUpdates(canvasStore, hits, { assetRef: { projectId: '__shared', assetId: a.id } })
      migrated = true
    } else {
      throw new Error(`deleteAsset: unknown cascade "${cascade}"`)
    }
  }

  if (!migrated) {
    await rm(join(root, ASSET_CATEGORY_DIR[a.kind], a.file), { force: true })
  }
  index.assets = index.assets.filter((x) => x.id !== assetId)
  await writeAssetIndex(root, index, indexFile)
  return { deleted: true, brokenNodes, migrated }
}

/** Hard-copy an asset into another project's library. Idempotent per
 *  (target project, source asset) pair — returns the existing copy. */
export async function copyAssetToProject(
  wsRoot: string,
  sourceProjectId: string,
  assetId: string,
  targetProjectId: string,
  sourcePath?: string,
  targetSourcePath?: string,
): Promise<{ asset: Asset; created: boolean }> {
  if (sourceProjectId === targetProjectId) throw new Error('copyAsset: source and target project are the same')
  const srcRoot = projectAssetRootAt(sourcePath, wsRoot, sourceProjectId)
  const srcIndexFile = sourcePath ? '.index.json' : 'index.json'
  const srcIndex = await loadAssetIndex(srcRoot, srcIndexFile)
  const src = srcIndex.assets.find((x) => x.id === assetId)
  if (!src) throw new Error(`asset "${assetId}" not found in project "${sourceProjectId}"`)

  const dstRoot = projectAssetRootAt(targetSourcePath, wsRoot, targetProjectId)
  const dstIndexFile = targetSourcePath ? '.index.json' : 'index.json'
  const dstIndex = await loadAssetIndex(dstRoot, dstIndexFile)
  const existing = dstIndex.assets.find(
    (x) => x.copyOf?.projectId === sourceProjectId && x.copyOf?.assetId === assetId,
  )
  if (existing) return { asset: existing, created: false }

  const id = newAssetId()
  const ext = extname(src.file).replace(/^\./, '') || assetExtFor('', src.kind)
  const file = newAssetFileName(id, ext)
  const catDir = join(dstRoot, ASSET_CATEGORY_DIR[src.kind])
  await mkdir(catDir, { recursive: true })
  await copyFile(join(srcRoot, ASSET_CATEGORY_DIR[src.kind], src.file), join(catDir, file))

  const now = new Date().toISOString()
  const asset: Asset = {
    id,
    kind: src.kind,
    name: src.name,
    file,
    tags: src.tags ? [...src.tags] : undefined,
    bytes: src.bytes,
    copyOf: { projectId: sourceProjectId, assetId },
    createdAt: now,
    updatedAt: now,
  }
  dstIndex.assets.push(asset)
  await writeAssetIndex(dstRoot, dstIndex, dstIndexFile)
  return { asset, created: true }
}

/**
 * Refresh a registered asset from its source canvas node ("库文件同步"):
 * when the node was regenerated and now points at a newer file, copy the new
 * bytes over the asset file in place (same id/file name, updatedAt bumped).
 */
export async function syncAssetFromCanvas(
  wsRoot: string,
  roots: string[],
  canvasStore: CanvasStore,
  projectId: string,
  assetId: string,
  sourcePath?: string,
): Promise<{ asset: Asset; changed: boolean }> {
  const root = projectAssetRootAt(sourcePath, wsRoot, projectId)
  const indexFile = sourcePath ? '.index.json' : 'index.json'
  const index = await loadAssetIndex(root, indexFile)
  const a = index.assets.find((x) => x.id === assetId)
  if (!a || a.origin?.type !== 'canvas' || !a.origin.canvasNodeId) {
    throw new Error('syncAsset: asset was not registered from a canvas node')
  }
  const nodeId = a.origin.canvasNodeId
  const snap = canvasStore.peek(projectId)
  const node = snap?.graph.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error('syncAsset: source canvas node no longer exists')
  const raw = (node.data as { resultUrl?: unknown }).resultUrl
  if (typeof raw !== 'string' || !raw) throw new Error('syncAsset: source node has no resultUrl')
  const read = await readSourceBytes(wsRoot, roots, raw)
  if (!read) throw new Error('syncAsset: source media could not be read')

  const existingFile = join(root, ASSET_CATEGORY_DIR[a.kind], a.file)
  try {
    const st = await stat(existingFile)
    if (st.size === read.bytes.length) {
      // Same size — treat as unchanged (cheap guard; hash compare overkill).
      return { asset: { ...a }, changed: false }
    }
  } catch { /* missing file — write fresh */ }
  const ext = read.ext || assetExtFor(raw, a.kind)
  const file = newAssetFileName(a.id, ext)
  await mkdir(join(root, ASSET_CATEGORY_DIR[a.kind]), { recursive: true })
  await writeFile(join(root, ASSET_CATEGORY_DIR[a.kind], file), read.bytes)
  if (file !== a.file) {
    await rm(existingFile, { force: true }).catch(() => undefined)
    a.file = file
  }
  a.bytes = read.bytes.length
  a.updatedAt = new Date().toISOString()
  await writeAssetIndex(root, index)
  return { asset: { ...a }, changed: true }
}

// ── batch migration of broken resultUrl nodes ──────────────────────────────

export interface MigrateResult {
  migrated: number
  skipped: number
  errors: string[]
}

/**
 * Scan every registered project's canvas and rewrite any node whose
 * `resultUrl` is a `file://` URL pointing outside the media-file proxy's
 * allow-list. Files are copied into the project's asset directory and the
 * node's resultUrl is updated to the project-relative path.
 *
 * Returns a summary; never throws — individual failures are collected in
 * `errors` and the caller decides whether to retry.
 */
export async function migrateBrokenCanvasUrls(
  wsRoot: string,
  roots: string[],
  projectIds: string[],
  sourcePaths: Record<string, string | undefined>,
): Promise<MigrateResult> {
  const { readFile, mkdir, writeFile, stat } = await import('node:fs/promises')
  const { resolve, extname, join, dirname } = await import('node:path')
  const { resolveMediaTarget } = await import('./routes')
  const { CanvasStore } = await import('./canvas-store')
  const tmpStore = new CanvasStore(wsRoot)

  let migrated = 0
  let skipped = 0
  const errors: string[] = []

  for (const pid of projectIds) {
    const srcPath = sourcePaths[pid]
    const canvasPath = srcPath ? join(srcPath, '.canvas.json') : join(wsRoot, 'canvases', `${pid}.json`)
    let raw: string
    try {
      raw = await readFile(canvasPath, 'utf8')
    } catch {
      continue // canvas not found — skip
    }
    let doc: { nodes?: Array<{ id: string; type: string; data?: Record<string, unknown> }>; edges?: unknown[]; version?: number }
    try {
      doc = JSON.parse(raw) as typeof doc
    } catch {
      errors.push(`${pid}: corrupt canvas JSON`)
      continue
    }
    if (!Array.isArray(doc.nodes)) continue

    let changed = false
    for (const n of doc.nodes) {
      const url = (n.data as { resultUrl?: unknown })?.resultUrl
      if (typeof url !== 'string' || !url.startsWith('file://')) {
        skipped += 1
        continue
      }
      const localPath = url.slice('file://'.length)
      const resolved = resolveMediaTarget(localPath, wsRoot, roots)
      if (resolved.ok) {
        skipped += 1
        continue
      }
      // Migrate: read source, copy to project assets, rewrite URL.
      let bytes: Buffer
      try {
        bytes = await readFile(localPath)
      } catch (e) {
        errors.push(`${pid}/${n.id}: cannot read ${localPath}: ${(e as Error).message}`)
        continue
      }
      if (!bytes || bytes.length === 0) {
        errors.push(`${pid}/${n.id}: empty source file`)
        continue
      }
      // Determine kind from node type.
      const typeMap: Record<string, 'character' | 'clip' | 'audio'> = {
        image: 'character',
        video: 'clip',
        music: 'audio',
      }
      const kind = typeMap[n.type]
      if (!kind) {
        skipped += 1
        continue
      }
      const ext = extname(localPath).replace(/^\./, '').toLowerCase() || assetExtFor(localPath, kind as 'character' | 'scene' | 'audio' | 'clip')
      const assetId = newAssetId()
      const fileName = newAssetFileName(assetId, ext)
      // Honor sourcePath so assets land in the user's project directory.
      const assetRoot = srcPath ? join(srcPath, 'assets') : join(wsRoot, 'projects', pid, 'assets')
      const catDir = join(assetRoot, ASSET_CATEGORY_DIR[kind])
      await mkdir(catDir, { recursive: true })
      await writeFile(join(catDir, fileName), bytes)

      // Update index.
      const indexFile = srcPath ? '.index.json' : 'index.json'
      const index = await loadAssetIndex(assetRoot, indexFile)
      const now = new Date().toISOString()
      const label = ((n.data as { label?: unknown })?.label ?? '').toString().trim().slice(0, 64) || `${kind}-${assetId.slice(2, 6)}`
      index.assets.push({
        id: assetId,
        kind,
        name: label,
        file: fileName,
        bytes: bytes.length,
        origin: { type: 'canvas', canvasNodeId: n.id },
        createdAt: now,
        updatedAt: now,
      })
      await writeAssetIndex(assetRoot, index, indexFile)

      // Rewrite resultUrl.
      const newUrl = `projects/${pid}/assets/${ASSET_CATEGORY_DIR[kind]}/${fileName}`
      ;(n.data as { resultUrl?: string }).resultUrl = newUrl
      changed = true
      migrated += 1
    }
    if (changed) {
      const out = { nodes: doc.nodes, edges: doc.edges ?? [], version: doc.version ?? 0 }
      const writePath = srcPath ? join(srcPath, '.canvas.json') : join(wsRoot, 'canvases', `${pid}.json`)
      try {
        await mkdir(dirname(writePath), { recursive: true })
        await writeFile(writePath, JSON.stringify(out, null, 2), 'utf8')
      } catch (e) {
        errors.push(`${pid}: failed to persist rewritten canvas: ${(e as Error).message}`)
      }
    }
  }
  return { migrated, skipped, errors }
}
