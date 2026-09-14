/**
 * Integration smoke for the 12 new media_studio_* agent tools and the 5
 * single-node canvas CRUD tools (M5). The test:
 *
 *   1. Builds a fake `ctx` (cordis service stub) that captures every
 *      `ctx.tools.register(...)` call.
 *   2. Calls each of the 12 `registerMediaStudio*Tool(ctx)` functions,
 *      plus all 4 existing canvas tools + 5 new single-node tools.
 *   3. Asserts that all tool names landed in the captured registry and
 *      that each `ToolDefinition` carries a non-empty description + the
 *      expected parameter shape.
 *   4. Also runs the read-only tools (`media_studio_list_projects`,
 *      `media_studio_search_assets`) end-to-end against an in-memory
 *      ProjectStore / CanvasStore seeded with one project + one asset to
 *      prove the full execute() pipeline is wired up.
 *   5. Runs targeted execute() smoke tests for each of the 5 new
 *      single-node canvas CRUD tools.
 *
 * The DSH boot path (src/index.ts) calls these same functions verbatim;
 * if they succeed here they will succeed in boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { CanvasStore } from '../src/canvas-store'

interface ToolDefinition {
  name: string
  description: string
  parameters: unknown
  output: unknown
  execute: (...args: unknown[]) => Promise<unknown>
  timeoutMs?: number
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

const EXPECTED_NAMES = [
  'media_studio_list_projects',
  'media_studio_create_project',
  'media_studio_pick_folder',
  'media_studio_open_project',
  'media_studio_rename_project',
  'media_studio_delete_project',
  'media_studio_list_assets',
  'media_studio_register_asset',
  'media_studio_update_asset',
  'media_studio_delete_asset',
  'media_studio_copy_asset',
  'media_studio_search_assets',
]

describe('agent tools: 12 new media_studio_* tools', () => {
  let wsRoot: string

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `media-studio-agent-tools-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(wsRoot, { recursive: true })
  })

  afterEach(async () => {
    // persist() in CanvasStore runs async (void this.persist(...)), so give it
    // a moment to finish before we try to remove the workspace root.
    await new Promise((r) => setTimeout(r, 50))
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('register all 12 tools with non-empty schema + description', async () => {
    const { ctx, registered } = buildCtx()
    const regFns = await import('../src/tools')
    const regList: Array<[string, (c: FakeCtx) => void]> = [
      ['media_studio_list_projects', (c) => regFns.registerMediaStudioListProjectsTool(c as never)],
      ['media_studio_create_project', (c) => regFns.registerMediaStudioCreateProjectTool(c as never)],
      ['media_studio_pick_folder', (c) => regFns.registerMediaStudioPickFolderTool(c as never)],
      ['media_studio_open_project', (c) => regFns.registerMediaStudioOpenProjectTool(c as never)],
      ['media_studio_rename_project', (c) => regFns.registerMediaStudioRenameProjectTool(c as never)],
      ['media_studio_delete_project', (c) => regFns.registerMediaStudioDeleteProjectTool(c as never)],
      ['media_studio_list_assets', (c) => regFns.registerMediaStudioListAssetsTool(c as never)],
      ['media_studio_register_asset', (c) => regFns.registerMediaStudioRegisterAssetTool(c as never)],
      ['media_studio_update_asset', (c) => regFns.registerMediaStudioUpdateAssetTool(c as never)],
      ['media_studio_delete_asset', (c) => regFns.registerMediaStudioDeleteAssetTool(c as never)],
      ['media_studio_copy_asset', (c) => regFns.registerMediaStudioCopyAssetTool(c as never)],
      ['media_studio_search_assets', (c) => regFns.registerMediaStudioSearchAssetsTool(c as never)],
    ]
    for (const [, reg] of regList) reg(ctx)
    const names = registered.map((t) => t.name)
    expect(names).toEqual(EXPECTED_NAMES)
    for (const tool of registered) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toBeDefined()
      expect(tool.output).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('register the existing 4 canvas_* tools + 5 new single-node CRUD tools for regression', async () => {
    const { ctx, registered } = buildCtx()
    const regFns = await import('../src/tools')
    // Existing 4 canvas tools.
    regFns.registerCanvasViewTool(ctx as never)
    regFns.registerCanvasPatchTool(ctx as never)
    regFns.registerAutoArrangeTool(ctx as never)
    regFns.registerCanvasRefreshNodeTool(ctx as never)
    // 5 new single-node CRUD tools.
    regFns.registerCanvasNodeViewTool(ctx as never)
    regFns.registerCanvasNodeAddTool(ctx as never)
    regFns.registerCanvasNodeUpdateTool(ctx as never)
    regFns.registerCanvasNodeRenameTool(ctx as never)
    regFns.registerCanvasNodeDeleteTool(ctx as never)
    const names = registered.map((t) => t.name).sort()
    expect(names).toEqual([
      'canvas_auto_arrange',
      'canvas_graph_patch',
      'canvas_graph_view',
      'canvas_node_add',
      'canvas_node_delete',
      'canvas_node_rename',
      'canvas_node_update',
      'canvas_node_view',
      'canvas_refresh_node',
    ])
    for (const tool of registered) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.parameters).toBeDefined()
      expect(tool.output).toBeDefined()
      expect(typeof tool.execute).toBe('function')
    }
  })

  it('execute() media_studio_list_projects returns the seeded project end-to-end', async () => {
    // Wire the real PluginService singletons (canvasStore + projectStore)
    // to the temp workspace, register the list tool, and call its execute.
    const { setMediaStudioHandles } = await import('../src/service-state')
    const { CanvasStore } = await import('../src/canvas-store')
    const { ProjectStore } = await import('../src/project-store')
    const canvasStore = new CanvasStore(wsRoot)
    const projectStore = new ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(wsRoot, "Movies") })
    setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Map(),
      projectStore,
      projectSseClients: new Set(),
    })
    await projectStore.ready()
    await projectStore.createProject('smoke-test')

    const { ctx, registered } = buildCtx()
    const regFns = await import('../src/tools')
    regFns.registerMediaStudioListProjectsTool(ctx as never)
    const listTool = registered[0]
    const result = (await listTool.execute({}, { signal: new AbortController().signal } as never)) as {
      ok: boolean
      projects: Array<{ id: string; name: string }>
      recentLimit: number
    }
    expect(result.ok).toBe(true)
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].name).toBe('smoke-test')
    expect(result.recentLimit).toBe(10)
  })

  it('execute() media_studio_search_assets finds the seeded asset', async () => {
    const { setMediaStudioHandles } = await import('../src/service-state')
    const { CanvasStore } = await import('../src/canvas-store')
    const { ProjectStore } = await import('../src/project-store')
    const canvasStore = new CanvasStore(wsRoot)
    const projectStore = new ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(wsRoot, "Movies") })
    setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Map(),
      projectStore,
      projectSseClients: new Set(),
    })
    await projectStore.ready()
    const proj = await projectStore.createProject('search-target')
    // Seed a small PNG asset under the project asset root so the search
    // index has something to find.
    const assetDir = join(proj.sourcePath!, 'assets', 'characters')
    await mkdir(assetDir, { recursive: true })
    const seedBuf = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108020000009077533DE', 'hex')
    await writeFile(join(assetDir, 'seed.png'), seedBuf)
    const indexPath = join(proj.sourcePath!, 'assets', '.index.json')
    await writeFile(indexPath, JSON.stringify({
      version: 1,
      assets: [{
        id: 'a-seed0001',
        name: 'unique-search-token-xyz',
        kind: 'character',
        file: 'seed.png',
        bytes: seedBuf.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }],
    }))

    const { ctx, registered } = buildCtx()
    const regFns = await import('../src/tools')
    regFns.registerMediaStudioSearchAssetsTool(ctx as never)
    const searchTool = registered[0]
    const result = (await searchTool.execute(
      { q: 'unique-search-token-xyz' },
      { signal: new AbortController().signal } as never,
    )) as { ok: boolean; hitCount: number; groups: Array<{ items: Array<{ name: string }> }> }
    expect(result.ok).toBe(true)
    expect(result.hitCount).toBe(1)
    expect(result.groups[0].items[0].name).toBe('unique-search-token-xyz')
  })
})

/**
 * Targeted execute() smoke tests for the 5 new single-node canvas CRUD tools.
 * Each test seeds a CanvasStore directly, wires handles, then calls the
 * tool's execute() to verify real-store behavior (not just registration).
 */
