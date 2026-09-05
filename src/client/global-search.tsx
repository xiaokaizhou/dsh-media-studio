// Global real-time asset search (M3) — the top-bar search box + grouped
// dropdown. Typing "林晚" shows hits grouped into 当前项目 / 其他项目, with
// library assets and (ranked-lower) finished canvas media. "+ 添加" soft-
// references a library asset into the current canvas; canvas-media results
// get "复制入库" (hard copy into the current project's library).

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useI18n } from './use-i18n-hook'
import { mediaSrc } from './canvas-api'
import {
  apiSearch,
  apiAddSoftRef,
  apiImportCanvas,
  type SearchItemAPI,
  type SearchResultAPI,
} from './search-api'
import type { RegistryAPI } from './projects-api'
import { IconX } from './icons'

let gsStylesInjected = false
function injectSearchStyles(): void {
  if (gsStylesInjected) return
  gsStylesInjected = true
  try {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-media-studio-search'
    style.textContent = `
.ms-gs { position:relative; display:flex; align-items:center; }
.ms-gs-input { width:clamp(96px, 22vw, 200px); box-sizing:border-box; height:26px; padding:0 8px; border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.12)); border-radius:8px; background:var(--dsw-alias-bg-layer-2,#1c1f27); color:var(--dsw-alias-label-primary,#eceef2); font:13px/1 system-ui,sans-serif; }
.ms-gs-input::placeholder { color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.4)); }
.ms-gs-input:focus { outline:none; border-color:var(--dsw-alias-interactive-bg-hover-accent,#7c83ff); }
.ms-gs-panel { position:fixed; width:min(430px, calc(100vw - 24px)); max-height:min(520px, calc(100vh - 120px)); display:flex; flex-direction:column; background:var(--dsw-alias-bg-overlay, rgba(24,26,34,0.98)); border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.22)); border-radius:12px; box-shadow:0 14px 40px rgba(0,0,0,0.5); color:var(--dsw-alias-label-primary,#eceef2); z-index:80; overflow:hidden; font-size:12.5px; }
.ms-gs-groups { flex:1; overflow-y:auto; padding:6px; }
.ms-gs-group-title { padding:6px 8px 4px; color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); font-size:10.5px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase; }
.ms-gs-row { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:9px; cursor:default; }
.ms-gs-row:hover { background:rgba(255,255,255,0.07); }
.ms-gs-thumb { flex:none; width:46px; height:46px; border-radius:8px; overflow:hidden; background:rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; }
.ms-gs-thumb img { width:100%; height:100%; object-fit:cover; }
.ms-gs-thumb .ms-gs-thumb-null { font-size:18px; color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.35)); }
.ms-gs-main { flex:1; min-width:0; }
.ms-gs-name { display:flex; align-items:center; gap:6px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:600; }
.ms-gs-meta { color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.ms-gs-badge { flex:none; border-radius:99px; padding:0 6px; background:rgba(74,222,128,0.14); color:#86efac; font-size:10.5px; }
.ms-gs-chip { flex:none; border-radius:99px; padding:0 5px; background:rgba(255,255,255,0.08); color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.5)); font-size:10px; }
.ms-gs-add { flex:none; border:none; border-radius:7px; padding:4px 9px; background:var(--dsw-alias-interactive-bg-hover-accent,#7c83ff); color:#0b0d12; font:600 11.5px/1 system-ui,sans-serif; cursor:pointer; }
.ms-gs-add:hover { filter:brightness(1.12); }
.ms-gs-add:disabled { opacity:0.55; cursor:not-allowed; }
.ms-gs-foot { flex:none; border-top:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1)); padding:6px 10px; color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); font-size:11px; display:flex; align-items:center; justify-content:space-between; gap:8px; }
.ms-gs-msg { color:#86efac; }
.ms-gs-err { color:#fca5a5; }
.ms-gs-empty { padding:26px 12px; text-align:center; color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); line-height:1.7; }
`
    document.head.appendChild(style)
  } catch { /* ignore */ }
}

function Thumb({ item, activeId }: { item: SearchItemAPI; activeId: string | null }) {
  const [failed, setFailed] = useState(false)
  if (!item.srcRaw || failed) {
    return <div className="ms-gs-thumb-null">{item.kind === 'audio' || item.kind === 'music' ? '♪' : item.kind === 'video' || item.kind === 'clip' ? '▶' : '🖼'}</div>
  }
  return <img src={mediaSrc(item.srcRaw, activeId ?? undefined)} alt="" loading="lazy" onError={() => setFailed(true)} />
}

