/**
 * AssetStore (M2) unit tests — registration from canvas nodes (incl. data
 * URLs and scoped local files), idempotency, metadata updates, deletion with
 * dependency preflights (block / break-refs / migrate-shared), hard copies
 * across projects, and the canvas→library file sync.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore } from '../src/project-store'
import {
  registerCanvasAsset,
  listAssets,
  updateAssetMeta,
  deleteAsset,
  copyAssetToProject,
  syncAssetFromCanvas,
  projectAssetRoot,
  sharedAssetRoot,
  projectAssetRootAt,
  ASSET_CATEGORY_DIR,
  AssetDeleteBlockedError,
} from '../src/asset-store'

let ws: string
let canvasStore: CanvasStore
let ps: ProjectStore
const roots = (): string[] => [ws]
function sourcePathFor(projectId: string): string | undefined {
  return ps.snapshot().projects.find((x) => x.id === projectId)?.sourcePath
}

async function setup(): Promise<void> {
  ws = await mkdtemp(join(tmpdir(), 'media-studio-assets-'))
  canvasStore = new CanvasStore(ws, {})
  ps = new ProjectStore(ws, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(ws, 'Movies') })
  await ps.ready()
}

async function newProject(name: string) {
  return ps.createProject(name)
}

/** Write a real local file inside the workspace so scoping passes. */
async function writeMedia(rel: string, content: string | Buffer): Promise<string> {
  const p = join(ws, rel)
  await mkdir(join(ws, rel.split('/')[0]), { recursive: true })
  await writeFile(p, content)
  return p
}

/** Put a media node with resultUrl on a project canvas. */
function putNode(projectId: string, nodeId: string, type: 'image' | 'video' | 'music', url: string): void {
  canvasStore.apply(projectId, [
    { op: 'addNode', nodeId, type, label: 'test', data: { status: 'done', resultUrl: url } },
  ])
}

beforeEach(setup)
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('registration', () => {
  it('registers a canvas image node as a hard copy with index entry', async () => {
    const p = await newProject('P')
    const src = await writeMedia('web-jobs/hero.png', 'png-bytes-123')
    putNode(p.id, 'n-1', 'image', src)
    const r = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'character', name: '林晚', sourcePath: sourcePathFor(p.id) })
    expect(r.created).toBe(true)
    expect(r.asset.kind).toBe('character')
    expect(r.asset.name).toBe('林晚')
    const file = join(projectAssetRootAt(sourcePathFor(p.id), ws, p.id), ASSET_CATEGORY_DIR.character, r.asset.file)
    expect(await readFile(file, 'utf8')).toBe('png-bytes-123')
    // .index.json persisted (sourcePath project)
    const assets = await listAssets(ws, p.id, sourcePathFor(p.id))
    expect(assets).toHaveLength(1)
    expect(assets[0].origin).toEqual({ type: 'canvas', canvasNodeId: 'n-1' })
  })

  it('is idempotent per canvas node', async () => {
    const p = await newProject('P')
    const src = await writeMedia('web-jobs/a.png', 'aaa')
    putNode(p.id, 'n-1', 'image', src)
    const first = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'scene', sourcePath: sourcePathFor(p.id) })
    const second = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'scene', sourcePath: sourcePathFor(p.id) })
    expect(first.asset.id).toBe(second.asset.id)
    expect(second.created).toBe(false)
    expect(await listAssets(ws, p.id, sourcePathFor(p.id))).toHaveLength(1)
  })

  it('decodes data: URLs', async () => {
    const p = await newProject('P')
    const b64 = Buffer.from('png-bytes').toString('base64')
    putNode(p.id, 'n-1', 'image', `data:image/png;base64,${b64}`)
    const r = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'character', sourcePath: sourcePathFor(p.id) })
    expect(r.asset.file.endsWith('.png')).toBe(true)
    expect(await readFile(join(projectAssetRootAt(sourcePathFor(p.id), ws, p.id), ASSET_CATEGORY_DIR.character, r.asset.file), 'utf8')).toBe('png-bytes')
  })

  it('rejects nodes without resultUrl or missing nodes', async () => {
    const p = await newProject('P')
    await expect(
      registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'ghost', kind: 'scene', sourcePath: sourcePathFor(p.id) }),
    ).rejects.toThrow('not found')
    putNode(p.id, 'n-2', 'video', '')
    await expect(
      registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-2', kind: 'clip', sourcePath: sourcePathFor(p.id) }),
    ).rejects.toThrow('no resultUrl')
  })

  it('refuses sources outside the allowed roots', async () => {
    const p = await newProject('P')
    putNode(p.id, 'n-1', 'image', '/etc/hostname')
    await expect(
      registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'scene', sourcePath: sourcePathFor(p.id) }),
    ).rejects.toThrow('could not be read')
  })
})

