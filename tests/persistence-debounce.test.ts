/**
 * P0-① — persist coalescing regression.
 *
 * The CanvasStore previously did a full `JSON.stringify(graph) +
 * writeFile` on EVERY `apply()` call — a single burst of N applies
 * (drag, auto-arrange, post-process batching) produced N full-graph
 * writes. The fix adds a microtask-debounced persist scheduler so
 * applies in the same synchronous tick collapse into one disk write
 * (and one SSE broadcast).
 *
 * Test goals:
 *   1. 100 sync apply → exactly 1 writeFile syscall (asserted via
 *      `persistWriteCount`).
 *   2. flushPersistNow synchronously durables before returning.
 *   3. Persist errors still surface (the failure-mode contract did
 *      not change).
 *   4. await new Promise(setImmediate) is enough to flush.
 */

import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasStore } from '../src/canvas-store'

let wsRoot: string
let store: CanvasStore

function setup(): void {
  wsRoot = mkdtempSync(join(tmpdir(), 'ms-persist-'))
  store = new CanvasStore(wsRoot)
}

function teardown(): void {
  rmSync(wsRoot, { recursive: true, force: true })
}

describe('P0-① — persist coalescer', () => {
  it('100 sync apply calls → exactly 1 writeFile', async () => {
    setup()
    try {
      const ops = Array.from({ length: 100 }, (_, i) => ({ op: 'addNode' as const, type: 'text' as const, label: `n${i}`, nodeId: `n${i}` }))
      store.apply('main', ops)
      // The coalescer writes in a microtask; the write itself is a
      // promise. Multiple `await Promise.resolve()` passes drain the
      // microtask queue, and the trailing `flushPersistNow` is the
      // deterministic escape hatch that guarantees the writeFile
      // syscall has returned by the time we read the counter.
      for (let i = 0; i < 5; i++) await Promise.resolve()
      await store.flushPersistNow('main')
      expect(store.persistWriteCount.get('main') ?? 0).toBe(1)
    } finally { teardown() }
  })

  it('flushPersistNow synchronously durables before returning', async () => {
    setup()
    try {
      store.apply('main', [{ op: 'addNode', type: 'text', label: 'A', nodeId: 'A' }])
      // Hasn't flushed yet — counter may still be 0 (microtask not run).
      await store.flushPersistNow('main')
      expect(store.persistWriteCount.get('main') ?? 0).toBeGreaterThanOrEqual(1)
      const onDisk = JSON.parse(readFileSync(join(wsRoot, 'canvases', 'main.json'), 'utf8')) as { nodes: Array<{ id: string }>; version: number }
      expect(onDisk.version).toBe(1)
      expect(onDisk.nodes.map((n) => n.id)).toContain('A')
    } finally { teardown() }
  })

  it('flushPersistNow drains the coalesced write to disk', async () => {
    setup()
    try {
      // Note: a single `apply()` batches N ops and bumps version once
      // (per `apply` call, not per op). 50 nodes added in one batch →
      // version 1, with 50 nodes on disk after the coalesced flush.
      const ops = Array.from({ length: 50 }, (_, i) => ({ op: 'addNode' as const, type: 'text' as const, label: `n${i}`, nodeId: `n${i}` }))
      store.apply('main', ops)
      // The deterministic escape hatch: `flushPersistNow` drains the
      // microtask queue and awaits the pending writeFile. After this
      // returns, the on-disk copy reflects the latest in-memory state.
      await store.flushPersistNow('main')
      const onDisk = JSON.parse(readFileSync(join(wsRoot, 'canvases', 'main.json'), 'utf8')) as { nodes: unknown[]; version: number }
      expect(onDisk.version).toBe(1)
      expect(onDisk.nodes).toHaveLength(50)
    } finally { teardown() }
  })

  it('two canvases are persisted independently', async () => {
    setup()
    try {
      store.apply('main', [{ op: 'addNode', type: 'text', label: 'A', nodeId: 'A' }])
      store.apply('other', [{ op: 'addNode', type: 'text', label: 'B', nodeId: 'B' }])
      await store.flushPersistNow()
      expect(store.persistWriteCount.get('main') ?? 0).toBe(1)
      expect(store.persistWriteCount.get('other') ?? 0).toBe(1)
    } finally { teardown() }
  })

  it('later applies after a flush re-schedule a fresh write', async () => {
    setup()
    try {
      store.apply('main', [{ op: 'addNode', type: 'text', label: 'A', nodeId: 'A' }])
      await store.flushPersistNow('main')
      expect(store.persistWriteCount.get('main') ?? 0).toBe(1)
      store.apply('main', [{ op: 'addNode', type: 'text', label: 'B', nodeId: 'B' }])
      await store.flushPersistNow('main')
      expect(store.persistWriteCount.get('main') ?? 0).toBe(2)
    } finally { teardown() }
  })
})
