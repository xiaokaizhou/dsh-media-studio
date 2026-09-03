// Project bar (M1) — the canvas top bar that owns the multi-project layer.
//
// Hosts the "项目 ▾" menu (new / open / recent ≤10 / rename / delete with
// dependency analysis), the current-project indicator, and a zh/en toggle.
// The registry is server-authoritative: we fetch once, then follow the
// projects SSE stream; every mutation POSTs to the host routes and applies
// the returned registry snapshot immediately (SSE echoes it too).
//
// The bar renders above the existing <Canvas>, which is remounted (keyed) on
// project switch so its SSE subscription and viewport follow the active
// project.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  apiCreateProject,
  apiDeleteProject,
  apiFetchDependents,
  apiOpenFolder,
  apiOpenProject,
  apiRenameProject,
  fetchProjects,
  subscribeProjects,
  type DependentsAPI,
  type ProjectMetaAPI,
  type RegistryAPI,
} from './projects-api'
import { resolveLang, storeLang, translate, type Lang } from './i18n'
import { IconPlus, IconTrash2, IconX } from './icons'
import AssetLibraryPanel from './asset-panel'
import GlobalSearch from './global-search'
import { getRevisions, subscribeRevisions, previewRevision, type RevEntry } from './revision-bus'
import { subscribeSummary, subscribeConn } from './canvas-bus'

// ── tiny inline icons (keep this file dependency-light) ────────────────────

function PencilIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}
function FolderIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </svg>
  )
}
function ClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 6v6l4 2" />
    </svg>
  )
}

// ── i18n react binding ─────────────────────────────────────────────────────

function useI18n(): { lang: Lang; t: (key: string, vars?: Record<string, string | number>) => string; switchLang: (l: Lang) => void } {
  const [lang, setLang] = useState<Lang>(resolveLang())
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  )
  const switchLang = useCallback((next: Lang) => {
    storeLang(next)
    setLang(next)
  }, [])
  return { lang, t, switchLang }
}

// ── shared bits ────────────────────────────────────────────────────────────

const NAME_FORBIDDEN = /[\\/:*?"<>|]/

function validateName(name: string): string | null {
  const s = name.trim()
  if (!s) return 'dlg.name.required'
  if (s.length > 64) return 'dlg.name.long'
  if (NAME_FORBIDDEN.test(s)) return 'dlg.name.invalid'
  return null
}

function shortDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  } catch {
    return iso
  }
}

type MenuView = 'home' | 'open' | 'recent'
type Dialog =
  | { kind: 'new' }
  | { kind: 'rename'; projectId: string; name: string }
  | { kind: 'delete'; projectId: string; name: string }
  | null

export interface ProjectAppProps {
  /** Canvas to render before the registry loads / when no project exists. */
  fallbackCanvasId?: string
  /** Creates the <Canvas> element for the active project id. */
  renderCanvas: (canvasId: string) => ReactNode
}

// ── Live canvas badge (version · state) for the top bar ──────────────────────
// Click opens the revision-history dropdown: scrub the progress bar or hit
// play/pause to preview past versions of the canvas (client-side playback —
// nothing is written to the server; closing returns to the live canvas).

type LiveConn = 'connecting' | 'open' | 'reconnecting'

const PLAY_STEP_MS = 700

