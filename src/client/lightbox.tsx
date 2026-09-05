// Fullscreen preview for a finished media node (image / video / voice).
// Dark backdrop, centered media, meta row
// (prompt · model · created), prev/next among sibling nodes of the same kind,
// and a download button. Rendered through a portal into document.body.

import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconDownload, IconX } from './icons'
import { mediaSrc } from './canvas-api'

export interface LightboxMeta {
  title?: string
  prompt?: string
  model?: string
  extra?: string
  createdAt?: number | string
}

interface Props {
  src: string
  kind: 'image' | 'video' | 'audio'
  meta?: LightboxMeta
  filename?: string
  onClose: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Project id for resolving bare `assets/...` relative paths. */
  projectId?: string
}

async function downloadUrl(url: string, suggestedName: string) {
  try {
    const r = await fetch(url, { mode: 'cors' })
    const blob = await r.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = suggestedName
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(objectUrl)
  } catch {
    // CORS may block a direct fetch — fall back to a plain link click; the
    // browser then handles whatever the server allows.
    const a = document.createElement('a')
    a.href = url
    a.download = suggestedName
    a.target = '_blank'
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

function MetaRow({ meta }: { meta?: LightboxMeta }) {
  if (!meta) return null
  const bits: string[] = []
  if (meta.title) bits.push(meta.title)
  if (meta.model) bits.push(meta.model)
  if (meta.extra) bits.push(meta.extra)
  return (
    <div className="lightbox-meta">
      {meta.prompt && <div className="lightbox-meta-prompt">{meta.prompt}</div>}
      {bits.length > 0 && <div className="lightbox-meta-bits">{bits.map((b, i) => <span key={i}>{b}</span>)}</div>}
    </div>
  )
}

function download(raw: string, suggestedName: string, projectId?: string) {
  // mediaSrc() maps stored local paths onto the host proxy — download from
  // the rendered form so fetch() can reach it.
  void downloadUrl(mediaSrc(raw, projectId), suggestedName)
}

export default function Lightbox({ src, kind, meta, filename = 'media', onClose, onPrev, onNext, projectId }: Props) {
  // ESC + arrow navigation, and a body scroll lock (the plugin owns the tab
  // body; adding one class is enough to freeze panning behind the preview).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowLeft') onPrev?.()
      if (e.key === 'ArrowRight') onNext?.()
    }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('media-studio-previewing')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('media-studio-previewing')
    }
  }, [onClose, onPrev, onNext])

  const media: ReactNode =
    kind === 'image' ? (
      <img className="lightbox-media lightbox-img" src={mediaSrc(src, projectId)} alt={meta?.prompt ?? meta?.title ?? ''} />
    ) : kind === 'video' ? (
      <video className="lightbox-media lightbox-video" src={mediaSrc(src, projectId)} controls autoPlay playsInline />
    ) : (
      <div className="lightbox-media lightbox-audio">
        <audio src={mediaSrc(src, projectId)} controls autoPlay />
      </div>
    )

  return createPortal(
    <div className="lightbox-backdrop" role="dialog" aria-modal="true" aria-label={meta?.title ?? 'Preview'} onClick={onClose}>
      <button type="button" className="lightbox-close" aria-label="Close preview" onClick={onClose}>
        <IconX size={20} />
      </button>
      {onPrev && (
        <button type="button" className="lightbox-nav lightbox-prev" aria-label="Previous" onClick={(e) => { e.stopPropagation(); onPrev() }}>‹</button>
      )}
      <div className="lightbox-stage" onClick={(e) => e.stopPropagation()}>
        {media}
        <div className="lightbox-footer">
          <MetaRow meta={meta} />
          <button type="button" className="lightbox-download" onClick={() => download(src, filename, projectId)}>
            <IconDownload size={14} /> Download
          </button>
        </div>
      </div>
      {onNext && (
        <button type="button" className="lightbox-nav lightbox-next" aria-label="Next" onClick={(e) => { e.stopPropagation(); onNext() }}>›</button>
      )}
    </div>,
    document.body,
  )
}
