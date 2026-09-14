/**
 * P0-② — `postProcessCanvasPatch` must batch its updateNode ops.
 *
 * Previously each successful `prepareVideoForCanvas` (step 1.5) and each
 * video poster backfill (step 1.6) issued its own single-op
 * `store.apply`, which fired N clones / N broadcasts / N writes for
 * an N-video patch. The fix collects every successful update into a
 * single trailing `apply()` call.
 *
 * The test installs a stub for `prepareVideoForCanvas` via `vi.mock`
 * so the post-process path runs without touching ffmpeg or the network.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { setMediaStudioHandles } from '../src/service-state'

// Hoist the mock so it intercepts the tools module's top-level
// `import { prepareVideoForCanvas } from './video-cover'`. vi.mock is
// hoisted by Vitest before any user import.
vi.mock('../src/video-cover', async () => {
  const real = await vi.importActual<typeof import('../src/video-cover')>('../src/video-cover')
  return {
    ...real,
    prepareVideoForCanvas: vi.fn(async (url: string) => ({ url: `file-stub:${url}`, poster: null })),
  }
})

let ws: string
let store: CanvasStore
let applyCalls: number

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'ms-batch-'))
  store = new CanvasStore(ws)
  // postProcessCanvasPatch uses the project store only to resolve the
  // canvasId → projectId mapping. Stub the minimum needed surface so
  // the post-process pipeline runs end-to-end without a real registry.
  const stubProjectStore = {
    snapshot: () => ({ activeId: null, recent: [], projects: [{ id: 'canvas-1', name: 'c', createdAt: 't', updatedAt: 't', lastOpenedAt: 't' }] }),
    activeCanvasId: () => 'canvas-1',
    resolveSourcePath: () => undefined,
  }
  setMediaStudioHandles({
    workspaceRoot: ws,
    mediaRoots: [],
    defaultCanvasId: 'main',
    canvasStore: store,
    sseClients: new Map(),
    projectStore: stubProjectStore as never,
    projectSseClients: new Set(),
  })
  applyCalls = 0
  const origApply = store.apply.bind(store)
  store.apply = ((canvasId: string, ops: Parameters<typeof origApply>[1]) => {
    applyCalls += 1
    return origApply(canvasId, ops)
  }) as typeof origApply
})

afterEach(async () => {
  vi.clearAllMocks()
  await rm(ws, { recursive: true, force: true })
})

describe('P0-② — postProcess batches N video poster updates into 1 apply', () => {
  it('6 batchAddMedia video items trigger exactly 2 apply() calls total', async () => {
    const tools = await import('../src/tools')

    // Prepare a fake source "video" so the post-process path doesn't
    // bail on a missing source. The stubbed prepareVideoForCanvas
    // returns synchronously without touching the filesystem.
    const src = join(ws, 'src.mp4')
    await mkdir(join(ws, 'src-dir'), { recursive: true })
    await writeFile(src, Buffer.from('fake-mp4'))

    // Build a synthetic patch: 6 video nodes in a single batchAddMedia.
    const items = Array.from({ length: 6 }, (_, i) => ({
      kind: 'video' as const,
      url: src,
      nodeId: `v${i}`,
      prompt: `clip ${i}`,
    }))
    const ops = [{ op: 'batchAddMedia' as const, items }]

    const result = store.apply('canvas-1', ops)
    expect(applyCalls).toBe(1) // just the initial batchAddMedia

    await tools.postProcessCanvasPatch(store, 'canvas-1', ops, result.issues)

    // postProcess should have produced exactly one additional apply()
    // (the batched trailing apply for all 6 video updates), not 6.
    expect(applyCalls).toBe(2)
  })
})
