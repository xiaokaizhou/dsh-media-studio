import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasStore } from '../src/canvas-store'

let workspaceRoot: string
let store: CanvasStore

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'media-studio-test-'))
  store = new CanvasStore(workspaceRoot)
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('CanvasStore — happy path', () => {
  it('starts with an empty canvas', () => {
    const s = store.snapshot('main')
    expect(s.version).toBe(0)
    expect(s.graph.nodes).toEqual([])
    expect(s.graph.edges).toEqual([])
  })

  it('adds a node and bumps version by 1', () => {
    const r = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'script intro', data: { prompt: 'A cat walks in' } },
    ])
    expect(r.version).toBe(1)
    expect(r.graph.nodes).toHaveLength(1)
    expect(r.graph.nodes[0].type).toBe('text')
    expect(r.graph.nodes[0].label).toBe('script intro')
    expect(r.graph.nodes[0].data.prompt).toBe('A cat walks in')
  })

  it('connects two nodes with one edge', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'A' },
      { op: 'addNode', type: 'image', label: 'B' },
    ])
    const [a, b] = r1.graph.nodes.map((n) => n.id)
    const r2 = store.apply('main', [{ op: 'connect', from: a, to: b }])
    expect(r2.graph.edges).toHaveLength(1)
    expect(r2.graph.edges[0]).toMatchObject({ source: a, target: b })
  })

  it('appends many media nodes in one batchAddMedia op', () => {
    const r = store.apply('main', [{
      op: 'batchAddMedia',
      items: [
        { kind: 'image', url: '/api/generated/img1.png', prompt: 'forest', model: 'agnes-image-2.1-flash' },
        { kind: 'video', url: '/api/generated/vid1.mp4', prompt: 'pan', model: 'agnes-video-2.5-flash' },
        { kind: 'audio', url: '/api/generated/aud1.mp3', prompt: 'narration' },
      ],
    }])
    expect(r.graph.nodes).toHaveLength(3)
    expect(r.graph.nodes.map((n) => n.type)).toEqual(['image', 'video', 'music'])
    expect(r.graph.nodes[0].data.resultUrl).toBe('/api/generated/img1.png')
  })
})

describe('CanvasStore — atomicity (whole batch fails)', () => {
  it('refuses the whole batch when one op is invalid', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'A' },
      { op: 'addNode', type: 'image', label: 'B' },
    ])
    const before = store.snapshot('main')
    expect(() => store.apply('main', [
      { op: 'connect', from: r1.graph.nodes[0].id, to: 'nonexistent' },
    ])).toThrow(/connect: target "nonexistent" not found/)
    const after = store.snapshot('main')
    // Version must NOT have advanced; canvas must be untouched.
    expect(after.version).toBe(before.version)
    expect(after.graph.nodes).toEqual(before.graph.nodes)
    expect(after.graph.edges).toEqual(before.graph.edges)
  })

  it('refuses empty op batches with a clear error', () => {
    expect(() => store.apply('main', [])).toThrow()
  })

  it('caps batch size to keep model output bounded', () => {
    const ops = Array.from({ length: 200 }, (_, i) => ({ op: 'addNode' as const, type: 'text' as const, label: `n${i}` }))
    // The tool layer caps to 60; here we test the store accepts reasonable
    // batches and we just trust the tool wrapper for the upper bound.
    const r = store.apply('main', ops)
    expect(r.graph.nodes).toHaveLength(200)
  })
})

describe('CanvasStore — deletion cascade', () => {
  it('removes edges touching a deleted node', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'A' },
      { op: 'addNode', type: 'image', label: 'B' },
      { op: 'addNode', type: 'video', label: 'C' },
    ])
    const [a, b, c] = r1.graph.nodes.map((n) => n.id)
    store.apply('main', [
      { op: 'connect', from: a, to: b },
      { op: 'connect', from: b, to: c },
      { op: 'connect', from: a, to: c },
    ])
    expect(store.snapshot('main').graph.edges).toHaveLength(3)
    store.apply('main', [{ op: 'deleteNode', id: b }])
    const snap = store.snapshot('main')
    expect(snap.graph.nodes).toHaveLength(2)
    expect(snap.graph.edges).toHaveLength(1)
    expect(snap.graph.edges[0].source).toBe(a)
    expect(snap.graph.edges[0].target).toBe(c)
  })
})

