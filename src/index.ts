import type { Context } from '@deepseek-ai/cordis'
// Type-only import — pulls in `@deepseek-ai/dsh-llm/lib/types/index.d.ts`
// which declares `module '@deepseek-ai/cordis'` so `ctx.llm` is in scope.
//
// IMPORTANT: this is type-only (rolldown erases the statement). The
// `dsh-media-studio` plugin USED to need `ctx.llm` because it owned its own
// `generate_text` tool. After the multimodal refactor that tool moved to
// the `dsh-llm-multimodal` plugin; this plugin no longer calls into
// `ctx.llm` at runtime.
//
// We keep the type-only import only because other modules in this package
// still type-annotate calls that consume ctx.llm-shaped values (for
// compatibility during a transitional period). When the migration is
// fully settled the import can be removed.
import type {} from '@deepseek-ai/dsh-llm'
import { homedir } from 'node:os'
import { Config } from './config'
import type { Config as ConfigShape } from './config'
import { registerCanvasViewTool, registerCanvasPatchTool, registerAutoArrangeTool, registerCanvasRefreshNodeTool } from './tools'
import { CanvasStore } from './canvas-store'
import { registerCanvasRoutes } from './routes'
import { ProjectStore, type ProjectEvent } from './project-store'
import { registerProjectRoutes } from './project-routes'
import { registerAssetRoutes } from './asset-routes'
import { registerSearchRoutes } from './search-routes'
import type { ServerResponse } from 'node:http'

export const name = 'dsh-media-studio'

/** Expand a leading `~` in config paths so a default like
 *  `~/.media-studio` never lands in a literal `~` directory. */
function expandRoot(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return `${homedir()}${p.slice(1)}`
  return p
}

/**
 * Services required by the plugin:
 *
 *   - `tools`   — register the four canvas_* tools (the
 *                 generate_text/image/video/tts/music tools live in the
 *                 sibling `dsh-llm-multimodal` plugin and are reached via
 *                 `ctx.tools.execute({ name: 'generate_image', ... })`
 *                 from `canvas_refresh_node` and friends).
 *   - `webServer` — register the canvas SSE / REST routes the tab subscribes to.
 *
 * `settings` and `llm` are NO LONGER declared here: the multimodal plugin
 * owns the `llm-multimodal` settings namespace, and the plugin no longer
 * reads `ctx.llm` directly.
 */
export const inject = ['tools', 'webServer']

export { Config }

import { getMediaStudioHandles, setMediaStudioHandles, type MediaStudioHandles } from './service-state'

/**
 * Lifecycle:
 *   1. Stash plugin-scoped handles in the module singleton (service-state.ts).
 *      We deliberately do NOT assign `ctx.mediaStudio` — cordis' Context is a
 *      Proxy and assigning an un-declared service property throws, which
 *      fail-soft catches and silently disables the plugin. Tools + routes read
 *      via `getMediaStudioHandles()`.
 *   2. Build the canvas store (the only persistent state this plugin owns).
 *   3. Wire SSE broadcast through the store so the agent's
 *      `canvas_graph_patch` tool AND the client's REST PATCH endpoint both
 *      push to the canvas tab through one path.
 *   4. Register canvas HTTP routes.
 *   5. Register canvas_* tools (one tool's failure must not break the rest).
 */
