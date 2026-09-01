// One React Flow node renderer that adapts to all five media-studio node
// kinds (text / image / video / music / note). The card layout mirrors
// franklin-canvas's NodeFrame so the visual is familiar, but the data
// comes exclusively from the host's CanvasNode.data (no separate React
// state — the host is source of truth).

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

interface Data extends Record<string, unknown> {
  kind: 'text' | 'image' | 'video' | 'music' | 'note'
  label: string
  prompt?: string
  model?: string
  resultUrl?: string
  status?: 'idle' | 'running' | 'done' | 'error'
}

const KIND_META: Record<Data['kind'], { icon: string; tint: string; sublabel: string }> = {
  text:  { icon: 'T', tint: '#7c83ff', sublabel: 'Text' },
  image: { icon: 'I', tint: '#f59e0b', sublabel: 'Image' },
  video: { icon: 'V', tint: '#ef4444', sublabel: 'Video' },
  music: { icon: 'M', tint: '#10b981', sublabel: 'Voice' },
  note:  { icon: 'N', tint: '#94a3b8', sublabel: 'Note' },
}

function MediaNodeImpl({ data, selected }: NodeProps<{ kind: Data['kind']; label: string; prompt?: string; model?: string; resultUrl?: string; status?: Data['status'] } & Record<string, unknown>>) {
  // React Flow narrows the second generic to the inferred node-data type.
  // We cast it to `Data` for the rendering below.
  const d = data as unknown as Data
  const meta = KIND_META[d.kind] ?? KIND_META.note
  const status = d.status ?? 'idle'

  return (
    <div
      className={`media-studio-node media-studio-node-${d.kind} media-studio-status-${status}`}
      style={{
        borderColor: selected ? meta.tint : 'rgba(255,255,255,0.12)',
        boxShadow: selected ? `0 0 0 2px ${meta.tint}40` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} className="media-studio-handle" />
      <Handle type="source" position={Position.Right} className="media-studio-handle" />

      <div className="media-studio-node-head" style={{ background: meta.tint }}>
        <span className="media-studio-node-icon">{meta.icon}</span>
        <span className="media-studio-node-sublabel">{meta.sublabel}</span>
        {status === 'running' && <span className="media-studio-node-spinner" />}
        {status === 'done' && <span className="media-studio-node-done">✓</span>}
        {status === 'error' && <span className="media-studio-node-error">✗</span>}
      </div>

      <div className="media-studio-node-body">
        <div className="media-studio-node-label">{d.label}</div>
        {d.prompt && <div className="media-studio-node-prompt">{truncate(d.prompt, 120)}</div>}
        {d.model && <div className="media-studio-node-model">{d.model}</div>}

        {/* Media preview — only shown when the host has produced a URL */}
        {d.resultUrl && d.kind === 'image' && (
          <img className="media-studio-preview" src={d.resultUrl} alt="" />
        )}
        {d.resultUrl && d.kind === 'video' && (
          <video className="media-studio-preview" src={d.resultUrl} controls preload="metadata" />
        )}
        {d.resultUrl && d.kind === 'music' && (
          <audio className="media-studio-preview" src={d.resultUrl} controls />
        )}
      </div>
    </div>
  )
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

export const MediaNode = memo(MediaNodeImpl)
