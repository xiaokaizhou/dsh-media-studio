import type { Context } from '@deepseek-ai/cordis'
// Value-import (not type-only) — needed for the `declare module` augmentation
// in @deepseek-ai/dsh-llm that adds `ctx.llm` to the cordis Context type.
import '@deepseek-ai/dsh-llm'
import { MediaStudioSettings, NS, readMediaStudio, DEFAULT_MEDIA_STUDIO, type MediaStudioScope, type MediaStudioSettingsShape } from './settings'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { registerGenerateTextTool, registerGenerateImageTool, registerGenerateVideoTool, registerGenerateMusicTool, registerCanvasViewTool, registerCanvasPatchTool, bindMediaStudioContext } from './tools'
import { CanvasStore } from './canvas-store'
import { registerCanvasRoutes } from './routes'

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
      /** Resolved absolute workspace directory (cordis config wins over env). */
      workspaceRoot: string
      /** Server-side canvas state (Day 4). Tools read / write through this. */
      canvasStore: import('./canvas-store').CanvasStore
      /** SSE client registry (Day 4) — the canvas tab subscribes here. */
      sseClients: Set<import('node:http').ServerResponse>
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
  ctx.inject(['settings', 'llm', 'webServer'], (sctx) => {
    // Register the namespace; the harness validates the schema and any
    // existing user section at load time. We accept whatever the user
    // already has — no destructive defaults.
    const scope = sctx.settings.register(NS, MediaStudioSettings) as MediaStudioScope

    // Attach plugin-scoped handles. Tool code reads these instead of going
    // through cordis lookup each call (and avoids "mediaStudio not bound"
    // races when tools execute before apply() finishes).
    const canvasStore = new CanvasStore(config.workspaceRoot)
    // restore() runs in the background — we don't await because apply()
    // must be sync; the first tool call may race with disk read but the
    // in-memory state is empty either way.
    void canvasStore.restore()

    ctx.mediaStudio = {
      scope,
      getSettings: (): MediaStudioSettingsShape => readMediaStudio(scope),
      llm: sctx.llm,
      workspaceRoot: config.workspaceRoot,
      canvasStore,
      sseClients: new Set(),
    }

    // Bind the ctx pointer used by media tool closures (Day 3).
    bindMediaStudioContext(ctx, canvasStore)

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
    // by the time apply() runs, so calling these here is safe.
    registerGenerateTextTool(ctx)
    registerGenerateImageTool(ctx)
    registerGenerateVideoTool(ctx)
    registerGenerateMusicTool(ctx)
    registerCanvasViewTool(ctx)
    registerCanvasPatchTool(ctx)
    // SSE + REST routes for the canvas tab.
    registerCanvasRoutes(ctx)
    ctx.logger?.info?.(
      '[media-studio] registered generate_text + generate_image + generate_video + generate_music + canvas_graph_view + canvas_graph_patch + /api/media-studio/canvas/{sse,state}',
    )
  })
}

// Re-export DEFAULT_MEDIA_STUDIO so tests / debug tooling can pull the
// canonical defaults without re-importing from the settings module.
export { DEFAULT_MEDIA_STUDIO }
