// Media Studio settings card — renders inside the DSH Plugins settings section
// as a native `settings.plugin.item` card.
//
// Design constraint:
// DSH 0.1.0-rc.7 only exports `@deepseek-ai/dsh-client-ui-settings-plugins`
// as a browser wrapper (`window.__ModuleLoader__.load(...)`); the internal
// symbols `textField` / `CardForm` / `ValueField` / `SecretField` /
// `PluginCard` are NOT re-exported as ESM bindings. A client bundle that
// tries `import { textField, CardForm, ... } from '@deepseek-ai/dsh-client-
// ui-settings-plugins'` fails the bundle-purity gate and crashes the client
// boot with `(...).textField is not a function`.
//
// To stay compatible, this card:
//   1. Reads / writes the `media-studio` settings namespace through a
//      SettingsScopeController (returned by `ctx.settingsScope.bind(...)`),
//      the same surface every other plugin card reads through.
//   2. Stages edits in local React state until the user clicks Save, then
//      flushes each staged field with `scope.set(field, value)`.
//   3. Treats the api-key fields as write-only: their card never displays a
//      stored value (DSH's `role('secret')` already redacts it on the wire)
//      and an empty staged draft is treated as "leave the current key".

import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import type { MediaStudioLocaleKey } from './locales'
import { EN, zh } from './locales'

// Register our locale namespace so the DSH locale system knows about it.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Media Studio settings card copy. */
    'media-studio.settings': MediaStudioLocaleKey
  }
}

// ── Namespace ────────────────────────────────────────────────────────────────
export const NS = 'media-studio'
/** Locale namespace key registered by this plugin. */
export const LOCALE_NS = 'media-studio.settings'
export { EN, zh }
export type { MediaStudioLocaleKey }

/** Field names. Flat — these are the dotted paths we pass to `scope.set`. */
const FIELDS = [
  'textModel',
  'image.provider',
  'image.baseURL',
  'image.defaultModel',
  'video.provider',
  'video.baseURL',
  'video.defaultModel',
  'music.provider',
  'music.baseURL',
  'music.defaultModel',
  'music.voice',
] as const

type FieldName = (typeof FIELDS)[number]

/** Secret fields: never display a stored value, blank draft = no change. */
const SECRET_FIELDS = new Set<string>([
  'image.apiKey',
  'video.apiKey',
  'music.apiKey',
])

/** The minimal client-side settings scope surface we use. */
export interface SettingsScopeHandle {
  getSnapshot(): {
    status: 'loading' | 'ready' | 'unavailable'
    value?: Record<string, unknown>
    base?: Record<string, unknown>
    user?: Record<string, unknown>
    revision?: number
    writable: boolean
  }
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<unknown>
  unset(field: string): Promise<unknown>
}

