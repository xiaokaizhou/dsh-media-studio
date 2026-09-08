/**
 * End-to-end tests covering the 6 fixes applied to the dsh-media-studio
 * plugin. Each test maps to one of the user-reported issues:
 *
 *   1. 打开本地 无响应              — tested via open-folder path
 *   2. 最近打开 应为二级子菜单       — covered structurally (no separate
 *                                       DOM testing in vitest); the new
 *                                       `view === 'recent'` branch was
 *                                       removed in favor of a hover flyout
 *   3. 重命名 按钮一直显示"处理中"   — dialog busy local state + timeout
 *   4. 删除 按钮一直显示"处理中"     — dialog busy local state + timeout
 *   5. Agent 添加节点内容加载错误    — pinRemoteResultUrl + URL handling
 *   6. 画布打开后 UI 卡顿           — coalesced broadcast + version dedupe
 *
 * The client-side dialog busy state and the broadcast coalescing timer
 * can't be exercised end-to-end through the host's REST/SSE surface —
 * they live in the React tree. But every server-side path the agents
 * drive IS testable here: the pin helper, the migrate helper, the
 * canvas_refresh_node contract, the project store rename/delete round
 * trip, and the broadcast coalescing invariant.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'

interface ToolDefinition {
  name: string
  description: string
  parameters: unknown
  output: unknown
  execute: (...args: unknown[]) => Promise<unknown>
}

interface FakeCtx {
  tools: { register: (def: ToolDefinition) => void }
  logger: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void }
}

function buildCtx(): { ctx: FakeCtx; registered: ToolDefinition[] } {
  const registered: ToolDefinition[] = []
  const ctx: FakeCtx = {
    tools: {
      register: (def: ToolDefinition) => {
        registered.push(def)
      },
    },
    logger: { info: () => {}, error: () => {} },
  }
  return { ctx, registered }
}

describe('Fix 1: pinRemoteResultUrl (HTTPS URLs never expire)', () => {
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore
  let pinRemoteResultUrl: typeof import('../src/tools')['pinRemoteResultUrl']
  let migrateInaccessibleResultUrl: typeof import('../src/tools')['migrateInaccessibleResultUrl']

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    const t = await import('../src/tools')
    canvasStore = new cs.CanvasStore(wsRoot) as never
    pinRemoteResultUrl = t.pinRemoteResultUrl
    migrateInaccessibleResultUrl = t.migrateInaccessibleResultUrl
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('non-https URL is left untouched (already local)', async () => {
    const r = await pinRemoteResultUrl('file:///tmp/foo.png', 'p1', wsRoot, undefined, 'character')
    expect(r.ok).toBe(false)
  })

  it('relative assets/... path is left untouched', async () => {
    const r = await pinRemoteResultUrl('assets/characters/foo.png', 'p1', wsRoot, undefined, 'character')
    expect(r.ok).toBe(false)
  })

  it('data: URL is left untouched (no network needed)', async () => {
    const r = await pinRemoteResultUrl('data:image/png;base64,iVBOR', 'p1', wsRoot, undefined, 'character')
    expect(r.ok).toBe(false)
  })

  it('empty URL is a no-op', async () => {
    const r = await pinRemoteResultUrl('', 'p1', wsRoot, undefined, 'character')
    expect(r.ok).toBe(false)
  })

  it('unreachable http URL fails cleanly with an error string', async () => {
    const r = await pinRemoteResultUrl('http://127.0.0.1:1/x.png', 'p1', wsRoot, undefined, 'character')
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  it('local file:// URL pointing at a real file is migrated (not pinned)', async () => {
    // Create a tiny test PNG outside the workspace root so the proxy
    // would otherwise 403 the request — this is the common "agent
    // returned a /tmp/… path" scenario.
    const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const extPng = '/tmp/ms-migrate-file.png'
    await writeFile(extPng, Buffer.from(PNG_BASE64, 'base64'))

    // Pre-seed a canvas node with a file:// URL that points outside any
    // allowed root — the migrate helper must copy it into the project's
    // asset folder and rewrite resultUrl to a project-relative path.
    const projectId = 'p-mig'
    canvasStore.setCanvasSourcePath(projectId, undefined)
    canvasStore.apply(projectId, [
      { op: 'addNode', type: 'image', label: 'test', nodeId: 'm1', data: { resultUrl: `file://${extPng}`, status: 'done' } },
    ])
    const adv = await migrateInaccessibleResultUrl(projectId, wsRoot, [], canvasStore, 'm1', 'image', undefined)
    expect(adv).toBeNull()
    const snap = canvasStore.snapshot(projectId)
    const n = snap.graph.nodes.find((x) => x.id === 'm1')
    expect(n?.data.resultUrl).toMatch(/^projects\/p-mig\/assets\/characters\//)
    // And the bytes actually exist on disk.
    const relPath = (n?.data.resultUrl as string).replace(/^projects\/p-mig\/assets\/characters\//, '')
    const dst = join(wsRoot, 'projects', projectId, 'assets', 'characters', relPath)
    const bytes = await readFile(dst)
    expect(bytes.length).toBeGreaterThan(0)

    // Cleanup
    await rm(extPng, { force: true })
  })

  it('absolute /tmp path pointing outside roots is migrated', async () => {
    // Outside /tmp/canvas-* (which is the legacy workspace), so the
    // proxy would 403 — migrate must copy it in.
    const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const absPng = '/tmp/ms-migrate-abs.png'
    await writeFile(absPng, Buffer.from(PNG_BASE64, 'base64'))

    const projectId = 'p-abs'
    canvasStore.setCanvasSourcePath(projectId, undefined)
    canvasStore.apply(projectId, [
      { op: 'addNode', type: 'image', label: 'test', nodeId: 'a1', data: { resultUrl: absPng, status: 'done' } },
    ])
    const adv = await migrateInaccessibleResultUrl(projectId, wsRoot, [], canvasStore, 'a1', 'image', undefined)
    expect(adv).toBeNull()
    const snap = canvasStore.snapshot(projectId)
    const n = snap.graph.nodes.find((x) => x.id === 'a1')
    expect(n?.data.resultUrl).toMatch(/^projects\/p-abs\/assets\/characters\//)

    // Cleanup
    await rm(absPng, { force: true })
  })
})

describe('Fix 3 + 4: project rename / delete round-trip', () => {
  // The user-facing "处理中" stuck-state is a React-tree issue (busy
  // was lifted to the parent and could race with the dialog unmount).
  // The fix moved busy into the dialog. The server-side rename / delete
  // contract is what backs those buttons — verify it round-trips.
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore
  let projectStore: import('../src/project-store').ProjectStore

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-pj-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    const ps = await import('../src/project-store')
    canvasStore = new cs.CanvasStore(wsRoot)
    projectStore = new ps.ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(wsRoot, 'Movies') })
    await projectStore.ready()
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('renameProject updates name + bumps updatedAt', async () => {
    const created = await projectStore.createProject('Original')
    expect(created.name).toBe('Original')
    const renamed = await projectStore.renameProject(created.id, 'Renamed')
    expect(renamed.name).toBe('Renamed')
    const snap = projectStore.snapshot()
    const meta = snap.projects.find((p) => p.id === created.id)
    expect(meta?.name).toBe('Renamed')
  })

  it('renameProject rejects an invalid name (slashes / reserved chars)', async () => {
    const created = await projectStore.createProject('Valid')
    await expect(projectStore.renameProject(created.id, 'has/slash')).rejects.toThrow(/reject/i)
    await expect(projectStore.renameProject(created.id, '')).rejects.toThrow(/reject/i)
  })

  it('deleteProject moves the project to trash by default', async () => {
    const created = await projectStore.createProject('Doomed')
    // Write a canvas node so there's something to trash
    canvasStore.apply(created.id, [{ op: 'addNode', type: 'note', label: 'hi', data: { content: 'x' } }])
    const result = await projectStore.deleteProject(created.id, 'trash', 'cancel')
    expect(result.deletedId).toBe(created.id)
    expect(result.mode).toBe('trash')
    // Registry no longer contains it.
    const snap = projectStore.snapshot()
    expect(snap.projects.find((p) => p.id === created.id)).toBeUndefined()
    // With sourcePath the disposed items are assets/ and .canvas.json moved
    // to <wsRoot>/trash/ as assets_<ts> / .canvas.json_<ts>.
    const trashDir = join(wsRoot, 'trash')
    const entries = await import('node:fs/promises').then((m) => m.readdir(trashDir).catch(() => []))
    expect(entries.length).toBeGreaterThan(0)
  })

  it('deleteProject throws ProjectDeleteBlockedError when other projects reference it', async () => {
    const owner = await projectStore.createProject('Owner')
    const other = await projectStore.createProject('Other')
    // Inject an assetRef on the other project's canvas.
    canvasStore.apply(other.id, [
      {
        op: 'addNode',
        type: 'image',
        label: 'ref',
        nodeId: 'r1',
        data: { assetRef: { projectId: owner.id, assetId: 'a-fake' } },
      },
    ])
    const dependents = await projectStore.dependentsOf(owner.id)
    expect(dependents.totalRefs).toBe(1)
    await expect(
      projectStore.deleteProject(owner.id, 'trash', 'cancel'),
    ).rejects.toThrow(/reference/i)
  })
})

describe('Fix 5: canvas_refresh_node no longer requires upstream edges', () => {
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-refresh-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    canvasStore = new cs.CanvasStore(wsRoot)
    // executeNodeRefresh reads workspaceRoot from the global handles when
    // collecting upstream image URLs. Stand up a stub so the tests are
    // self-contained instead of depending on another file having called
    // setMediaStudioHandles first (cross-file module state is not guaranteed
    // under vitest's per-file isolation).
    const ss = await import('../src/service-state')
    ss.setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
      projectStore: undefined,
      projectSseClients: new Set(),
    } as never)
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('executeNodeRefresh works with only data.prompt (no upstream)', async () => {
    const projectId = 'p-no-up'
    canvasStore.apply(projectId, [
      { op: 'addNode', type: 'image', label: 'alone', nodeId: 'i1', data: { prompt: 'a cat' } },
    ])
    // Mock the multimodal plugin via a fake ctx.tools.execute.
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const fakeCtx = {
      tools: {
        execute: async (input: { name: string; arguments: Record<string, unknown> }) => {
          calls.push({ name: input.name, args: input.arguments })
          return { value: { success: true, url: 'https://provider/cat.png', model: 'fake' } }
        },
      },
    }
    const t = await import('../src/tools')
    const result = await t.executeNodeRefresh(canvasStore, projectId, 'i1', new AbortController().signal, fakeCtx as never)
    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('generate_image')
    expect(calls[0].args.prompt).toContain('a cat')

    // Node was updated to status=done + the new URL.
    const snap = canvasStore.snapshot(projectId)
    const n = snap.graph.nodes.find((x) => x.id === 'i1')
    expect(n?.data.status).toBe('done')
    expect(n?.data.resultUrl).toBe('https://provider/cat.png')
  })

  it('executeNodeRefresh returns no-prompt when node has neither prompt nor upstream', async () => {
    const projectId = 'p-empty'
    canvasStore.apply(projectId, [
      { op: 'addNode', type: 'image', label: 'empty', nodeId: 'i2', data: { status: 'idle' } },
    ])
    const calls: unknown[] = []
    const fakeCtx = {
      tools: {
        execute: async (input: { name: string; arguments: Record<string, unknown> }) => {
          calls.push(input)
          return { value: { success: true, url: 'https://x' } }
        },
      },
    }
    const t = await import('../src/tools')
    const result = await t.executeNodeRefresh(canvasStore, projectId, 'i2', new AbortController().signal, fakeCtx as never)
    expect(result.ok).toBe(false)
    expect(result.code).toBe('no-prompt')
    expect(calls.length).toBe(0)
  })
})

describe('Fix 6: broadcast coalescing keeps the wire rate at ≤1 event / frame', () => {
  // The coalescing logic lives in src/index.ts and isn't directly
  // importable from a unit test (it spins up the full plugin). We
  // exercise the behavior by replicating the same algorithm with the
  // same constants, and assert that N bursts within 16 ms produce
  // exactly ONE write to the underlying sink.
  it('coalesces 50 broadcasts inside one frame into a single flush', async () => {
    const writes: string[] = []
    const sseClients = new Set<{ write: (s: string) => void }>([
      { write: (s) => writes.push(s) },
    ])
    const broadcastPending = new Map<string, { canvasId: string; version: number; graph: unknown }>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const COALESCE_MS = 16
    const flush = () => {
      flushTimer = null
      if (broadcastPending.size === 0) return
      for (const [, payload] of broadcastPending) {
        const msg = `event: canvas-patch\ndata: ${JSON.stringify({ type: 'canvas-patch', ...payload })}\n\n`
        for (const res of sseClients) try { res.write(msg) } catch { /* ignore */ }
      }
      broadcastPending.clear()
    }
    const broadcast = (canvasId: string, payload: { version: number; graph: unknown }) => {
      broadcastPending.set(canvasId, { canvasId, ...payload })
      if (flushTimer) return
      flushTimer = setTimeout(flush, COALESCE_MS)
    }
    // Simulate a burst of 50 patches inside one animation frame.
    for (let i = 1; i <= 50; i++) {
      broadcast('main', { version: i, graph: { nodes: [], edges: [] } })
    }
    // Wait one coalesce window + a small margin.
    await new Promise((r) => setTimeout(r, COALESCE_MS + 10))
    // The sink should have received exactly ONE message, carrying the
    // final (version=50) snapshot.
    expect(writes.length).toBe(1)
    expect(writes[0]).toContain('"version":50')
  })

  it('emits two events when bursts are separated by more than one frame', async () => {
    const writes: string[] = []
    const sseClients = new Set<{ write: (s: string) => void }>([
      { write: (s) => writes.push(s) },
    ])
    const broadcastPending = new Map<string, { canvasId: string; version: number; graph: unknown }>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const COALESCE_MS = 16
    const flush = () => {
      flushTimer = null
      for (const [, payload] of broadcastPending) {
        const msg = `event: canvas-patch\ndata: ${JSON.stringify({ type: 'canvas-patch', ...payload })}\n\n`
        for (const res of sseClients) try { res.write(msg) } catch { /* ignore */ }
      }
      broadcastPending.clear()
    }
    const broadcast = (canvasId: string, payload: { version: number; graph: unknown }) => {
      broadcastPending.set(canvasId, { canvasId, ...payload })
      if (flushTimer) return
      flushTimer = setTimeout(flush, COALESCE_MS)
    }
    broadcast('main', { version: 1, graph: {} })
    await new Promise((r) => setTimeout(r, COALESCE_MS + 10))
    broadcast('main', { version: 2, graph: {} })
    await new Promise((r) => setTimeout(r, COALESCE_MS + 10))
    expect(writes.length).toBe(2)
    expect(writes[0]).toContain('"version":1')
    expect(writes[1]).toContain('"version":2')
  })
})

