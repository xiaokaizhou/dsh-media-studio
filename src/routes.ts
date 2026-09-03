import type { Context } from '@deepseek-ai/cordis'
// Side-effect import — pulls in the `webServer: WebServer` augmentation on
// the cordis Context type so TypeScript knows ctx.webServer exists.
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { CanvasStore } from './canvas-store'
import { getMediaStudioHandles } from './service-state'
import { executeNodeRefresh } from './tools'

const MEDIA_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.flac': 'audio/flac',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

function mimeFor(p: string): string {
  return MEDIA_MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'
}

/** Stream a local file with basic HTTP Range support (media seeking). */
async function serveMediaFile(target: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let st
  try {
    st = await stat(target)
    if (!st.isFile()) throw new Error('not a file')
  } catch {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"error":"not found"}')
    return
  }
  const mime = mimeFor(target)
  const total = st.size
  const range = req.headers.range

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : 0
      let end = m[2] ? parseInt(m[2], 10) : total - 1
      if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < total) {
        end = Math.min(end, total - 1)
        res.writeHead(206, {
          'Content-Type': mime,
          'Content-Length': end - start + 1,
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=3600',
        })
        createReadStream(target, { start, end }).on('error', () => res.destroy()).pipe(res)
        return
      }
    }
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': total,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=3600',
  })
  createReadStream(target).on('error', () => res.destroy()).pipe(res)
}

/** True when `target` is `root` itself or sits underneath it. Compares
 *  resolved absolute paths with a separator guard so `/a/bc` never counts
 *  as being inside `/a/b`. */
function isUnderRoot(target: string, root: string): boolean {
  const r = resolve(root)
  return target === r || target.startsWith(r + sep)
}

/**
 * Allow-list check for the media-file proxy.
 *
 * `workspaceRoot` is always allowed; `mediaRoots` adds the directories a host
 * admin opted into (typically the project folder an agent writes generated
 * media to). Everything else is refused — a relative `path` query still
 * resolves against `workspaceRoot`, so `../../../etc/passwd` stays a 403.
 */
export function resolveMediaTarget(
  requested: string,
  workspaceRoot: string,
  mediaRoots: readonly string[] = [],
): { ok: true; target: string } | { ok: false } {
  const wsRoot = resolve(workspaceRoot)
  const target = resolve(wsRoot, requested)
  const roots = [wsRoot, ...mediaRoots.filter((r) => typeof r === 'string' && r.trim() !== '')]
  return roots.some((r) => isUnderRoot(target, r)) ? { ok: true, target } : { ok: false }
}

/**
 * Register canvas-related HTTP routes under `ctx.webServer`. Pattern:
 * `ctx.webServer.register({ kind, path, handler })`. The harness's webServer
 * service also exposes a static-serve path; we own the canvas API surface.
 *
 * After the multimodal refactor this routes module exposes ONLY canvas +
 * media-proxy routes. The `/api/media-studio/models` and
 * `/api/media-studio/providers` endpoints are gone: the dsh-llm-multimodal
 * plugin owns the LLM-facing UI; media-studio is a pure canvas plugin.
 *
 * SSE wire shape (per canvas):
 *   data: {"type":"canvas-patch","canvasId":"...","version":42,"graph":{...},"patch":[...]}\n\n
 *   data: {"type":"heartbeat"}\n\n   (every 15s; SSE intermediaries drop idle conns)
 *
 * The SSE handler is the source of truth for the canvas tab — the agent's
 * `canvas_graph_patch` tool persists + bumps `version`, then we push the
 * updated graph to every connected tab.
 */
