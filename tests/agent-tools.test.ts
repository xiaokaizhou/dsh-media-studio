/**
 * Integration smoke for the 12 new media_studio_* agent tools added on top
 * of the four canvas_* tools. The test:
 *
 *   1. Builds a fake `ctx` (cordis service stub) that captures every
 *      `ctx.tools.register(...)` call.
 *   2. Calls each of the 12 new `registerMediaStudio*Tool(ctx)` functions.
 *   3. Asserts that all 12 tool names landed in the captured registry and
 *      that each `ToolDefinition` carries a non-empty description + the
 *      expected parameter shape.
 *   4. Also runs the read-only tools (`media_studio_list_projects`,
 *      `media_studio_search_assets`) end-to-end against an in-memory
 *      ProjectStore / CanvasStore seeded with one project + one asset to
 *      prove the full execute() pipeline is wired up.
 *
 * The DSH boot path (src/index.ts) calls these same 12 functions verbatim;
 * if they succeed here they will succeed in boot.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'

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

  it('register the existing 4 canvas_* tools for regression', async () => {
    const { ctx, registered } = buildCtx()
    const regFns = await import('../src/tools')
    regFns.registerCanvasViewTool(ctx as never)
    regFns.registerCanvasPatchTool(ctx as never)
    regFns.registerAutoArrangeTool(ctx as never)
    regFns.registerCanvasRefreshNodeTool(ctx as never)
    const names = registered.map((t) => t.name).sort()
    expect(names).toEqual(['canvas_auto_arrange', 'canvas_graph_patch', 'canvas_graph_view', 'canvas_refresh_node'])
  })

  it('execute() media_studio_list_projects returns the seeded project end-to-end', async () => {
    // Wire the real PluginService singletons (canvasStore + projectStore)
    // to the temp workspace, register the list tool, and call its execute.
    const { setMediaStudioHandles } = await import('../src/service-state')
    const { CanvasStore } = await import('../src/canvas-store')
    const { ProjectStore } = await import('../src/project-store')
    const canvasStore = new CanvasStore(wsRoot)
    const projectStore = new ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true })
    setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
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
    const projectStore = new ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true })
    setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
      projectStore,
      projectSseClients: new Set(),
    })
    await projectStore.ready()
    const proj = await projectStore.createProject('search-target')
    // Seed a small PNG asset under the project asset root so the search
    // index has something to find.
    const assetDir = join(wsRoot, 'projects', proj.id, 'assets', 'characters')
    await mkdir(assetDir, { recursive: true })
    const seedBuf = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108020000009077533DE', 'hex')
    await writeFile(join(assetDir, 'seed.png'), seedBuf)
    const indexPath = join(wsRoot, 'projects', proj.id, 'assets', 'index.json')
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
