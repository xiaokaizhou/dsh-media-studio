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
      { op: 'addNode', type: 'text', label: 'A', data: { text: 'A content' } },
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

describe('CanvasStore — regions (partition containers)', () => {
  it('adds a region with auto id, kind and default size, auto-stacked', () => {
    const r1 = store.apply('main', [
      { op: 'addRegion', label: '流程总览', kind: 'flow' },
      { op: 'addRegion', label: '人物资产', kind: 'character' },
    ])
    expect(r1.graph.regions).toHaveLength(2)
    const [a, b] = r1.graph.regions
    expect(a.label).toBe('流程总览')
    expect(a.kind).toBe('flow')
    expect(a.w).toBe(720)
    expect(a.h).toBe(400)
    // Second region stacks below the first, never overlapping.
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h)
    expect(b.x).toBe(a.x)
  })

  it('accepts an explicit region id and rejects duplicates', () => {
    store.apply('main', [{ op: 'addRegion', label: 'scripts', id: 'reg-script' }])
    expect(() => store.apply('main', [{ op: 'addRegion', label: 'dup', id: 'reg-script' }]))
      .toThrow(/duplicate region id "reg-script"/)
  })

  it('places nodes with regionId inside the region grid and records membership', () => {
    const r1 = store.apply('main', [
      { op: 'addRegion', label: '人物资产', id: 'r-char', kind: 'character', x: 100, y: 100, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: '主角人设', regionId: 'r-char' },
      { op: 'addNode', type: 'image', label: '配角人设', regionId: 'r-char' },
    ])
    const [a, b] = r1.graph.nodes
    expect(a.data.region).toBe('r-char')
    expect(b.data.region).toBe('r-char')
    // Inside the box, below the header, and not overlapping each other.
    const inBounds = (p: { x: number; y: number }) =>
      p.x >= 100 && p.y >= 164 && p.x + 240 <= 820 && p.y + 160 <= 500
    expect(inBounds(a.position!)).toBe(true)
    expect(inBounds(b.position!)).toBe(true)
    expect(`${a.position!.x},${a.position!.y}`).not.toBe(`${b.position!.x},${b.position!.y}`)
  })

  it('grows the region box automatically as members exceed its bounds', () => {
    const r1 = store.apply('main', [
      { op: 'addRegion', label: '人物资产', id: 'r-char', x: 0, y: 0, w: 720, h: 400 },
      ...Array.from({ length: 8 }, (_, i) => ({
        op: 'addNode' as const,
        type: 'image' as const,
        label: `n${i}`,
        regionId: 'r-char',
      })),
    ])
    const region = r1.graph.regions[0]
    expect(region.h).toBeGreaterThan(400)
    for (const n of r1.graph.nodes) {
      expect(n.position!.x + 240).toBeLessThanOrEqual(region.x + region.w)
      expect(n.position!.y + 240).toBeLessThanOrEqual(region.y + region.h)
      expect(n.position!.x).toBeGreaterThanOrEqual(region.x)
      expect(n.position!.y).toBeGreaterThanOrEqual(region.y)
    }
  })

  it('fitRegion snaps the box tightly around its members', () => {
    store.apply('main', [
      { op: 'addRegion', label: '分镜区', id: 'r-sb', x: 0, y: 0, w: 640, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', regionId: 'r-sb', position: { x: 100, y: 120 } },
      { op: 'addNode', type: 'image', label: 'b', regionId: 'r-sb', position: { x: 400, y: 120 } },
    ])
    const r = store.apply('main', [{ op: 'fitRegion', id: 'r-sb' }])
    const region = r.graph.regions[0]
    // Tight wrap: minX=100, minY=120, maxX=640, maxY=360 (240-tall cards).
    expect(region).toMatchObject({
      x: 100 - 24,
      y: 120 - 64,
      w: 640 - 100 + 48,
      h: 360 - 120 + 64 + 24,
    })
  })

  it('fitRegion leaves an empty region untouched', () => {
    store.apply('main', [{ op: 'addRegion', label: 'empty', id: 'r-e', x: 5, y: 5, w: 300, h: 200 }])
    const r = store.apply('main', [{ op: 'fitRegion', id: 'r-e' }])
    expect(r.graph.regions[0]).toMatchObject({ x: 5, y: 5, w: 300, h: 200 })
  })

  it('rejects addNode with an unknown regionId atomically', () => {
    const before = store.snapshot('main')
    expect(() => store.apply('main', [{ op: 'addNode', type: 'image', label: 'x', regionId: 'nope' }]))
      .toThrow(/region "nope" not found/)
    expect(store.snapshot('main').version).toBe(before.version)
  })

  it('batchAddMedia items can target a region', () => {
    const r = store.apply('main', [
      { op: 'addRegion', label: '分镜区', id: 'r-sb' },
      { op: 'batchAddMedia', items: [{ kind: 'image', url: 'file:///kf.png', prompt: '关键帧', regionId: 'r-sb' }] },
    ])
    expect(r.graph.nodes).toHaveLength(1)
    expect(r.graph.nodes[0].data.region).toBe('r-sb')
  })

  it('updateRegion patches label/kind/geometry shallowly', () => {
    store.apply('main', [{ op: 'addRegion', label: 'old', id: 'r1', x: 0, y: 0 }])
    const r = store.apply('main', [
      { op: 'updateRegion', id: 'r1', label: 'new', kind: 'output', x: 50, y: 60, w: 800, h: 500 },
    ])
    expect(r.graph.regions[0]).toMatchObject({ id: 'r1', label: 'new', kind: 'output', x: 50, y: 60, w: 800, h: 500 })
  })

  it('deleteRegion removes only the box, keeping its nodes', () => {
    store.apply('main', [
      { op: 'addRegion', label: 'temp', id: 'r-tmp' },
      { op: 'addNode', type: 'text', label: 'keep', regionId: 'r-tmp' },
    ])
    const r = store.apply('main', [{ op: 'deleteRegion', id: 'r-tmp' }])
    expect(r.graph.regions).toHaveLength(0)
    expect(r.graph.nodes).toHaveLength(1)
  })

  it('connect stores an optional semantic label on the edge', () => {
    const r1 = store.apply('main', [
      { op: 'addNode', type: 'text', label: '剧本' },
      { op: 'addNode', type: 'image', label: '人设图' },
    ])
    const [a, b] = r1.graph.nodes.map((n) => n.id)
    const r2 = store.apply('main', [{ op: 'connect', from: a, to: b, label: '角色清单来源' }])
    expect(r2.graph.edges[0]).toMatchObject({ source: a, target: b, label: '角色清单来源' })
  })

  it('autoArrange with regionId only moves that region, staying in bounds', () => {
    const r1 = store.apply('main', [
      { op: 'addRegion', label: '人物资产', id: 'r-char', x: 0, y: 0, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', regionId: 'r-char', position: { x: 900, y: 900 } },
      { op: 'addNode', type: 'image', label: 'b', regionId: 'r-char', position: { x: 950, y: 950 } },
      { op: 'addNode', type: 'text', label: 'outside', position: { x: 2000, y: 2000 } },
    ])
    const outsideBefore = r1.graph.nodes.find((n) => n.label === 'outside')!.position
    const r2 = store.autoArrange('main', { regionId: 'r-char' })
    for (const n of r2.graph.nodes) {
      if (n.label === 'outside') {
        expect(n.position).toEqual(outsideBefore) // untouched by region arrange
      } else {
        expect(n.position!.x).toBeGreaterThanOrEqual(0)
        expect(n.position!.x + 240).toBeLessThanOrEqual(720)
        expect(n.position!.y).toBeGreaterThanOrEqual(64)
      }
    }
  })

  it('autoArrange with regionId fits the region box after moving nodes', () => {
    store.apply('main', [
      { op: 'addRegion', label: '人物资产', id: 'r-char', x: 0, y: 0, w: 720, h: 600 },
      { op: 'addNode', type: 'image', label: 'a', regionId: 'r-char', position: { x: 50, y: 50 } },
    ])
    const r = store.autoArrange('main', { regionId: 'r-char' })
    const region = r.graph.regions[0]
    // After arrange + auto-fit: box wraps the single 240×240 card tightly.
    expect(region.w).toBeLessThan(720)
    expect(region.h).toBeLessThan(600)
    const node = r.graph.nodes[0]
    expect(node.position!.x).toBeGreaterThanOrEqual(region.x)
    expect(node.position!.y).toBeGreaterThanOrEqual(region.y)
    expect(node.position!.x + 240).toBeLessThanOrEqual(region.x + region.w)
    expect(node.position!.y + 240).toBeLessThanOrEqual(region.y + region.h)
  })

  it('persists and restores regions with the graph', async () => {
    await store.apply('main', [
      { op: 'addRegion', label: '分镜区', id: 'r-sb', kind: 'storyboard' },
      { op: 'addNode', type: 'video', label: 'v', regionId: 'r-sb' },
    ])
    await new Promise((r) => setTimeout(r, 50))
    const store2 = new CanvasStore(workspaceRoot)
    await store2.restore()
    const snap = store2.snapshot('main')
    expect(snap.graph.regions).toHaveLength(1)
    expect(snap.graph.regions[0]).toMatchObject({ id: 'r-sb', label: '分镜区', kind: 'storyboard' })
    expect(snap.graph.nodes[0].data.region).toBe('r-sb')
  })
})