function LiveBadge({ canvasId }: { canvasId: string }) {
  const { t } = useI18n()
  const [version, setVersion] = useState(0)
  const [count, setCount] = useState(0)
  const [conn, setConn] = useState<LiveConn>('connecting')
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const [revs, setRevs] = useState<RevEntry[]>(() => getRevisions(canvasId))
  const [sel, setSel] = useState(-1) // index into revs; -1 = latest
  const [playing, setPlaying] = useState(false)
  const badgeRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const revsRef = useRef<RevEntry[]>(revs)
  revsRef.current = revs

  // Live SSE subscription: version + node count + connection state. Goes
  // through the shared canvas-bus so this badge and CanvasView share one
  // EventSource — two parallel connections against the same endpoint
  // were doubling the work for every patch and (more importantly) were
  // a measurable source of UI jank just from *opening* an empty canvas
  // tab.
  useEffect(() => {
    const offSummary = subscribeSummary(canvasId, (info) => {
      setVersion(info.version)
      setCount(info.count)
    })
    const offConn = subscribeConn(canvasId, setConn)
    return () => { offSummary(); offConn() }
  }, [canvasId])

  const close = () => {
    setOpen(false)
    setPlaying(false)
    previewRevision(canvasId, null) // exit playback → live canvas
  }

  // Refresh revisions from the bus while the panel is open.
  useEffect(() => {
    if (!open) return
    setRevs(getRevisions(canvasId))
    const off = subscribeRevisions(canvasId, () => setRevs(getRevisions(canvasId)))
    return off
  }, [open, canvasId])

  // Outside click / Escape closes (and exits preview).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const el = e.target as Node | null
      if (!el) return
      if (badgeRef.current?.contains(el) || panelRef.current?.contains(el)) return
      close()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, canvasId])

  const lastIdx = revs.length > 0 ? revs.length - 1 : -1
  const curIdx = sel === -1 ? lastIdx : Math.min(sel, lastIdx)

  // Playback loop: step through versions oldest → newest.
  useEffect(() => {
    if (!playing) return
    const start = curIdx === lastIdx || curIdx < 0 ? 0 : curIdx
    let i = Math.max(0, start)
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      const list = revsRef.current
      if (i >= list.length) {
        setPlaying(false)
        setSel(-1)
        previewRevision(canvasId, null)
        return
      }
      setSel(i)
      previewRevision(canvasId, list[i])
      i += 1
      timer = setTimeout(tick, PLAY_STEP_MS)
    }
    tick()
    return () => { if (timer) clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, canvasId])

  const openPanel = () => {
    setRevs(getRevisions(canvasId))
    const el = badgeRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setAnchor({ x: Math.max(6, r.right - 300), y: r.bottom + 6 })
    }
    setSel(-1)
    setOpen(true)
  }

  const seek = (i: number) => {
    setPlaying(false)
    const list = revsRef.current
    const target = Math.max(0, Math.min(list.length - 1, i))
    setSel(target)
    const r = list[target]
    if (r) previewRevision(canvasId, r)
  }

  const cls = conn === 'open' ? 'is-open' : conn === 'reconnecting' ? 'is-reconnecting' : ''
  return (
    <>
      <button
        ref={badgeRef}
        type="button"
        className={`ms-pb-live is-clickable ${cls}`}
        title={`v${version} · ${count} nodes · SSE ${conn} — 历史版本`}
        onClick={openPanel}
      >
        <span className="ms-pb-live-dot" />
        <span className="ms-pb-sep" aria-hidden>·</span>
        <span className="ms-pb-live-v">v{version}</span>
        <span className="ms-pb-caret">▾</span>
      </button>
      {open && anchor && createPortal(
        <div ref={panelRef} className="ms-pb-hist" style={{ left: anchor.x, top: anchor.y }} role="dialog" aria-label={t('hist.title')}>
          <div className="ms-pb-hist-head">
            <span>{t('hist.title')} · v{version}</span>
            <button type="button" className="ms-pb-icon-btn" onClick={close} aria-label={t('common.close')}>
              <IconX size={13} />
            </button>
          </div>
          <div className="ms-pb-hist-ctrl">
            <button
              type="button"
              className="ms-pb-play"
              onClick={() => setPlaying((p) => !p)}
              disabled={revs.length < 2}
              aria-label={playing ? t('hist.pause') : t('hist.play')}
            >
              {playing ? '❚❚' : '▶'}
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, lastIdx)}
              step={1}
              value={Math.max(0, curIdx)}
              disabled={revs.length < 2}
              aria-label={t('hist.progress')}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <span className="ms-pb-hist-v">{curIdx >= 0 ? `v${revs[curIdx].version}` : '—'}</span>
          </div>
          <div className="ms-pb-hist-list">
            {revs.length === 0 ? (
              <div className="ms-pb-empty">{t('hist.none')}</div>
            ) : (
              [...revs].reverse().map((r, revIdx) => {
                const i = revs.length - 1 - revIdx
                const when = new Date(r.at).toLocaleTimeString()
                const nodes = r.snap.graph.nodes.length
                return (
                  <button
                    key={r.version}
                    type="button"
                    className={`ms-pb-hist-row ${i === curIdx ? 'is-on' : ''}`}
                    onClick={() => seek(i)}
                    title={`${when} · ${nodes} nodes`}
                  >
                    <span className="ms-pb-hist-row-v">v{r.version}</span>
                    <span className="ms-pb-hist-row-meta">{when} · {nodes}</span>
                  </button>
                )
              })
            )}
          </div>
          <div className="ms-pb-hist-foot">
            <button type="button" className="ms-btn-cancel" onClick={close}>{t('hist.backToLive')}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}

// ── main component ─────────────────────────────────────────────────────────

// ── styles (injected once; token set mirrors canvas-styles' .ms-menu-backdrop
//    so the bar and its portals render even before the canvas sheet loads) ──

