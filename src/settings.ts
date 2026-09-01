import Schema from '@deepseek-ai/schemastery'
import { settingsNamespace, type SettingsScope } from '@deepseek-ai/dsh-settings'

/**
 * Settings namespace schema for `mediaStudio`. Every user-tunable field lives
 * here (provider baseURL + apiKey + default model), exposed in the DSH
 * Settings UI just like other plugins' prefs. Code reads the resolved
 * value through the registered `SettingsScope<T>`.
 *
 * Roles:
 *   `role('secret')`  — stripped from network/redacted descriptions and
 *                        encrypted in `~/.dsh/settings.yaml`. Plugin code
 *                        still receives the verbatim value at runtime.
 *
 * Defaults are applied via `.default(...)` on individual leaf schemas so
 * a partially-populated user section (e.g. only image provider filled)
 * still validates cleanly against the full schema.
 */

const MediaProviderSchema = Schema.object({
  /** Provider route, e.g. "deepseek", "openai", "custom-agnes". */
  provider: Schema.string().default('').description('Provider route as registered with ctx.llm (or "custom-*" for user-added media APIs).'),
  /** API base URL — required for "custom-*" providers. */
  baseURL: Schema.string().default('').description('API endpoint for "custom-*" providers (Agnes, MiniMax, OpenAI-compat, etc).'),
  /** Auth bearer; role('secret') so it is redacted on the wire. */
  apiKey: Schema.string().role('secret').default('').description('Bearer / API key for the custom provider.'),
  /** Default model to use when the node does not specify one. */
  defaultModel: Schema.string().default('').description('Default model id used when a canvas node leaves the model field blank.'),
})

const MediaMusicProviderSchema = Schema.object({
  provider: Schema.string().default(''),
  baseURL: Schema.string().default(''),
  apiKey: Schema.string().role('secret').default(''),
  defaultModel: Schema.string().default(''),
  voice: Schema.string().default('male-qn-jingying').description('Voice preset id for TTS (MiniMax Speech 02 HD etc.).'),
})

export const MediaStudioSettings = Schema.object({
  /** Default text model the canvas `text` node uses. Auto-resolved from `ctx.llm` if blank. */
  textModel: Schema.string().default('').description('Default text model id (e.g. "deepseek/deepseek-chat"). Leave blank to auto-pick.'),
  image: MediaProviderSchema.default({
    provider: 'custom-agnes',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    defaultModel: 'agnes-image-2.1-flash',
  }),
  video: MediaProviderSchema.default({
    provider: 'custom-agnes',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    defaultModel: 'agnes-video-2.5-flash',
  }),
  music: MediaMusicProviderSchema.default({
    provider: 'custom-minimax',
    baseURL: 'https://api.minimaxi.com',
    apiKey: '',
    defaultModel: 'speech-02-hd',
    voice: 'male-qn-jingying',
  }),
})

// ── TypeScript types — derived by hand from the schema, since schemastery
// does not export a public `Infer<typeof X>` helper that works on plain
// `Schema.object({...})` results. Mirror the schema exactly; if the schema
// gains a field, mirror it here too.
export interface MediaProvider {
  provider: string
  baseURL: string
  apiKey: string
  defaultModel: string
}
export interface MediaMusicProvider extends MediaProvider { voice: string }
export interface MediaStudioSettingsShape {
  textModel: string
  image: MediaProvider
  video: MediaProvider
  music: MediaMusicProvider
}

export const NS = settingsNamespace('media-studio')

export type MediaStudioScope = SettingsScope<MediaStudioSettingsShape>

/** Default values when no user section is on disk. Keep in sync with the
 *  `.default(...)` calls above — `.get()` returns these when the section
 *  is empty, so anything reading the shape synchronously without going
 *  through the harness sees the same defaults. */
export const DEFAULT_MEDIA_STUDIO: MediaStudioSettingsShape = {
  textModel: '',
  image: {
    provider: 'custom-agnes',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    defaultModel: 'agnes-image-2.1-flash',
  },
  video: {
    provider: 'custom-agnes',
    baseURL: 'https://apihub.agnes-ai.com/v1',
    apiKey: '',
    defaultModel: 'agnes-video-2.5-flash',
  },
  music: {
    provider: 'custom-minimax',
    baseURL: 'https://api.minimaxi.com',
    apiKey: '',
    defaultModel: 'speech-02-hd',
    voice: 'male-qn-jingying',
  },
}

/** Read the live resolved value through the SettingsScope handle. Returns
 *  DEFAULT_MEDIA_STUDIO if the scope is missing (boot-time code paths). */
export function readMediaStudio(scope: MediaStudioScope | undefined): MediaStudioSettingsShape {
  if (!scope) return DEFAULT_MEDIA_STUDIO
  try { return scope.get() as MediaStudioSettingsShape } catch { return DEFAULT_MEDIA_STUDIO }
}
