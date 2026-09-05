// Canvas node renderers — card system:
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
  IconRefreshCw,
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
import { resolveLang, translate } from './i18n'

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
  const { openConnectMenu, edgesLeft, edgesRight } = useMediaCanvas()
  // Connectivity is precomputed once per SSE merge in canvas.tsx (kept as
  // stable Set references) and shipped through the canvas context. That
  // avoids the per-gesture cost of running `s.edges.some(...)` inside an
  // xyflow `useStore` selector — every pan/zoom frame would otherwise
  // re-invoke the selector for every AddSideButton × every node.
  const isConnected = side === 'right' ? edgesRight.has(id) : edgesLeft.has(id)
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

/**
 * Refresh button — appears at the bottom-center of nodes that have upstream edges.
 * Hover visibility matches the "+" side buttons. On click, triggers regeneration
 * from upstream node content via the host refresh endpoint.
 */
function RefreshSideButton({ id }: { id: string }) {
  const { refreshNode, hasUpstreamById } = useMediaCanvas()
  // Show only when this node has at least one upstream edge. We read the
  // precomputed Set from context (see AddSideButton above for the why).
  const hasUpstream = hasUpstreamById.has(id)
  // ALL hooks must run on every render — React tracks hooks by call order,
  // so any conditional `return null` must come AFTER every hook above it.
  // The previous layout declared `useState` then `return null` then
  // `useCallback`, which collapsed the hook count from 2 → 1 the moment
  // `hasUpstream` flipped false and tripped React's "Rendered fewer hooks
  // than expected" (Minified React error #310). Hoisting the callback fixes
  // it; the disabled-when-no-upstream check still prevents misuse.
  const [refreshing, setRefreshing] = useState(false)
  const handleRefresh = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (refreshing || !hasUpstream) return
    setRefreshing(true)
    try {
      await refreshNode(id)
    } catch { /* SSE reconciles on its own */ }
    finally {
      // Brief delay so the spinner doesn't flicker away too fast.
      setTimeout(() => setRefreshing(false), 600)
    }
  }, [id, refreshing, refreshNode, hasUpstream])

  if (!hasUpstream) return null

  return (
    <button
      type="button"
      className={`ms-refresh-btn nodrag`}
      aria-label="Refresh node from upstream content"
      title={refreshing ? 'Refreshing…' : 'Refresh from upstream'}
      onClick={handleRefresh}
      disabled={refreshing}
    >
      {refreshing
        ? <IconLoader className="ms-spin" size={13} strokeWidth={2} />
        : <IconRefreshCw size={13} strokeWidth={2} />
      }
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
  /** Mirrors `NodeProps.selected` so NodeShell can skip an xyflow store
   *  selector subscription per node (see the comment inside NodeShell). */
  selected?: boolean
}

/**
 * Wraps any card body with the floating title
 * row above the card, the optional hover/selected pill toolbar, target +
 * source handles (left/right), corner-delete affordance slot and the "+"
 * branch buttons on both sides.
 */
function NodeShell({ id, kind, status, title, toolbar, children, selected = false }: ShellProps) {
  const api = useMediaCanvas()
  const { cardW } = api
  const meta = KIND_META[kind]
  const Icon = meta.Icon

  const [hover, setHover] = useState(false)
  // `selected` comes from NodeProps in the parent renderers (xyflow already
  // passes it on every node wrapper). Reading it from props avoids an
  // xyflow `useStore` selector per node — selectors fire on every store
  // dispatch, including viewport pan/zoom ticks, so on large canvases the
  // per-gesture `s.nodes.find(...)` cost was a measurable jank source.
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
    <div className="canvas-card-wrap" style={cardWidthVar(cardW)} data-ms-id={id}>
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
      {/* Bottom-center refresh button — only visible when the node has upstream edges */}
      <RefreshSideButton id={id} />
      <Handle type="source" position={Position.Right} id={`${id}-out`} className="ms-handle" />
    </div>
  )
}

