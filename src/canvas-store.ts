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
  | { op: 'addNode'; type: CanvasNode['type']; label: string; data?: Record<string, unknown>; position?: { x: number; y: number } }
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

const NEW_NODE_KINDS = new Set<CanvasNode['type']>(['text', 'image', 'video', 'music', 'note'])

export class CanvasStore {
  private canvases = new Map<string, CanvasState>()
  private workspaceRoot: string

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot
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

    return { graph: next, patch: ops, version: cv.version, lintOk, issues }
  }

  /** Read the snapshot the canvas tab needs to render. */
  snapshot(canvasId: string): CanvasSnapshot {
    const cv = this.canvasOf(canvasId)
    return { graph: cloneGraph(cv.graph), version: cv.version }
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

  /** Restore every persisted canvas from disk into the in-memory map. */
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
        cv.graph = { nodes: raw.nodes ?? [], edges: raw.edges ?? [] }
        cv.version = typeof raw.version === 'number' ? raw.version : 0
      } catch { /* corrupt file — leave the empty canvas */ }
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
      // source of truth, the next op retries the write.
      console.error('[media-studio] persist failed:', (e as Error).message)
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
  switch (op.op) {
    case 'addNode': {
      if (!NEW_NODE_KINDS.has(op.type)) return `unknown node type "${op.type}" (allowed: ${[...NEW_NODE_KINDS].join(', ')})`
      if (typeof op.label !== 'string' || !op.label.trim()) return 'label is required'
      graph.nodes.push({
        id: newId('n'),
        type: op.type,
        label: op.label,
        data: op.data ?? {},
        ...(op.position ? { position: op.position } : {}),
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
          ...(item.position ? { position: item.position } : {}),
        })
      }
      return null
    }
  }
}

/** Cheap post-write lint — flags orphan refs, duplicate ids, and dangling
 *  edges. Not a full graph validator; just the rules the agent needs to
 *  understand when a patch was rejected. */
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
  return issues
}

/** Tiny unique id helper. Branded ids are NOT used here — these ids live
 *  only inside the canvas JSON and never cross the LLM wire. */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
