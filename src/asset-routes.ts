/**
 * Asset REST routes (M2) — library browsing, canvas registration, metadata
 * updates, deletion with dependency preflight, hard copies across projects,
 * and the "sync library file from canvas" refresh.
 *
 * The asset layer has no store class of its own: it orchestrates the pure
 * asset-store helpers with the handles' workspaceRoot / mediaRoots /
 * canvasStore / projectStore and pushes `asset-changed` SSE events on the
 * shared projects stream so open panels refresh.
 */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getMediaStudioHandles } from './service-state'
import {
  ASSET_KINDS,
  registerCanvasAsset,
  listAssets,
  updateAssetMeta,
  deleteAsset,
  copyAssetToProject,
  syncAssetFromCanvas,
  scanCanvasRefs,
  type AssetKind,
} from './asset-store'

export type AssetChangeType = 'registered' | 'updated' | 'deleted' | 'copied' | 'synced'

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        resolve(body)
      } catch (e) {
        reject(new Error(`invalid JSON body: ${(e as Error).message}`))
      }
    })
    req.on('error', reject)
  })
}

function broadcastAssetEvent(projectId: string, assetIds: string[], change: AssetChangeType): void {
  const clients = getMediaStudioHandles().projectSseClients
  if (!clients) return
  const body = JSON.stringify({ type: 'asset-changed', projectId, assetIds, change })
  const msg = `event: asset-changed\ndata: ${body}\n\n`
  for (const res of clients) {
    try { res.write(msg) } catch { /* client gone */ }
  }
}

function asKind(v: unknown): AssetKind | null {
  return typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v) ? (v as AssetKind) : null
}

export function registerAssetRoutes(ctx: Context): () => void {
  const wserver = ctx.webServer
  const handles = () => getMediaStudioHandles()
  const projectIds = (): string[] => {
    const ps = handles().projectStore
    return ps ? ps.snapshot().projects.map((p) => p.id) : []
  }

  // GET /assets?projectId= → { assets: [...], projectId }
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets',
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const pid = url.searchParams.get('projectId') ?? ''
          if (!pid) { json(res, 400, { ok: false, error: 'projectId is required' }); return }
          const assets = await listAssets(handles().workspaceRoot, pid)
          json(res, 200, { ok: true, projectId: pid, assets })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // POST /assets/register { projectId, canvasNodeId, kind, name? }
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/register',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const pid = String(body.projectId ?? '').trim()
          const nodeId = String(body.canvasNodeId ?? '').trim()
          const kind = asKind(body.kind)
          if (!pid || !nodeId) { json(res, 400, { ok: false, error: 'projectId and canvasNodeId are required' }); return }
          if (!kind) { json(res, 400, { ok: false, error: `kind must be one of: ${ASSET_KINDS.join(', ')}` }); return }
          const h = handles()
          const r = await registerCanvasAsset({
            wsRoot: h.workspaceRoot,
            roots: h.mediaRoots ?? [],
            canvasStore: h.canvasStore,
            projectId: pid,
            canvasNodeId: nodeId,
            kind,
            name: typeof body.name === 'string' ? body.name : undefined,
          })
          broadcastAssetEvent(pid, [r.asset.id], r.created ? 'registered' : 'updated')
          json(res, r.created ? 201 : 200, { ok: true, created: r.created, asset: r.asset })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // POST /assets/update { projectId, assetId, name?, tags? }
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/update',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const pid = String(body.projectId ?? '').trim()
          const aid = String(body.assetId ?? '').trim()
          if (!pid || !aid) { json(res, 400, { ok: false, error: 'projectId and assetId are required' }); return }
          const h = handles()
          const patch: { name?: string; tags?: string[] } = {}
          if (body.name !== undefined) patch.name = String(body.name)
          if (Array.isArray(body.tags)) patch.tags = (body.tags as unknown[]).map((x) => String(x)).slice(0, 12)
          const asset = await updateAssetMeta(h.workspaceRoot, pid, aid, patch)
          broadcastAssetEvent(pid, [aid], 'updated')
          json(res, 200, { ok: true, asset })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // GET /assets/dependents?projectId=&assetId=  (asset-level deletion preflight)
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/dependents',
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const pid = url.searchParams.get('projectId') ?? ''
          const aid = url.searchParams.get('assetId') ?? ''
          if (!pid || !aid) { json(res, 400, { ok: false, error: 'projectId and assetId are required' }); return }
          const h = handles()
          const ids = projectIds().filter((x) => x !== pid)
          const hits = scanCanvasRefs(h.canvasStore, ids, pid, aid)
          json(res, 200, { ok: true, dependents: { totalRefs: hits.reduce((s, x) => s + x.nodeIds.length, 0), hits } })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // POST /assets/delete { projectId, assetId, cascade: cancel|break-refs|migrate-shared }
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/delete',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const pid = String(body.projectId ?? '').trim()
          const aid = String(body.assetId ?? '').trim()
          if (!pid || !aid) { json(res, 400, { ok: false, error: 'projectId and assetId are required' }); return }
          const cascadeRaw = String(body.cascade ?? 'cancel')
          const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
          const h = handles()
          const result = await deleteAsset(h.workspaceRoot, h.canvasStore, pid, aid, cascade, projectIds())
          broadcastAssetEvent(pid, [aid], 'deleted')
          json(res, 200, { ok: true, result })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // POST /assets/copy { projectId, assetId, targetProjectId }
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/copy',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const pid = String(body.projectId ?? '').trim()
          const aid = String(body.assetId ?? '').trim()
          const target = String(body.targetProjectId ?? '').trim()
          if (!pid || !aid || !target) { json(res, 400, { ok: false, error: 'projectId, assetId and targetProjectId are required' }); return }
          const h = handles()
          const r = await copyAssetToProject(h.workspaceRoot, pid, aid, target)
          broadcastAssetEvent(target, [r.asset.id], r.created ? 'copied' : 'updated')
          json(res, r.created ? 201 : 200, { ok: true, created: r.created, asset: r.asset })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // POST /assets/sync-file { projectId, assetId }  — update library file from its canvas node
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/assets/sync-file',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const pid = String(body.projectId ?? '').trim()
          const aid = String(body.assetId ?? '').trim()
          if (!pid || !aid) { json(res, 400, { ok: false, error: 'projectId and assetId are required' }); return }
          const h = handles()
          const r = await syncAssetFromCanvas(h.workspaceRoot, h.mediaRoots ?? [], h.canvasStore, pid, aid)
          if (r.changed) broadcastAssetEvent(pid, [aid], 'synced')
          json(res, 200, { ok: true, changed: r.changed, asset: r.asset })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  return () => {}
}
