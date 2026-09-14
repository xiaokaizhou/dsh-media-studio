/**
 * P1-⑥ — `pLimit` concurrency gate for prepareVideoForCanvas.
 *
 * The post-process pipeline can be called with N videos in a single
 * patch. Running them strictly in series makes a 6-video batch take
 * 6× the per-clip wall time; running all N in parallel can OOM or
 * flood the disk. `pLimit(n)` caps the in-flight count to `n` and
 * queues the rest. The helper lives in `src/tools.ts` and is also
 * exported for testability.
 */

import { describe, it, expect } from 'vitest'
import { pLimit } from '../src/tools'

describe('P1-⑥ — pLimit concurrency gate', () => {
  it('runs at most N tasks concurrently', async () => {
    const limit = pLimit(2)
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 8 }, () => limit(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((r) => setTimeout(r, 10))
      active -= 1
      return true
    }))
    await Promise.all(tasks)
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThanOrEqual(1)
  })

  it('serialises when limit = 1', async () => {
    const limit = pLimit(1)
    let peak = 0
    let active = 0
    const tasks = Array.from({ length: 4 }, () => limit(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((r) => setTimeout(r, 5))
      active -= 1
    }))
    await Promise.all(tasks)
    expect(peak).toBe(1)
  })

  it('propagates errors without stalling later tasks', async () => {
    const limit = pLimit(1)
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('boom') }),
      limit(async () => 'ok'),
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    if (results[1].status === 'fulfilled') expect(results[1].value).toBe('ok')
  })
})
