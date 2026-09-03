// Client-side revision history bus (M3b).
//
// The canvas view records every accepted server snapshot (version + graph)
// into this module, keyed by canvas id. The top-bar version badge reads the
// bus to render the "history versions" dropdown with play / pause / progress
// scrubbing. Playback is client-side *preview only* — no writes hit the
// server; leaving the preview returns to the live (latest) snapshot.

import type { MsSnapshot } from './canvas-api'

export interface RevEntry {
  version: number
  at: number
  snap: MsSnapshot
}

type Controller = (snap: MsSnapshot | null) => void
type Listener = () => void

const revisions = new Map<string, RevEntry[]>()
const controllers = new Map<string, Controller>()
const listeners = new Map<string, Set<Listener>>()

const MAX_REVS = 200

function notify(canvasId: string): void {
  const set = listeners.get(canvasId)
  if (set) for (const fn of [...set]) fn()
}

/** Record one accepted snapshot for a canvas (dedup by version). The caller
 *  passes a freshly built snapshot that is never mutated afterwards — we
 *  store the reference as-is; deep-cloning the whole graph on every version
 *  was a measurable jank source on large canvases. */
export function recordRevision(canvasId: string, snap: MsSnapshot): void {
  const list = revisions.get(canvasId) ?? []
  const prev = list[list.length - 1]
  if (prev && prev.version === snap.version) return
  list.push({ version: snap.version, at: Date.now(), snap })
  if (list.length > MAX_REVS) list.splice(0, list.length - MAX_REVS)
  revisions.set(canvasId, list)
  notify(canvasId)
}

/** Drop recorded revisions for a canvas (project switch / remount). */
export function resetRevisions(canvasId: string): void {
  revisions.delete(canvasId)
}

/** Latest recorded snapshot for a canvas (null when none yet). */
export function latestRevision(canvasId: string): RevEntry | null {
  const list = revisions.get(canvasId)
  return list && list.length > 0 ? list[list.length - 1] : null
}

export function getRevisions(canvasId: string): RevEntry[] {
  return [...(revisions.get(canvasId) ?? [])]
}

/**
 * The canvas view registers a controller so the badge can preview an
 * arbitrary revision (apply local content + suppress live SSE echo) or exit
 * back to live by calling it with null.
 */
export function setController(canvasId: string, ctrl: Controller | null): void {
  if (ctrl) controllers.set(canvasId, ctrl)
  else controllers.delete(canvasId)
}

/** Preview a revision on the canvas (no-op if no controller is installed). */
export function previewRevision(canvasId: string, entry: RevEntry | null): void {
  controllers.get(canvasId)?.(entry ? cloneSnap(entry.snap) : null)
}

export function subscribeRevisions(canvasId: string, fn: Listener): () => void {
  let set = listeners.get(canvasId)
  if (!set) {
    set = new Set()
    listeners.set(canvasId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(canvasId)
  }
}

export function cloneSnap(snap: MsSnapshot): MsSnapshot {
  return JSON.parse(JSON.stringify(snap)) as MsSnapshot
}
