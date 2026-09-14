/**
 * P1-④ — registry-changed SSE broadcasts strip the user-private
 * `sourcePath` and the deployment-internal `legacy` flag before
 * sending the wire payload.
 *
 * The source-of-truth `ProjectStore.snapshot()` still returns full
 * ProjectMeta objects (server-side tools + REST endpoints need the
 * filesystem path), but `safeRegistryForClient()` is the filter the
 * broadcast loop applies.
 */

import { describe, it, expect } from 'vitest'
import { safeRegistryForClient } from '../src/project-store'
import type { RegistrySnapshot } from '../src/project-store'

describe('P1-④ — registry broadcast privacy', () => {
  it('produces a payload with no filesystem paths', () => {
    const snap: RegistrySnapshot = {
      activeId: 'p-1',
      recent: ['p-1'],
      projects: [
        {
          id: 'p-1', name: '林晚传',
          sourcePath: '/Users/alice/Movies/linwan', legacy: false,
          createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastOpenedAt: '2026-01-01T00:00:00Z',
        },
      ],
    }
    const out = safeRegistryForClient(snap)
    const json = JSON.stringify(out)
    expect(json).not.toContain('/Users/alice')
    expect(json).not.toContain('sourcePath')
    expect(json).not.toContain('legacy')
    expect(json).toContain('林晚传')
  })
})