export function registerCanvasRoutes(ctx: Context): () => void {
  const wserver = ctx.webServer

  const store = getMediaStudioHandles().canvasStore
  const sseClients = getMediaStudioHandles().sseClients

  // SSE stream — the canvas tab subscribes here.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/sse',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const canvasId = url.searchParams.get('canvasId') || 'main'

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.write(`: connected to canvas "${canvasId}"\n\n`)

      // Send the current snapshot so the client can render immediately.
      // Use a named `event:` so the client's `addEventListener('canvas-patch')`
      // handler fires (a bare `data:` would dispatch as `message`).
      const snap = store.snapshot(canvasId)
      const snapBody = JSON.stringify({
        type: 'canvas-patch',
        canvasId,
        version: snap.version,
        graph: snap.graph,
        patch: [],
      })
      res.write(`event: canvas-patch\ndata: ${snapBody}\n\n`)

      sseClients.add(res)
      const ping = setInterval(() => {
        try { res.write(`data: {"type":"heartbeat"}\n\n`) } catch { /* client gone */ }
      }, 15_000)
      req.on('close', () => {
        clearInterval(ping)
        sseClients.delete(res)
      })
    },
  })

  // Snapshot endpoint — the canvas tab falls back to a plain fetch if SSE
  // is blocked by an intermediate proxy.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/state',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const canvasId = url.searchParams.get('canvasId') || 'main'
      const snap = store.snapshot(canvasId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(snap))
    },
  })

  // Patch endpoint — the client (and any external automation) can POST
  // a batch of ops. The host's store.apply() runs the same lint / atomicity
  // guard the agent's `canvas_graph_patch` tool uses; on success the SSE
  // broadcast fires so every connected tab updates.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/patch',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string; ops?: unknown[] }
          const canvasId = body.canvasId || 'main'
          const ops = Array.isArray(body.ops) ? body.ops : []
          const result = store.apply(canvasId, ops as never)
          // `store.apply` already broadcasts the new graph to every SSE
          // client (the canvas tab) — no second push here.
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ok: true,
            applied: result.patch.length,
            version: result.version,
            lintOk: result.lintOk,
            issues: result.issues,
          }))
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
        }
      })
    },
  })

  // Media file proxy — host tools store generated media as local filesystem
  // paths (…/web-jobs/x.png); the browser can't load those directly, so the
  // client maps stored resultUrls onto this route (see canvas-api mediaSrc).
  // Scope-locked to the plugin workspace root; Range-enabled so <video>
  // seeking works.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/media-file',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://x')
      const requested = url.searchParams.get('path') ?? ''
      if (!requested) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"missing path"}')
        return
      }
      const handles = getMediaStudioHandles()
      const resolved = resolveMediaTarget(requested, handles.workspaceRoot, handles.mediaRoots ?? [])
      if (!resolved.ok) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"forbidden: path is outside workspaceRoot and every configured mediaRoots entry"}')
        return
      }
      void serveMediaFile(resolved.target, req, res)
    },
  })

  // Refresh endpoint — client calls this when a user clicks the refresh button
  // on a node with upstream connections. Delegates to the same logic as the
  // agent tool (executeNodeRefresh) so both paths share one implementation.
  // executeNodeRefresh now reaches the dsh-llm-multimodal plugin's
  // generate_image / generate_video / generate_music tools via
  // ctx.tools.execute().
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/canvas/refresh',
    handler: (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string; nodeId?: string }
          const canvasId = body.canvasId || 'main'
          const nodeId = String(body.nodeId ?? '').trim()
          console.log(`[media-studio] refresh: canvasId=${canvasId} nodeId=${nodeId}`)
          if (!nodeId) {
            res.writeHead(400, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'nodeId is required' }))
            return
          }
          const store = getMediaStudioHandles().canvasStore
          // Use a generous timeout (5 min) instead of req.on('close') — the
          // latter fires after the response is sent, which would abort a
          // generation that already completed. The timeout guards against
          // truly stuck generations (provider API hang).
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
          try {
            const result = await executeNodeRefresh(store, canvasId, nodeId, controller.signal, ctx)
            console.log(`[media-studio] refresh: done, ok=${result.ok} kind=${result.kind}`)
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result))
          } finally {
            clearTimeout(timeout)
          }
        } catch (e) {
          console.error(`[media-studio] refresh: error ${(e as Error).message}`)
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: (e as Error).message }))
          }
        }
      })
    },
  })

  // Return a noop disposer — the webServer.unregister handles cleanup
  // when the plugin fiber is disposed; we don't need custom teardown.
  return () => {}
}
