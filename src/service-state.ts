import type { CanvasStore } from './canvas-store'
import type { ProjectStore } from './project-store'
import type { ServerResponse } from 'node:http'

/**
 * Plugin-scoped handles shared between the host `apply()` (which builds them),
 * the canvas HTTP/SSE routes (routes.ts), and the agent tools (tools.ts).
 *
 * NOTE: we deliberately do NOT hang these off `ctx.mediaStudio`. cordis'
 * `Context` is a Proxy that rejects assigning a service property unless it is
 * installed through the `Service` mechanism; a bare `ctx.mediaStudio = {...}`
 * throws at runtime (the `declare module` augmentation is type-only and is
 * erased), which silently disabled the whole plugin via fail-soft. A
 * module-level singleton sidesteps the Proxy entirely and is safe for a
 * single-instance plugin.
 *
 * After the multimodal refactor we no longer hold `ctx.llm`,
 * `scope.getSettings()` for a mediaStudio namespace, or any media-provider
 * configuration. The plugin's only persistent state is the canvas store
 * + SSE-client registry.
 */
export interface MediaStudioHandles {
  /** Resolved absolute workspace directory. */
  workspaceRoot: string
  /**
   * Extra absolute roots the media-file proxy may serve from, on top of
   * `workspaceRoot` (config `mediaRoots`, `~` already expanded). Optional so
   * call sites that predate the setting keep compiling; an absent or empty
   * list means "workspaceRoot only", i.e. the original behaviour.
   */
  mediaRoots?: string[]
  /** Canvas id every tool falls back to when none is supplied. */
  defaultCanvasId: string
  /** Server-side canvas state (atomic, persisted). */
  canvasStore: CanvasStore
  /** SSE client registry — keyed by canvasId (M4-③) so a patch on canvas
   *  A is only delivered to clients that subscribed to canvas A. */
  sseClients: Map<string, Set<ServerResponse>>
  /** Multi-project registry (added M0). Absent during transitional boots. */
  projectStore?: ProjectStore
  /** SSE client registry for project-level events (registry/open/delete). */
  projectSseClients?: Set<ServerResponse>
  /** Plugin logger (cordis ctx.logger). Absent in unit-test environments. */
  logger?: {
    info?: (msg: string) => void
    warn?: (msg: string) => void
    error?: (msg: string) => void
    debug?: (msg: string) => void
  }
}

let handles: MediaStudioHandles | null = null

export function setMediaStudioHandles(h: MediaStudioHandles): void {
  handles = h
}

export function getMediaStudioHandles(): MediaStudioHandles {
  if (!handles) throw new Error('media-studio: handles not initialized before use')
  return handles
}

/** Safe logger that falls back to console when handles aren't initialized
 *  (e.g. unit tests that call pure functions directly). Use this instead
 *  of `getMediaStudioHandles().logger?.xxx?.()` in modules that may be
 *  invoked outside the plugin lifecycle. */
export const log = {
  info: (msg: string): void => { try { handles?.logger?.info?.(msg) } catch { /* ignore */ } },
  warn: (msg: string): void => { try { handles?.logger?.warn?.(msg) } catch { /* ignore */ } },
  error: (msg: string): void => { try { handles?.logger?.error?.(msg) } catch { /* ignore */ } },
  debug: (msg: string): void => { try { handles?.logger?.debug?.(msg) } catch { /* ignore */ } },
}
