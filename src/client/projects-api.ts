// Client-side REST + SSE bindings for the project layer (M1).
//
// Mirrors canvas-api.ts conventions: plain fetch wrappers over the host
// routes, browser-only (no node imports), returns ok:false instead of
// throwing so the UI can render inline errors.

export interface ProjectMetaAPI {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  /** Absolute path to the user's project directory; absent for legacy entries. */
  sourcePath?: string
  legacy?: boolean
}

export interface RegistryAPI {
  activeId: string | null
  recent: string[]
  projects: ProjectMetaAPI[]
}

export interface RefHitAPI {
  refProjectId: string
  refProjectName: string
  assetId: string
  nodeIds: string[]
}

export interface DependentsAPI {
  totalRefs: number
  hits: RefHitAPI[]
  copyConsumers: Array<{ projectId: string; projectName: string; count: number }>
}

export interface DeleteResultAPI {
  deletedId: string
  switchedTo: string | null
  mode: 'trash' | 'permanent'
  cascade: 'cancel' | 'break-refs' | 'migrate-shared'
  migratedFiles?: number
  migratedAssets?: number
  rewrittenNodes?: number
  brokenNodes?: number
}

import { requestJson, type ApiResult } from './http-shared'

// deleteProject may carry a 409 dependents payload; expose it on Err.
export type { ApiResult }

export function fetchProjects(): Promise<ApiResult<RegistryAPI & { recentLimit?: number }>> {
  return requestJson('/api/media-studio/projects')
}

export function apiCreateProject(name?: string, sourcePath?: string): Promise<ApiResult<{ project: ProjectMetaAPI; registry: RegistryAPI }>> {
  return requestJson('/api/media-studio/projects/create', { method: 'POST', body: JSON.stringify({ name: name ?? '', sourcePath }) })
}

export function apiOpenFolder(folderName: string, sourcePath?: string): Promise<ApiResult<{ project: ProjectMetaAPI; registry: RegistryAPI }>> {
  return requestJson('/api/media-studio/projects/open-folder', { method: 'POST', body: JSON.stringify({ folderName, sourcePath }) })
}

export function apiPickFolder(): Promise<ApiResult<{ canceled: boolean; path: string | null }>> {
  return requestJson('/api/media-studio/projects/pick-folder', { method: 'POST' })
}

/**
 * Reveal a project's on-disk folder in the host's native file manager
 * (Finder / Explorer / xdg-open). The server resolves the path from the
 * project's `sourcePath` (preferred) or the legacy managed
 * `<workspaceRoot>/projects/<id>` location and spawns the platform's
 * file-manager command detached — so the request returns as soon as the
 * child has launched even if the GUI window stays open.
 *
 * Pass `projectId` to reveal a non-active project (e.g. from a recent
 * list); omit it to reveal the currently active project. Returns the
 * resolved absolute path on success so the UI can show a confirmation.
 */
export function apiRevealProject(projectId?: string): Promise<ApiResult<{ projectId: string; path: string }>> {
  return requestJson('/api/media-studio/projects/reveal', {
    method: 'POST',
    body: JSON.stringify(projectId ? { projectId } : {}),
  })
}

export function apiOpenProject(projectId: string): Promise<ApiResult<{ project: ProjectMetaAPI; registry: RegistryAPI }>> {
  return requestJson('/api/media-studio/projects/open', { method: 'POST', body: JSON.stringify({ projectId }) })
}

export function apiRenameProject(projectId: string, name: string): Promise<ApiResult<{ project: ProjectMetaAPI; registry: RegistryAPI }>> {
  return requestJson('/api/media-studio/projects/rename', { method: 'POST', body: JSON.stringify({ projectId, name }) })
}

export function apiFetchDependents(projectId: string): Promise<ApiResult<{ dependents: DependentsAPI }>> {
  return requestJson(`/api/media-studio/projects/dependents?projectId=${encodeURIComponent(projectId)}`)
}

export function apiDeleteProject(
  projectId: string,
  opts: { mode?: 'trash' | 'permanent'; cascade?: 'cancel' | 'break-refs' | 'migrate-shared' },
): Promise<ApiResult<{ result: DeleteResultAPI; registry: RegistryAPI }>> {
  return requestJson('/api/media-studio/projects/delete', {
    method: 'POST',
    body: JSON.stringify({ projectId, mode: opts.mode ?? 'trash', cascade: opts.cascade ?? 'cancel' }),
  })
}

import { subscribeRegistry, subscribeProjectOpen } from './canvas-bus'

/**
 * Subscribe to project-level SSE events (registry-changed / project-open /
 * project-deleted). Returns an unsubscribe function.
 *
 * Uses the SHARED unified SSE bus (canvas-bus.ts) instead of opening its own
 * EventSource. See canvas-bus.ts header for why: a second /projects/sse
 * socket pushed the tab past the HTTP/1.1 six-connection limit and queued
 * every short REST call behind the SSE sockets.
 */
export function subscribeProjects(handlers: { onRegistry: (reg: RegistryAPI) => void; onOpen?: (projectId: string, name?: string) => void }): () => void {
  const offReg = subscribeRegistry(handlers.onRegistry)
  const offOpen = handlers.onOpen ? subscribeProjectOpen(handlers.onOpen) : null
  return () => {
    offReg()
    offOpen?.()
  }
}
