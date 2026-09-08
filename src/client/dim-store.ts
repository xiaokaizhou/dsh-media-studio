// Upstream/downstream chain highlight — view-only dim state.
//
// When the user selects node(s), the canvas computes the *related* set
// (selected ∪ upstream closure ∪ downstream closure, unioned for a
// multi-selection) and publishes it to this module-level store. Node cards
// and edge views each subscribe a single *boolean* snapshot through
// useSyncExternalStore, so a selection toggle only re-renders the elements
// whose relatedness actually flipped — the rest of the canvas stays
// untouched, and pan/zoom (which must stay at zero React work per frame,
// see the connMaps discipline in canvas.tsx) is completely unaffected.
//
// The dim state is deliberately kept OUT of node.data, host patches and the
// undo history: it is pure view state. The server never sees it, SSE
// snapshots (which reconcile node content) can neither wipe nor leak it,
// and undo/redo ref churn is harmless because every lookup is id-keyed.

import { useCallback, useSyncExternalStore } from 'react'

// ── Pure graph helpers (exported for unit tests) ──────────────────────────

export interface Adjacency {
  /** outgoing: source → direct targets */
  out: Map<string, string[]>
  /** incoming: target → direct sources */
  in: Map<string, string[]>
}

export function buildAdjacency(edges: Array<{ source: string; target: string }>): Adjacency {
  const out = new Map<string, string[]>()
  const inn = new Map<string, string[]>()
  for (const e of edges) {
    let a = out.get(e.source)
    if (!a) out.set(e.source, (a = []))
    a.push(e.target)
    let b = inn.get(e.target)
    if (!b) inn.set(e.target, (b = []))
    b.push(e.source)
  }
  return { out, in: inn }
}

/**
 * related = selected ∪ downstream(selected) ∪ upstream(selected).
 * O(V+E); visited sets make it cycle-safe.
 *
 * Deliberate semantic: sibling branches stay UNRELATED. If U→D and S→D
 * (D is downstream of S), U is an ancestor of D, not of S — U is not in
 * up(S) so it (and the U→D edge) gets dimmed. The edge rule
 * "related(source) && related(target)" is therefore exactly
 * "the edge lies on an upstream or downstream chain of the selection".
 */
export function computeRelated(adj: Adjacency, selected: Iterable<string>): Set<string> {
  const sel = [...selected]
  const related = new Set<string>(sel)
  if (sel.length === 0) return related
  // Downstream closure (index-pointer BFS — no O(n) array shifts).
  const seenDown = new Set<string>(sel)
  let queue = [...sel]
  let i = 0
  while (i < queue.length) {
    const id = queue[i++]
    for (const nxt of adj.out.get(id) ?? []) {
      if (seenDown.has(nxt)) continue
      seenDown.add(nxt)
      related.add(nxt)
      queue.push(nxt)
    }
  }
  // Upstream closure.
  const seenUp = new Set<string>(sel)
  queue = [...sel]
  i = 0
  while (i < queue.length) {
    const id = queue[i++]
    for (const prev of adj.in.get(id) ?? []) {
      if (seenUp.has(prev)) continue
      seenUp.add(prev)
      related.add(prev)
      queue.push(prev)
    }
  }
  return related
}

// ── External store (one dim set per canvas, so two open tabs can't fight) ─

const dimSets = new Map<string, Set<string>>()
const listeners = new Map<string, Set<() => void>>()

/** Publish the related set for `canvasId` (null clears the dim state).
 *  No-op when the same Set reference is re-published. */
export function setDimSet(canvasId: string, next: Set<string> | null): void {
  const cur = dimSets.get(canvasId)
  if (cur === next) return
  if (next === null) dimSets.delete(canvasId)
  else dimSets.set(canvasId, next)
  listeners.get(canvasId)?.forEach((l) => l())
}

/** The currently published related set (null = no active dim state). */
export function getDimSet(canvasId: string): Set<string> | null {
  return dimSets.get(canvasId) ?? null
}

function dimSubscribe(canvasId: string, cb: () => void): () => void {
  let ls = listeners.get(canvasId)
  if (!ls) listeners.set(canvasId, (ls = new Set()))
  ls.add(cb)
  return () => {
    ls.delete(cb)
  }
}

/** true when the canvas has an active selection AND this node is NOT in the
 *  related set (i.e. the card should render dimmed).
 *
 * The snapshot getter returns a plain boolean: Object.is-stable across calls,
 * O(1) per subscriber, so a dispatch only re-renders the flipped elements. */
export function useNodeDimmed(canvasId: string, nodeId: string): boolean {
  const subscribe = useCallback((cb: () => void) => dimSubscribe(canvasId, cb), [canvasId])
  return useSyncExternalStore(subscribe, () => {
    const s = dimSets.get(canvasId)
    return s !== undefined && !s.has(nodeId)
  })
}

/** true when the canvas has an active selection AND at least one endpoint of
 *  this edge (source→target) is outside the related set. */
export function useEdgeDimmed(canvasId: string, source: string, target: string): boolean {
  const subscribe = useCallback((cb: () => void) => dimSubscribe(canvasId, cb), [canvasId])
  return useSyncExternalStore(subscribe, () => {
    const s = dimSets.get(canvasId)
    if (s === undefined) return false
    return !(s.has(source) && s.has(target))
  })
}
