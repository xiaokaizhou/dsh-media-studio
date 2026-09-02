// Settings panel for the mediaStudio namespace — rendered into the DSH
// Settings UI as a side card. Reads the live value through the settings
// RPC, writes back through the same surface, and surfaces validation
// errors without blocking the user.
//
// Why a separate panel? `ctx.settings.describe({ redactSecrets: true })`
// returns the user's secrets redacted over the wire. The settings page
// needs the FULL value to show inputs pre-filled and to know which fields
// the user has already filled. We render this panel from the same client
// runtime so it reads from the harness's same-process settings store.

import { useCallback, useEffect, useState } from 'react'

interface SettingsPanelProps {
  host: HTMLElement
}

interface MediaStudioSection {
  textModel: string
  image: { provider: string; baseURL: string; apiKey: string; defaultModel: string }
  video: { provider: string; baseURL: string; apiKey: string; defaultModel: string }
  music: { provider: string; baseURL: string; apiKey: string; defaultModel: string; voice: string }
}

const EMPTY: MediaStudioSection = {
  textModel: '',
  image: { provider: 'custom-agnes', baseURL: 'https://apihub.agnes-ai.com/v1', apiKey: '', defaultModel: 'agnes-image-2.1-flash' },
  video: { provider: 'custom-agnes', baseURL: 'https://apihub.agnes-ai.com/v1', apiKey: '', defaultModel: 'agnes-video-2.5-flash' },
  music: { provider: 'custom-minimax', baseURL: 'https://api.minimaxi.com', apiKey: '', defaultModel: 'speech-02-hd', voice: 'male-qn-jingying' },
}

export function SettingsPanel({ host }: SettingsPanelProps) {
  const [value, setValue] = useState<MediaStudioSection>(EMPTY)
  const [revision, setRevision] = useState<number>(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Initial load — fetch the live value via the harness settings RPC.
  // We DON'T redact secrets here because the settings page is process-local
  // and the user already saved them once.
  useEffect(() => {
    fetch('/api/settings/describe?ns=media-studio&redactSecrets=false', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        const v = data?.value as MediaStudioSection | undefined
        if (v) setValue({ ...EMPTY, ...v })
        setRevision(data?.revision ?? 0)
      })
      .catch((e) => setError(`load failed: ${(e as Error).message}`))
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    try {
      const r = await fetch('/api/settings/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ns: 'media-studio', value, expectedRevision: revision }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setRevision(data?.revision ?? revision)
    } catch (e) {
      setError(`save failed: ${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }, [value, revision])

  return (
    <div className="media-studio-settings" data-canvas-host={host}>
      <h3>Media Studio</h3>
      <p className="media-studio-hint">
        Configure your LLM (text) and media providers (image / video / voice). Keys stay on this machine; only the plugin reads them.
      </p>

      <fieldset>
        <legend>Text (uses DSH-configured LLM)</legend>
        <label>
          <span>Default model (e.g. <code>deepseek/deepseek-chat</code>)</span>
          <input
            type="text"
            value={value.textModel}
            placeholder="deepseek/deepseek-chat"
            onChange={(e) => setValue({ ...value, textModel: e.target.value })}
          />
        </label>
      </fieldset>

      <fieldset>
        <legend>Image</legend>
        <ProviderFields value={value.image} onChange={(image) => setValue({ ...value, image })} defaultModelPlaceholder="agnes-image-2.1-flash" />
      </fieldset>

      <fieldset>
        <legend>Video</legend>
        <ProviderFields value={value.video} onChange={(video) => setValue({ ...value, video })} defaultModelPlaceholder="agnes-video-2.5-flash" />
      </fieldset>

      <fieldset>
        <legend>Voice (TTS)</legend>
        <ProviderFields value={value.music} onChange={(music) => setValue({ ...value, music })} defaultModelPlaceholder="speech-02-hd" />
        <label>
          <span>Default voice</span>
          <input
            type="text"
            value={value.music.voice}
            placeholder="male-qn-jingying"
            onChange={(e) => setValue({ ...value, music: { ...value.music, voice: e.target.value } })}
          />
        </label>
      </fieldset>

      {error && <p className="media-studio-error" role="alert">{error}</p>}

      <div className="media-studio-actions">
        <button type="button" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  )
}

interface ProviderFieldsProps {
  value: { provider: string; baseURL: string; apiKey: string; defaultModel: string; voice?: string }
  onChange: (next: { provider: string; baseURL: string; apiKey: string; defaultModel: string; voice?: string }) => void
  defaultModelPlaceholder: string
}

function ProviderFields({ value, onChange, defaultModelPlaceholder }: ProviderFieldsProps) {
  return (
    <>
      <label>
        <span>Provider id (e.g. <code>custom-agnes</code>)</span>
        <input type="text" value={value.provider} onChange={(e) => onChange({ ...value, provider: e.target.value })} />
      </label>
      <label>
        <span>Base URL</span>
        <input type="text" value={value.baseURL} onChange={(e) => onChange({ ...value, baseURL: e.target.value })} placeholder="https://…" />
      </label>
      <label>
        <span>API key</span>
        <input type="password" value={value.apiKey} onChange={(e) => onChange({ ...value, apiKey: e.target.value })} placeholder="sk-…" autoComplete="off" />
      </label>
      <label>
        <span>Default model</span>
        <input type="text" value={value.defaultModel} onChange={(e) => onChange({ ...value, defaultModel: e.target.value })} placeholder={defaultModelPlaceholder} />
      </label>
    </>
  )
}
