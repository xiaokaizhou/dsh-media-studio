// dsh-media-studio — client entry for DSH web runtime.
//
// Registers two surfaces:
//   1. A betterSidebar TAB ("Media Studio") that hosts the React Flow
//      canvas. This is the primary surface — the agent's canvas tools
//      write to the same 'main' canvas the tab renders, so pipeline
//      updates land live via SSE.
//   2. A Settings card ("Media Studio") inside the DSH Plugins settings
//      section, keyed by the 'media-studio' namespace. The card binds a
//      `settingsScope` from `ctx.settingsScope.bind({namespace})` and uses
//      `scope.set / unset` to write user edits through the harness's
//      settings transport.
//
// The betterSidebar service is a soft dependency: if dsh-better-sidebar
// is not installed we gracefully skip the tab (the canvas simply has no
// home) but the settings card still works through `slots`.

import type {} from 'dsh-better-sidebar' // triggers `ctx.betterSidebar` cordis augmentation
import { createElement } from 'react'
import { Canvas } from './client/canvas'
import {
  MediaStudioCard,
  MediaStudioCardController,
  type SettingsScopeHandle,
  NS as SETTINGS_NS,
  LOCALE_NS,
  EN,
  zh,
  type MediaStudioLocaleKey,
} from './client/settings-panel'
import type { TabDescriptor } from 'dsh-better-sidebar'

/**
 * Runtime services we need:
 * - `betterSidebar` — to register the canvas tab (soft dependency)
 * - `slots`          — to register the Media Studio settings card
 * - `locale`         — to register zh/en copy dictionaries
 * - `settingsScope`  — to bind the 'media-studio' settings namespace
 */
export const inject = ['betterSidebar', 'slots', 'locale', 'settingsScope']

/** The canvas every tab + tool shares. Matches the tool default so the
 *  agent's `canvas_graph_patch` / `canvas_graph_view` operate on the
 *  exact canvas the tab renders. */
export const DEFAULT_CANVAS_ID = 'main'

/**
 * Plugin entry point — called by the DSH client runtime once all declared
 * services are available.
 */
export function apply(ctx: unknown): void {
  const c = ctx as {
    /** Provided by dsh-better-sidebar (soft dependency). */
    betterSidebar?: { registerTab(descriptor: TabDescriptor): () => void }
    /** Provided by @deepseek-ai/dsh-client-ui-slots. */
    slots?: {
      inject: (path: string, cb: () => void) => void
      register: (
        descriptor: {
          name: string
          id?: string
          key?: string
          order?: number
          label?: () => string
          locale?: string
          inject?: () => Record<string, unknown>
        },
        comp: (...args: unknown[]) => unknown,
      ) => void
    }
    /** Provided by @deepseek-ai/dsh-client-locale. */
    locale?: {
      register: (ns: string, dicts: { zh: Record<string, string>; en: Record<string, string> }) => void
      bind: (ns: string) => (key: string) => string
    }
    /** Provided by @deepseek-ai/dsh-client-ui-settings. */
    settingsScope?: {
      bind: <T>(spec: { namespace: string }) => SettingsScopeHandle
    }
  }

  // 1) Canvas tab — the headline surface.
  if (c.betterSidebar) {
    c.betterSidebar.registerTab({
      id: 'media-studio:canvas',
      title: 'Media Studio',
      // One shared canvas instance per workspace (the canvas is keyed by
      // 'main', not by the conversation), so reopening focuses the same tab
      // instead of spawning duplicates.
      single: true,
      // Sit near the top of the + menu, just under the built-in explorers.
      order: 40,
      component: () => createElement(Canvas, { canvasId: DEFAULT_CANVAS_ID }),
    })
  }

  // 2) Settings card — registered inside the DSH Plugins settings section.
  //    Uses the native `settings.plugin.item` keyed slot so it appears
  //    alongside other configurable plugin cards with the same UX.
  if (c.slots && typeof c.slots.inject === 'function') {
    // Register zh/en copy dictionaries so the locale system can serve them.
    if (c.locale) {
      c.locale.register(LOCALE_NS, { zh, en: EN })
    }

    const t = c.locale?.bind(LOCALE_NS) ?? ((k: string) => k)

    c.slots.inject('settings.plugin.item', () => {
      if (typeof c.slots!.register !== 'function') return
      if (!c.settingsScope) return

      // The card is fully self-contained: it does not import the internal
      // `textField` / `CardForm` / `ValueField` symbols (those are NOT
      // exported from the browser wrapper and any value-import would crash
      // the loader).
      const scopeCtrl = c.settingsScope.bind({ namespace: SETTINGS_NS })
      const controller = new MediaStudioCardController(scopeCtrl)

      c.slots!.register(
        {
          name: 'settings.plugin.item',
          key: SETTINGS_NS,
          order: 60,
          label: () => t('title' as MediaStudioLocaleKey),
          locale: LOCALE_NS,
          inject: () => ({
            t,
            controller,
          }),
        },
        MediaStudioCard,
      )
    })
  }
}