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
import { createElement, type ReactNode } from 'react'
import { Canvas } from './client/canvas'
import ProjectApp from './client/project-bar'
import { registerLocaleDictionaries, translate, resolveLang, LOCALE_NS, type LocaleSource } from './client/i18n'
import { IconCanvas } from './client/icons'
import { subscribeProjectFocused } from './client/canvas-bus'

// Augment the global Window type with the SW preheat bridges set in
// `apply()` below. The Service Worker itself writes the same names to its
// own `globalThis`, but those bindings are unreachable from the page —
// this declaration makes TypeScript treat the page-side mirrors as
// first-class globals.
declare global {
  interface Window {
    __msPreheatVideo?: (url: string) => void
    __msPreheatAudio?: (url: string) => void
  }
}

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
 * Resolve the tab's display title from the host language. `title` supports a
 * function form so the + menu and freshly opened tabs pick up the current
 * DSH Settings → Language (zh → 「媒体工作室」, anything else → "Media Studio")
 * instead of being hardcoded to English.
 *
 * The dictionaries are registered against the host LocaleRuntime under
 * LOCALE_NS by registerLocaleDictionaries(); `translate(ns, key)` answers
 * with the active locale. When no LocaleSource is wired (standalone smoke
 * previews / tests) fall back to the module-level resolveLang() path.
 */
function resolveTabTitle(source: LocaleSource | null | undefined): string {
  if (source) {
    try {
      return source.translate(LOCALE_NS, 'tab.title')
    } catch {
      // host translate can throw on a torn-down runtime — fall through
    }
  }
  return translate(resolveLang(), 'tab.title')
}

/** Sidebar-tab glyph: the canvas grid mark, sized to the tab strip. */
function renderTabIcon(size: number): ReactNode {
  return createElement(IconCanvas, { size })
}

/**
 * Plugin entry point — called by the DSH client runtime once all declared
 * services are available.
 */
export function apply(ctx: unknown): void {
  const c = ctx as {
    /** Provided by dsh-better-sidebar (soft dependency). */
    betterSidebar?: {
      registerTab(descriptor: {
        id: string
        title: string | (() => string)
        icon?: (size: number) => ReactNode
        single?: boolean
        order?: number
        component: () => unknown
      }): () => void
    }
    /** Provided by @deepseek-ai/dsh-client-locale (soft dependency). */
    locale?: LocaleSource
  }

  // Resolve the soft locale dependency ONCE while this context is still
  // active. `c.locale` is a Cordis service getter that re-checks the fiber
  // state on EVERY access and throws `cannot get required service "locale"
  // in inactive context` once this context is marked inactive (hot reload /
  // runtime lifecycle management). Tab renders happen later, on the
  // betterSidebar render path, and must not re-enter the getter — caching
  // the resolved reference keeps them independent of the context lifecycle
  // (the LocaleRuntime methods we use — getSnapshot/subscribe/translate/
  // register — never touch the context).
  const locale = c.locale ?? null
  const disposeLocale = registerLocaleDictionaries(locale)

  const TAB_ID = 'media-studio:canvas'

  if (c.betterSidebar) {
    c.betterSidebar.registerTab({
      id: TAB_ID,
      title: () => resolveTabTitle(locale),
      icon: renderTabIcon,
      single: true,
      order: 40,
      component: () =>
        createElement(ProjectApp, {
          locale,
          fallbackCanvasId: DEFAULT_CANVAS_ID,
          renderCanvas: (canvasId: string) => createElement(Canvas, { canvasId, key: canvasId }),
        }),
    })

    // Auto-open the Media Studio sidebar tab when a project is focused by the
    // agent (media_studio_create_project / media_studio_open_project).
    //
    // This mirrors the browser-skill pattern: subscribe directly to
    // betterSidebar.state changes so we can call openTab() BEFORE the
    // SidebarFocusListener React component ever mounts (it only exists once
    // the tab is already open — a chicken-and-egg problem).
    //
    // Also subscribe to project-focused SSE events as a belt-and-suspenders
    // fallback: even if subscribeState fires on unrelated changes, the
    // project-focused guard ensures we only open when an agent creates/opens
    // a project.
    const SB = c.betterSidebar as {
      subscribeState?: (fn: () => void) => () => void
      openTab?: (seed: { type: string; id?: string }) => void
      getSnapshot?: () => { state?: { sessionId?: string } }
    }

    let pendingFocus = false

    // Mark that a project-focused SSE event arrived. This flag is consumed
    // by openIfNeeded() on the next betterSidebar state change (or immediately
    // on the initial call below).
    const markPending = () => { pendingFocus = true }
    subscribeProjectFocused(markPending)

    // Open the Media Studio tab when a project-focused event fires.
    // openTab is idempotent — safe to call even if the tab is already open.
    // We gate on pendingFocus so we only open when the agent explicitly
    // focused a project (create/open), not on every unrelated sidebar change.
    const openIfNeeded = () => {
      if (!pendingFocus) return
      try {
        SB.openTab?.({ type: TAB_ID, id: TAB_ID })
        pendingFocus = false
      } catch { /* best-effort */ }
    }

    // Subscribe to sidebar state changes so we open when the panel is ready.
    SB.subscribeState?.(openIfNeeded)

    // Try immediately — the sidebar may already be initialized.
    openIfNeeded()
  }

  // Tie dictionary unregistration to the plugin fiber so a future reload
  // (or a test teardown) doesn't leak stale dictionaries into the host.
  // We don't have a direct ctx.effect handle here (the ctx is typed `unknown`
  // for the soft-dependency ergonomics), so we register on unload via
  // window beforeunload as a best-effort. The runtime fiber unload is the
  // canonical path; beforeunload just covers hard reloads.
  if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => disposeLocale(), { once: true })

    // ── Service Worker 预热：拦截 media-file 请求，缓存前 256KB header ──
    // The SW lives at this same origin and intercepts /api/media-studio/media-file
    // requests with full Range support. After registration + claim it
    // takes over every subsequent media-file fetch on this page; the React
    // nodes call `window.__msPreheatVideo/Audio(url)` to ask the SW to
    // preheat a URL in the background. Registration is fire-and-forget:
    // if it fails (e.g. SW scope denied) the audio/video nodes still work
    // via the normal Range path, just without the in-memory SW cache.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .register('/api/media-studio/service-worker.js', { scope: '/' })
        .catch((err) => console.warn('[media-studio] SW registration failed:', err))

      // ── Main-thread → SW message bridge ──
      // The SW can only `globalThis` to itself (different Realm), so we
      // mirror the `__msPreheatVideo/Audio` functions on `window`. They
      // no-op until the SW is the active controller (i.e. claims the page),
      // which is fine — the first call after claim still gets a fresh
      // background prefetch.
      const makePreheat = (type: 'ms-preload-video' | 'ms-preload-audio') => (url: string) => {
        const ctrl = navigator.serviceWorker.controller
        if (!ctrl) return
        ctrl.postMessage({ type, url })
      }
      navigator.serviceWorker.ready
        .then(() => {
          window.__msPreheatVideo = makePreheat('ms-preload-video')
          window.__msPreheatAudio = makePreheat('ms-preload-audio')
        })
        .catch(() => { /* SW 失败也无所谓：原生 fetch 兜底 */ })
    }
  }
}