describe('single-node CRUD tools: execute() smoke', () => {
  let wsRoot: string

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `media-studio-crud-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(wsRoot, { recursive: true })
  })

  afterEach(async () => {
    // persist() in CanvasStore runs async (void this.persist(...)), so give it
    // a moment to finish before we try to remove the workspace root.
    await new Promise((r) => setTimeout(r, 50))
    await rm(wsRoot, { recursive: true, force: true })
  })

  async function wireStore(): Promise<{ canvasStore: CanvasStore; canvasId: string }> {
    const { setMediaStudioHandles } = await import('../src/service-state')
    const { CanvasStore } = await import('../src/canvas-store')
    const { ProjectStore } = await import('../src/project-store')
    const store = new CanvasStore(wsRoot)
    const projectStore = new ProjectStore(wsRoot, store, { recentLimit: 10, trashEnabled: true })
    setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore: store,
      sseClients: new Map(),
      projectStore,
      projectSseClients: new Set(),
    })
    return { canvasStore: store, canvasId: 'main' }
  }

  async function seedNode(store: CanvasStore, canvasId: string, id: string, type: string, label: string, data?: Record<string, unknown>) {
    const result = store.apply(canvasId, [{ op: 'addNode', type: type as 'text', label, data: data ?? {}, nodeId: id }])
    expect(result.graph.nodes.find((n: { id: string }) => n.id === id)).toBeDefined()
    return result.version
  }

  async function seedEdge(store: CanvasStore, canvasId: string, from: string, to: string) {
    const result = store.apply(canvasId, [{ op: 'connect', from, to }])
    return result.version
  }

  it('canvas_node_view returns the correct node', async () => {
    const { canvasStore, canvasId } = await wireStore()
    await seedNode(canvasStore, canvasId, 'n-view01', 'text', 'Hello View')
    const { registerCanvasNodeViewTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeViewTool(ctx as never)
    const viewTool = registered[0]
    const result = (await viewTool.execute({ id: 'n-view01' }, { signal: new AbortController().signal } as never)) as { ok: boolean; node?: { id: string; label: string; type: string; data: Record<string, unknown> }; version: number }
    expect(result.ok).toBe(true)
    expect(result.node!.id).toBe('n-view01')
    expect(result.node!.label).toBe('Hello View')
    expect(result.node!.type).toBe('text')
    expect(result.version).toBe(1)
  })

  it('canvas_node_view returns node-not-found for missing id', async () => {
    const { canvasStore, canvasId } = await wireStore()
    void canvasId // store is empty
    const { registerCanvasNodeViewTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeViewTool(ctx as never)
    const viewTool = registered[0]
    const result = (await viewTool.execute({ id: 'n-missing' }, { signal: new AbortController().signal } as never)) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('node-not-found')
  })

  it('canvas_node_add creates a node and returns it with generated id', async () => {
    const { canvasStore, canvasId } = await wireStore()
    const { registerCanvasNodeAddTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeAddTool(ctx as never)
    const addTool = registered[0]
    const result = (await addTool.execute({ type: 'note', label: 'My Note', data: { content: 'hello' } }, { signal: new AbortController().signal } as never)) as { ok: boolean; node?: { id: string; label: string; type: string; data: Record<string, unknown> }; version: number }
    expect(result.ok).toBe(true)
    expect(result.node).toBeDefined()
    expect(result.node!.label).toBe('My Note')
    expect(result.node!.type).toBe('note')
    expect(result.node!.data.content).toBe('hello')
    expect(result.version).toBe(1)
  })

  it('canvas_node_add with duplicate nodeId returns { ok:false, code:"duplicate-node-id" }', async () => {
    const { canvasStore, canvasId } = await wireStore()
    await seedNode(canvasStore, canvasId, 'n-dup01', 'text', 'Existing')
    const { registerCanvasNodeAddTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeAddTool(ctx as never)
    const addTool = registered[0]
    const result = (await addTool.execute({ type: 'text', label: 'Another', nodeId: 'n-dup01' }, { signal: new AbortController().signal } as never)) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('duplicate-node-id')
  })

  it('canvas_node_add without position uses store auto-placement', async () => {
    const { canvasStore, canvasId } = await wireStore()
    // Seed one node so the grid is non-empty.
    await seedNode(canvasStore, canvasId, 'n-base01', 'text', 'Base')
    const { registerCanvasNodeAddTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeAddTool(ctx as never)
    const addTool = registered[0]
    const result = (await addTool.execute({ type: 'image', label: 'Auto Pos' }, { signal: new AbortController().signal } as never)) as { ok: boolean; node?: { position?: { x: number; y: number } } }
    expect(result.ok).toBe(true)
    expect(result.node!.position).toBeDefined()
    // Should NOT be (0,0) — auto-placement avoids overlap.
    const p = result.node!.position!
    expect(p.x).toBeGreaterThan(0)
    expect(p.y).toBeGreaterThan(0)
  })

  it('canvas_node_update merges data (does not replace)', async () => {
    const { canvasStore, canvasId } = await wireStore()
    await seedNode(canvasStore, canvasId, 'n-upd01', 'text', 'Original', { text: 'hello', model: 'v1' })
    const { registerCanvasNodeUpdateTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeUpdateTool(ctx as never)
    const updateTool = registered[0]
    const result = (await updateTool.execute({ id: 'n-upd01', data: { text: 'world' } }, { signal: new AbortController().signal } as never)) as { ok: boolean; node?: { data: Record<string, unknown> }; version: number }
    expect(result.ok).toBe(true)
    expect(result.node!.data.text).toBe('world')
    expect(result.node!.data.model).toBe('v1') // preserved via shallow merge
    expect(result.version).toBe(2)
  })

  it('canvas_node_update with wrong id returns { ok:false, code:"node-not-found" }', async () => {
    const { canvasStore, canvasId } = await wireStore()
    void canvasId
    const { registerCanvasNodeUpdateTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeUpdateTool(ctx as never)
    const updateTool = registered[0]
    const result = (await updateTool.execute({ id: 'n-gone', data: { foo: 'bar' } }, { signal: new AbortController().signal } as never)) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('node-not-found')
  })

  it('canvas_node_rename changes label only', async () => {
    const { canvasStore, canvasId } = await wireStore()
    await seedNode(canvasStore, canvasId, 'n-ren01', 'text', 'Old Label', { text: 'content' })
    const { registerCanvasNodeRenameTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeRenameTool(ctx as never)
    const renameTool = registered[0]
    const result = (await renameTool.execute({ id: 'n-ren01', label: 'New Label' }, { signal: new AbortController().signal } as never)) as { ok: boolean; node?: { label: string; data: Record<string, unknown> }; version: number }
    expect(result.ok).toBe(true)
    expect(result.node!.label).toBe('New Label')
    expect(result.node!.data.text).toBe('content') // data untouched
    expect(result.version).toBe(2)
  })

  it('canvas_node_delete removes connected edges automatically', async () => {
    const { canvasStore, canvasId } = await wireStore()
    // Create two nodes + an edge between them.
    await seedNode(canvasStore, canvasId, 'n-del-src', 'text', 'Source')
    await seedNode(canvasStore, canvasId, 'n-del-tgt', 'text', 'Target')
    await seedEdge(canvasStore, canvasId, 'n-del-src', 'n-del-tgt')
    const { registerCanvasNodeDeleteTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeDeleteTool(ctx as never)
    const deleteTool = registered[0]
    const result = (await deleteTool.execute({ id: 'n-del-src' }, { signal: new AbortController().signal } as never)) as { ok: boolean; deletedId: string; version: number }
    expect(result.ok).toBe(true)
    expect(result.deletedId).toBe('n-del-src')
    // Edge should be gone.
    const snap = canvasStore.snapshot(canvasId)
    expect(snap.graph.edges.length).toBe(0)
    expect(snap.graph.nodes.length).toBe(1) // target remains
  })

  it('canvas_node_delete with wrong id returns node-not-found', async () => {
    const { canvasStore, canvasId } = await wireStore()
    void canvasId
    const { registerCanvasNodeDeleteTool } = await import('../src/tools')
    const { ctx, registered } = buildCtx()
    registerCanvasNodeDeleteTool(ctx as never)
    const deleteTool = registered[0]
    const result = (await deleteTool.execute({ id: 'n-gone' }, { signal: new AbortController().signal } as never)) as { ok: boolean; code: string; message: string }
    expect(result.ok).toBe(false)
    expect(result.code).toBe('node-not-found')
  })

  it('all 5 single-node tools support omitting canvasId (default-resolution)', async () => {
    const { canvasStore, canvasId } = await wireStore()
    await seedNode(canvasStore, canvasId, 'n-default', 'text', 'Default Canvas')
    const { registerCanvasNodeViewTool, registerCanvasNodeAddTool, registerCanvasNodeUpdateTool, registerCanvasNodeRenameTool, registerCanvasNodeDeleteTool } = await import('../src/tools')
    // View via default canvasId (omitted).
    let tool: { execute: (...a: unknown[]) => Promise<unknown> }
    let r: { ok: boolean }
    ;(({ ctx, registered }) => { registerCanvasNodeViewTool(ctx as never); tool = registered[0] })(buildCtx())
    r = (await tool.execute({ id: 'n-default' }, { signal: new AbortController().signal } as never) as { ok: boolean })
    expect(r.ok).toBe(true)

    ;(({ ctx, registered }) => { registerCanvasNodeRenameTool(ctx as never); tool = registered[0] })(buildCtx())
    r = (await tool.execute({ id: 'n-default', label: 'Renamed via default' }, { signal: new AbortController().signal } as never) as { ok: boolean })
    expect(r.ok).toBe(true)

    ;(({ ctx, registered }) => { registerCanvasNodeUpdateTool(ctx as never); tool = registered[0] })(buildCtx())
    r = (await tool.execute({ id: 'n-default', data: { x: 1 } }, { signal: new AbortController().signal } as never) as { ok: boolean })
    expect(r.ok).toBe(true)

    ;(({ ctx, registered }) => { registerCanvasNodeAddTool(ctx as never); tool = registered[0] })(buildCtx())
    r = (await tool.execute({ type: 'note', label: 'Added via default' }, { signal: new AbortController().signal } as never) as { ok: boolean })
    expect(r.ok).toBe(true)

    ;(({ ctx, registered }) => { registerCanvasNodeDeleteTool(ctx as never); tool = registered[0] })(buildCtx())
    r = (await tool.execute({ id: 'n-default' }, { signal: new AbortController().signal } as never) as { ok: boolean })
    expect(r.ok).toBe(true)
  })
})
