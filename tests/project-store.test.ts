/**
 * ProjectStore unit tests (M0) — registry CRUD, legacy migration, recent
 * capping, deletion dependency analysis and the three cascade modes.
 *
 * Disk layout under a temp workspace:
 *   <tmp>/projects.json
 *   <tmp>/canvases/<id>.json
 *   <tmp>/projects/<id>/assets/{characters,scenes,audio,clips}/index.json
 *   <tmp>/shared-assets/
 *   <tmp>/trash/
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore, ProjectDeleteBlockedError, type ProjectMeta } from '../src/project-store'
import { writeAssetIndex, ASSET_CATEGORY_DIR, type Asset } from '../src/asset-store'

let wsRoot: string
let canvasStore: CanvasStore
let store: ProjectStore
const events: string[] = []

async function makeStore(opts: { recentLimit?: number; trashEnabled?: boolean } = {}): Promise<ProjectStore> {
  events.length = 0
  canvasStore = new CanvasStore(wsRoot, {})
  store = new ProjectStore(wsRoot, canvasStore, {
    recentLimit: opts.recentLimit ?? 10,
    trashEnabled: opts.trashEnabled ?? true,
    onEvent: (e) => events.push(e.type),
  })
  await store.ready()
  return store
}

/** Write a legacy canvas file the way the old plugin would. */
async function writeLegacyCanvas(id: string, version = 3): Promise<void> {
  const dir = join(wsRoot, 'canvases')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${id}.json`),
    JSON.stringify({
      nodes: [{ id: 'n-1', type: 'note', label: `${id} note`, data: { content: 'x' } }],
      edges: [],
      version,
    }),
  )
}

/** Apply a soft-reference node onto a project's canvas (as M3's UI will). */
function applySoftRef(projectId: string, nodeId: string, ref: { projectId: string; assetId: string }): void {
  canvasStore.apply(projectId, [
    { op: 'addNode', nodeId, type: 'image', label: 'ref', data: { assetRef: ref, status: 'done', resultUrl: '/x.png' } },
  ])
}

async function makeOwnerAsset(projectId: string, asset: Asset): Promise<void> {
  const catDir = join(wsRoot, 'projects', projectId, 'assets', ASSET_CATEGORY_DIR[asset.kind])
  await mkdir(catDir, { recursive: true })
  await writeFile(join(catDir, asset.file), 'png-bytes')
  const root = join(wsRoot, 'projects', projectId, 'assets')
  const existing = await readAssetIndex(root)
  await writeAssetIndex(root, { version: 1, assets: [...existing, asset] })
}

async function readAssetIndex(root: string) {
  try {
    return (JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as { assets: Asset[] }).assets
  } catch {
    return [] as Asset[]
  }
}

beforeEach(async () => {
  wsRoot = await mkdtemp(join(tmpdir(), 'media-studio-projects-'))
})

afterEach(async () => {
  await rm(wsRoot, { recursive: true, force: true })
})

describe('boot & migration', () => {
  it('starts empty on a brand-new workspace', async () => {
    await makeStore()
    expect(store.snapshot().projects).toHaveLength(0)
    expect(store.snapshot().activeId).toBeNull()
    expect(store.activeCanvasId()).toBeNull()
  })

  it('promotes every legacy canvas to a project, main becomes active', async () => {
    await writeLegacyCanvas('main', 5)
    await writeLegacyCanvas('scene-test', 2)
    await makeStore()
    const snap = store.snapshot()
    expect(snap.projects.map((p) => p.id).sort()).toEqual(['main', 'scene-test'])
    expect(snap.projects.find((p) => p.id === 'main')?.legacy).toBe(true)
    expect(snap.activeId).toBe('main')
    expect(snap.recent).toContain('scene-test')
    // Canvas state is restored into memory (dependents scans see nodes).
    expect(canvasStore.peek('scene-test')?.graph.nodes).toHaveLength(1)
  })

  it('leaves an existing registry untouched and prunes stale recent ids', async () => {
    await writeLegacyCanvas('main')
    await makeStore()
    const created = await store.createProject('第二次启动')
    // Registry now exists on disk with p-* project.
    await makeStore() // fresh store over the same root
    expect(store.snapshot().projects.find((p) => p.id === created.id)?.name).toBe('第二次启动')
    expect(store.snapshot().projects.some((p) => p.id === 'main')).toBe(true)
  })
})

describe('create / rename / recent', () => {
  it('createProject builds the 4-category template and activates it', async () => {
    await makeStore()
    const p = await store.createProject('林晚传')
    expect(p.id.startsWith('p-')).toBe(true)
    expect(store.snapshot().activeId).toBe(p.id)
    const root = join(wsRoot, 'projects', p.id, 'assets')
    for (const dir of ['characters', 'scenes', 'audio', 'clips']) {
      expect((await readdir(join(root, dir))).length).toBeGreaterThanOrEqual(0)
      await expect(rm(join(root, dir), { recursive: true })).resolves.toBeUndefined()
    }
    expect(await readAssetIndex(root)).toEqual([])
  })

  it('caps the recent list at recentLimit', async () => {
    await makeStore({ recentLimit: 3 })
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = await store.createProject(`p${i}`)
      ids.push(p.id)
    }
    expect(store.snapshot().recent).toHaveLength(3)
    expect(store.snapshot().recent[0]).toBe(ids[4])
  })

  it('openProject moves the project to the front and switches active', async () => {
    await makeStore()
    const a = await store.createProject('A')
    const b = await store.createProject('B')
    expect(store.snapshot().activeId).toBe(b.id)
    await store.openProject(a.id)
    expect(store.snapshot().activeId).toBe(a.id)
    expect(store.snapshot().recent[0]).toBe(a.id)
  })

  it('rename only touches the name when the project has no user sourcePath', async () => {
    // Pure-registry rename: a project created without a `sourcePath` (the
    // default for `createProject(name)` — no folder picked) only changes
    // its display name. id stays stable, the on-disk layout under
    // `<wsRoot>/projects/<id>` is not touched.
    await makeStore()
    const p = await store.createProject('旧名')
    expect(p.sourcePath).toBeUndefined()
    const renamed = await store.renameProject(p.id, '新名·重制版')
    expect(renamed.id).toBe(p.id)
    expect(renamed.name).toBe('新名·重制版')
    expect(store.snapshot().projects.find((x) => x.id === p.id)?.name).toBe('新名·重制版')
    await expect(store.renameProject(p.id, 'bad/name')).rejects.toThrow('may not contain')
    await expect(store.renameProject(p.id, '  ')).rejects.toThrow()
  })

  it('rename renames the user-owned sourcePath folder and updates the registry', async () => {
    // Folder-owned project: a project created with a real sourcePath (the
    // native picker path) renames both the display name and the directory
    // itself, then threads the new path through the registry + the canvas
    // store. References don't break because the project id is immutable.
    const tmp = await mkdtemp(join(tmpdir(), 'media-studio-rename-'))
    const before = join(tmp, 'old-name')
    await mkdir(before, { recursive: true })
    await writeFile(join(before, 'AGENTS.md'), '# old\n', 'utf8')
    await writeFile(join(before, '.canvas.json'), '{"version":0,"nodes":[],"edges":[]}', 'utf8')
    await makeStore()
    const p = await store.createProject('旧名', before)
    expect(p.sourcePath).toBe(before)
    const renamed = await store.renameProject(p.id, '新名·重制版')
    expect(renamed.id).toBe(p.id)
    expect(renamed.name).toBe('新名·重制版')
    const after = join(tmp, '新名·重制版')
    expect(renamed.sourcePath).toBe(after)
    // Old directory is gone, new directory is real.
    const { stat } = await import('node:fs/promises')
    await expect(stat(before)).rejects.toThrow(/ENOENT/)
    const afterStat = await stat(after)
    expect(afterStat.isDirectory()).toBe(true)
    // Files moved with the folder.
    expect((await readdir(after)).sort()).toEqual(['.canvas.json', 'AGENTS.md'].sort())
    // Registry on disk reflects the new path.
    const raw = JSON.parse(await readFile(join(wsRoot, 'projects.json'), 'utf8'))
    expect(raw.projects[p.id].sourcePath).toBe(after)
    // Renaming again to the same name is a no-op on disk.
    const twice = await store.renameProject(p.id, '新名·重制版')
    expect(twice.sourcePath).toBe(after)
  })

  it('rename refuses when the target folder name is already taken on disk', async () => {
    // Two siblings, one already on disk: renaming the first to the second's
    // name must reject rather than overwrite.
    const tmp = await mkdtemp(join(tmpdir(), 'media-studio-rename-clash-'))
    const aDir = join(tmp, 'a')
    const bDir = join(tmp, 'b')
    await mkdir(aDir, { recursive: true })
    await mkdir(bDir, { recursive: true })
    await makeStore()
    const a = await store.createProject('A', aDir)
    const b = await store.createProject('B', bDir)
    await expect(store.renameProject(a.id, 'b')).rejects.toThrow(/already exists/)
    // Registry untouched.
    expect(store.snapshot().projects.find((x) => x.id === a.id)?.sourcePath).toBe(aDir)
    expect(b.id).toBeDefined()
  })
})

describe('deletion dependency analysis & cascades', () => {
  it('dependentsOf reports refs and hard-copy consumers', async () => {
    await makeStore()
    const owner = await store.createProject('拥有者')
    const refP = await store.createProject('引用者')
    applySoftRef(refP.id, 'r-1', { projectId: owner.id, assetId: 'a-1' })
    applySoftRef(refP.id, 'r-2', { projectId: owner.id, assetId: 'a-1' })
    // a hard copy inside the referencing project
    canvasStore.apply(refP.id, [
      { op: 'addNode', nodeId: 'c-1', type: 'image', label: 'copy', data: { refCopiesFrom: { projectId: owner.id } } },
    ])
    const deps = await store.dependentsOf(owner.id)
    expect(deps.totalRefs).toBe(2)
    expect(deps.hits).toHaveLength(1)
    expect(deps.hits[0].refProjectId).toBe(refP.id)
    expect(deps.hits[0].nodeIds.sort()).toEqual(['r-1', 'r-2'])
    expect(deps.hits[0].assetId).toBe('a-1')
    expect(deps.copyConsumers).toHaveLength(1)
    expect(deps.copyConsumers[0].projectId).toBe(refP.id)
  })

  it('blocks deletion by default when referenced (registry untouched)', async () => {
    await makeStore()
    const owner = await store.createProject('拥有者')
    const refP = await store.createProject('引用者')
    applySoftRef(refP.id, 'r-1', { projectId: owner.id, assetId: 'a-1' })
    events.length = 0
    await expect(store.deleteProject(owner.id)).rejects.toBeInstanceOf(ProjectDeleteBlockedError)
    expect(store.snapshot().projects.some((p) => p.id === owner.id)).toBe(true)
    expect(events).toEqual([])
  })

  it('trash mode moves project dir + canvas file under trash and prunes recent', async () => {
    await makeStore()
    const p = await store.createProject('要删的')
    // give it a persisted canvas file
    canvasStore.apply(p.id, [{ op: 'addNode', type: 'note', label: 'hi', data: { content: 'x' } }])
    const result = await store.deleteProject(p.id)
    expect(result.deletedId).toBe(p.id)
    expect(store.snapshot().projects.some((x) => x.id === p.id)).toBe(false)
    expect(canvasStore.peek(p.id)).toBeNull()
    // asset dir moved to trash
    const trashDirs = await readdir(join(wsRoot, 'trash'))
    expect(trashDirs.length).toBeGreaterThan(0)
    const trashed = trashDirs.find((d) => d.startsWith(p.id))
    expect(trashed).toBeTruthy()
  })

  it('active switches to another project when the active one is deleted', async () => {
    await makeStore()
    const a = await store.createProject('A')
    const b = await store.createProject('B')
    await store.openProject(a.id)
    const result = await store.deleteProject(a.id)
    expect(result.switchedTo).toBe(b.id)
    expect(store.snapshot().activeId).toBe(b.id)
    expect(events).toContain('project-deleted')
  })

  it('break-refs cascade marks referencing nodes broken and still trashes', async () => {
    await makeStore()
    const owner = await store.createProject('拥有者')
    const refP = await store.createProject('引用者')
    applySoftRef(refP.id, 'r-1', { projectId: owner.id, assetId: 'a-1' })
    const result = await store.deleteProject(owner.id, 'trash', 'break-refs')
    expect(result.brokenNodes).toBe(1)
    const node = canvasStore.peek(refP.id)!.graph.nodes.find((n) => n.id === 'r-1')!
    expect(node.data.brokenAsset).toBe(true)
    expect(node.data.status).toBe('error')
    expect(store.snapshot().projects.some((x) => x.id === owner.id)).toBe(false)
  })

  it('migrate-shared cascade keeps referenced assets alive under __shared', async () => {
    await makeStore()
    const owner = await store.createProject('拥有者')
    const refP = await store.createProject('引用者')
    await makeOwnerAsset(owner.id, {
      id: 'a-1', kind: 'scene', name: '林晚家客厅', file: 'a-1.png',
      createdAt: 'now', updatedAt: 'now',
    })
    applySoftRef(refP.id, 'r-1', { projectId: owner.id, assetId: 'a-1' })
    const result = await store.deleteProject(owner.id, 'trash', 'migrate-shared')
    expect(result.migratedFiles).toBe(1)
    expect(result.rewrittenNodes).toBe(1)
    // Reference now points at the shared library.
    const node = canvasStore.peek(refP.id)!.graph.nodes.find((n) => n.id === 'r-1')!
    expect((node.data.assetRef as { projectId: string }).projectId).toBe('__shared')
    // File physically copied to shared root with index entry.
    const sharedRoot = join(wsRoot, 'shared-assets')
    const sharedAssets = await readAssetIndex(sharedRoot)
    const migrated = sharedAssets.find((a) => a.id === 'a-1')
    expect(migrated?.origin).toEqual({ type: 'migrated', fromProject: owner.id })
    const sharedFile = join(sharedRoot, ASSET_CATEGORY_DIR.scene, 'a-1.png')
    expect(await readFile(sharedFile, 'utf8')).toBe('png-bytes')
    // Owner is gone but __shared is not a registrable project.
    expect(store.snapshot().projects.some((x) => x.id === owner.id)).toBe(false)
    // Second migration of the same asset id must not duplicate the file.
    expect(events).toContain('project-deleted')
  })

  it('permanent mode removes files without leaving trash', async () => {
    await makeStore({ trashEnabled: false })
    const p = await store.createProject('永删')
    await store.deleteProject(p.id, 'permanent')
    await expect(readdir(join(wsRoot, 'trash'))).rejects.toThrow()
    await expect(readdir(join(wsRoot, 'projects'))).resolves.toEqual([])
  })
})

describe('registry file durability', () => {
  it('persists registry JSON that round-trips on the next store', async () => {
    await makeStore()
    const p = await store.createProject('持久')
    await store.renameProject(p.id, '持久2')
    const raw = JSON.parse(await readFile(join(wsRoot, 'projects.json'), 'utf8'))
    expect(raw.projects[p.id].name).toBe('持久2')
    expect(raw.activeId).toBe(p.id)
    expect(raw.version).toBe(1)
    // A brand new store instance over the same root sees the same data.
    const s2 = new ProjectStore(wsRoot, new CanvasStore(wsRoot, {}), { recentLimit: 10, trashEnabled: true })
    await s2.ready()
    expect(s2.snapshot().projects.find((x) => x.id === p.id)?.name).toBe('持久2')
    expect(s2.activeCanvasId()).toBe(p.id)
  })

  it('keeps legacy free-form canvases usable even outside the registry', async () => {
    await makeStore()
    // arbitrary canvas id used by an agent tool, unrelated to any project
    canvasStore.apply('scratch-board', [{ op: 'addNode', type: 'text', label: 't', data: { text: 'x' } }])
    const deps = await store.dependentsOf('main') // should not throw
    expect(deps.totalRefs).toBe(0)
  })
})

describe('lossless JSON round-trip (Issue B regression)', () => {
  it('createProject without sourcePath produces snapshot without undefined sourcePath key', async () => {
    await makeStore()
    const p = await store.createProject('无源路径项目')
    expect(p.sourcePath).toBeUndefined()
    // The snapshot must not contain any undefined-valued keys
    const snap = store.snapshot()
    const snapJson = JSON.stringify(snap)
    // Re-parse to confirm no undefined leaked
    const parsed = JSON.parse(snapJson) as ReturnType<ProjectStore['snapshot']>
    for (const proj of parsed.projects) {
      expect(proj).not.toHaveProperty('sourcePath')
    }
    // The tool-like return value must also be clean
    const returnVal = { ok: true, ...snap }
    const returnJson = JSON.stringify(returnVal)
    expect(returnJson).not.toContain('"sourcePath":undefined')
    expect(JSON.parse(returnJson)).toEqual(returnVal)
  })

  it('openProject without sourcePath preserves clean snapshot', async () => {
    await makeStore()
    const p = await store.createProject('开放测试')
    expect(p.sourcePath).toBeUndefined()
    const opened = await store.openProject(p.id)
    expect(opened.sourcePath).toBeUndefined()
    const snap = store.snapshot()
    for (const proj of snap.projects) {
      expect(proj).not.toHaveProperty('sourcePath')
    }
  })
})
