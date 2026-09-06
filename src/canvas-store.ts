/**
 * Canvas state management — server-side source of truth for the canvas tab.
 *
 * Modeled directly on the workflow-one `engine.js` Canvas 4-guard pattern:
 *   1. `no-graph`              — incoming payload has no nodes[] array
 *   2. `stale-version`         — incoming version < current version (someone else wrote newer)
 *   3. `empty-regression`     — incoming is empty while current isn't (don't blank the canvas)
 *   4. closed fiber cleanup   — disposed when the plugin unloads
 *
 * Persistence: every accepted write is atomically JSON-flushed to disk
 * (`workspaceRoot/canvases/<canvasId>.json`). The canvas store is
 * recovered from disk on plugin boot so closing/reopening DSH restores
 * the canvas exactly.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export interface CanvasNode {
  id: string
  type: 'text' | 'image' | 'video' | 'music' | 'note'
  /** User-friendly label rendered in the canvas card. */
  label: string
  /** Free-form data attached by the agent / UI: prompt, resultUrl, status, etc. */
  data: Record<string, unknown>
  /** Logical position in the canvas; UI maps to x/y in px. */
  position?: { x: number; y: number }
}

export interface CanvasEdge {
  id: string
  source: string
  target: string
  /** Optional branch label for condition nodes (true / false). */
  branch?: 'true' | 'false'
  /** Optional edge semantics — what this dependency means (e.g. "角色清单来源",
   *  "一致性锚点"). Rendered on the edge in the canvas UI. */
  label?: string
}

/** A named, bounded container on the canvas. Regions are layout scaffolds:
 *  the skill (or user) groups related nodes inside a region for partitioned
 *  reading; nodes declare membership via `data.region = <regionId>`. Regions
 *  themselves carry no content — deleting a region keeps every node. */
export interface CanvasRegion {
  id: string
  /** User-facing title rendered in the region header. */
  label: string
  /** Free-form classification (e.g. 'flow' | 'script' | 'characters' |
   *  'scenes' | 'storyboard' | 'media'); the UI may tint by kind. */
  kind?: string
  x: number
  y: number
  w: number
  h: number
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  regions: CanvasRegion[]
}

export interface CanvasState {
  graph: CanvasGraph
  /** Monotonic version, increments on every accepted patch. */
  version: number
  /** Session ids currently bound to this canvas (for SSE scoping). */
  boundSessions: Set<string>
}

export interface CanvasSnapshot {
  graph: CanvasGraph
  version: number
}

export interface PatchResult {
  /** The new graph after the patch was applied. */
  graph: CanvasGraph
  /** Echo back the ops that were accepted (for the SSE listener). */
  patch: CanvasOp[]
  /** Canvas version after this patch (the SSE listener uses this to dedup). */
  version: number
  /** Whether the post-patch lint passed (no errors, only warnings). */
  lintOk: boolean
  /** Lint issues (warnings + errors). */
  issues: string[]
  /** Most recent persistence error for this canvas, if any. The in-memory
   *  state is still authoritative; this warns the caller that the on-disk
   *  copy may be stale (e.g. disk full, permission denied). Absent when the
   *  last persist succeeded. */
  persistError?: string
}

/**
 * The op union — extends dsh-harness-one's set with our own op codes.
 * See `validateOps` for the full grammar.
 */
export type CanvasOp =
  | {
    op: 'addNode'
    type: CanvasNode['type']
    label: string
    data?: Record<string, unknown>
    position?: { x: number; y: number }
    /**
     * Optional region id — when `position` is omitted the node is placed in
     * the region's own grid (regionSlot) instead of the global defaultSlot.
     * The node's membership is recorded as `data.region = regionId` so
     * region-aware auto-arrange and queries can find it later.
     */
    regionId?: string
    /**
     * Optional explicit node id. The canvas UI uses this when it needs to
     * reference the new node from a later op in the same batch (e.g. create
     * node + connect atomically). Must be unique on the canvas; when absent
     * the store generates an id.
     */
    nodeId?: string
  }
  | { op: 'updateNode'; id: string; data: Record<string, unknown> }
  | { op: 'renameNode'; id: string; label: string }
  | { op: 'deleteNode'; id: string }
  | { op: 'moveNode'; id: string; position: { x: number; y: number } }
  | { op: 'connect'; from: string; to: string; branch?: 'true' | 'false'; label?: string }
  | { op: 'deleteEdge'; id: string }
  | {
    op: 'addRegion'
    label: string
    kind?: string
    /** Optional explicit id; when absent the store generates one. */
    id?: string
    /** Position + size. When omitted the region auto-stacks below the
     *  lowest existing region (default 640 × 400). */
    x?: number
    y?: number
    w?: number
    h?: number
  }
  | { op: 'updateRegion'; id: string; label?: string; kind?: string; x?: number; y?: number; w?: number; h?: number }
  | { op: 'deleteRegion'; id: string }
  | {
    op: 'fitRegion'
    id: string
    /** Snap the region box to the tight bounding box of its member nodes
     *  (small padding + header). Empty regions are left untouched. */
  }
  | {
    op: 'batchAddMedia'
    items: Array<{
      kind: 'image' | 'video' | 'audio'
      url: string
      prompt?: string
      model?: string
      /** Position hint for the new node (UI may snap-to-grid). */
      position?: { x: number; y: number }
      /** Region to auto-place into when `position` is omitted (membership
       *  recorded as data.region). */
      regionId?: string
      /** Optional explicit id; if absent we generate one. */
      nodeId?: string
      /** Video-only: provider-supplied cover / thumbnail URL. Passed
       *  through to prepareVideoForCanvas in post-processing so the card
       *  can display a real first-frame poster. */
      coverUrl?: string
    }>
  }

