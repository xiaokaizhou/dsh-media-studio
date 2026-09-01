import "@deepseek-ai/dsh-llm";
import Schema from "@deepseek-ai/schemastery";
import { SettingsScope } from "@deepseek-ai/dsh-settings";
import { Context } from "@deepseek-ai/cordis";
//#region src/settings.d.ts
interface MediaProvider {
  provider: string;
  baseURL: string;
  apiKey: string;
  defaultModel: string;
}
interface MediaMusicProvider extends MediaProvider {
  voice: string;
}
interface MediaStudioSettingsShape {
  textModel: string;
  image: MediaProvider;
  video: MediaProvider;
  music: MediaMusicProvider;
}
type MediaStudioScope = SettingsScope<MediaStudioSettingsShape>;
/** Default values when no user section is on disk. Keep in sync with the
 *  `.default(...)` calls above — `.get()` returns these when the section
 *  is empty, so anything reading the shape synchronously without going
 *  through the harness sees the same defaults. */
declare const DEFAULT_MEDIA_STUDIO: MediaStudioSettingsShape;
//#endregion
//#region src/config.d.ts
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
interface Config {
  /** Where canvas snapshots, generated media, and SSE journal land. */
  workspaceRoot: string;
  /** Canvas every freshly opened session is bound to by default. */
  defaultCanvasId: string;
  /** Send `MediaStudio/tool-call` events to the session log (replayable). */
  logToolCalls: boolean;
}
declare const Config: Schema<Config>;
//#endregion
//#region src/index.d.ts
declare const name = "dsh-media-studio";
/**
 * `settings` — register + watch the user-facing mediaStudio namespace.
 * `llm` — read the harness-native LlmRuntime so text tools can use whatever
 *         provider the user already configured in `~/.dsh/settings.yaml`.
 * `tools` — register our canvas + media generation tools.
 * `webServer` — register the SSE / HTTP routes the canvas tab subscribes to.
 */
declare const inject: string[];
declare module '@deepseek-ai/cordis' {
  interface Context {
    mediaStudio: {
      scope: MediaStudioScope;
      getSettings(): MediaStudioSettingsShape;
      /**
       * Reference to the harness-native LlmRuntime, captured at apply().
       * Plugins read this instead of `ctx.llm` to keep the surface explicit
       * and to let stub-friendly tests pass `undefined`.
       */
      llm: unknown;
      /** Resolved absolute workspace directory (cordis config wins over env). */
      workspaceRoot: string;
    };
  }
}
/**
 * Lifecycle:
 *   1. Register `mediaStudio` settings namespace (immutable schema; user fills).
 *   2. Grab a typed scope handle for live reads.
 *   3. Stash it on `ctx.mediaStudio` so tools / routes / future code read
 *      a single source of truth (never call `scope.get()` ad-hoc — cache it).
 *   4. Snapshot the LlmRuntime reference for tool bridges.
 *   5. Wire settings.watch → ctx.effect so HMR / live edits are picked up.
 *
 * Tool + route registration land in Day 2 / Day 3; this skeleton is the
 * minimum that proves settings + llm injection end-to-end.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, DEFAULT_MEDIA_STUDIO, apply, inject, name };