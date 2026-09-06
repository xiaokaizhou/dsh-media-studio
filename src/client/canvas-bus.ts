// Unified SSE bus — ONE EventSource for both canvas patches AND project
// registry events.
//
// Why: the client used to open two long-lived sockets (/canvas/sse and
// /projects/sse). Together with DSH core's own 3-4 SSE streams that hit the
// HTTP/1.1 six-connection-per-host ceiling, every short REST call (rename,
// delete, status polling) was queued behind the SSE sockets and never got a
// connection — dialog buttons stuck in "处理中…" and the modal backdrop never
// went away. Sharing one socket frees a connection for short-lived calls.
//
// Consumers:
//   • CanvasView (canvas.tsx)  — full graph snapshots
//   • LiveBadge  (project-bar) — version/count summary + conn state
//   • ProjectApp (project-bar) — registry snapshots + project-open events
//
// The first subscriber opens the EventSource; the last one to unsubscribe
// closes it. CanvasId is part of the connection URL; switching projects
// tears down the old socket and opens a new one.
//
// Optimisations (2026-09):
//   • Page-hidden pause: when the tab is backgrounded, the SSE socket is
//     closed to free a connection; it reopens on visibilitychange→visible.
//   • Reconnect resync: after an EventSource error→reopen cycle, we actively
//     fetch the latest canvas snapshot + registry so events missed during the
//     gap don't leave the UI stale.
//   • Registry debounce: rapid registry-changed bursts (e.g. during project
//     creation) are coalesced to a 150 ms trailing edge, avoiding React
//     re-render storms.

import type { MsSnapshot } from './canvas-api'
import type { RegistryAPI } from './projects-api'

type FullListener = (snap: MsSnapshot) => void
type SummaryListener = (info: { version: number; count: number }) => void
type ConnListener = (conn: 'connecting' | 'open' | 'reconnecting') => void
type RegistryListener = (reg: RegistryAPI) => void
type ProjectOpenListener = (projectId: string, name?: string) => void
type ProjectFocusedListener = (projectId: string, name?: string, source?: 'create' | 'open') => void

const REGISTRY_DEBOUNCE_MS = 150

interface BusState {
  full: Set<FullListener>
  summary: Set<SummaryListener>
  conn: Set<ConnListener>
  registry: Set<RegistryListener>
  projectOpen: Set<ProjectOpenListener>
  projectFocused: Set<ProjectFocusedListener>
  es: EventSource | null
  canvasId: string | null
  last: {
    snap: MsSnapshot | null
    conn: 'connecting' | 'open' | 'reconnecting'
    registry: RegistryAPI | null
  }
  // Page-hidden pause support.
  paused: boolean
  visibilityHandler: (() => void) | null
  // Registry debounce.
  registryTimer: ReturnType<typeof setTimeout> | null
  pendingRegistry: RegistryAPI | null
  // Reconnect resync guard.
  resyncTimer: ReturnType<typeof setTimeout> | null
  // Canvas-switch guard: after a canvasId change (e.g. project deletion
  // auto-switches activeId), the SSE initial snapshot may race with
  // server-side canvas loading and deliver an empty v0 graph. While this
  // flag is set, v0 snapshots are ignored until the active fetch resolves.
  switchPending: boolean
}

