// Canvas — media-studio editor tab.
//
// The render shape (nodes + edges) is server-authoritative: `useCanvasState`
// subscribes to the host SSE stream; every agent `canvas_graph_patch` lands
// here as a snapshot that React Flow reconciles. The user's own edits are
// local-optimistic + committed through POST /api/media-studio/canvas/patch,
// which persists + broadcasts back (the same path the agent tools use).
//
// Interaction model:
//   • Right-click / double-click on empty space → floating "add node" menu.
//   • Drag a connection off a node and release on empty space → "add a
//     connected node" menu at the cursor.
//   • "+" buttons on the sides of every card → same connected-add menu.
//   • Cmd/Ctrl+Z (+Shift) → undo / redo (host snapshots diffed + rebuilt
//     atomically through the store; the agent sees the rewind too).
//   • Scroll pans, Cmd/Ctrl+scroll zooms, pinch zooms — Figma-style.
//   • Clipboard image paste → new image node.
//   • Floating view bar: auto-arrange · minimap toggle · fit · zoom.
//
// Node cards (title rows, hover toolbars, media fills) live in ./nodes.tsx;
// all styling in ./canvas-styles.ts.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore as useFlowStore,
  useStoreApi as useFlowStoreApi,
  type Connection,
  type Edge as FlowEdge,
  type EdgeProps,
  type Node as FlowNode,
  type NodeChange,
  type OnConnectEnd,
  type OnConnectStart,
} from '@xyflow/react'
import { createPortal } from 'react-dom'
import { NODE_CATALOG, NODE_TYPES, defaultLabel } from './nodes'
import {
  MediaCanvasContext,
  postOps,
  type MsOp,
  type MsSnapshot,
  type NodeKind,
  type OpenConnectOpts,
  useMediaCanvas,
} from './canvas-api'
import { injectMediaStudioStyles } from './canvas-styles'
import { IconMap, IconMaximize2, IconMinus, IconWand, IconZoomIn, IconEraser, IconX } from './icons'
import { apiRegisterAsset, type AssetKind } from './assets-api'
import { resolveLang, translate } from './i18n'
import { subscribeFull, subscribeConn } from './canvas-bus'

export interface CanvasProps {
  /** Canvas id the tab renders + subscribes to (shared with the tools). */
  canvasId: string
}

type ConnState = 'connecting' | 'open' | 'reconnecting'

// ── Snapshot helpers ─────────────────────────────────────────────────────

type SNode = MsSnapshot['graph']['nodes'][number]
type SRegion = MsSnapshot['graph']['regions'][number]
type SGraph = MsSnapshot['graph']

function nodeToken(n: SNode): string {
  return JSON.stringify([n.id, n.type, n.label, n.position ?? null, n.data])
}

/** Content fingerprint that ignores edge ids (the host mints them). */
function graphToken(graph: SGraph): string {
  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).map(nodeToken).join('|')
  const edges = graph.edges
    .map((e) => `${e.source}->${e.target}${e.label ? `:${e.label}` : ''}`)
    .sort()
    .join('|')
  const regions = (graph.regions ?? [])
    .map((r) => `${r.id}:${r.label}:${r.kind ?? ''}:${r.x},${r.y},${r.w},${r.h}`)
    .sort()
    .join('|')
  return `${nodes}##${edges}##${regions}`
}

function cloneGraph(graph: SGraph): SGraph {
  return JSON.parse(JSON.stringify(graph)) as SGraph
}

function msSnapshotOf(graph: SGraph, version: number): MsSnapshot {
  return { graph: cloneGraph(graph), version }
}

/** Ops that rebuild the host graph to equal `target` (delete-all + re-add
 *  with fixed ids) — atomic in one patch, used by undo/redo. */
function restoreOps(target: MsSnapshot): MsOp[] {
  const ops: MsOp[] = []
  for (const n of target.graph.nodes) ops.push({ op: 'deleteNode', id: n.id })
  for (const r of target.graph.regions ?? []) ops.push({ op: 'deleteRegion', id: r.id })
  for (const r of target.graph.regions ?? []) {
    ops.push({
      op: 'addRegion',
      id: r.id,
      label: r.label,
      ...(r.kind ? { kind: r.kind } : {}),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
    })
  }
  for (const n of target.graph.nodes) {
    ops.push({
      op: 'addNode',
      type: n.type,
      label: n.label,
      nodeId: n.id,
      position: n.position,
      data: n.data,
    })
  }
  for (const e of target.graph.edges) ops.push({ op: 'connect', from: e.source, to: e.target, ...(e.label ? { label: e.label } : {}) })
  return ops
}

// ── Projection host-graph ↔ React Flow ───────────────────────────────────

function projectNodeOne(n: SNode): FlowNode {
  const isDoc = n.type === 'text' || n.type === 'note'
  return {
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    // Restrict drag origin to .ms-drag-area for text/note nodes so the
    // resize handle (outside that element) never triggers a node drag.
    ...(isDoc ? { dragHandle: '.ms-drag-area' } : {}),
    data: {
      kind: n.type,
      label: n.label,
      prompt: n.data.prompt,
      model: n.data.model,
      resultUrl: n.data.resultUrl,
      status: n.data.status,
      errorMsg: n.data.errorMsg,
      text: n.data.text,
      content: n.data.content,
      // Video covers: server's prepareVideoForCanvas stores the poster
      // (external first-frame JPG) in data.poster. Without carrying it here
      // the client never receives it and every poster-rendering path (video
      // poster attr, CSS background, <img> overlay) silently does nothing.
      poster: n.data.poster,
      // Text/note cards persist their user-resized height in data.height
      // (updateNode). Carry it through the projection so an SSE snapshot —
      // including the echo of the very patch that stored it — doesn't drop
      // it and collapse the card back to its default size.
      height: n.data.height,
    },
  }
}

function projectNodes(graph: SGraph): FlowNode[] {
  return graph.nodes.map((n) => projectNodeOne(n))
}

/** Content token for a projected node — unchanged nodes keep their original
 *  object reference so memoized card components skip re-rendering. */
function projectedNodeToken(n: SNode): string {
  const p = n.position
  return JSON.stringify([n.id, n.type, n.label, p ? [p.x, p.y] : null, n.data])
}

/**
 * Merge an incoming graph into the current flow nodes, **reusing** existing
 * node objects whose content is unchanged. Per-version SSE updates then only
 * re-render the cards that actually changed instead of remounting the whole
 * canvas — the main source of UI-wide jank on large canvases.
 */
function mergeNodes(
  prev: FlowNode[],
  graph: SGraph,
  tokenCache: Map<string, string>,
): FlowNode[] {
  if (prev.length === 0 || graph.nodes.length === 0) {
    tokenCache.clear()
    return projectNodes(graph)
  }
  const prevById = new Map(prev.map((n) => [n.id, n]))
  const out: FlowNode[] = []
  for (const n of graph.nodes) {
    const existing = prevById.get(n.id)
    const token = projectedNodeToken(n)
    const cached = tokenCache.get(n.id)
    if (existing && cached === token) {
      out.push(existing)
      continue
    }
    const projected = projectNodeOne(n)
    tokenCache.set(n.id, token)
    out.push(projected)
  }
  // Drop tokens for ids that disappeared.
  for (const id of [...tokenCache.keys()]) {
    if (!prevById.has(id)) tokenCache.delete(id)
  }
  return out
}

function mergeEdges(prev: FlowEdge[], edges: SGraph['edges']): FlowEdge[] {
  const byId = new Map(prev.map((e) => [e.id, e]))
  const out: FlowEdge[] = []
  for (const e of edges) {
    const existing = byId.get(e.id)
    if (existing && existing.source === e.source && existing.target === e.target && existing.data?.label === e.label) {
      out.push(existing)
    } else {
      out.push({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: `${e.source}-out`,
        targetHandle: `${e.target}-in`,
        type: 'flow',
        data: { label: e.label },
      })
    }
  }
  return out
}

function projectEdges(graph: SGraph): FlowEdge[] {
  return graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: `${e.source}-out`,
    targetHandle: `${e.target}-in`,
    type: 'flow',
    data: { label: e.label },
  }))
}

function regionToken(r: SRegion): string {
  return `${r.id}:${r.label}:${r.kind ?? ''}:${r.x},${r.y},${r.w},${r.h}`
}

/** Reference-preserving merge for regions: unchanged boxes keep their object
 *  identity so a live resize drag isn't reset by the SSE echo of the same
 *  values. */
