/**
 * P1-⑨ — `openProject` must only re-read the target project's
 * canvas from disk, not every project's canvas.
 *
 * The original `openProject` called `canvasStore.restore(allSourcePaths())`
 * which did a `readdir` + `readFile` over every project's `.canvas.json`.
 * With N projects that turns one open into N reads. The fix replaces
 * the full-restore with `CanvasStore.restoreOne(canvasId, sourcePath)`,
 * a targeted single-file read that's also version-guarded so an open
 * after boot typically performs no I/O at all.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'

let ws: string

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ms-restore-one-'))
})

afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('P1-⑨ — restoreOne', () => {
  it('restores a single canvas without touching other files', async () => {
    // Set up three projects, only the target has a canvas.json on disk.
    const dirs: Record<string, string> = {}
    for (const id of ['p-a', 'p-b', 'p-c']) {
      const dir = join(ws, 'projects', id)
      await mkdir(dir, { recursive: true })
      dirs[id] = dir
      await writeFile(join(dir, '.canvas.json'), JSON.stringify({
        version: 1,
        nodes: [{ id: 'n-' + id, type: 'text', label: id, data: { text: id } }],
        edges: [],
        regions: [],
      }, null, 2), 'utf8')
    }

    const store = new CanvasStore(ws)
    // Pre-populate in-memory state to a stale value to prove the restore
    // overwrites it.
    store.apply('p-a', [{ op: 'addNode', type: 'text', label: 'stale', data: { text: 'stale' } }])

    await store.restoreOne('p-b', dirs['p-b'])

    const a = store.snapshot('p-a')
    expect(a.graph.nodes).toHaveLength(1)
    expect(a.graph.nodes[0].label).toBe('stale') // untouched
    const b = store.snapshot('p-b')
    expect(b.graph.nodes).toHaveLength(1)
    expect(b.graph.nodes[0].label).toBe('p-b') // restored
    const c = store.snapshot('p-c')
    expect(c.graph.nodes).toEqual([]) // not restored (still empty in-memory)
  })

  it('no-op when in-memory version is already newer than disk', async () => {
    const dir = join(ws, 'p-d')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.canvas.json'), JSON.stringify({
      version: 1, nodes: [{ id: 'x', type: 'text', label: 'old', data: { text: 'old' } }], edges: [], regions: [],
    }, null, 2), 'utf8')

    const store = new CanvasStore(ws)
    store.apply('p-d', [{ op: 'addNode', type: 'text', label: 'new', data: { text: 'new' } }])
    const snap = store.snapshot('p-d')
    const inMemVersion = snap.version // 1

    await store.restoreOne('p-d', dir)
    const after = store.snapshot('p-d')
    // In-memory state is newer (or equal) → restore is a no-op.
    expect(after.version).toBe(inMemVersion)
    expect(after.graph.nodes[0].label).toBe('new')
  })

  it('tolerates a missing canvas file (no throw)', async () => {
    const dir = join(ws, 'p-e')
    await mkdir(dir, { recursive: true })
    // no .canvas.json
    const store = new CanvasStore(ws)
    await store.restoreOne('p-e', dir) // should not throw
    expect(store.snapshot('p-e').graph.nodes).toEqual([])
  })
})