const PROJECT_STYLES = `
.media-studio-project,
.media-studio-project .ms-menu-backdrop {
  --ms-bg: var(--dsw-alias-bg-base, #0c0e13);
  --ms-bg2: var(--dsw-alias-bg-layer-1, #14171d);
  --ms-panel: var(--dsw-alias-bg-overlay, rgba(26, 29, 38, 0.96));
  --ms-panel-soft: rgba(255,255,255,0.08);
  --ms-fg: var(--dsw-alias-label-primary, #eceef2);
  --ms-fg-dim: var(--dsw-alias-label-secondary, rgba(255,255,255,0.68));
  --ms-fg-faint: var(--dsw-alias-label-tertiary, rgba(255,255,255,0.42));
  --ms-accent: var(--dsw-alias-interactive-bg-hover-accent, #7c83ff);
  --ms-border: var(--dsw-alias-border-l2, rgba(255,255,255,0.11));
  --ms-border-strong: var(--dsw-alias-border-l4, rgba(255,255,255,0.24));
  --ms-error: #ef4444;
  --ms-ok: #4ade80;
  --ms-shadow-lg: 0 14px 40px rgba(0,0,0,0.5), 0 5px 12px rgba(0,0,0,0.35);
}
body:not([data-ds-dark-theme]) .media-studio-project,
body:not([data-ds-dark-theme]) .media-studio-project .ms-menu-backdrop {
  --ms-panel-soft: rgba(15,17,22,0.07);
  --ms-shadow-lg: 0 14px 40px rgba(15,17,22,0.16), 0 5px 12px rgba(15,17,22,0.10);
}
.media-studio-project { width:100%; height:100%; display:flex; flex-direction:column; min-height:0; background: var(--ms-bg); color: var(--ms-fg); font: var(--dsw-font-s-14, 13px/1.45 system-ui, -apple-system, sans-serif); }
.ms-pb-bar { flex:none; display:flex; align-items:center; gap:8px; padding:5px 10px; border-bottom:1px solid var(--ms-border); background: var(--ms-bg2); user-select:none; }
.ms-pb-root { display:inline-flex; align-items:center; gap:6px; height:26px; padding:0 9px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--ms-fg-dim); font:600 12px/1 system-ui,sans-serif; cursor:pointer; }
.ms-pb-root:hover { background:var(--ms-panel-soft); color:var(--ms-fg); }
.ms-pb-root svg { color:var(--ms-accent); }
.ms-pb-caret { font-size:10px; color:var(--ms-fg-faint); }
.ms-pb-cur { font:600 11.5px/1 system-ui,sans-serif; color:var(--ms-fg-dim); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:60%; }
.ms-pb-muted { color:var(--ms-fg-faint); font-size:11.5px; }
.ms-pb-host { flex:1; min-height:0; position:relative; display:flex; }
.ms-pb-host > div { flex:1; min-width:0; }
.ms-pb-menu { position:fixed; width:276px; max-height:min(560px, calc(100vh - 96px)); display:flex; flex-direction:column; background:var(--ms-panel); border:1px solid var(--ms-border-strong); border-radius:12px; box-shadow:var(--ms-shadow-lg); padding:6px; z-index:60; color:var(--ms-fg); font-size:12.5px; }
.ms-pb-menu-item { display:flex; align-items:center; gap:8px; width:100%; padding:7px 8px; border:none; border-radius:8px; background:transparent; color:var(--ms-fg-dim); font:inherit; cursor:pointer; text-align:left; }
.ms-pb-menu-item:hover:not(:disabled) { background:var(--ms-panel-soft); color:var(--ms-fg); }
.ms-pb-menu-item:disabled { opacity:0.4; cursor:not-allowed; }
.ms-pb-menu-item svg { color:var(--ms-accent); flex:none; }
.ms-pb-item-new { color:var(--ms-fg); font-weight:600; }
.ms-pb-sub-arrow { margin-left:auto; color:var(--ms-fg-faint); font-size:14px; line-height:1; }
.ms-pb-back { color:var(--ms-fg-faint); font-weight:600; }
.ms-pb-sep { height:1px; margin:6px 4px; background:var(--ms-border); }
.ms-pb-section-label { padding:2px 8px 4px; color:var(--ms-fg-faint); font-size:10.5px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; }
.ms-pb-scroll { flex:1; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:1px; }
.ms-pb-project-row { display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:8px; cursor:pointer; }
.ms-pb-project-row:hover { background:var(--ms-panel-soft); }
.ms-pb-project-row.is-active { background:var(--ms-accent); box-shadow:none; }
.ms-pb-project-row.is-active .ms-pb-row-name, .ms-pb-project-row.is-active .ms-pb-icon-btn { color:#0b0d12; }
.ms-pb-row-name { flex:1; min-width:0; display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:var(--ms-fg); }
.ms-pb-active-dot { flex:none; width:6px; height:6px; border-radius:50%; background:var(--ms-ok); }
.ms-pb-row-actions { display:none; align-items:center; gap:2px; flex:none; }
.ms-pb-project-row:hover .ms-pb-row-actions, .ms-pb-project-row:focus-within .ms-pb-row-actions { display:inline-flex; }
.ms-pb-icon-btn { display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px; padding:0; border:none; border-radius:6px; background:transparent; color:var(--ms-fg-faint); cursor:pointer; }
.ms-pb-icon-btn:hover { background:var(--ms-panel-soft); color:var(--ms-fg); }
.ms-pb-icon-btn.is-danger:hover { color:var(--ms-error); background:rgba(239,68,68,0.14); }
.ms-pb-chip { flex:none; padding:1px 6px; border-radius:99px; background:var(--ms-panel-soft); color:var(--ms-fg-faint); font-size:10px; }
.ms-pb-empty { padding:14px 10px; color:var(--ms-fg-faint); font-size:12px; text-align:center; }
.ms-pb-lang-row { display:flex; align-items:center; justify-content:space-between; padding:2px 8px 4px; }
.ms-pb-lang-btns { display:flex; gap:2px; }
.ms-pb-lang-btns button { border:none; border-radius:6px; padding:3px 8px; background:transparent; color:var(--ms-fg-dim); cursor:pointer; font:600 11px/1 system-ui,sans-serif; }
.ms-pb-lang-btns button.is-on { background:var(--ms-accent); color:#0b0d12; }
.ms-pb-dialog { position:fixed; left:50%; top:44%; transform:translate(-50%,-50%); width:min(400px, calc(100vw - 44px)); background:var(--ms-panel); border:1px solid var(--ms-border-strong); border-radius:14px; box-shadow:var(--ms-shadow-lg); display:flex; flex-direction:column; color:var(--ms-fg); font-size:12.5px; }
.ms-pb-dialog-head { display:flex; align-items:center; justify-content:space-between; padding:12px 14px 6px; font-weight:700; font-size:13px; }
.ms-pb-dialog-body { padding:8px 14px; display:flex; flex-direction:column; gap:8px; }
.ms-pb-delete-summary { color:var(--ms-fg); }
.ms-pb-refs-block { border:1px solid rgba(239,68,68,0.35); background:rgba(239,68,68,0.08); border-radius:10px; padding:8px 10px; display:flex; flex-direction:column; gap:4px; }
.ms-pb-refs-header { color:var(--ms-error); font-weight:600; font-size:12px; }
.ms-pb-refs-row { display:flex; align-items:center; gap:6px; color:var(--ms-fg-dim); }
.ms-pb-cascade-label { margin-top:2px; color:var(--ms-fg-dim); font-weight:600; }
.ms-pb-radio, .ms-pb-check { display:flex; align-items:flex-start; gap:8px; color:var(--ms-fg-dim); line-height:1.45; cursor:pointer; }
.ms-pb-radio input, .ms-pb-check input { margin-top:2px; accent-color:var(--ms-accent); }
.ms-pb-trash-hint { color:var(--ms-fg-faint); font-size:11.5px; }
.ms-pb-err { color:var(--ms-error); font-size:12px; }
.ms-pb-blocked { color:#f59e0b; font-size:12px; }
.ms-pb-input { width:100%; box-sizing:border-box; padding:7px 9px; border-radius:8px; border:1px solid var(--ms-border-strong); background:var(--ms-bg2); color:var(--ms-fg); font:inherit; }
.ms-pb-input:focus { outline:none; border-color:var(--ms-accent); }
.ms-pb-dialog-actions { display:flex; justify-content:flex-end; gap:8px; padding:8px 14px 12px; }
.ms-btn-primary { padding:6px 14px; border:none; border-radius:8px; background:var(--ms-accent); color:#0b0d12; font:600 12px/1 system-ui,sans-serif; cursor:pointer; }
.ms-btn-primary:hover { filter:brightness(1.1); }
.ms-btn-primary:disabled, .ms-btn-danger:disabled, .ms-btn-cancel:disabled { opacity:0.5; cursor:not-allowed; }
/* Top bar layout: left (menu+project) · centered search · right live badge */
.ms-pb-bar { position: relative; }
.ms-pb-left { display:flex; align-items:center; gap:8px; min-width:0; max-width:44%; }
.ms-pb-center { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; align-items:center; pointer-events:none; z-index:6; }
.ms-pb-center > * { pointer-events:auto; }
.ms-pb-right { display:flex; align-items:center; margin-left:auto; flex:none; padding-left:6px; }
.ms-pb-live { display:inline-flex; align-items:center; gap:5px; font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:0.04em; text-transform:uppercase; color:var(--ms-fg-faint); white-space:nowrap; }
.ms-pb-live-dot { width:6px; height:6px; border-radius:50%; background:#6b6b73; }
.ms-pb-live.is-open .ms-pb-live-dot { background:var(--ms-ok); box-shadow:0 0 6px rgba(74,222,128,0.8); }
.ms-pb-live.is-reconnecting .ms-pb-live-dot { background:var(--ms-error); }
@media (max-width: 560px) { .ms-pb-cur { display:none; } }
.ms-pb-live.is-clickable { border:none; background:transparent; padding:2px 6px; border-radius:8px; color:var(--ms-fg-faint); font:600 10.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:0.04em; text-transform:uppercase; cursor:pointer; }
.ms-pb-live.is-clickable:hover { background:var(--ms-panel-soft); color:var(--ms-fg); }
.ms-pb-live-dot { margin-left:4px; }
.ms-pb-caret { margin-left:4px; font-size:9px; color:var(--ms-fg-faint); }
.ms-pb-hist { position:fixed; width:300px; max-height:min(460px, calc(100vh - 90px)); display:flex; flex-direction:column; background:var(--ms-panel); border:1px solid var(--ms-border-strong); border-radius:12px; box-shadow:var(--ms-shadow-lg); color:var(--ms-fg); z-index:80; font:12px/1.4 system-ui,sans-serif; overflow:hidden; }
.ms-pb-hist-head { display:flex; align-items:center; justify-content:space-between; padding:10px 12px 6px; font-weight:700; }
.ms-pb-hist-ctrl { display:flex; align-items:center; gap:8px; padding:4px 12px 8px; border-bottom:1px solid var(--ms-border); }
.ms-pb-play { flex:none; width:26px; height:26px; border-radius:8px; border:none; background:var(--ms-panel-soft); color:var(--ms-fg); cursor:pointer; font-size:11px; display:flex; align-items:center; justify-content:center; }
.ms-pb-play:hover { background:var(--ms-accent); color:#0b0d12; }
.ms-pb-play:disabled { opacity:0.4; cursor:not-allowed; }
.ms-pb-hist-ctrl input[type=range] { flex:1; min-width:0; accent-color:var(--ms-accent); }
.ms-pb-hist-v { flex:none; font:600 11px/1 ui-monospace,Menlo,monospace; color:var(--ms-fg-dim); }
.ms-pb-hist-list { flex:1; min-height:0; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:2px; }
.ms-pb-hist-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:5px 8px; border:none; border-radius:8px; background:transparent; color:var(--ms-fg-dim); font:inherit; cursor:pointer; text-align:left; }
.ms-pb-hist-row:hover { background:var(--ms-panel-soft); color:var(--ms-fg); }
.ms-pb-hist-row.is-on { background:var(--ms-accent); color:#0b0d12; font-weight:600; }
.ms-pb-hist-row-v { font-family:ui-monospace,Menlo,monospace; font-size:11.5px; }
.ms-pb-hist-row-meta { color:var(--ms-fg-faint); font-size:11px; }
.ms-pb-hist-row.is-on .ms-pb-hist-row-meta { color:rgba(11,13,18,0.7); }
.ms-pb-hist-foot { flex:none; display:flex; justify-content:flex-end; padding:8px 12px 10px; }
.ms-pb-sep { color:var(--ms-fg-faint); margin:0 2px; font-size:11px; line-height:1; }
.ms-pb-live-v { font-weight:700; }
`