// ── Media cards: image / video / voice ───────────────────────────────────

type MediaKind = 'image' | 'video' | 'music'

function Placeholder({ Icon, text, error, hint }: { Icon: typeof IconImage; text: string; error?: boolean; hint?: string }) {
  return (
    <div className={`ms-placeholder ${error ? 'ms-error' : ''}`}>
      <Icon size={26} strokeWidth={1.4} />
      <span>{text}</span>
      {hint && <span className="ms-placeholder-hint">{hint}</span>}
    </div>
  )
}

interface MediaCardProps {
  kind: MediaKind
  nodeId: string
  data: MsData
}

/** Mount the media element only once its card approaches the viewport —
 *  dozens of <video> elements otherwise all start buffering at once (the
 *  "many videos → endless loading" stall on big canvases). */
function useInViewOnce(): { containerRef: (el: HTMLDivElement | null) => void; visible: boolean } {
  const [visible, setVisible] = useState(false)
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!el || visible) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) { setVisible(true); io.disconnect() }
      },
      { rootMargin: '260px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [el, visible])
  return { containerRef: setEl, visible }
}

function LazyVideo({ src, poster }: { src: string; poster?: string | null }) {
  const { containerRef, visible } = useInViewOnce()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [started, setStarted] = useState(false)
  const [posterFailed, setPosterFailed] = useState(false)

  // Before the FIRST click the card contains ONLY the poster <img> + a play
  // badge — no <video> element at all. This sidesteps Safari's unreliable
  // <video poster> attribute AND its stacking of overlay layers above a
  // <video> element; the poster is rendered exactly like a plain image card,
  // which works in every browser. The video mounts on first click (then native
  // controls take over).
  const showPoster = !started && !posterFailed && !!poster

  // Start playback once the video mounts after the click (the click itself is
  // the user gesture, so autoplay policy allows play() right after).
  useEffect(() => {
    if (!started) return
    const v = videoRef.current
    if (!v) return
    v.play().catch(() => { /* autoplay rejected — native controls still usable */ })
  }, [started])

  return (
    <div
      ref={containerRef}
      className="media-fill media-video-slot"
      title="▶ 播放"
      onClick={() => { if (!started) setStarted(true) }}
    >
      {visible ? (
        <>
          {showPoster && (
            <img
              className="media-video-poster"
              src={poster || undefined}
              alt=""
              draggable={false}
              onError={() => {
                setPosterFailed(true)
                console.warn('[media-studio] video poster failed to load:', poster)
              }}
            />
          )}
          {!started && (
            <div className="media-video-play-btn" aria-hidden="true">
              <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                <circle cx="14" cy="14" r="13" fill="rgba(0,0,0,0.55)" stroke="rgba(255,255,255,0.7)" strokeWidth="1.5" />
                <path d="M11 9.5l7 4.5-7 4.5V9.5z" fill="white" />
              </svg>
            </div>
          )}
          {started && (
            <video
              ref={videoRef}
              className="media-fill media-video"
              src={src}
              controls
              autoPlay
              playsInline
            />
          )}
        </>
      ) : (
        <span className="media-lazy-hint">▶</span>
      )}
    </div>
  )
}

