import type { Context } from '@deepseek-ai/cordis'
// Value-import (not type-only) — needed for the `declare module` augmentation
// in @deepseek-ai/dsh-llm that adds `ctx.llm` to the cordis Context type.
import '@deepseek-ai/dsh-llm'
import { MediaStudioSettings, NS, readMediaStudio, DEFAULT_MEDIA_STUDIO, type MediaStudioScope, type MediaStudioSettingsShape } from './settings'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { registerGenerateTextTool } from './tools'

export const name = 'dsh-media-studio'
/**
 * `settings` — register + watch the user-facing mediaStudio namespace.
 * `llm` — read the harness-native LlmRuntime so text tools can use whatever
 *         provider the user already configured in `~/.dsh/settings.yaml`.
 * `tools` — register our canvas + media generation tools.
 * `webServer` — register the SSE / HTTP routes the canvas tab subscribes to.
 */
export const inject = ['settings', 'llm', 'tools', 'webServer']

export { Config }

// ─── service extension: plugin-scoped handles other code reads via ctx ───
declare module '@deepseek-ai/cordis' {
  interface Context {
    mediaStudio: {
      scope: MediaStudioScope
      getSettings(): MediaStudioSettingsShape
      /**
       * Reference to the harness-native LlmRuntime, captured at apply().
       * Plugins read this instead of `ctx.llm` to keep the surface explicit
       * and to let stub-friendly tests pass `undefined`.
       */
      llm: unknown
    }
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
export function apply(ctx: Context, config: ConfigShape): void {
  ctx.inject(['settings', 'llm'], (sctx) => {
    // Register the namespace; the harness validates the schema and any
    // existing user section at load time. We accept whatever the user
    // already has — no destructive defaults.
    const scope = sctx.settings.register(NS, MediaStudioSettings) as MediaStudioScope

    // Attach plugin-scoped handles. Tool code reads these instead of going
    // through cordis lookup each call (and avoids "mediaStudio not bound"
    // races when tools execute before apply() finishes).
    ctx.mediaStudio = {
      scope,
      getSettings: (): MediaStudioSettingsShape => readMediaStudio(scope),
      llm: sctx.llm,
    }

    // Live settings → ctx cache refresh + log. The Settings UI re-reads
    // ctx.mediaStudio.getSettings() on every commit; this watcher just
    // keeps the cache fresh and emits a plugin-visible event for any
    // downstream listeners (e.g. the canvas tool rebuilds its default-model
    // option list).
    ctx.effect(() => {
      const dispose = scope.watch((next, prev) => {
        ctx.logger?.info?.(
          `[media-studio] settings changed: textModel ${prev.textModel} → ${next.textModel}`,
        )
      })
      return dispose
    }, 'media-studio: settings watcher')

    // Surface the default workspace at boot so the canvas store can read it
    // before any user interaction. (config.workspaceRoot is the host-level
    // override; mediaStudio settings can layer a session-local override on top.)
    ctx.logger?.info?.(
      `[media-studio] ready: workspaceRoot=${config.workspaceRoot}, defaultCanvas=${config.defaultCanvasId}, ` +
      `textModel="${ctx.mediaStudio.getSettings().textModel || '(auto)'}"`,
    )

    // Tool registration — `ctx.tools` is `undefined` until the tools service
    // activates; the `tools` inject dependency above guarantees it is live
    // by the time apply() runs, so calling `registerGenerateTextTool` here
    // is safe.
    registerGenerateTextTool(ctx)
    ctx.logger?.info?.('[media-studio] registered generate_text tool')
  })
}

// Re-export DEFAULT_MEDIA_STUDIO so tests / debug tooling can pull the
// canonical defaults without re-importing from the settings module.
export { DEFAULT_MEDIA_STUDIO }