export function apply(ctx: Context, config: ConfigShape): void {
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
  // `~/.media-studio` resolve to a real home dir on every profile.
  const wsRoot = expandRoot(config.workspaceRoot)
  // Extra roots the media-file proxy may serve from. Without these, media an
  // agent parks outside the plugin workspace (a project folder under
  // ~/Movies, say) is refused with 403 and every image/video/music node on
  // the canvas renders as "failed to load".
  const mediaRoots = (config.mediaRoots ?? []).map(expandRoot)

  const canvasStore = new CanvasStore(wsRoot, { broadcast })
  // restore() runs in the background — we don't await because apply()
  // must be sync; the first tool call may race with disk read but the
  // in-memory state is empty either way. The ProjectStore's boot also calls
  // restore() (version-guarded) before dependents scans can run.
  void canvasStore.restore()

  // ── Project layer (M0) ──────────────────────────────────────────────────
  // Project-level SSE clients + broadcast closure for registry/open/delete
  // events; the ProjectStore serializes every mutation and calls back here.
  const projectSseClients = new Set<ServerResponse>()
  const broadcastProject = (event: ProjectEvent) => {
    const body = JSON.stringify({ ...event, registry: event.registry ?? { activeId: null, recent: [], projects: [] } })
    const msg = `event: ${event.type}\ndata: ${body}\n\n`
    for (const res of projectSseClients) {
      try { res.write(msg) } catch { /* client gone */ }
    }
  }
  const projectStore = new ProjectStore(wsRoot, canvasStore, {
    recentLimit: config.recentLimit,
    trashEnabled: config.trashEnabled,
    onEvent: broadcastProject,
  })

  // Stash plugin-scoped handles. Tools + routes read via getMediaStudioHandles().
  const handles: MediaStudioHandles = {
    workspaceRoot: wsRoot,
    mediaRoots,
    defaultCanvasId: config.defaultCanvasId,
    canvasStore,
    sseClients,
    projectStore,
    projectSseClients,
  }
  setMediaStudioHandles(handles)

  // Surface the default workspace at boot so the canvas store can read it
  // before any user interaction.
  ctx.logger?.info?.(
    `[media-studio] ready: workspaceRoot=${wsRoot}, mediaRoots=[${mediaRoots.join(', ')}], defaultCanvas=${config.defaultCanvasId}, recentLimit=${config.recentLimit}`,
  )

  // Canvas SSE + REST routes + project routes — register via ctx.effect
  // (media-preview uses the same ctx.effect + webServer.register pattern and
  // is reachable from the browser, so this is the sanctioned way to expose a
  // plugin HTTP endpoint in `dsh web`).
  ctx.effect(() => registerCanvasRoutes(ctx), 'media-studio: canvas routes')
  ctx.effect(() => registerProjectRoutes(ctx), 'media-studio: project routes')
  ctx.effect(() => registerAssetRoutes(ctx), 'media-studio: asset routes')
  ctx.effect(() => registerSearchRoutes(ctx), 'media-studio: search routes')

  // Tool registration — each is wrapped so a single tool's schema/registration
  // error cannot throw out of apply() and (via fail-soft) disable the whole
  // plugin before the routes above are live.
  //
  // NOTE: the media-generation tools (generate_text / generate_image /
  // generate_video / generate_tts / generate_music) live in the sibling
  // `dsh-llm-multimodal` plugin and are reached via ctx.tools.execute(...)
  // from `canvas_refresh_node` whenever the user clicks "regenerate" on a
  // canvas node. This plugin only owns the four canvas_* tools.
  const toolRegs: Array<[string, () => void]> = [
    ['canvas_graph_view', () => registerCanvasViewTool(ctx)],
    ['canvas_graph_patch', () => registerCanvasPatchTool(ctx)],
    ['canvas_auto_arrange', () => registerAutoArrangeTool(ctx)],
    ['canvas_refresh_node', () => registerCanvasRefreshNodeTool(ctx)],
  ]
  for (const [name, reg] of toolRegs) {
    try {
      reg()
    } catch (e) {
      ctx.logger?.error?.(`[media-studio] tool registration failed for ${name}: ${(e as Error).message}`)
    }
  }
  ctx.logger?.info?.(
    '[media-studio] registered canvas_graph_view + canvas_graph_patch + canvas_auto_arrange + canvas_refresh_node + /api/media-studio/canvas/{sse,state,patch,refresh} + /api/media-studio/projects*',
  )
}
