// Canvas node renderers — franklin-canvas-inspired card system:
//
//   • Editable title row floats ABOVE the card (kind icon · title input ·
//     status glyph) — edits commit through `renameNode` to the host store.
//   • Image / video / voice cards are media-first: the result fills the
//     whole card; placeholders + running overlay show intermediate states.
//   • Hovering or selecting a media card floats a pill toolbar above it
//     (expand · download · delete).
//   • Corner delete × on hover, "+" branch buttons on both sides, and
//     invisible-but-snap handles at left (target) / right (source) so
//     drag-to-connect still works between cards.
//
// Everything renders from the host's node.data; the host stays the single
// source of truth (SSE reconciliation in canvas.tsx).

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Handle,
  NodeToolbar,
  Position,
  useReactFlow,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react'
import {
  IconCheck,
  IconDownload,
  IconFilm,
  IconImage,
  IconLoader,
  IconMaximize2,
  IconMusic,
  IconNote,
  IconPlus,
  IconTrash2,
  IconType,
  IconX,
} from './icons'
import {
  cardWidthVar,
  mediaSrc,
  useMediaCanvas,
  type MsData,
  type MsStatus,
  type NodeKind,
} from './canvas-api'
import Lightbox from './lightbox'

// ── Kinds / catalog ──────────────────────────────────────────────────────

export interface KindMeta {
  type: NodeKind
  label: string
  desc: string
  placeholder: string
  tint: string
  Icon: typeof IconImage
}

export const NODE_CATALOG: KindMeta[] = [
  { type: 'text',  label: 'Text',  desc: 'Scripts, prompts, notes from the agent', placeholder: 'text',  tint: '#7c83ff', Icon: IconType },
  { type: 'image', label: 'Image', desc: 'Generated / uploaded image',            placeholder: 'image', tint: '#f59e0b', Icon: IconImage },
  { type: 'video', label: 'Video', desc: 'Generated short clip',                  placeholder: 'video', tint: '#ef4444', Icon: IconFilm },
  { type: 'music', label: 'Voice', desc: 'TTS voice / audio track',               placeholder: 'voice', tint: '#10b981', Icon: IconMusic },
  { type: 'note',  label: 'Note',  desc: 'Free-form note',                        placeholder: 'note',  tint: '#eab308', Icon: IconNote },
]

export const KIND_META: Record<NodeKind, KindMeta> = Object.fromEntries(
  NODE_CATALOG.map((m) => [m.type, m]),
) as Record<NodeKind, KindMeta>

export function defaultLabel(kind: NodeKind): string {
  return `New ${KIND_META[kind].label.toLowerCase()}`
}

/** Remeasure handle positions after media loads / node resizes. */
function useRefreshHandles(id: string) {
  const updateNodeInternals = useUpdateNodeInternals()
  useEffect(() => {
    const raf = requestAnimationFrame(() => updateNodeInternals(id))
    const timers = [60, 200, 500].map((ms) => setTimeout(() => updateNodeInternals(id), ms))
    updateNodeInternals(id)
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout) }
  }, [id, updateNodeInternals])
}

/**
 * Bottom-right height-resize grip for text/note cards.
 *
 * Resizing is driven by native pointer events. The grip previews the new
 * height locally on every pointermove (no host traffic mid-drag) and commits
 * ONE `updateNode({ height })` on pointer-up, so undo/redo, the SSE stream and
 * the agent's canvas_graph_view all settle on the final size.
 *
 * Why dragging this corner resizes instead of moving the node: xyflow only
 * starts a node drag from elements matching the node's `dragHandle`
 * ('.ms-drag-area' — the card body; set in projectNodes in canvas.tsx). XYDrag
 * filters each pointer-down through hasSelector(), which walks the target and
 * its ancestors up to the node wrapper — this grip is a sibling OUTSIDE
 * `.ms-drag-area`, so the filter rejects the gesture and no d3 drag begins.
 * `.nodrag` is a second, independent guard on top of that.
 */