/** `get(path, root)` — read a dotted path like `image.provider`. */
function get(path: string, root: unknown): unknown {
  if (root === undefined || root === null) return undefined
  let cur: unknown = root
  for (const seg of path.split('.')) {
    if (cur === undefined || cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

/** Set a dotted path on a draft, returning a new object. */
function setPath(root: unknown, path: string, value: unknown): unknown {
  const segs = path.split('.')
  const out: Record<string, unknown> =
    root && typeof root === 'object' && !Array.isArray(root)
      ? { ...(root as Record<string, unknown>) }
      : {}
  let cur = out
  for (let i = 0; i < segs.length - 1; i++) {
    const key = segs[i]!
    const prev = cur[key]
    cur[key] = prev && typeof prev === 'object' && !Array.isArray(prev)
      ? { ...(prev as Record<string, unknown>) }
      : {}
    cur = cur[key] as Record<string, unknown>
  }
  cur[segs[segs.length - 1]!] = value
  return out
}

// ── Controller ──────────────────────────────────────────────────────────────
/**
 * Bridges the `media-studio` settings scope onto the card's staged form.
 *
 * `scope.bind` is what `ctx.settingsScope.bind({namespace: NS})` returns at
 * runtime. We keep a local map of staged edits per field and only flush to
 * the wire on `save()`.
 */
export class MediaStudioCardController {
  private readonly scope: SettingsScopeHandle
  /** Drafts — keys mirror FIELDS; absent key = no edit staged. Public so the
   *  card can show per-field "dirty" badges without exposing writes. */
  readonly drafts: Map<string, string> = new Map()
  /** apiKey drafts — separately tracked so we can ignore blank ones. */
  readonly secretDrafts: Map<string, string> = new Map()
  private listeners = new Set<() => void>()
  private readonly scopeUnsub: () => void
  private saving = false
  private failed = false

  constructor(scope: SettingsScopeHandle) {
    this.scope = scope
    this.scopeUnsub = scope.subscribe(() => this.notify())
  }

  /** Free the scope subscription when the card unmounts. */
  dispose(): void {
    this.scopeUnsub()
    this.listeners.clear()
  }

  /** Subscribe to controller changes (staged edits, save state, scope load). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const l of this.listeners) l()
  }

  /** Whether the namespace is served and writable. */
  isReady(): boolean {
    const snap = this.scope.getSnapshot()
    return snap.status === 'ready' && snap.writable
  }

  isSaving(): boolean { return this.saving }
  isFailed(): boolean { return this.failed }

  /** True when at least one staged edit would land a write. */
  isDirty(): boolean {
    return this.drafts.size > 0 || this.hasMeaningfulSecretDraft()
  }

  /** The staged text for one field, or the live value if no draft. */
  textFor(field: string): string {
    if (this.drafts.has(field)) return this.drafts.get(field)!
    const snap = this.scope.getSnapshot()
    const v = get(field, snap.value)
    return v == null ? '' : String(v)
  }

  /** Stage a draft text. Empty draft for a non-secret field = clear on save. */
  stageEdit(field: string, text: string): void {
    const snap = this.scope.getSnapshot()
    const current = get(field, snap.value)
    if (String(current ?? '') === text) {
      this.drafts.delete(field)
    } else {
      this.drafts.set(field, text)
    }
    if (SECRET_FIELDS.has(field)) this.secretDrafts.set(field, text)
    this.failed = false
    this.notify()
  }

  /** Reset one field (drop the staged draft). */
  resetField(field: string): void {
    this.drafts.delete(field)
    this.secretDrafts.delete(field)
    this.notify()
  }

  /** Drop every staged edit. */
  discard(): void {
    this.drafts.clear()
    this.secretDrafts.clear()
    this.failed = false
    this.notify()
  }

  /** Whether the apiKey for `kind` (image/video/music) is configured. */
  isSecretConfigured(kind: 'image' | 'video' | 'music'): boolean {
    const snap = this.scope.getSnapshot()
    const v = get(`${kind}.apiKey`, snap.user)
    return typeof v === 'string' && v.length > 0
  }

  /** Flush every staged edit. Empty drafts clear their field. */
  async save(): Promise<void> {
    if (!this.isReady()) return
    this.saving = true
    this.failed = false
    this.notify()
    try {
      for (const [field, text] of this.drafts) {
        if (text === '') {
          await this.scope.unset(field)
        } else {
          await this.scope.set(field, text)
        }
      }
      for (const [field, text] of this.secretDrafts) {
        if (text === '') continue // blank apiKey = leave current
        await this.scope.set(field, text)
      }
      this.drafts.clear()
      this.secretDrafts.clear()
    } catch {
      this.failed = true
    } finally {
      this.saving = false
      this.notify()
    }
  }

  private hasMeaningfulSecretDraft(): boolean {
    for (const text of this.secretDrafts.values()) {
      if (text !== '') return true
    }
    return false
  }
}

// ── Card component ───────────────────────────────────────────────────────────
export interface MediaStudioCardProps {
  t: (key: MediaStudioLocaleKey) => string
  controller: MediaStudioCardController
}

function useControllerVersion(ctrl: MediaStudioCardController): number {
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const unsub = ctrl.subscribe(() => setVersion((v) => v + 1))
    return unsub
  }, [ctrl])
  // version only used to trigger renders; the value itself is irrelevant
  return version
}

/** Inline styles matching DSH design tokens. */
const S = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    borderRadius: '12px',
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '14px 16px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  } as React.CSSProperties,
  title: {
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: '1.4',
    margin: 0,
  } as React.CSSProperties,
  description: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '13px',
    lineHeight: '1.5',
    margin: 0,
  } as React.CSSProperties,
  body: {
    padding: '12px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  } as React.CSSProperties,
  sectionLabel: {
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px',
    fontWeight: 500,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    marginTop: '12px',
    marginBottom: '4px',
  } as React.CSSProperties,
  fieldBlock: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    padding: '12px 0',
  } as React.CSSProperties,
  fieldHead: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '8px',
  } as React.CSSProperties,
  fieldLabel: {
    flex: 1,
    minWidth: 0,
    color: 'var(--dsw-alias-label-primary)',
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '1.5',
  } as React.CSSProperties,
  fieldHint: {
    color: 'var(--dsw-alias-label-tertiary)',
    margin: 0,
    fontSize: '12px',
    lineHeight: '1.5',
  } as React.CSSProperties,
  fieldInput: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-3)',
    height: '34px',
    font: 'inherit',
    color: 'var(--dsw-alias-label-primary)',
    borderRadius: '8px',
    padding: '0 12px',
    fontSize: '13px',
    lineHeight: '1.5',
  } as React.CSSProperties,
  badge: {
    whiteSpace: 'nowrap' as const,
    background: 'var(--dsw-alias-bg-module-platform)',
    color: 'var(--dsw-alias-label-secondary)',
    borderRadius: '999px',
    padding: '1px 8px',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '17px',
  } as React.CSSProperties,
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '12px 16px',
    borderTop: '1px solid var(--dsw-alias-border-l2)',
  } as React.CSSProperties,
  btnDiscard: {
    appearance: 'none' as const,
    font: 'inherit',
    cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    padding: '5px 14px',
    fontSize: '13px',
    lineHeight: '1.5',
    color: 'var(--dsw-alias-label-secondary)',
    background: 'transparent',
  } as React.CSSProperties,
  btnSave: {
    appearance: 'none' as const,
    font: 'inherit',
    cursor: 'pointer',
    border: 'none',
    borderRadius: '8px',
    padding: '5px 14px',
    fontSize: '13px',
    lineHeight: '1.5',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-foreground)',
  } as React.CSSProperties,
  readOnly: {
    color: 'var(--dsw-alias-label-tertiary)',
    fontSize: '12px',
    lineHeight: '1.5',
    margin: '12px 0 0',
  } as React.CSSProperties,
  failed: {
    flex: 1,
    color: 'var(--dsw-alias-label-error)',
    fontSize: '12px',
    lineHeight: '1.5',
  } as React.CSSProperties,
} as const

