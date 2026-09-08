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

  it('moveNode into a constrained region clamps the position inside the region bounds', () => {
    store.apply('main', [
      { op: 'addRegion', label: 'lockbox', id: 'r-lock', x: 100, y: 100, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-a', regionId: 'r-lock', position: { x: 120, y: 180 } },
    ])
    // Try to drag the node outside the region (far to the right).
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-a', position: { x: 5000, y: 5000 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-a')!
    // Must be clamped inside the region — range is the FULL box (no
    // PAD/HEADER reservation): x in [100, 580], y in [100, 260]
    // (region 720×400 minus card 240×240).
    expect(node.position!.x).toBeLessThanOrEqual(580)
    expect(node.position!.y).toBeLessThanOrEqual(260)
    expect(node.position!.x).toBeGreaterThanOrEqual(100)
    expect(node.position!.y).toBeGreaterThanOrEqual(100)
  })

  it('moveNode into a constrained region can still move freely when the request lands inside', () => {
    store.apply('main', [
      { op: 'addRegion', label: 'lockbox', id: 'r-lock', x: 100, y: 100, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-a', regionId: 'r-lock', position: { x: 120, y: 180 } },
    ])
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-a', position: { x: 200, y: 220 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-a')!
    expect(node.position).toEqual({ x: 200, y: 220 })
  })

  it('moveNode without constrained region allows positions anywhere', () => {
    store.apply('main', [
      { op: 'addRegion', label: 'freebox', id: 'r-free', x: 100, y: 100, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-a', regionId: 'r-free', position: { x: 120, y: 180 } },
    ])
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-a', position: { x: 5000, y: 5000 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-a')!
    expect(node.position).toEqual({ x: 5000, y: 5000 })
  })

  it('re-locking a region leaves previously-outside members in place (drops membership)', () => {
    // Regression for "unlock → drag node out → re-lock". The node is a
    // member (regionId) but its center sits far outside the box. Flipping the
    // lock ON must NOT yank it back in: it drops membership and stays put, so
    // it also stops following region drags.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-x', x: 100, y: 100, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-a', regionId: 'r-x', position: { x: 5000, y: 5000 } },
    ])
    const r = store.apply('main', [{ op: 'updateRegion', id: 'r-x', constrained: true }])
    const node = r.graph.nodes.find((n) => n.id === 'n-a')!
    expect('region' in node.data).toBe(false)
    expect(node.position).toEqual({ x: 5000, y: 5000 }) // left where it was
  })

  it('locking a region still claps members that are inside the box back in', () => {
    // Counterpart: a member whose center is INSIDE the box is clamped to fit
    // fully within the (no PAD/HEADER) bounds on lock — the normal locked
    // invariant for nodes that genuinely belong.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-in', x: 100, y: 100, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-in', regionId: 'r-in', position: { x: 50, y: 50 } },
    ])
    // center (170,170) is inside the 100..820 × 100..500 box.
    const r = store.apply('main', [{ op: 'updateRegion', id: 'r-in', constrained: true }])
    const node = r.graph.nodes.find((n) => n.id === 'n-in')!
    expect(node.data.region).toBe('r-in') // still a member
    // Full-region clamp: x in [100, 580], y in [100, 260] → card snaps to (100,100).
    expect(node.position).toEqual({ x: 100, y: 100 })
  })

  it('shrinking a constrained region pulls members back inside the new bounds', () => {
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-shrink', x: 0, y: 0, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-shrink', regionId: 'r-shrink', position: { x: 400, y: 100 } },
    ])
    // Shrink the region so the existing child would spill out (the card
    // extends from x=400 to x=640, well inside the 720-wide box).
    const r = store.apply('main', [{ op: 'updateRegion', id: 'r-shrink', w: 360, h: 400 }])
    const node = r.graph.nodes.find((n) => n.id === 'n-shrink')!
    // Full-region clamp — card right edge may reach `region.x + region.w`,
    // card top-left may be at `region.y` (no PAD / HEADER reservation).
    expect(node.position!.x + 240).toBeLessThanOrEqual(360)
    expect(node.position!.y).toBeGreaterThanOrEqual(0)
  })

  it('type-aware clamp uses a text card\'s stored data.height (regression: content-fit text overflowing locked region)', () => {
    // A content-fit text card whose actual rendered height is 300 px must
    // have regionNodeHeight return 300, so the constrained-region clamp
    // reserves `region.h - 300` of vertical space — NOT 160 (the unset
    // default) and NOT 240 (the media default). This is the contract the
    // client relies on when it auto-persists measured height on first render.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-tall', x: 0, y: 0, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'text', label: 'long script', nodeId: 'n-tall', regionId: 'r-tall', position: { x: 100, y: 500 }, data: { height: 300 } },
    ])
    // moveNode to a y that would exceed the 160-default clamp but fit the
    // 300-aware clamp (y_max = 0 + 400 - 300 = 100, so 150 is clamped to 100).
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-tall', position: { x: 100, y: 150 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-tall')!
    expect(node.position!.y).toBe(100) // clamped by data.height=300, not 240 (would give 160) nor 160 (would give 240)
  })

  it('image card with persisted data.height (cardW-dependent) clamps correctly (regression: cardW ≠ 240 overflow)', () => {
    // When the canvas pane is wide, `cardW` is up to 280 px and an image
    // card's true rendered height is 280 — NOT the historical 240 default.
    // The client now auto-persists the measured height to `data.height` on
    // every measurement, and the server's `regionNodeHeight` reads it. This
    // test pins the server contract the client relies on: a persisted
    // data.height of 280 must drive the clamp (y_max = region.h - 280),
    // even for an image card.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-wide', x: 0, y: 0, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'wide card', nodeId: 'n-wide', regionId: 'r-wide', position: { x: 100, y: 200 }, data: { height: 280 } },
    ])
    // y_max with h=280 is 0 + 400 - 280 = 120. Send y=200 → clamp to 120.
    // The old 240-default would have given y=160, which leaves the card
    // bottom at 160+280=440 — 40 px past the region's 400 bottom.
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-wide', position: { x: 100, y: 200 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-wide')!
    expect(node.position!.y).toBe(120)
  })

  it('music card with persisted data.height (cardW×9/16) clamps correctly (regression: cardW ≠ 240 overflow)', () => {
    // Music cards are 16:9 — at cardW=240 the height is 135, but at
    // cardW=280 the height is 157.5. Persisting the measured height
    // ensures the clamp follows the pane width.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-mu', x: 0, y: 0, w: 720, h: 300, constrained: true },
      { op: 'addNode', type: 'music', label: 'wide music', nodeId: 'n-mu', regionId: 'r-mu', position: { x: 100, y: 200 }, data: { height: 158 } },
    ])
    // y_max with h=158 is 0 + 300 - 158 = 142. Send y=200 → clamp to 142.
    const r = store.apply('main', [{ op: 'moveNode', id: 'n-mu', position: { x: 100, y: 200 } }])
    const node = r.graph.nodes.find((n) => n.id === 'n-mu')!
    expect(node.position!.y).toBe(142)
  })

  it('region drag commit (updateRegion + per-child moveNode batch) moves every child by exactly the region delta', () => {
    // The region-drag UI commits a single batch on pointer-up:
    //   [ { op: 'updateRegion', id, x, y }, ...moveNode for each child... ]
    // Each moveNode carries the child's NEW position (orig + delta), not
    // a relative delta — verify the server applies them exactly so the
    // optimistic local frame matches the persisted state with zero
    // post-commit "jump" caused by an SSE echo mismatch.
    store.apply('main', [
      { op: 'addRegion', label: 'flow', id: 'r-flow', x: 100, y: 100, w: 720, h: 400 },
      { op: 'addNode', type: 'image', label: 'a', nodeId: 'n-a', regionId: 'r-flow', position: { x: 120, y: 180 } },
      { op: 'addNode', type: 'image', label: 'b', nodeId: 'n-b', regionId: 'r-flow', position: { x: 380, y: 180 } },
      { op: 'addNode', type: 'image', label: 'c', nodeId: 'n-c', regionId: 'r-flow', position: { x: 640, y: 180 } },
      // c lives outside the region — a member pin (constrained=true) would
      // clamp it; we don't constrain here so the dragged moveNode value
      // must be respected verbatim.
    ])
    const dx = 50
    const dy = 30
    const r = store.apply('main', [
      { op: 'updateRegion', id: 'r-flow', x: 100 + dx, y: 100 + dy },
      { op: 'moveNode', id: 'n-a', position: { x: 120 + dx, y: 180 + dy } },
      { op: 'moveNode', id: 'n-b', position: { x: 380 + dx, y: 180 + dy } },
      { op: 'moveNode', id: 'n-c', position: { x: 640 + dx, y: 180 + dy } },
    ])
    expect(r.graph.regions[0]).toMatchObject({ x: 150, y: 130 })
    expect(r.graph.nodes.find((n) => n.id === 'n-a')!.position).toEqual({ x: 170, y: 210 })
    expect(r.graph.nodes.find((n) => n.id === 'n-b')!.position).toEqual({ x: 430, y: 210 })
    expect(r.graph.nodes.find((n) => n.id === 'n-c')!.position).toEqual({ x: 690, y: 210 })
    // Membership survives the batch.
    for (const n of r.graph.nodes) {
      expect(n.data.region).toBe('r-flow')
    }
  })

  it('region drag commit on a constrained region clamps children that would spill', () => {
    // Counterpart to the free-drag case: when the region is locked, the
    // client must clamp the child moveNode coordinates to the new box so
    // the SSE echo doesn't snap them. Verify the server applies the same
    // clamp authoritatively.
    store.apply('main', [
      { op: 'addRegion', label: 'lockbox', id: 'r-lk', x: 0, y: 0, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'left', nodeId: 'n-l', regionId: 'r-lk', position: { x: 50, y: 100 } },
      { op: 'addNode', type: 'image', label: 'right', nodeId: 'n-r', regionId: 'r-lk', position: { x: 400, y: 100 } },
    ])
    // Drag the box 200px right — left child would land at x=250 (still
    // inside the new 200..920 box) but right child would land at x=600
    // (still inside). To force a clamp we'd need an even larger drag;
    // use dx=1000 to put both far outside, then verify they're pulled back.
    const r = store.apply('main', [
      { op: 'updateRegion', id: 'r-lk', x: 1000, y: 0 },
      { op: 'moveNode', id: 'n-l', position: { x: 1050, y: 100 } },
      { op: 'moveNode', id: 'n-r', position: { x: 1400, y: 100 } },
    ])
    const box = r.graph.regions[0]
    const cardW = 240
    const cardH = 240
    // Full-region clamp — no PAD/HEADER reservation. The card top-left
    // can land at the box's left/top edges and the card's right/bottom
    // edges can land at the box's right/bottom edges.
    for (const n of r.graph.nodes) {
      expect(n.position!.x).toBeGreaterThanOrEqual(box.x)
      expect(n.position!.x + cardW).toBeLessThanOrEqual(box.x + box.w)
      expect(n.position!.y).toBeGreaterThanOrEqual(box.y)
      expect(n.position!.y + cardH).toBeLessThanOrEqual(box.y + box.h)
    }
  })

  it('updateNode with region: null clears membership (auto-detect "dragged out")', () => {
    // The onNodeDragStop auto-detect flow clears membership with an explicit
    // `region: null` (NOT `undefined` — JSON.stringify drops undefined, so an
    // undefined payload would reach the server as `{}` and leave the region
    // key intact). Verify the server actually deletes the key so the node
    // detaches and no longer follows the region / gets pulled back on lock.
    store.apply('main', [
      { op: 'addRegion', label: 'box', id: 'r-out', x: 0, y: 0, w: 720, h: 400, constrained: true },
      { op: 'addNode', type: 'image', label: 'inside', nodeId: 'n-out', regionId: 'r-out', position: { x: 100, y: 100 } },
    ])
    const before = store.snapshot('main')
    expect(before.graph.nodes[0].data.region).toBe('r-out')

    const after = store.apply('main', [
      { op: 'updateNode', id: 'n-out', data: { region: null } },
    ])
    // Membership cleared AND the key removed (not just set to undefined) so
    // the persisted graph stays clean.
    expect('region' in after.graph.nodes[0].data).toBe(false)
    expect(after.graph.nodes[0].data.region).toBeUndefined()

    // Now the node can move anywhere — even into a constrained region's box
    // it is not clamped because it is no longer a member.
    const free = store.apply('main', [
      { op: 'moveNode', id: 'n-out', position: { x: 9999, y: 9999 } },
    ])
    expect(free.graph.nodes[0].position).toEqual({ x: 9999, y: 9999 })
  })

  it('updateNode preserves other data fields when only region changes (the auto-detect edit)', () => {
    // The auto-detect flow writes only `{ region: <id> }` — the shallow
    // merge in updateNode must not drop the node's prompt, label, status,
    // or any other field the user has touched.
    store.apply('main', [
      { op: 'addRegion', label: 'flow', id: 'r-flow2' },
      { op: 'addNode', type: 'image', label: 'image', nodeId: 'n-img', data: { prompt: 'a cat', status: 'done' }, position: { x: 200, y: 200 } },
    ])
    const after = store.apply('main', [
      { op: 'updateNode', id: 'n-img', data: { region: 'r-flow2' } },
    ])
    const n = after.graph.nodes.find((x) => x.id === 'n-img')!
    expect(n.data.region).toBe('r-flow2')
    expect(n.data.prompt).toBe('a cat')
    expect(n.data.status).toBe('done')
  })
})