function LazyAudio({ src }: { src: string }) {
  const { containerRef, visible } = useInViewOnce()
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const peaksRef = useRef<Float32Array | null>(null)
  const audioCtxRef = useRef<AudioContext | null>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [decoded, setDecoded] = useState(false)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  // While the user drags the scrub bar / waveform, `timeupdate` must not
  // write `time` back (it would fight the thumb mid-drag).
  const scrubbingRef = useRef(false)
  // Active pointer drag on the waveform canvas (for seek-by-drag).
  const waveDragRef = useRef<{ pointerId: number } | null>(null)
  // Track which src we decoded — regenerating a node produces a new
  // resultUrl → new src on the same component; stale peaks must not survive.
  const decodedSrcRef = useRef<string | null>(null)

  // Playback state is driven by the <audio> element's own events so the UI
  // can never desync from the browser (autoplay-policy rejection, buffering,
  // external pause, ended…). `scrubbingRef` gates timeupdate during a drag.
  useEffect(() => {
    if (!visible || !src) return
    const audio = audioRef.current
    if (!audio) return
    const onMeta = () => setDuration(audio.duration || 0)
    const onTime = () => {
      if (scrubbingRef.current) return
      setTime(audio.currentTime || 0)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onEnd = () => setPlaying(false)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('play', onPlay)
    audio.addEventListener('playing', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('playing', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnd)
    }
  }, [visible, src])

  // Reset transport + decode state when the underlying file changes (a
  // refresh regenerates the node → new resultUrl → new src on this very
  // component instance).
  useEffect(() => {
    if (decodedSrcRef.current === src) return
    decodedSrcRef.current = src
    peaksRef.current = null
    setDecoded(false)
    setTime(0)
    setDuration(0)
    setPlaying(false)
    setDecodeError(null)
  }, [src])

  // WebAudio decode → peaks for real waveform.
  useEffect(() => {
    if (!visible || !src || decoded) return
    let aborted = false
    const Ctor = (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) || null
    if (!Ctor) { setDecodeError('WebAudio not supported'); return }
    const ctx = new Ctor()
    audioCtxRef.current = ctx
    const cleanup = () => { try { void ctx.close() } catch { /* ignore */ } }
    ;(async () => {
      try {
        const res = await fetch(src)
        if (!res.ok) throw new Error(`fetch ${res.status}`)
        const buf = await res.arrayBuffer()
        if (aborted) return
        const audio = await ctx.decodeAudioData(buf.slice(0))
        if (aborted) return
        const data = audio.getChannelData(0)
        const bars = 96
        const stride = Math.max(1, Math.floor(data.length / bars))
        const peaks = new Float32Array(bars)
        for (let i = 0; i < bars; i += 1) {
          let peak = 0
          const start = i * stride
          const end = Math.min(data.length, start + stride)
          for (let j = start; j < end; j += 1) {
            const v = Math.abs(data[j] ?? 0)
            if (v > peak) peak = v
          }
          peaks[i] = peak
        }
        peaksRef.current = peaks
        setDecoded(true)
      } catch (e) {
        if (!aborted) setDecodeError((e as Error).message)
      } finally {
        cleanup()
        audioCtxRef.current = null
      }
    })()
    return () => { aborted = true; cleanup() }
  }, [visible, src, decoded])

  // Draw the waveform + playback progress whenever peaks / time change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1
    const cssW = canvas.clientWidth || 220
    const cssH = canvas.clientHeight || 56
    canvas.width = Math.round(cssW * dpr)
    canvas.height = Math.round(cssH * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, cssW, cssH)
    const peaks = peaksRef.current
    if (!peaks || peaks.length === 0) {
      // fallback bars while decoding
      ctx.fillStyle = 'rgba(255,255,255,0.18)'
      const fb = 32
      const bw = cssW / fb
      for (let i = 0; i < fb; i += 1) {
        const h = Math.max(2, Math.random() * (cssH * 0.7))
        ctx.fillRect(i * bw + 1, (cssH - h) / 2, Math.max(1, bw - 2), h)
      }
      return
    }
    const bars = peaks.length
    const bw = cssW / bars
    const mid = cssH / 2
    const dur = duration || 1
    const playedRatio = Math.min(1, Math.max(0, time / dur))
    // Low-level audio (ambience beds, quiet VO) has raw linear peaks far
    // below full scale (e.g. ~0.01–0.05), which would otherwise render as a
    // near-flat 2px strip with no visible waveform. Apply a display-only
    // gain so the tallest bar reaches ~92% of the canvas while preserving
    // relative dynamics; loud/regular audio (max peak ≥ 0.1 ≈ −20 dBFS)
    // is left untouched (gain = 1).
    let maxPeak = 0
    for (let i = 0; i < bars; i += 1) {
      const p = peaks[i] ?? 0
      if (p > maxPeak) maxPeak = p
    }
    let displayGain = 1
    if (maxPeak > 0 && maxPeak < 0.1) {
      displayGain = Math.min(0.92 / maxPeak, 64) // cap: don't blow up near-silence noise
    }
    for (let i = 0; i < bars; i += 1) {
      const peak = Math.min(1, (peaks[i] ?? 0) * displayGain)
      const h = Math.max(2, peak * (cssH * 0.92))
      const x = i * bw + 1
      const w = Math.max(1, bw - 2)
      const ratio = (i + 0.5) / bars
      const played = ratio <= playedRatio
      ctx.fillStyle = played ? 'rgba(124,131,255,0.95)' : 'rgba(255,255,255,0.32)'
      ctx.fillRect(x, mid - h / 2, w, h)
    }
  }, [decoded, time, duration, visible])

  const toggle = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) {
      // `playing` is driven by the audio element's own events ('play' /
      // 'playing'), so a rejected play() (autoplay policy, missing media)
      // can never leave the UI claiming to be playing.
      const p = audio.play()
      if (p) p.catch(() => { /* state stays false — no 'playing' event */ })
    } else {
      audio.pause() // 'pause' event → setPlaying(false)
    }
  }

  const scrubTo = (t: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(t)) return
    const dur = audio.duration || duration || 0
    const clamped = Math.max(0, Math.min(t, dur || t))
    audio.currentTime = clamped
    setTime(clamped)
  }

  const scrub = (e: React.ChangeEvent<HTMLInputElement>) => {
    scrubTo(Number(e.target.value))
  }

  const seekAtClientX = (clientX: number) => {
    const canvas = canvasRef.current
    const audio = audioRef.current
    if (!canvas || !audio) return
    const r = canvas.getBoundingClientRect()
    if (r.width <= 0) return
    const dur = audio.duration || duration || 0
    if (!dur) return
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
    scrubTo(ratio * dur)
  }

  // ── Waveform pointer drag-to-seek ──────────────────────────────────────
  // `.nodrag` keeps xyflow's node drag from hijacking the gesture; pointer
  // capture keeps the seek working even when the cursor leaves the canvas
  // mid-drag. `scrubbingRef` gates timeupdate so the playhead doesn't fight
  // the user's finger during the drag.
  const onWavePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!e.isPrimary) return
    e.stopPropagation()
    scrubbingRef.current = true
    waveDragRef.current = { pointerId: e.pointerId }
    const canvas = canvasRef.current
    if (canvas) { try { canvas.setPointerCapture(e.pointerId) } catch { /* already captured */ } }
    seekAtClientX(e.clientX)
  }

  const onWavePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = waveDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    e.stopPropagation()
    seekAtClientX(e.clientX)
  }

  const endWaveDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = waveDragRef.current
    if (!drag || drag.pointerId !== e.pointerId) return
    waveDragRef.current = null
    scrubbingRef.current = false
    const canvas = canvasRef.current
    if (canvas) { try { canvas.releasePointerCapture(e.pointerId) } catch { /* ignore */ } }
  }

  // Keyboard seeking: the canvas is a real slider control (tabIndex 0).
  const onWaveKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const audio = audioRef.current
    if (!audio) return
    const dur = audio.duration || duration || 0
    const cur = audio.currentTime || 0
    const step = e.shiftKey ? 10 : 1
    let next: number | null = null
    if (e.key === 'ArrowRight') next = cur + step
    else if (e.key === 'ArrowLeft') next = cur - step
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = dur
    if (next === null) return
    e.preventDefault()
    e.stopPropagation()
    scrubTo(next)
  }

  // Scrub-bar drag lock: suppress timeupdate while the thumb is being
  // dragged so a still-playing track can't yank it back mid-scrub.
  const onScrubPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (!e.isPrimary) return
    scrubbingRef.current = true
  }
  const endScrub = (e: React.PointerEvent<HTMLInputElement>) => {
    scrubbingRef.current = false
    scrubTo(Number(e.currentTarget.value))
  }

  const fmt = (t: number) => {
    if (!Number.isFinite(t)) return '0:00'
    const m = Math.floor(t / 60)
    const s = Math.floor(t % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  return (
    <div ref={containerRef} className="media-audio-fill">
      {visible ? (
        <div className="ms-audio-editor">
          <canvas
            ref={canvasRef}
            className="ms-audio-wave nodrag"
            onPointerDown={onWavePointerDown}
            onPointerMove={onWavePointerMove}
            onPointerUp={endWaveDrag}
            onPointerCancel={endWaveDrag}
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={onWaveKeyDown}
            role="slider"
            aria-label="Audio waveform"
            aria-valuemin={0}
            aria-valuemax={Math.round((duration || 0) * 1000) / 1000}
            aria-valuenow={Math.round(time * 1000) / 1000}
            aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
            tabIndex={0}
          />
          <div className="ms-audio-controls">
            <button type="button" className="ms-audio-play nodrag" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'}>
              {playing ? '❚❚' : '▶'}
            </button>
            <span className="ms-audio-time">{fmt(time)}</span>
            <input
              type="range"
              className="ms-audio-scrub nodrag"
              min={0}
              max={duration || 0}
              step={0.1}
              value={time}
              onChange={scrub}
              onPointerDown={onScrubPointerDown}
              onPointerUp={endScrub}
              onPointerCancel={endScrub}
              aria-label="Seek"
            />
            <span className="ms-audio-time">{fmt(duration)}</span>
          </div>
          {decodeError && <div className="ms-audio-err" role="status">waveform unavailable</div>}
          <audio ref={audioRef} src={src} preload="metadata" />
        </div>
      ) : (
        <span className="media-lazy-hint">▶ 音频</span>
      )}
    </div>
  )
}

function MediaCardBody({ kind, nodeId, d }: {
  kind: MediaKind
  nodeId: string
  d: MsData
}) {
  const api = useMediaCanvas()
  const status = d.status ?? 'idle'
  const raw = d.resultUrl
  const src = mediaSrc(raw, api.canvasId)
  const meta = KIND_META[kind]
  const Icon = meta.Icon

  // Image load failures swap in the error treatment without a host round trip.
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [raw])

  // Video/music running guard: if the server never writes a result, drop
  // back to an error state so the user sees a clear "stuck" treatment
  // instead of an infinite spinner. The refreshNode path has its own
  // 120s timeout — this covers the agent-patch path (e.g. generate_video
  // that timed out on the server).
  const startedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (status !== 'running') { startedAtRef.current = null; return }
    if (raw) return
    if (startedAtRef.current == null) startedAtRef.current = Date.now()
    const elapsed = Date.now() - (startedAtRef.current ?? Date.now())
    const remaining = Math.max(0, 60_000 - elapsed)
    const t = setTimeout(() => {
      api.patchData(nodeId, { status: 'error' as const, errorMsg: 'Generation timed out — refresh to retry' })
    }, remaining)
    return () => clearTimeout(t)
  }, [status, raw, nodeId, api])

  return (
    <div className={`media-card ms-media-${kind} ${raw ? 'has-result' : ''} status-${status}`}>
      <CornerDelete id={nodeId} />

      {/* Hide the image during refresh so the overlay is visible.
          When status returns to 'done' the new resultUrl will render here. */}
      {kind === 'image' && raw && !broken && status !== 'running' && (
        <img
          className="media-fill media-img"
          src={src}
          alt=""
          onError={() => setBroken(true)}
          draggable={false}
        />
      )}
      {kind === 'image' && (!raw || broken || status === 'running') && (
        <Placeholder
          Icon={Icon}
          error={broken || status === 'error'}
          text={broken ? '图片加载失败' : status === 'error' ? (d.errorMsg || '生成失败') : status === 'running' ? '生成中…' : '等待生成图片'}
          hint={!raw && status === 'idle' ? '连接上游节点后点击刷新按钮生成' : undefined}
        />
      )}

      {kind === 'video' && raw && (
        <LazyVideo src={src} poster={d.poster ? mediaSrc(d.poster as string, api.canvasId) : null} />
      )}
      {kind === 'video' && !raw && (
        <Placeholder
          Icon={Icon}
          error={status === 'error'}
          text={status === 'error' ? (d.errorMsg || '生成失败') : status === 'running' ? '生成中…' : '等待生成视频'}
          hint={status === 'idle' ? '连接上游节点后点击刷新按钮生成' : undefined}
        />
      )}

      {kind === 'music' && (
        raw ? (
          <LazyAudio src={src} />
        ) : (
          <Placeholder
            Icon={Icon}
            error={status === 'error'}
            text={status === 'error' ? (d.errorMsg || '生成失败') : status === 'running' ? '生成中…' : '等待生成音频'}
            hint={status === 'idle' ? '连接上游节点后点击刷新按钮生成' : undefined}
          />
        )
      )}

      {/* Running overlay */}
      {status === 'running' && (
        <div className="media-overlay">
          <IconLoader className="ms-spin" size={20} />
          <span className="media-overlay-hint">生成中…</span>
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
      a.href = mediaSrc(raw, api.canvasId)
      a.download = `${title || id}.${kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3'}`
      a.target = '_blank'
      a.rel = 'noopener'
      a.click()
    }

    const toolbar = useMemo<ToolbarItem[]>(() => {
      const items: ToolbarItem[] = [
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
      ]
      // M2 — "存入素材库": register this card's media into the project library.
      if (raw && api.saveToLibraryNode) {
        items.push({
          id: 'save', icon: <IconPlus size={16} strokeWidth={1.75} />,
          label: translate(resolveLang(), 'node.saveToLibrary'),
          onClick: () => api.saveToLibraryNode!(id),
        })
      }
      items.push({
        id: 'delete', icon: <IconTrash2 size={16} strokeWidth={1.75} />,
        label: 'Delete node', onClick: () => api.deleteNode(id),
      })
      return items
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [raw, id, api.saveToLibraryNode])

    return (
      <NodeShell id={id} kind={kind} status={status} title={title} toolbar={toolbar} selected={props.selected}>
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
            projectId={api.canvasId}
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
    // Hard cap: never taller than 1.5× the smaller viewport dimension.
    // (canvas.tsx maintains maxCardDimRef for this value.)
    const maxH = Math.min(1600, api.cardW > 0 ? api.cardW * 3 : 1600)
    const shownH = previewH ?? storedH

    return (
      <NodeShell id={id} kind={kind} status={status} title={title} selected={props.selected}>
        <div
          className={`canvas-node node-${kind} ms-drag-area${shownH ? ' is-fixed' : ''}`}
          style={shownH ? { height: shownH } : undefined}
        >
          <CornerDelete id={id} />
          {d.prompt && status !== 'running' && <div className="ms-doc-prompt">{d.prompt}</div>}
          <textarea
            className={`ms-doc-editor${value.trim() === '' ? ' is-empty' : ''}`}
            value={draft}
            placeholder={kind === 'note' ? 'Write a note…' : 'Script / text will appear here…'}
            rows={kind === 'note' ? 3 : 5}
            aria-label={meta.label}
            onFocus={() => { editingRef.current = true }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
          />
          {/* Empty-content warning: shown when the canonical content field
              is missing/blank AND the user is not currently typing in the
              textarea (avoid noise while they're fixing it themselves). */}
          {value.trim() === '' && !editingRef.current && (
            <div className="ms-doc-empty-warn" role="status">
              <span className="ms-doc-empty-icon" aria-hidden>⚠</span>
              <span className="ms-doc-empty-text">内容为空 — agent 尚未写入 {kind === 'note' ? 'data.content' : 'data.text'}</span>
            </div>
          )}
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