function FieldRow(props: { children: ReactNode }) {
  return createElement('div', { style: { marginTop: 4 }, children: props.children })
}

function SectionLabel({ children }: { children: ReactNode }) {
  return createElement('div', { style: S.sectionLabel, children })
}

function ValueField(props: {
  id: string
  label: string
  hint: string
  text: string
  disabled: boolean
  placeholder: string
  onEdit: (text: string) => void
  dirty: boolean
  resetLabel: string
  onReset: () => void
}) {
  return createElement('div', { style: S.fieldBlock }, [
    createElement('div', { style: S.fieldHead }, [
      createElement('label', { style: S.fieldLabel, htmlFor: props.id, children: props.label }),
      props.dirty
        ? createElement(
            'button',
            {
              type: 'button',
              style: { ...S.badge, background: 'transparent', border: 'none', cursor: 'pointer' },
              onClick: props.onReset,
              disabled: props.disabled,
              children: props.resetLabel,
            },
          )
        : null,
    ]),
    createElement('input', {
      id: props.id,
      style: S.fieldInput,
      type: 'text',
      value: props.text,
      placeholder: props.placeholder,
      disabled: props.disabled,
      onChange: (e: { target: { value: string } }) => props.onEdit(e.target.value),
    }),
    createElement('p', { style: S.fieldHint, children: props.hint }),
  ])
}

function SecretField(props: {
  id: string
  label: string
  hint: string
  text: string
  disabled: boolean
  placeholder: string
  configured: boolean
  stateLabel: string
  onEdit: (text: string) => void
}) {
  return createElement('div', { style: S.fieldBlock }, [
    createElement('div', { style: S.fieldHead }, [
      createElement('label', { style: S.fieldLabel, htmlFor: props.id, children: props.label }),
      createElement('span', { style: S.badge, children: props.stateLabel }),
    ]),
    createElement('input', {
      id: props.id,
      style: S.fieldInput,
      type: 'password',
      value: props.text,
      placeholder: props.placeholder,
      disabled: props.disabled,
      onChange: (e: { target: { value: string } }) => props.onEdit(e.target.value),
    }),
    createElement('p', { style: S.fieldHint, children: props.hint }),
  ])
}