describe('metadata + deletion', () => {
  it('updateAssetMeta renames and tags without touching the file', async () => {
    const p = await newProject('P')
    const src = await writeMedia('web-jobs/b.png', 'bbb')
    putNode(p.id, 'n-1', 'image', src)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'character', name: '旧名', sourcePath: sourcePathFor(p.id) })
    const updated = await updateAssetMeta(ws, p.id, asset.id, { name: '林晚·立绘', tags: ['女主'] }, sourcePathFor(p.id))
    expect(updated.name).toBe('林晚·立绘')
    expect(updated.tags).toEqual(['女主'])
    expect(updated.file).toBe(asset.file)
    await expect(updateAssetMeta(ws, p.id, asset.id, { name: '   ' }, sourcePathFor(p.id))).rejects.toThrow('required')
  })

  it('blocks deletion by default when another project soft-references it', async () => {
    const owner = await newProject('拥有者')
    const refP = await newProject('引用者')
    const src = await writeMedia('web-jobs/c.png', 'ccc')
    putNode(owner.id, 'n-1', 'image', src)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: owner.id, canvasNodeId: 'n-1', kind: 'scene', name: '客厅', sourcePath: sourcePathFor(owner.id) })
    // referrer canvas
    canvasStore.apply(refP.id, [
      { op: 'addNode', nodeId: 'r-1', type: 'image', label: 'ref', data: { assetRef: { projectId: owner.id, assetId: asset.id }, status: 'done', resultUrl: '/x.png' } },
    ])
    await expect(deleteAsset(ws, canvasStore, owner.id, asset.id, 'cancel', [owner.id, refP.id], sourcePathFor(owner.id))).rejects.toBeInstanceOf(AssetDeleteBlockedError)
    expect(await listAssets(ws, owner.id, sourcePathFor(owner.id))).toHaveLength(1)
  })

  it('break-refs cascade removes the file and marks referencing nodes broken', async () => {
    const owner = await newProject('拥有者')
    const refP = await newProject('引用者')
    const src = await writeMedia('web-jobs/d.png', 'ddd')
    putNode(owner.id, 'n-1', 'image', src)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: owner.id, canvasNodeId: 'n-1', kind: 'scene', sourcePath: sourcePathFor(owner.id) })
    canvasStore.apply(refP.id, [
      { op: 'addNode', nodeId: 'r-1', type: 'image', label: 'ref', data: { assetRef: { projectId: owner.id, assetId: asset.id }, status: 'done', resultUrl: '/x.png' } },
    ])
    const res = await deleteAsset(ws, canvasStore, owner.id, asset.id, 'break-refs', [owner.id, refP.id], sourcePathFor(owner.id))
    expect(res.brokenNodes).toBe(1)
    expect(await listAssets(ws, owner.id, sourcePathFor(owner.id))).toHaveLength(0)
    const node = canvasStore.peek(refP.id)!.graph.nodes.find((n) => n.id === 'r-1')!
    expect(node.data.brokenAsset).toBe(true)
    await expect(access(join(projectAssetRootAt(sourcePathFor(owner.id), ws, owner.id), ASSET_CATEGORY_DIR.scene, asset.file))).rejects.toThrow()
  })

  it('migrate-shared moves the asset into __shared and rewrites refs', async () => {
    const owner = await newProject('拥有者')
    const refP = await newProject('引用者')
    const src = await writeMedia('web-jobs/e.png', 'eee')
    putNode(owner.id, 'n-1', 'image', src)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: owner.id, canvasNodeId: 'n-1', kind: 'scene', name: '共享素材', sourcePath: sourcePathFor(owner.id) })
    canvasStore.apply(refP.id, [
      { op: 'addNode', nodeId: 'r-1', type: 'image', label: 'ref', data: { assetRef: { projectId: owner.id, assetId: asset.id }, status: 'done', resultUrl: '/x.png' } },
    ])
    const res = await deleteAsset(ws, canvasStore, owner.id, asset.id, 'migrate-shared', [owner.id, refP.id], sourcePathFor(owner.id))
    expect(res.migrated).toBe(true)
    // lives on in the shared root
    const sharedFiles = await readdir(join(sharedAssetRoot(ws), ASSET_CATEGORY_DIR.scene))
    expect(sharedFiles).toContain(asset.file)
    expect(await readFile(join(sharedAssetRoot(ws), ASSET_CATEGORY_DIR.scene, asset.file), 'utf8')).toBe('eee')
    // ref rewritten to __shared
    const node = canvasStore.peek(refP.id)!.graph.nodes.find((n) => n.id === 'r-1')!
    expect((node.data.assetRef as { projectId: string }).projectId).toBe('__shared')
    // gone from the owner index
    expect(await listAssets(ws, owner.id, sourcePathFor(owner.id))).toHaveLength(0)
  })
})

