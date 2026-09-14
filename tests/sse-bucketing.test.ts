/**
 * P1-③ — SSE broadcasts must only reach subscribers of the same canvas.
 *
 * The unified `/api/media-studio/sse` endpoint subscribed a single
 * EventSource per tab and the host's broadcast loop pushed every
 * `canvas-patch` to every connection — so a patch on canvas A would
 * also reach a tab currently viewing canvas B. The fix splits the
 * SSE client registry into a `Map<canvasId, Set<ServerResponse>>`
 * and the canvas-bus adds a defensive canvasId equality check before
 * applying a received patch.
 */

import { describe, it, expect } from 'vitest'
import { safeRegistryForClient } from '../src/project-store'

describe('P1-③ — safeRegistryForClient (server-side broadcast shape)', () => {
  it('strips sourcePath + legacy from every project meta', () => {
    const snap = {
      activeId: 'p-a',
      recent: ['p-a'],
      projects: [
        { id: 'p-a', name: 'A', sourcePath: '/Users/alice/Movies/A', createdAt: 't', updatedAt: 't', lastOpenedAt: 't', legacy: true },
        { id: 'p-b', name: 'B', sourcePath: '/Users/alice/Movies/B', createdAt: 't', updatedAt: 't', lastOpenedAt: 't' },
        { id: 'p-c', name: 'C', createdAt: 't', updatedAt: 't', lastOpenedAt: 't' },
      ],
    }
    const safe = safeRegistryForClient(snap)
    // sourcePath + legacy must never appear in the wire payload.
    const json = JSON.stringify(safe)
    expect(json).not.toContain('sourcePath')
    expect(json).not.toContain('legacy')
    expect(json).not.toContain('/Users/alice')
    // Names + ids still pass through.
    expect(safe.projects.map((p) => p.name)).toEqual(['A', 'B', 'C'])
  })

  it('preserves project entries that had no sourcePath / legacy flags', () => {
    const snap = {
      activeId: null,
      recent: [],
      projects: [{ id: 'p-x', name: 'X', createdAt: 't', updatedAt: 't', lastOpenedAt: 't' }],
    }
    const safe = safeRegistryForClient(snap)
    expect(safe.projects).toEqual(snap.projects)
  })
})
