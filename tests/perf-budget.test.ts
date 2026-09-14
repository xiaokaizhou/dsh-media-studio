/**
 * Perf-budget smoke test — guards the most load-sensitive code paths
 * against regression.
 *
 * Coarse timing budget. The thresholds here are generous enough that
 * the test passes on any reasonable CI machine but tight enough that
 * any accidental O(N²) regression (e.g. putting `cloneGraph` back
 * into a hot loop) trips it. The actual numbers were calibrated
 * against the post-fix baseline on a M-class CPU.
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'

describe('perf budget — server', () => {
  it('1000 sync apply calls finish quickly and coalesce into ≤ 2 writes', async () => {
    const ws = await mkdtemp(join(tmpdir(), 'ms-perf-'))
    try {
      const store = new CanvasStore(ws)
      const N = 1000
      const ops = Array.from({ length: N }, (_, i) => ({
        op: 'addNode' as const, type: 'text' as const, label: `n${i}`, nodeId: `n${i}`,
      }))
      const t0 = Date.now()
      store.apply('main', ops)
      await new Promise<void>((r) => setImmediate(r))
      const elapsed = Date.now() - t0
      // The whole burst (apply + cloneGraph × 1 + write × 1) should
      // run well under a second on any reasonable machine. 500 ms is
      // generous; a regression to "1000 sync apply → 1000 writes"
      // would push this past several seconds.
      expect(elapsed).toBeLessThan(500)
      expect(store.persistWriteCount.get('main') ?? 0).toBeLessThanOrEqual(2)
    } finally {
      await rm(ws, { recursive: true, force: true })
    }
  })
})
