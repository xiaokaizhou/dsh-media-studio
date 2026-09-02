// Canvas — franklin-canvas-inspired editor tab for media-studio.
//
// The render shape (nodes + edges) is server-authoritative: `useCanvasState`
// subscribes to the host SSE stream; every agent `canvas_graph_patch` lands
// here as a snapshot that React Flow reconciles. The user's own edits are
// local-optimistic + committed through POST /api/media-studio/canvas/patch,
// which persists + broadcasts back (the same path the agent tools use).
//
// Interaction model ported from franklin-canvas:
//
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
import { IconMap, IconMaximize2, IconMinus, IconWand, IconZoomIn } from './icons'

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

function projectNodes(graph: SGraph): FlowNode[] {
  return graph.nodes.map((n) => {
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
        // Text/note cards persist their user-resized height in data.height
        // (updateNode). Carry it through the projection so an SSE snapshot —
        // including the echo of the very patch that stored it — doesn't drop
        // it and collapse the card back to its default size.
        height: n.data.height,
      },
    }
  })
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

  useEffect(() => {
    const url = `/api/media-studio/canvas/sse?canvasId=${encodeURIComponent(canvasId)}`
    let es: EventSource
    try {
      es = new EventSource(url)
    } catch (err) {
      console.error('[media-studio] failed to open EventSource:', err)
      setConn('reconnecting')
      return () => {}
    }
    es.addEventListener('open', () => setConn('open'))
    es.addEventListener('canvas-patch', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (data?.type === 'canvas-patch' && data.graph) {
          setSnap({ graph: data.graph, version: data.version ?? 0 })
          setConn('open')
        }
      } catch { /* ignore malformed */ }
    })
    es.addEventListener('error', () => {
      console.warn('[media-studio] canvas SSE error, will retry')
      setConn('reconnecting')
    })
    return () => es.close()
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

  // Adaptive card width from the pane width — big franklin cards that still
  // fit the DSH sidebar.
  const [cardW, setCardW] = useState(240)
  const measureRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = measureRef.current?.parentElement ?? null
    if (!el) return
    const measure = () => {
      const w = el.clientWidth
      setCardW((prev) => {
        const target = Math.max(200, Math.min(280, w - 84))
        return Math.abs(prev - target) > 1 ? target : prev
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

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
    if (!snap) return
    if (interactingRef.current) return
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
    appliedRef.current = msSnapshotOf(snap.graph, snap.version)
    if (!isFirst && graphToken(prev.graph) === graphToken(snap.graph)) return

    if (!isFirst) queueHistory(prev)
    setNodes(projectNodes(snap.graph))
    setEdges(projectEdges(snap.graph))

    if (snap.version !== lastPanTargetRef.current) {
      lastPanTargetRef.current = snap.version
      // Softly frame agent-written content — never right after the user's own
      // edit (they own the camera at that point).
      if (Date.now() - lastLocalPostRef.current > 700) {
        requestAnimationFrame(() => {
          try { rf.fitView({ padding: 0.18, duration: 220, maxZoom: 1 }) } catch { /* ignore */ }
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // Initial fit on the first non-empty snapshot.
  useEffect(() => {
    if (!snap || didInitialFitRef.current) return
    if (snap.graph.nodes.length === 0) return
    didInitialFitRef.current = true
    requestAnimationFrame(() => {
      try { rf.fitView({ padding: 0.2, duration: 250 }) } catch { /* ignore */ }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap])

  // ── Gestures ────────────────────────────────────────────────────────────
  const onNodesChange = useCallback((changes: NodeChange[]) => {
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
      if (ch.type === 'dimensions' && !ch.resizing && ch.dimensions) {
        dimCommits.push({ id: ch.id, height: ch.dimensions.height })
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
      postLocal(dimCommits.map((c) => ({ op: 'updateNode', id: c.id, data: { height: c.height } })))
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

  // Auto-arrange: columns by edge depth (franklin's view-bar wand).
  const autoArrange = useCallback(() => {
    const flowNodes = rf.getNodes()
    const flowEdges = rf.getEdges()
    if (flowNodes.length === 0) return
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
        const h = n?.measured?.height ?? 160
        moves.push({ op: 'moveNode', id, position: { x: 60 + d * colPitch, y } })
        y += h + 44
      }
    }
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    postLocal(moves)
    setTimeout(() => { try { rf.fitView({ padding: 0.15, duration: 360 }) } catch { /* ignore */ } }, 140)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, cardW, postLocal, queueHistory])

  // ── API for node components ─────────────────────────────────────────────
  const api = useMemo(() => ({
    canvasId,
    cardW,
    openConnectMenu,
    deleteNode: (id: string) => mutate([{ op: 'deleteNode', id }]),
    renameNode: (id: string, label: string) => mutate([{ op: 'renameNode', id, label }]),
    patchData: (id: string, data: Record<string, unknown>) => mutate([{ op: 'updateNode', id, data }]),
    post: postLocal,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [canvasId, cardW, openConnectMenu, mutate, postLocal])

  return (
    <div className="media-studio-canvas" style={{ width: '100%', height: '100%' }}>
      <Toolbar
        onAdd={onToolbarAdd}
        version={snap?.version ?? 0}
        conn={conn}
        count={nodes.length}
      />
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
            selectionOnDrag={false}
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

          {menu && <CreateMenu menu={menu} onClose={dismissMenu} onPick={onPickCreate} />}

          <ViewBar
            autoArrange={autoArrange}
            minimapOn={prefs.minimap}
            onToggleMinimap={toggleMinimap}
          />
        </MediaCanvasContext.Provider>
      </div>
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
  if (!prefs.minimap) return null
  return <MiniMap pannable zoomable nodeStrokeWidth={1} />
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({ onAdd, version, conn, count }: {
  onAdd: (k: NodeKind) => void
  version: number
  conn: ConnState
  count: number
}) {
  return (
    <div className="ms-toolbar">
      <ul className="ms-add-row" aria-label="Add a node">
        {CREATE_ORDER.map((kind) => {
          const meta = NODE_CATALOG.find((m) => m.type === kind)!
          const Icon = meta.Icon
          return (
            <li key={kind}>
              <button
                type="button"
                className="ms-add-btn"
                onClick={() => onAdd(kind)}
                title={`${meta.label} · ${meta.desc}`}
                aria-label={`Add ${meta.label} node`}
              >
                <Icon size={14} strokeWidth={1.75} />
                <span>{meta.label}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <span className="ms-toolbar-spacer" />
      <span
        className={`ms-live ${conn === 'open' ? 'is-open' : conn === 'reconnecting' ? 'is-reconnecting' : ''}`}
        title={`v${version} · ${count} nodes · SSE ${conn}`}
      >
        <span className="ms-live-dot" />
        {count > 0 ? `v${version} · live` : 'empty'}
      </span>
    </div>
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

// ── View bar (auto-arrange / minimap / fit / zoom) ───────────────────────

function ViewBar({ autoArrange, minimapOn, onToggleMinimap }: {
  autoArrange: () => void
  minimapOn: boolean
  onToggleMinimap: () => void
}) {
  const rf = useReactFlow()
  // Live zoom % (the same subscription franklin's view bar uses).
  const zoom = useFlowStore((s) => s.transform[2])
  const doFit = () => { try { rf.fitView({ padding: 0.18, duration: 260 }) } catch { /* ignore */ } }
  const setZ = (z: number) => { try { rf.zoomTo(z, { duration: 180 }) } catch { /* ignore */ } }

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
        {Math.round((zoom ?? 1) * 100)}%
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
    </div>
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
