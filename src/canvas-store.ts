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
}

export interface CanvasGraph {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
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
  | { op: 'connect'; from: string; to: string; branch?: 'true' | 'false' }
  | { op: 'deleteEdge'; id: string }
  | {
    op: 'batchAddMedia'
    items: Array<{
      kind: 'image' | 'video' | 'audio'
      url: string
      prompt?: string
      model?: string
      /** Position hint for the new node (UI may snap-to-grid). */
      position?: { x: number; y: number }
      /** Optional explicit id; if absent we generate one. */
      nodeId?: string
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

  constructor(workspaceRoot: string, opts?: { broadcast?: CanvasBroadcast }) {
    this.workspaceRoot = workspaceRoot
    this.broadcast = opts?.broadcast
  }

  /** Resolve one canvas (lazily created if absent). Key includes the workspace
   *  root so two profiles pointing at the same canvasId never collide. */
  canvasOf(canvasId: string): CanvasState {
    const key = `${this.workspaceRoot}\0${canvasId}`
    let cv = this.canvases.get(key)
    if (!cv) {
      cv = { graph: { nodes: [], edges: [] }, version: 0, boundSessions: new Set() }
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
    // Persist on the same thread so a frontend crash before SSE delivery
    // does not roll the canvas back.
    void this.persist(canvasId, cv)

    // Push the new graph to every connected SSE client (the canvas tab
    // subscribes here). Centralized in `apply` so the agent's
    // `canvas_graph_patch` tool AND the client's REST PATCH endpoint both
    // broadcast through the same path — no drift between the two callers.
    this.broadcast?.(canvasId, { version: cv.version, graph: next, patch: ops })

    return { graph: next, patch: ops, version: cv.version, lintOk, issues }
  }

  /**
   * Auto-arrange nodes by topological depth (same algorithm as the client
   * view-bar wand). Columns are ordered by BFS depth from sources; within
   * each column nodes stack vertically. Uses a default card height of 200
   * px so the server-side result is close to what the client would produce.
   */
  autoArrange(canvasId: string): PatchResult {
    const cv = this.canvasOf(canvasId)
    const g = cv.graph
    if (g.nodes.length === 0) return { graph: cloneGraph(g), patch: [], version: cv.version, lintOk: true, issues: [] }

    // Build adjacency maps.
    const inMap = new Map<string, string[]>()
    const outMap = new Map<string, string[]>()
    for (const e of g.edges) {
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
    for (const n of g.nodes) {
      if (!inMap.get(n.id)?.length) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
    }
    while (queue.length) {
      const { id, d } = queue.shift()!
      for (const t of outMap.get(id) ?? []) {
        if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
      }
    }
    for (const n of g.nodes) if (!depth.has(n.id)) depth.set(n.id, 0)

    // Group ids by depth.
    const byDepth = new Map<number, string[]>()
    for (const n of g.nodes) {
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
    for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      let y = marginY
      for (const id of ids) {
        moves.push({ op: 'moveNode', id, position: { x: marginX + d * colPitch, y } })
        y += defaultH + rowGap
      }
    }

    // Apply atomically — reuse the same store path so SSE fires.
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
    if (existed) this.broadcast?.(canvasId, { version: 0, graph: { nodes: [], edges: [] }, patch: [] })
  }

  /** Absolute path of the persisted file for a canvas id (for move/remove). */
  canvasFilePath(canvasId: string): string {
    return join(this.workspaceRoot, 'canvases', `${canvasId}.json`)
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
   */
  async restore(): Promise<void> {
    const dir = join(this.workspaceRoot, 'canvases')
    let entries: string[] = []
    try {
      const fs = await import('node:fs/promises')
      entries = await fs.readdir(dir)
    } catch { return /* dir absent on first run */ }
    for (const file of entries) {
      if (!file.endsWith('.json')) continue
      try {
        const raw = JSON.parse(await readFile(join(dir, file), 'utf8'))
        const canvasId = file.slice(0, -'.json'.length)
        const cv = this.canvasOf(canvasId)
        const diskVersion = typeof raw.version === 'number' ? raw.version : 0
        // Only reload when disk is ahead — prevents restoring stale data
        // over a more recent in-memory state.
        if (diskVersion > cv.version) {
          cv.graph = { nodes: raw.nodes ?? [], edges: raw.edges ?? [] }
          cv.version = diskVersion
        }
      } catch { /* corrupt file — leave the current in-memory canvas */ }
    }
  }

  private async persist(canvasId: string, cv: CanvasState): Promise<void> {
    const dir = join(this.workspaceRoot, 'canvases')
    const dest = join(dir, `${canvasId}.json`)
    try {
      await mkdir(dir, { recursive: true })
      await writeFile(dest, JSON.stringify({ nodes: cv.graph.nodes, edges: cv.graph.edges, version: cv.version }, null, 2), 'utf8')
    } catch (e) {
      // Persistence failure is non-fatal: in-memory state is still
      // source of truth, the next op retries the write. Log rather than
      // swallow so disk-write errors are visible in diagnostics.
      console.warn(`[media-studio] persist failed for canvas "${canvasId}": ${(e as Error).message}`)
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function cloneGraph(g: CanvasGraph): CanvasGraph {
  return {
    nodes: g.nodes.map((n) => ({ ...n, data: { ...n.data } })),
    edges: g.edges.map((e) => ({ ...e })),
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
      graph.nodes.push({
        id,
        type: op.type,
        label: op.label,
        data: op.data ?? {},
        ...(op.position ? { position: op.position } : { position: defaultSlot(graph.nodes) }),
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
      graph.edges.push({ id: newId('e'), source: op.from, target: op.to, ...(op.branch ? { branch: op.branch } : {}) })
      return null
    }
    case 'deleteEdge': {
      const i = graph.edges.findIndex((e) => e.id === op.id)
      if (i < 0) return `edge "${op.id}" not found`
      graph.edges.splice(i, 1)
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
        const id = item.nodeId ?? newId(kind === 'music' ? 'm' : kind[0])
        if (graph.nodes.some((x) => x.id === id)) return `batchAddMedia: duplicate node id "${id}"`
        graph.nodes.push({
          id,
          type: kind,
          label: item.prompt ? item.prompt.slice(0, 60) : `${kind} ${id}`,
          data: {
            ...(item.prompt ? { prompt: item.prompt } : {}),
            ...(item.model ? { model: item.model } : {}),
            resultUrl: item.url,
            status: 'done',
          },
          ...(item.position ? { position: item.position } : { position: defaultSlot(graph.nodes) }),
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
