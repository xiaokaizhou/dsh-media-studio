/**
 * Project store — the multi-project layer on top of the canvas store.
 *
 * One project owns exactly one storyboard canvas (project id == canvas id)
 * plus a categorized asset library. The registry file
 * `<workspaceRoot>/projects.json` is the single authoritative project list;
 * canvases keep persisting at the legacy `<workspaceRoot>/canvases/<id>.json`
 * path so existing data never moves (the first boot after upgrade promotes
 * every legacy canvas to a project).
 *
 * Hard rules this store enforces:
 *   1. Project `id` is immutable; only `name` changes. Nothing on disk is
 *      renamed on rename — references can never break from a rename.
 *   2. Every mutating call is serialized through one promise queue
 *      (single-writer), matching the canvas store's atomic-batch model.
 *   3. Deletion always runs dependency analysis first; when other projects
 *      soft-reference this project's assets the caller must pick a cascade
 *      mode: block / migrate referenced assets to the shared library
 *      (`__shared`) / force-delete and mark every referencing node broken.
 *   4. Deletion goes to `<workspaceRoot>/trash/` by default (recoverable).
 *
 * The store never reads/writes assets themselves (see asset-store.ts) — it
 * only moves whole project asset directories, except for the `migrate-shared`
 * cascade which needs the asset index to relocate referenced files.
 */

import { readFile, writeFile, mkdir, readdir, rename, rm, copyFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CanvasStore, CanvasOp } from './canvas-store'
import {
  ASSET_CATEGORY_DIR,
  type Asset,
  type AssetIndexFile,
  type AssetKind,
  loadAssetIndex,
  writeAssetIndex,
} from './asset-store'

// ── Registry shapes ────────────────────────────────────────────────────────

export interface ProjectMeta {
  /** Immutable project id. Doubles as the storyboard canvas id. */
  id: string
  /** Editable display name — never reflected in paths or references. */
  name: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  /** True for projects auto-created from pre-upgrade canvases/*.json files. */
  legacy?: boolean
}

export interface ProjectRegistry {
  version: number
  activeId: string | null
  /** Most-recently-opened ids, newest first, capped at recentLimit. */
  recent: string[]
  projects: Record<string, ProjectMeta>
}

/** Slim registry view sent to the client / SSE listeners. */
export interface RegistrySnapshot {
  activeId: string | null
  recent: string[]
  projects: ProjectMeta[]
}

export type DeleteMode = 'trash' | 'permanent'
export type DeleteCascade = 'cancel' | 'break-refs' | 'migrate-shared'

/** One referencing hit found by dependency analysis. */
export interface RefHit {
  refProjectId: string
  refProjectName: string
  assetId: string
  nodeIds: string[]
}

/** Dependency analysis result shown before deletion. */
export interface DependentsInfo {
  totalRefs: number
  /** Hits grouped by (referencing project, referenced asset). */
  hits: RefHit[]
  /** Informational: projects that hard-copied this project's assets. */
  copyConsumers: Array<{ projectId: string; projectName: string; count: number }>
}

export interface DeleteResult {
  deletedId: string
  /** New active project after deletion, or null when none remain. */
  switchedTo: string | null
  mode: DeleteMode
  cascade: DeleteCascade
  /** migrate-shared stats */
  migratedFiles?: number
  migratedAssets?: number
  rewrittenNodes?: number
  brokenNodes?: number
}

/** Project-scoped events pushed to SSE subscribers (registry/open/delete). */
export type ProjectEventType = 'registry-changed' | 'project-open' | 'project-deleted'

export interface ProjectEvent {
  type: ProjectEventType
  registry?: RegistrySnapshot
  projectId?: string
  name?: string
  switchedTo?: string | null
}

export interface ProjectStoreOpts {
  recentLimit: number
  trashEnabled: boolean
  /** Called after every registry/open/delete mutation so the transport layer
   *  can push the event to project SSE subscribers. */
  onEvent?: (event: ProjectEvent) => void
}

const REGISTRY_VERSION = 1
const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'audio', 'clip']

export function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
}

