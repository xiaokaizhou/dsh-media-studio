// Asset library panel (M2) — modal browser for one project's four categories
// with per-asset actions: rename (inline), copy-to-another-project, sync from
// canvas (when the asset was registered from a card), and delete (with a
// dependency-aware confirm when other projects reference the asset).

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useI18n } from './use-i18n-hook'
import { mediaSrc } from './canvas-api'
import {
  apiListAssets,
  apiUpdateAsset,
  apiCopyAsset,
  apiSyncAsset,
  apiDeleteAsset,
  apiAssetDependents,
  ASSET_KINDS,
  type AssetAPI,
  type AssetKind,
} from './assets-api'
import type { RegistryAPI } from './projects-api'
import { IconTrash2, IconX } from './icons'

const KIND_DIR: Record<AssetKind, string> = { character: 'characters', scene: 'scenes', audio: 'audio', clip: 'clips' }

export interface AssetLibraryPanelProps {
  projectId: string
  registry: RegistryAPI | null
  onClose: () => void
}

let assetStylesInjected = false
function injectAssetPanelStyles(): void {
  if (assetStylesInjected) return
  assetStylesInjected = true
  try {
    const style = document.createElement('style')
    style.dataset.plugin = 'dsh-media-studio-assets'
    style.textContent = `
.ms-alp-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.45); z-index:70; display:flex; align-items:center; justify-content:center; }
.ms-alp-panel { width:min(720px, calc(100vw - 48px)); max-width:720px; height:min(560px, calc(100vh - 96px)); display:flex; flex-direction:column; background:var(--dsw-alias-bg-overlay, rgba(22,24,31,0.98)); border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.22)); border-radius:14px; box-shadow:0 14px 40px rgba(0,0,0,0.5); color:var(--dsw-alias-label-primary,#eceef2); font:13px/1.45 system-ui,sans-serif; overflow:hidden; }
.ms-alp-head { display:flex; align-items:center; gap:10px; padding:12px 14px 8px; }
.ms-alp-title { font-weight:700; font-size:14px; flex:1; }
.ms-alp-tabs { display:flex; gap:2px; padding:4px 14px 8px; border-bottom:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1)); flex-wrap:wrap; }
.ms-alp-tab { border:none; border-radius:8px; padding:4px 10px; background:transparent; color:var(--dsw-alias-label-secondary, rgba(255,255,255,0.66)); cursor:pointer; font:600 12px/1 system-ui,sans-serif; }
.ms-alp-tab.is-on { background:var(--dsw-alias-interactive-bg-hover-accent, #7c83ff); color:#0b0d12; }
.ms-alp-body { flex:1; overflow-y:auto; padding:12px 14px; }
.ms-alp-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
.ms-alp-card { border:1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.1)); border-radius:10px; overflow:hidden; background:var(--dsw-alias-bg-layer-2,#1c1f27); display:flex; flex-direction:column; }
.ms-alp-media { height:110px; background:#101218; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.ms-alp-media img, .ms-alp-media video { width:100%; height:100%; object-fit:cover; }
.ms-alp-media audio { width:92%; }
.ms-alp-media .ms-alp-media-null { color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.4)); font-size:11px; }
.ms-alp-card-body { padding:6px 8px 7px; display:flex; flex-direction:column; gap:4px; }
.ms-alp-name { font-weight:600; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:flex; gap:4px; align-items:center; }
.ms-alp-name input { width:100%; box-sizing:border-box; font:inherit; border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.24)); background:var(--dsw-alias-bg-layer-1,#14171d); color:var(--dsw-alias-label-primary,#eceef2); border-radius:6px; padding:2px 5px; }
.ms-alp-meta { color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.42)); font-size:10.5px; display:flex; gap:6px; align-items:center; }
.ms-alp-chip { border-radius:99px; padding:0 5px; background:rgba(124,131,255,0.16); color:#a5b4fc; font-size:10px; }
.ms-alp-actions { display:flex; gap:2px; justify-content:flex-end; }
.ms-alp-act { display:inline-flex; align-items:center; gap:4px; border:none; background:transparent; color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); cursor:pointer; font-size:11px; padding:2px 5px; border-radius:6px; }
.ms-alp-act:hover { background:rgba(255,255,255,0.08); color:var(--dsw-alias-label-primary,#eceef2); }
.ms-alp-act.is-danger:hover { color:#ef4444; background:rgba(239,68,68,0.14); }
.ms-alp-empty { color:var(--dsw-alias-label-tertiary, rgba(255,255,255,0.45)); text-align:center; padding:40px 10px; line-height:1.7; }
.ms-alp-foot { padding:8px 14px 12px; display:flex; justify-content:flex-end; gap:8px; }
.ms-alp-msg { color:var(--dsw-alias-label-secondary, rgba(255,255,255,0.66)); font-size:12px; padding:6px 2px 0; }
.ms-alp-del { border:1px solid rgba(239,68,68,0.4); background:rgba(239,68,68,0.08); border-radius:10px; padding:10px 12px; margin:8px 14px 0; display:flex; flex-direction:column; gap:8px; }
.ms-alp-del-actions { display:flex; gap:8px; justify-content:flex-end; }
.ms-btn-primary { padding:5px 12px; border:none; border-radius:8px; background:var(--dsw-alias-interactive-bg-hover-accent,#7c83ff); color:#0b0d12; font:600 12px/1 system-ui,sans-serif; cursor:pointer; }
.ms-btn-cancel { padding:5px 12px; border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.2)); border-radius:8px; background:transparent; color:var(--dsw-alias-label-secondary, rgba(255,255,255,0.7)); font:inherit; cursor:pointer; }
.ms-btn-danger { padding:5px 12px; border:none; border-radius:8px; background:#dc2626; color:#fff; font:600 12px/1 system-ui,sans-serif; cursor:pointer; }
.ms-btn-primary:disabled, .ms-btn-danger:disabled, .ms-btn-cancel:disabled { opacity:0.55; cursor:not-allowed; }
.ms-alp-select { background:var(--dsw-alias-bg-layer-1,#14171d); color:var(--dsw-alias-label-primary,#eceef2); border:1px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.2)); border-radius:6px; font-size:11px; padding:2px 4px; }
`
    document.head.appendChild(style)
  } catch { /* ignore */ }
}