function mergeRegions(prev: SRegion[], next: SRegion[]): SRegion[] {
  if (prev.length === 0 || next.length === 0) return next.map((r) => ({ ...r }))
  const byId = new Map(prev.map((r) => [r.id, r]))
  const out: SRegion[] = []
  for (const r of next) {
    const existing = byId.get(r.id)
    if (existing && regionToken(existing) === regionToken(r)) {
      out.push(existing)
    } else {
      out.push({ ...r })
    }
  }
  return out
}

function projectRegions(graph: SGraph): SRegion[] {
  return (graph.regions ?? []).map((r) => ({ ...r }))
}

/** Deterministic local mirror of the host apply() for UI-fired ops, so the
 *  optimistic state matches the SSE echo. Edge ids are client placeholders —
 *  content comparison ignores them. Region ops mirror the host rules
 *  (auto-stack / shallow patch / delete box only). */
function applyLocalOps(
  nodes: FlowNode[],
  edges: FlowEdge[],
  regions: SRegion[],
  ops: MsOp[],
): { nodes: FlowNode[]; edges: FlowEdge[]; regions: SRegion[] } {
  let ns = nodes.map((n) => ({ ...n, data: { ...(n.data as object) } }))
  let es = edges.map((e) => ({ ...e }))
  let rs = regions.map((r) => ({ ...r }))
  let edgeSeq = es.length
  for (const op of ops) {
    switch (op.op) {
      case 'addNode': {
        const id = op.nodeId ?? `n-${Date.now().toString(36)}`
        if (ns.some((n) => n.id === id)) break
        ns = [...ns, {
          id,
          type: op.type,
          position: op.position ?? { x: 0, y: 0 },
          data: { kind: op.type, label: op.label, ...(op.data ?? {}) },
        }]
        break
      }
      case 'deleteNode': {
        ns = ns.filter((n) => n.id !== op.id)
        es = es.filter((e) => e.source !== op.id && e.target !== op.id)
        break
      }
      case 'moveNode': {
        ns = ns.map((n) => (n.id === op.id ? { ...n, position: op.position } : n))
        break
      }
      case 'renameNode': {
        ns = ns.map((n) => (n.id === op.id ? { ...n, data: { ...(n.data as object), label: op.label } } : n))
        break
      }
      case 'updateNode': {
        ns = ns.map((n) => (n.id === op.id ? { ...n, data: { ...(n.data as object), ...op.data } } : n))
        break
      }
      case 'connect': {
        if (!ns.some((n) => n.id === op.from) || !ns.some((n) => n.id === op.to)) break
        es = [...es, {
          id: `e-ui-${++edgeSeq}`,
          source: op.from,
          target: op.to,
          sourceHandle: `${op.from}-out`,
          targetHandle: `${op.to}-in`,
          type: 'flow',
          data: { label: op.label },
        }]
        break
      }
      case 'deleteEdge': {
        es = es.filter((e) => e.id !== op.id)
        break
      }
      case 'addRegion': {
        if (rs.some((r) => r.id === op.id)) break
        const bottom = rs.reduce((m, r) => Math.max(m, r.y + r.h), 0)
        rs = [...rs, {
          id: op.id ?? `r-ui-${Date.now().toString(36)}`,
          label: op.label,
          ...(op.kind ? { kind: op.kind } : {}),
          x: op.x ?? 60,
          y: op.y ?? (bottom === 0 ? 60 : bottom + 60),
          w: op.w ?? 640,
          h: op.h ?? 400,
        }]
        break
      }
      case 'updateRegion': {
        rs = rs.map((r) => (r.id === op.id ? {
          ...r,
          ...(op.label !== undefined ? { label: op.label } : {}),
          ...(op.kind !== undefined ? { kind: op.kind } : {}),
          ...(op.x !== undefined ? { x: op.x } : {}),
          ...(op.y !== undefined ? { y: op.y } : {}),
          ...(op.w !== undefined ? { w: op.w } : {}),
          ...(op.h !== undefined ? { h: op.h } : {}),
        } : r))
        break
      }
      case 'deleteRegion': {
        rs = rs.filter((r) => r.id !== op.id)
        break
      }
      case 'fitRegion':
        // Geometry is computed server-side from node positions; the SSE echo
        // reconciles it. No optimistic mirror (button click → echo is fast).
        break
    }
  }
  return { nodes: ns, edges: es, regions: rs }
}

/** Deterministic free-slot placement mirroring the host's defaultSlot. */
function freeSlot(occupied: Array<{ x: number; y: number }>): { x: number; y: number } {
  for (let i = 0; i < 400; i++) {
    const col = i % 8
    const row = Math.floor(i / 8)
    const cand = { x: 60 + col * 300, y: 60 + row * 300 }
    const free = occupied.every((p) => !(Math.abs(p.x - cand.x) < 260 && Math.abs(p.y - cand.y) < 210))
    if (free) return cand
  }
  return { x: 60 + (occupied.length % 8) * 300, y: 60 + Math.floor(occupied.length / 8) * 300 }
}

/**
 * Content-fit height for text/note cards (used by the auto-arrange wand):
 * title row + textarea scrollHeight + paddings, capped so cards never grow
 * without bound. Returns null while the card isn't mounted yet.
 */
function estimateDocHeight(id: string, cardW: number): number | null {
  let el: HTMLElement | null = null
  try {
    el = document.querySelector(`[data-ms-id="${CSS.escape(id)}"]`)
  } catch { /* unqueryable id — skip */ }
  if (!el) return null
  const titleRow = el.querySelector('.ms-title-row') as HTMLElement | null
  const editor = el.querySelector('.ms-doc-editor') as HTMLTextAreaElement | null
  const warn = el.querySelector('.ms-doc-empty-warn') as HTMLElement | null
  const titleH = titleRow?.offsetHeight ?? 30
  const editorH = editor ? editor.scrollHeight : 0
  const warnH = warn ? warn.offsetHeight + 6 : 0
  const pad = 14
  const minH = 104
  const cap = Math.max(minH, Math.min(520, Math.round(cardW * 1.9)))
  const raw = titleH + editorH + warnH + pad
  return Math.max(minH, Math.min(cap, Math.round(raw)))
}

// ── Custom edge (bezier gradient) ─────────────────────────────────────────
// Edge `data.label` is still carried through the graph (semantics for
// refresh / skill sync) but is intentionally NOT rendered — per product
// decision, edge labels are removed from the canvas UI.
function FlowEdgeView(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, style } = props
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const gradId = `ms-edge-${id}`
  // Check if this edge is part of the currently selected node's connected
  // component. Non-connected edges fade out via CSS.
  // When no selection (empty set), show all edges.
  const api = useMediaCanvas()
  const isConnected = !api.highlightedEdgeIds || api.highlightedEdgeIds.size === 0 || api.highlightedEdgeIds.has(id)
  return (
    <>
      <defs>
        <linearGradient id={gradId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <BaseEdge
        id={id}
        path={path}
        className={!isConnected ? 'is-dimmed' : undefined}
        style={{
          stroke: selected ? '#a5b4fc' : `url(#${gradId})`,
          strokeWidth: selected ? 2.5 : 2,
          strokeOpacity: selected ? 1 : 0.6,
          ...style,
        }}
      />
    </>
  )
}

const EDGE_TYPES = { flow: FlowEdgeView }

// ── Region layer (partition containers, rendered inside the viewport) ─────
// Hosted via <ViewportPortal>, which portals into the transformed
// .react-flow__viewport — so region boxes pan and zoom with the canvas for
// free. z-index 1 keeps them above the dot-grid background (0) and below
// edges (2) / nodes (6). The layer itself is pointer-events: none; only the
// title bar and resize handle opt back in (marked nopan/nodrag so xyflow's
// pane never turns a region click into a canvas pan).
function RegionLayer({ regions, onFit, onDelete, onResizeLocal, onResizeCommit, onDragStateChange }: {
  regions: SRegion[]
  onFit: (id: string) => void
  onDelete: (id: string) => void
  /** Live drag feedback — local optimistic geometry update (no history). */
  onResizeLocal: (id: string, w: number, h: number) => void
  /** Drag end — commit the final geometry to the host. */
  onResizeCommit: (id: string, w: number, h: number) => void
  /** Drag start/end signal (used to pause SSE region reconciliation so a
   *  concurrent agent op can't snap the box back mid-drag). */
  onDragStateChange: (dragging: boolean) => void
}) {
  const flowStoreApi = useFlowStoreApi()
  if (regions.length === 0) return null
  return (
    <ViewportPortal>
      <div className="ms-region-layer" aria-hidden>
        {regions.map((r) => (
          <RegionBox
            key={r.id}
            region={r}
            flowStoreApi={flowStoreApi}
            onFit={onFit}
            onDelete={onDelete}
            onResizeLocal={onResizeLocal}
            onResizeCommit={onResizeCommit}
            onDragStateChange={onDragStateChange}
          />
        ))}
      </div>
    </ViewportPortal>
  )
}