/** Hook invoked after every accepted `apply()` so transport layers (SSE)
 *  can push the new graph to subscribed clients. Wired by the host `apply()`;
 *  `undefined` disables broadcasting (tests / headless). */
export type CanvasBroadcast = (
  canvasId: string,
  payload: { version: number; graph: CanvasGraph; patch: CanvasOp[] },
) => void

const NEW_NODE_KINDS = new Set<CanvasNode['type']>(['text', 'image', 'video', 'music', 'note'])

export class CanvasStore {
  private canvases = new Map<string, CanvasState>()
  private workspaceRoot: string
  private broadcast?: CanvasBroadcast
  private logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void; debug?: (m: string) => void }
  /** canvasId → absolute sourcePath; undefined falls back to legacy layout. */
  private canvasSourcePaths = new Map<string, string>()
  /** canvasId → most recent persist error message. Cleared on successful
   *  persist. Surfaced in PatchResult.persistError so callers know the
   *  on-disk copy may be stale. */
  private lastPersistError = new Map<string, string>()
  /** canvasId → highest version ever applied. Used to detect version
   *  rollback (e.g. a race where the in-memory canvas was reset to an
   *  older state). On rollback we log and clamp so subsequent ops don't
   *  silently overwrite newer state. */
  private maxVersionSeen = new Map<string, number>()

  constructor(workspaceRoot: string, opts?: { broadcast?: CanvasBroadcast; logger?: CanvasStore['logger'] }) {
    this.workspaceRoot = workspaceRoot
    this.broadcast = opts?.broadcast
    this.logger = opts?.logger
  }

  /** Register/refresh the sourcePath for a canvas. Called by the ProjectStore
   *  on boot, create, rename, and open so the canvas store knows where to
   *  persist without the caller threading sourcePath through every op. */
  setCanvasSourcePath(canvasId: string, sourcePath: string | undefined): void {
    if (sourcePath) this.canvasSourcePaths.set(canvasId, sourcePath)
    else this.canvasSourcePaths.delete(canvasId)
  }

  /** Public read accessor for a single canvas's sourcePath. Replaces the
   *  previous type-assertion hack in tools.ts that reached into the private
   *  `canvasSourcePaths` map. */
  getSourcePath(canvasId: string): string | undefined {
    return this.canvasSourcePaths.get(canvasId)
  }

  /** Snapshot the (canvasId → sourcePath) map for restore() / diagnostics. */
  allSourcePaths(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.canvasSourcePaths) out[k] = v
    return out
  }

  /** Resolve one canvas (lazily created if absent). Key includes the workspace
   *  root so two profiles pointing at the same canvasId never collide. */
  canvasOf(canvasId: string): CanvasState {
    const key = `${this.workspaceRoot}\0${canvasId}`
    let cv = this.canvases.get(key)
    if (!cv) {
      cv = { graph: { nodes: [], edges: [], regions: [] }, version: 0, boundSessions: new Set() }
      this.canvases.set(key, cv)
    }
    return cv
  }

  /**
   * Apply a batch of ops atomically. Either every op succeeds or the canvas
   * is left untouched and the caller gets a lint error back to fix and retry.
   */
  apply(canvasId: string, ops: CanvasOp[]): PatchResult {
    if (!Array.isArray(ops)) throw new Error('canvas-graph-patch: ops must be an array')
    if (ops.length === 0) throw new Error('canvas-graph-patch: ops must be a non-empty array')

    const cv = this.canvasOf(canvasId)
    const next = cloneGraph(cv.graph)

    // Validation + mutation pass.
    for (const op of ops) {
      const err = applyOp(next, op)
      if (err) throw new Error(`canvas-graph-patch rejected (no change applied): op=${op.op}: ${err}`)
    }

    // Post-write lint (cheap, sync).
    const issues = lintGraph(next)
    const lintOk = issues.every((s) => !s.startsWith('error:'))

    cv.graph = next
    cv.version += 1
    // Version monotonicity guard: if the in-memory canvas was reset to an
    // older state (race / restore glitch), cv.version could roll back. We
    // track the highest version ever seen for this canvas; on rollback we
    // log and clamp so subsequent ops don't silently overwrite newer state.
    const prevMax = this.maxVersionSeen.get(canvasId) ?? 0
    if (cv.version <= prevMax) {
      this.logger?.warn?.(
        `[media-studio] version rollback detected for canvas "${canvasId}": applying v${cv.version} but previously saw v${prevMax}; clamping to v${prevMax + 1}`,
      )
      cv.version = prevMax + 1
    }
    this.maxVersionSeen.set(canvasId, cv.version)
    // Persist on the same thread so a frontend crash before SSE delivery
    // does not roll the canvas back.
    void this.persist(canvasId, cv, this.canvasSourcePaths.get(canvasId))

    // Push the new graph to every connected SSE client (the canvas tab
    // subscribes here). Centralized in `apply` so the agent's
    // `canvas_graph_patch` tool AND the client's REST PATCH endpoint both
    // broadcast through the same path — no drift between the two callers.
    this.broadcast?.(canvasId, { version: cv.version, graph: next, patch: ops })

    const persistError = this.lastPersistError.get(canvasId)
    return persistError
      ? { graph: next, patch: ops, version: cv.version, lintOk, issues, persistError }
      : { graph: next, patch: ops, version: cv.version, lintOk, issues }
  }

  /**
   * Auto-arrange nodes by topological depth (same algorithm as the client
   * view-bar wand). Columns are ordered by BFS depth from sources; within
   * each column nodes stack vertically. Uses a default card height of 200
   * px so the server-side result is close to what the client would produce.
   *
   * When `opts.regionId` is given, only nodes whose `data.region` matches
   * are re-laid out, constrained INSIDE the region bounds (columns wrap
   * within the region width) — so per-region tidy-ups never break the
   * partitioned canvas layout.
   */
  autoArrange(canvasId: string, opts?: { regionId?: string }): PatchResult {
    const cv = this.canvasOf(canvasId)
    const g = cv.graph
    const region = opts?.regionId ? g.regions.find((r) => r.id === opts.regionId) : undefined
    const targetNodes = region
      ? g.nodes.filter((n) => (n.data as Record<string, unknown>).region === region.id)
      : g.nodes
    if (targetNodes.length === 0) {
      const persistError = this.lastPersistError.get(canvasId)
      return persistError
        ? { graph: cloneGraph(g), patch: [], version: cv.version, lintOk: true, issues: [], persistError }
        : { graph: cloneGraph(g), patch: [], version: cv.version, lintOk: true, issues: [] }
    }
    const targetIds = new Set(targetNodes.map((n) => n.id))

    // Build adjacency maps (edges counted only when both ends are targets).
    const inMap = new Map<string, string[]>()
    const outMap = new Map<string, string[]>()
    for (const e of g.edges) {
      if (!targetIds.has(e.source) || !targetIds.has(e.target)) continue
      const inArr = inMap.get(e.target) ?? []
      inArr.push(e.source)
      inMap.set(e.target, inArr)
      const outArr = outMap.get(e.source) ?? []
      outArr.push(e.target)
      outMap.set(e.source, outArr)
    }
    // BFS depth from roots (nodes with no incoming edges).
    const depth = new Map<string, number>()
    const queue: Array<{ id: string; d: number }> = []
    for (const n of targetNodes) {
      if (!inMap.get(n.id)?.length) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
    }
    while (queue.length) {
      const { id, d } = queue.shift()!
      for (const t of outMap.get(id) ?? []) {
        if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
      }
    }
    for (const n of targetNodes) if (!depth.has(n.id)) depth.set(n.id, 0)

    // Group ids by depth.
    const byDepth = new Map<number, string[]>()
    for (const n of targetNodes) {
      const d = depth.get(n.id) ?? 0
      const list = byDepth.get(d) ?? []
      list.push(n.id)
      byDepth.set(d, list)
    }

    // Column pitch mirrors the client: cardW (default 260) + 130 = 390 px.
    const colPitch = 390
    const rowGap = 44
    const defaultH = 200
    const marginX = 60
    const marginY = 60
    const moves: CanvasOp[] = []
    if (region) {
      // Region-constrained layout: columns wrap inside the region width,
      // rows grow downward inside the region height; the region header bar
      // (64 px) is left free at the top. Pitch matches the region gallery
      // grid (cards are ~240px, so column/row pitch 260 keeps them tight).
      const pad = REGION_PAD
      const headerH = REGION_HEADER_H
      const colPitchR = REGION_COL
      const rowPitchR = REGION_ROW
      const cols = Math.max(1, Math.floor((region.w - pad * 2) / colPitchR))
      let i = 0
      for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        for (const id of ids) {
          const col = i % cols
          const row = Math.floor(i / cols)
          moves.push({
            op: 'moveNode',
            id,
            position: {
              x: region.x + pad + col * colPitchR,
              y: region.y + headerH + row * rowPitchR,
            },
          })
          i += 1
        }
      }
    } else {
      for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let y = marginY
        for (const id of ids) {
          moves.push({ op: 'moveNode', id, position: { x: marginX + d * colPitch, y } })
          y += defaultH + rowGap
        }
      }
    }

    // Apply atomically — reuse the same store path so SSE fires.
    // After moving nodes, snap every affected region box tightly around its
    // members so the user never sees a half-empty region after auto-arrange.
    if (region) {
      moves.push({ op: 'fitRegion', id: region.id })
    } else {
      for (const r of g.regions) {
        if (g.nodes.some((n) => (n.data as Record<string, unknown>).region === r.id)) {
          moves.push({ op: 'fitRegion', id: r.id })
        }
      }
    }
    return this.apply(canvasId, moves)
  }

  /** Read the snapshot the canvas tab needs to render. */
  snapshot(canvasId: string): CanvasSnapshot {
    const cv = this.canvasOf(canvasId)
    return { graph: cloneGraph(cv.graph), version: cv.version }
  }

  /**
   * Non-mutating snapshot read. Unlike `snapshot()` this never lazily creates
   * an in-memory canvas entry for an unknown id — used by project-level scans
   * (deletion dependents analysis) where calling `canvasOf` would pollute the
   * map with empty states for projects that merely exist in the registry.
   * Returns null when the canvas has no in-memory state yet.
   */
  peek(canvasId: string): CanvasSnapshot | null {
    const cv = this.canvases.get(`${this.workspaceRoot}\0${canvasId}`)
    return cv ? { graph: cloneGraph(cv.graph), version: cv.version } : null
  }

  /** Drop a canvas from the in-memory map (used when its owning project is
   *  deleted). The persisted file is handled by the caller (trash/permanent). */
  evictCanvas(canvasId: string): void {
    const key = `${this.workspaceRoot}\0${canvasId}`
    const existed = this.canvases.delete(key)
    this.canvasSourcePaths.delete(canvasId)
    if (existed) this.broadcast?.(canvasId, { version: 0, graph: { nodes: [], edges: [], regions: [] }, patch: [] })
  }

  /** Absolute path of the persisted file for a canvas id (for move/remove).
   *  Honors `sourcePath` when the project carrying the canvas lives in a
   *  user-owned directory — falls back to the legacy `<wsRoot>/canvases/<id>`
   *  layout when no sourcePath is available. */
  canvasFilePath(canvasId: string, sourcePath?: string): string {
    return sourcePath ? join(sourcePath, '.canvas.json') : join(this.workspaceRoot, 'canvases', `${canvasId}.json`)
  }

  /** Bind a session id to this canvas (for SSE scoping). */
  bindSession(canvasId: string, sessionId: string): void {
    const cv = this.canvasOf(canvasId)
    cv.boundSessions.add(sessionId)
  }
  unbindSession(canvasId: string, sessionId: string): void {
    const cv = this.canvasOf(canvasId)
    cv.boundSessions.delete(sessionId)
  }
  boundSessions(canvasId: string): readonly string[] {
    return [...this.canvasOf(canvasId).boundSessions]
  }

  /** Restore every persisted canvas from disk into the in-memory map.
   *
   * Safety guard: only reload if the disk version is strictly newer than the
   * in-memory version. This prevents a late-running restore() from clobbering
   * in-memory state that was modified by patches applied after boot. It also
   * enables safe re-invocation (e.g. from a file watcher) without losing
   * uncommitted work.
   *
   * Reads from BOTH the new layout (`.canvas.json` at a project sourcePath)
   * and the legacy layout (`<wsRoot>/canvases/<id>.json`) so projects
   * without a sourcePath still boot cleanly.
   */
  async restore(sourcePaths: Record<string, string> = {}): Promise<void> {
    const fs = await import('node:fs/promises')
    this.logger?.debug?.(`[media-studio] restore() called with sourcePaths keys=${Object.keys(sourcePaths).join(',')} workspaceRoot=${this.workspaceRoot}`)

    // Legacy layout: <wsRoot>/canvases/<id>.json
    const legacyDir = join(this.workspaceRoot, 'canvases')
    const legacyIds = new Set<string>()
    try {
      for (const file of await fs.readdir(legacyDir)) {
        if (!file.endsWith('.json')) continue
        try {
          const raw = JSON.parse(await readFile(join(legacyDir, file), 'utf8'))
          const canvasId = file.slice(0, -'.json'.length)
          legacyIds.add(canvasId)
          this.maybeReload(canvasId, raw)
        } catch { /* corrupt file — leave the current in-memory canvas */ }
      }
    } catch { /* legacy dir absent — fine, this is the normal post-migration state */ }

    // New layout: each registered project's .canvas.json under its sourcePath.
    for (const [canvasId, sourcePath] of Object.entries(sourcePaths)) {
      try {
        const raw = JSON.parse(await readFile(join(sourcePath, '.canvas.json'), 'utf8'))
        this.maybeReload(canvasId, raw)
      } catch { /* missing or corrupt — skip */ }
    }
  }

  /** Internal: reload iff disk version is strictly newer than the in-memory
   *  version. Splits out of restore() to keep both layouts legible. */
  private maybeReload(canvasId: string, raw: { version?: unknown; nodes?: unknown; edges?: unknown; regions?: unknown }): void {
    const cv = this.canvasOf(canvasId)
    const diskVersion = typeof raw.version === 'number' ? raw.version : 0
    this.logger?.debug?.(`[media-studio] maybeReload(${canvasId}): inMem=${cv.version} disk=${diskVersion} diskNodes=${Array.isArray(raw.nodes) ? raw.nodes.length : '?'}`)
    if (diskVersion > cv.version) {
      cv.graph = {
        nodes: (raw.nodes as CanvasNode[]) ?? [],
        edges: (raw.edges as CanvasEdge[]) ?? [],
        regions: (raw.regions as CanvasRegion[]) ?? [],
      }
      cv.version = diskVersion
      this.logger?.debug?.(`[media-studio] maybeReload(${canvasId}): APPLIED, now ${cv.graph.nodes.length} nodes`)
    }
  }

  /** Migrate resultUrl paths in a canvas so they reference a new project id.
   *
   * When a project is re-registered under a different id (e.g. a legacy
   * canvas promoted to a sourcePath project with a new id), every node's
   * `resultUrl` that matches the old id must be rewritten to the new one
   * so the media-file proxy can resolve it. Returns true when any url was
   * actually rewritten; false means the canvas was already up to date.
   * When `sourcePath` is provided the in-memory change is also persisted
   * to disk immediately. */
  async migrateProjectId(canvasId: string, fromId: string, toId: string, sourcePath?: string): Promise<boolean> {
    if (fromId === toId) return false
    const cv = this.canvasOf(canvasId)
    let changed = false
    for (const n of cv.graph.nodes) {
      const url = (n.data as Record<string, unknown>).resultUrl as string | undefined
      if (typeof url !== 'string' || !url.startsWith(`projects/${fromId}/`)) continue
      ;(n.data as Record<string, unknown>).resultUrl = url.replace(
        `projects/${fromId}/`,
        `projects/${toId}/`,
      )
      changed = true
    }
    if (changed) {
      this.logger?.debug?.(`[media-studio] migrateProjectId(${canvasId}): ${fromId} → ${toId}, updated resultUrl on some nodes`)
      // Await persist so the on-disk file stays in sync — callers must
      // await this method to guarantee the migration is durable.
      await this.persist(canvasId, cv, sourcePath)
    }
    return changed
  }

  private async persist(canvasId: string, cv: CanvasState, sourcePath?: string): Promise<void> {
    const dest = this.canvasFilePath(canvasId, sourcePath)
    try {
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, JSON.stringify({ nodes: cv.graph.nodes, edges: cv.graph.edges, regions: cv.graph.regions, version: cv.version }, null, 2), 'utf8')
      // Persist succeeded — clear any previous error so PatchResult stops
      // reporting it.
      this.lastPersistError.delete(canvasId)
    } catch (e) {
      // Persistence failure is non-fatal: in-memory state is still
      // source of truth, the next op retries the write. Log rather than
      // swallow so disk-write errors are visible in diagnostics. Also
      // record the error so PatchResult can surface it to callers.
      const msg = (e as Error).message
      this.logger?.warn?.(`[media-studio] persist failed for canvas "${canvasId}": ${msg}`)
      this.lastPersistError.set(canvasId, msg)
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function cloneGraph(g: CanvasGraph): CanvasGraph {
  return {
    nodes: g.nodes.map((n) => ({ ...n, data: { ...n.data } })),
    edges: g.edges.map((e) => ({ ...e })),
    regions: g.regions.map((r) => ({ ...r })),
  }
}

/** Apply one op to `graph` in place; return an error string or null. */
function applyOp(graph: CanvasGraph, op: CanvasOp): string | null {
  // Guard: op.op is required and must be a known string. Missing or unknown
  // op codes are hard errors — silent no-ops would let malformed patches
  // increment the version while doing nothing, which is exactly the bug
  // that made the canvas appear empty while the tool reported success.
  const rawOp = (op as { op?: unknown }).op
  if (typeof rawOp !== 'string') return `invalid op: missing or non-string "op" field (got ${JSON.stringify(rawOp)})`
  switch (op.op) {
    case 'addNode': {
      if (!NEW_NODE_KINDS.has(op.type)) return `unknown node type "${op.type}" (allowed: ${[...NEW_NODE_KINDS].join(', ')})`
      if (typeof op.label !== 'string' || !op.label.trim()) return 'label is required'
      const id = op.nodeId && typeof op.nodeId === 'string' && op.nodeId.trim() ? op.nodeId.trim() : newId('n')
      if (graph.nodes.some((x) => x.id === id)) return `duplicate node id "${id}"`
      if (op.regionId !== undefined && !graph.regions.some((r) => r.id === op.regionId)) {
        return `addNode: region "${op.regionId}" not found`
      }
      graph.nodes.push({
        id,
        type: op.type,
        label: op.label,
        // Region membership lives on the node's data (`region` key) so
        // region-aware auto-arrange / queries can find members later.
        data: op.regionId ? { ...(op.data ?? {}), region: op.regionId } : (op.data ?? {}),
        ...(op.position ? { position: op.position } : {
          position: op.regionId ? regionSlot(graph, op.regionId) : defaultSlot(graph.nodes),
        }),
      })
      return null
    }
    case 'updateNode': {
      const n = graph.nodes.find((x) => x.id === op.id)
      if (!n) return `node "${op.id}" not found`
      n.data = { ...n.data, ...op.data }
      return null
    }
    case 'renameNode': {
      const n = graph.nodes.find((x) => x.id === op.id)
      if (!n) return `node "${op.id}" not found`
      n.label = op.label
      return null
    }
    case 'deleteNode': {
      const i = graph.nodes.findIndex((x) => x.id === op.id)
      if (i < 0) return `node "${op.id}" not found`
      graph.nodes.splice(i, 1)
      graph.edges = graph.edges.filter((e) => e.source !== op.id && e.target !== op.id)
      return null
    }
    case 'moveNode': {
      const n = graph.nodes.find((x) => x.id === op.id)
      if (!n) return `node "${op.id}" not found`
      n.position = op.position
      return null
    }
    case 'connect': {
      if (!graph.nodes.some((x) => x.id === op.from)) return `connect: source "${op.from}" not found`
      if (!graph.nodes.some((x) => x.id === op.to)) return `connect: target "${op.to}" not found`
      graph.edges.push({
        id: newId('e'),
        source: op.from,
        target: op.to,
        ...(op.branch ? { branch: op.branch } : {}),
        ...(op.label !== undefined ? { label: op.label } : {}),
      })
      return null
    }
    case 'deleteEdge': {
      const i = graph.edges.findIndex((e) => e.id === op.id)
      if (i < 0) return `edge "${op.id}" not found`
      graph.edges.splice(i, 1)
      return null
    }
    case 'addRegion': {
      if (typeof op.label !== 'string' || !op.label.trim()) return 'region label is required'
      const id = op.id && typeof op.id === 'string' && op.id.trim() ? op.id.trim() : newId('r')
      if (graph.regions.some((r) => r.id === id)) return `duplicate region id "${id}"`
      // Auto-stack below the lowest existing region when no position given.
      const bottom = graph.regions.reduce((m, r) => Math.max(m, r.y + r.h), 0)
      graph.regions.push({
        id,
        label: op.label,
        ...(op.kind ? { kind: op.kind } : {}),
        x: op.x ?? SLOT_MARGIN,
        y: op.y ?? (bottom === 0 ? SLOT_MARGIN : bottom + 60),
        w: op.w ?? REGION_W,
        h: op.h ?? REGION_H,
      })
      return null
    }
    case 'updateRegion': {
      const r = graph.regions.find((x) => x.id === op.id)
      if (!r) return `region "${op.id}" not found`
      if (op.label !== undefined) r.label = op.label
      if (op.kind !== undefined) r.kind = op.kind
      if (op.x !== undefined) r.x = op.x
      if (op.y !== undefined) r.y = op.y
      if (op.w !== undefined) r.w = op.w
      if (op.h !== undefined) r.h = op.h
      return null
    }
    case 'deleteRegion': {
      const i = graph.regions.findIndex((r) => r.id === op.id)
      if (i < 0) return `region "${op.id}" not found`
      graph.regions.splice(i, 1)
      return null
    }
    case 'fitRegion': {
      const region = graph.regions.find((x) => x.id === op.id)
      if (!region) return `region "${op.id}" not found`
      const members = graph.nodes.filter((n) => (n.data as Record<string, unknown>).region === op.id)
      if (members.length === 0) return null // empty region — keep as-is
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (const n of members) {
        const p = n.position ?? { x: 0, y: 0 }
        minX = Math.min(minX, p.x)
        minY = Math.min(minY, p.y)
        maxX = Math.max(maxX, p.x + REGION_CARD_W)
        maxY = Math.max(maxY, p.y + regionNodeHeight(n))
      }
      // Tight wrap: header band on top, small padding elsewhere.
      region.x = Math.round(minX - REGION_PAD)
      region.y = Math.round(minY - REGION_HEADER_H)
      region.w = Math.round(maxX - minX + REGION_PAD * 2)
      region.h = Math.round(maxY - minY + REGION_HEADER_H + REGION_PAD)
      return null
    }
    case 'batchAddMedia': {
      // Single-call helper: append one media node per item, optionally
      // connecting to a previous item in the same batch (via `connectTo`
      // index) so the agent can build a linear pipeline in one op.
      for (let i = 0; i < op.items.length; i++) {
        const item = op.items[i]
        const kind = item.kind === 'audio' ? 'music' : item.kind === 'image' ? 'image' : item.kind === 'video' ? 'video' : null
        if (!kind) return `batchAddMedia: unknown kind "${item.kind}"`
        if (typeof item.url !== 'string' || !item.url.trim()) {
          return `batchAddMedia: item ${i} is missing "url" (agent must call generate_image/video/music first and pass the returned url here)`
        }
        const id = item.nodeId ?? newId(kind === 'music' ? 'm' : kind[0])
        if (graph.nodes.some((x) => x.id === id)) return `batchAddMedia: duplicate node id "${id}"`
        if (item.regionId !== undefined && !graph.regions.some((r) => r.id === item.regionId)) {
          return `batchAddMedia: region "${item.regionId}" not found`
        }
        graph.nodes.push({
          id,
          type: kind,
          label: item.prompt ? item.prompt.slice(0, 60) : `${kind} ${id}`,
          data: {
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.model ? { model: item.model } : {}),
            ...(item.regionId ? { region: item.regionId } : {}),
            resultUrl: item.url.trim(),
            status: 'done',
          },
          ...(item.position ? { position: item.position } : {
            position: item.regionId ? regionSlot(graph, item.regionId) : defaultSlot(graph.nodes),
          }),
        })
      }
      return null
    }
  }
}

