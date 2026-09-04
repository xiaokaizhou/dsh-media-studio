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
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStore as useFlowStore,
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
} from './canvas-api'
import { injectMediaStudioStyles } from './canvas-styles'
import { IconMap, IconMaximize2, IconMinus, IconWand, IconZoomIn, IconEraser, IconX } from './icons'
import { apiRegisterAsset, type AssetKind } from './assets-api'
import { resolveLang, translate } from './i18n'
import { recordRevision, setController, latestRevision } from './revision-bus'
import { subscribeFull, subscribeConn } from './canvas-bus'

export interface CanvasProps {
  /** Canvas id the tab renders + subscribes to (shared with the tools). */
  canvasId: string
}

type ConnState = 'connecting' | 'open' | 'reconnecting'

// ── Snapshot helpers ─────────────────────────────────────────────────────

type SNode = MsSnapshot['graph']['nodes'][number]
type SGraph = MsSnapshot['graph']

function nodeToken(n: SNode): string {
  return JSON.stringify([n.id, n.type, n.label, n.position ?? null, n.data])
}

/** Content fingerprint that ignores edge ids (the host mints them). */
function graphToken(graph: SGraph): string {
  const nodes = [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : 1)).map(nodeToken).join('|')
  const edges = graph.edges
    .map((e) => `${e.source}->${e.target}`)
    .sort()
    .join('|')
  return `${nodes}##${edges}`
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
  for (const e of target.graph.edges) ops.push({ op: 'connect', from: e.source, to: e.target })
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
    if (existing && existing.source === e.source && existing.target === e.target) {
      out.push(existing)
    } else {
      out.push({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: `${e.source}-out`,
        targetHandle: `${e.target}-in`,
        type: 'flow',
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
  }))
}

/** Deterministic local mirror of the host apply() for UI-fired ops, so the
 *  optimistic state matches the SSE echo. Edge ids are client placeholders —
 *  content comparison ignores them. */
function applyLocalOps(nodes: FlowNode[], edges: FlowEdge[], ops: MsOp[]): { nodes: FlowNode[]; edges: FlowEdge[] } {
  let ns = nodes.map((n) => ({ ...n, data: { ...(n.data as object) } }))
  let es = edges.map((e) => ({ ...e }))
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
        }]
        break
      }
      case 'deleteEdge': {
        es = es.filter((e) => e.id !== op.id)
        break
      }
    }
  }
  return { nodes: ns, edges: es }
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