export function MediaStudioCard(props: MediaStudioCardProps) {
  const { t, controller } = props
  // touch the version to re-render when controller notifies
  useControllerVersion(controller)

  const disabled = !controller.isReady()
  const dirty = controller.isDirty()
  const saving = controller.isSaving()
  const blocked = !dirty || saving

  const vf = (field: string, labelKey: MediaStudioLocaleKey, hintKey: MediaStudioLocaleKey, placeholder: string) =>
    createElement(ValueField, {
      id: field,
      label: t(labelKey),
      hint: t(hintKey),
      text: controller.textFor(field),
      disabled,
      placeholder,
      dirty: controller.drafts.has(field), // touched / staged
      resetLabel: t('reset'),
      onEdit: (text: string) => controller.stageEdit(field, text),
      onReset: () => controller.resetField(field),
    })

  const sf = (kind: 'image' | 'video' | 'music', labelKey: MediaStudioLocaleKey, hintKey: MediaStudioLocaleKey) =>
    createElement(SecretField, {
      id: `${kind}.apiKey`,
      label: t(labelKey),
      hint: t(hintKey),
      text: controller.textFor(`${kind}.apiKey`),
      disabled,
      placeholder: '••••••',
      configured: controller.isSecretConfigured(kind),
      stateLabel: t(controller.isSecretConfigured(kind) ? `${kind}ApiKeySet` as MediaStudioLocaleKey : `${kind}ApiKeyUnset` as MediaStudioLocaleKey),
      onEdit: (text: string) => controller.stageEdit(`${kind}.apiKey`, text),
    })

  return createElement('div', { style: S.card }, [
    createElement('div', { style: S.header }, [
      createElement('p', { style: S.title, children: t('title') }),
      createElement('span', { style: { flex: 1 } }),
      dirty && !saving ? createElement('span', { style: S.badge, children: t('unsaved') }) : null,
    ]),

    createElement('div', { style: S.body }, [
      createElement('p', { style: S.description, children: t('description') }),
      vf('textModel', 'textModel', 'textModelHint', 'deepseek/deepseek-chat'),

      createElement(SectionLabel, { children: t('imageProvider') }),
      createElement(FieldRow, { children: vf('image.provider', 'imageProvider', 'imageProviderHint', 'custom-agnes') }),
      createElement(FieldRow, { children: vf('image.baseURL', 'imageBaseUrl', 'imageBaseUrlHint', 'https://…') }),
      createElement(FieldRow, { children: sf('image', 'imageApiKey', 'imageApiKeyHint') }),
      createElement(FieldRow, { children: vf('image.defaultModel', 'imageDefaultModel', 'imageDefaultModelHint', 'agnes-image-2.1-flash') }),

      createElement(SectionLabel, { children: t('videoProvider') }),
      createElement(FieldRow, { children: vf('video.provider', 'videoProvider', 'videoProviderHint', 'custom-agnes') }),
      createElement(FieldRow, { children: vf('video.baseURL', 'videoBaseUrl', 'videoBaseUrlHint', 'https://…') }),
      createElement(FieldRow, { children: sf('video', 'videoApiKey', 'videoApiKeyHint') }),
      createElement(FieldRow, { children: vf('video.defaultModel', 'videoDefaultModel', 'videoDefaultModelHint', 'agnes-video-2.5-flash') }),

      createElement(SectionLabel, { children: t('musicProvider') }),
      createElement(FieldRow, { children: vf('music.provider', 'musicProvider', 'musicProviderHint', 'custom-minimax') }),
      createElement(FieldRow, { children: vf('music.baseURL', 'musicBaseUrl', 'musicBaseUrlHint', 'https://…') }),
      createElement(FieldRow, { children: sf('music', 'musicApiKey', 'musicApiKeyHint') }),
      createElement(FieldRow, { children: vf('music.defaultModel', 'musicDefaultModel', 'musicDefaultModelHint', 'speech-02-hd') }),
      createElement(FieldRow, { children: vf('music.voice', 'musicVoice', 'musicVoiceHint', 'male-qn-jingying') }),

      !controller.isReady()
        ? createElement('p', { style: S.readOnly, role: 'status', children: t('readOnly') })
        : null,
    ]),

    createElement('div', { style: S.footer }, [
      controller.isFailed()
        ? createElement('p', { style: S.failed, role: 'status', children: t('saveFailed') })
        : null,
      createElement(
        'button',
        {
          type: 'button',
          style: { ...S.btnDiscard, opacity: !dirty || saving ? 0.5 : 1, cursor: !dirty || saving ? 'not-allowed' : 'pointer' },
          disabled: !dirty || saving,
          onClick: () => controller.discard(),
          children: t('discard'),
        },
      ),
      createElement(
        'button',
        {
          type: 'button',
          style: { ...S.btnSave, opacity: blocked ? 0.5 : 1, cursor: blocked ? 'not-allowed' : 'pointer' },
          disabled: blocked,
          onClick: () => { void controller.save() },
          children: t(saving ? 'saving' : 'save'),
        },
      ),
    ]),
  ])
}