function DocResizeGrip({ startHeight, minHeight, maxHeight, onPreview, onCommit }: {
  startHeight: number
  minHeight: number
  maxHeight: number
  /** Live preview height (flow units) while the drag is in progress. */
  onPreview: (h: number) => void
  /** Called once when the drag ends (pointer-up) with the final height. */
  onCommit: (h: number) => void
}) {
  const { screenToFlowPosition } = useReactFlow()
  const liveRef = useRef<{ startFlowY: number; startHeight: number } | null>(null)

  const clamp = (v: number) => Math.max(minHeight, Math.min(maxHeight, v))

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.isPrimary) return
    // Keep this away from xyflow's d3 drag / pane handlers (React's own
    // listener is at the root, after d3's, so this is belt-and-braces —
    // the real guard is the dragHandle filter described above).
    e.stopPropagation()
    e.preventDefault()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const start = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    liveRef.current = { startFlowY: start.y, startHeight }
    onPreview(startHeight)

    const onMove = (ev: PointerEvent) => {
      const live = liveRef.current
      if (!live) return
      const cur = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      onPreview(clamp(Math.round(live.startHeight + (cur.y - live.startFlowY))))
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
    }
    const finish = (ev: PointerEvent, cancel: boolean) => {
      const live = liveRef.current
      if (!live) return
      liveRef.current = null
      cleanup()
      if (cancel) return // keep the last persisted height
      const cur = screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
      onCommit(clamp(Math.round(live.startHeight + (cur.y - live.startFlowY))))
    }
    const onUp = (ev: PointerEvent) => finish(ev, false)
    const onCancel = (ev: PointerEvent) => finish(ev, true)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startHeight, screenToFlowPosition])

  return (
    <div
      className="ms-resize-handle-wrap nodrag"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize card height"
      title="Drag to resize height"
      onPointerDown={onPointerDown}
    />
  )
}

// ── Small building blocks ────────────────────────────────────────────────

function StatusGlyph({ status }: { status: MsStatus }) {
  if (status === 'running') return <span className="ms-title-spinner" aria-label="running" />
  if (status === 'done') return <IconCheck size={13} className="ms-title-check" aria-label="done" />
  if (status === 'error') return <span className="ms-title-error" aria-label="error">!</span>
  return <span className="ms-title-idle-dot" aria-hidden />
}

function CornerDelete({ id }: { id: string }) {
  const { deleteNode } = useMediaCanvas()
  return (
    <button
      type="button"
      className="ms-corner-delete nodrag"
      aria-label="Delete node"
      title="Delete node"
      onClick={(e) => { e.stopPropagation(); deleteNode(id) }}
    >
      <IconX size={12} strokeWidth={2.25} />
    </button>
  )
}

function AddSideButton({ id, side }: { id: string; side: 'left' | 'right' }) {
  const { openConnectMenu } = useMediaCanvas()
  // Ambient when idle, revealed on hover/selection so a branch is still
  // possible once an edge already exists.
  const isConnected = useStore((s) =>
    s.edges.some((e) => (side === 'right' ? e.source === id : e.target === id)),
  )
  return (
    <button
      type="button"
      className={`ms-add-side ms-add-${side} nodrag ${isConnected ? 'is-connected' : ''}`}
      aria-label={side === 'right' ? 'Add node to the right' : 'Add node to the left'}
      title="Add a connected node"
      onClick={(e) => {
        e.stopPropagation()
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
        const anchorX = side === 'right' ? r.left - 14 : r.right + 14
        openConnectMenu({ fromId: id, side, x: anchorX, y: r.top + r.height / 2 })
      }}
    >
      <IconPlus size={18} strokeWidth={2.75} />
    </button>
  )
}

interface ToolbarItem {
  id: string
  icon: ReactNode
  label: string
  disabled?: boolean
  onClick?: () => void
}

// ── Node frame shell ─────────────────────────────────────────────────────

interface ShellProps {
  id: string
  kind: NodeKind
  status: MsStatus
  title: string
  /** Toolbar shown on hover / selection (media cards). Omit → hidden. */
  toolbar?: ToolbarItem[]
  children: ReactNode
}

/**
 * Wraps any card body with the franklin-style chrome: the floating title
 * row above the card, the optional hover/selected pill toolbar, target +
 * source handles (left/right), corner-delete affordance slot and the "+"
 * branch buttons on both sides.
 */
