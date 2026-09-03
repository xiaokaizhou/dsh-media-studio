// Client-side bindings for the asset library (M2). Plain fetch wrappers over
// the asset REST routes — browser-only, ok:false on errors for inline UI.

import { requestJson, type ApiResult } from './http-shared'

export type AssetKind = 'character' | 'scene' | 'audio' | 'clip'
export const ASSET_KINDS: AssetKind[] = ['character', 'scene', 'audio', 'clip']

export interface AssetAPI {
  id: string
  kind: AssetKind
  name: string
  file: string
  tags?: string[]
  bytes?: number
  meta?: { width?: number; height?: number; durationS?: number }
  origin?: { type: string; canvasNodeId?: string; model?: string; prompt?: string; fromProject?: string }
  copyOf?: { projectId: string; assetId: string }
  createdAt: string
  updatedAt: string
}

export interface AssetHitAPI {
  refProjectId: string
  assetId: string
  nodeIds: string[]
}

export function apiListAssets(projectId: string): Promise<ApiResult<{ assets: AssetAPI[] }>> {
  return requestJson(`/api/media-studio/assets?projectId=${encodeURIComponent(projectId)}`)
}

export function apiRegisterAsset(
  projectId: string,
  canvasNodeId: string,
  kind: AssetKind,
  name?: string,
): Promise<ApiResult<{ created: boolean; asset: AssetAPI }>> {
  return requestJson('/api/media-studio/assets/register', {
    method: 'POST',
    body: JSON.stringify({ projectId, canvasNodeId, kind, name: name ?? '' }),
  })
}

export function apiUpdateAsset(projectId: string, assetId: string, patch: { name?: string; tags?: string[] }): Promise<ApiResult<{ asset: AssetAPI }>> {
  return requestJson('/api/media-studio/assets/update', {
    method: 'POST',
    body: JSON.stringify({ projectId, assetId, ...patch }),
  })
}

export function apiAssetDependents(projectId: string, assetId: string): Promise<ApiResult<{ dependents: { totalRefs: number; hits: AssetHitAPI[] } }>> {
  return requestJson(`/api/media-studio/assets/dependents?projectId=${encodeURIComponent(projectId)}&assetId=${encodeURIComponent(assetId)}`)
}

export function apiDeleteAsset(
  projectId: string,
  assetId: string,
  cascade: 'cancel' | 'break-refs' | 'migrate-shared',
): Promise<ApiResult<{ result: { deleted: boolean; brokenNodes: number; migrated: boolean } }>> {
  return requestJson('/api/media-studio/assets/delete', {
    method: 'POST',
    body: JSON.stringify({ projectId, assetId, cascade }),
  })
}

export function apiCopyAsset(projectId: string, assetId: string, targetProjectId: string): Promise<ApiResult<{ created: boolean; asset: AssetAPI }>> {
  return requestJson('/api/media-studio/assets/copy', {
    method: 'POST',
    body: JSON.stringify({ projectId, assetId, targetProjectId }),
  })
}

export function apiSyncAsset(projectId: string, assetId: string): Promise<ApiResult<{ changed: boolean; asset: AssetAPI }>> {
  return requestJson('/api/media-studio/assets/sync-file', {
    method: 'POST',
    body: JSON.stringify({ projectId, assetId }),
  })
}
