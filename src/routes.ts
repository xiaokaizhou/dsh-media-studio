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

/**
 * Register canvas-related HTTP routes under `ctx.webServer`. Pattern:
 * `ctx.webServer.register({ kind, path, handler })`. The harness's webServer
 * service also exposes a static-serve path; we own the canvas API surface.
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
      const wsRoot = getMediaStudioHandles().workspaceRoot
      const root = resolve(wsRoot)
      const target = resolve(root, requested)
      if (target !== root && !target.startsWith(root + sep)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end('{"ok":false,"error":"forbidden"}')
        return
      }
      void serveMediaFile(target, req, res)
    },
  })

  // Return a noop disposer — the webServer.unregister handles cleanup
  // when the plugin fiber is disposed; we don't need custom teardown.
  return () => {}
}
