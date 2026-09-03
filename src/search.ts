/**
 * Global asset search + soft references (M3).
 *
 * Corpus = per-project asset libraries (catalog 'library') plus every
 * project canvas's finished media nodes (catalog 'canvas' — "画布素材",
 * shown lower-ranked until the card is saved to a library).
 *
 * Search is computed live over the in-memory canvas store + asset indexes —
 * library sizes here are small (single-user local) so per-query scans are
 * cheap and can never go stale. Scoring is substring/prefix-weighting over
 * name > tags > prompt; CJK is handled naturally by substring matching.
 *
 * Soft references add an ordinary canvas node carrying `data.assetRef`
 * pointing at an asset owned by another project (or the shared library);
 * no file is copied. Deletion preflights (project-store / asset-store) scan
 * the same `assetRef` field, so reference integrity holds across delete /
 * rename / migration.
 */

import { join } from 'node:path'
import type { CanvasStore } from './canvas-store'
import type { CanvasNode } from './canvas-store'
import {
  ASSET_CATEGORY_DIR,
  type Asset,
  type AssetKind,
  loadAssetIndex,
  projectAssetRoot,
} from './asset-store'
import type { ProjectMeta } from './project-store'

export type SearchCatalog = 'library' | 'canvas'

export interface SearchItem {
  /** Unique client key: `<catalog>:<owner>:<id>` */
  key: string
  catalog: SearchCatalog
  ownerProjectId: string
  ownerProjectName: string
  assetId?: string
  canvasNodeId?: string
  kind: string
  name: string
  tags?: string[]
  prompt?: string
  bytes?: number
  updatedAt: string
  /** Raw media source the client can display via mediaSrc() (absolute path
   *  for library files; the canvas node's resultUrl otherwise). */
  srcRaw: string | null
  /** How many soft refs the scope project already has on this asset. */
  alreadyRefCount: number
}

export interface SearchGroup {
  key: 'current' | 'other'
  title: string
  total: number
  items: SearchItem[]
}

export interface SearchResult {
  q: string
  scopeProjectId: string | null
  hitCount: number
  limit: number
  groups: SearchGroup[]
}

export function nodeTypeForAssetKind(kind: AssetKind): 'image' | 'music' | 'video' {
  if (kind === 'audio') return 'music'
  if (kind === 'clip') return 'video'
  return 'image'
}

/** Absolute media-file path of a library asset (proxy-servable). */
export function assetMediaPath(wsRoot: string, projectId: string, a: Asset): string {
  return join(projectAssetRoot(wsRoot, projectId), ASSET_CATEGORY_DIR[a.kind], a.file)
}

const KIND_LABEL_ORDER: Record<string, number> = { character: 0, scene: 1, audio: 2, clip: 3, image: 4, music: 5, video: 6 }

function scoreAsset(query: string, a: Asset): number {
  const q = query.toLowerCase()
  const name = a.name.toLowerCase()
  if (name === q) return 100
  if (name.startsWith(q)) return 80
  if (name.includes(q)) return 60
  let s = 0
  for (const tag of a.tags ?? []) {
    const tl = tag.toLowerCase()
    if (tl === q) s = Math.max(s, 45)
    else if (tl.includes(q)) s = Math.max(s, 35)
  }
  const prompt = ((a.origin as { prompt?: string } | undefined)?.prompt ?? '').toLowerCase()
  if (prompt.includes(q)) s = Math.max(s, 22)
  const file = a.file.toLowerCase()
  if (file.includes(q)) s = Math.max(s, 10)
  return s
}

function scoreNode(query: string, n: CanvasNode): number {
  const q = query.toLowerCase()
  const name = (n.label || '').toLowerCase()
  if (name === q) return 90
  if (name.startsWith(q)) return 72
  if (name.includes(q)) return 54
  const prompt = ((n.data as { prompt?: unknown }).prompt as string | undefined) ?? ''
  if (prompt.toLowerCase().includes(q)) return 20
  return 0
}

/** Fuzzy filter helper — token AND on contains. */
function tokensContain(text: string, tokens: string[]): boolean {
  const t = text.toLowerCase()
  return tokens.every((tok) => t.includes(tok))
}

