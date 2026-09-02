import type { MediaStudioScope, MediaStudioSettingsShape } from './settings'
import type { CanvasStore } from './canvas-store'
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
 */
export interface MediaStudioHandles {
  scope: MediaStudioScope
  getSettings(): MediaStudioSettingsShape
  /** Resolved harness LLM reference (may be undefined if no adapter configured). */
  llm: unknown
  /** Resolved absolute workspace directory. */
  workspaceRoot: string
  /** Canvas id every tool falls back to when none is supplied. */
  defaultCanvasId: string
  /** Server-side canvas state (atomic, persisted). */
  canvasStore: CanvasStore
  /** SSE client registry — the canvas tab's EventSource lands here. */
  sseClients: Set<ServerResponse>
}

let handles: MediaStudioHandles | null = null

export function setMediaStudioHandles(h: MediaStudioHandles): void {
  handles = h
}

export function getMediaStudioHandles(): MediaStudioHandles {
  if (!handles) throw new Error('media-studio: handles not initialized before use')
  return handles
}