/** Cheap post-write lint — flags orphan refs, duplicate ids, and dangling
 *  edges. Not a full graph validator; just the rules the agent needs to
 *  understand when a patch was rejected.
 *
 *  Also emits *warnings* (not errors) for Text/Note nodes whose canonical
 *  content field is empty. The graph is still accepted — we don't want to
 *  break the "create empty placeholder then fill later" two-step pattern —
 *  but the issue shows up in the tool response so the agent (and humans
 *  reading the rendered card) can act on it. */
function lintGraph(g: CanvasGraph): string[] {
  const issues: string[] = []
  const ids = new Set<string>()
  for (const n of g.nodes) {
    if (ids.has(n.id)) issues.push(`error: duplicate node id "${n.id}"`)
    ids.add(n.id)
  }
  for (const e of g.edges) {
    if (!ids.has(e.source)) issues.push(`error: edge "${e.id}" source "${e.source}" missing`)
    if (!ids.has(e.target)) issues.push(`error: edge "${e.id}" target "${e.target}" missing`)
  }
  // Self-loop warning (not fatal)
  for (const e of g.edges) {
    if (e.source === e.target) issues.push(`warn: edge "${e.id}" is a self-loop`)
  }
  // Data-content warnings for document-style nodes. Surface the issue
  // without blocking the patch — agents that build placeholders first then
  // updateNode later are still allowed to.
  for (const n of g.nodes) {
    if (n.type === 'text') {
      const t = (n.data as Record<string, unknown>).text
      if (typeof t !== 'string' || t.trim() === '') {
        issues.push(`warn: text node "${n.id}" has empty data.text — agent should follow up with updateNode(id, {text: ...})`)
      }
    } else if (n.type === 'note') {
      const c = (n.data as Record<string, unknown>).content
      if (typeof c !== 'string' || c.trim() === '') {
        issues.push(`warn: note node "${n.id}" has empty data.content — agent should follow up with updateNode(id, {content: ...})`)
      }
    }
  }
  return issues
}

