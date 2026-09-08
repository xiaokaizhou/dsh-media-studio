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
  type OnNodeDrag,
  type OnSelectionChangeParams,
} from '@xyflow/react'
import { createPortal } from 'react-dom'
import { NODE_CATALOG, NODE_TYPES, defaultLabel } from './nodes'
import {
  getDimSet,
  setDimSet,
  computeRelated,
  useEdgeDimmed,
} from './dim-store'
import {
  MediaCanvasContext,
  postOps,
  useMediaCanvas,
  type MsOp,
  type MsSnapshot,
  type NodeKind,
  type OpenConnectOpts,
} from './canvas-api'
import { injectMediaStudioStyles } from './canvas-styles'
import { IconMap, IconMaximize2, IconMinus, IconWand, IconZoomIn, IconEraser, IconX, IconLock, IconUnlock } from './icons'
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
          ...(op.constrained !== undefined ? { constrained: op.constrained } : {}),
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
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, style } = props
  // Chain-highlight: dim this edge when the canvas has an active node
  // selection and at least one endpoint is outside the related set. The
  // boolean subscription re-renders only flipped edges (see dim-store.ts).
  // EdgeProps id/source/target are `string | number` in xyflow; our node
  // ids are strings, so coerce defensively for the store lookup.
  const { canvasId } = useMediaCanvas()
  const dimmed = useEdgeDimmed(canvasId, String(source), String(target))
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
          // `stroke-opacity` animates via CSS transition (canvas-styles.ts);
          // a selected edge always wins at full opacity.
          strokeOpacity: selected ? 1 : dimmed ? 0.12 : 0.6,
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
function RegionLayer({ regions, onFit, onDelete, onResizeLocal, onResizeCommit, onDragStateChange, onDragStart, renamingRegionId, onRenameStart, onRenameCommit, onToggleConstraint, onArrangeRegion }: {
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
  /** Region drag start: (regionId, clientX, clientY, event) */
  onDragStart: (regionId: string, clientX: number, clientY: number, e: React.PointerEvent) => void
  /** Currently-renamed region id (null = none). */
  renamingRegionId: string | null
  /** Start inline rename for a region. */
  onRenameStart: (id: string) => void
  /** Commit a region rename. */
  onRenameCommit: (id: string, label: string) => void
  /** Toggle region constraint. */
  onToggleConstraint: (id: string) => void
  /** Arrange nodes inside a single region. */
  onArrangeRegion: (id: string) => void
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
            onDragStart={onDragStart}
            isRenaming={r.id === renamingRegionId}
            onRenameStart={onRenameStart}
            onRenameCommit={onRenameCommit}
            onToggleConstraint={onToggleConstraint}
            onArrangeRegion={onArrangeRegion}
          />
        ))}
      </div>
    </ViewportPortal>
  )
}

