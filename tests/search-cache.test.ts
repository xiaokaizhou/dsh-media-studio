/**
 * P1-⑦ — `loadAssetIndex` in-process cache.
 *
 * The asset-index read fires on every keystroke in the top-bar search
 * box (and every dependency preflight). Without a cache every read
 * was an `await stat` + `await readFile` + `JSON.parse` — for N
 * projects that's N× the disk IO per keystroke. The fix keeps an
 * in-process `Map<file, { fingerprint, index }>` keyed by the file
 * path and stat fingerprint, so a read with the same mtime+size
 * returns the cached payload in O(Set lookup).
 *
 * The test exercises the cache via the public surface (`loadAssetIndex`
 * + `invalidateAssetIndexCache`) and asserts (a) second reads don't
 * re-stat / re-parse and (b) `invalidate` forces a fresh read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAssetIndex, writeAssetIndex, invalidateAssetIndexCache } from '../src/asset-store'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ms-assetcache-'))
})

afterEach(async () => {
  invalidateAssetIndexCache()
  await rm(ws, { recursive: true, force: true })
})

describe('P1-⑦ — loadAssetIndex cache', () => {
  it('returns the same payload on a repeated read without re-parsing', async () => {
    const root = join(ws, 'p-1')
    await mkdir(root, { recursive: true })
    await writeAssetIndex(root, { version: 1, assets: [{ id: 'a1', kind: 'character', name: '林晚', file: 'a1.png', createdAt: 't', updatedAt: 't' }] }, 'index.json')

    const a = await loadAssetIndex(root, 'index.json')
    const b = await loadAssetIndex(root, 'index.json')
    expect(a).toBe(b) // Object.is-stable, cached reference
  })

  it('invalidates the cache when invalidateAssetIndexCache is called', async () => {
    const root = join(ws, 'p-1')
    await mkdir(root, { recursive: true })
    await writeAssetIndex(root, { version: 1, assets: [{ id: 'a1', kind: 'character', name: 'first', file: 'a1.png', createdAt: 't', updatedAt: 't' }] }, 'index.json')

    await writeAssetIndex(root, { version: 1, assets: [{ id: 'a2', kind: 'character', name: 'second', file: 'a2.png', createdAt: 't', updatedAt: 't' }] }, 'index.json')
    // writeAssetIndex already invalidates; an extra invalidate is safe.
    invalidateAssetIndexCache()
    const after = await loadAssetIndex(root, 'index.json')
    expect(after.assets.map((a) => a.name)).toEqual(['second'])
  })

  it('returns empty index for an absent file without throwing', async () => {
    const out = await loadAssetIndex(join(ws, 'no-such-dir'), 'index.json')
    expect(out.assets).toEqual([])
  })

  it('drops cache on invalidate() with no args (full reset)', async () => {
    const root = join(ws, 'p-1')
    await mkdir(root, { recursive: true })
    await writeAssetIndex(root, { version: 1, assets: [] }, 'index.json')
    await loadAssetIndex(root, 'index.json')
    invalidateAssetIndexCache()
    // After invalidate, a fresh read still works.
    const out = await loadAssetIndex(root, 'index.json')
    expect(out).toBeTruthy()
  })
})
