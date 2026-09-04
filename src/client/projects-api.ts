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

/**
 * Subscribe to project-level SSE events (registry-changed / project-open /
 * project-deleted). Returns an unsubscribe function. EventSource reconnects
 * automatically; the initial snapshot arrives as registry-changed.
 */
export function subscribeProjects(handlers: { onRegistry: (reg: RegistryAPI) => void; onOpen?: (projectId: string, name?: string) => void }): () => void {
  let es: EventSource | null = null
  try {
    es = new EventSource('/api/media-studio/projects/sse')
  } catch (err) {
    console.error('[media-studio] failed to open project EventSource:', err)
    return () => {}
  }
  const handle = (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data) as { registry?: RegistryAPI; projectId?: string; name?: string }
      if (data.registry) handlers.onRegistry(data.registry)
      if (e.type === 'project-open' && data.projectId) handlers.onOpen?.(data.projectId, data.name)
    } catch { /* ignore malformed */ }
  }
  es.addEventListener('registry-changed', handle)
  es.addEventListener('project-open', handle)
  es.addEventListener('project-deleted', handle)
  return () => es?.close()
}