function RegionBox({ region, flowStoreApi, onFit, onDelete, onResizeLocal, onResizeCommit, onDragStateChange, onDragStart, isRenaming, onRenameStart, onRenameCommit, onToggleConstraint, onArrangeRegion }: {
  region: SRegion
  flowStoreApi: ReturnType<typeof useFlowStoreApi>
  onFit: (id: string) => void
  onDelete: (id: string) => void
  onResizeLocal: (id: string, w: number, h: number) => void
  onResizeCommit: (id: string, w: number, h: number) => void
  onDragStateChange: (dragging: boolean) => void
  onDragStart: (regionId: string, clientX: number, clientY: number, e: React.PointerEvent) => void
  isRenaming: boolean
  onRenameStart: (id: string) => void
  onRenameCommit: (id: string, label: string) => void
  onToggleConstraint: (id: string) => void
  onArrangeRegion: (id: string) => void
}) {
  const [renameDraft, setRenameDraft] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

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

  const handleDragStart = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    onDragStart(region.id, e.clientX, e.clientY, e)
  }

  const handleLabelClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    onRenameStart(region.id)
  }

  const handleRenameInputKeydown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation()
    if (e.key === 'Enter') {
      onRenameCommit(region.id, renameDraft ?? region.label)
    } else if (e.key === 'Escape') {
      setRenameDraft(null)
    }
  }

  const handleRenameInputBlur = () => {
    onRenameCommit(region.id, renameDraft ?? region.label)
  }

  return (
    <div
      className="ms-region"
      data-kind={region.kind ?? 'generic'}
      data-constrained={region.constrained ? 'true' : 'false'}
      style={{ left: region.x, top: region.y, width: region.w, height: region.h }}
    >
      <div className="ms-region-title nopan nodrag">
        {/* Drag handle — left side of title bar */}
        <div
          className="ms-region-drag-handle nopan nodrag"
          title="拖动移动分区及子节点"
          aria-label="Drag to move region"
          onPointerDown={handleDragStart}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden>
            <circle cx="2.5" cy="2.5" r="1.5" />
            <circle cx="7.5" cy="2.5" r="1.5" />
            <circle cx="2.5" cy="7.5" r="1.5" />
            <circle cx="7.5" cy="7.5" r="1.5" />
          </svg>
        </div>
        {/* Editable label */}
        {isRenaming ? (
          <input
            ref={inputRef}
            className="ms-region-rename-input"
            value={renameDraft ?? region.label}
            onChange={(e) => setRenameDraft(e.target.value)}
            onBlur={handleRenameInputBlur}
            onKeyDown={handleRenameInputKeydown}
            onClick={(e) => e.stopPropagation()}
            autoFocus
          />
        ) : (
          <span
            className="ms-region-label ms-region-label-clickable"
            title="点击重命名"
            onClick={handleLabelClick}
          >
            {region.label}
          </span>
        )}
        {region.kind && <span className="ms-region-kind">{region.kind}</span>}
        <span className="ms-region-title-spacer" />
        {/* Arrange nodes in this region — only visible when region is locked */}
        <button
          type="button"
          className="ms-region-btn"
          title="Arrange nodes in region"
          aria-label="Arrange nodes in region"
          onClick={(e) => { e.stopPropagation(); onArrangeRegion(region.id) }}
        >
          <IconWand size={11} strokeWidth={1.8} />
        </button>
        {/* Constraint toggle */}
        <button
          type="button"
          className="ms-region-btn"
          title={region.constrained ? '解锁：允许节点移出分区' : '约束：限制节点在分区内移动'}
          aria-label={region.constrained ? 'Unlock region constraint' : 'Constrain region'}
          aria-pressed={region.constrained}
          onClick={(e) => { e.stopPropagation(); onToggleConstraint(region.id) }}
        >
          {region.constrained
            ? <IconLock size={11} strokeWidth={2} />
            : <IconUnlock size={11} strokeWidth={2} />
          }
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
      {/* Transparent drag-blocking overlay — covers the empty region body so
          clicks there are absorbed (region is nopan/nodrag) rather than
          reaching the ReactFlow pane and panning the canvas. */}
      <div
        className="ms-region-body nopan nodrag"
        aria-hidden
        onPointerDown={(e) => e.stopPropagation()}
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
  // Track viewport pixel size so adaptive-arrange zoom calculations don't
  // need to reach into the xyflow store (which has no public getState()).
  const viewportSizeRef = useRef<{ w: number; h: number }>({ w: 800, h: 600 })
  // Sync viewportSizeRef from the ReactFlow store via a passive subscription.
  // We intentionally do NOT put this in state — only a ref — to avoid
  // triggering canvas re-renders on every viewport change.
  useEffect(() => {
    const el = document.querySelector('.media-studio-canvas .react-flow') as HTMLElement
    if (el) {
      viewportSizeRef.current = { w: el.clientWidth, h: el.clientHeight }
    }
    const ro = new ResizeObserver((entries) => {
      const { clientWidth: w, clientHeight: h } = entries[0].target as HTMLElement
      if (w && h) viewportSizeRef.current = { w, h }
    })
    if (el) ro.observe(el)
    return () => { ro.disconnect() }
  }, [])
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
    // Constrained-region clamp: when a node belongs to a region with
    // constrained=true, its flow-position must stay inside the region bounds
    // (padding + card size). We clamp during the commit phase so the SSE
    // echo also carries the clamped value.
    const CARD_W = cardW
    const CARD_H = 240
    const CONstrain_PAD = 24
    const REGION_HEADER_H_LOCAL = 64
    for (const ch of changes) {
      if (ch.type === 'position' && ch.dragging) {
        interactingRef.current = true
        draggingNow = true
      }
      if (ch.type === 'position' && !ch.dragging && ch.position) {
        // Find the region this node belongs to and check if it's constrained.
        const nodeData = nodesRef.current.find((n) => n.id === ch.id)?.data as Record<string, unknown> | undefined
        const regionId = nodeData?.region as string | undefined
        if (regionId) {
          const region = regionsRef.current.find((r) => r.id === regionId)
          if (region?.constrained) {
            const maxX = region.x + region.w - CARD_W - CONstrain_PAD
            const maxY = region.y + region.h - REGION_HEADER_H_LOCAL - CARD_H - CONstrain_PAD
            const clampedX = Math.max(region.x + CONstrain_PAD, Math.min(maxX, ch.position.x))
            const clampedY = Math.max(region.y + REGION_HEADER_H_LOCAL + CONstrain_PAD, Math.min(maxY, ch.position.y))
            commits.push({ id: ch.id, position: { x: Math.round(clampedX), y: Math.round(clampedY) } })
          } else {
            commits.push({ id: ch.id, position: ch.position })
          }
        } else {
          commits.push({ id: ch.id, position: ch.position })
        }
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
  }, [onNodesChangeBase, postLocal, queueHistory, cardW, regionsRef])

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
    // Intentionally NO rf.setCenter call here — the user expects the new
    // region to appear under the current viewport without panning/zooming.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, nextId])

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

  // ── Region drag (move region + all child nodes together) ────────────────
  const [draggingRegionId, setDraggingRegionId] = useState<string | null>(null)
  const dragStartRef = useRef<{
    regionId: string
    regionX: number
    regionY: number
    nodePositions: Map<string, { x: number; y: number }>
    startX: number
    startY: number
  } | null>(null)

  const onRegionDragStart = useCallback((regionId: string, clientX: number, clientY: number, e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const r = regionsRef.current.find((r) => r.id === regionId)
    if (!r) return
    setDraggingRegionId(regionId)
    const nodePositions = new Map<string, { x: number; y: number }>()
    for (const n of nodesRef.current) {
      if ((n.data as Record<string, unknown>).region !== regionId) continue
      nodePositions.set(n.id, n.position ?? { x: 0, y: 0 })
    }
    dragStartRef.current = { regionId, regionX: r.x, regionY: r.y, nodePositions, startX: clientX, startY: clientY }
  }, [])

  useEffect(() => {
    if (!draggingRegionId) return
    const start = dragStartRef.current
    if (!start) return
    // Read zoom once at drag start via DOM transform (stable for the duration).
    let zoom = 1
    const viewportEl = document.querySelector('.react-flow__viewport') as HTMLElement | null
    if (viewportEl) {
      const style = viewportEl.style.transform
      const match = style?.match(/scale\(([\d.]+)\)/)
      if (match) zoom = parseFloat(match[1]) || 1
    }
    // Use requestAnimationFrame to batch the two state updates (setRegions +
    // setNodes) into a single paint per frame. Without this, pointermove
    // fires two independent React state updates per frame → 120 renders/s at
    // 60 Hz. With RAF, we coalesce to one render per frame (60 renders/s).
    let rafId: number | null = null
    let pendingDx = 0
    let pendingDy = 0
    let dirty = false
    const schedule = () => {
      if (rafId !== null) return
      rafId = requestAnimationFrame(() => {
        rafId = null
        if (!dirty) return
        dirty = false
        const dx = pendingDx
        const dy = pendingDy
        setRegions((cur) => cur.map((r) =>
          r.id === draggingRegionId ? { ...r, x: Math.round(start.regionX + dx), y: Math.round(start.regionY + dy) } : r,
        ))
        setNodes((cur) => cur.map((n) => {
          if ((n.data as Record<string, unknown>).region !== draggingRegionId) return n
          const orig = start.nodePositions.get(n.id)
          if (!orig) return n
          return { ...n, position: { x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) } }
        }))
      })
    }
    const move = (ev: PointerEvent) => {
      pendingDx = (ev.clientX - start.startX) / zoom
      pendingDy = (ev.clientY - start.startY) / zoom
      dirty = true
      schedule()
    }
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null }
      setDraggingRegionId(null)
      // Commit the move as a batch op.
      const dx = (ev.clientX - start.startX) / zoom
      const dy = (ev.clientY - start.startY) / zoom
      const ops: MsOp[] = [{ op: 'updateRegion', id: draggingRegionId, x: Math.round(start.regionX + dx), y: Math.round(start.regionY + dy) }]
      for (const [nid, orig] of start.nodePositions) {
        ops.push({ op: 'moveNode', id: nid, position: { x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) } })
      }
      mutate(ops)
      dragStartRef.current = null
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingRegionId])

  // ── Region rename ────────────────────────────────────────────────────────
  const [renamingRegionId, setRenamingRegionId] = useState<string | null>(null)

  const commitRegionRename = useCallback((id: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    mutate([{ op: 'updateRegion', id, label: trimmed }])
    setRenamingRegionId(null)
  }, [mutate])

  // ── Region constraint toggle ─────────────────────────────────────────────
  const toggleRegionConstraint = useCallback((id: string) => {
    const r = regionsRef.current.find((r) => r.id === id)
    if (!r) return
    mutate([{ op: 'updateRegion', id, constrained: !r.constrained }])
  }, [mutate])

  // ── Arrange nodes inside a single region ─────────────────────────────────
  // Only active when the region has constrained=true (lock is on). Uses the
  // same BFS-depth layout as the global adaptive arrange, but scoped to a
  // single region and uses the region's actual width for column sizing.
  const arrangeSingleRegion = useCallback((id: string) => {
    previewingRef.current = false
    const region = regionsRef.current.find((r) => r.id === id)
    if (!region) return
    const flowNodes = rf.getNodes()
    const flowEdges = rf.getEdges()
    const members = flowNodes.filter((n) => (n.data as Record<string, unknown>).region === id)
    if (members.length === 0) return

    // Build edge maps restricted to region members only.
    const inMap = new Map<string, string[]>()
    const outMap = new Map<string, string[]>()
    const memberIds = new Set(members.map((n) => n.id))
    for (const e of flowEdges) {
      if (!memberIds.has(e.source) || !memberIds.has(e.target)) continue
      const a = inMap.get(e.target) ?? []; a.push(e.source); inMap.set(e.target, a)
      const b = outMap.get(e.source) ?? []; b.push(e.target); outMap.set(e.source, b)
    }

    // BFS from roots (no incoming edges within region).
    const depth = new Map<string, number>()
    const queue: Array<{ id: string; d: number }> = []
    for (const n of members) {
      if (!inMap.get(n.id)?.length) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
    }
    while (queue.length) {
      const { id, d } = queue.shift()!
      for (const t of outMap.get(id) ?? []) {
        if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
      }
    }
    for (const n of members) if (!depth.has(n.id)) depth.set(n.id, 0)

    // Group by depth for column assignment.
    const byDepth = new Map<number, string[]>()
    for (const n of members) {
      const d = depth.get(n.id) ?? 0
      const list = byDepth.get(d) ?? []
      list.push(n.id)
      byDepth.set(d, list)
    }

    // Dynamic column sizing: fit columns inside region width using actual node widths.
    const pad = 24
    const headerH = 64
    const usableW = region.w - pad * 2
    let maxNodeW = cardW
    for (const n of members) {
      const w = n.measured?.width ?? cardW
      if (w > maxNodeW) maxNodeW = w
    }
    const cols = Math.max(1, Math.floor(usableW / (maxNodeW + 20)))
    const colPitch = maxNodeW + 20
    const rowPitch = 280
    const ops: MsOp[] = []
    let i = 0
    for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
      for (const nid of ids) {
        const col = i % cols
        const row = Math.floor(i / cols)
        ops.push({ op: 'moveNode', id: nid, position: { x: region.x + pad + col * colPitch, y: region.y + headerH + row * rowPitch } })
        i++
      }
    }
    if (ops.length === 0) return
    mutate([...ops, { op: 'fitRegion' as const, id }])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, cardW, mutate])

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

  // ── Adaptive auto-arrange per region ────────────────────────────────────
  // For each region that has members, runs a region-constrained layout
  // (columns by depth, wrapped inside the region bounds), then fits each
  // region box to its new content. Falls back to the global auto-arrange
  // when there are no regions with members.
  const adaptiveAutoArrange = useCallback(() => {
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

    // Group nodes by region.
    const byRegion = new Map<string, typeof flowNodes>()
    const globalNodes: typeof flowNodes = []
    for (const n of flowNodes) {
      const rid = (n.data as Record<string, unknown>).region as string | undefined
      if (rid) {
        const list = byRegion.get(rid) ?? []
        list.push(n)
        byRegion.set(rid, list)
      } else {
        globalNodes.push(n)
      }
    }

    const allOps: MsOp[] = [...heightOps]

    // Build edge maps for a given node set.
    const buildMaps = (nodes: typeof flowNodes) => {
      const inMap = new Map<string, string[]>()
      const outMap = new Map<string, string[]>()
      for (const e of flowEdges) {
        if (!nodes.find((n) => n.id === e.source) || !nodes.find((n) => n.id === e.target)) continue
        const a = inMap.get(e.target) ?? []; a.push(e.source); inMap.set(e.target, a)
        const b = outMap.get(e.source) ?? []; b.push(e.target); outMap.set(e.source, b)
      }
      return { inMap, outMap }
    }

    // Layout nodes for one region.
    const layoutRegion = (regionId: string, regionNodes: typeof flowNodes) => {
      if (regionNodes.length === 0) return
      const region = regionsRef.current.find((r) => r.id === regionId)
      if (!region) return
      const { inMap, outMap } = buildMaps(regionNodes)
      const depth = new Map<string, number>()
      const queue: Array<{ id: string; d: number }> = []
      for (const n of regionNodes) {
        if (!inMap.get(n.id)?.length) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
      }
      while (queue.length) {
        const { id, d } = queue.shift()!
        for (const t of outMap.get(id) ?? []) {
          if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
        }
      }
      for (const n of regionNodes) if (!depth.has(n.id)) depth.set(n.id, 0)
      const byDepth = new Map<number, string[]>()
      for (const n of regionNodes) {
        const d = depth.get(n.id) ?? 0
        const list = byDepth.get(d) ?? []
        list.push(n.id)
        byDepth.set(d, list)
      }
      const pad = 24
      const headerH = 64
      // Use actual node widths (or cardW fallback) to compute column sizing,
      // ensuring nodes don't overflow the region boundary.
      let maxNodeW = cardW
      for (const n of regionNodes) {
        const w = n.measured?.width ?? cardW
        if (w > maxNodeW) maxNodeW = w
      }
      const colPitch = maxNodeW + 20
      const rowPitch = 280
      const cols = Math.max(1, Math.floor((region.w - pad * 2) / colPitch))
      let i = 0
      for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        for (const id of ids) {
          const col = i % cols
          const row = Math.floor(i / cols)
          allOps.push({ op: 'moveNode', id, position: { x: region.x + pad + col * colPitch, y: region.y + headerH + row * rowPitch } })
          i += 1
        }
      }
    }

    for (const [rid, rnodes] of byRegion) layoutRegion(rid, rnodes)

    // Global layout (no region) — same algorithm as autoArrange.
    if (globalNodes.length > 0) {
      const { inMap, outMap } = buildMaps(globalNodes)
      const depth = new Map<string, number>()
      const queue: Array<{ id: string; d: number }> = []
      for (const n of globalNodes) {
        if (!inMap.get(n.id)?.length) { depth.set(n.id, 0); queue.push({ id: n.id, d: 0 }) }
      }
      while (queue.length) {
        const { id, d } = queue.shift()!
        for (const t of outMap.get(id) ?? []) {
          if ((depth.get(t) ?? -1) < d + 1) { depth.set(t, d + 1); queue.push({ id: t, d: d + 1 }) }
        }
      }
      for (const n of globalNodes) if (!depth.has(n.id)) depth.set(n.id, 0)
      const byDepth = new Map<number, string[]>()
      for (const n of globalNodes) {
        const d = depth.get(n.id) ?? 0
        const list = byDepth.get(d) ?? []
        list.push(n.id)
        byDepth.set(d, list)
      }
      const colPitch = cardW + 130
      for (const [d, ids] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
        let y = 60
        for (const id of ids) {
          const n = globalNodes.find((x) => x.id === id)
          const est = estHeights.get(id)
          const h = est ?? n?.measured?.height ?? 160
          allOps.push({ op: 'moveNode', id, position: { x: 60 + d * colPitch, y } })
          y += h + 44
        }
      }
    }

    // Fit every region that has members.
    for (const r of regionsRef.current) {
      if (flowNodes.some((n) => (n.data as Record<string, unknown>).region === r.id)) {
        allOps.push({ op: 'fitRegion', id: r.id })
      }
    }

    if (allOps.length === 0) return
    try {
      mutate(allOps)
    } catch (e) {
      console.error('[media-studio] adaptiveAutoArrange failed:', (e as Error).message)
      return
    }
    setTimeout(() => {
      try {
        // Compute bounding box of all regions + nodes and zoom to fit content.
        const pad = 60
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (const n of flowNodes) {
          const px = n.position?.x ?? 0
          const py = n.position?.y ?? 0
          minX = Math.min(minX, px)
          minY = Math.min(minY, py)
          maxX = Math.max(maxX, px + (n.measured?.width ?? cardW))
          maxY = Math.max(maxY, py + (n.measured?.height ?? 240))
        }
        for (const r of regionsRef.current) {
          minX = Math.min(minX, r.x)
          minY = Math.min(minY, r.y)
          maxX = Math.max(maxX, r.x + r.w)
          maxY = Math.max(maxY, r.y + r.h)
        }
        if (isFinite(minX) && isFinite(maxX) && isFinite(minY) && isFinite(maxY)) {
          const cx = (minX + maxX) / 2
          const cy = (minY + maxY) / 2
          const w = maxX - minX + pad * 2
          const h = maxY - minY + pad * 2
          const vp = viewportSizeRef.current
          const scale = Math.min(vp.w / w, vp.h / h, 2)
          rf.setCenter(cx, cy, { zoom: scale, duration: 360 })
        } else {
          rf.fitView({ padding: 0.15, duration: 360 })
        }
      } catch { /* ignore */ }
    }, 200)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, cardW, mutate, regionsRef])

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
  // The out/in adjacency arrays feed the chain-highlight BFS (dim-store.ts).
  const connMaps = useMemo(() => {
    const right = new Set<string>()
    const left = new Set<string>()
    const out = new Map<string, string[]>()
    const inn = new Map<string, string[]>()
    for (const e of edges) {
      right.add(e.source)
      left.add(e.target)
      const a = out.get(e.source) ?? []
      a.push(e.target)
      out.set(e.source, a)
      const b = inn.get(e.target) ?? []
      b.push(e.source)
      inn.set(e.target, b)
    }
    return { right, left, out, in: inn }
  }, [edges])

  // ── Chain highlight (dim unrelated nodes/edges while a node is selected) ─
  // `onSelectionChange` is xyflow's selection funnel: node click, Shift+click,
  // Cmd/Ctrl marquee and empty-pane deselect all flow through it. We publish
  // the related set (selected ∪ upstream ∪ downstream) to the module-level
  // dim store; each card/edge subscribes a boolean snapshot, so a selection
  // toggle only re-renders the elements that flipped. The adjacency lookup
  // goes through a ref so the callback stays stable across edges churn
  // (a fresh callback per SSE version would re-render the ReactFlow tree).
  const connMapsRef = useRef(connMaps)
  connMapsRef.current = connMaps
  const selectedIdsRef = useRef<string[]>([])
  const dimStructRef = useRef('')

  const onSelectionChange = useCallback(({ nodes }: OnSelectionChangeParams) => {
    // Node ids are strings in this app; String() guards the xyflow
    // `string | number` id type so the dim store stays id-keyed.
    const ids = nodes.map((n) => String(n.id))
    selectedIdsRef.current = ids
    dimStructRef.current = ''
    if (ids.length === 0) {
      setDimSet(canvasId, null)
      return
    }
    setDimSet(canvasId, computeRelated(connMapsRef.current, ids))
  }, [canvasId])

  // Topology changed under an active selection (e.g. the agent added a node
  // while the user had one selected) → recompute so the new nodes get the
  // correct dim treatment. connMaps ref changes on every SSE version; the
  // token guard makes content-equal echoes no-ops.
  useEffect(() => {
    const ids = selectedIdsRef.current
    if (ids.length === 0 || getDimSet(canvasId) === null) return
    const token =
      ids.join('|') + '=>' + edges.map((e) => `${e.source}->${e.target}`).join('|')
    if (token === dimStructRef.current) return
    dimStructRef.current = token
    setDimSet(canvasId, computeRelated(connMaps, ids))
  }, [canvasId, connMaps, edges])

  // A canvas (re)mount starts with an empty selection — clear any dim state
  // left over from a previously active canvas tab on mount/change/unmount.
  useEffect(() => {
    selectedIdsRef.current = []
    dimStructRef.current = ''
    setDimSet(canvasId, null)
    return () => {
      setDimSet(canvasId, null)
    }
  }, [canvasId])

  // ── Node drag stop — real-time constraint clamp ─────────────────────────
  // Clamps a node's position inside its constrained region immediately when
  // the user lifts the mouse, so xyflow never renders the node outside the
  // bounds. The onNodesChange commit is kept as a safety net for any edge
  // case where onNodeDragStop doesn't fire (e.g. keyboard-driven moves).
  const CONSTRAINT_PAD = 24
  const REGION_HEADER_H_CONST = 64
  const onNodeDragStop: OnNodeDrag = useCallback((event, node) => {
    const rid = (node.data as Record<string, unknown>).region as string | undefined
    if (!rid) return
    const region = regionsRef.current.find((r) => r.id === rid)
    if (!region || !region.constrained) return
    event.preventDefault()
    const cur = appliedRef.current
    if (cur) queueHistory(cur)
    const cw = cardW
    const ch = 240
    const maxX = region.x + region.w - cw - CONSTRAINT_PAD
    const maxY = region.y + region.h - REGION_HEADER_H_CONST - ch - CONSTRAINT_PAD
    const clampedX = Math.max(region.x + CONSTRAINT_PAD, Math.min(maxX, node.position.x))
    const clampedY = Math.max(region.y + REGION_HEADER_H_CONST + CONSTRAINT_PAD, Math.min(maxY, node.position.y))
    const dx = clampedX - node.position.x
    const dy = clampedY - node.position.y
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    mutate([{ op: 'moveNode', id: node.id, position: { x: Math.round(clampedX), y: Math.round(clampedY) } }])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutate, queueHistory, cardW])

  // ── Node drag — live constraint clamp during drag ───────────────────────
  // onNodeDrag fires on every pointermove while dragging. Clamping here keeps
  // the node visually inside the region bounds throughout the gesture instead
  // of only correcting it at the very end (onNodeDragStop). This prevents the
  // node from ever being rendered outside its constrained region.
  const onNodeDrag = useCallback((_event: MouseEvent | TouchEvent, node: FlowNode) => {
    const rid = (node.data as Record<string, unknown>).region as string | undefined
    if (!rid) return
    const region = regionsRef.current.find((r) => r.id === rid)
    if (!region || !region.constrained) return
    const cw = cardW
    const ch = 240
    const maxX = region.x + region.w - cw - CONSTRAINT_PAD
    const maxY = region.y + region.h - REGION_HEADER_H_CONST - ch - CONSTRAINT_PAD
    const nx = Math.max(region.x + CONSTRAINT_PAD, Math.min(maxX, node.position.x))
    const ny = Math.max(region.y + REGION_HEADER_H_CONST + CONSTRAINT_PAD, Math.min(maxY, node.position.y))
    if (Math.abs(nx - node.position.x) < 0.5 && Math.abs(ny - node.position.y) < 0.5) return
    rf.setNodes((nds) => nds.map((n) => n.id === node.id ? { ...n, position: { x: nx, y: ny } } : n))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rf, cardW])

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
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionChange={onSelectionChange}
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
              onDragStart={onRegionDragStart}
              renamingRegionId={renamingRegionId}
              onRenameStart={setRenamingRegionId}
              onRenameCommit={commitRegionRename}
              onToggleConstraint={toggleRegionConstraint}
              onArrangeRegion={arrangeSingleRegion}
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
