import type { Context } from '@deepseek-ai/cordis'
// Value-import (not type-only) — needed for the `declare module` augmentation
// in @deepseek-ai/dsh-llm that adds `ctx.llm` to the cordis Context type.
import '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { MediaStudioSettings, NS, readMediaStudio, DEFAULT_MEDIA_STUDIO, type MediaStudioScope, type MediaStudioSettingsShape } from './settings'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { registerCanvasViewTool, registerCanvasPatchTool } from './tools'
import { CanvasStore } from './canvas-store'
import { registerCanvasRoutes } from './routes'
import type { ServerResponse } from 'node:http'

export const name = 'dsh-media-studio'

/** Expand a leading `~` in config paths so a default like
 *  `~/.franklin/media-studio` never lands in a literal `~` directory. */
function expandRoot(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${homedir()}${p.slice(1)}`
  return p
}
/**
 * `settings` — register + watch the user-facing mediaStudio namespace.
 * `llm` — read the harness-native LlmRuntime so text tools can use whatever
 *         provider the user already configured in `~/.dsh/settings.yaml`.
 * `tools` — register our canvas + media generation tools.
 * `webServer` — register the SSE / HTTP routes the canvas tab subscribes to.
 */
export const inject = ['settings', 'llm', 'tools', 'webServer']

export { Config }

import { getMediaStudioHandles, setMediaStudioHandles, type MediaStudioHandles } from './service-state'

/**
 * Lifecycle:
 *   1. Register `mediaStudio` settings namespace (immutable schema; user fills).
 *   2. Grab a typed scope handle for live reads.
 *   3. Stash plugin-scoped handles in the module singleton (service-state.ts).
 *      We deliberately do NOT assign `ctx.mediaStudio` — cordis' Context is a
 *      Proxy and assigning an un-declared service property throws, which
 *      fail-soft catches and silently disables the plugin. Tools + routes read
 *      via `getMediaStudioHandles()`.
 *   4. Snapshot the LlmRuntime reference for tool bridges.
 *   5. Wire settings.watch → ctx.effect so HMR / live edits are picked up.
 */
export function apply(ctx: Context, config: ConfigShape): void {
  ctx.inject(['settings', 'llm'], (sctx) => {
    // Register the namespace; the harness validates the schema and any
    // existing user section at load time. We accept whatever the user
    // already has — no destructive defaults.
    let scope: MediaStudioScope
    try {
      scope = sctx.settings.register(NS, MediaStudioSettings) as MediaStudioScope
    } catch (e) {
      ctx.logger?.error?.(`[media-studio] settings.register failed: ${(e as Error).message}`)
      throw e
    }

    // Attach plugin-scoped handles. Tool code reads these instead of going
    // through cordis lookup each call (and avoids "mediaStudio not bound"
    // races when tools execute before apply() finishes).

    // SSE client registry — the canvas tab's EventSource lands here so
    // `store.apply` can push live patches to every subscriber.
    const sseClients = new Set<ServerResponse>()

    // Broadcast hook wired into the store: writes the same wire shape the
    // SSE handler uses (`data: {type:'canvas-patch', canvasId, version,
    // graph, patch}`). Both the agent's `canvas_graph_patch` tool and the
    // client's REST PATCH endpoint go through `store.apply`, so a single
    // broadcast path keeps them in lockstep.
    const broadcast: import('./canvas-store').CanvasBroadcast = (canvasId, payload) => {
      // SSE named events: the client listens via
      // `addEventListener('canvas-patch', …)`. When only `data: …\n\n` is
      // emitted the browser dispatches a `message` event (not the named
      // one), so the React state never updates. Include `event:` line so
      // dispatch matches.
      const body = JSON.stringify({ type: 'canvas-patch', canvasId, ...payload })
      const msg = `event: canvas-patch\ndata: ${body}\n\n`
      for (const res of sseClients) {
        try { res.write(msg) } catch { /* client gone */ }
      }
    }

    // Expand `~` in config.workspaceRoot so defaults like
    // `~/.franklin/media-studio` resolve to a real home dir on every profile.
    const wsRoot = expandRoot(config.workspaceRoot)

    const canvasStore = new CanvasStore(wsRoot, { broadcast })
    // restore() runs in the background — we don't await because apply()
    // must be sync; the first tool call may race with disk read but the
    // in-memory state is empty either way.
    void canvasStore.restore()

    // Stash plugin-scoped handles in the module singleton (NOT ctx.mediaStudio —
    // assigning a service property the Proxy doesn't know about throws and
    // fail-soft disables the plugin). Tools + routes read via getMediaStudioHandles().
    const handles: MediaStudioHandles = {
      scope,
      getSettings: (): MediaStudioSettingsShape => readMediaStudio(scope),
      llm: sctx.llm,
      workspaceRoot: wsRoot,
      defaultCanvasId: config.defaultCanvasId,
      canvasStore,
      sseClients,
    }
    setMediaStudioHandles(handles)

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
      `[media-studio] ready: workspaceRoot=${wsRoot}, defaultCanvas=${config.defaultCanvasId}, ` +
      `textModel="${getMediaStudioHandles().getSettings().textModel || '(auto)'}"`,
    )

    // Canvas SSE + REST routes — register via ctx.effect (media-preview uses
    // the same ctx.effect + webServer.register pattern and is reachable from
    // the browser, so this is the sanctioned way to expose a plugin HTTP
    // endpoint in `dsh web`).
    ctx.effect(() => registerCanvasRoutes(ctx), 'media-studio: canvas routes')

    // Tool registration — each is wrapped so a single tool's schema/registration
    // error cannot throw out of apply() and (via fail-soft) disable the whole
    // plugin before the routes above are live.
    //
    // NOTE: the media-generation tools (generate_text / generate_image /
    // generate_video / generate_music) are intentionally NOT registered here —
    // the built-in `dsh-llm-multimodal` plugin already owns those global tool
    // names, and registering duplicates throws "tool already registered" and
    // crashes the whole plugin tree. The canvas tools below are unique to this
    // plugin and are what the agent uses to drive the infinite canvas.
    const toolRegs: Array<[string, () => void]> = [
      ['canvas_graph_view', () => registerCanvasViewTool(ctx)],
      ['canvas_graph_patch', () => registerCanvasPatchTool(ctx)],
    ]
    for (const [name, reg] of toolRegs) {
      try {
        reg()
      } catch (e) {
        ctx.logger?.error?.(`[media-studio] tool registration failed for ${name}: ${(e as Error).message}`)
      }
    }
    ctx.logger?.info?.(
      '[media-studio] registered canvas_graph_view + canvas_graph_patch + /api/media-studio/canvas/{sse,state,patch}',
    )
  })
}

// Re-export DEFAULT_MEDIA_STUDIO so tests / debug tooling can pull the
// canonical defaults without re-importing from the settings module.
export { DEFAULT_MEDIA_STUDIO }
