// Client bindings for the M3 search + soft-reference routes.

import { requestJson, type ApiResult } from './http-shared'

export type SearchCatalog = 'library' | 'canvas'

export interface SearchItemAPI {
  key: string
  catalog: SearchCatalog
  ownerProjectId: string
  ownerProjectName: string
  assetId?: string
  canvasNodeId?: string
  kind: string
  name: string
  tags?: string[]
  prompt?: string
  bytes?: number
  updatedAt: string
  srcRaw: string | null
  alreadyRefCount: number
}

export interface SearchGroupAPI {
  key: 'current' | 'other'
  title: string
  total: number
  items: SearchItemAPI[]
}

export interface SearchResultAPI {
  q: string
  scopeProjectId: string | null
  hitCount: number
  limit: number
  groups: SearchGroupAPI[]
}

export function apiSearch(q: string, scope?: string | null): Promise<ApiResult<SearchResultAPI>> {
  const params = new URLSearchParams({ q })
  if (scope) params.set('scope', scope)
  params.set('limit', '20')
  return requestJson(`/api/media-studio/search?${params.toString()}`)
}

export function apiAddSoftRef(assetProjectId: string, assetId: string): Promise<ApiResult<{ nodeId: string; refCount: number; canvasId: string }>> {
  return requestJson('/api/media-studio/refs', {
    method: 'POST',
    body: JSON.stringify({ assetProjectId, assetId }),
  })
}

export function apiImportCanvas(projectId: string, canvasNodeId: string): Promise<ApiResult<{ created: boolean; asset: { id: string; name: string } }>> {
  return requestJson('/api/media-studio/search/import-canvas', {
    method: 'POST',
    body: JSON.stringify({ projectId, canvasNodeId }),
  })
}