function RegionBox({ region, flowStoreApi, onFit, onDelete, onResizeLocal, onResizeCommit, onDragStateChange }: {
  region: SRegion
  flowStoreApi: ReturnType<typeof useFlowStoreApi>
  onFit: (id: string) => void
  onDelete: (id: string) => void
  onResizeLocal: (id: string, w: number, h: number) => void
  onResizeCommit: (id: string, w: number, h: number) => void
  onDragStateChange: (dragging: boolean) => void
}) {
  const onResizeStart = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onDragStateChange(true)
    const startX = e.clientX
    const startY = e.clientY
    const startW = region.w
    const startH = region.h
    // Flow-space deltas: pointer deltas divided by the current zoom.
    const zoom = flowStoreApi.getState().transform[2] || 1
    let lastW = startW
    let lastH = startH
    const move = (ev: PointerEvent) => {
      lastW = Math.max(120, Math.round(startW + (ev.clientX - startX) / zoom))
      lastH = Math.max(96, Math.round(startH + (ev.clientY - startY) / zoom))
      onResizeLocal(region.id, lastW, lastH)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onDragStateChange(false)
      onResizeCommit(region.id, lastW, lastH)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="ms-region"
      data-kind={region.kind ?? 'generic'}
      style={{ left: region.x, top: region.y, width: region.w, height: region.h }}
    >
      <div className="ms-region-title nopan nodrag">
        <span className="ms-region-label">{region.label}</span>
        {region.kind && <span className="ms-region-kind">{region.kind}</span>}
        <span className="ms-region-title-spacer" />
        <button
          type="button"
          className="ms-region-btn"
          title="贴合内容（自动包裹所有子节点）"
          aria-label={`Fit region ${region.label} to content`}
          onClick={(e) => { e.stopPropagation(); onFit(region.id) }}
        >
          <IconMaximize2 size={11} strokeWidth={2} />
        </button>
        <button
          type="button"
          className="ms-region-btn ms-region-btn-danger"
          title="删除分区（不删除内部节点）"
          aria-label={`Delete region ${region.label}`}
          onClick={(e) => { e.stopPropagation(); onDelete(region.id) }}
        >
          <IconX size={11} strokeWidth={2.2} />
        </button>
      </div>
      <div
        className="ms-region-resize nopan nodrag"
        title="拖动调整分区大小"
        aria-hidden
        onPointerDown={onResizeStart}
      />
    </div>
  )
}

// ── SSE subscription ─────────────────────────────────────────────────────

function useCanvasState(canvasId: string): { snap: MsSnapshot | null; conn: ConnState } {
  const [snap, setSnap] = useState<MsSnapshot | null>(null)
  const [conn, setConn] = useState<ConnState>('connecting')

  // Subscribe through the shared canvas-bus. CanvasView and LiveBadge both
  // need this stream — opening two EventSources against the same endpoint
  // doubled the server-side fan-out and the browser-side JSON parsing
  // cost on every patch, and was a measurable source of UI jank from
  // *opening* an empty canvas tab. The bus keeps a single connection open
  // until the last subscriber unsubscribes.
  useEffect(() => {
    const offSnap = subscribeFull(canvasId, (s) => setSnap(s))
    const offConn = subscribeConn(canvasId, setConn)
    return () => { offSnap(); offConn() }
  }, [canvasId])
  return { snap, conn }
}

type MenuKind =
  | { kind: 'pane'; x: number; y: number; flowX: number; flowY: number }
  | { kind: 'connect'; fromId: string; side: 'left' | 'right'; x: number; y: number; flowX: number; flowY: number }

const CREATE_ORDER: NodeKind[] = ['text', 'image', 'video', 'music', 'note']

// ── The view ─────────────────────────────────────────────────────────────