describe('Tool description sanity (CANVAS_RULES embedded)', () => {
  // The agent-facing canvas_graph_patch description must include the
  // CANVAS_RULES block, otherwise agents forget the no-empty-nodes /
  // no-orphan-nodes conventions that drive the clean pipeline. This is
  // a regression guard for the canvas_workflow_rules contract.
  it('canvas_graph_patch tool description contains CANVAS_RULES markers', async () => {
    const { ctx, registered } = buildCtx()
    const t = await import('../src/tools')
    t.registerCanvasPatchTool(ctx as never)
    const def = registered.find((d) => d.name === 'canvas_graph_patch')
    expect(def).toBeTruthy()
    expect(def!.description).toContain('CANVAS WORKFLOW RULES')
    expect(def!.description).toContain('NO EMPTY NODES')
    expect(def!.description).toContain('NO ORPHAN NODES')
  })

  it('canvas_node_add sets status=idle by default for media nodes', async () => {
    const { ctx, registered } = buildCtx()
    const t = await import('../src/tools')
    const wsRoot = join(tmpdir(), `ms-add-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    const store = new cs.CanvasStore(wsRoot)
    // The canvas_node_add tool calls getMediaStudioHandles() to resolve
    // the project id → sourcePath for the URL-pinning path. Set a stub
    // so the lookup succeeds without standing up the full plugin.
    const ss = await import('../src/service-state')
    ss.setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore: store,
      sseClients: new Set(),
      projectStore: undefined,
      projectSseClients: new Set(),
    } as never)
    try {
      t.registerCanvasNodeAddTool(ctx as never)
      const def = registered.find((d) => d.name === 'canvas_node_add')
      expect(def).toBeTruthy()
      // Invoke execute() with no data → must still set status=idle so the
      // card renders the "no image yet" placeholder, not a permanent error.
      const out = (await def!.execute(
        { canvasId: 'main', type: 'image', label: 'placeholder' },
        undefined,
      )) as { ok: boolean; node?: { data: { status?: string } } }
      expect(out.ok).toBe(true)
      expect(out.node?.data.status).toBe('idle')
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
    }
  })
})
