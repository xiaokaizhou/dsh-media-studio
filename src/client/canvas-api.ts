// Shared client-side types + the React context the node components and the
// canvas view use to talk back to the host canvas store.
//
// The canvas is server-authoritative: every UI mutation funnels through
// `postOps`, which POSTs a batch of `CanvasOp`s to
// `/api/media-studio/canvas/patch`. The host applies + persists + SSE-broadcasts;
// the tab reconciles its local React Flow state from the stream.
//
// We deliberately re-declare the op union here (mirroring the host's
// CanvasOp) instead of importing the server module — the client bundle runs
// in the browser and must not pull in node:fs etc.

import { createContext, useContext, type CSSProperties } from 'react'

export type NodeKind = 'text' | 'image' | 'video' | 'music' | 'note'
export type MsStatus = 'idle' | 'running' | 'done' | 'error'

/** Data payload stored on each canvas node (server `data` field). */
export interface MsData extends Record<string, unknown> {
  kind?: NodeKind
  label?: string
  prompt?: string
  model?: string
  resultUrl?: string
  status?: MsStatus
  errorMsg?: string
  text?: string
  content?: string
  /** Persisted card height (px, flow units) for text/note nodes after the
   *  user drags the bottom-right resize grip. */
  height?: number
}

export type MsOp =
  | {
    op: 'addNode'
    type: NodeKind
    label: string
    data?: Record<string, unknown>
    position?: { x: number; y: number }
    /** Region to auto-place into when `position` is omitted (membership
     *  recorded as data.region). */
    regionId?: string
    nodeId?: string
  }
  | { op: 'updateNode'; id: string; data: Record<string, unknown> }
  | { op: 'renameNode'; id: string; label: string }
  | { op: 'deleteNode'; id: string }
  | { op: 'moveNode'; id: string; position: { x: number; y: number } }
  | { op: 'connect'; from: string; to: string; label?: string }
  | { op: 'deleteEdge'; id: string }
  | {
    op: 'addRegion'
    label: string
    kind?: string
    id?: string
    x?: number
    y?: number
    w?: number
    h?: number
  }
  | { op: 'updateRegion'; id: string; label?: string; kind?: string; x?: number; y?: number; w?: number; h?: number }
  | { op: 'deleteRegion'; id: string }
  | { op: 'fitRegion'; id: string }

/** Host snapshot shape the SSE stream delivers. */
export interface MsSnapshot {
  graph: {
    nodes: Array<{
      id: string
      type: NodeKind
      label: string
      data: MsData
      position?: { x: number; y: number }
    }>
    edges: Array<{ id: string; source: string; target: string; label?: string }>
    regions: Array<{
      id: string
      label: string
      kind?: string
      x: number
      y: number
      w: number
      h: number
    }>
  }
  version: number
}

export interface OpenConnectOpts {
  /** Source node when the menu leads to a wired create (side buttons, drag). */
  fromId?: string
  side?: 'left' | 'right'
  /** Anchor in viewport coords (the menu renders position:fixed there). */
  x: number
  y: number
}

/**
 * What node components may ask the canvas view to do. Provided once by
 * <Canvas>; node cards consume it via useMediaCanvas().
 */
export interface MediaCanvasApi {
  canvasId: string
  /** Responsive card width (px) computed from the container width. */
  cardW: number
  /** Open the "add a node here" menu (context / + side / drag-release). */
  openConnectMenu(opts: OpenConnectOpts): void
  /** Delete one node through the host (corner ×, toolbar delete, keyboard). */
  deleteNode(id: string): void
  /** Rename through the host (title row commits on blur / Enter). */
  renameNode(id: string, label: string): void
  /** Merge data into a node (e.g. textarea edits on blur). */
  patchData(id: string, data: Record<string, unknown>): void
  /** Single-op fire-and-forget that always goes through the history + SSE. */
  post(ops: MsOp[]): void
  /** Regenerate this node from its upstream content via the host tool. */
  refreshNode(id: string): Promise<void>
  /** M2 — open the "save this media card into the project library" dialog.
   *  Absent when the card type has nothing to save or the host hides it. */
  saveToLibraryNode?(id: string): void
  /** Node ids that have at least one outgoing edge (source side). Rebuilt
   *  once per server snapshot in canvas.tsx — never on viewport gestures —
   *  so AddSideButton / RefreshSideButton can read connectivity without an
   *  xyflow store selector subscription (which would re-run on every
   *  pan/zoom tick). Stable Set references are returned so consumers only
   *  re-render when the graph topology actually changes. */
  edgesRight: ReadonlySet<string>
  /** Node ids that have at least one incoming edge (target side). */
  edgesLeft: ReadonlySet<string>
  /** Node ids that have at least one upstream (incoming) edge. Equivalent
   *  to `edgesLeft`, kept as a separate name for readability at call sites. */
  hasUpstreamById: ReadonlySet<string>
}

