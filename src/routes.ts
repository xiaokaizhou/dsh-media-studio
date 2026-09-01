import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CanvasStore } from './canvas-store'

/**
 * Register canvas-related HTTP routes under `ctx.webServer`. Pattern:
 * `ctx.webServer.route('METHOD', '/path', handler)`. The harness's webServer
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
export function registerCanvasRoutes(ctx: Context): void {
  const wserver = ctx.get('webServer') as unknown as {
    route(method: string, path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void
  } | undefined
  if (!wserver) {
    ctx.logger?.warn?.('[media-studio] webServer service missing — canvas SSE routes not registered')
    return
  }

  const store = (ctx.mediaStudio as unknown as { canvasStore: CanvasStore }).canvasStore
  const sseClients = (ctx.mediaStudio as unknown as { sseClients: Set<ServerResponse> }).sseClients

  // SSE stream — the canvas tab subscribes here.
  wserver.route('GET', '/api/media-studio/canvas/sse', (req, res) => {
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
    const snap = store.snapshot(canvasId)
    res.write(`data: ${JSON.stringify({
      type: 'canvas-patch',
      canvasId,
      version: snap.version,
      graph: snap.graph,
      patch: [],
    })}\n\n`)

    sseClients.add(res)
    const ping = setInterval(() => {
      try { res.write(`data: {"type":"heartbeat"}\n\n`) } catch { /* client gone */ }
    }, 15_000)
    req.on('close', () => {
      clearInterval(ping)
      sseClients.delete(res)
    })
  })

  // Snapshot endpoint — the canvas tab falls back to a plain fetch if SSE
  // is blocked by an intermediate proxy.
  wserver.route('GET', '/api/media-studio/canvas/state', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const canvasId = url.searchParams.get('canvasId') || 'main'
    const snap = store.snapshot(canvasId)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(snap))
  })

  // Patch endpoint — the client (and any external automation) can POST
  // a batch of ops. The host's store.apply() runs the same lint / atomicity
  // guard the agent's `canvas_graph_patch` tool uses; on success the SSE
  // broadcast fires so every connected tab updates.
  wserver.route('POST', '/api/media-studio/canvas/patch', (req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { canvasId?: string; ops?: unknown[] }
        const canvasId = body.canvasId || 'main'
        const ops = Array.isArray(body.ops) ? body.ops : []
        const result = store.apply(canvasId, ops as never)
        broadcastCanvasPatch(ctx, canvasId, { version: result.version, graph: result.graph, patch: result.patch })
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
  })
}

/**
 * Broadcast a canvas patch to every connected SSE client. Called by the
 * `canvas_graph_patch` tool after a successful apply — but since tools
 * run inside the same module we wire the broadcast hook here for callers
 * that prefer to push without going through the tool's apply() return.
 */
export function broadcastCanvasPatch(
  ctx: Context,
  canvasId: string,
  payload: { version: number; graph: unknown; patch: unknown[] },
): void {
  const sseClients = (ctx.mediaStudio as unknown as { sseClients: Set<ServerResponse> }).sseClients
  const msg = `data: ${JSON.stringify({ type: 'canvas-patch', canvasId, ...payload })}\n\n`
  for (const res of sseClients) {
    try { res.write(msg) } catch { /* client gone */ }
  }
}