let projectStylesInjected = false
function injectProjectBarStyles(): void {
  if (projectStylesInjected) return
  projectStylesInjected = true
  try {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-media-studio-projectbar'
    style.textContent = PROJECT_STYLES
    document.head.appendChild(style)
  } catch { /* ignore */ }
}

// ── styles (injected once) ────────────────────────────────────────────────

export default function ProjectApp(props: ProjectAppProps): ReactNode {
  const fallbackCanvasId = props.fallbackCanvasId ?? 'main'
  const { lang, t, switchLang } = useI18n()

  useEffect(() => {
    injectProjectBarStyles()
  }, [])

  const [registry, setRegistry] = useState<RegistryAPI | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [view, setView] = useState<MenuView>('home')
  const [dialog, setDialog] = useState<Dialog>(null)
  const [busy, setBusy] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const rootBtnRef = useRef<HTMLButtonElement | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)

  const activeId = registry?.activeId ?? null
  const activeProject = registry?.projects.find((p) => p.id === activeId) ?? null
  const canvasId = activeId || fallbackCanvasId

  // Initial registry + follow the projects SSE stream.
  useEffect(() => {
    let alive = true
    const load = () => void fetchProjects().then((res) => {
      if (res.ok && alive) {
        setRegistry({ activeId: res.data.activeId, recent: res.data.recent, projects: res.data.projects })
      }
    })
    load()
    const off = subscribeProjects({ onRegistry: (reg) => alive && setRegistry(reg) })
    return () => {
      alive = false
      off()
    }
  }, [])

  // Manual refresh: re-fetch the registry on demand (useful when the
  // disabled state looks stuck — e.g. SSE dropped while the user was
  // afk, or fetchProjects was racy with mount). Surface via the menu
  // so the user can recover without reloading the whole tab.
  const refreshRegistry = useCallback(() => {
    void fetchProjects().then((res) => {
      if (res.ok) setRegistry({ activeId: res.data.activeId, recent: res.data.recent, projects: res.data.projects })
    })
  }, [])

  // Close popups on Escape.
  useEffect(() => {
    if (!menuOpen && !dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setDialog(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuOpen, dialog])

  const toggleMenu = useCallback(() => {
    if (menuOpen) {
      setMenuOpen(false)
      return
    }
    const el = rootBtnRef.current
    if (el) {
      const r = el.getBoundingClientRect()
      setAnchor({ x: Math.max(6, Math.min(r.left, window.innerWidth - 280)), y: r.bottom + 6 })
    }
    setView('home')
    setMenuOpen(true)
  }, [menuOpen])

  const applyRegistry = useCallback((reg: RegistryAPI) => {
    setRegistry(reg)
    setMenuOpen(false)
    setDialog(null)
    setBusy(false)
  }, [])

  const handleCreate = useCallback(async (name: string): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await apiCreateProject(name || undefined)
      if (res.ok) {
        applyRegistry(res.data.registry)
        return true
      }
      return false
    } finally {
      setBusy(false)
    }
  }, [applyRegistry])

  const handleOpen = useCallback(async (id: string): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await apiOpenProject(id)
      if (res.ok) {
        applyRegistry(res.data.registry)
        return true
      }
      return false
    } finally {
      setBusy(false)
    }
  }, [applyRegistry])

  const handleRename = useCallback(async (id: string, name: string): Promise<boolean> => {
    setBusy(true)
    try {
      const res = await apiRenameProject(id, name)
      if (res.ok) {
        applyRegistry(res.data.registry)
        return true
      }
      return false
    } finally {
      setBusy(false)
    }
  }, [applyRegistry])

  const handleDelete = useCallback(async (id: string, mode: 'trash' | 'permanent', cascade: 'cancel' | 'break-refs' | 'migrate-shared') => {
    setBusy(true)
    const res = await apiDeleteProject(id, { mode, cascade })
    if (res.ok) applyRegistry(res.data.registry)
    setBusy(false)
    return res.ok
  }, [applyRegistry])

  const pickFolder = useCallback(async (): Promise<FileList | null | undefined> => {
    // undefined = both pickers unavailable, caller should fall back to
    //   manual path input (tier 3).
    // null = user cancelled (AbortError / explicit cancel).
    // FileList = success, has at least one entry.
    // 1) File System Access API (Chrome 86+ / Edge).
    try {
      const w = window as unknown as { showDirectoryPicker?: () => Promise<{ values: () => AsyncIterable<{ kind: string; getFile: () => Promise<File> }> }> }
      if (typeof w.showDirectoryPicker === 'function') {
        const handle = await w.showDirectoryPicker()
        const files: File[] = []
        for await (const entry of handle.values()) {
          if (entry.kind === 'file') files.push(await entry.getFile())
        }
        // Fabricate a FileList-like object so the caller's `webkitRelativePath` lookup works.
        return Object.assign(document.createElement('input'), { files }) as unknown as FileList
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return null
      // showDirectoryPicker isn't available or threw — try the fallback.
    }
    // 2) <input webkitdirectory> (Safari + older Chrome + Hermes embedded webview).
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      ;(input as unknown as Record<string, unknown>).webkitdirectory = ''
      input.setAttribute('directory', '')
      input.style.display = 'none'
      let settled = false
      const finish = (result: FileList | null | undefined) => {
        if (settled) return
        settled = true
        document.body.removeChild(input)
        resolve(result)
      }
      input.onchange = () => finish(input.files && input.files.length ? input.files : null)
      // Some browsers (Firefox) fire cancel on Escape inside the picker.
      ;(input as unknown as { oncancel?: () => void }).oncancel = () => finish(null)
      document.body.appendChild(input)
      input.click()
      // 60s hard timeout: if nothing happens (Hermes embedded view silently
      // dropping the dialog), bail to tier 3 manual path input.
      setTimeout(() => finish(undefined), 60_000)
    })
  }, [])