function CanvasView({ canvasId }: CanvasProps) {
  useEffect(() => { injectMediaStudioStyles() }, [])

  const { snap, conn } = useCanvasState(canvasId)
  const rf = useReactFlow()

  const [nodes, setNodes, onNodesChangeBase] = useNodesState<FlowNode>([])
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<FlowEdge>([])

  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const edgesRef = useRef(edges)
  edgesRef.current = edges

  // Regions are host-authoritative but rendered + edited locally (optimistic
  // resize drag), then reconciled from SSE snapshots. The ref lets
  // non-render callbacks (clear-canvas) read the latest set.
  const [regions, setRegions] = useState<SRegion[]>([])
  const regionsRef = useRef(regions)
  regionsRef.current = regions

  const interactingRef = useRef(false)
  const restoringRef = useRef(false)
  const lastLocalPostRef = useRef(0)
  const didInitialFitRef = useRef(false)
  const lastPanTargetRef = useRef(0)
  // M1 — per-project camera memory. When the tab opens a project whose
  // viewport was persisted, restore it and briefly suppress the automatic
  // "frame the content" fits so they don't fight the remembered camera.
  const suppressAutoFitRef = useRef(false)
  const previewingRef = useRef(false)
  const nodeTokenCacheRef = useRef(new Map<string, string>())
  const lastFitStructRef = useRef('')
  const vpKey = `dsh-media-studio:viewport:${canvasId}`

  // Adaptive card width from the pane width — big cards that still
  // fit the DSH sidebar.  Node dims are hard-capped at 1.5× the smaller
  // viewport dimension (updated reactively via a ref so we avoid a stale
  // dependency cycle on the state setter).
  const [cardW, setCardW] = useState(240)
  const maxCardDimRef = useRef(900)
  const measureRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = measureRef.current?.parentElement ?? null
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      const h = el.clientHeight
      const vpMin = Math.min(w, h)
      maxCardDimRef.current = Math.round(vpMin * 1.5)
      setCardW((prev) => {
        const target = Math.max(200, Math.min(280, w - 84))
        const capped = Math.min(target, maxCardDimRef.current)
        return Math.abs(prev - capped) > 1 ? capped : prev
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Per-project viewport memory (M1) ────────────────────────────────────
  // Restore the remembered camera on open (if any) and persist camera
  // changes back, debounced, keyed by project/canvas id.
  useEffect(() => {
    suppressAutoFitRef.current = false
    let raw: string | null = null
    try {
      raw = localStorage.getItem(vpKey)
    } catch { /* ignore */ }
    if (!raw) return
    try {
      const vp = JSON.parse(raw) as { x: number; y: number; zoom: number }
      if (Number.isFinite(vp.x) && Number.isFinite(vp.y) && vp.zoom >= 0.2 && vp.zoom <= 2.5) {
        suppressAutoFitRef.current = true
        requestAnimationFrame(() => {
          try { rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: 0 }) } catch { /* ignore */ }
        })
        // Let the opening snapshots land; after this window auto-fits resume.
        const t = setTimeout(() => { suppressAutoFitRef.current = false }, 900)
        return () => clearTimeout(t)
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vpKey])

  // Viewport persistence — drives the per-project camera memory. We deliberately
  // do NOT subscribe to `useFlowStore(s => s.transform)`: xyflow mutates that
  // tuple on every gesture frame (during pan/zoom), which would re-render the
  // entire CanvasView subtree — every NodeShell, every AddSideButton, the
  // ViewBar, the FAB dock, the SSE effect, … — on every pan tick. With a
  // touchpad / trackpad that fires ~120 events/sec, the canvas tab on screen
  // was the dominant source of UI jank in the host shell.
  //
  // Instead, react to ReactFlow's `onMove` callback (fires only when the
  // viewport actually settles after a user gesture or programmatic move) and
  // debounce the localStorage write ourselves. The callback also gives us a
  // direct handle to gate writes while the camera is mid-gesture.
  const lastPersistedVpRef = useRef<[number, number, number] | null>(null)
  const vpPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onMoveViewport = useCallback((_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
    const { x, y, zoom } = viewport
    const prev = lastPersistedVpRef.current
    if (prev && prev[0] === x && prev[1] === y && prev[2] === zoom) return
    lastPersistedVpRef.current = [x, y, zoom]
    if (vpPersistTimerRef.current) clearTimeout(vpPersistTimerRef.current)
    vpPersistTimerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(vpKey, JSON.stringify({ x: Math.round(x), y: Math.round(y), zoom: Math.round(zoom * 100) / 100 }))
      } catch { /* ignore */ }
    }, 450)
  }, [vpKey])

  // ── History (content snapshots, 500ms coalescing) ───────────────────────
  const appliedRef = useRef<MsSnapshot | null>(null)
  const historyRef = useRef<{ past: MsSnapshot[]; future: MsSnapshot[] }>({ past: [], future: [] })
  const pendingQueueRef = useRef<MsSnapshot | null>(null)
  const queueTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const queueHistory = useCallback((prev: MsSnapshot) => {
    // Keep the EARLIEST snapshot of a burst so multi-op agent patches fold
    // into one undo step.
    if (!pendingQueueRef.current) pendingQueueRef.current = prev
    if (queueTimerRef.current) return
    queueTimerRef.current = setTimeout(() => {
      queueTimerRef.current = null
      const h = historyRef.current
      if (pendingQueueRef.current) {
        h.past.push(pendingQueueRef.current)
        if (h.past.length > 50) h.past.shift()
        h.future = []
        pendingQueueRef.current = null
      }
    }, 500)
  }, [])

  const postLocal = useCallback((ops: MsOp[]) => {
    if (ops.length === 0) return
    lastLocalPostRef.current = Date.now()
    void postOps(canvasId, ops)
  }, [canvasId])

  // ── Ids ─────────────────────────────────────────────────────────────────
  const idSeqRef = useRef(0)
  const nextId = useCallback((prefix: string): string => {
    const taken = new Set(nodesRef.current.map((n) => n.id))
    let id: string
    do {
      idSeqRef.current += 1
      id = `ui-${prefix}-${idSeqRef.current}`
    } while (taken.has(id))
    return id
  }, [])

  /** Optimistic mutation + undo snapshot + host commit (UI's one funnel). */
  const mutate = useCallback((ops: MsOp[], then?: () => void) => {
    if (ops.length === 0) { then?.(); return }
    previewingRef.current = false // user is editing → leave playback preview
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    const next = applyLocalOps(nodesRef.current, edgesRef.current, regionsRef.current, ops)
    setNodes(next.nodes)
    setEdges(next.edges)
    setRegions(next.regions)
    postLocal(ops)
    then?.()
  }, [postLocal, queueHistory])

  // ── Reconcile from the SSE snapshot ─────────────────────────────────────
  useEffect(() => {
    if (!snap) return
    if (interactingRef.current) return
    if (restoringRef.current) {
      // The restore (undo/redo) patch ack: adopt silently, no history push.
      restoringRef.current = false
      appliedRef.current = msSnapshotOf(snap.graph, snap.version)
      setNodes(projectNodes(snap.graph))
      setEdges(projectEdges(snap.graph))
      setRegions(projectRegions(snap.graph))
      return
    }
    const prev = appliedRef.current
    const isFirst = prev === null
    // Version dedupe at the useEffect layer too — the SSE handler already
    // dedupes incoming `snap` updates, but the same version can also be
    // re-applied if a stale effect re-runs (React 18 strict mode, devtools
    // re-mount, etc.). Skip the work entirely.
    if (!isFirst && prev.version === snap.version) return
    const nextSnap = msSnapshotOf(snap.graph, snap.version)
    appliedRef.current = nextSnap
    if (previewingRef.current) return // playback owns the screen for now

    if (!isFirst) queueHistory(prev)
    // Reference-preserving merge: only cards whose content actually changed
    // are replaced, so memoized node components skip re-renders and the
    // whole canvas no longer remounts on every version tick.
    setNodes((cur) => mergeNodes(cur, snap.graph, nodeTokenCacheRef.current))
    setEdges((cur) => mergeEdges(cur, snap.graph.edges))
    if (!draggingRegionRef.current) {
      setRegions((cur) => mergeRegions(cur, snap.graph.regions ?? []))
    }

    // Structural change → softly frame the new content. Purely data-level
    // updates (status toggles while media streams in) keep the camera put.
    const structToken =
      snap.graph.nodes.map((n) => `${n.id}@${n.position?.x ?? 0},${n.position?.y ?? 0}`).sort().join('|')
      + '#'
      + snap.graph.edges.map((e) => `${e.source}->${e.target}`).sort().join('|')
      + '#'
      + (snap.graph.regions ?? []).map((r) => `${r.id}:${r.x},${r.y},${r.w},${r.h}`).sort().join('|')
    if (snap.version !== lastPanTargetRef.current || structToken !== lastFitStructRef.current) {
      lastPanTargetRef.current = snap.version
      lastFitStructRef.current = structToken
      // Softly frame agent-written content — never right after the user's own
      // edit (they own the camera at that point) nor during the opening
      // viewport restore window.
      if (suppressAutoFitRef.current) {
        /* remembered camera owns the moment — no auto fit */
      } else if (Date.now() - lastLocalPostRef.current > 700) {
        requestAnimationFrame(() => {
          try { rf.fitView({ padding: 0.18, duration: 220, maxZoom: 1 }) } catch { /* ignore */ }
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // Initial fit on the first non-empty snapshot (skipped when a remembered
  // viewport is being restored).
  useEffect(() => {
    if (!snap || didInitialFitRef.current) return
    if (snap.graph.nodes.length === 0) return
    if (suppressAutoFitRef.current) return
    didInitialFitRef.current = true
    requestAnimationFrame(() => {
      try { rf.fitView({ padding: 0.2, duration: 250 }) } catch { /* ignore */ }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // ── Highlighted nodes on selection ──────────────────────────────────────
  // When a node is selected, highlight all nodes connected to it (upstream +
  // downstream) so the user can see the dependency chain at a glance.
  // Non-highlighted nodes and edges fade to 30% opacity for clear visual focus.
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<ReadonlySet<string>>(new Set())
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<ReadonlySet<string>>(new Set())

  // Pre-computed adjacency lists — cached and only rebuilt when edges change.
  // This avoids O(E) traversal on every selection event.
  const adjacencyRef = useRef<{
    out: Map<string, Array<{ id: string; target: string }>>
    in: Map<string, Array<{ id: string; source: string }>>
  }>({ out: new Map(), in: new Map() })

  // Rebuild adjacency map only when edges change (not on every render).
  useMemo(() => {
    const outMap = new Map<string, Array<{ id: string; target: string }>>()
    const inMap = new Map<string, Array<{ id: string; source: string }>>()
    for (const e of edges) {
      const outArr = outMap.get(e.source) ?? []
      outArr.push({ id: e.id, target: e.target })
      outMap.set(e.source, outArr)
      const inArr = inMap.get(e.target) ?? []
      inArr.push({ id: e.id, source: e.source })
      inMap.set(e.target, inArr)
    }
    adjacencyRef.current = { out: outMap, in: inMap }
  }, [edges])

  // ── Gestures ────────────────────────────────────────────────────────────
  // Only the resize-grip gesture may persist node heights. React Flow also
  // fires 'dimensions' events on every auto-measure/layout pass (and after
  // every SSE echo), so committing all of them would spam versions and lock
  // doc cards into whatever height the transient measure produced — the
  // "version/high rockets on restart" bug. We mark ids while ch.resizing is
  // true and persist exactly the final height of that gesture.
  const resizingIdsRef = useRef<Set<string>>(new Set())
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    previewingRef.current = false
    let draggingNow = false
    const commits: Array<{ id: string; position: { x: number; y: number } }> = []
    const dimCommits: Array<{ id: string; height: number }> = []
    for (const ch of changes) {
      if (ch.type === 'position' && ch.dragging) {
        interactingRef.current = true
        draggingNow = true
      }
      if (ch.type === 'position' && !ch.dragging && ch.position) {
        commits.push({ id: ch.id, position: ch.position })
      }
      if (ch.type === 'select' && !draggingNow) {
        queueMicrotask(() => { interactingRef.current = false })
      }
      if (ch.type === 'dimensions') {
        if (ch.resizing) {
          resizingIdsRef.current.add(ch.id)
        } else if (ch.dimensions && resizingIdsRef.current.has(ch.id)) {
          resizingIdsRef.current.delete(ch.id)
          dimCommits.push({ id: ch.id, height: ch.dimensions.height })
        }
      }
    }
    onNodesChangeBase(changes as never)
    if (commits.length > 0) {
      interactingRef.current = false
      const cur = appliedRef.current
      if (cur) queueHistory(cur)
      postLocal(commits.map((c) => ({ op: 'moveNode', id: c.id, position: c.position })))
    }
    if (dimCommits.length > 0) {
      const cur = appliedRef.current
      if (cur) queueHistory(cur)
      postLocal(dimCommits.map((c) => ({ op: 'updateNode', id: c.id, data: { height: Math.round(c.height) } })))
    }

    // Compute highlighted nodes when selection changes.
    const selChanges = changes.filter((ch) => ch.type === 'select')
    for (const ch of selChanges) {
      const nodeId = ch.id
      const isSelected = !!ch.selected
      if (!isSelected) {
        setHighlightedNodeIds(new Set())
        setHighlightedEdgeIds(new Set())
        continue
      }
      // Fast lookup from pre-computed adjacency: direct neighbors only.
      const connected = new Set<string>()
      const connectedEdges = new Set<string>()
      const { out, in: inMap } = adjacencyRef.current
      const queue: string[] = [nodeId]
      connected.add(nodeId)
      while (queue.length > 0) {
        const curr = queue.shift()!
        // Outgoing edges
        for (const edge of out.get(curr) ?? []) {
          connectedEdges.add(edge.id)
          if (!connected.has(edge.target)) {
            connected.add(edge.target)
            queue.push(edge.target)
          }
        }
        // Incoming edges
        for (const edge of inMap.get(curr) ?? []) {
          connectedEdges.add(edge.id)
          if (!connected.has(edge.source)) {
            connected.add(edge.source)
            queue.push(edge.source)
          }
        }
      }
      setHighlightedNodeIds(connected)
      setHighlightedEdgeIds(connectedEdges)
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNodesChangeBase, postLocal, queueHistory, edges])

  const onEdgesChange = useCallback((changes: Parameters<typeof onEdgesChangeBase>[0]) => {
    onEdgesChangeBase(changes)
  }, [onEdgesChangeBase])

  // ── Delete keys ─────────────────────────────────────────────────────────
  const onKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    const selNodes = nodesRef.current.filter((n) => n.selected)
    const selEdges = edgesRef.current.filter((ed) => ed.selected)
    if (selNodes.length === 0 && selEdges.length === 0) return
    e.preventDefault()
    const ops: MsOp[] = [
      ...selEdges.map((ed) => ({ op: 'deleteEdge', id: ed.id }) as MsOp),
      ...selNodes.map((n) => ({ op: 'deleteNode', id: n.id }) as MsOp),
    ]
    mutate(ops)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate])

  // ── Undo / redo ─────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    const h = historyRef.current
    const target = h.past.pop()
    if (!target) return
    const cur = appliedRef.current
    if (cur) h.future.push(cur)
    restoringRef.current = true
    setNodes(projectNodes(target.graph))
    setEdges(projectEdges(target.graph))
    setRegions(projectRegions(target.graph))
    postLocal(restoreOps(target))
    lastLocalPostRef.current = Date.now()
  }, [postLocal])

  const redo = useCallback(() => {
    const h = historyRef.current
    const target = h.future.pop()
    if (!target) return
    const cur = appliedRef.current
    if (cur) h.past.push(cur)
    restoringRef.current = true
    setNodes(projectNodes(target.graph))
    setEdges(projectEdges(target.graph))
    setRegions(projectRegions(target.graph))
    postLocal(restoreOps(target))
    lastLocalPostRef.current = Date.now()
  }, [postLocal])

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // Clipboard image paste → new image node.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      for (const item of Array.from(e.clipboardData.items)) {
        if (!item.type.startsWith('image/')) continue
        const file = item.getAsFile()
        if (!file) continue
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const pos = rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
          mutate([{
            op: 'addNode',
            type: 'image',
            label: 'pasted image',
            nodeId: nextId('img'),
            position: { x: pos.x - 90, y: pos.y - 90 },
            data: { kind: 'image', status: 'done', resultUrl: dataUrl },
          }])
        }
        reader.readAsDataURL(file)
        e.preventDefault()
        return
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, nextId, rf])

  // ── Menus ───────────────────────────────────────────────────────────────
  const [menu, setMenu] = useState<MenuKind | null>(null)
  const dismissMenu = useCallback(() => setMenu(null), [])

  const openPaneMenuAt = useCallback((clientX: number, clientY: number) => {
    const flow = rf.screenToFlowPosition({ x: clientX, y: clientY })
    setMenu({ kind: 'pane', x: clientX, y: clientY, flowX: flow.x, flowY: flow.y })
  }, [rf])

  const openConnectMenu = useCallback((opts: OpenConnectOpts) => {
    const flow = rf.screenToFlowPosition({ x: opts.x, y: opts.y })
    setMenu(opts.fromId
      ? { kind: 'connect', fromId: opts.fromId, side: opts.side ?? 'right', x: opts.x, y: opts.y, flowX: flow.x, flowY: flow.y }
      : { kind: 'pane', x: opts.x, y: opts.y, flowX: flow.x, flowY: flow.y })
  }, [rf])

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault()
    openPaneMenuAt(event.clientX, event.clientY)
  }, [openPaneMenuAt])

  const onPaneDoubleClick = useCallback((event: React.MouseEvent | MouseEvent) => {
    openPaneMenuAt(event.clientX, event.clientY)
  }, [openPaneMenuAt])

  // Click on empty pane clears selection and highlights.
  const onPaneClick = useCallback(() => {
    setHighlightedNodeIds(new Set())
    setHighlightedEdgeIds(new Set())
  }, [])

  const connectStartRef = useRef<string | null>(null)
  const onConnectStart: OnConnectStart = useCallback((_event, { nodeId }) => {
    connectStartRef.current = nodeId ?? null
  }, [])
  const onConnectEnd: OnConnectEnd = useCallback((event) => {
    const target = event.target as HTMLElement | null
    const hitPane = target?.classList.contains('react-flow__pane')
    if (!hitPane || !connectStartRef.current) { connectStartRef.current = null; return }
    const fromId = connectStartRef.current
    connectStartRef.current = null
    const me = event as unknown as MouseEvent
    const flow = rf.screenToFlowPosition({ x: me.clientX, y: me.clientY })
    setMenu({ kind: 'connect', fromId, side: 'right', x: me.clientX, y: me.clientY, flowX: flow.x, flowY: flow.y })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf])

  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return
    mutate([{ op: 'connect', from: conn.source, to: conn.target }])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate])

  // ── Creation ────────────────────────────────────────────────────────────
  const onPickCreate = useCallback((kind: NodeKind) => {
    if (!menu) return
    const id = nextId(kind)
    const W = cardW
    const ops: MsOp[] = []
    let position: { x: number; y: number }
    let center: { x: number; y: number }

    if (menu.kind === 'connect') {
      // Snap beside the source node so the new card reads as a branch.
      const src = rf.getNode(menu.fromId)
      if (src) {
        const srcW = src.measured?.width ?? W
        const srcH = src.measured?.height ?? 160
        if (menu.side === 'right') {
          position = { x: src.position.x + srcW + 80, y: src.position.y + Math.max(0, (srcH - W) / 2) }
        } else {
          position = { x: src.position.x - W - 80, y: src.position.y + Math.max(0, (srcH - W) / 2) }
        }
        center = { x: position.x + W / 2, y: position.y + W / 2 }
      } else {
        position = { x: menu.flowX - W / 2, y: menu.flowY - 40 }
        center = { x: menu.flowX, y: menu.flowY }
      }
      const isLeft = menu.side === 'left'
      ops.push({ op: 'connect', from: isLeft ? id : menu.fromId, to: isLeft ? menu.fromId : id })
    } else {
      position = { x: menu.flowX - W / 2, y: menu.flowY - 40 }
      center = { x: menu.flowX, y: menu.flowY }
    }

    ops.unshift({
      op: 'addNode',
      type: kind,
      label: defaultLabel(kind),
      nodeId: id,
      position,
      data: { kind, status: 'idle' },
    })
    dismissMenu()
    mutate(ops)
    requestAnimationFrame(() => {
      try { rf.setCenter(center.x, center.y, { zoom: 1, duration: 220 }) } catch { /* not mounted */ }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, mutate, nextId, rf, cardW, dismissMenu])

  const onToolbarAdd = useCallback((kind: NodeKind) => {
    const id = nextId(kind)
    const slot = freeSlot(nodesRef.current.map((n) => n.position))
    mutate([{
      op: 'addNode',
      type: kind,
      label: defaultLabel(kind),
      nodeId: id,
      position: slot,
      data: { kind, status: 'idle' },
    }])
    requestAnimationFrame(() => {
      try { rf.setCenter(slot.x + 100, slot.y + 90, { zoom: 1, duration: 220 }) } catch { /* ignore */ }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, nextId, rf])

  // ── Region interactions ─────────────────────────────────────────────────
  const onToolbarAddRegion = useCallback(() => {
    const id = nextId('region')
    mutate([{ op: 'addRegion', label: '新分区', id }])
    const bottom = regionsRef.current.reduce((m, r) => Math.max(m, r.y + r.h), 0)
    requestAnimationFrame(() => {
      try { rf.setCenter(60 + 320, (bottom === 0 ? 60 : bottom + 60) + 200, { zoom: 1, duration: 220 }) } catch { /* ignore */ }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, nextId, rf])

  const fitRegionBox = useCallback((id: string) => {
    mutate([{ op: 'fitRegion', id }])
  }, [mutate])

  const deleteRegionBox = useCallback((id: string) => {
    mutate([{ op: 'deleteRegion', id }])
  }, [mutate])

  // Live drag feedback: optimistic local geometry only (no history churn).
  const resizeRegionLocal = useCallback((id: string, w: number, h: number) => {
    setRegions((cur) => cur.map((r) => (r.id === id ? { ...r, w, h } : r)))
  }, [])

  // While a resize drag is live, pause SSE region reconciliation so a
  // concurrent agent op (echoing the pre-drag geometry) can't snap the box
  // back under the cursor. The post-drag echo reconciles everything.
  const draggingRegionRef = useRef(false)
  const setRegionDragging = useCallback((dragging: boolean) => {
    draggingRegionRef.current = dragging
  }, [])

  // Drag end: commit the final geometry through mutate() — one host op, one
  // history entry (undo returns the box to its pre-drag size). SSE echo
  // reconciles with token-equal geometry, keeping the local object identity.
  const resizeRegionCommit = useCallback((id: string, w: number, h: number) => {
    mutate([{ op: 'updateRegion', id, w, h }])
  }, [mutate])

  // Auto-arrange: columns by edge depth (view-bar wand). Also
  // auto-wraps text/note cards to their content (capped) before layout, so
  // the result reads like a tidy storyboard instead of overgrown boxes.
  const autoArrange = useCallback(() => {
    previewingRef.current = false
    const flowNodes = rf.getNodes()
    const flowEdges = rf.getEdges()
    if (flowNodes.length === 0) return

    // ── doc height auto-fit (text/note) ────────────────────────────────
    const estHeights = new Map<string, number>()
    const heightOps: MsOp[] = []
    for (const n of flowNodes) {
      if (n.type !== 'text' && n.type !== 'note') continue
      const h = estimateDocHeight(n.id, cardW)
      if (!h) continue
      const current = n.measured?.height ?? (n.data as { height?: unknown }).height
      if (typeof current !== 'number' || Math.abs(current - h) > 4) {
        estHeights.set(n.id, h)
        heightOps.push({ op: 'updateNode', id: n.id, data: { height: h } })
      }
    }

    const inMap = new Map<string, string[]>()
    const outMap = new Map<string, string[]>()
    for (const e of flowEdges) {
      const a = inMap.get(e.target) ?? []
      a.push(e.source)
      inMap.set(e.target, a)
      const b = outMap.get(e.source) ?? []
      b.push(e.target)
      outMap.set(e.source, b)
    }
    const depth = new Map<string, number>()
    const queue: Array<{ id: string; d: number }> = []
    for (const n of flowNodes) {
      if (!(inMap.get(n.id)?.length)) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
    }
    while (queue.length) {
      const { id, d } = queue.shift()!
      for (const t of outMap.get(id) ?? []) {
        if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
      }
    }
    for (const n of flowNodes) if (!depth.has(n.id)) depth.set(n.id, 0)

    const byDepth = new Map<number, string[]>()
    for (const n of flowNodes) {
      const d = depth.get(n.id) ?? 0
      const list = byDepth.get(d) ?? []
      list.push(n.id)
      byDepth.set(d, list)
    }
    const colPitch = cardW + 130
    const moves: MsOp[] = []
    for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      let y = 60
      for (const id of ids) {
        const n = flowNodes.find((x) => x.id === id)
        const est = estHeights.get(id)
        const h = est ?? n?.measured?.height ?? 160
        moves.push({ op: 'moveNode', id, position: { x: 60 + d * colPitch, y } })
        y += h + 44
      }
    }
    if (moves.length + heightOps.length === 0) return
    // Optimistic local apply (like every other user op): the canvas moves
    // immediately instead of waiting for the SSE echo — and any failure
    // surfaces in the console instead of silently "doing nothing".
    try {
      mutate([...heightOps, ...moves])
    } catch (e) {
      console.error('[media-studio] autoArrange failed:', (e as Error).message)
      return
    }
    setTimeout(() => { try { rf.fitView({ padding: 0.15, duration: 360 }) } catch { /* ignore */ } }, 140)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, cardW, mutate])

  // ── Save-to-library dialog (M2) ─────────────────────────────────────────
  const [saveDlg, setSaveDlg] = useState<{ id: string; type: NodeKind; label: string } | null>(null)
  const openSaveToLibrary = useCallback((id: string) => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n) return
    const t = n.type as NodeKind
    if (t !== 'image' && t !== 'video' && t !== 'music') return
    setSaveDlg({ id, type: t, label: (n.data as { label?: string }).label ?? '' })
  }, [])

  // ── Connectivity maps ───────────────────────────────────────────────────
  // Rebuild once per edges reference change (which, thanks to mergeEdges'
  // reference-preserving merge above, only happens on actual SSE graph
  // updates — never on viewport gestures). Stable Set refs are shipped to
  // AddSideButton / RefreshSideButton through the canvas context so they
  // skip the per-gesture `useStore(s => s.edges.some(...))` selector that
  // was the dominant source of UI jank when the canvas tab was on screen.
  const connMaps = useMemo(() => {
    const right = new Set<string>()
    const left = new Set<string>()
    for (const e of edges) {
      right.add(e.source)
      left.add(e.target)
    }
    return { right, left }
  }, [edges])

  // ── API for node components ─────────────────────────────────────────────
  const api = useMemo(() => ({
    canvasId,
    cardW,
    openConnectMenu,
    saveToLibraryNode: openSaveToLibrary,
    deleteNode: (id: string) => mutate([{ op: 'deleteNode', id }]),
    renameNode: (id: string, label: string) => mutate([{ op: 'renameNode', id, label }]),
    patchData: (id: string, data: Record<string, unknown>) => mutate([{ op: 'updateNode', id, data }]),
    post: postLocal,
    edgesRight: connMaps.right,
    edgesLeft: connMaps.left,
    hasUpstreamById: connMaps.left,
    highlightedNodeIds,
    highlightedEdgeIds,
    refreshNode: async (id: string) => {
      // Optimistically set status to 'running' immediately so the user sees
      // feedback before the (potentially long) generation completes. The SSE
      // broadcast from the server will later reconcile the final state.
      mutate([{ op: 'updateNode', id, data: { status: 'running' as const } }])

      // Safety net: if the server never responds (hang, network issue) the
      // SSE 'done'/'error' broadcast will still update the node — but if
      // SSE is also broken we need a client-side timeout to avoid the
      // node being stuck on 'running' forever. Must stay ABOVE the server's
      // refresh timeout (5 min, routes.ts) so a long video generation
      // (30–90 s + download + ffmpeg) never gets yanked to idle before the
      // server finishes; 5.5 min leaves margin for the SSE round-trip.
      const timeoutHandle = setTimeout(() => {
        console.warn('[media-studio] refreshNode: timeout, forcing status=idle')
        mutate([{ op: 'updateNode', id, data: { status: 'idle' as const, errorMsg: 'Refresh timed out' } }])
      }, 330_000)

      try {
        const res = await fetch('/api/media-studio/canvas/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ canvasId, nodeId: id }),
        })
        clearTimeout(timeoutHandle)
        if (!res.ok) {
          const txt = await res.text().catch(() => '')
          console.error('[media-studio] refresh failed:', res.status, txt)
          mutate([{ op: 'updateNode', id, data: { status: 'idle' as const, errorMsg: txt } }])
          return
        }
        const json = await res.json()
        if (!json.ok) {
          // Server reported a known failure (no upstream, not-supported, etc.)
          // — surface it and skip the 'wait for SSE' path.
          mutate([{ op: 'updateNode', id, data: { status: 'error' as const, errorMsg: json.message || json.code || 'Refresh failed' } }])
          return
        }
        // SSE will reconcile the final state (done + resultUrl).
      } catch (e) {
        clearTimeout(timeoutHandle)
        console.error('[media-studio] refresh error:', (e as Error).message)
        mutate([{ op: 'updateNode', id, data: { status: 'error' as const, errorMsg: (e as Error).message } }])
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [canvasId, cardW, openConnectMenu, mutate, postLocal, connMaps])

  // ── Clear-canvas confirmation ───────────────────────────────────────────
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false)
  const doClearCanvas = useCallback(() => {
    previewingRef.current = false
    if (nodesRef.current.length === 0 && regionsRef.current.length === 0) return
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    // Local-optimistic clear — no undo push on the SSE ack so we don't
    // double-record the empty state. SSE will reconcile anyway.
    setNodes([])
    setEdges([])
    appliedRef.current = null
    postLocal([
      ...regionsRef.current.map((r) => ({ op: 'deleteRegion' as const, id: r.id })),
      ...nodesRef.current.map((n) => ({ op: 'deleteNode' as const, id: n.id })),
    ])
  }, [queueHistory, postLocal])

  return (
    <div className="media-studio-canvas" style={{ width: '100%', height: '100%' }}>
      <div
        className="ms-stage"
        ref={measureRef}
        onClick={dismissMenu}
        onKeyDown={onKeyDown}
        tabIndex={0}
      >
        <MediaCanvasContext.Provider value={api}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onPaneContextMenu={onPaneContextMenu}
            onDoubleClick={onPaneDoubleClick}
            onPaneClick={onPaneClick}
            onMove={onMoveViewport}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            defaultEdgeOptions={{ type: 'flow' }}
            fitView={false}
            minZoom={0.2}
            maxZoom={2.5}
            defaultViewport={{ x: 60, y: 60, zoom: 1 }}
            proOptions={{ hideAttribution: true }}
            panOnScroll
            panOnScrollSpeed={0.9}
            zoomOnScroll={false}
            zoomOnPinch
            zoomActivationKeyCode={['Meta', 'Control']}
            panOnDrag
            // Box / marquee selection — parity. Bare drag
            // pans the viewport; holding Cmd (Mac) / Ctrl (Win) while
            // dragging on empty pane starts a box selection. Shift + click
            // adds nodes to the existing selection (xyflow default
            // multiSelectionKeyCode). selectNodesOnDrag={false} prevents the
            // click-drag-on-card gesture from also being interpreted as a
            // node-drag-AND-select — we want only the explicit marquee path
            // to change selection state, so the Ctrl-drag feedback stays
            // unambiguous.
            selectionOnDrag={false}
            selectionKeyCode={['Meta', 'Control']}
            selectNodesOnDrag={false}
            deleteKeyCode={null as never}
            style={{ background: 'transparent' }}
          >
            <Background
              variant={BackgroundVariant.Dots}
              gap={20}
              size={1.8}
            />
            <RegionLayer
              regions={regions}
              onFit={fitRegionBox}
              onDelete={deleteRegionBox}
              onResizeLocal={resizeRegionLocal}
              onResizeCommit={resizeRegionCommit}
              onDragStateChange={setRegionDragging}
            />
            <MiniMapWrap />
          </ReactFlow>

          {nodes.length === 0 && regions.length === 0 && <EmptyHint conn={conn} />}

          {/* Vertical "add a node" capsule dock — left-middle of the canvas. */}
          <div className="ms-fab-dock" role="toolbar" aria-label="Add a node">
            {CREATE_ORDER.map((kind) => {
              const meta = NODE_CATALOG.find((m) => m.type === kind)!
              const Icon = meta.Icon
              return (
                <button
                  key={kind}
                  type="button"
                  className="ms-fab-dock-btn"
                  onClick={() => onToolbarAdd(kind)}
                  title={`${meta.label} · ${meta.desc}`}
                  aria-label={`Add ${meta.label} node`}
                >
                  <Icon size={17} strokeWidth={1.8} />
                </button>
              )
            })}
            <button
              type="button"
              className="ms-fab-dock-btn ms-fab-dock-region"
              onClick={onToolbarAddRegion}
              title="新增分区（容器盒，节点可拖入）"
              aria-label="Add a region"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                <rect x="1.75" y="1.75" width="12.5" height="12.5" rx="2.5" />
                <path d="M4.5 1.75v3.75M11.5 1.75v3.75M4.5 14.25v-3.75M11.5 14.25v-3.75" />
              </svg>
            </button>
          </div>

          {menu && <CreateMenu menu={menu} onClose={dismissMenu} onPick={onPickCreate} />}

          <ViewBar
            autoArrange={autoArrange}
            minimapOn={prefs.minimap}
            onToggleMinimap={toggleMinimap}
            onClearCanvas={() => setClearConfirmOpen(true)}
          />

          {clearConfirmOpen && (
            <div className="ms-clear-confirm-backdrop" onClick={() => setClearConfirmOpen(false)}>
              <div
                className="ms-clear-confirm-dialog"
                role="alertdialog"
                aria-modal="true"
                aria-label="清空画布"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ms-clear-confirm-title">确定清空画布？</div>
                <div className="ms-clear-confirm-body">
                  此操作将删除所有节点和连线，且无法撤销。
                </div>
                <div className="ms-clear-confirm-actions">
                  <button
                    type="button"
                    className="ms-btn-cancel"
                    onClick={() => setClearConfirmOpen(false)}
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    className="ms-btn-danger"
                    onClick={() => {
                      setClearConfirmOpen(false)
                      doClearCanvas()
                    }}
                  >
                    全部清空
                  </button>
                </div>
              </div>
            </div>
          )}
        </MediaCanvasContext.Provider>
      </div>

      {saveDlg && createPortal(
        <SaveToLibraryDialog canvasId={canvasId} node={saveDlg} onClose={() => setSaveDlg(null)} />,
        document.body,
      )}
    </div>
  )
}

// ── View preferences (minimap etc.) — tiny module store ──────────────────

let prefs: { minimap: boolean } = loadPrefs()
const prefListeners = new Set<() => void>()

function loadPrefs(): { minimap: boolean } {
  try {
    const raw = localStorage.getItem('dsh-media-studio:view')
    if (raw) {
      const v = JSON.parse(raw) as { minimap?: boolean }
      return { minimap: v.minimap ?? false }
    }
  } catch { /* ignore */ }
  return { minimap: false }
}

function toggleMinimap() {
  prefs = { minimap: !prefs.minimap }
  try { localStorage.setItem('dsh-media-studio:view', JSON.stringify(prefs)) } catch { /* ignore */ }
  prefListeners.forEach((l) => l())
}

function usePrefsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const l = () => setV((n) => n + 1)
    prefListeners.add(l)
    return () => { prefListeners.delete(l) }
  }, [])
  return v
}

function MiniMapWrap() {
  usePrefsVersion()
  // Only mount the <MiniMap> when the user has toggled it on. MiniMap brings
  // a continuous maintenance cost (its internal `useStore` subscriptions to
  // viewport/nodes/edges fire on every store dispatch, plus d3-zoom attached
  // to its SVG, plus an SVG with one `<g>` per node) — keeping it mounted
  // while hidden was the dominant source of UI jank just from *opening* the
  // canvas tab. The wrapper itself only uses stable hooks
  // (useState/useEffect from usePrefsVersion) so toggling does not change
  // the hook order of THIS component.
  if (!prefs.minimap) return null
  return (
    <div className="ms-minimap-slot" data-on="true" aria-hidden={false}>
      <MiniMap pannable zoomable nodeStrokeWidth={1} />
    </div>
  )
}

// ── Save-to-library dialog (M2) ───────────────────────────────────────────

const SAVE_KIND_ORDER: AssetKind[] = ['character', 'scene', 'audio', 'clip']

function SaveToLibraryDialog({ canvasId, node, onClose }: {
  canvasId: string
  node: { id: string; type: NodeKind; label: string }
  onClose: () => void
}) {
  const lang = resolveLang()
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)
  const defaultKind: AssetKind = node.type === 'video' ? 'clip' : node.type === 'music' ? 'audio' : 'scene'
  const [kind, setKind] = useState<AssetKind>(defaultKind)
  const [name, setName] = useState(node.label)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    setBusy(true)
    setErr(null)
    const trimmed = name.trim()
    const res = await apiRegisterAsset(canvasId, node.id, kind, trimmed || undefined)
    setBusy(false)
    if (res.ok) onClose()
    else setErr(res.error)
  }

  return createPortal(
    <div className="ms-menu-backdrop is-modal" onClick={onClose}>
      <div className="ms-pb-dialog" role="dialog" aria-modal="true" aria-label={t('save.title')} onClick={(e) => e.stopPropagation()}>
        <div className="ms-pb-dialog-head">
          <span>{t('save.title')}</span>
          <button type="button" className="ms-pb-icon-btn" onClick={onClose} aria-label={t('common.close')}>
            <IconX size={13} />
          </button>
        </div>
        <div className="ms-pb-dialog-body">
          <div className="ms-pb-muted">{t('save.hint')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
            {SAVE_KIND_ORDER.map((k) => (
              <label key={k} className="ms-pb-radio" style={{ padding: '3px 2px' }}>
                <input type="radio" name="asset-kind" checked={kind === k} onChange={() => setKind(k)} />
                <span>{t(`asset.kind.${k}`)}</span>
              </label>
            ))}
          </div>
          <input
            className="ms-pb-input"
            value={name}
            placeholder={t('save.name.placeholder')}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submit()
            }}
          />
          {err && <div className="ms-pb-err">{err}</div>}
        </div>
        <div className="ms-pb-dialog-actions">
          <button type="button" className="ms-btn-cancel" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="button" className="ms-btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t('common.loading') : t('save.confirm')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function EmptyHint({ conn }: { conn: ConnState }) {
  return (
    <div className="ms-empty">
      {conn === 'open' ? (
        <>
          <div className="ms-empty-title">画布为空</div>
          <div className="ms-empty-sub">
            双击或右键任意位置添加节点，或让 agent 启动创作流程。
          </div>
        </>
      ) : conn === 'reconnecting' ? (
        <div className="ms-empty-title">连接中断，正在重连…</div>
      ) : (
        <div className="ms-empty-title">正在连接画布…</div>
      )}
    </div>
  )
}

