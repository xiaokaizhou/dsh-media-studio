/**
 * `mediaStudio` cross-plugin service tests.
 *
 * The service (src/media-studio-service.ts) is published on the cordis
 * context by apply() so sibling plugins — dsh-llm-multimodal in
 * particular — can route generated media into the ACTIVE project's
 * sourcePath asset tree. These tests cover the store-facing contract:
 * active-project resolution, sourcePath-aware asset dirs, the legacy
 * wsRoot/projects fallback, and unknown-kind / unknown-id rejections.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore } from '../src/project-store'
import { createMediaStudioService } from '../src/media-studio-service'

let wsRoot: string
let store: ProjectStore

beforeEach(async () => {
  wsRoot = await mkdtemp(join(tmpdir(), 'media-studio-svc-'))
  const canvasStore = new CanvasStore(wsRoot, {})
  store = new ProjectStore(wsRoot, canvasStore, {
    recentLimit: 10,
    trashEnabled: true,
    defaultSourcePath: join(wsRoot, 'Movies'),
  })
  await store.ready()
})

afterEach(async () => {
  await rm(wsRoot, { recursive: true, force: true })
})

describe('mediaStudio service', () => {
  it('reports no active project on an empty registry', () => {
    const svc = createMediaStudioService(wsRoot, store)
    expect(svc.getActiveProjectId()).toBeNull()
    expect(svc.getActiveProject()).toBeNull()
    expect(svc.resolveAssetDir()).toBeNull()
    expect(svc.workspaceRoot()).toBe(wsRoot)
  })

  it('resolves the active project asset dirs from its sourcePath', async () => {
    const meta = await store.createProject('svc-proj')
    const svc = createMediaStudioService(wsRoot, store)
    expect(svc.getActiveProjectId()).toBe(meta.id)
    expect(svc.getActiveProject()?.name).toBe('svc-proj')
    // No kind → the assets root itself.
    expect(svc.resolveAssetDir()).toBe(join(meta.sourcePath!, 'assets'))
    // kind → matching category subdir.
    expect(svc.resolveAssetDir(undefined, 'character')).toBe(join(meta.sourcePath!, 'assets', 'characters'))
    expect(svc.resolveAssetDir(undefined, 'scene')).toBe(join(meta.sourcePath!, 'assets', 'scenes'))
    expect(svc.resolveAssetDir(meta.id, 'scene')).toBe(join(meta.sourcePath!, 'assets', 'scenes'))
    expect(svc.resolveAssetDir(meta.id, 'clip')).toBe(join(meta.sourcePath!, 'assets', 'clips'))
    expect(svc.resolveAssetDir(meta.id, 'audio')).toBe(join(meta.sourcePath!, 'assets', 'audio'))
    // Unknown kind / unknown project id → null (caller falls back).
    expect(svc.resolveAssetDir(meta.id, 'bogus')).toBeNull()
    expect(svc.resolveAssetDir('p-nope', 'scene')).toBeNull()
  })

  it('follows activation changes (openProject re-points the active id)', async () => {
    const a = await store.createProject('svc-a')
    const b = await store.createProject('svc-b')
    expect(b.id).not.toBe(a.id)
    const svc = createMediaStudioService(wsRoot, store)
    expect(svc.getActiveProjectId()).toBe(b.id)
    await store.openProject(a.id)
    expect(svc.getActiveProjectId()).toBe(a.id)
    expect(svc.resolveAssetDir(undefined, 'audio')).toBe(join(a.sourcePath!, 'assets', 'audio'))
  })

  it('legacy entries without sourcePath fall back to <wsRoot>/projects/<id>/assets', async () => {
    const meta = await store.createProject('legacy-ish')
    // Simulate a pre-migration registry entry (boot() synthesis shape):
    // same project but with sourcePath stripped.
    const legacyStore = {
      snapshot: () => ({
        activeId: meta.id,
        recent: [meta.id],
        projects: [{ ...meta, sourcePath: undefined, legacy: true }],
      }),
    }
    const svc = createMediaStudioService(wsRoot, legacyStore as unknown as ProjectStore)
    expect(svc.resolveAssetDir(undefined, 'scene')).toBe(join(wsRoot, 'projects', meta.id, 'assets', 'scenes'))
    expect(svc.resolveAssetDir()).toBe(join(wsRoot, 'projects', meta.id, 'assets'))
  })
})