export interface RunSearchInput {
  wsRoot: string
  canvasStore: CanvasStore
  projects: ProjectMeta[]
  q: string
  /** Scope project (typically the active one). */
  scopeProjectId?: string | null
  limitPerGroup?: number
}

/** Run the search; returns both groups with pre-soft-ref counts. */
export async function runSearch(input: RunSearchInput): Promise<SearchResult> {
  const q = (input.q ?? '').trim()
  const scope = input.scopeProjectId ?? null
  const limit = Math.max(1, Math.min(50, input.limitPerGroup ?? 20))
  const groups: SearchGroup[] = [
    { key: 'current', title: '', total: 0, items: [] },
    { key: 'other', title: '', total: 0, items: [] },
  ]

  if (!q) {
    return { q, scopeProjectId: scope, hitCount: 0, limit, groups }
  }
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return { q, scopeProjectId: scope, hitCount: 0, limit, groups }
  }

  const scopeName = input.projects.find((p) => p.id === scope)?.name ?? null

  // Scope project's existing refs → alreadyRefCount badge.
  const refCounts = new Map<string, number>()
  if (scope) {
    const snap = input.canvasStore.peek(scope)
    if (snap) {
      for (const n of snap.graph.nodes) {
        const ref = (n.data as { assetRef?: { projectId?: string; assetId?: string } }).assetRef
        if (ref?.projectId && ref.assetId) {
          const key = `${ref.projectId}\0${ref.assetId}`
          refCounts.set(key, (refCounts.get(key) ?? 0) + 1)
        }
      }
    }
  }

  const libScores: Array<{ item: SearchItem; score: number; ownerId: string }> = []
  const nodeScores: Array<{ item: SearchItem; score: number; ownerId: string }> = []

  for (const p of input.projects) {
    const index = await loadAssetIndex(projectAssetRoot(input.wsRoot, p.id))
    for (const a of index.assets) {
      const score = scoreAsset(q, a)
      if (score <= 0) continue
      const nameMatches = tokensContain(a.name, tokens)
      const promptMatches = tokensContain((a.origin as { prompt?: string } | undefined)?.prompt ?? '', tokens)
      if (!nameMatches && !promptMatches) continue
      const relCount = refCounts.get(`${p.id}\0${a.id}`) ?? 0
      libScores.push({
        ownerId: p.id,
        score,
        item: {
          key: `library:${p.id}:${a.id}`,
          catalog: 'library',
          ownerProjectId: p.id,
          ownerProjectName: p.name,
          assetId: a.id,
          kind: a.kind,
          name: a.name,
          tags: a.tags,
          prompt: (a.origin as { prompt?: string } | undefined)?.prompt,
          bytes: a.bytes,
          updatedAt: a.updatedAt,
          srcRaw: assetMediaPath(input.wsRoot, p.id, a),
          alreadyRefCount: relCount,
        },
      })
    }

    // Canvas media corpus (B): finished nodes with media, excluding soft-ref
    // placeholders (they have no own file), text/note cards, and nodes that
    // were already registered into this project's library (the library entry
    // represents them — no duplicates).
    const snap = input.canvasStore.peek(p.id)
    if (snap) {
      const registeredCanvasIds = new Set(
        index.assets
          .filter((a) => a.origin?.type === 'canvas' && (a.origin as { canvasNodeId?: string }).canvasNodeId)
          .map((a) => (a.origin as { canvasNodeId?: string }).canvasNodeId as string),
      )
      const seenUrl = new Set<string>()
      for (const n of snap.graph.nodes) {
        if (n.type !== 'image' && n.type !== 'video' && n.type !== 'music') continue
        if (registeredCanvasIds.has(n.id)) continue
        const d = n.data as { resultUrl?: unknown; status?: unknown; assetRef?: unknown }
        if (typeof d.resultUrl !== 'string' || !d.resultUrl) continue
        if (d.status && d.status !== 'done') continue
        if (d.assetRef) continue
        if (seenUrl.has(d.resultUrl)) continue
        seenUrl.add(d.resultUrl)
        const score = scoreNode(q, n)
        if (score <= 0) continue
        const labelMatches = tokensContain(n.label ?? '', tokens)
        const promptMatches = tokensContain((n.data as { prompt?: unknown }).prompt as string ?? '', tokens)
        if (!labelMatches && !promptMatches) continue
        nodeScores.push({
          ownerId: p.id,
          score: score - 4, // 画布素材 ranks after registered library assets
          item: {
            key: `canvas:${p.id}:${n.id}`,
            catalog: 'canvas',
            ownerProjectId: p.id,
            ownerProjectName: p.name,
            canvasNodeId: n.id,
            kind: n.type,
            name: n.label ?? `${n.type} ${n.id}`,
            prompt: (n.data as { prompt?: unknown }).prompt as string | undefined ?? undefined,
            updatedAt: d.status === 'done' ? '' : '',
            srcRaw: d.resultUrl as string,
            alreadyRefCount: 0,
          },
        })
      }
    }
  }

  const toGroup = (key: 'current' | 'other', entries: Array<{ item: SearchItem; score: number; ownerId: string }>) => {
    const mine = entries.filter((e) => e.ownerId === scope)
    const others = entries.filter((e) => e.ownerId !== scope)
    const source = key === 'current' ? mine : others
    source.sort((a, b) => b.score - a.score || (a.item.updatedAt < b.item.updatedAt ? 1 : -1))
    const items = source.slice(0, limit).map((e) => e.item)
    const title = key === 'current'
      ? (scopeName ? `${scopeName}` : (input.projects[0]?.name ?? '当前项目'))
      : `${input.projects.filter((p) => p.id !== scope).length} 个其他项目`
    return { key, title, total: source.length, items } satisfies SearchGroup
  }

  const all = [...libScores, ...nodeScores]
  const gCur = toGroup('current', all)
  const gOther = toGroup('other', all)
  const hitCount = gCur.total + gOther.total
  if (gCur.total > 0) groups[0] = gCur
  if (gOther.total > 0) groups[1] = gOther
  // When scope has no own hits but others do, keep group order intuitive.
  return { q, scopeProjectId: scope, hitCount, limit, groups: groups.filter((g) => g.total > 0) }
}

