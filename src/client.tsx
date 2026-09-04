// dsh-media-studio — client entry for DSH web runtime.
//
// The canvas tab now renders through the M1 project layer (ProjectApp):
// a top "项目" bar owns the multi-project registry, and the canvas element
// below is remounted (keyed by canvas id) whenever the active project
// changes, so its SSE subscription + viewport follow the project.
//
// Two soft runtime services are pulled in here:
//   • betterSidebar — required to surface the tab; the canvas simply has
//     no home if the plugin is not installed.
//   • locale — used to register our own dictionary namespace under
//     `media-studio` and to subscribe to the host-wide Settings → Language
//     switch. Without it the project bar falls back to its own localStorage
//     override so smoke previews still render.

import type {} from 'dsh-better-sidebar' // triggers `ctx.betterSidebar` cordis augmentation
import { createElement } from 'react'
import { Canvas } from './client/canvas'
import ProjectApp from './client/project-bar'
import { registerLocaleDictionaries, type LocaleSource } from './client/i18n'

/**
 * Runtime services we need. Both are soft dependencies — without them we
 * still register what we can; the UI just degrades.
 *   - betterSidebar: tab surface.
 *   - locale:        Settings → Language source of truth (used to wire
 *                    ProjectApp to the host-wide switch and to register
 *                    our zh/en dictionary under `media-studio`).
 */
export const inject = ['betterSidebar', 'locale']

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
    /** Provided by @deepseek-ai/dsh-client-locale (soft dependency). */
    locale?: LocaleSource
  }

  // Register the media-studio dictionary into the host LocaleSource under
  // our own namespace. The host's lookup chain (active → en → common → key)
  // then handles missing keys; we just hand over both languages and a
  // disposer for ctx.effect wiring.
  const disposeLocale = registerLocaleDictionaries(c.locale)

  if (c.betterSidebar) {
    c.betterSidebar.registerTab({
      id: 'media-studio:canvas',
      title: 'Media Studio',
      single: true,
      order: 40,
      component: () =>
        createElement(ProjectApp, {
          locale: c.locale ?? null,
          fallbackCanvasId: DEFAULT_CANVAS_ID,
          renderCanvas: (canvasId: string) => createElement(Canvas, { canvasId, key: canvasId }),
        }),
    })
  }

  // Tie dictionary unregistration to the plugin fiber so a future reload
  // (or a test teardown) doesn't leak stale dictionaries into the host.
  // We don't have a direct ctx.effect handle here (the ctx is typed `unknown`
  // for the soft-dependency ergonomics), so we register on unload via
  // window beforeunload as a best-effort. The runtime fiber unload is the
  // canonical path; beforeunload just covers hard reloads.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => disposeLocale(), { once: true })
  }
}