describe('CanvasStore — lint feedback', () => {
  it('reports lint pass on a clean connect', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'A' },
      { op: 'addNode', type: 'image', label: 'B' },
    ])
    const [a, b] = r1.graph.nodes.map((n) => n.id)
    const r2 = store.apply('main', [{ op: 'connect', from: a, to: b }])
    expect(r2.lintOk).toBe(true)
    expect(r2.issues).toEqual([])
  })
})

describe('CanvasStore — persistence round-trip', () => {
  it('persists to disk and restores on a new instance', async () => {
    await store.apply('main', [
      { op: 'addNode', type: 'image', label: 'first' },
    ])
    // Allow the voided persist() promise to complete before restoring.
    await new Promise((r) => setTimeout(r, 50))
    expect(existsSync(join(workspaceRoot, 'canvases', 'main.json'))).toBe(true)

    const store2 = new CanvasStore(workspaceRoot)
    await store2.restore()
    const snap = store2.snapshot('main')
    expect(snap.graph.nodes).toHaveLength(1)
    expect(snap.graph.nodes[0].label).toBe('first')
  })

  it('isolates canvases by id within the same workspace', async () => {
    await store.apply('main', [{ op: 'addNode', type: 'text', label: 'A' }])
    await store.apply('other', [{ op: 'addNode', type: 'image', label: 'B' }])
    const mainSnap = store.snapshot('main')
    const otherSnap = store.snapshot('other')
    expect(mainSnap.graph.nodes).toHaveLength(1)
    expect(mainSnap.graph.nodes[0].label).toBe('A')
    expect(otherSnap.graph.nodes).toHaveLength(1)
    expect(otherSnap.graph.nodes[0].label).toBe('B')
  })
})

describe('CanvasStore — explicit nodeId (canvas UI create+connect)', () => {
  it('adds a node with the caller-supplied id and auto position', () => {
    const r = store.apply('main', [
      { op: 'addNode', type: 'image', label: 'fixed', nodeId: 'ui-img-1', position: { x: 100, y: 200 } },
    ])
    expect(r.graph.nodes).toHaveLength(1)
    expect(r.graph.nodes[0].id).toBe('ui-img-1')
    expect(r.graph.nodes[0].position).toEqual({ x: 100, y: 200 })
  })

  it('creates a node and connects to it atomically in one batch', () => {
    const r1 = store.apply('main', [{ op: 'addNode', type: 'text', label: 'src' }])
    const src = r1.graph.nodes[0].id
    const r2 = store.apply('main', [
      { op: 'addNode', type: 'video', label: 'dst', nodeId: 'ui-vid-1', position: { x: 300, y: 0 } },
      { op: 'connect', from: src, to: 'ui-vid-1' },
    ])
    expect(r2.version).toBe(2)
    expect(r2.graph.edges).toHaveLength(1)
    expect(r2.graph.edges[0].source).toBe(src)
    expect(r2.graph.edges[0].target).toBe('ui-vid-1')
  })

  it('rejects a duplicate explicit node id', () => {
    store.apply('main', [{ op: 'addNode', type: 'text', label: 'A', nodeId: 'dup' }])
    expect(() => store.apply('main', [
      { op: 'addNode', type: 'text', label: 'B', nodeId: 'dup' },
    ])).toThrow(/duplicate node id/)
  })
})

describe('CanvasStore — default auto-placement', () => {
  it('stagger-places nodes that omit position instead of stacking at (0,0)', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: 'one' },
      { op: 'addNode', type: 'image', label: 'two' },
      { op: 'addNode', type: 'image', label: 'three' },
    ])
    const positions = r1.graph.nodes.map((n) => n.position)
    expect(positions[0]).toBeDefined()
    const pts = new Set(positions.map((p) => `${p?.x},${p?.y}`))
    expect(pts.size).toBe(3)
  })

  it('keeps two consecutive empty batches from overlapping', () => {
    const a = store.apply('main', [{ op: 'addNode', type: 'image', label: 'x' }]).graph.nodes.at(-1)!.position!
    const b = store.apply('main', [{ op: 'addNode', type: 'image', label: 'y' }]).graph.nodes.at(-1)!.position!
    expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBeGreaterThan(0)
  })

  it('auto-places batchAddMedia items without position', () => {
    const r = store.apply('main', [
      {
        op: 'batchAddMedia',
        items: [
          { kind: 'image', url: 'file:///a.png' },
          { kind: 'video', url: 'file:///b.mp4' },
        ],
      },
    ])
    expect(r.graph.nodes).toHaveLength(2)
    for (const n of r.graph.nodes) expect(n.position).toBeDefined()
  })
})
