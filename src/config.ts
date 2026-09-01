import Schema from '@deepseek-ai/schemastery'

/**
 * Plugin-level config (the cordis.yml row). Holds ONLY values that
 * cannot live in the user-facing settings UI — typically filesystem
 * paths and boolean toggles a host admin owns. Everything user-tunable
 * (provider baseURL, API keys, model choice, voice) lives in the
 * `mediaStudio` settings namespace registered in `settings.ts` and is
 * surfaced to the DSH Settings page like any other plugin.
 *
 * Misconfiguration fails loud at load time (Schemastery), and every
 * field below is overrideable in cordis.yml without editing code.
 */
export interface Config {
  /** Where canvas snapshots, generated media, and SSE journal land. */
  workspaceRoot: string
  /** Canvas every freshly opened session is bound to by default. */
  defaultCanvasId: string
  /** Send `MediaStudio/tool-call` events to the session log (replayable). */
  logToolCalls: boolean
}

export const Config: Schema<Config> = Schema.object({
  workspaceRoot: Schema.string().default('~/.franklin/media-studio').description('Directory for canvas + generated media. Created on first write.'),
  defaultCanvasId: Schema.string().default('main').description('Canvas id every session is bound to unless it overrides.'),
  logToolCalls: Schema.boolean().default(true).description('Append every canvas/media tool result to the session log for replay.'),
})
