// Canvas — React Flow editor for the media-studio canvas tab.
//
// Pattern follows franklin-canvas's CanvasView.tsx but is trimmed for
// the DSH client (single canvas, no router, no project switcher — those
// live in the DSH shell, not the canvas tab).
//
// Render shape: nodes + edges come from `useCanvasState()` which
// subscribes to the SSE stream exposed by the host plugin. Every patch
// the agent runs lands here as a state update; React Flow reconciles.
//
// Toolbar: a thin strip at the top adds a node by POSTing a local
// addNode op via the canvas REST surface. (The agent still drives the
// authoritative path — this is for manual exploration.)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node as RFNode,
  type Edge as RFEdge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { MediaNode } from './nodes'

export interface CanvasNodeData extends Record<string, unknown> {
  kind: 'text' | 'image' | 'video' | 'music' | 'note'
  label: string
  prompt?: string
  model?: string
  resultUrl?: string
  status?: 'idle' | 'running' | 'done' | 'error'
  width?: number
  height?: number
}

export interface CanvasSnapshot {
  graph: {
    nodes: Array<{
      id: string
      type: string
      label: string
      data: CanvasNodeData
      position?: { x: number; y: number }
    }>
    edges: Array<{ id: string; source: string; target: string }>
  }
  version: number
}

interface CanvasProps {
  host: HTMLElement
}

/**
 * Subscribe to the host's canvas SSE stream and accumulate the latest
 * snapshot. Returns a state object that's safe to read synchronously from
 * the render path (no ref juggling).
 */
function useCanvasState(canvasId: string) {
  const [snap, setSnap] = useState<CanvasSnapshot | null>(null)
  useEffect(() => {
    const es = new EventSource(`/api/media-studio/canvas/sse?canvasId=${encodeURIComponent(canvasId)}`)
    es.addEventListener('canvas-patch', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data)
        if (data?.type === 'canvas-patch' && data.graph) {
          setSnap({ graph: data.graph, version: data.version ?? 0 })
        }
      } catch { /* ignore malformed */ }
    })
    es.addEventListener('error', () => {
      // EventSource auto-reconnects; just log.
      console.warn('[media-studio] canvas SSE error, will retry')
    })
    return () => es.close()
  }, [canvasId])
  return snap
}

export function Canvas({ host }: CanvasProps) {
  const canvasId = useMemo(() => readCanvasIdFromHost(host) ?? 'main', [host])
  const snap = useCanvasState(canvasId)

  // React Flow needs the node type map registered exactly once per page.
  const nodeTypes = useMemo(() => ({
    text: MediaNode,
    image: MediaNode,
    video: MediaNode,
    music: MediaNode,
    note: MediaNode,
  }), [])

  // Project the host graph onto React Flow's expected shape.
  const initialNodes: RFNode<CanvasNodeData>[] = useMemo(() => snap?.graph.nodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: n.position ?? { x: 0, y: 0 },
    data: { kind: n.type, ...n.data },
  })) ?? [], [snap])

  const initialEdges: RFEdge[] = useMemo(() => snap?.graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
  })) ?? [], [snap])

  const [nodes, setNodes, onNodesChangeBase] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(initialEdges)

  // When the snapshot changes (new SSE event), replace the local copy.
  // We never merge: the host is the source of truth.
  useEffect(() => {
    if (!snap) return
    setNodes(initialNodes)
    setEdges(initialEdges)
  }, [snap?.version]) // eslint-disable-line react-hooks/exhaustive-deps

  const onNodesChange = useCallback((changes: NodeChange[]) => onNodesChangeBase(changes), [onNodesChangeBase])
  const onEdgesChange = useCallback((changes: EdgeChange[]) => onEdgesChangeBase(changes), [onEdgesChangeBase])

  // Manual connect — debounced POST back to the host so the agent and
  // other tabs see the same edge. We optimistically render via React Flow
  // and rely on the host's broadcast to reconcile if it disagrees.
  const onConnect = useCallback((conn: Connection) => {
    if (!conn.source || !conn.target) return
    setEdges((eds) => addEdge({ ...conn, id: `e-${Date.now()}` }, eds))
    void postOps(canvasId, [{ op: 'connect', from: conn.source, to: conn.target }])
  }, [canvasId, setEdges])

  // Toolbar — add one node per click. (The agent does most of the
  // heavy lifting; this is for human exploration.)
  const onAdd = useCallback((kind: 'text' | 'image' | 'video' | 'music' | 'note') => {
    const id = `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const position = pickFreePosition(nodes)
    void postOps(canvasId, [{ op: 'addNode', type: kind, label: `New ${kind}`, data: { kind, status: 'idle' }, position }])
    // Optimistic render — host SSE will catch up and reconcile.
    setNodes((ns) => [...ns, {
      id, type: kind, position, data: { kind, label: `New ${kind}`, status: 'idle' },
    }])
  }, [canvasId, nodes, setNodes])

  return (
    <div className="media-studio-canvas" style={{ width: '100%', height: '100%' }}>
      <Toolbar onAdd={onAdd} version={snap?.version ?? 0} />
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
      >
        <Background gap={24} size={1} />
        <Controls />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  )
}

// ─── helpers ──────────────────────────────────────────────────────────────

function Toolbar({ onAdd, version }: { onAdd: (k: 'text' | 'image' | 'video' | 'music' | 'note') => void; version: number }) {
  const kinds: Array<['text' | 'image' | 'video' | 'music' | 'note', string]> = [
    ['text', 'Text'],
    ['image', 'Image'],
    ['video', 'Video'],
    ['music', 'Voice'],
    ['note', 'Note'],
  ]
  return (
    <div className="media-studio-toolbar">
      {kinds.map(([k, label]) => (
        <button key={k} type="button" onClick={() => onAdd(k)}>{label}</button>
      ))}
      <span className="media-studio-version">v{version}</span>
    </div>
  )
}

function readCanvasIdFromHost(host: HTMLElement): string | null {
  const attr = host.getAttribute('data-canvas-id')
  return attr || null
}

/** Place a new node below the lowest existing node so it doesn't overlap. */
function pickFreePosition(nodes: RFNode[]): { x: number; y: number } {
  if (nodes.length === 0) return { x: 60, y: 60 }
  let maxY = 0
  for (const n of nodes) {
    const y = (n.position?.y ?? 0) + 200
    if (y > maxY) maxY = y
  }
  return { x: 60, y: maxY + 40 }
}

/** Fire-and-forget POST of canvas ops to the host's REST endpoint. The
 *  host's apply() runs synchronously; the SSE broadcast will reconcile
 *  the local state once the call returns. */
async function postOps(canvasId: string, ops: unknown[]): Promise<void> {
  try {
    await fetch('/api/media-studio/canvas/patch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ canvasId, ops }),
    })
  } catch (e) {
    console.error('[media-studio] canvas patch failed:', (e as Error).message)
  }
}
