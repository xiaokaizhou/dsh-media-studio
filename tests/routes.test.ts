import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setMediaStudioHandles } from '../src/service-state'

/**
 * End-to-end test of the media-studio HTTP endpoints after the multimodal
 * refactor. The route surface is now smaller: we ONLY own the canvas
 * routes + the media-file proxy. The `/api/media-studio/{models,providers}`
 * endpoints are gone; dsh-llm-multimodal owns LLM-facing discovery.
 *
 * We mount the real `registerCanvasRoutes` against a fake `ctx.webServer`,
 * then fire HTTP requests against the resulting server and assert the
 * JSON a client (or external automation) would receive.
 */

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'

type Handler = {
  kind: string
  path: string
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
}

interface TestServer {
  port: number
  close(): void
}

/**
 * Build a server with an arbitrary `ctx.tools.execute` mock. The tools
 * registry is consulted by `canvas_refresh_node` via `ctx.tools.execute(...)`;
 * by mounting the routes with our own ctx the test owns what the
 * multimodal plugin would have returned.
 */
async function startTestServer(
  toolsExecute?: (input: { name: string; arguments: unknown; signal: AbortSignal }) => Promise<unknown>,
): Promise<TestServer> {
  const handlers: Handler[] = []
  const fakeCtx: { webServer: { register: (h: Handler) => () => void }; tools?: { execute: typeof toolsExecute } } = {
    webServer: { register: (h: Handler) => { handlers.push(h); return () => {} } },
  }
  if (toolsExecute) fakeCtx.tools = { execute: toolsExecute }

  const wsRoot = tmpdir()
  const { CanvasStore } = await import('../src/canvas-store')
  const store = new CanvasStore(wsRoot)
  const sseClients = new Set<http.ServerResponse>()

  setMediaStudioHandles({
    workspaceRoot: wsRoot,
    defaultCanvasId: 'main',
    canvasStore: store,
    sseClients,
  })

  const routes = await import('../src/routes')
  const dispose = routes.registerCanvasRoutes(fakeCtx as never)

  const server = http.createServer((req, res) => {
    for (const h of handlers) {
      if (h.path === req.url?.split('?')[0]) {
        h.handler(req, res)
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"ok":false,"error":"not found"}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    close() {
      server.close()
      dispose()
    },
  }
}

function httpReq(port: number, path: string, method: string, body?: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = body != null ? Buffer.from(JSON.stringify(body)) : undefined
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('media-studio HTTP endpoints — canvas surface (after multimodal refactor)', () => {
  let testServer: TestServer

  beforeEach(async () => {
    testServer = await startTestServer()
  })

  afterEach(() => {
    testServer.close()
  })

  it('GET /api/media-studio/canvas/state returns the empty graph', async () => {
    const r = await httpReq(testServer.port, '/api/media-studio/canvas/state', 'GET')
    expect(r.status).toBe(200)
    const json = JSON.parse(r.body)
    expect(json.graph.nodes).toEqual([])
    expect(json.graph.edges).toEqual([])
    expect(json.version).toBe(0)
  })

  it('GET /api/media-studio/canvas/sse opens a stream with current snapshot + named `canvas-patch` event', async () => {
    const got = await new Promise<{ status: number; bytes: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: testServer.port,
        path: '/api/media-studio/canvas/sse',
        method: 'GET',
      }, (res) => {
        let buf = ''
        res.on('data', (c) => { buf += c.toString('utf8') })
        res.on('close', () => resolve({ status: res.statusCode ?? 0, bytes: buf }))
        // Stop after the named event lands.
        setTimeout(() => { req.destroy(); resolve({ status: res.statusCode ?? 0, bytes: buf }) }, 200)
      })
      req.on('error', reject)
      req.end()
    })
    expect(got.status).toBe(200)
    // The handler emits a `event: canvas-patch\\ndata: {...}\\n\\n` block as
    // its first message; verify BOTH the named-event line and the data body
    // are present. (Bare `data:` would dispatch as a `message` event in the
    // browser, so this regression-test matters.)
    expect(got.bytes).toContain('event: canvas-patch')
    expect(got.bytes).toContain('"type":"canvas-patch"')
    expect(got.bytes).toContain('"canvasId":"main"')
  })

  it('POST /api/media-studio/canvas/patch applies a batch of ops atomically', async () => {
    const r = await httpReq(testServer.port, '/api/media-studio/canvas/patch', 'POST', {
      canvasId: 'main',
      ops: [
        { op: 'addNode', type: 'text', label: 'Hello', nodeId: 'n1' },
        { op: 'addNode', type: 'image', label: 'World', nodeId: 'n2' },
        { op: 'connect', from: 'n1', to: 'n2' },
      ],
    })
    expect(r.status).toBe(200)
    const json = JSON.parse(r.body)
    expect(json.ok).toBe(true)
    expect(json.applied).toBe(3)
    expect(json.version).toBe(1)
    expect(json.lintOk).toBe(true)

    const s = await httpReq(testServer.port, '/api/media-studio/canvas/state?canvasId=main', 'GET')
    const snap = JSON.parse(s.body)
    expect(snap.graph.nodes.map((n: { id: string }) => n.id).sort()).toEqual(['n1', 'n2'])
    expect(snap.graph.edges).toHaveLength(1)
  })

  it('POST /api/media-studio/canvas/patch rejects an empty ops array with 400', async () => {
    const r = await httpReq(testServer.port, '/api/media-studio/canvas/patch', 'POST', {
      canvasId: 'main',
      ops: [],
    })
    expect(r.status).toBe(400)
    const json = JSON.parse(r.body)
    expect(json.ok).toBe(false)
  })

  it('GET /api/media-studio/media-file serves a file under workspaceRoot', async () => {
    const sub = join(tmpdir(), 'media-studio-rt-' + Date.now())
    const target = join(sub, 'sample.png')
    await mkdir(sub, { recursive: true })
    // 9-byte PNG signature
    await writeFile(target, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))

    const { CanvasStore } = await import('../src/canvas-store')
    const store = new CanvasStore(sub)
    setMediaStudioHandles({
      workspaceRoot: sub,
      defaultCanvasId: 'main',
      canvasStore: store,
      sseClients: new Set(),
    })

    const r = await new Promise<{ status: number; ct: string; bytes: number }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: testServer.port,
        path: '/api/media-studio/media-file?path=sample.png',
        method: 'GET',
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ct: res.headers['content-type'] || '', bytes: Buffer.concat(chunks).length }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(r.status).toBe(200)
    expect(r.ct).toBe('image/png')
    expect(r.bytes).toBe(9)
  })

  it('GET /api/media-studio/media-file refuses paths outside workspaceRoot', async () => {
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: testServer.port,
        path: '/api/media-studio/media-file?path=../../../etc/passwd',
        method: 'GET',
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(r.status).toBe(403)
  })

  it('GET /api/media-studio/media-file serves an absolute path under a configured mediaRoots entry', async () => {
    // Regression: media generated into a project folder outside workspaceRoot
    // used to 403, so every image/video/music node rendered "failed to load".
    const wsDir = join(tmpdir(), 'media-studio-ws-' + Date.now())
    const projectDir = join(tmpdir(), 'media-studio-project-' + Date.now())
    const target = join(projectDir, 'clip.mp4')
    await mkdir(wsDir, { recursive: true })
    await mkdir(projectDir, { recursive: true })
    await writeFile(target, Buffer.from([0x00, 0x01, 0x02, 0x03]))

    const { CanvasStore } = await import('../src/canvas-store')
    setMediaStudioHandles({
      workspaceRoot: wsDir,
      mediaRoots: [projectDir],
      defaultCanvasId: 'main',
      canvasStore: new CanvasStore(wsDir),
      sseClients: new Set(),
    })

    const get = (p: string) => new Promise<{ status: number; ct: string; bytes: number }>((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: testServer.port,
        path: '/api/media-studio/media-file?path=' + encodeURIComponent(p),
        method: 'GET',
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, ct: res.headers['content-type'] || '', bytes: Buffer.concat(chunks).length }))
      })
      req.on('error', reject)
      req.end()
    })

    const allowed = await get(target)
    expect(allowed.status).toBe(200)
    expect(allowed.ct).toBe('video/mp4')
    expect(allowed.bytes).toBe(4)

    // A sibling directory sharing a name prefix must still be refused.
    const refused = await get(projectDir + '-evil/secret.mp4')
    expect(refused.status).toBe(403)
  })
})

