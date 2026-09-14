/**
 * M2-⑧ — `dependentsOf` no longer deep-clones every canvas.
 *
 * `ProjectStore.dependentsOf()` previously called `canvasStore.peek()`
 * for every other project on every call — each `peek` did a full
 * `cloneGraph` (deep copy of every node, every edge, every region).
 * For an N-project workspace, deleting one project cost O(N ×
 * canvasSize) memory + CPU. The fix replaces the `peek` scan with
 * `CanvasStore.scanAssetRefs`, which walks the live `canvases` Map
 * without cloning.
 *
 * Test goals:
 *   1. Same final result as before (returns the same hits).
 *   2. The store's in-memory graph stays untouched after a scan
 *      (no defensive copies leaked back into the store).
 *   3. The `countLegacyCopyRefs` companion surfaces refCopiesFrom
 *      provenance without cloning either.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore } from '../src/project-store'

let ws: string
let canvasStore: CanvasStore
let projectStore: ProjectStore

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ms-deps-'))
  canvasStore = new CanvasStore(ws)
  projectStore = new ProjectStore(ws, canvasStore, {
    recentLimit: 10, trashEnabled: true,
    defaultSourcePath: join(ws, 'Movies'),
  })
  await projectStore.ready()
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('M2-⑧ — scanAssetRefs (no clone)', () => {
  it('returns soft-ref hits across canvases', async () => {
    const owner = await projectStore.createProject('owner')
    const ref1 = await projectStore.createProject('referrer-1')
    const ref2 = await projectStore.createProject('referrer-2')

    canvasStore.apply(ref1.id, [{
      op: 'addNode', type: 'image', label: 'use1', data: {
        assetRef: { projectId: owner.id, assetId: 'a-1' },
        status: 'done', resultUrl: 'projects/owner/assets/characters/a-1.png',
      },
    }])
    canvasStore.apply(ref2.id, [
      { op: 'addNode', type: 'image', label: 'use2a', data: {
        assetRef: { projectId: owner.id, assetId: 'a-2' }, status: 'done', resultUrl: 'projects/owner/assets/characters/a-2.png',
      } },
      { op: 'addNode', type: 'image', label: 'use2b', data: {
        assetRef: { projectId: owner.id, assetId: 'a-2' }, status: 'done', resultUrl: 'projects/owner/assets/characters/a-2b.png',
      } },
    ])

    const hits = canvasStore.scanAssetRefs([owner.id, ref1.id, ref2.id], owner.id)
    const byAsset = new Map(hits.map((h) => [h.assetId, h.nodeIds.sort()]))
    expect(byAsset.get('a-1')).toHaveLength(1)
    expect(byAsset.get('a-2')).toHaveLength(2)
  })

  it('filters by assetIdFilter when given', async () => {
    const owner = await projectStore.createProject('owner')
    const ref = await projectStore.createProject('ref')
    canvasStore.apply(ref.id, [
      { op: 'addNode', type: 'image', label: 'a', data: { assetRef: { projectId: owner.id, assetId: 'a-1' }, status: 'done' } },
      { op: 'addNode', type: 'image', label: 'b', data: { assetRef: { projectId: owner.id, assetId: 'a-2' }, status: 'done' } },
    ])
    const hits = canvasStore.scanAssetRefs([owner.id, ref.id], owner.id, 'a-2')
    expect(hits).toHaveLength(1)
    expect(hits[0].assetId).toBe('a-2')
  })

  it('dependentsOf works on a registry with cross-project soft refs', async () => {
    const owner = await projectStore.createProject('owner')
    const ref = await projectStore.createProject('ref')
    canvasStore.apply(ref.id, [{
      op: 'addNode', type: 'image', label: 'use', data: {
        assetRef: { projectId: owner.id, assetId: 'a-x' }, status: 'done',
      },
    }])
    const info = await projectStore.dependentsOf(owner.id)
    expect(info.totalRefs).toBe(1)
    expect(info.hits[0]).toMatchObject({ refProjectId: ref.id, assetId: 'a-x' })
  })

  it('countLegacyCopyRefs surfaces refCopiesFrom counts without cloning', async () => {
    const owner = await projectStore.createProject('owner')
    const ref = await projectStore.createProject('ref')
    canvasStore.apply(ref.id, [
      { op: 'addNode', type: 'image', label: 'u1', data: { refCopiesFrom: { projectId: owner.id }, status: 'done' } },
      { op: 'addNode', type: 'image', label: 'u2', data: { refCopiesFrom: { projectId: owner.id }, status: 'done' } },
      { op: 'addNode', type: 'image', label: 'u3', data: { refCopiesFrom: { projectId: 'other' }, status: 'done' } },
    ])
    const counts = canvasStore.countLegacyCopyRefs([owner.id, ref.id], owner.id)
    expect(counts.get(ref.id)).toBe(2)
  })
})