/** Add a soft-reference node for a library asset into a project canvas.
 *  Returns the node id (and the post-add ref count for that asset). */
export function addSoftRefToCanvas(
  canvasStore: CanvasStore,
  canvasId: string,
  wsRoot: string,
  ownerProjectId: string,
  asset: Asset,
): { nodeId: string; refCount: number } {
  const nodeId = `ref-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
  const nodeType = nodeTypeForAssetKind(asset.kind)
  const mediaPath = assetMediaPath(wsRoot, ownerProjectId, asset)
  canvasStore.apply(canvasId, [
    {
      op: 'addNode',
      nodeId,
      type: nodeType,
      label: asset.name,
      data: {
        assetRef: { projectId: ownerProjectId, assetId: asset.id },
        assetKind: asset.kind,
        status: 'done',
        resultUrl: mediaPath,
        prompt: (asset.origin as { prompt?: string } | undefined)?.prompt,
      },
    },
  ])
  // count current canvas refs of this asset
  const snap = canvasStore.peek(canvasId)
  let refCount = 0
  if (snap) {
    for (const n of snap.graph.nodes) {
      const ref = (n.data as { assetRef?: { projectId?: string; assetId?: string } }).assetRef
      if (ref?.projectId === ownerProjectId && ref.assetId === asset.id) refCount += 1
    }
  }
  return { nodeId, refCount }
}

/** Resolve an asset by owner+id (throws when missing). */
export async function resolveAsset(wsRoot: string, ownerProjectId: string, assetId: string): Promise<Asset> {
  const index = await loadAssetIndex(projectAssetRoot(wsRoot, ownerProjectId))
  const a = index.assets.find((x) => x.id === assetId)
  if (!a) throw new Error(`asset "${assetId}" not found in project "${ownerProjectId}"`)
  return a
}