export function validateProjectName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'name is required'
  if (trimmed.length > 64) return 'name must be at most 64 characters'
  // Reserved only because a future "export to folder" may map names to paths.
  if (/[\\/:*?"<>|]/.test(trimmed)) return 'name may not contain \\ / : * ? " < > |'
  return null
}

export class ProjectDeleteBlockedError extends Error {
  constructor(public readonly dependents: DependentsInfo) {
    super(`project is referenced by other projects (${dependents.totalRefs} soft reference(s)); choose a cascade mode`)
    this.name = 'ProjectDeleteBlockedError'
  }
}

// ── The store ──────────────────────────────────────────────────────────────

export class ProjectStore {
  private registry: ProjectRegistry = { version: REGISTRY_VERSION, activeId: null, recent: [], projects: {} }
  private readyPromise: Promise<void>
  private queue: Promise<unknown> = Promise.resolve()
  private wsRoot: string
  private canvasStore: CanvasStore
  private opts: ProjectStoreOpts

  constructor(wsRoot: string, canvasStore: CanvasStore, opts: ProjectStoreOpts) {
    this.wsRoot = wsRoot
    this.canvasStore = canvasStore
    this.opts = opts
    this.readyPromise = this.serial(() => this.boot())
  }

  // ── public reads (await ready, then return registry-derived data) ───────

  /** Wait until the registry is loaded/migrated. All reads funnel through
   *  this so first-request-after-boot never races the async boot. */
  async ready(): Promise<void> {
    await this.readyPromise
  }

  /** Snapshot of the whole registry for clients / SSE. */
  snapshot(): RegistrySnapshot {
    const projects = Object.values(this.registry.projects)
      .slice()
      .sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : a.lastOpenedAt > b.lastOpenedAt ? -1 : 0))
    return { activeId: this.registry.activeId, recent: this.registry.recent, projects }
  }

  getRecentLimit(): number {
    return Math.max(1, Math.floor(this.opts.recentLimit))
  }

  /**
   * Resolve the canvas id tools/UI should default to: the active project's
   * canvas, else the legacy plugin default. Kept synchronous because tool
   * registration and default-canvas reads happen before the async boot may
   * finish; when the registry is still empty this returns null and callers
   * fall back to `main` as before.
   */
  activeCanvasId(): string | null {
    if (this.registry.activeId && this.registry.projects[this.registry.activeId]) return this.registry.activeId
    return this.registry.recent[0] ?? null
  }

  // ── boot / migration ────────────────────────────────────────────────────

  /** Load the registry or, on a fresh upgrade, promote every legacy
   *  canvases/*.json file to a project. Never deletes anything. */
  private async boot(): Promise<void> {
    const registryPath = this.registryPath()
    let raw: string | null = null
    try {
      raw = await readFile(registryPath, 'utf8')
    } catch { /* absent — first run or pre-upgrade */ }

    let loaded = false
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as ProjectRegistry
        if (parsed && typeof parsed === 'object' && typeof parsed.version === 'number') {
          this.registry = parsed
          this.registry.projects ??= {}
          this.registry.recent = Array.isArray(parsed.recent) ? parsed.recent.filter((id) => this.registry.projects[id]) : []
          loaded = true
        }
      } catch {
        console.warn(`[media-studio] projects.json is corrupt (${registryPath}) — starting with an empty registry; the original file is left untouched for manual recovery.`)
      }
    }

    if (!loaded) {
      // Fresh upgrade: promote legacy canvases (sorted: 'main' first for stable active).
      let canvasIds: string[] = []
      try {
        const dir = join(this.wsRoot, 'canvases')
        const entries = await readdir(dir)
        canvasIds = entries.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length)).sort((a, b) => {
          if (a === 'main') return -1
          if (b === 'main') return 1
          return a < b ? -1 : 1
        })
      } catch { /* no canvases dir — brand-new workspace */ }

      const now = new Date().toISOString()
      for (const id of canvasIds) {
        this.registry.projects[id] = {
          id,
          name: id === 'main' ? '未命名项目' : id,
          createdAt: now,
          updatedAt: now,
          lastOpenedAt: now,
          legacy: true,
        }
      }
      this.registry.recent = canvasIds
      this.registry.activeId = canvasIds[0] ?? null
      await this.persistRegistry()
      if (canvasIds.length > 0) {
        console.log(`[media-studio] migrated ${canvasIds.length} legacy canvas(es) into project registry: ${canvasIds.join(', ')}`)
      }
    }

    // Make sure every persisted canvas is in memory before any dependents
    // scan runs (restore is version-guarded, so re-invocation is safe).
    await this.canvasStore.restore()
  }

  private registryPath(): string {
    return join(this.wsRoot, 'projects.json')
  }

  // ── project operations (all serialized) ─────────────────────────────────

  async createProject(name?: string): Promise<ProjectMeta> {
    return this.serial(async () => {
      await this.readyPromise
      const trimmed = name?.trim() ?? ''
      const finalName = trimmed || this.defaultNewName()
      const err = validateProjectName(finalName)
      if (err) throw new Error(`createProject rejected: ${err}`)

      const meta: ProjectMeta = {
        id: newProjectId(),
        name: finalName,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      }
      await this.ensureProjectTemplate(meta.id)
      this.registry.projects[meta.id] = meta
      await this.setActiveLocked(meta.id)
      this.emit({ type: 'registry-changed' })
      return { ...meta }
    })
  }

  async openProject(id: string): Promise<ProjectMeta> {
    return this.serial(async () => {
      await this.readyPromise
      const meta = this.registry.projects[id]
      if (!meta) throw new Error(`openProject: project "${id}" not found`)
      meta.lastOpenedAt = new Date().toISOString()
      await this.setActiveLocked(id)
      this.emit({ type: 'project-open', projectId: id, name: meta.name, registry: this.snapshot() })
      return { ...meta }
    })
  }

  async renameProject(id: string, name: string): Promise<ProjectMeta> {
    return this.serial(async () => {
      await this.readyPromise
      const meta = this.registry.projects[id]
      if (!meta) throw new Error(`renameProject: project "${id}" not found`)
      const err = validateProjectName(name)
      if (err) throw new Error(`renameProject rejected: ${err}`)
      meta.name = name.trim()
      meta.updatedAt = new Date().toISOString()
      await this.persistRegistry()
      this.emit({ type: 'registry-changed' })
      return { ...meta }
    })
  }

  /** Dependency preflight used by both the REST endpoint and deleteProject.
   *  Soft refs come from canvases; hard-copy consumers come from canvas nodes
   *  (legacy refCopiesFrom) and from other projects' asset indexes (M2
   *  copyAssetToProject provenance). */
  async dependentsOf(ownerId: string): Promise<DependentsInfo> {
    await this.readyPromise
    const hits: RefHit[] = []
    const copyCounts = new Map<string, number>()

    for (const meta of Object.values(this.registry.projects)) {
      if (meta.id === ownerId) continue
      const snap = this.canvasStore.peek(meta.id)
      if (snap && snap.graph.nodes.length > 0) {
        const byAsset = new Map<string, { assetId: string; nodeIds: string[] }>()
        for (const n of snap.graph.nodes) {
          const ref = (n.data as { assetRef?: { projectId?: string; assetId?: string } }).assetRef
          if (ref && ref.projectId === ownerId && typeof ref.assetId === 'string' && ref.assetId) {
            const bucket = byAsset.get(ref.assetId) ?? { assetId: ref.assetId, nodeIds: [] }
            bucket.nodeIds.push(n.id)
            byAsset.set(ref.assetId, bucket)
          }
          const origin = (n.data as { refCopiesFrom?: { projectId?: string } }).refCopiesFrom
          if (origin && origin.projectId === ownerId) copyCounts.set(meta.id, (copyCounts.get(meta.id) ?? 0) + 1)
        }
        for (const bucket of byAsset.values()) {
          hits.push({ refProjectId: meta.id, refProjectName: meta.name, assetId: bucket.assetId, nodeIds: bucket.nodeIds })
        }
      }
      // Hard copies stored in the other project's asset index (copyOf).
      const idx = await loadAssetIndex(this.projectAssetRoot(meta.id))
      for (const a of idx.assets) {
        if (a.copyOf && a.copyOf.projectId === ownerId) {
          copyCounts.set(meta.id, (copyCounts.get(meta.id) ?? 0) + 1)
        }
      }
    }
    const copyConsumers: Array<{ projectId: string; projectName: string; count: number }> = []
    for (const [pid, count] of copyCounts) {
      copyConsumers.push({ projectId: pid, projectName: this.registry.projects[pid]?.name ?? pid, count })
    }
    const totalRefs = hits.reduce((sum, h) => sum + h.nodeIds.length, 0)
    return { totalRefs, hits, copyConsumers }
  }

  /**
   * Delete a project.
   *
   * @param id       project id
   * @param mode     trash (default) | permanent
   * @param cascade  cancel (default, throws when referenced) | break-refs |
   *                 migrate-shared
   */
  async deleteProject(id: string, mode: DeleteMode = 'trash', cascade: DeleteCascade = 'cancel'): Promise<DeleteResult> {
    return this.serial(async () => {
      await this.readyPromise
      const meta = this.registry.projects[id]
      if (!meta) throw new Error(`deleteProject: project "${id}" not found`)
      if (id === '__shared') throw new Error('deleteProject: the shared library cannot be deleted')

      const dependents = await this.dependentsOf(id)
      let migratedAssets = 0
      let migratedFiles = 0
      let rewrittenNodes = 0
      let brokenNodes = 0

      if (dependents.totalRefs > 0) {
        if (cascade === 'cancel' || cascade === undefined) throw new ProjectDeleteBlockedError(dependents)
        if (cascade === 'migrate-shared') {
          const migrated = await this.migrateRefsToShared(id, dependents.hits)
          migratedAssets = migrated.assets
          migratedFiles = migrated.files
          rewrittenNodes = migrated.rewrittenNodes
        } else if (cascade === 'break-refs') {
          brokenNodes = await this.markReferencingNodesBroken(id, dependents.hits)
        } else {
          throw new Error(`deleteProject: unknown cascade mode "${cascade}"`)
        }
      }

      // Determine the next active project before removal.
      const wasActive = this.registry.activeId === id
      let switchedTo: string | null = null
      if (wasActive) {
        const candidates = this.registry.recent.filter((rid) => rid !== id && this.registry.projects[rid])
        switchedTo = candidates[0] ?? Object.keys(this.registry.projects).find((pid) => pid !== id) ?? null
      }

      // Physically remove: project asset dir → trash/permanent.
      await this.disposeProjectAssets(id, mode)
      // Canvas file (in-memory evict + file to trash/permanent).
      this.canvasStore.evictCanvas(id)
      await this.disposeFile(this.canvasStore.canvasFilePath(id), mode)

      delete this.registry.projects[id]
      this.registry.recent = this.registry.recent.filter((rid) => rid !== id)
      if (switchedTo) this.registry.activeId = switchedTo
      else if (this.registry.activeId === id) this.registry.activeId = null
      await this.persistRegistry()

      this.emit({ type: 'project-deleted', projectId: id, name: meta.name, switchedTo })
      this.emit({ type: 'registry-changed' })

      return {
        deletedId: id,
        switchedTo,
        mode,
        cascade: cascade as DeleteCascade,
        migratedFiles,
        migratedAssets,
        rewrittenNodes,
        brokenNodes,
      }
    })
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Serialize mutations behind one promise chain (single-writer). */
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    // Keep the chain alive regardless of individual failures.
    this.queue = run.catch(() => {})
    return run
  }

  private emit(event: ProjectEvent): void {
    if (!event.registry) event.registry = this.snapshot()
    this.opts.onEvent?.(event)
  }

  private async persistRegistry(): Promise<void> {
    try {
      await mkdir(dirname(this.registryPath()), { recursive: true })
      await writeFile(this.registryPath(), JSON.stringify(this.registry, null, 2), 'utf8')
    } catch (e) {
      console.warn(`[media-studio] persist projects.json failed: ${(e as Error).message}`)
    }
  }

  /** Mark active + push recent to front + persist (must be inside serial). */
  private async setActiveLocked(id: string): Promise<void> {
    this.registry.activeId = id
    this.registry.recent = [id, ...this.registry.recent.filter((rid) => rid !== id)].slice(0, this.getRecentLimit())
    await this.persistRegistry()
  }

  private defaultNewName(): string {
    const n = Object.keys(this.registry.projects).length + 1
    return `未命名项目 ${n}`
  }

  /** Create the four asset category dirs + an empty index for a project. */
  private async ensureProjectTemplate(projectId: string): Promise<void> {
    const root = this.projectAssetRoot(projectId)
    try {
      for (const kind of ASSET_KINDS) {
        await mkdir(join(root, ASSET_CATEGORY_DIR[kind]), { recursive: true })
      }
      const indexPath = join(root, 'index.json')
      try {
        await readFile(indexPath, 'utf8')
      } catch {
        await writeAssetIndex(root, { version: 1, assets: [] })
      }
    } catch (e) {
      console.warn(`[media-studio] ensureProjectTemplate(${projectId}) failed: ${(e as Error).message}`)
    }
  }

  private projectAssetRoot(projectId: string): string {
    return join(this.wsRoot, 'projects', projectId, 'assets')
  }

  private sharedAssetRoot(): string {
    return join(this.wsRoot, 'shared-assets')
  }

  private async disposeProjectAssets(projectId: string, mode: DeleteMode): Promise<void> {
    const dir = dirname(this.projectAssetRoot(projectId)) // projects/<id>
    await this.disposeFile(dir, mode)
  }

  private async disposeFile(target: string, mode: DeleteMode): Promise<void> {
    try {
      if (mode === 'trash' && this.opts.trashEnabled) {
        const trashRoot = join(this.wsRoot, 'trash')
        await mkdir(trashRoot, { recursive: true })
        const dest = join(trashRoot, `${this.basename(target)}_${Date.now()}`)
        await rename(target, dest)
        console.log(`[media-studio] moved to trash: ${dest}`)
      } else {
        await rm(target, { recursive: true, force: true })
      }
    } catch (e) {
      // Missing source is fine; real errors are logged but non-fatal.
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') console.warn(`[media-studio] disposeFile(${target}) failed: ${(e as Error).message}`)
    }
  }

  private basename(p: string): string {
    return p.split(/[\\/]/).pop() ?? 'item'
  }

  /**
   * migrate-shared cascade: copy every referenced asset file from the doomed
   * project into the shared library, then rewrite all referencing nodes'
   * `assetRef.projectId` to `__shared` so nothing breaks. Dedupes by asset
   * id/file so a second migration never duplicates.
   */
  private async migrateRefsToShared(
    ownerId: string,
    hits: RefHit[],
  ): Promise<{ assets: number; files: number; rewrittenNodes: number }> {
    const index = await loadAssetIndex(this.projectAssetRoot(ownerId))
    const indexById = new Map(index.assets.map((a) => [a.id, a]))
    const sharedIndex = await loadAssetIndex(this.sharedAssetRoot())
    const sharedById = new Map(sharedIndex.assets.map((a) => [a.id, a]))

    // Unique referenced asset ids → copy missing files into the shared root,
    // tagging each migrated asset with its origin for provenance.
    const uniqueAssetIds = [...new Set(hits.map((h) => h.assetId))]
    let files = 0
    const migratedAssets: Asset[] = []
    for (const assetId of uniqueAssetIds) {
      const entry = indexById.get(assetId)
      if (!entry || !entry.file || sharedById.has(assetId)) continue
      const cat = ASSET_CATEGORY_DIR[entry.kind]
      if (!cat) continue
      const source = join(this.projectAssetRoot(ownerId), cat, entry.file)
      const destDir = join(this.sharedAssetRoot(), cat)
      try {
        await mkdir(destDir, { recursive: true })
        await copyFile(source, join(destDir, entry.file))
        files += 1
      } catch (e) {
        console.warn(`[media-studio] migrate-shared: could not copy ${source}: ${(e as Error).message}`)
      }
      const migrated: Asset = { ...entry, origin: { type: 'migrated', fromProject: ownerId }, updatedAt: new Date().toISOString() }
      migratedAssets.push(migrated)
      sharedById.set(assetId, migrated)
    }
    if (migratedAssets.length > 0 || sharedIndex.assets.length > 0) {
      const merged = new Map<string, Asset>()
      for (const a of sharedIndex.assets) merged.set(a.id, a)
      for (const a of migratedAssets) merged.set(a.id, a)
      const out: AssetIndexFile = { version: 1, assets: [...merged.values()] }
      await writeAssetIndex(this.sharedAssetRoot(), out)
    }

    // Rewrite referencing nodes. Group by canvas, one atomic apply each.
    let rewrittenNodes = 0
    const byCanvas = new Map<string, CanvasOp[]>()
    for (const hit of hits) {
      const ops = byCanvas.get(hit.refProjectId) ?? []
      for (const nodeId of hit.nodeIds) {
        ops.push({ op: 'updateNode', id: nodeId, data: { assetRef: { projectId: '__shared', assetId: hit.assetId } } })
      }
      byCanvas.set(hit.refProjectId, ops)
    }
    for (const [canvasId, ops] of byCanvas) {
      try {
        this.canvasStore.apply(canvasId, ops)
        rewrittenNodes += ops.length
      } catch (e) {
        console.warn(`[media-studio] migrate-shared: rewriting refs on "${canvasId}" failed: ${(e as Error).message}`)
      }
    }
    return { assets: uniqueAssetIds.length, files, rewrittenNodes }
  }

  /** break-refs cascade: mark every referencing node broken in place. */
  private async markReferencingNodesBroken(ownerId: string, hits: RefHit[]): Promise<number> {
    let brokenNodes = 0
    const byCanvas = new Map<string, CanvasOp[]>()
    for (const hit of hits) {
      const ops = byCanvas.get(hit.refProjectId) ?? []
      for (const nodeId of hit.nodeIds) {
        ops.push({
          op: 'updateNode',
          id: nodeId,
          data: { brokenAsset: true, status: 'error', errorMsg: `源项目已删除（${ownerId}）` },
        })
      }
      byCanvas.set(hit.refProjectId, ops)
    }
    for (const [canvasId, ops] of byCanvas) {
      try {
        this.canvasStore.apply(canvasId, ops)
        brokenNodes += ops.length
      } catch (e) {
        console.warn(`[media-studio] break-refs on "${canvasId}" failed: ${(e as Error).message}`)
      }
    }
    return brokenNodes
  }
}
