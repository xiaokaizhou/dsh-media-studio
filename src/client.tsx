// dsh-media-studio — client entry for DSH web runtime.
//
// Registers two surfaces:
//   1. A betterSidebar TAB ("Media Studio") that hosts the React Flow
//      canvas. This is the primary surface — the agent's canvas tools
//      write to the same 'main' canvas the tab renders, so pipeline
//      updates land live via SSE.
//   2. A Settings section ("Media Studio") that lets the user configure
//      the text/image/video/music provider endpoints. Kept as a settings
//      section so it lives next to the other plugin settings.
//
// The betterSidebar service is a soft dependency: if dsh-better-sidebar
// is not installed we gracefully skip the tab (the canvas simply has no
// home) but the settings section still works through `slots`.

import type {} from 'dsh-better-sidebar' // triggers `ctx.betterSidebar` cordis augmentation
import { createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Canvas } from './client/canvas'
import { SettingsPanel } from './client/settings-panel'
import type { TabDescriptor } from 'dsh-better-sidebar'

/**
 * Runtime services we need:
 * - `betterSidebar` — to register the canvas tab (soft dependency)
 * - `slots`          — to register the Media Studio settings section
 */
export const inject = ['betterSidebar', 'slots']

/** The canvas every tab + tool shares. Matches the tool default so the
 *  agent's `canvas_graph_patch` / `canvas_graph_view` operate on the
 *  exact canvas the tab renders. */
export const DEFAULT_CANVAS_ID = 'main'

const roots = new Map<HTMLElement, Root>()

/**
 * Settings section rendered inside DSH Settings UI.
 *
 * The slots host may pass `{ close }` when the dialog closes; we accept
 * and ignore it — the host removes the DOM node, and React GC collects
 * our subtree automatically.
 */
function SettingsSection(_props?: { close?: () => void }): ReactNode {
  return createElement('div', {
    ref: (el: HTMLElement | null) => {
      if (!el || roots.has(el)) return
      const root = createRoot(el)
      roots.set(el, root)
      root.render(createElement(SettingsPanel, { host: el }))
    },
  })
}

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
        descriptor: { name: string; id?: string; order?: number; label?: () => string },
        comp: () => ReactNode,
      ) => void
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

  // 2) Settings section — provider configuration.
  if (c.slots && typeof c.slots.inject === 'function') {
    c.slots.inject('settings.section', () => {
      if (typeof c.slots!.register !== 'function') return
      c.slots!.register(
        {
          name: 'settings.section',
          id: 'dsh-media-studio-settings',
          order: 60,
          label: () => 'Media Studio',
        },
        SettingsSection,
      )
    })
  }
}