const state: BusState = {
  full: new Set(),
  summary: new Set(),
  conn: new Set(),
  registry: new Set(),
  projectOpen: new Set(),
  projectFocused: new Set(),
  es: null,
  canvasId: null,
  last: { snap: null, conn: 'connecting', registry: null },
  paused: false,
  visibilityHandler: null,
  registryTimer: null,
  pendingRegistry: null,
  resyncTimer: null,
  switchPending: false,
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

function emitRegistry(reg: RegistryAPI) {
  state.last.registry = reg
  for (const fn of state.registry) fn(reg)
}

/** Debounced registry emit — coalesces rapid bursts to trailing edge. */
function scheduleRegistry(reg: RegistryAPI) {
  state.pendingRegistry = reg
  if (state.registryTimer) clearTimeout(state.registryTimer)
  state.registryTimer = setTimeout(() => {
    state.registryTimer = null
    const pending = state.pendingRegistry
    state.pendingRegistry = null
    if (pending) emitRegistry(pending)
  }, REGISTRY_DEBOUNCE_MS)
}

function hasSubscribers(): boolean {
  return (
    state.full.size > 0 ||
    state.summary.size > 0 ||
    state.conn.size > 0 ||
    state.registry.size > 0 ||
    state.projectOpen.size > 0 ||
    state.projectFocused.size > 0
  )
}

/** Actively fetch the latest canvas snapshot + registry after reconnect. */
function resyncAfterReconnect(canvasId: string) {
  if (state.resyncTimer) clearTimeout(state.resyncTimer)
  // Small delay so we don't race the SSE initial snapshot that the server
  // sends on connect.
  state.resyncTimer = setTimeout(() => {
    state.resyncTimer = null
    // Canvas snapshot.
    fetch(`/api/media-studio/canvas/state?canvasId=${encodeURIComponent(canvasId)}`)
      .then(r => r.json())
      .then((data: { graph?: MsSnapshot['graph']; version?: number }) => {
        if (data?.graph) {
          const snap: MsSnapshot = { graph: data.graph, version: data.version ?? 0 }
          if (!state.last.snap || state.last.snap.version < snap.version) {
            state.last.snap = snap
            emitSummary(snap)
            for (const fn of state.full) fn(snap)
          }
        }
      })
      .catch(() => { /* SSE will deliver the next event anyway */ })
    // Registry snapshot.
    fetch('/api/media-studio/projects')
      .then(r => r.json())
      .then((reg: RegistryAPI) => scheduleRegistry(reg))
      .catch(() => { /* ignore */ })
  }, 300)
}

function ensureConnection(canvasId: string) {
  if (state.paused) return // Page is hidden — don't open until visible again.
  if (state.es && state.canvasId === canvasId) return
  // Different canvas — tear down the old connection.
  if (state.es) {
    try { state.es.close() } catch { /* ignore */ }
    state.es = null
    state.canvasId = null
    // Intentionally do NOT clear last.snap here: keeping the old graph
    // visible avoids a blank-canvas flash while the new socket's initial
    // snapshot is in flight. The switchPending flag below prevents a
    // raced v0 empty snapshot from overwriting it.
    state.last.conn = 'connecting'
    state.switchPending = true
    emitConn('connecting')
  }
  state.canvasId = canvasId
  let es: EventSource
  try {
    // Unified endpoint: carries canvas-patch AND registry-changed events.
    es = new EventSource(`/api/media-studio/sse?canvasId=${encodeURIComponent(canvasId)}`)
  } catch {
    emitConn('reconnecting')
    return
  }
  state.es = es
  es.addEventListener('open', () => emitConn('open'))
  es.addEventListener('error', () => {
    emitConn('reconnecting')
    // EventSource auto-reconnects; when it comes back, resync to cover the
    // events we missed while the socket was down.
    resyncAfterReconnect(canvasId)
  })

  es.addEventListener('canvas-patch', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { type?: string; graph?: MsSnapshot['graph']; version?: number }
      if (data?.type !== 'canvas-patch' || !data.graph) return
      const snap: MsSnapshot = { graph: data.graph, version: data.version ?? 0 }
      // While switchPending is set, the SSE initial snapshot may race with
      // server-side canvas loading and deliver an empty v0 graph. Ignore it
      // — the active fetch in subscribeFull will deliver the real state.
      if (state.switchPending && snap.version === 0) return
      state.switchPending = false
      // Cheap dedupe: same version → nothing to do (echoes from the host
      // often carry the version we already applied).
      if (state.last.snap && state.last.snap.version === snap.version) return
      state.last.snap = snap
      emitConn('open')
      emitSummary(snap)
      for (const fn of state.full) fn(snap)
    } catch { /* malformed payload — drop */ }
  })

  es.addEventListener('registry-changed', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { registry?: RegistryAPI }
      if (data?.registry) scheduleRegistry(data.registry)
    } catch { /* ignore */ }
  })

  es.addEventListener('project-open', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { projectId?: string; name?: string }
      if (data?.projectId) {
        for (const fn of state.projectOpen) fn(data.projectId, data.name)
      }
    } catch { /* ignore */ }
  })

  es.addEventListener('project-focused', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { projectId?: string; name?: string; source?: 'create' | 'open' }
      if (data?.projectId) {
        for (const fn of state.projectFocused) fn(data.projectId, data.name, data.source)
      }
    } catch { /* ignore */ }
  })

  es.addEventListener('project-deleted', () => {
    // Registry-changed usually follows with the updated registry; nothing
    // extra to do here, but the listener exists so future consumers can
    // react to deletion specifically.
  })
}

function closeConnection() {
  if (state.es) {
    try { state.es.close() } catch { /* ignore */ }
    state.es = null
  }
  state.canvasId = null
  state.last.snap = null
  state.last.registry = null
  state.last.conn = 'connecting'
  state.switchPending = false
  if (state.resyncTimer) { clearTimeout(state.resyncTimer); state.resyncTimer = null }
}

function disconnectIfIdle() {
  if (!hasSubscribers()) {
    closeConnection()
    detachVisibilityHandler()
  }
}