const [pathPromptOpen, setPathPromptOpen] = useState(false)

const handleOpenFolder = useCallback(async () => {
    // Three-tier folder picker:
    //   1) File System Access API showDirectoryPicker (Chrome 86+ / Edge)
    //   2) <input webkitdirectory> fallback (Firefox, older Chrome, Hermes
    //      embedded Chromium, etc.)
    //   3) Manual absolute-path text input (last-resort — Hermes desktop's
    //      embedded webview may block both pickers above)
    // Tier 1 + 2 only return folder metadata in-browser; tier 3 accepts the
    // path string the user types. None of these upload files anywhere —
    // they only return a folder name to register as a project.
    setMenuOpen(false)

    // Tier 1 + 2: try the in-browser picker.
    const files = await pickFolder()
    if (files && files.length) {
      const folderName = files[0].webkitRelativePath.split('/')[0] || `project-${Date.now().toString(36)}`
      await commitOpen(folderName)
      return
    }
    if (files === null) {
      // Tier 1 + 2 threw a real error (user cancel signal); don't ask again.
      return
    }
    // Tier 3: fallback path prompt.
    setPathPromptOpen(true)
  }, [applyRegistry])

  const commitOpen = useCallback(async (folderName: string) => {
    setBusy(true)
    try {
      const res = await apiOpenFolder(folderName)
      if (res.ok) applyRegistry(res.data.registry)
      else console.warn('[media-studio] open-folder failed:', res.error)
    } finally {
      setBusy(false)
    }
  }, [applyRegistry])

  const submitPathPrompt = useCallback(async (rawPath: string) => {
    const trimmed = rawPath.trim()
    if (!trimmed) return
    const tail = trimmed.split('/').filter(Boolean).pop() || trimmed
    setPathPromptOpen(false)
    await commitOpen(tail)
  }, [commitOpen])

  // Delete-dialog internals (dependency analysis lives here).
  function DeleteDialogContent({ target }: { target: NonNullable<Extract<Dialog, { kind: 'delete' }>> }) {
    const [deps, setDeps] = useState<DependentsAPI | null>(null)
    const [analyzing, setAnalyzing] = useState(true)
    const [cascade, setCascade] = useState<'migrate-shared' | 'break-refs' | null>(null)
    const [permanent, setPermanent] = useState(false)
    const [err, setErr] = useState<string | null>(null)

    useEffect(() => {
      let alive = true
      setAnalyzing(true)
      void apiFetchDependents(target.projectId).then((res) => {
        if (!alive) return
        setAnalyzing(false)
        if (res.ok) setDeps(res.data.dependents)
        else setErr(t('err.generic', { message: res.error }))
      })
      return () => {
        alive = false
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [target.projectId])

    const hasRefs = (deps?.totalRefs ?? 0) > 0
    const canDelete = !hasRefs || cascade !== null
    const doDelete = async () => {
      if (!canDelete) return
      const ok = await handleDelete(target.projectId, permanent ? 'permanent' : 'trash', cascade ?? 'cancel')
      if (!ok) {
        setErr(t('err.blocked.project'))
      }
    }

    return (
      <div className="ms-pb-dialog" role="alertdialog" aria-modal="true" aria-label={t('dlg.delete.title')}>
        <div className="ms-pb-dialog-head">
          <span>{t('dlg.delete.title')}</span>
          <button type="button" className="ms-pb-icon-btn" onClick={() => setDialog(null)} aria-label={t('common.close')}>
            <IconX size={13} />
          </button>
        </div>
        <div className="ms-pb-dialog-body">
          <div className="ms-pb-delete-summary">{t('dlg.delete.summary', { name: target.name })}</div>
          {analyzing ? (
            <div className="ms-pb-muted">{t('dlg.delete.analyzing')}</div>
          ) : hasRefs && deps ? (
            <>
              <div className="ms-pb-refs-block">
                <div className="ms-pb-refs-header">{t('dlg.delete.refsHeader')}</div>
                {deps.hits.map((h, i) => (
                  <div key={i} className="ms-pb-refs-row">
                    <FolderIcon size={11} />
                    <span>{t('dlg.delete.refsDetail', { project: h.refProjectName, nodes: h.nodeIds.length })}</span>
                  </div>
                ))}
                {deps.copyConsumers.length > 0 && (
                  <div className="ms-pb-muted" style={{ marginTop: 8 }}>
                    {t('dlg.delete.copiesHint')}
                    {deps.copyConsumers.map((c) => ` ${c.projectName} (×${c.count})`).join('、')}
                  </div>
                )}
              </div>
              <div className="ms-pb-cascade-label">{t('dlg.delete.cascadeHint')}</div>
              <label className="ms-pb-radio">
                <input type="radio" name="cascade" checked={cascade === 'migrate-shared'} onChange={() => { setCascade('migrate-shared'); setErr(null) }} />
                <span>{t('dlg.delete.cascade.migrate')}</span>
              </label>
              <label className="ms-pb-radio">
                <input type="radio" name="cascade" checked={cascade === 'break-refs'} onChange={() => { setCascade('break-refs'); setErr(null) }} />
                <span>{t('dlg.delete.cascade.break')}</span>
              </label>
              {err && <div className="ms-pb-err">{err}</div>}
              {!canDelete && <div className="ms-pb-blocked">{t('dlg.delete.blocked')}</div>}
            </>
          ) : (
            <>
              <div className="ms-pb-muted">{t('dlg.delete.noRefs')}</div>
              {err && <div className="ms-pb-err">{err}</div>}
            </>
          )}
          <div className="ms-pb-trash-hint">{t('dlg.delete.trashHint')}</div>
          <label className="ms-pb-check">
            <input type="checkbox" checked={permanent} onChange={(e) => setPermanent(e.target.checked)} />
            <span>{t('dlg.delete.permanent')}</span>
          </label>
        </div>
        <div className="ms-pb-dialog-actions">
          <button type="button" className="ms-btn-cancel" onClick={() => setDialog(null)} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="ms-btn-danger"
            disabled={busy || !canDelete}
            onClick={() => void doDelete()}
          >
            {busy ? t('common.loading') : t('dlg.delete.confirm')}
          </button>
        </div>
      </div>
    )
  }

  // Name input dialog (create / rename share it).
  function NameDialogContent({ dlg }: { dlg: Extract<Dialog, { kind: 'new' } | { kind: 'rename' }> }) {
    const [name, setName] = useState(dlg.kind === 'rename' ? dlg.name : '')
    const [err, setErr] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement | null>(null)
    useEffect(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, [])
    const submit = async () => {
      const vErr = validateName(name)
      if (vErr) { setErr(t(vErr)); return }
      if (dlg.kind === 'new') {
        const ok = await handleCreate(name)
        if (!ok) setErr(t('err.generic', { message: 'create failed' }))
      } else {
        const ok = await handleRename(dlg.projectId, name)
        if (!ok) setErr(t('err.generic', { message: 'rename failed' }))
      }
    }
    return (
      <div className="ms-pb-dialog" role="dialog" aria-modal="true" aria-label={t(dlg.kind === 'new' ? 'dlg.new.title' : 'dlg.rename.title')}>
        <div className="ms-pb-dialog-head">
          <span>{t(dlg.kind === 'new' ? 'dlg.new.title' : 'dlg.rename.title')}</span>
          <button type="button" className="ms-pb-icon-btn" onClick={() => setDialog(null)} aria-label={t('common.close')}>
            <IconX size={13} />
          </button>
        </div>
        <div className="ms-pb-dialog-body">
          <input
            ref={inputRef}
            className="ms-pb-input"
            value={name}
            placeholder={t('project.name.placeholder')}
            onChange={(e) => { setName(e.target.value); setErr(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submit()
            }}
          />
          {err && <div className="ms-pb-err">{err}</div>}
        </div>
        <div className="ms-pb-dialog-actions">
          <button type="button" className="ms-btn-cancel" onClick={() => setDialog(null)} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button type="button" className="ms-btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? t('common.loading') : (dlg.kind === 'rename' ? t('common.rename') : t('common.create'))}
          </button>
        </div>
      </div>
    )
  }

  // Project list (open view or recent view).
  function ProjectList({ items, onPick }: { items: ProjectMetaAPI[]; onPick: (id: string) => void }) {
    if (items.length === 0) {
      return <div className="ms-pb-empty">{t('project.open.empty')}</div>
    }
    return (
      <div className="ms-pb-scroll">
        {items.map((p) => (
          <div key={p.id} className="ms-pb-project-row" role="button" tabIndex={0} onClick={() => void onPick(p.id)}>
            <span className="ms-pb-row-name">
              {p.name}
              {p.id === activeId && <span className="ms-pb-active-dot" />}
            </span>
            <span className="ms-pb-row-actions" onClick={(e) => e.stopPropagation()}>
              {p.legacy && <span className="ms-pb-chip">{t('project.legacy')}</span>}
              <button type="button" className="ms-pb-icon-btn" title={t('project.rename')} onClick={() => setDialog({ kind: 'rename', projectId: p.id, name: p.name })}>
                <PencilIcon />
              </button>
              <button type="button" className="ms-pb-icon-btn is-danger" title={t('project.delete')} onClick={() => setDialog({ kind: 'delete', projectId: p.id, name: p.name })}>
                <IconTrash2 size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    )
  }

  const recentItems = (registry?.recent ?? []).map((id) => registry?.projects.find((p) => p.id === id)).filter((p): p is ProjectMetaAPI => !!p)
  const allItems = registry?.projects.slice().sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1)) ?? []

  return (
    <div className="media-studio-project">
      <div className="ms-pb-bar">
        <div className="ms-pb-left">
          <button ref={rootBtnRef} type="button" className="ms-pb-root" onClick={toggleMenu} aria-haspopup="menu" aria-expanded={menuOpen}>
            <FolderIcon size={13} />
            <span>{t('project.menu')}</span>
            <span className="ms-pb-caret">▾</span>
          </button>
          {activeProject ? (
            <span className="ms-pb-cur" title={`${t('project.current')}: ${activeProject.name}`}>
              {t('project.current')}: {activeProject.name}
            </span>
          ) : (
            <span className="ms-pb-cur ms-pb-muted">{t('project.open.empty')}</span>
          )}
        </div>
        <div className="ms-pb-center">
          <GlobalSearch registry={registry} activeId={activeId} />
        </div>
        <div className="ms-pb-right">
          <LiveBadge canvasId={canvasId} />
        </div>
      </div>
      <div className="ms-pb-host">{props.renderCanvas(canvasId)}</div>

      {menuOpen && anchor && createPortal(
        <div className="ms-menu-backdrop" onClick={() => setMenuOpen(false)}>
          <div
            className="ms-pb-menu"
            style={{ left: anchor.x, top: anchor.y }}
            role="menu"
            aria-label={t('project.menu.title')}
            onClick={(e) => e.stopPropagation()}
          >
            {view === 'home' ? (
              <>
                <button type="button" role="menuitem" className="ms-pb-menu-item ms-pb-item-new" onClick={() => setDialog({ kind: 'new' })}>
                  <IconPlus size={13} />
                  <span>{t('project.new')}</span>
                </button>
                <button type="button" role="menuitem" className="ms-pb-menu-item" onClick={() => handleOpenFolder()}>
                  <FolderIcon size={13} />
                  <span>{t('project.open')}</span>
                  <span className="ms-pb-sub-arrow">›</span>
                </button>
                <button type="button" role="menuitem" className="ms-pb-menu-item" onClick={() => setView('recent')} disabled={recentItems.length === 0}>
                  <ClockIcon size={13} />
                  <span>{t('project.recent')}</span>
                  <span className="ms-pb-sub-arrow">›</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="ms-pb-menu-item"
                  disabled={!activeId}
                  onClick={() => {
                    if (!activeId) return
                    setLibraryOpen(true)
                    setMenuOpen(false)
                  }}
                >
                  <span style={{ fontSize: 13, lineHeight: 1 }}>▤</span>
                  <span>{t('project.library')}</span>
                </button>
                <div className="ms-pb-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="ms-pb-menu-item"
                  onClick={() => { refreshRegistry(); setMenuOpen(false) }}
                >
                  <span style={{ fontSize: 13, lineHeight: 1 }}>↻</span>
                  <span>{t('project.refresh')}</span>
                </button>
                <div className="ms-pb-sep" />
                <div className="ms-pb-section-label">{t('project.current')}</div>
                {activeProject ? (
                  <div className="ms-pb-project-row is-active" onClick={() => setMenuOpen(false)}>
                    <span className="ms-pb-row-name">{activeProject.name}</span>
                    <span className="ms-pb-row-actions" onClick={(e) => e.stopPropagation()}>
                      <button type="button" className="ms-pb-icon-btn" title={t('project.rename')} onClick={() => setDialog({ kind: 'rename', projectId: activeProject.id, name: activeProject.name })}>
                        <PencilIcon />
                      </button>
                      <button type="button" className="ms-pb-icon-btn is-danger" title={t('project.delete')} onClick={() => setDialog({ kind: 'delete', projectId: activeProject.id, name: activeProject.name })}>
                        <IconTrash2 size={12} />
                      </button>
                    </span>
                  </div>
                ) : (
                  <div className="ms-pb-empty">{t('project.open.empty')}</div>
                )}
                <div className="ms-pb-sep" />
                <div className="ms-pb-lang-row">
                  <span className="ms-pb-section-label">{t('project.lang')}</span>
                  <div className="ms-pb-lang-btns">
                    <button type="button" className={lang === 'zh' ? 'is-on' : ''} onClick={() => switchLang('zh')}>中文</button>
                    <button type="button" className={lang === 'en' ? 'is-on' : ''} onClick={() => switchLang('en')}>EN</button>
                  </div>
                </div>
              </>
            ) : (
              <>
                <button type="button" className="ms-pb-menu-item ms-pb-back" onClick={() => setView('home')}>
                  <span className="ms-pb-sub-arrow" style={{ transform: 'rotate(180deg)' }}>›</span>
                  <span>{view === 'recent' ? t('project.recent.title') : t('project.open.title')}</span>
                </button>
                <ProjectList items={view === 'recent' ? recentItems : allItems} onPick={handleOpen} />
              </>
            )}
          </div>
        </div>,
        document.body,
      )}

      {dialog && createPortal(
        <div className="ms-menu-backdrop" onClick={() => !busy && setDialog(null)}>
          {dialog.kind === 'delete' ? (
            <DeleteDialogContent target={dialog} />
          ) : (
            <NameDialogContent dlg={dialog} />
          )}
        </div>,
        document.body,
      )}

      {libraryOpen && activeId && (
        <AssetLibraryPanel projectId={activeId} registry={registry} onClose={() => setLibraryOpen(false)} />
      )}

      {pathPromptOpen && <PathPromptDialog onSubmit={submitPathPrompt} onClose={() => setPathPromptOpen(false)} busy={busy} />}
    </div>
  )
}

/** Tier-3 fallback: when neither File System Access API nor webkitdirectory
 *  surfaces a working dialog (Hermes desktop's embedded webview drops both),
 *  show a text input so the user can paste the absolute folder path.
 *  Nothing is uploaded — the path string is just used to derive a project
 *  name for registration. */
function PathPromptDialog({ onSubmit, onClose, busy }: { onSubmit: (path: string) => Promise<void> | void; onClose: () => void; busy: boolean }) {
  const [val, setVal] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return (
    <div className="ms-menu-backdrop" onClick={() => !busy && onClose()}>
      <div className="ms-pb-dialog" role="dialog" aria-modal="true" aria-label="输入文件夹路径" onClick={(e) => e.stopPropagation()}>
        <div className="ms-pb-dialog-head">
          <span>输入文件夹路径</span>
          <button type="button" className="ms-pb-icon-btn" onClick={onClose} aria-label="关闭">
            <IconX size={13} />
          </button>
        </div>
        <div className="ms-pb-dialog-body">
          <div className="ms-pb-muted" style={{ fontSize: 12 }}>
            浏览器无法弹出系统选目录对话框,请直接粘贴本地文件夹的绝对路径(例如 <code>/Users/xiao/Movies/douyin-viral-drama</code>)。
          </div>
          <input
            ref={inputRef}
            type="text"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void onSubmit(val) }}
            placeholder="/path/to/folder"
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              border: '1px solid var(--ms-border-strong)',
              background: 'var(--ms-surface, transparent)',
              color: 'var(--ms-fg)',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 12,
              outline: 'none',
            }}
          />
        </div>
        <div className="ms-pb-dialog-actions">
          <button type="button" className="ms-btn-cancel" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className="ms-btn-primary" onClick={() => void onSubmit(val)} disabled={busy || !val.trim()}>确定</button>
        </div>
      </div>
    </div>
  )
}