function NodeShell({ id, kind, status, title, toolbar, children }: ShellProps) {
  const api = useMediaCanvas()
  const { cardW } = api
  const meta = KIND_META[kind]
  const Icon = meta.Icon

  const [hover, setHover] = useState(false)
  const selected = useStore((s) => s.nodes.find((n) => n.id === id)?.selected ?? false)
  const visible = hover || selected

  const [draft, setDraft] = useState<string | null>(null)
  const shown = draft ?? title
  const commitTitle = () => {
    const v = draft?.trim()
    setDraft(null)
    if (v && v !== title) api.renameNode(id, v)
  }

  const showPill = visible && !!toolbar && toolbar.length > 0

  return (
    <div className="canvas-card-wrap" style={cardWidthVar(cardW)}>
      <Handle type="target" position={Position.Left} id={`${id}-in`} className="ms-handle" />
      <div
        className="node-frame-wrap"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      >
        {/* Editable title row — floats above the card */}
        <div className="ms-title-row">
          <span className="ms-title-icon" style={{ color: meta.tint }}>
            <Icon size={12} strokeWidth={1.75} />
          </span>
          <input
            className="ms-title-input"
            value={shown}
            placeholder={meta.placeholder}
            aria-label={`${meta.label} node title`}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTitle}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') { setDraft(null); (e.target as HTMLInputElement).blur() }
              e.stopPropagation()
            }}
          />
          <StatusGlyph status={status} />
        </div>

        {showPill && (
          <NodeToolbar position={Position.Top} offset={36} className="ms-node-toolbar" isVisible>
            <div className="ms-toolbar-pill-row">
              {toolbar!.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`ms-tb-btn ${it.disabled ? 'is-disabled' : ''}`}
                  aria-label={it.label}
                  aria-disabled={it.disabled || undefined}
                  title={it.label}
                  onClick={(e) => { e.stopPropagation(); if (!it.disabled) it.onClick?.() }}
                >
                  {it.icon}
                </button>
              ))}
            </div>
          </NodeToolbar>
        )}

        {children}
      </div>

      <AddSideButton id={id} side="left" />
      <AddSideButton id={id} side="right" />
      <Handle type="source" position={Position.Right} id={`${id}-out`} className="ms-handle" />
    </div>
  )
}

// ── Media cards: image / video / voice ───────────────────────────────────

type MediaKind = 'image' | 'video' | 'music'

function Placeholder({ Icon, text, error }: { Icon: typeof IconImage; text: string; error?: boolean }) {
  return (
    <div className={`ms-placeholder ${error ? 'ms-error' : ''}`}>
      <Icon size={26} strokeWidth={1.4} />
      <span>{text}</span>
    </div>
  )
}

interface MediaCardProps {
  kind: MediaKind
  nodeId: string
  data: MsData
}

function MediaCardBody({ kind, nodeId, d }: {
  kind: MediaKind
  nodeId: string
  d: MsData
}) {
  const status = d.status ?? 'idle'
  const raw = d.resultUrl
  const src = mediaSrc(raw)
  const meta = KIND_META[kind]
  const Icon = meta.Icon

  // Image load failures swap in the error treatment without a host round trip.
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [raw])

  return (
    <div className={`media-card ms-media-${kind} ${raw ? 'has-result' : ''} status-${status}`}>
      <CornerDelete id={nodeId} />

      {kind === 'image' && raw && !broken && (
        <img
          className="media-fill media-img"
          src={src}
          alt=""
          onError={() => setBroken(true)}
          draggable={false}
        />
      )}
      {kind === 'image' && (!raw || broken) && (
        <Placeholder
          Icon={Icon}
          error={broken || status === 'error'}
          text={broken ? 'Image failed to load' : status === 'error' ? (d.errorMsg || 'Generation failed') : 'No image yet'}
        />
      )}

      {kind === 'video' && raw && (
        <video className="media-fill media-video" src={src} controls preload="metadata" playsInline />
      )}
      {kind === 'video' && !raw && (
        <Placeholder
          Icon={Icon}
          error={status === 'error'}
          text={status === 'error' ? (d.errorMsg || 'Generation failed') : 'No video yet'}
        />
      )}

      {kind === 'music' && (
        raw ? (
          <div className="media-audio-fill">
            <audio src={src} controls />
          </div>
        ) : (
          <Placeholder
            Icon={Icon}
            error={status === 'error'}
            text={status === 'error' ? (d.errorMsg || 'Generation failed') : 'No voice yet'}
          />
        )
      )}

      {/* Running overlay */}
      {status === 'running' && (
        <div className="media-overlay">
          <IconLoader className="ms-spin" size={20} />
          <span className="media-overlay-hint">Generating…</span>
        </div>
      )}
    </div>
  )
}