/**
 * Page-visibility pause: when the tab goes hidden, close the SSE socket to
 * free an HTTP/1.1 connection for short requests; reopen when visible again.
 * Attached lazily on first subscriber, detached when the last subscriber
 * leaves.
 */
function attachVisibilityHandler() {
  if (state.visibilityHandler) return
  const handler = () => {
    if (document.hidden) {
      if (state.es) {
        state.paused = true
        closeConnection()
        emitConn('connecting')
      }
    } else if (state.paused) {
      state.paused = false
      if (state.canvasId && hasSubscribers()) {
        ensureConnection(state.canvasId)
      }
    }
  }
  state.visibilityHandler = handler
  document.addEventListener('visibilitychange', handler)
}

function detachVisibilityHandler() {
  if (state.visibilityHandler) {
    document.removeEventListener('visibilitychange', state.visibilityHandler)
    state.visibilityHandler = null
  }
  state.paused = false
}

/**
 * Actively fetch the latest canvas snapshot. Used after a canvasId switch
 * (e.g. project deletion auto-switches activeId) because the SSE initial
 * snapshot may fire before the server finishes loading the new project's
 * canvas from disk — delivering an empty graph that then sticks until the
 * next patch. A fetch guarantees we get the fully-loaded state.
 */
function fetchCanvasSnapshot(canvasId: string) {
  fetch(`/api/media-studio/canvas/state?canvasId=${encodeURIComponent(canvasId)}`)
    .then(r => r.json())
    .then((data: { graph?: MsSnapshot['graph']; version?: number }) => {
      if (!data?.graph) return
      const snap: MsSnapshot = { graph: data.graph, version: data.version ?? 0 }
      // Fetch is authoritative after a switch — clear the pending flag and
      // apply regardless of version (the new canvas may have a lower version
      // than the old one we were displaying).
      state.switchPending = false
      state.last.snap = snap
      emitSummary(snap)
      for (const fn of state.full) fn(snap)
    })
    .catch(() => {
      // Fetch failed — clear the flag so subsequent SSE events can apply.
      state.switchPending = false
    })
}

/** Subscribe to the full snapshot stream (canvas.tsx path). */
export function subscribeFull(canvasId: string, fn: FullListener): () => void {
  // True only when switching FROM an existing different canvas (not first connect).
  const isSwitch = state.canvasId !== null && state.canvasId !== canvasId
  state.full.add(fn)
  attachVisibilityHandler()
  ensureConnection(canvasId)
  // Replay last snap so a late subscriber (e.g. tab remount) doesn't sit
  // at "connecting" forever.
  if (state.last.snap && state.canvasId === canvasId) {
    fn(state.last.snap)
  } else if (isSwitch) {
    // Canvas just switched (e.g. after project deletion). The SSE initial
    // snapshot may race with server-side canvas loading and deliver an empty
    // graph — actively fetch to get the fully-loaded state.
    fetchCanvasSnapshot(canvasId)
  }
  return () => {
    state.full.delete(fn)
    disconnectIfIdle()
  }
}

/** Subscribe to a summary stream (version + count only — LiveBadge path). */
export function subscribeSummary(canvasId: string, fn: SummaryListener): () => void {
  state.summary.add(fn)
  attachVisibilityHandler()
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
  attachVisibilityHandler()
  ensureConnection(canvasId)
  fn(state.last.conn)
  return () => {
    state.conn.delete(fn)
    disconnectIfIdle()
  }
}

/** Subscribe to project-registry snapshots (project-bar path). */
export function subscribeRegistry(fn: RegistryListener): () => void {
  state.registry.add(fn)
  attachVisibilityHandler()
  // Need a canvasId to open the connection; use the active one if known,
  // otherwise defer until the first canvas subscriber opens it.
  if (state.canvasId) ensureConnection(state.canvasId)
  if (state.last.registry) fn(state.last.registry)
  return () => {
    state.registry.delete(fn)
    disconnectIfIdle()
  }
}

/** Subscribe to project-open events (project-bar path — switch active tab). */
export function subscribeProjectOpen(fn: ProjectOpenListener): () => void {
  state.projectOpen.add(fn)
  attachVisibilityHandler()
  if (state.canvasId) ensureConnection(state.canvasId)
  return () => {
    state.projectOpen.delete(fn)
    disconnectIfIdle()
  }
}

/**
 * Subscribe to project-focused events (sidebar-focus-listener path — auto
 * activate the Media Studio sidebar tab when an LLM creates/opens a project).
 */
export function subscribeProjectFocused(fn: ProjectFocusedListener): () => void {
  state.projectFocused.add(fn)
  attachVisibilityHandler()
  if (state.canvasId) ensureConnection(state.canvasId)
  return () => {
    state.projectFocused.delete(fn)
    disconnectIfIdle()
  }
}
