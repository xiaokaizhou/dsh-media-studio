// dsh-media-studio — client entry for DSH web runtime.
//
// The canvas tab now renders through the M1 project layer (ProjectApp):
// a top "项目" bar owns the multi-project registry, and the canvas element
// below is remounted (keyed by canvas id) whenever the active project
// changes, so its SSE subscription + viewport follow the project.
//
// The betterSidebar service is a soft dependency: if dsh-better-sidebar
// is not installed we gracefully skip the tab (the canvas simply has no
// home).

import type {} from 'dsh-better-sidebar' // triggers `ctx.betterSidebar` cordis augmentation
import { createElement } from 'react'
import { Canvas } from './client/canvas'
import ProjectApp from './client/project-bar'

/**
 * Runtime services we need. Only `betterSidebar` — the settings card was
 * removed when the LLM configuration moved to dsh-llm-multimodal.
 */
export const inject = ['betterSidebar']

/** Fallback canvas id before the registry resolves / when no project exists
 *  (kept identical to the tool default so the agent's canvas_* tools always
 *  target the same surface). */
export const DEFAULT_CANVAS_ID = 'main'

/**
 * Plugin entry point — called by the DSH client runtime once all declared
 * services are available.
 */
export function apply(ctx: unknown): void {
  const c = ctx as {
    /** Provided by dsh-better-sidebar (soft dependency). */
    betterSidebar?: { registerTab(descriptor: { id: string; title: string; single?: boolean; order?: number; component: () => unknown }): () => void }
  }

  if (c.betterSidebar) {
    c.betterSidebar.registerTab({
      id: 'media-studio:canvas',
      title: 'Media Studio',
      single: true,
      order: 40,
      component: () =>
        createElement(ProjectApp, {
          fallbackCanvasId: DEFAULT_CANVAS_ID,
          renderCanvas: (canvasId: string) => createElement(Canvas, { canvasId, key: canvasId }),
        }),
    })
  }
}
