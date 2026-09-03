// Shared canvas-state bus for cross-component canvas metadata.
//
// Two sibling components used to each open their own EventSource against
// `/api/media-studio/canvas/sse` for the same canvasId:
//
//   • `CanvasView` (canvas.tsx) — needs the full graph to reconcile nodes
//     and edges from server patches.
//   • `LiveBadge`  (project-bar.tsx) — only needs version + node count to
//     light up the top-bar status pill.
//
// Two concurrent SSE connections against the same endpoint were doubling
// the server-side fan-out per canvas and the browser-side JSON parsing /
// setState churn per patch — and just *opening* a fresh canvas tab
// opened both connections, which was a measurable source of UI jank
// even with an empty canvas (no nodes, no edges).
//
// We funnel both consumers through a single module-level connection: the
// first subscriber opens the EventSource, the rest just listen. The full
// snapshot is forwarded to the listener registered by CanvasView; the
// version/count summary is broadcast to badge listeners too. The
// connection closes when the last subscriber unsubscribes.

import type { MsSnapshot } from './canvas-api'

type FullListener = (snap: MsSnapshot) => void
type SummaryListener = (info: { version: number; count: number }) => void
type ConnListener = (conn: 'connecting' | 'open' | 'reconnecting') => void

interface BusState {
  full: Set<FullListener>
  summary: Set<SummaryListener>
  conn: Set<ConnListener>
  es: EventSource | null
  canvasId: string | null
  last: { snap: MsSnapshot | null; conn: 'connecting' | 'open' | 'reconnecting' }
}

const state: BusState = {
  full: new Set(),
  summary: new Set(),
  conn: new Set(),
  es: null,
  canvasId: null,
  last: { snap: null, conn: 'connecting' },
}

function emitConn(s: 'connecting' | 'open' | 'reconnecting') {
  if (state.last.conn === s) return
  state.last.conn = s
  for (const fn of state.conn) fn(s)
}

function emitSummary(snap: MsSnapshot) {
  const info = { version: snap.version, count: snap.graph.nodes.length }
  for (const fn of state.summary) fn(info)
}

function ensureConnection(canvasId: string) {
  if (state.es && state.canvasId === canvasId) return
  // Different canvas — tear down the old connection.
  if (state.es) {
    try { state.es.close() } catch { /* ignore */ }
    state.es = null
    state.canvasId = null
    state.last.snap = null
    state.last.conn = 'connecting'
    emitConn('connecting')
  }
  state.canvasId = canvasId
  let es: EventSource
  try {
    es = new EventSource(`/api/media-studio/canvas/sse?canvasId=${encodeURIComponent(canvasId)}`)
  } catch {
    emitConn('reconnecting')
    return
  }
  state.es = es
  es.addEventListener('open', () => emitConn('open'))
  es.addEventListener('error', () => emitConn('reconnecting'))
  es.addEventListener('canvas-patch', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { type?: string; graph?: MsSnapshot['graph']; version?: number }
      if (data?.type !== 'canvas-patch' || !data.graph) return
      const snap: MsSnapshot = { graph: data.graph, version: data.version ?? 0 }
      // Cheap dedupe: same version → nothing to do (echoes from the host
      // often carry the version we already applied).
      if (state.last.snap && state.last.snap.version === snap.version) return
      state.last.snap = snap
      emitConn('open')
      emitSummary(snap)
      for (const fn of state.full) fn(snap)
    } catch { /* malformed payload — drop */ }
  })
}

function disconnectIfIdle() {
  if (state.full.size === 0 && state.summary.size === 0 && state.conn.size === 0) {
    if (state.es) {
      try { state.es.close() } catch { /* ignore */ }
      state.es = null
      state.canvasId = null
      state.last.snap = null
      state.last.conn = 'connecting'
    }
  }
}

/** Subscribe to the full snapshot stream (canvas.tsx path). */
export function subscribeFull(canvasId: string, fn: FullListener): () => void {
  state.full.add(fn)
  ensureConnection(canvasId)
  // Replay last snap so a late subscriber (e.g. tab remount) doesn't sit
  // at "connecting" forever.
  if (state.last.snap && state.canvasId === canvasId) fn(state.last.snap)
  return () => {
    state.full.delete(fn)
    disconnectIfIdle()
  }
}

/** Subscribe to a summary stream (version + count only — LiveBadge path). */
export function subscribeSummary(canvasId: string, fn: SummaryListener): () => void {
  state.summary.add(fn)
  ensureConnection(canvasId)
  if (state.last.snap && state.canvasId === canvasId) {
    fn({ version: state.last.snap.version, count: state.last.snap.graph.nodes.length })
  }
  return () => {
    state.summary.delete(fn)
    disconnectIfIdle()
  }
}

/** Subscribe to connection state changes (open / reconnecting / connecting). */
export function subscribeConn(canvasId: string, fn: ConnListener): () => void {
  state.conn.add(fn)
  ensureConnection(canvasId)
  fn(state.last.conn)
  return () => {
    state.conn.delete(fn)
    disconnectIfIdle()
  }
}