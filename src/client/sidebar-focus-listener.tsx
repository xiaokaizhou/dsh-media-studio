// SidebarFocusListener — client-only React component that wires the
// `project-focused` SSE event (fired by media_studio_create_project /
// media_studio_open_project on the server) to the dsh-better-sidebar
// `activateTab` API. Goal: when the LLM creates or opens a project, the
// Media Studio sidebar tab auto-activates and the user sees the canvas
// without manual interaction.
//
// Pairs with the SSE event emitted by ProjectStore.createProject /
// openProject; see project-store.ts and project-routes.ts for the wire
// shape (`event: project-focused\ndata: { projectId, name, source }`).
//
// `betterSidebar` is a soft dependency (see client.tsx). When absent
// (older host / smoke previews), the listener no-ops silently.
//
// Uses the SHARED unified SSE bus (canvas-bus.ts) instead of opening its
// own EventSource. See canvas-bus.ts header for why: every extra SSE
// socket pushes the tab closer to the HTTP/1.1 six-connection limit.

import { useEffect } from 'react'
import { subscribeProjectFocused } from './canvas-bus'

/** Minimal BetterSidebar service surface we depend on. The full type lives
 *  in dsh-better-sidebar's lib/types; we declare a structural subset to
 *  avoid coupling the client bundle to the host package at compile time. */
interface SidebarService {
  activateTab?: (tabId: string) => void
  openTab?: (seed: { type: string; id?: string; title?: string }) => void
}

declare global {
  interface Window {
    __DSH_BETTER_SIDEBAR__?: SidebarService
    /** Some hosts publish the service as a global (injected by the shell). */
    DSH_BETTER_SIDEBAR?: SidebarService
  }
}

const TAB_ID = 'media-studio:canvas'

/** Resolve the host's betterSidebar service handle. Returns undefined when
 *  the host has not published it — callers must no-op in that case. */
function resolveSidebar(): SidebarService | undefined {
  if (typeof window === 'undefined') return undefined
  return window.__DSH_BETTER_SIDEBAR__ ?? window.DSH_BETTER_SIDEBAR
}

/**
 * Mount once inside ProjectApp. Subscribes to `project-focused` events on
 * the shared SSE bus and on every event asks the host to activate the Media
 * Studio sidebar tab. Also activates on mount, so a user who never closed
 * the tab but lost focus gets re-focused when the project tree remounts
 * (e.g. after a project switch).
 */
export function SidebarFocusListener(): null {
  useEffect(() => {
    const activate = () => {
      const sb = resolveSidebar()
      if (!sb) return
      try {
        sb.openTab?.({ type: TAB_ID, id: TAB_ID, title: 'Media Studio' })
        sb.activateTab?.(TAB_ID)
      } catch (err) {
        // best-effort: a broken host shouldn't tear down the canvas.
        console.warn('[media-studio] sidebar focus failed:', err)
      }
    }

    // Activate on mount so the tab is in view before the first canvas_* call.
    activate()

    // Subscribe to project-focused on the shared bus (no separate EventSource).
    const off = subscribeProjectFocused(() => {
      activate()
    })

    return off
  }, [])

  return null
}