describe('hard copy + sync', () => {
  it('copyAssetToProject duplicates with provenance and is idempotent', async () => {
    const a = await newProject('源')
    const b = await newProject('目标')
    const src = await writeMedia('web-jobs/f.png', 'fff')
    putNode(a.id, 'n-1', 'image', src)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: a.id, canvasNodeId: 'n-1', kind: 'character', name: '林晚', sourcePath: sourcePathFor(a.id) })
    const r1 = await copyAssetToProject(ws, a.id, asset.id, b.id, sourcePathFor(a.id), sourcePathFor(b.id))
    expect(r1.created).toBe(true)
    expect(r1.asset.id).not.toBe(asset.id)
    expect(r1.asset.copyOf).toEqual({ projectId: a.id, assetId: asset.id })
    expect(await readFile(join(projectAssetRootAt(sourcePathFor(b.id), ws, b.id), ASSET_CATEGORY_DIR.character, r1.asset.file), 'utf8')).toBe('fff')
    const r2 = await copyAssetToProject(ws, a.id, asset.id, b.id, sourcePathFor(a.id), sourcePathFor(b.id))
    expect(r2.created).toBe(false)
    expect(r2.asset.id).toBe(r1.asset.id)
    expect(await listAssets(ws, b.id, sourcePathFor(b.id))).toHaveLength(1)
    // owner's delete preflight now reports the copy consumer
    const deps = await ps.dependentsOf(a.id)
    expect(deps.copyConsumers.some((c) => c.projectId === b.id && c.count >= 1)).toBe(true)
  })

  it('syncAssetFromCanvas refreshes the file when the node was regenerated', async () => {
    const p = await newProject('P')
    const v1 = await writeMedia('web-jobs/v1.mp4', 'small')
    putNode(p.id, 'n-1', 'video', v1)
    const { asset } = await registerCanvasAsset({ wsRoot: ws, roots: roots(), canvasStore, projectId: p.id, canvasNodeId: 'n-1', kind: 'clip', name: '片段', sourcePath: sourcePathFor(p.id) })
    const filePath = join(projectAssetRootAt(sourcePathFor(p.id), ws, p.id), ASSET_CATEGORY_DIR.clip, asset.file)
    // agent regenerates the node → new, bigger file
    const v2 = await writeMedia('web-jobs/v2.mp4', 'much-bigger-content')
    canvasStore.apply(p.id, [{ op: 'updateNode', id: 'n-1', data: { resultUrl: v2, status: 'done' } }])
    const res = await syncAssetFromCanvas(ws, roots(), canvasStore, p.id, asset.id, sourcePathFor(p.id))
    expect(res.changed).toBe(true)
    expect(await readFile(filePath, 'utf8')).toBe('much-bigger-content')
    const listed = await listAssets(ws, p.id, sourcePathFor(p.id))
    expect(listed[0].bytes).toBe(Buffer.byteLength('much-bigger-content'))
  })
})

describe('migrateBrokenCanvasUrls', () => {
  it('rewrites file:///tmp/ URLs to project-relative paths for sourcePath projects', async () => {
    const ws2 = await mkdtemp(join(tmpdir(), 'media-studio-migrate-'))
    const srcPath = join(ws2, 'my-project')
    await mkdir(srcPath, { recursive: true })

    // Write a real PNG-like file to OS temp dir so it is OUTSIDE the allowed roots
    const os = await import('node:os')
    const tmpFile = join(os.tmpdir(), `media-studio-test-img-${Date.now()}.png`)
    await writeFile(tmpFile, Buffer.from('fake-png-bytes'))

    // Write a canvas with a file:///tmp/ resultUrl
    const canvas = {
      nodes: [
        { id: 'n-1', type: 'image', label: 'test', data: { resultUrl: `file://${tmpFile}`, status: 'done' } },
      ],
      edges: [],
      version: 1,
    }
    await writeFile(join(srcPath, '.canvas.json'), JSON.stringify(canvas))

    // Create project registry entry
    const registry = {
      version: 1,
      activeId: 'p-test',
      recent: ['p-test'],
      projects: {
        'p-test': {
          id: 'p-test',
          name: 'Test',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastOpenedAt: new Date().toISOString(),
          sourcePath: srcPath,
        },
      },
    }
    await writeFile(join(ws2, 'projects.json'), JSON.stringify(registry))

    const { migrateBrokenCanvasUrls } = await import('../src/asset-store')
    const r = await migrateBrokenCanvasUrls(ws2, [ws2], ['p-test'], { 'p-test': srcPath })

    expect(r.migrated).toBe(1)
    expect(r.errors).toHaveLength(0)

    // Canvas should be rewritten
    const updated = JSON.parse((await readFile(join(srcPath, '.canvas.json'), 'utf8')) as string)
    const newUrl = updated.nodes[0].data.resultUrl
    expect(newUrl).toMatch(/^projects\/p-test\/assets\/characters\//)
    expect(newUrl).not.toMatch(/^file:\/\//)

    // Asset file should be in sourcePath assets dir
    const assetDir = join(srcPath, 'assets', 'characters')
    expect(await readdir(assetDir)).toHaveLength(1)
    expect(await readFile(join(assetDir, (await readdir(assetDir))[0]), 'utf8')).toBe('fake-png-bytes')

    await rm(ws2, { recursive: true, force: true })
  })
})
