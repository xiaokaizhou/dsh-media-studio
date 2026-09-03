/**
 * Search + soft-reference routes (M3).
 *
 *   GET  /api/media-studio/search?q=…&scope=<projectId>&limit=20
 *        → grouped hits (current project vs other projects)
 *   POST /api/media-studio/refs { assetProjectId, assetId }
 *        → adds a soft-ref canvas node to the ACTIVE project canvas
 *   POST /api/media-studio/search/import-canvas { projectId, canvasNodeId }
 *        → saves an other-project canvas media into the active project's
 *          library (hard copy) — the "+" action for 画布素材 results
 */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getMediaStudioHandles } from './service-state'
import {
  runSearch,
  addSoftRefToCanvas,
  resolveAsset,
} from './search'
import { registerCanvasAsset, copyAssetToProject } from './asset-store'

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

export function registerSearchRoutes(ctx: Context): () => void {
  const wserver = ctx.webServer

  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/search',
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const q = url.searchParams.get('q') ?? ''
          const scopeRaw = url.searchParams.get('scope') ?? ''
          const limitRaw = Number(url.searchParams.get('limit') ?? 20)
          const h = getMediaStudioHandles()
          const ps = h.projectStore!
          await ps.ready()
          const scope = scopeRaw ? scopeRaw : (ps.activeCanvasId() ?? 'main')
          const result = await runSearch({
            wsRoot: h.workspaceRoot,
            canvasStore: h.canvasStore,
            projects: ps.snapshot().projects,
            q,
            scopeProjectId: scope,
            limitPerGroup: Number.isFinite(limitRaw) ? limitRaw : 20,
          })
          json(res, 200, { ok: true, ...result })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Soft reference: add an asset of any project to the ACTIVE canvas.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/refs',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const assetProjectId = String(body.assetProjectId ?? '').trim()
          const assetId = String(body.assetId ?? '').trim()
          if (!assetProjectId || !assetId) { json(res, 400, { ok: false, error: 'assetProjectId and assetId are required' }); return }
          const h = getMediaStudioHandles()
          const ps = h.projectStore!
          await ps.ready()
          const canvasId = ps.activeCanvasId()
          if (!canvasId || !ps.snapshot().projects.some((p) => p.id === canvasId)) {
            json(res, 400, { ok: false, error: 'no active project to receive the reference' })
            return
          }
          const asset = await resolveAsset(h.workspaceRoot, assetProjectId, assetId)
          const { nodeId, refCount } = addSoftRefToCanvas(h.canvasStore, canvasId, h.workspaceRoot, assetProjectId, asset)
          json(res, 200, {
            ok: true,
            nodeId,
            refCount,
            canvasId,
            asset: { projectId: assetProjectId, assetId: asset.id, kind: asset.kind, name: asset.name },
          })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Canvas-media "+": save an other-project canvas node's media into the
  // active project's library (hard copy), with provenance to the source.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/search/import-canvas',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const projectId = String(body.projectId ?? '').trim()
          const canvasNodeId = String(body.canvasNodeId ?? '').trim()
          if (!projectId || !canvasNodeId) { json(res, 400, { ok: false, error: 'projectId and canvasNodeId are required' }); return }
          const h = getMediaStudioHandles()
          const ps = h.projectStore!
          await ps.ready()
          const targetId = ps.activeCanvasId()
          if (!targetId) { json(res, 400, { ok: false, error: 'no active project to import into' }); return }

          const snap = h.canvasStore.peek(projectId)
          const node = snap?.graph.nodes.find((n) => n.id === canvasNodeId)
          if (!node) { json(res, 400, { ok: false, error: `canvas node "${canvasNodeId}" not found in project "${projectId}"` }); return }
          const kind = node.type === 'video' ? 'clip' as const : node.type === 'music' ? 'audio' as const : 'scene' as const

          const registered = await registerCanvasAsset({
            wsRoot: h.workspaceRoot,
            roots: h.mediaRoots ?? [],
            canvasStore: h.canvasStore,
            projectId,
            canvasNodeId,
            kind,
          })
          const copied = await copyAssetToProject(h.workspaceRoot, projectId, registered.asset.id, targetId)
          json(res, 200, {
            ok: true,
            sourceProjectId: projectId,
            canvasNodeId,
            targetProjectId: targetId,
            created: copied.created,
            asset: copied.asset,
          })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  return () => {}
}