/** One renderer for all three media kinds; kind is fixed per node type. */
function makeMediaNode(kind: MediaKind) {
  function MediaCardNode(props: NodeProps) {
    const { id, data } = props
    useRefreshHandles(id)
    const api = useMediaCanvas()
    const d = data as unknown as MsData
    const status = d.status ?? 'idle'
    const title = d.label ?? KIND_META[kind].placeholder
    const raw = d.resultUrl
    const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
    const { getNodes } = useReactFlow()

    const navLightbox = (dir: 1 | -1) => {
      const peers = getNodes().filter(
        (n) => n.type === kind && typeof (n.data as MsData).resultUrl === 'string',
      )
      if (peers.length < 2 || !lightboxSrc) return
      const idx = peers.findIndex((n) => (n.data as MsData).resultUrl === lightboxSrc)
      const next = peers[(idx + dir + peers.length) % peers.length]
      setLightboxSrc((next.data as MsData).resultUrl as string)
    }

    const download = () => {
      if (!raw) return
      const a = document.createElement('a')
      a.href = mediaSrc(raw)
      a.download = `${title || id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`
      a.target = '_blank'
      a.rel = 'noopener'
      a.click()
    }

    const toolbar = useMemo<ToolbarItem[]>(() => {
      const items = [
        {
          id: 'expand', icon: <IconMaximize2 size={16} strokeWidth={1.75} />,
          label: raw ? 'Expand' : 'Expand (no result yet)', disabled: !raw,
          onClick: () => { if (raw) setLightboxSrc(raw) },
        },
        {
          id: 'download', icon: <IconDownload size={16} strokeWidth={1.75} />,
          label: raw ? 'Download' : 'Download (no result yet)', disabled: !raw,
          onClick: download,
        },
        {
          id: 'delete', icon: <IconTrash2 size={16} strokeWidth={1.75} />,
          label: 'Delete node', onClick: () => api.deleteNode(id),
        },
      ]
      return items
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [raw, id])

    return (
      <NodeShell id={id} kind={kind} status={status} title={title} toolbar={toolbar}>
        <MediaCardBody kind={kind} nodeId={id} d={d} />
        {lightboxSrc && (
          <Lightbox
            src={lightboxSrc}
            kind={kind === 'music' ? 'audio' : kind}
            filename={`${title || id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`}
            meta={{
              title,
              prompt: d.prompt,
              model: d.model,
            }}
            onClose={() => setLightboxSrc(null)}
            onPrev={() => navLightbox(-1)}
            onNext={() => navLightbox(1)}
          />
        )}
      </NodeShell>
    )
  }
  return memo(MediaCardNode)
}

// ── Text / note cards ────────────────────────────────────────────────────

/** Shared editable-textarea card for `text` (agent output) & `note`. */
function makeDocNode(kind: 'text' | 'note') {
  function DocNode(props: NodeProps) {
    const { id, data } = props
    useRefreshHandles(id)
    const api = useMediaCanvas()
    const d = data as unknown as MsData
    const meta = KIND_META[kind]
    const status = d.status ?? 'idle'
    const title = d.label ?? meta.placeholder
    const field: 'text' | 'content' = kind === 'text' ? 'text' : 'content'
    const value = (d[field] as string | undefined) ?? ''
    const storedH = typeof d.height === 'number' ? d.height : undefined

    const [draft, setDraft] = useState(value)
    const editingRef = useRef(false)
    useEffect(() => {
      if (!editingRef.current) setDraft(value)
    }, [value])

    const commit = () => {
      editingRef.current = false
      const v = draft
      if (v !== value) api.patchData(id, { [field]: v })
    }

    // Preview height while the bottom-right grip is dragged; null = not
    // resizing, and data.height (or the per-kind default) decides the size.
    const [previewH, setPreviewH] = useState<number | null>(null)
    const defaultH = kind === 'note' ? 90 : 120
    const minH = kind === 'note' ? 64 : 84
    const maxH = 1600
    const shownH = previewH ?? storedH

    return (
      <NodeShell id={id} kind={kind} status={status} title={title}>
        <div
          className={`canvas-node node-${kind} ms-drag-area${shownH ? ' is-fixed' : ''}`}
          style={shownH ? { height: shownH } : undefined}
        >
          <CornerDelete id={id} />
          {d.prompt && status !== 'running' && <div className="ms-doc-prompt">{d.prompt}</div>}
          <textarea
            className="ms-doc-editor"
            value={draft}
            placeholder={kind === 'note' ? 'Write a note…' : 'Script / text will appear here…'}
            rows={kind === 'note' ? 3 : 5}
            aria-label={meta.label}
            onFocus={() => { editingRef.current = true }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
          {status === 'running' && (
            <div className="ms-doc-running"><IconLoader className="ms-spin" size={12} /> generating…</div>
          )}
        </div>
        <DocResizeGrip
          startHeight={shownH ?? defaultH}
          minHeight={minH}
          maxHeight={maxH}
          onPreview={setPreviewH}
          onCommit={(h) => {
            setPreviewH(null)
            if (h !== storedH) api.patchData(id, { height: h })
          }}
        />
      </NodeShell>
    )
  }
  return memo(DocNode)
}

export const TextNode = makeDocNode('text')
export const NoteNode = makeDocNode('note')
export const ImageNode = makeMediaNode('image')
export const VideoNode = makeMediaNode('video')
export const MusicNode = makeMediaNode('music')

export const NODE_TYPES = {
  text: TextNode,
  image: ImageNode,
  video: VideoNode,
  music: MusicNode,
  note: NoteNode,
} as const