/** Tiny unique id helper. Branded ids are NOT used here — these ids live
 *  only inside the canvas JSON and never cross the LLM wire. */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Auto-placement grid for ops that arrive without a `position` (the agent's
// tools and the canvas UI both send positions only when they care). Nodes are
// placed in a row-major grid (COL_PITCH × ROW_PITCH, starting at MARGIN) that
// skips occupied cells, so agent-driven additions never stack invisibly on
// top of each other at (0,0).
const SLOT_MARGIN = 60
const SLOT_COL = 300
const SLOT_ROW = 300
const SLOT_COLS = 8
const SLOT_CAP = 400

function defaultSlot(nodes: CanvasNode[]): { x: number; y: number } {
  const occupied = nodes.map((n) => n.position ?? { x: 0, y: 0 })
  const overlaps = (x: number, y: number) => occupied.some(
    (p) => Math.abs(p.x - x) < SLOT_COL - 40 && Math.abs(p.y - y) < SLOT_ROW - 90,
  )
  for (let i = 0; i < SLOT_CAP; i++) {
    const col = i % SLOT_COLS
    const row = Math.floor(i / SLOT_COLS)
    const x = SLOT_MARGIN + col * SLOT_COL
    const y = SLOT_MARGIN + row * SLOT_ROW
    if (!overlaps(x, y)) return { x, y }
  }
  // Degenerate fallback — stagger below the lowest node.
  const maxY = occupied.reduce((m, p) => Math.max(m, p.y), SLOT_MARGIN)
  return { x: SLOT_MARGIN, y: maxY + SLOT_ROW }
}

// ── Region-aware auto-placement ───────────────────────────────────────────
// Nodes created with a `regionId` (and no explicit position) land in the
// region's own row-major grid instead of the global defaultSlot. The grid
// is denser than the global one (cards in a region read as a gallery /
// 宫格), starts below the region title bar, and GROWS the region box as
// needed so new members always land INSIDE the box — a region always wraps
// its children (small padding), never lets them spill out.
const REGION_W = 720
const REGION_H = 400
const REGION_PAD = 24
const REGION_HEADER_H = 64
// Gallery pitch: card width 240 + 60px gap = 300; row pitch matches the
// tallest card (240) + 60px gap. This keeps cards breathable instead of
// the old 20px gap that made titles overlap adjacent rows.
const REGION_COL = 300
const REGION_ROW = 300
const REGION_CAP = 240
const REGION_CARD_W = 240
const REGION_CARD_H_MEDIA = 240
const REGION_CARD_H_MUSIC = 135
const REGION_CARD_H_TEXT = 160

/** Estimated rendered height of a node card (used by fitRegion bounding box). */
function regionNodeHeight(n: CanvasNode): number {
  if (n.type === 'music') return REGION_CARD_H_MUSIC
  if (n.type === 'text' || n.type === 'note') {
    const h = (n.data as { height?: unknown }).height
    return typeof h === 'number' && h > 0 ? h : REGION_CARD_H_TEXT
  }
  return REGION_CARD_H_MEDIA
}

function regionSlot(graph: CanvasGraph, regionId: string): { x: number; y: number } {
  const region = graph.regions.find((r) => r.id === regionId)
  if (!region) return defaultSlot(graph.nodes)
  const members = graph.nodes.filter((n) => (n.data as Record<string, unknown>).region === regionId)
  const occupied = members.map((n) => n.position ?? { x: 0, y: 0 })
  const cols = Math.max(1, Math.floor((region.w - REGION_PAD * 2) / REGION_COL))
  const free = (x: number, y: number) => occupied.every(
    (p) => Math.abs(p.x - x) >= REGION_COL - 60 || Math.abs(p.y - y) >= REGION_ROW - 60,
  )
  // Grow the region box so the new slot is always inside it. This keeps the
  // invariant "region wraps all members" without the agent having to manage
  // region geometry manually.
  const grow = (x: number, y: number) => {
    const needW = x + REGION_COL - region.x
    const needH = y + REGION_ROW - region.y
    if (needW > region.w) region.w = needW
    if (needH > region.h) region.h = needH
  }
  for (let i = 0; i < REGION_CAP; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    const x = region.x + REGION_PAD + col * REGION_COL
    const y = region.y + REGION_HEADER_H + REGION_PAD + row * REGION_ROW
    if (free(x, y)) {
      grow(x, y)
      return { x, y }
    }
  }
  // Degenerate fallback — grow + stagger below the region's lowest member.
  const maxY = occupied.reduce((m, p) => Math.max(m, p.y), region.y + REGION_HEADER_H)
  const fx = region.x + REGION_PAD
  const fy = maxY + REGION_ROW
  grow(fx, fy)
  return { x: fx, y: fy }
}