/**
 * `canvas_refresh_node` integration — the HTTP route delegates to
 * `executeNodeRefresh`, which reaches the multimodal plugin via
 * `ctx.tools.execute(...)`. We mock the ToolRuntime here so we never touch
 * the real multimodal plugin and still verify the dispatch shape + canvas
 * update.
 */
describe('canvas_refresh_node delegates to dsh-llm-multimodal', () => {
  it('POST /api/media-studio/canvas/refresh calls generate_image on the multimodal plugin and updates the node', async () => {
    const exec = vi.fn(async (input: { name: string; arguments: unknown; signal: AbortSignal }) => {
      if (input.name === 'generate_image') {
        return { value: { success: true, url: 'file:///tmp/refreshed.png', model: 'agnes-image-2.1-flash' } }
      }
      return { value: { success: false, message: 'unexpected tool: ' + input.name } }
    })
    const testServer = await startTestServer(exec as never)

    try {
      const { getMediaStudioHandles } = await import('../src/service-state')
      const store = getMediaStudioHandles().canvasStore
      store.apply('main', [
        { op: 'addNode', type: 'text', label: 'brief', nodeId: 't1', data: { text: 'a cat on the moon' } },
        { op: 'addNode', type: 'image', label: 'img', nodeId: 'i1', data: { prompt: 'a cat' } },
        { op: 'connect', from: 't1', to: 'i1' },
      ])

      const r = await httpReq(testServer.port, '/api/media-studio/canvas/refresh', 'POST', {
        canvasId: 'main', nodeId: 'i1',
      })
      expect(r.status).toBe(200)
      const json = JSON.parse(r.body)
      expect(json.ok).toBe(true)
      expect(json.kind).toBe('image')
      expect(json.url).toBe('file:///tmp/refreshed.png')

      // The mocked multimodal was called exactly once with the right name.
      expect(exec).toHaveBeenCalled()
      const calledNames = exec.mock.calls.map((c) => (c[0] as { name: string }).name)
      expect(calledNames).toContain('generate_image')

      // The canvas node updated to status=done with the new url.
      const snap = store.snapshot('main')
      const img = snap.graph.nodes.find((n) => n.id === 'i1')
      expect(img?.data.status).toBe('done')
      expect(img?.data.resultUrl).toBe('file:///tmp/refreshed.png')
    } finally {
      testServer.close()
    }
  })

  it('canvas_refresh_node returns no-upstream when the target node has no upstream edges', async () => {
    const exec = vi.fn(async () => ({ value: { success: true, url: 'file:///should-not-happen.png', model: 'x' } }))
    const testServer = await startTestServer(exec as never)

    try {
      const { getMediaStudioHandles } = await import('../src/service-state')
      const store = getMediaStudioHandles().canvasStore
      store.apply('main', [
        { op: 'addNode', type: 'image', label: 'lonely', nodeId: 'i9', data: { prompt: 'no upstream' } },
      ])

      const r = await httpReq(testServer.port, '/api/media-studio/canvas/refresh', 'POST', {
        canvasId: 'main', nodeId: 'i9',
      })
      expect(r.status).toBe(200)
      const json = JSON.parse(r.body)
      expect(json.ok).toBe(false)
      expect(json.code).toBe('no-upstream')
      // Multimodal plugin must NOT have been invoked.
      expect(exec).not.toHaveBeenCalled()
    } finally {
      testServer.close()
    }
  })
})
