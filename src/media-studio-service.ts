/**
 * Cross-plugin service surface (`mediaStudio`).
 *
 * Published on the cordis context in `index.ts` via
 * `ctx.reflect.provide('mediaStudio', createMediaStudioService(...))`.
 * Sibling plugins — most notably `dsh-llm-multimodal` — read it at call
 * time with `ctx.get('mediaStudio')` and route generated media straight
 * into the ACTIVE project's asset tree (`<sourcePath>/assets/<kind>/`)
 * instead of a shared temp/workspace directory (the legacy
 * `<wsRoot>/web-jobs` landing spot).
 *
 * The service is read-only on purpose: it resolves paths and reports the
 * active project but never touches the filesystem — the calling plugin
 * owns its own mkdir/write side effects. That keeps ownership clean:
 * media-studio is the single source of truth for where a project's files
 * live (it holds `projects.json`), dsh-llm-multimodal stays a thin
 * generator.
 *
 * Visibility: `provide` registers into the root context's isolation
 * scope, so every other plugin fiber in the same DSH process can read
 * the service while this plugin's fiber is ACTIVE. When the media-studio
 * plugin is absent (headless profiles) or its fiber is stopped,
 * `ctx.get('mediaStudio')` returns `undefined` and consumers fall back
 * to their legacy outputDir behaviour — no hard dependency, no
 * `inject` wait-state.
 */
import { join } from 'node:path'
import type { ProjectMeta, RegistrySnapshot } from './project-store'
import { ASSET_KINDS, ASSET_CATEGORY_DIR, projectAssetRootAt, type AssetKind } from './asset-store'

export interface MediaStudioProjectRef {
  id: string
  name: string
  /** Absolute user-owned directory the project's data lives under, or
   *  `undefined` for pre-migration legacy registry entries. */
  sourcePath: string | undefined
  legacy?: boolean
}

/** The consumer-facing contract. Keep this shape minimal and stable —
 *  dsh-llm-multimodal (and any future caller) is compiled against it. */
export interface MediaStudioService {
  /** Id of the currently active project, or `null` when the registry has
   *  no active entry. */
  getActiveProjectId(): string | null
  /** Active project meta, or `null` when there is no active project. */
  getActiveProject(): MediaStudioProjectRef | null
  /**
   * Absolute directory of one project's asset library. Honors
   * `sourcePath` (`<sourcePath>/assets`); legacy projects without a
   * sourcePath resolve to the plugin-owned `<wsRoot>/projects/<id>/assets`.
   * Pass `kind` (character / scene / audio / clip) to get the matching
   * category subdirectory. Returns `null` when the project id is
   * unknown or `kind` is not a library category. NEVER creates
   * directories — the caller mkdir's what it needs.
   */
  resolveAssetDir(projectId?: string, kind?: string): string | null
  /** The plugin's workspaceRoot (absolute, `~` already expanded). */
  workspaceRoot(): string
}

/** Minimal store contract the service needs — ProjectStore satisfies it;
 *  tests can fake it with a plain snapshot() closure. The snapshot shape
 *  mirrors `RegistrySnapshot` (projects as an array, newest first). */
export interface MediaStudioStoreLike {
  snapshot(): RegistrySnapshot
}

export const MEDIA_STUDIO_SERVICE_NAME = 'mediaStudio'

export function createMediaStudioService(wsRoot: string, store: MediaStudioStoreLike): MediaStudioService {
  const knownKinds: ReadonlySet<string> = new Set(ASSET_KINDS)
  return {
    getActiveProjectId() {
      return store.snapshot().activeId
    },
    getActiveProject() {
      const snap = store.snapshot()
      const activeId = snap.activeId
      if (!activeId) return null
      const meta = snap.projects.find((p) => p.id === activeId)
      if (!meta) return null
      return { id: meta.id, name: meta.name, sourcePath: meta.sourcePath, legacy: meta.legacy }
    },
    resolveAssetDir(projectId, kind) {
      const snap = store.snapshot()
      const pid = typeof projectId === 'string' && projectId.trim() ? projectId : snap.activeId
      if (!pid) return null
      const meta = snap.projects.find((p) => p.id === pid)
      if (!meta) return null
      const root = projectAssetRootAt(meta.sourcePath, wsRoot, pid)
      if (kind === undefined || kind === '') return root
      if (!knownKinds.has(kind)) return null
      return join(root, ASSET_CATEGORY_DIR[kind as AssetKind])
    },
    workspaceRoot() {
      return wsRoot
    },
  }
}
