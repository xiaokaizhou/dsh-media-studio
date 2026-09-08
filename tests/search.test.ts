/**
 * Search + soft-reference unit tests (M3) — corpus (library + canvas media),
 * grouping/scoring, per-group limits, alreadyRefCount, and addSoftRefToCanvas.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore, type ProjectMeta } from '../src/project-store'
import {
  registerCanvasAsset,
  loadAssetIndex,
  writeAssetIndex,
  projectAssetRoot,
  ASSET_CATEGORY_DIR,
  type Asset,
} from '../src/asset-store'
import { runSearch, addSoftRefToCanvas, resolveAsset } from '../src/search'
import { projectAssetRootAt } from '../src/asset-store'

let ws: string
let canvasStore: CanvasStore
let ps: ProjectStore

async function addLibraryAsset(projectId: string, a: Asset): Promise<void> {
  const meta = ps.snapshot().projects.find((p) => p.id === projectId)
  const root = projectAssetRootAt(meta?.sourcePath, ws, projectId)
  const cat = join(root, ASSET_CATEGORY_DIR[a.kind])
  await mkdir(cat, { recursive: true })
  await writeFile(join(cat, a.file), 'x')
  const indexFile = meta?.sourcePath ? '.index.json' : 'index.json'
  const idx = await loadAssetIndex(root, indexFile)
  idx.assets.push(a)
  await writeAssetIndex(root, idx, indexFile)
}

async function registerCanvasNode(projectId: string, nodeId: string, type: 'image' | 'video' | 'music', url: string, label: string): Promise<void> {
  canvasStore.apply(projectId, [
    { op: 'addNode', nodeId, type, label, data: { status: 'done', resultUrl: url } },
  ])
}

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'media-studio-search-'))
  canvasStore = new CanvasStore(ws, {})
  ps = new ProjectStore(ws, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(ws, "Movies") })
  await ps.ready()
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('runSearch corpus & grouping', () => {
  it('finds library assets of the scope project in "current" and others in "other"', async () => {
    const a = await ps.createProject('林晚传')
    const b = await ps.createProject('番外篇')
    await addLibraryAsset(a.id, {
      id: 'a1', kind: 'character', name: '林晚·半身像', file: 'a1.png',
      origin: { type: 'generated', prompt: '林晚 立绘 古风' },
      createdAt: 'n', updatedAt: 'n',
    })
    await addLibraryAsset(b.id, {
      id: 'b1', kind: 'scene', name: '林晚家客厅', file: 'b1.png',
      origin: { type: 'generated', prompt: '古代庭院 蜡烛' },
      createdAt: 'n', updatedAt: 'n',
    })
    const res = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '林晚', scopeProjectId: a.id })
    expect(res.hitCount).toBe(2)
    const cur = res.groups.find((g) => g.key === 'current')
    const other = res.groups.find((g) => g.key === 'other')
    expect(cur?.items.map((i) => i.assetId)).toEqual(['a1'])
    expect(other?.items.map((i) => i.assetId)).toEqual(['b1'])
  })

  it('includes finished canvas media as the "canvas" catalog, ranked after library', async () => {
    const a = await ps.createProject('林晚传')
    await addLibraryAsset(a.id, {
      id: 'a1', kind: 'scene', name: '林晚的房间', file: 'a1.png', createdAt: 'n', updatedAt: 'n',
    })
    await registerCanvasNode(a.id, 'n-canvas', 'image', '/api/ok/a.png', '林晚 手绘稿')
    const res = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '林晚', scopeProjectId: a.id })
    const cur = res.groups.find((g) => g.key === 'current')!
    const kinds = cur.items.map((i) => i.catalog)
    // library ranks before canvas media
    expect(kinds[0]).toBe('library')
    expect(kinds).toContain('canvas')
    const canvasItem = cur.items.find((i) => i.catalog === 'canvas')!
    expect(canvasItem.canvasNodeId).toBe('n-canvas')
  })

  it('filters by name/prompt tokens and returns nothing on no match', async () => {
    const a = await ps.createProject('P')
    await addLibraryAsset(a.id, {
      id: 'a1', kind: 'character', name: '林晚', file: 'a1.png',
      origin: { type: 'generated', prompt: '女主 古装' },
      createdAt: 'n', updatedAt: 'n',
    })
    const hit = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '古装', scopeProjectId: a.id })
    expect(hit.hitCount).toBe(1)
    const miss = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '林晚礼服', scopeProjectId: a.id })
    expect(miss.hitCount).toBe(0)
    const empty = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '', scopeProjectId: a.id })
    expect(empty.hitCount).toBe(0)
  })

  it('caps each group to limitPerGroup and reports totals', async () => {
    const a = await ps.createProject('P')
    for (let i = 0; i < 5; i++) {
      await addLibraryAsset(a.id, {
        id: `a${i}`, kind: 'scene', name: `林晚场景${i}`, file: `a${i}.png`, createdAt: 'n', updatedAt: 'n',
      })
    }
    const res = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '林晚', scopeProjectId: a.id, limitPerGroup: 3 })
    const cur = res.groups.find((g) => g.key === 'current')!
    expect(cur.items).toHaveLength(3)
    expect(cur.total).toBe(5)
  })
})

describe('addSoftRefToCanvas & alreadyRefCount', () => {
  it('adds an image node referencing the owner asset with the proxy path', async () => {
    const owner = await ps.createProject('素材源')
    const target = await ps.createProject('使用中')
    const asset: Asset = { id: 's1', kind: 'character', name: '林晚·立绘', file: 's1.png', createdAt: 'n', updatedAt: 'n' }
    await addLibraryAsset(owner.id, asset)
    const { nodeId, refCount } = addSoftRefToCanvas(canvasStore, target.id, ws, owner.id, asset)
    expect(refCount).toBe(1)
    const node = canvasStore.peek(target.id)!.graph.nodes.find((n) => n.id === nodeId)!
    expect(node.type).toBe('image')
    expect(node.data.assetRef).toEqual({ projectId: owner.id, assetId: 's1' })
    expect(node.data.assetKind).toBe('character')
    expect(String(node.data.resultUrl)).toContain(join('projects', owner.id, 'assets', 'characters'))
    // second reference is allowed and counted
    const second = addSoftRefToCanvas(canvasStore, target.id, ws, owner.id, asset)
    expect(second.refCount).toBe(2)
  })

  it('alreadyRefCount reflects references in the scope project', async () => {
    const owner = await ps.createProject('素材源')
    const target = await ps.createProject('使用中')
    const asset: Asset = { id: 's2', kind: 'scene', name: '林晚房间', file: 's2.png', createdAt: 'n', updatedAt: 'n' }
    await addLibraryAsset(owner.id, asset)
    addSoftRefToCanvas(canvasStore, target.id, ws, owner.id, asset)
    const res = await runSearch({ wsRoot: ws, canvasStore, projects: ps.snapshot().projects, q: '林晚', scopeProjectId: target.id })
    const other = res.groups.find((g) => g.key === 'other')!
    const item = other.items.find((i) => i.assetId === 's2')!
    expect(item.alreadyRefCount).toBe(1)
  })

  it('resolveAsset round-trips through the owner index', async () => {
    const owner = await ps.createProject('素材源')
    const asset: Asset = { id: 's3', kind: 'audio', name: '旁白-林晚', file: 's3.mp3', createdAt: 'n', updatedAt: 'n' }
    await addLibraryAsset(owner.id, asset)
    const meta = ps.snapshot().projects.find((p) => p.id === owner.id)
    const resolved = await resolveAsset(ws, owner.id, 's3', meta?.sourcePath)
    expect(resolved.name).toBe('旁白-林晚')
    await expect(resolveAsset(ws, owner.id, 'ghost', meta?.sourcePath)).rejects.toThrow('not found')
  })
})