export default function AssetLibraryPanel(props: AssetLibraryPanelProps): ReactNode {
  const { projectId, registry, onClose } = props
  const { t } = useI18n()
  const [assets, setAssets] = useState<AssetAPI[]>([])
  const [tab, setTab] = useState<'all' | AssetKind>('all')
  const [error, setError] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [deleting, setDeleting] = useState<AssetAPI | null>(null)
  const [cascade, setCascade] = useState<'migrate-shared' | 'break-refs' | null>(null)
  const [delRefs, setDelRefs] = useState<number>(0)
  const [delProjects, setDelProjects] = useState<number>(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    injectAssetPanelStyles()
  }, [])

  const load = useCallback(async () => {
    setError(null)
    const res = await apiListAssets(projectId)
    if (res.ok) setAssets(res.data.assets)
    else setError(res.error)
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const projectName = useMemo(() => {
    const p = registry?.projects.find((x) => x.id === projectId)
    return p?.name ?? projectId
  }, [registry, projectId])

  const others = useMemo(() => (registry?.projects ?? []).filter((p) => p.id !== projectId), [registry, projectId])

  const visible = useMemo(() => {
    if (tab === 'all') return assets
    return assets.filter((a) => a.kind === tab)
  }, [assets, tab])

  const counts = useMemo(() => {
    const m = new Map<AssetKind, number>()
    for (const k of ASSET_KINDS) m.set(k, 0)
    for (const a of assets) m.set(a.kind, (m.get(a.kind) ?? 0) + 1)
    return m
  }, [assets])

  const thumb = (a: AssetAPI) =>
    `/api/media-studio/media-file?path=${encodeURIComponent(`projects/${projectId}/assets/${KIND_DIR[a.kind]}/${a.file}`)}`

  const startRename = (a: AssetAPI) => {
    setRenaming(a.id)
    setRenameVal(a.name)
  }
  const commitRename = async (a: AssetAPI) => {
    setRenaming(null)
    const name = renameVal.trim()
    if (!name || name === a.name) return
    const res = await apiUpdateAsset(projectId, a.id, { name })
    if (res.ok) await load()
    else setError(res.error)
  }

  const doCopy = async (a: AssetAPI, targetId: string) => {
    setBusy(true)
    const res = await apiCopyAsset(projectId, a.id, targetId)
    setBusy(false)
    if (res.ok) {
      const target = registry?.projects.find((p) => p.id === targetId)
      setMsg(t('asset.copy.ok', { project: target?.name ?? targetId }))
    } else setError(res.error)
  }

  const openDelete = async (a: AssetAPI) => {
    setDeleting(a)
    setCascade(null)
    setDelRefs(0)
    setDelProjects(0)
    const res = await apiAssetDependents(projectId, a.id)
    if (res.ok) {
      setDelRefs(res.data.dependents.totalRefs)
      setDelProjects(new Set(res.data.dependents.hits.map((h) => h.refProjectId)).size)
    } else setError(res.error)
  }

  const confirmDelete = async () => {
    if (!deleting) return
    if (delRefs > 0 && !cascade) return
    setBusy(true)
    const res = await apiDeleteAsset(projectId, deleting.id, cascade ?? 'cancel')
    setBusy(false)
    if (res.ok) {
      setDeleting(null)
      await load()
    } else {
      setError(res.error)
    }
  }

  const doSync = async (a: AssetAPI) => {
    const res = await apiSyncAsset(projectId, a.id)
    if (res.ok) {
      if (res.data.changed) setMsg(t('asset.synced.ok'))
      await load()
    } else setError(res.error)
  }

  return (
    <div className="ms-alp-backdrop" onClick={onClose}>
      <div className="ms-alp-panel" role="dialog" aria-modal="true" aria-label={t('asset.title', { project: projectName })} onClick={(e) => e.stopPropagation()}>
        <div className="ms-alp-head">
          <span className="ms-alp-title">{t('asset.title', { project: projectName })}</span>
          <button type="button" className="ms-alp-act" onClick={() => void load()}>↻</button>
          <button type="button" className="ms-alp-act" onClick={onClose} aria-label="close"><IconX size={14} /></button>
        </div>
        <div className="ms-alp-tabs">
          <button type="button" className={`ms-alp-tab ${tab === 'all' ? 'is-on' : ''}`} onClick={() => setTab('all')}>{t('asset.all')}{assets.length > 0 ? ` (${assets.length})` : ''}</button>
          {ASSET_KINDS.map((k) => (
            <button key={k} type="button" className={`ms-alp-tab ${tab === k ? 'is-on' : ''}`} onClick={() => setTab(k)}>
              {t(`asset.kind.${k}`)}{counts.get(k) ? ` (${counts.get(k)})` : ''}
            </button>
          ))}
        </div>
        <div className="ms-alp-body">
          {error && <div className="ms-alp-msg">{error}</div>}
          {visible.length === 0 && !error ? (
            <div className="ms-alp-empty">
              <div>{t('asset.empty')}</div>
              <div style={{ fontSize: 11.5 }}>{t('asset.empty.hint')}</div>
            </div>
          ) : (
            <div className="ms-alp-grid">
              {visible.map((a) => (
                <div className="ms-alp-card" key={a.id}>
                  <div className="ms-alp-media">
                    {a.kind === 'audio' ? (
                      <audio src={mediaSrc(thumb(a))} controls preload="none" />
                    ) : a.kind === 'clip' ? (
                      <video src={mediaSrc(thumb(a))} muted preload="none" />
                    ) : (
                      <img src={mediaSrc(thumb(a))} alt={a.name} loading="lazy" />
                    )}
                  </div>
                  <div className="ms-alp-card-body">
                    {renaming === a.id ? (
                      <input
                        autoFocus
                        value={renameVal}
                        onChange={(e) => setRenameVal(e.target.value)}
                        onBlur={() => void commitRename(a)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(a)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                      />
                    ) : (
                      <div className="ms-alp-name" title={a.name}>{a.name}</div>
                    )}
                    <div className="ms-alp-meta">
                      <span>{t(`asset.kind.${a.kind}`)}</span>
                      {typeof a.bytes === 'number' && <span>{t('asset.size', { bytes: Math.max(1, Math.round(a.bytes / 1024)) })}</span>}
                      {a.copyOf && <span className="ms-alp-chip">{t('asset.copied')}</span>}
                      {a.origin?.type === 'canvas' && <span className="ms-alp-chip">{t('asset.fromCanvas')}</span>}
                    </div>
                    <div className="ms-alp-actions">
                      <button type="button" className="ms-alp-act" onClick={() => startRename(a)}>{t('asset.rename')}</button>
                      {a.origin?.type === 'canvas' && (
                        <button type="button" className="ms-alp-act" onClick={() => void doSync(a)}>{t('asset.sync')}</button>
                      )}
                      {others.length > 0 && (
                        <select
                          className="ms-alp-select"
                          defaultValue=""
                          disabled={busy}
                          title={t('asset.copyTo')}
                          onChange={(e) => {
                            if (e.target.value) void doCopy(a, e.target.value)
                            e.target.value = ''
                          }}
                        >
                          <option value="" disabled>{t('asset.copyTo')}</option>
                          {others.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      )}
                      <button type="button" className="ms-alp-act is-danger" onClick={() => void openDelete(a)}>
                        <IconTrash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        {msg && <div className="ms-alp-msg">{msg}</div>}
        <div className="ms-alp-foot">
          <button type="button" className="ms-btn-cancel" onClick={onClose}>{t('common.close')}</button>
        </div>
        {deleting && (
          <div className="ms-alp-del">
            <div>
              <b>{deleting.name}</b> — {t('asset.delete.confirm')}
              {delRefs > 0 && (
                <div style={{ marginTop: 6, color: '#fca5a5' }}>
                  {t('asset.delete.blocked', { n: delProjects, refs: delRefs })}
                </div>
              )}
            </div>
            {delRefs > 0 && (
              <>
                <div>{t('asset.delete.cascadeHint')}</div>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="radio" checked={cascade === 'migrate-shared'} onChange={() => setCascade('migrate-shared')} /> {t('asset.cascade.migrate')}
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input type="radio" checked={cascade === 'break-refs'} onChange={() => setCascade('break-refs')} /> {t('asset.cascade.break')}
                </label>
              </>
            )}
            <div className="ms-alp-del-actions">
              <button type="button" className="ms-btn-cancel" onClick={() => setDeleting(null)}>{t('common.cancel')}</button>
              <button type="button" className="ms-btn-danger" disabled={busy || (delRefs > 0 && !cascade)} onClick={() => void confirmDelete()}>
                {busy ? t('common.loading') : t('asset.delete.confirm')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