export const MediaCanvasContext = createContext<MediaCanvasApi | null>(null)

export function useMediaCanvas(): MediaCanvasApi {
  const api = useContext(MediaCanvasContext)
  if (!api) throw new Error('media-studio: <Canvas> provider missing')
  return api
}

/**
 * Fire-and-forget POST of canvas ops to the host's REST endpoint. The host
 * apply() runs synchronously; the SSE broadcast reconciles the tab state
 * once the call returns.
 */
export async function postOps(canvasId: string, ops: MsOp[]): Promise<{ ok: boolean; version?: number }> {
  if (ops.length === 0) return { ok: true }
  try {
    const res = await fetch('/api/media-studio/canvas/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId, ops }),
    })
    if (!res.ok) {
      console.error('[media-studio] canvas patch failed:', res.status, res.statusText)
      return { ok: false }
    }
    const json = (await res.json()) as { ok?: boolean; version?: number }
    return { ok: json.ok !== false, version: json.version }
  } catch (e) {
    console.error('[media-studio] canvas patch failed:', (e as Error).message)
    return { ok: false }
  }
}

/** Browser-renderable URL for a stored media path.
 *
 * Host tools store local filesystem paths (e.g. .../web-jobs/x.png) as the
 * node's resultUrl. Browsers can't load those, so we map them onto the
 * host's media-file proxy. http(s)/data:/blob: and same-origin /api/ URLs
 * pass through untouched.
 *
 * Bare relative paths that start with `assets/` (the project-internal
 * convention, e.g. `assets/characters/xxx.png`) are automatically prefixed
 * with `projects/<projectId>/` so the server's `resolveMediaTarget()` rewrite
 * kicks in and maps them to the correct on-disk location. This prevents the
 * browser from requesting `http://host/assets/...` which always 404s. */
export function mediaSrc(raw?: string, projectId?: string): string {
  if (!raw) return ''
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw
  if (raw.startsWith('file://')) return `/api/media-studio/media-file?path=${encodeURIComponent(raw.slice('file://'.length))}`
  if (raw.startsWith('/api/')) return raw
  if (raw.startsWith('/')) {
    // Absolute POSIX path written by a host tool.
    return `/api/media-studio/media-file?path=${encodeURIComponent(raw)}`
  }
  if (raw.startsWith('projects/')) {
    // Project-relative path under workspaceRoot (e.g. projects/<id>/assets/.../foo.png).
    // Resolved against workspaceRoot by the media-file proxy, so no extra
    // permissioning is required here.
    return `/api/media-studio/media-file?path=${encodeURIComponent(raw)}`
  }
  if (raw.startsWith('assets/')) {
    // Bare project-internal relative path (e.g. assets/characters/xxx.png).
    // Prefix with the current project id so the media-file proxy can rewrite
    // it to the correct sourcePath-backed location. Falls back to the raw
    // path when projectId is unavailable (legacy / off-canvas usage).
    const prefixed = projectId ? `projects/${projectId}/${raw}` : raw
    return `/api/media-studio/media-file?path=${encodeURIComponent(prefixed)}`
  }
  return raw
}

/** Spread onto a node wrapper to drive adaptive card width from the canvas. */
export function cardWidthVar(w: number): CSSProperties {
  return { '--ms-card-w': `${Math.round(w)}px` } as CSSProperties
}