// ── Floating "add node" menu ─────────────────────────────────────────────

function CreateMenu({ menu, onClose, onPick }: {
  menu: MenuKind
  onClose: () => void
  onPick: (k: NodeKind) => void
}) {
  const isConnect = menu.kind === 'connect'
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 240))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 330))
  const menuRef = useRef<HTMLDivElement | null>(null)
  // Portal to <body>: the canvas host carries `contain: layout style` and can
  // live inside transformed/containing sidebar shells, both of which hijack
  // `position: fixed` descendants (the popup would be laid out from the
  // canvas origin while `left/top` are viewport coordinates → way off the
  // "+"/cursor). On <body> fixed is truly viewport-relative.
  //
  // Outside-click to dismiss is handled by a window-level pointerdown listener
  // rather than a backdrop <div onClick>: a full-viewport backdrop would have
  // to sit above the top bar (z-index 900) to swallow clicks on the canvas
  // pane, which made it eat clicks meant for the top bar's "项目" button,
  // the "download canvas" icon, etc. — leaving users with the impression the
  // canvas was blocking UI. With pointer-events: none on the backdrop, the
  // top bar stays clickable; this listener closes the menu only when the
  // pointer lands outside the popup AND outside the canvas pane (so right-
  // click / double-click on the pane reopens it without flicker).
  useEffect(() => {
    const onPointerDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null
      if (!t) return
      const menuEl = menuRef.current
      if (menuEl && menuEl.contains(t)) return
      const pane = document.querySelector('.react-flow__pane')
      if (pane && pane.contains(t)) return
      onClose()
    }
    // Defer one frame so the same pointerdown that opened the menu doesn't
    // immediately close it again.
    const id = window.setTimeout(() => {
      window.addEventListener('pointerdown', onPointerDown, true)
    }, 0)
    return () => {
      window.clearTimeout(id)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [onClose])
  return createPortal(
    <div className="ms-menu-backdrop">
      <div
        ref={menuRef}
        className="ms-connect-menu"
        style={{ left, top }}
        role="menu"
        aria-label={isConnect ? 'Choose a connected node to create' : 'Add a node'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ms-connect-menu-section">
          {isConnect ? '添加关联节点' : '添加节点'}
        </div>
        {CREATE_ORDER.map((kind) => {
          const meta = NODE_CATALOG.find((m) => m.type === kind)!
          const Icon = meta.Icon
          return (
            <button
              key={kind}
              type="button"
              role="menuitem"
              className="ms-connect-menu-item"
              onClick={() => onPick(kind)}
            >
              <span className="ms-connect-menu-icon" style={{ color: meta.tint }}>
                <Icon size={15} strokeWidth={1.75} />
              </span>
              <span className="ms-connect-menu-text">
                <span className="ms-connect-menu-label">{meta.label}</span>
                <span className="ms-connect-menu-desc">{meta.desc}</span>
              </span>
            </button>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

// ── View bar (auto-arrange / minimap / fit / zoom / clear) ──────────────────

function ViewBar({ autoArrange, minimapOn, onToggleMinimap, onClearCanvas }: {
  autoArrange: () => void
  minimapOn: boolean
  onToggleMinimap: () => void
  onClearCanvas: () => void
}) {
  const rf = useReactFlow()
  const lang = resolveLang()
  const t = (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars)
  const doFit = () => { try { rf.fitView({ padding: 0.18, duration: 260 }) } catch { /* ignore */ } }

  return (
    <div className="ms-view-bar" role="toolbar" aria-label="Canvas view controls">
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={autoArrange}
        title={t('view.autoArrange')}
        aria-label={t('view.autoArrange')}
      >
        <IconWand size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={`ms-view-bar-btn ${minimapOn ? 'is-active' : ''}`}
        onClick={onToggleMinimap}
        title={minimapOn ? t('view.minimap.hide') : t('view.minimap.show')}
        aria-pressed={minimapOn}
      >
        <IconMap size={15} strokeWidth={1.8} />
      </button>
      <button type="button" className="ms-view-bar-btn" onClick={doFit} title={t('view.fit')}>
        <IconMaximize2 size={14} strokeWidth={1.8} />
      </button>
      <span className="ms-view-bar-divider" aria-hidden />
      <ZoomControls />
      <span className="ms-view-bar-divider" aria-hidden />
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={onClearCanvas}
        title={t('view.clear')}
        aria-label={t('view.clear')}
      >
        <IconEraser size={14} strokeWidth={1.8} />
      </button>
    </div>
  )
}

// ZoomControls: -/+/% buttons. Lives in its own component so the surrounding
// ViewBar (and the whole CanvasView tree) does not re-render on every pan/
// zoom gesture — only this small island updates with the zoom number. Without
// the split, the `useFlowStore(s => s.transform[2])` selector lives at the
// ViewBar level and triggers a full tree re-render every gesture tick.
function ZoomControls() {
  const rf = useReactFlow()
  const zoom = useFlowStore((s) => s.transform[2])
  const setZ = (z: number) => { try { rf.zoomTo(z, { duration: 180 }) } catch { /* ignore */ } }
  const pct = Math.round((zoom ?? 1) * 100)
  return (
    <>
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={() => setZ(Math.max(0.2, (zoom ?? 1) * 0.8))}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <IconMinus size={15} strokeWidth={2} />
      </button>
      <button
        type="button"
        className="ms-view-bar-pct"
        onClick={() => setZ(1)}
        title="Zoom to 100%"
        aria-label="Zoom 100%"
      >
        {pct}%
      </button>
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={() => setZ(Math.min(2.5, (zoom ?? 1) * 1.25))}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <IconZoomIn size={15} strokeWidth={2} />
      </button>
    </>
  )
}

// ── Public entry ─────────────────────────────────────────────────────────

export function Canvas({ canvasId }: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasView canvasId={canvasId} />
    </ReactFlowProvider>
  )
}

export default Canvas