export default function GlobalSearch({ registry, activeId }: {
  registry: RegistryAPI | null
  activeId: string | null
}) {
  const { t } = useI18n()
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [res, setRes] = useState<SearchResultAPI | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { injectSearchStyles() }, [])

  const refreshAnchor = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setAnchor({ x: Math.max(8, Math.min(r.left, window.innerWidth - 450)), y: r.bottom + 5 })
  }, [])

  // ⌘/Ctrl+K focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const tgt = e.target as HTMLElement | null
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) return
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        refreshAnchor()
        setOpen(true)
      }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [refreshAnchor])

  // Auto-close when clicking anywhere outside the input and the dropdown.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (ev: PointerEvent) => {
      const t = ev.target as Node | null
      if (!t) return
      const inp = inputRef.current
      const panel = panelRef.current
      if (inp && inp.contains(t)) return
      if (panel && panel.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown)
    return () => window.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  // Debounced live search.
  useEffect(() => {
    if (!q.trim()) { setRes(null); setErr(null); setLoading(false); return }
    let alive = true
    setLoading(true)
    setErr(null)
    const h = setTimeout(async () => {
      const r = await apiSearch(q.trim(), activeId)
      if (!alive) return
      setLoading(false)
      if (r.ok) {
        setRes(r.data)
        setMsg(null)
      } else {
        setRes(null)
        setErr(r.error)
      }
    }, 180)
    return () => { alive = false; clearTimeout(h) }
  }, [q, activeId])

  const doAdd = async (item: SearchItemAPI) => {
    setErr(null)
    if (item.catalog === 'library' && item.assetId) {
      const r = await apiAddSoftRef(item.ownerProjectId, item.assetId)
      if (r.ok) {
        setMsg(t('search.addedRef'))
        // bump the inline badge without refetching
        setRes((prev) => {
          if (!prev) return prev
          return {
            ...prev,
            groups: prev.groups.map((g) => ({
              ...g,
              items: g.items.map((it) => (it.key === item.key ? { ...it, alreadyRefCount: r.data.refCount } : it)),
            })),
          }
        })
      } else setErr(r.error)
    } else if (item.catalog === 'canvas' && item.canvasNodeId) {
      const r = await apiImportCanvas(item.ownerProjectId, item.canvasNodeId)
      if (r.ok) {
        setMsg(t('search.imported'))
      } else setErr(r.error)
    }
  }

  const activeName = registry?.projects.find((p) => p.id === activeId)?.name

  return (
    <div className="ms-gs">
      <input
        ref={inputRef}
        className="ms-gs-input"
        value={q}
        placeholder={t('search.placeholder')}
        onFocus={() => { refreshAnchor(); setOpen(true) }}
        onChange={(e) => { setQ(e.target.value); refreshAnchor() }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        aria-label={t('search.placeholder')}
      />
      {open && anchor && createPortal(
        <div ref={panelRef} className="ms-gs-panel" style={{ left: anchor.x, top: anchor.y }}>
          <div className="ms-gs-groups">
            {err && <div className="ms-gs-err ms-gs-empty">{err}</div>}
            {!q.trim() && !err && <div className="ms-gs-empty">{t('search.idle')}</div>}
            {q.trim() && loading && res === null && !err && <div className="ms-gs-empty">…</div>}
            {res && res.hitCount === 0 && (
              <div className="ms-gs-empty">{t('search.noResult', { q: res.q })}</div>
            )}
            {res && res.groups.map((g) => (
              <div key={g.key}>
                <div className="ms-gs-group-title">
                  {g.key === 'current'
                    ? t('search.current', { name: activeName ?? g.title })
                    : t('search.other', { n: g.total })}
                  {g.total > g.items.length ? ` · ${g.items.length}/${g.total}` : ''}
                </div>
                {g.items.map((it) => (
                  <div className="ms-gs-row" key={it.key}>
                    <div className="ms-gs-thumb"><Thumb item={it} activeId={activeId} /></div>
                    <div className="ms-gs-main">
                      <div className="ms-gs-name">
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.name}</span>
                        {it.catalog === 'canvas' && <span className="ms-gs-chip">{t('search.canvasTag')}</span>}
                        {it.alreadyRefCount > 0 && <span className="ms-gs-badge">{t('search.refCount', { n: it.alreadyRefCount })}</span>}
                      </div>
                      <div className="ms-gs-meta">
                        {it.ownerProjectName} · {it.catalog === 'library'
                          ? it.kind
                          : `${it.kind} · ${it.prompt ?? ''}`.trim()}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ms-gs-add"
                      onClick={() => void doAdd(it)}
                      title={it.catalog === 'library' ? t('search.addRef') : t('search.importCopy')}
                    >
                      {it.catalog === 'library' ? t('search.addRef') : t('search.importCopy')}
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="ms-gs-foot">
            <span className={msg ? 'ms-gs-msg' : ''}>{msg ?? `${q.trim() ? `${res ? res.hitCount : 0} hits` : ''}`}</span>
            <button
              type="button"
              style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4 }}
              onClick={() => setOpen(false)}
            >
              <IconX size={11} /> {t('search.close')}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  )
}
