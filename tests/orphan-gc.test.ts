/**
 * P1-⑤ — orphan media GC.
 *
 * After M5-⑤'s stable filenames, repeated prepare* calls on the same
 * source URL overwrite the same file. But old random-id files written
 * before the upgrade (or files written by concurrent tools that don't
 * use the stable scheme yet) can still accumulate. `gcOrphanMedia`
 * scans every project asset directory, lists files matching the
 * stable prefixes (`v-`, `a-`, `img-`), removes those whose basename
 * is not referenced by any loaded canvas's `resultUrl` / `poster`.
 *
 * Test goals:
 *   1. Files that match a referenced basename are kept.
 *   2. Files that don't match any reference are removed.
 *   3. Stable files that match no reference (orphan from a stale
 *      generation) are removed even though they have the right prefix.
 *   4. Files outside the stable prefixes (regular user assets) are
 *      never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { gcOrphanMedia } from '../src/tools'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ms-orphan-'))
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('P1-⑤ — gcOrphanMedia', () => {
  it('keeps a stable-prefixed file whose basename is referenced', async () => {
    const src = join(ws, 'p1', 'assets', 'clips')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'v-keepit.mp4'), Buffer.from('keep'))
    const store = new CanvasStore(ws)
    store.apply('p1', [{
      op: 'addNode', type: 'video', label: 'clip', data: {
        resultUrl: `projects/p1/assets/clips/v-keepit.mp4`, status: 'done',
      },
    }])
    const out = await gcOrphanMedia(store, 'p1', join(ws, 'p1'))
    expect(out.scanned).toBe(1)
    expect(out.removed).toBe(0)
    const remaining = await readdir(src)
    expect(remaining).toContain('v-keepit.mp4')
  })

  it('removes an unreferenced stable-prefixed file', async () => {
    const src = join(ws, 'p1', 'assets', 'clips')
    await mkdir(src, { recursive: true })
    // Two stable-prefixed files on disk: one referenced by a canvas
    // node, one not. The GC should keep the referenced one and remove
    // the orphan.
    await writeFile(join(src, 'v-orphan.mp4'), Buffer.from('orphan'))
    await writeFile(join(src, 'v-keepit.mp4'), Buffer.from('keep'))
    const store = new CanvasStore(ws)
    store.apply('p1', [{
      op: 'addNode', type: 'video', label: 'keep', data: {
        resultUrl: 'projects/p1/assets/clips/v-keepit.mp4', status: 'done',
      },
    }])
    const out = await gcOrphanMedia(store, 'p1', join(ws, 'p1'))
    expect(out.scanned).toBe(2)
    expect(out.removed).toBe(1)
    const remaining = await readdir(src)
    expect(remaining).not.toContain('v-orphan.mp4')
    expect(remaining).toContain('v-keepit.mp4')
  })

  it('never touches user assets that lack the stable prefix', async () => {
    const src = join(ws, 'p1', 'assets', 'characters')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'user-uploaded.png'), Buffer.from('keep'))
    const store = new CanvasStore(ws)
    const out = await gcOrphanMedia(store, 'p1', join(ws, 'p1'))
    expect(out.scanned).toBe(0)
    expect(out.removed).toBe(0)
    const remaining = await readdir(src)
    expect(remaining).toContain('user-uploaded.png')
  })

  it('handles a missing assets directory without throwing', async () => {
    const store = new CanvasStore(ws)
    const out = await gcOrphanMedia(store, 'p1', join(ws, 'p1'))
    expect(out).toEqual({ removed: 0, scanned: 0 })
  })

  it('also considers poster references (video covers)', async () => {
    const src = join(ws, 'p1', 'assets', 'clips')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'v-x.mp4'), Buffer.from('mp4'))
    await writeFile(join(src, 'v-x.poster.jpg'), Buffer.from('jpg'))
    await writeFile(join(src, 'v-x.thumb.jpg'), Buffer.from('jpg'))
    await writeFile(join(src, 'v-stale.mp4'), Buffer.from('stale'))
    const store = new CanvasStore(ws)
    store.apply('p1', [{
      op: 'addNode', type: 'video', label: 'clip', data: {
        resultUrl: 'projects/p1/assets/clips/v-x.mp4',
        poster: 'projects/p1/assets/clips/v-x.poster.jpg',
        status: 'done',
      },
    }])
    const out = await gcOrphanMedia(store, 'p1', join(ws, 'p1'))
    expect(out.scanned).toBe(4) // v-x.mp4 + v-x.poster.jpg + v-x.thumb.jpg + v-stale.mp4
    // The canvas node references v-x.mp4 and v-x.poster.jpg, but NOT
    // v-x.thumb.jpg (the previous-generation thumbnail from before the
    // cover switch) or v-stale.mp4. Both are orphans and get removed.
    expect(out.removed).toBe(2) // v-stale.mp4 + v-x.thumb.jpg
    const remaining = await readdir(src)
    expect(remaining.sort()).toEqual(['v-x.mp4', 'v-x.poster.jpg'])
  })
})
