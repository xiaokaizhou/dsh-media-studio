// dsh-media-studio client entry — mounted by the DSH web runtime.
//
// Pattern follows dsh-harness-one's canvasui client.js:
//   1. Define an `inject` list declaring the client-runtime services we
//      need at apply() time (slots + UI primitives + modules).
//   2. Export an `apply(ctx, config)` that, when betterSidebar is present,
//      registers a sidebar tab pointing at our infinite canvas.
//   3. Wire an SSE subscription that mirrors the host's CanvasStore —
//      every canvas_graph_patch the agent runs lands here as a React Flow
//      node/edge update.
//
// The full React Flow canvas + settings panel + node types live in
// `client/canvas.tsx`, `client/nodes.tsx`, `client/panel.tsx`. This file
// is intentionally a thin bootstrap that the harness bundles.
//
// Loads lazily via `window.__DSH_BOOT__` (the runtime injects this module
// graph into the page before any DSH UI mounts).

import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Canvas } from './client/canvas'
import { SettingsPanel } from './client/settings-panel'

/** Runtime services we depend on. The harness guarantees these are live by
 *  the time apply() runs (per the dsh.client manifest in package.json). */
export const inject = [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-modules',
]

/** Cache the React roots so HMR can unmount cleanly. */
const roots = new Map<HTMLElement, Root>()

/** Mount the infinite-canvas editor into a host element. Returns a disposer
 *  that ReactDOM calls when the tab closes (unmount + cleanup). */
function mountCanvas(host: HTMLElement): () => void {
  // The slot might be reused across navigations; reuse the existing root.
  let root = roots.get(host)
  if (!root) {
    root = createRoot(host)
    roots.set(host, root)
  }
  root.render(createElement(Canvas, { host }))
  return () => {
    root?.unmount()
    roots.delete(host)
  }
}

/** Mount the per-canvas settings form (apiKey, baseURL, model pickers). */
function mountSettings(host: HTMLElement): () => void {
  let root = roots.get(host)
  if (!root) {
    root = createRoot(host)
    roots.set(host, root)
  }
  root.render(createElement(SettingsPanel, { host }))
  return () => {
    root?.unmount()
    roots.delete(host)
  }
}

/**
 * Client plugin entry. The harness calls this once per active DSH profile.
 *
 * Soft-deps on betterSidebar: if the user has not installed the sidebar
 * plugin, we surface a settings panel only — the canvas tab is omitted
 * (the agent can still drive the canvas through the chat UI).
 */
export function apply(ctx: unknown): void {
  const c = ctx as {
    inject(services: string[], body: (s: unknown) => void): void
    get(name: string): unknown
    effect(disposer: () => () => void, label?: string): void
    on(event: string, handler: (...args: unknown[]) => void): void
  }

  // Register the canvas tab IF better-sidebar is installed.
  c.inject(['@deepseek-ai/dsh-client-ui-slots'], () => {
    const slots = c.get('@deepseek-ai/dsh-client-ui-slots') as
      | { registerSlot(name: string, factory: (host: HTMLElement) => () => void): void }
      | undefined
    if (slots && typeof slots.registerSlot === 'function') {
      slots.registerSlot('media-studio-canvas', mountCanvas)
    }
  })

  // Register the settings panel slot (always available, even without
  // better-sidebar — the settings panel is consumed by the dsh Settings UI).
  c.inject(['@deepseek-ai/dsh-client-ui-slots'], () => {
    const slots = c.get('@deepseek-ai/dsh-client-ui-slots') as
      | { registerSlot(name: string, factory: (host: HTMLElement) => () => void): void }
      | undefined
    if (slots && typeof slots.registerSlot === 'function') {
      slots.registerSlot('media-studio-settings', mountSettings)
    }
  })
}