// ── Custom edge (bezier gradient) ────────────────────────────────────────
function FlowEdgeView(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, style } = props
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition })
  const gradId = `ms-edge-${id}`
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
  //
  // DIAG (remove after #300 rootcause): rate-limit the bus callback. A
  // runaway setSnap (>20 within any 200ms window) is the React #300
  // fingerprint; logging the burst count + first/last version lets us tell
  // "fast legitimate patches" from "setSnap loop".
  useEffect(() => {
    let burstCount = 0
    let burstWindowStart = 0
    let burstFirstVer: number | undefined
    let burstLastVer: number | undefined
    const offSnap = subscribeFull(canvasId, (s) => {
      const now = performance.now()
      if (now - burstWindowStart > 200) {
        if (burstCount > 20) {
          console.error(
            '[media-studio diag] setSnap burst: count=%d window=200ms firstVersion=%s lastVersion=%s canvasId=%s',
            burstCount, burstFirstVer, burstLastVer, canvasId,
          )
        }
        burstWindowStart = now
        burstCount = 0
        burstFirstVer = undefined
        burstLastVer = undefined
      }
      burstCount += 1
      burstFirstVer ??= s.version
      burstLastVer = s.version
      setSnap(s)
    })
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

  /** Optimistic mutation + history snapshot + host commit (UI's one funnel). */
  const mutate = useCallback((ops: MsOp[], then?: () => void) => {
    if (ops.length === 0) { then?.(); return }
    // DIAG (remove after #300 rootcause): trace each mutation so a loop where
    // the canvas keeps applying ops on top of itself becomes visible.
    console.debug('[media-studio diag] mutate: ops=%o', ops.map((o) => o.op))
    previewingRef.current = false // user is editing → leave playback preview
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    const next = applyLocalOps(nodesRef.current, edgesRef.current, ops)
    setNodes(next.nodes)
    setEdges(next.edges)
    postLocal(ops)
    then?.()
  }, [postLocal, queueHistory])

  // ── Reconcile from the SSE snapshot ─────────────────────────────────────
  useEffect(() => {
    // DIAG (remove after #300 rootcause): trace every reconcile so a
    // runaway loop is localizable. `entered` / `skipped` lets us tell whether
    // the effect ran vs returned early — together with the burst counter in
    // useCanvasState we can pinpoint which stage is re-firing.
    if (snap) {
      const prev = appliedRef.current
      console.debug(
        '[media-studio diag] reconcile enter: version=%s prevVersion=%s interacting=%s restoring=%s',
        snap.version, prev?.version, interactingRef.current, restoringRef.current,
      )
    }
    if (!snap) return
    if (interactingRef.current) {
      console.debug('[media-studio diag] reconcile skipped: interacting')
      return
    }
    if (restoringRef.current) {
      // The restore (undo/redo) patch ack: adopt silently, no history push.
      restoringRef.current = false
      appliedRef.current = msSnapshotOf(snap.graph, snap.version)
      setNodes(projectNodes(snap.graph))
      setEdges(projectEdges(snap.graph))
      return
    }
    const prev = appliedRef.current
    const isFirst = prev === null
    // Version dedupe at the useEffect layer too — the SSE handler already
    // dedupes incoming `snap` updates, but the same version can also be
    // re-applied if a stale effect re-runs (React 18 strict mode, devtools
    // re-mount, etc.). Skip the work entirely.
    if (!isFirst && prev.version === snap.version) {
      console.debug('[media-studio diag] reconcile skipped: same version', snap.version)
      return
    }
    const nextSnap = msSnapshotOf(snap.graph, snap.version)
    appliedRef.current = nextSnap
    // Revision bus (M3b): record every accepted version for the history
    // dropdown even while a playback preview is on screen. `nextSnap` is a
    // fresh object never mutated afterwards — the bus stores it as-is
    // (no second deep clone; deep clones on every patch were a jank source).
    recordRevision(canvasId, nextSnap)
    if (previewingRef.current) return // playback owns the screen for now

    if (!isFirst) queueHistory(prev)
    // Reference-preserving merge: only cards whose content actually changed
    // are replaced, so memoized node components skip re-renders and the
    // whole canvas no longer remounts on every version tick.
    setNodes((cur) => mergeNodes(cur, snap.graph, nodeTokenCacheRef.current))
    setEdges((cur) => mergeEdges(cur, snap.graph.edges))

    // Structural change → softly frame the new content. Purely data-level
    // updates (status toggles while media streams in) keep the camera put.
    const structToken =
      snap.graph.nodes.map((n) => `${n.id}@${n.position?.x ?? 0},${n.position?.y ?? 0}`).sort().join('|')
      + '#'
      + snap.graph.edges.map((e) => `${e.source}->${e.target}`).sort().join('|')
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
    console.debug('[media-studio diag] reconcile exit: version=%s nodesApplied=1 edgesApplied=1', snap.version)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // Revision-bus controller (M3b): the top-bar version badge plays history by
  // previewing a recorded snapshot locally (SSE echo is suppressed while a
  // preview is on screen); calling with null exits back to the live canvas.
  useEffect(() => {
    setController(canvasId, (snapOrNull) => {
      previewingRef.current = !!snapOrNull
      if (snapOrNull) {
        setNodes(projectNodes(snapOrNull.graph))
        setEdges(projectEdges(snapOrNull.graph))
      } else {
        const latest = latestRevision(canvasId)
        if (latest) {
          setNodes(projectNodes(latest.snap.graph))
          setEdges(projectEdges(latest.snap.graph))
        }
      }
    })
    return () => {
      setController(canvasId, null)
      previewingRef.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasId])

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onNodesChangeBase, postLocal, queueHistory])

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
    refreshNode: async (id: string) => {
      // Optimistically set status to 'running' immediately so the user sees
      // feedback before the (potentially long) generation completes. The SSE
      // broadcast from the server will later reconcile the final state.
      mutate([{ op: 'updateNode', id, data: { status: 'running' as const } }])

      // Safety net: if the server never responds (hang, network issue) the
      // SSE 'done'/'error' broadcast will still update the node — but if
      // SSE is also broken we need a client-side timeout to avoid the
      // node being stuck on 'running' forever. 120 s is well above normal
      // generation latency (10–60 s for images, up to 90 s for video).
      const timeoutHandle = setTimeout(() => {
        console.warn('[media-studio] refreshNode: timeout, forcing status=idle')
        mutate([{ op: 'updateNode', id, data: { status: 'idle' as const, errorMsg: 'Refresh timed out' } }])
      }, 120_000)

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
    if (nodesRef.current.length === 0) return
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    // Local-optimistic clear — no history push on the SSE ack so we don't
    // double-record the empty state. SSE will reconcile anyway.
    setNodes([])
    setEdges([])
    appliedRef.current = null
    postLocal(nodesRef.current.map((n) => ({ op: 'deleteNode' as const, id: n.id })))
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
              gap={22}
              size={1.4}
              color="rgba(255,255,255,0.13)"
            />
            <MiniMapWrap />
          </ReactFlow>

          {nodes.length === 0 && <EmptyHint conn={conn} />}

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
                aria-label="Clear canvas"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="ms-clear-confirm-title">Clear canvas?</div>
                <div className="ms-clear-confirm-body">
                  This will delete all nodes and edges. This action cannot be undone.
                </div>
                <div className="ms-clear-confirm-actions">
                  <button
                    type="button"
                    className="ms-btn-cancel"
                    onClick={() => setClearConfirmOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="ms-btn-danger"
                    onClick={() => {
                      setClearConfirmOpen(false)
                      doClearCanvas()
                    }}
                  >
                    Clear all
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
    <div className="ms-menu-backdrop" onClick={onClose}>
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
          <div className="ms-empty-title">Canvas is empty</div>
          <div className="ms-empty-sub">
            Double-click or right-click anywhere to drop a node — or let the agent start the pipeline.
          </div>
        </>
      ) : conn === 'reconnecting' ? (
        <div className="ms-empty-title">Lost the stream — retrying…</div>
      ) : (
        <div className="ms-empty-title">Connecting to canvas…</div>
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
  // Portal to <body>: the canvas host carries `contain: layout style` and can
  // live inside transformed/containing sidebar shells, both of which hijack
  // `position: fixed` descendants (the popup would be laid out from the
  // canvas origin while `left/top` are viewport coordinates → way off the
  // "+"/cursor). On <body> fixed is truly viewport-relative. The backdrop is
  // the token host for the popup's colors, so it matches the DSH theme.
  return createPortal(
    <div className="ms-menu-backdrop" onClick={onClose}>
      <div
        className="ms-connect-menu"
        style={{ left, top }}
        role="menu"
        aria-label={isConnect ? 'Choose a connected node to create' : 'Add a node'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ms-connect-menu-section">
          {isConnect ? 'Add a connected node' : 'Add a node'}
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
  const doFit = () => { try { rf.fitView({ padding: 0.18, duration: 260 }) } catch { /* ignore */ } }

  return (
    <div className="ms-view-bar" role="toolbar" aria-label="Canvas view controls">
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={autoArrange}
        title="Auto-arrange nodes by flow"
        aria-label="Auto-arrange nodes by flow"
      >
        <IconWand size={15} strokeWidth={1.8} />
      </button>
      <button
        type="button"
        className={`ms-view-bar-btn ${minimapOn ? 'is-active' : ''}`}
        onClick={onToggleMinimap}
        title={minimapOn ? 'Hide minimap' : 'Show minimap'}
        aria-pressed={minimapOn}
      >
        <IconMap size={15} strokeWidth={1.8} />
      </button>
      <button type="button" className="ms-view-bar-btn" onClick={doFit} title="Fit to content">
        <IconMaximize2 size={14} strokeWidth={1.8} />
      </button>
      <span className="ms-view-bar-divider" aria-hidden />
      <ZoomControls />
      <span className="ms-view-bar-divider" aria-hidden />
      <button
        type="button"
        className="ms-view-bar-btn"
        onClick={onClearCanvas}
        title="Clear canvas"
        aria-label="Clear canvas"
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
