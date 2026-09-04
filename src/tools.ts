import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { CanvasStore, type CanvasOp, type CanvasSnapshot, type CanvasNode } from './canvas-store'
import { join } from 'node:path'
import { getMediaStudioHandles } from './service-state'
import { prepareVideoForCanvas } from './video-cover'
import {
  registerCanvasAsset,
  type AssetKind,
  listAssets,
  updateAssetMeta,
  deleteAsset,
  copyAssetToProject,
  scanCanvasRefs,
} from './asset-store'
import { ProjectDeleteBlockedError } from './project-store'
import { runSearch, addSoftRefToCanvas, resolveAsset } from './search'

/** Map a canvas node type to the asset-library kind for auto-registration.
 *  Canvas `music` nodes hold audio → 'audio' in the library. */
export function assetKindForNodeType(nodeType: CanvasNode['type']): AssetKind | null {
  switch (nodeType) {
    case 'image': return 'character'  // default; project callers can override
    case 'video': return 'clip'
    case 'music': return 'audio'
    default: return null
  }
}

/** Walk a batch of patch ops and pick out newly-added or updated media nodes
 *  (image / video / music) that carry a `resultUrl`. Text / note nodes never
 *  hold media so we skip them. `postNodes` is the canvas graph after the
 *  patch has been applied — we read from it because `updateNode` only sends
 *  the changed fields. */
export function collectMediaNodesFromOps(
  ops: CanvasOp[],
  postNodes: CanvasNode[],
): { nodeId: string; nodeType: CanvasNode['type'] }[] {
  const out: { nodeId: string; nodeType: CanvasNode['type'] }[] = []
  for (const op of ops) {
    if (op.op === 'addNode') {
      if (op.data?.resultUrl && (op.type === 'image' || op.type === 'video' || op.type === 'music')) {
        const nodeId = op.nodeId || ''
        if (nodeId) out.push({ nodeId, nodeType: op.type })
      }
    } else if (op.op === 'updateNode') {
      const merged = postNodes.find((n) => n.id === op.id)
      if (merged && merged.data?.resultUrl && (merged.type === 'image' || merged.type === 'video' || merged.type === 'music')) {
        out.push({ nodeId: merged.id, nodeType: merged.type })
      }
    } else if (op.op === 'batchAddMedia') {
      for (const item of op.items) {
        const nodeId = item.nodeId || ''
        if (nodeId && (item.kind === 'image' || item.kind === 'video' || item.kind === 'audio')) {
          const nodeType: CanvasNode['type'] = item.kind === 'audio' ? 'music' : item.kind
          out.push({ nodeId, nodeType })
        }
      }
    }
  }
  return out
}

/** Try to auto-register a newly-patched node's media into the project asset
 *  library. Returns null on success (or if no registration was needed), or
 *  a `warn:`-prefixed advisory string on failure — the same shape the lint
 *  pass already uses in `issues`, so the agent sees one unified list. Never
 *  throws — a failed auto-register must not break the canvas patch the agent
 *  just applied. */
async function tryAutoRegisterAsset(
  projectId: string,
  sourcePath: string | undefined,
  nodeId: string,
  nodeType: CanvasNode['type'],
): Promise<string | null> {
  const kind = assetKindForNodeType(nodeType)
  if (!kind) return null
  const mst = getMediaStudioHandles()
  try {
    await registerCanvasAsset({
      wsRoot: mst.workspaceRoot,
      roots: mst.mediaRoots ?? [],
      canvasStore: mst.canvasStore,
      projectId,
      sourcePath,
      canvasNodeId: nodeId,
      kind,
    })
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `node "${nodeId}" (${nodeType}) has resultUrl but auto-register failed: ${msg}. ` +
      `Call POST /api/media-studio/assets/register with {projectId, kind, canvasNodeId} to link it.`
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//
// After the multimodal refactor the `dsh-media-studio` plugin no longer owns
// any LLM-facing tools. The five `generate_*` tools (text / image / video /
// tts / music) all live in the sibling `dsh-llm-multimodal` plugin, which
// also owns the `llm-multimodal` settings namespace and the matching
// settings card.
//
// This file owns FOUR canvas-only tools:
//   - canvas_graph_view      — read canvas snapshot
//   - canvas_graph_patch     — atomic batched canvas mutation
//   - canvas_auto_arrange    — re-layout by topological depth
//   - canvas_refresh_node    — click-regenerate one media node (delegates to
//                              the multimodal plugin's tools via
//                              ctx.tools.execute)
// ─────────────────────────────────────────────────────────────────────────────

// ── Refresh: shared between the agent tool + the client HTTP route ────────

/**
 * Assemble a regeneration prompt from the upstream nodes of `nodeId`.
 *
 * Strategy:
 *   • text  nodes → concatenate `text` (or `content`) from upstream text/note
 *                   nodes, prefixed by each label so the LLM knows which
 *                   source each chunk came from.
 *   • image nodes → reuse `prompt` from upstream image nodes as the new
 *                   prompt; if no image upstreams exist, fall back to
 *                   concatenating text upstreams and appending "Generate an
 *                   image that illustrates: <context>".
 *   • video nodes → same strategy as image but with "Generate a short video: "
 *   • music nodes → concatenate text upstreams as the TTS `text`.
 */
export function buildRefreshContext(
  nodeId: string,
  graph: CanvasSnapshot['graph'],
): string {
  const node = graph.nodes.find((n) => n.id === nodeId)
  if (!node) return ''

  // Collect upstream edges (edges where this node is the target).
  const upstreamIds = graph.edges
    .filter((e) => e.target === nodeId)
    .map((e) => e.source)

  if (upstreamIds.length === 0) return ''

  const parts: string[] = []
  for (const id of upstreamIds) {
    const up = graph.nodes.find((n) => n.id === id)
    if (!up) continue
    const label = up.label || up.type
    let content = ''
    if (up.type === 'text' || up.type === 'note') {
      content = (up.data.text as string | undefined) ?? (up.data.content as string | undefined) ?? ''
    } else if (up.type === 'image' || up.type === 'video') {
      content = (up.data.prompt as string | undefined) ?? ''
    } else if (up.type === 'music') {
      content = (up.data.text as string | undefined) ?? ''
    }
    if (content) {
      parts.push(`[${label}]: ${content}`)
    } else {
      parts.push(`[${label}]: (no text content)`)
    }
  }

  return parts.join('\n')
}

/**
 * Map a canvas node type to the multimodal tool name. The dsh-llm-multimodal
 * plugin owns all five generators — `generate_image` etc.
 */
function toolNameForNodeType(kind: 'image' | 'video' | 'music'): string {
  switch (kind) {
    case 'image': return 'generate_image'
    case 'video': return 'generate_video'
    case 'music': return 'generate_music'
  }
}

/**
 * One call into the multimodal plugin. We use the harness's
 * `ctx.tools.execute(...)` (declared on the cordis Context through
 * `@deepseek-ai/dsh-tools`'s `ToolRuntime`) rather than calling the
 * multimodal plugin's internals — that is the documented plugin boundary
 * and stays robust if dsh-llm-multimodal evolves its internals.
 */
async function callMultimodal(
  ctx: Context,
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ ok: boolean; url?: string; model?: string; coverUrl?: string; code?: string; message?: string }> {
  try {
    // The tool shape, per dsh-tools, is `{ name, arguments, signal, callId }`.
    // For our purposes the harness mints a callId; we just pass our signal.
    const exec = await (ctx.tools as unknown as {
      execute: (input: { name: string; arguments: unknown; signal: AbortSignal; callId?: string }) => Promise<unknown>
    }).execute({
      name,
      arguments: args,
      signal,
    })
    const out = (exec as { value?: unknown; isError?: boolean })?.value ?? exec
    // `coverUrl` is set by `dsh-llm-multimodal/generate_video` when the
    // provider response carries a sibling image — media-studio's video-cover
    // pipeline uses it to embed the first frame into the MP4 so project
    // directories stay clean (no sibling .thumb.jpg).
    const v = out as { success?: boolean; videoUrl?: string; url?: string; model?: string; message?: string; coverUrl?: string }
    if (v && v.success) {
      const url = v.videoUrl || v.url
      return { ok: true, url, model: v.model, coverUrl: v.coverUrl }
    }
    return { ok: false, code: 'multimodal-failed', message: v?.message || JSON.stringify(out).slice(0, 200) }
  } catch (e) {
    return { ok: false, code: 'multimodal-threw', message: (e as Error).message }
  }
}

/** Execute the node refresh logic. Used by both the agent tool and the HTTP
 *  route so they share the same code path. */
export async function executeNodeRefresh(
  store: CanvasStore,
  canvasId: string,
  nodeId: string,
  signal: AbortSignal,
  ctx: Context,
): Promise<{ ok: boolean; code?: string; message?: string; prompt?: string; kind: string; url?: string }> {
  // Read current snapshot
  const snap = store.snapshot(canvasId)
  const node = snap.graph.nodes.find((n) => n.id === nodeId)
  if (!node) return { ok: false, code: 'node-not-found', message: `node "${nodeId}" not found`, kind: 'image' }

  // Guard: must have upstream edges
  const upstreamEdges = snap.graph.edges.filter((e) => e.target === nodeId)
  if (upstreamEdges.length === 0) {
    return { ok: false, code: 'no-upstream', message: `node "${nodeId}" has no upstream connections`, kind: 'image' }
  }

  // Set running status optimistically (sync patch so the tab reflects immediately)
  const runningOp: CanvasOp = { op: 'updateNode', id: nodeId, data: { status: 'running' as const } }
  try {
    store.apply(canvasId, [runningOp])
  } catch { /* non-fatal — keep going */ }

  const kind = node.type as 'image' | 'video' | 'music'
  const context = buildRefreshContext(nodeId, snap.graph)
  const basePrompt = (node.data.prompt as string | undefined) ?? ''

  try {
    let resultUrl: string | undefined
    let newPrompt: string
    /** Video-only: optional poster path produced by prepareVideoForCanvas
     *  (provider-cover embed success means poster stays null and the
     *  attached_pic stream paints itself; extract success sets it). */
    let videoPoster: string | null = null

    if (kind === 'image') {
      newPrompt = basePrompt
        ? `${basePrompt}\n\nContext from upstream nodes:\n${context || '(no upstream text content)'}\n\nRegenerate the image keeping the original style and subject.`
        : `Regenerate image from upstream context:\n${context || '(empty)'}`
      const r = await callMultimodal(ctx, 'generate_image', {
        prompt: newPrompt,
        model: (node.data.model as string | undefined) || undefined,
      }, signal)
      if (!r.ok || !r.url) return { ok: false, code: r.code || 'image-failed', message: r.message || 'no url', kind }
      resultUrl = r.url
    } else if (kind === 'video') {
      newPrompt = basePrompt
        ? `${basePrompt}\n\nContext from upstream nodes:\n${context || '(no upstream text content)'}\n\nRegenerate the video keeping the original style and subject.`
        : `Regenerate video from upstream context:\n${context || '(empty)'}`
      const r = await callMultimodal(ctx, 'generate_video', {
        prompt: newPrompt,
        model: (node.data.model as string | undefined) || undefined,
      }, signal)
      if (!r.ok || !r.url) return { ok: false, code: r.code || 'video-failed', message: r.message || 'no url', kind }
      // prepareVideoForCanvas may rewrite r.url to a local copy under
      // web-jobs/ AND optionally attach (or extract) a poster. Failures are
      // non-fatal — we always fall back to the provider URL.
      const wsRoot = getMediaStudioHandles().workspaceRoot
      const prepared = await prepareVideoForCanvas(r.url, {
        wsRoot,
        // Prefer the typed `coverUrl` field returned by dsh-llm-multimodal;
        // `providerExtras` is a belt-and-suspenders fallback for providers
        // that stuff the cover URL into an unmodeled JSON field.
        coverUrl: r.coverUrl,
        providerExtras: r,
      })
      resultUrl = prepared.url
      videoPoster = prepared.poster
    } else if (kind === 'music') {
      newPrompt = context || '(no upstream text content)'
      const r = await callMultimodal(ctx, 'generate_music', {
        text: newPrompt,
        voice: (node.data.voice as string | undefined) || undefined,
      }, signal)
      if (!r.ok || !r.url) return { ok: false, code: r.code || 'music-failed', message: r.message || 'no url', kind }
      resultUrl = r.url
    } else {
      return { ok: false, code: 'not-supported', message: `refresh not supported for kind "${kind}"`, kind }
    }

    const updateOp: CanvasOp = {
      op: 'updateNode',
      id: nodeId,
      data: {
        status: 'done' as const,
        resultUrl,
        prompt: newPrompt,
        ...(kind === 'video' && videoPoster ? { poster: videoPoster } : {}),
        ...(kind === 'music' ? { text: newPrompt } : {}),
      },
    }
    store.apply(canvasId, [updateOp])

    return { ok: true, kind, prompt: newPrompt, url: resultUrl }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const code = 'unknown'
    console.error(`[media-studio] executeNodeRefresh: error ${code} ${msg}`)
    const errOp: CanvasOp = {
      op: 'updateNode',
      id: nodeId,
      data: { status: 'error' as const, errorMsg: msg },
    }
    try { store.apply(canvasId, [errOp]) } catch { /* ignore */ }
    return { ok: false, code, message: msg, kind }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration — canvas_graph_* + auto-arrange + refresh node
// ─────────────────────────────────────────────────────────────────────────────

/** Canvas id tools fall back to: the active project's canvas when a project
 *  registry exists (M0), else the plugin default (`main`). */
function resolveCanvasId(): string {
  const mst = getMediaStudioHandles()
  const active = mst.projectStore?.activeCanvasId() ?? null
  return active || mst.defaultCanvasId || 'main'
}

/**
 * `canvas_graph_view` — read the current canvas snapshot. Agents should
 * call this before `canvas_graph_patch` so they don't operate blind.
 */
export function registerCanvasViewTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_view',
      description: 'Read the current canvas graph (nodes + edges) for a canvas. Returns JSON; pass canvasId to disambiguate when the user has multiple canvases open (blank → the active project\'s canvas, else the plugin default).',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `canvas version ${(value as { version: number }).version}: ${(value as { graph: { nodes: unknown[] } }).graph.nodes.length} nodes, ${(value as { graph: { edges: unknown[] } }).graph.edges.length} edges`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        return store.snapshot(canvasId) as unknown as JsonValue
      },
    }),
  )
}

/**
 * `canvas_graph_patch` — batched, atomic canvas mutation. This is the
 * primary tool the agent uses to "operate the canvas" from conversation.
 */
export function registerCanvasPatchTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_patch',
      description:
        'Batch-apply canvas graph ops atomically. Ops: addNode (type: text|image|video|music|note, label, data?, position?, nodeId? — position optional: auto-placed in a free grid slot when omitted; nodeId lets a later op in the same batch reference this node); updateNode (id, data); renameNode (id, label); deleteNode (id); moveNode (id, position); connect (from, to, branch?); deleteEdge (id); batchAddMedia (items: [{kind, url, prompt?, model?, position?, nodeId?}]). On reject, the whole batch fails — fix the lint hint and retry.\n\n' +
        'Data contract (non-blocking, but you should follow it):\n' +
        '  • text nodes MUST carry data.text (non-empty string)\n' +
        '  • note nodes MUST carry data.content (non-empty string)\n' +
        '  • image/video/music nodes are filled by a later refresh_node call (resultUrl arrives then)\n' +
        'If you omit data.text or data.content, the node still gets created — but the lint pass will emit a warning, and the rendered card will show an "empty" placeholder to the user. After creating any text/note node you MUST follow up with updateNode(id, {text|content: ...}) or include data.text / data.content inline in the same addNode op. Never rely on the empty placeholder.',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        ops: { type: 'array', items: { type: 'object', additionalProperties: true }, required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { applied: number; version: number; lintOk: boolean; issues: string[] }
          const advisoryCount = v.issues.filter((s) => s.startsWith('warn:')).length
          const advisorySuffix = advisoryCount > 0
            ? `; ${advisoryCount} media registration advisory(ies)`
            : ''
          return [{
            type: 'text' as const,
            text: `applied ${v.applied} ops → version ${v.version}; lint: ${v.lintOk ? 'pass' : 'warnings'}${advisorySuffix}`,
          }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const ops = Array.isArray(args.ops) ? (args.ops as unknown as CanvasOp[]) : []
        if (ops.length === 0) throw new Error('canvas_graph_patch: ops must be a non-empty array')
        if (ops.length > 60) throw new Error(`canvas_graph_patch: batch too large (${ops.length} ops, max 60)`)
        const result = store.apply(canvasId, ops)

        // Auto-register any newly-patched media nodes (image/video/music with
        // a resultUrl) into the project asset library. Best-effort: failures
        // surface as `warn:` lines appended to the same `issues` array the
        // lint pass uses, so the agent gets one unified diagnostics list and
        // sees exactly what didn't make it into the library.
        const issues = [...result.issues]
        const projectStore = mst.projectStore
        const projectId = projectStore?.activeCanvasId?.() ?? null
        const sourcePath = (() => {
          if (!projectId || !projectStore) return undefined
          const snap = projectStore.snapshot?.()
          if (!snap) return undefined
          const meta = snap.projects.find((p) => p.id === projectId)
          return meta?.sourcePath
        })()
        if (projectId) {
          const postSnap = store.snapshot(canvasId)
          const mediaNodes = collectMediaNodesFromOps(ops, postSnap.graph.nodes)
          for (const { nodeId, nodeType } of mediaNodes) {
            const adv = await tryAutoRegisterAsset(projectId, sourcePath, nodeId, nodeType)
            if (adv) issues.push(adv)
          }
        }

        return {
          applied: result.patch.length,
          version: result.version,
          lintOk: result.lintOk,
          issues,
        }
      },
    }),
  )
}

/**
 * `canvas_auto_arrange` — re-layout all nodes by topological depth.
 */
export function registerAutoArrangeTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_auto_arrange',
      description: 'Auto-arrange all nodes in a canvas by topological flow depth (columns ordered by BFS from sources, nodes stacked vertically within each column). Mirrors the client\'s bottom-right wand button. Call this after building a workflow for an immediately clean layout.',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `auto-arranged → version ${(value as { version: number }).version}; lint: ${(value as { lintOk: boolean }).lintOk ? 'pass' : 'warnings'}`,
        }],
      },
      async execute(args) {
        const store = getMediaStudioHandles().canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const result = store.autoArrange(canvasId)
        return {
          applied: result.patch.length,
          version: result.version,
          lintOk: result.lintOk,
          issues: result.issues,
        }
      },
    }),
  )
}

/** The tool output shape — a single prompt + whether it had upstream content. */
const refreshNodeOutput = {
  schema: {
    type: 'object' as const,
    additionalProperties: false as const,
    properties: {
      ok: { type: 'boolean' as const },
      code: { type: 'string' as const },
      message: { type: 'string' as const },
      prompt: { type: 'string' as const },
      kind: { type: 'string' as const },
      url: { type: 'string' as const },
    },
  },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: (value as { ok: boolean; prompt?: string; url?: string; message?: string }).ok
      ? `refreshed node "${(value as { kind: string }).kind}": ${(value as { url: string }).url?.slice(0, 80) || ''}`
      : `refresh failed: ${(value as { message: string }).message}`,
  }],
} satisfies { schema: ValueSchemaSpec; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }

export function registerCanvasRefreshNodeTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_refresh_node',
      description:
        'Refresh a canvas node by regenerating its media through the dsh-llm-multimodal plugin (generate_image / generate_video / generate_music). For image/video nodes, gathers upstream prompts and regenerates; for music nodes, regathers upstream text and re-runs TTS. Sets status to "running" during generation and updates resultUrl on completion.',
      parameters: {
        canvasId: { type: 'string', description: 'Canvas id. Blank → the plugin default.' },
        nodeId: { type: 'string', description: 'The node id to refresh. Must exist on the canvas.' },
      },
      output: refreshNodeOutput,
      async execute(args, exec) {
        const mst = getMediaStudioHandles()
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const nodeId = String(args.nodeId).trim()
        if (!nodeId) return { ok: false, code: 'missing-node-id', message: 'nodeId is required', kind: 'image' }
        return executeNodeRefresh(mst.canvasStore, canvasId, nodeId, exec.signal, ctx)
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Project management tools (Agent-side wrappers over the REST endpoints
// registered in project-routes.ts). These exist so the agent can drive the
// multi-project layer directly — without these, the agent was only able to
// operate the canvas of whichever project happened to be active in the GUI.
//
// All writes funnel through ProjectStore's single-writer queue; all
// mutations emit registry-changed / project-open / project-deleted on the
// projects SSE so any open Media Studio tab refreshes.
//
// Output shape mirrors the REST endpoints:
//   list / create / open / rename → { ok, project, registry, recentLimit? }
//   delete → { ok, result, registry } | { ok:false, code:'project-referenced', dependents }
// ─────────────────────────────────────────────────────────────────────────────

function requireProjectStore(): NonNullable<ReturnType<typeof getMediaStudioHandles>['projectStore']> {
  const ps = getMediaStudioHandles().projectStore
  if (!ps) throw new Error('media_studio: projectStore is not initialized (plugin not ready?)')
  return ps
}

export function registerMediaStudioListProjectsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_list_projects',
      description:
        'List every registered media-studio project (active + recent ≤ recentLimit + all). ' +
        'Returns the registry snapshot the GUI shows in the "项目" menu. Read-only.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { projects: unknown[]; activeId: string | null; recent: string[] }
          return [{
            type: 'text' as const,
            text: `${v.projects.length} project(s); active=${v.activeId ?? '(none)'}; recent=[${v.recent.join(', ')}]`,
          }]
        },
      },
      async execute() {
        const ps = requireProjectStore()
        await ps.ready()
        const snap = ps.snapshot()
        return { ok: true, ...snap, recentLimit: ps.getRecentLimit() } as unknown as JsonValue
      },
    }),
  )
}

export function registerMediaStudioCreateProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_create_project',
      description:
        'Create a new media-studio project. Without `sourcePath` the project lives in the legacy ' +
        'workspace layout and is fully owned by media-studio. With `sourcePath` (an absolute host ' +
        'directory the agent or user chose) the project\'s canvas + assets are placed INSIDE that ' +
        'user-owned directory; media-studio only owns the registry entry. The new project is also ' +
        'activated and pushed to the front of `recent`.',
      parameters: {
        name: { type: 'string', description: 'Display name (optional; auto-default "未命名项目 N" when blank). Max 64 chars; no \\ / : * ? " < > |.' },
        sourcePath: { type: 'string', description: 'Optional absolute host directory the project\'s data lives under. Pass the path returned by media_studio_pick_folder, or omit for a managed workspace project.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { id: string; name: string }; error?: string }
          return [{
            type: 'text' as const,
            text: v.ok ? `created project "${v.project!.name}" (id=${v.project!.id})` : `create failed: ${v.error}`,
          }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        try {
          const sourcePath = typeof args.sourcePath === 'string' && args.sourcePath.trim() ? args.sourcePath.trim() : undefined
          const meta = await ps.createProject(typeof args.name === 'string' ? args.name : undefined, sourcePath)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, code: 'create-failed', error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioPickFolderTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_pick_folder',
      description:
        'macOS only: open the native NSOpenPanel so the user can choose a host directory; ' +
        'returns the absolute POSIX path (or { canceled: true }). The path can then be passed ' +
        'to `media_studio_create_project({ sourcePath })` to make the chosen directory a real ' +
        'project. On non-macOS hosts the tool returns { ok:false, code:"unsupported-platform" }.',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; canceled?: boolean; path?: string | null; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `pick failed: ${v.error}` }]
          return [{ type: 'text' as const, text: v.canceled ? 'user canceled' : `selected: ${v.path}` }]
        },
      },
      async execute() {
        if (process.platform !== 'darwin') {
          return { ok: false, code: 'unsupported-platform', error: 'native folder picker is only available on macOS' } as unknown as JsonValue
        }
        const { spawn } = await import('node:child_process')
        const script = 'set selectedFolder to choose folder with prompt "选择项目文件夹"\nPOSIX path of selectedFolder\n'
        const uid = typeof process.getuid === 'function' ? process.getuid() : null
        const useLaunchctl = uid !== null
        const cmd = useLaunchctl ? 'launchctl' : 'osascript'
        const args: string[] = useLaunchctl ? ['asuser', String(uid), 'osascript'] : []
        return await new Promise<{ ok: boolean; canceled?: boolean; path?: string | null; error?: string }>((resolve) => {
          const proc = spawn(cmd, [...args, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
          let out = ''
          let err = ''
          proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
          proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
          proc.on('close', (code: number | null) => {
            if (code === 0) { resolve({ ok: true, canceled: false, path: out.trim() || null }); return }
            if (code === null || /User canceled|-128|InterruptedError/i.test(err)) {
              resolve({ ok: true, canceled: true, path: null })
              return
            }
            resolve({ ok: false, error: `osascript failed (code ${code}): ${err.trim() || out.trim()}` })
          })
          proc.on('error', (e) => resolve({ ok: false, error: e.message }))
        })
      },
    }),
  )
}

export function registerMediaStudioOpenProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_open_project',
      description:
        'Activate an existing project (bumping it to the front of `recent` and restoring its canvas ' +
        'from disk). Subsequent canvas_graph_* tool calls without an explicit canvasId will land on ' +
        'this project\'s canvas. Returns the refreshed registry so the agent can verify activeId.',
      parameters: {
        projectId: { type: 'string', description: 'Project id (p-… format).', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { id: string; name: string }; error?: string }
          return [{
            type: 'text' as const,
            text: v.ok ? `opened project "${v.project!.name}" (id=${v.project!.id})` : `open failed: ${v.error}`,
          }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        if (!id) return { ok: false, error: 'projectId is required' }
        try {
          const meta = await ps.openProject(id)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioRenameProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_rename_project',
      description:
        'Rename a project. id is immutable — only `name` changes. When the project has a user-owned ' +
        '`sourcePath` (created via the folder picker or migrated from a legacy canvas) the on-disk ' +
        'directory is renamed in lock-step and projects.json is updated; existing references survive ' +
        'the rename. Fails with a clear error when the target directory already exists.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        name: { type: 'string', description: 'New display name. 1–64 chars; no \\ / : * ? " < > |.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; project?: { name: string }; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `renamed → "${v.project!.name}"` : `rename failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        const name = typeof args.name === 'string' ? args.name : ''
        if (!id) return { ok: false, error: 'projectId is required' }
        try {
          const meta = await ps.renameProject(id, name)
          return { ok: true, project: meta, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioDeleteProjectTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_delete_project',
      description:
        'Delete a project. Default mode is `trash` (recoverable under <wsRoot>/trash/) and default ' +
        'cascade is `cancel` — when other projects soft-reference this one\'s assets, the call returns ' +
        '`{ ok:false, code:"project-referenced", dependents:{...} }` so you can pick a cascade mode ' +
        'and retry. Modes: mode=`trash`|`permanent`; cascade=`cancel`|`break-refs`|`migrate-shared`. ' +
        '`migrate-shared` copies referenced assets into the __shared library and rewrites the ' +
        'referencing nodes\' `assetRef.projectId` so nothing breaks. `break-refs` marks every ' +
        'referencing node `brokenAsset:true`. `cancel` is the safe default.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        mode: { type: 'string', description: '"trash" (default, recoverable) or "permanent".' },
        cascade: { type: 'string', description: '"cancel" (default), "break-refs", or "migrate-shared".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; code?: string; error?: string; dependents?: { totalRefs?: number }; result?: { deletedId: string; switchedTo: string | null } }
          if (v.ok) return [{ type: 'text' as const, text: `deleted ${v.result!.deletedId}; switchedTo=${v.result!.switchedTo ?? '(none)'}` }]
          if (v.code === 'project-referenced') return [{ type: 'text' as const, text: `delete blocked: ${v.dependents?.totalRefs ?? 0} soft reference(s); choose a cascade mode and retry` }]
          return [{ type: 'text' as const, text: `delete failed: ${v.error ?? '(unknown)'}` }]
        },
      },
      async execute(args) {
        const ps = requireProjectStore()
        const id = String(args.projectId ?? '').trim()
        if (!id) return { ok: false, error: 'projectId is required' }
        const mode = args.mode === 'permanent' ? 'permanent' as const : 'trash' as const
        const cascadeRaw = String(args.cascade ?? 'cancel')
        const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
        try {
          const result = await ps.deleteProject(id, mode, cascade as 'cancel' | 'break-refs' | 'migrate-shared')
          return { ok: true, result, registry: ps.snapshot() } as unknown as JsonValue
        } catch (e) {
          if (e instanceof ProjectDeleteBlockedError) {
            return { ok: false, code: 'project-referenced', dependents: e.dependents, error: e.message } as unknown as JsonValue
          }
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Asset library management tools (Agent-side wrappers over asset-routes.ts).
// All asset mutations emit `asset-changed` on the projects SSE so any open
// Media Studio tab refreshes its library panel.
// ─────────────────────────────────────────────────────────────────────────────

const ASSET_KIND_VALUES = ['character', 'scene', 'audio', 'clip'] as const
function asAssetKind(v: unknown): AssetKind | null {
  return typeof v === 'string' && (ASSET_KIND_VALUES as readonly string[]).includes(v) ? (v as AssetKind) : null
}

export function registerMediaStudioListAssetsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_list_assets',
      description:
        'List every asset in a project\'s library (categories: character / scene / audio / clip). ' +
        'Returns the metadata stored in assets/.index.json — file paths, tags, origin, copyOf ' +
        'provenance. The 4 categories correspond to the 4 tabs the GUI shows in the asset panel.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; assets?: unknown[]; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `${v.assets!.length} asset(s)` : `list failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        if (!pid) return { ok: false, error: 'projectId is required' }
        try {
          const assets = await listAssets(mst.workspaceRoot, pid, ps.resolveSourcePath(pid))
          return { ok: true, projectId: pid, assets } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioRegisterAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_register_asset',
      description:
        'Promote a canvas node\'s media into a project\'s asset library. Idempotent: re-registering ' +
        'the same canvasNodeId returns the existing asset instead of creating a duplicate. The node\'s ' +
        'media file is copied into <project>/assets/<kind>/<assetId>.<ext> and registered in the index. ' +
        '`kind` is the asset-library category (character / scene / audio / clip); canvas node type → ' +
        'default kind mapping is image→character, video→clip, music→audio.',
      parameters: {
        projectId: { type: 'string', description: 'Project id the node belongs to.', required: true },
        canvasNodeId: { type: 'string', description: 'Canvas node id to register from.', required: true },
        kind: { type: 'string', description: 'Asset category: "character" | "scene" | "audio" | "clip".', required: true },
        name: { type: 'string', description: 'Optional display name (defaults to the node label).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; created?: boolean; asset?: { id: string; name: string }; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `register failed: ${v.error}` }]
          return [{ type: 'text' as const, text: `${v.created ? 'created' : 'updated'} asset "${v.asset!.name}" (id=${v.asset!.id})` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const nodeId = String(args.canvasNodeId ?? '').trim()
        const kind = asAssetKind(args.kind)
        if (!pid || !nodeId) return { ok: false, error: 'projectId and canvasNodeId are required' }
        if (!kind) return { ok: false, error: `kind must be one of: ${ASSET_KIND_VALUES.join(', ')}` }
        try {
          const r = await registerCanvasAsset({
            wsRoot: mst.workspaceRoot,
            roots: mst.mediaRoots ?? [],
            canvasStore: mst.canvasStore,
            projectId: pid,
            sourcePath: ps.resolveSourcePath(pid),
            canvasNodeId: nodeId,
            kind,
            name: typeof args.name === 'string' ? args.name : undefined,
          })
          return { ok: true, created: r.created, asset: r.asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioUpdateAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_update_asset',
      description:
        'Update an asset\'s display name and/or tags. The underlying file (named <assetId>.<ext>) ' +
        'is untouched — rename never breaks references. Tags are capped at 12 entries.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        assetId: { type: 'string', description: 'Asset id (a-… format).', required: true },
        name: { type: 'string', description: 'Optional new display name.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tag list (max 12 entries, replaces existing).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; asset?: { name: string }; error?: string }
          return [{ type: 'text' as const, text: v.ok ? `updated asset "${v.asset!.name}"` : `update failed: ${v.error}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        if (!pid || !aid) return { ok: false, error: 'projectId and assetId are required' }
        const patch: { name?: string; tags?: string[] } = {}
        if (args.name !== undefined) patch.name = String(args.name)
        if (Array.isArray(args.tags)) patch.tags = (args.tags as unknown[]).map((x) => String(x)).slice(0, 12)
        try {
          const asset = await updateAssetMeta(mst.workspaceRoot, pid, aid, patch, ps.resolveSourcePath(pid))
          return { ok: true, asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioDeleteAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_delete_asset',
      description:
        'Delete one asset. cascade="cancel" (default) refuses when other projects hold soft refs on ' +
        'this asset and returns `{ ok:false, dependents:{...} }` so the agent can re-decide. ' +
        'cascade="migrate-shared" copies the asset into __shared and rewrites references. ' +
        'cascade="break-refs" marks every referencing canvas node `brokenAsset:true`.',
      parameters: {
        projectId: { type: 'string', description: 'Project id.', required: true },
        assetId: { type: 'string', description: 'Asset id.', required: true },
        cascade: { type: 'string', description: '"cancel" (default), "break-refs", or "migrate-shared".' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; error?: string; dependents?: { totalRefs?: number }; result?: { deletedId: string } }
          if (v.ok) return [{ type: 'text' as const, text: `deleted asset ${v.result!.deletedId}` }]
          return [{ type: 'text' as const, text: `delete failed: ${v.error ?? 'blocked'} (${v.dependents?.totalRefs ?? 0} ref(s))` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        if (!pid || !aid) return { ok: false, error: 'projectId and assetId are required' }
        const cascadeRaw = String(args.cascade ?? 'cancel')
        const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
        try {
          // Preflight so the agent sees a structured "blocked" payload matching the
          // project-level contract — the underlying deleteAsset throws AssetDeleteBlockedError
          // (we surface it as ok:false) and runScan returns the same dependents info.
          const projectIds = ps.snapshot().projects.map((p) => p.id)
          const hits = scanCanvasRefs(mst.canvasStore, projectIds.filter((x) => x !== pid), pid, aid)
          const totalRefs = hits.reduce((s, x) => s + x.nodeIds.length, 0)
          if (totalRefs > 0 && cascade === 'cancel') {
            return { ok: false, dependents: { totalRefs, hits }, error: 'asset is referenced by other projects; choose a cascade mode' } as unknown as JsonValue
          }
          const result = await deleteAsset(mst.workspaceRoot, mst.canvasStore, pid, aid, cascade as 'cancel' | 'break-refs' | 'migrate-shared', projectIds, ps.resolveSourcePath(pid))
          return { ok: true, result } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

export function registerMediaStudioCopyAssetTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_copy_asset',
      description:
        'Hard-copy an asset (file + index entry) from one project to another. Returns the new ' +
        'asset\'s id in the target project — use that with `media_studio_search_assets` or ' +
        '`canvas_graph_patch` (data.assetRef) to soft-reference it without copying again. ' +
        'Cross-project soft refs are NOT made by this tool; this only duplicates the bytes.',
      parameters: {
        projectId: { type: 'string', description: 'Source project id.', required: true },
        assetId: { type: 'string', description: 'Source asset id.', required: true },
        targetProjectId: { type: 'string', description: 'Destination project id.', required: true },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; created?: boolean; asset?: { id: string; name: string }; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `copy failed: ${v.error}` }]
          return [{ type: 'text' as const, text: `${v.created ? 'copied' : 'updated'} asset "${v.asset!.name}" → id=${v.asset!.id}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        const pid = String(args.projectId ?? '').trim()
        const aid = String(args.assetId ?? '').trim()
        const target = String(args.targetProjectId ?? '').trim()
        if (!pid || !aid || !target) return { ok: false, error: 'projectId, assetId and targetProjectId are required' }
        try {
          const r = await copyAssetToProject(
            mst.workspaceRoot,
            pid,
            aid,
            target,
            ps.resolveSourcePath(pid),
            ps.resolveSourcePath(target),
          )
          return { ok: true, created: r.created, asset: r.asset } as unknown as JsonValue
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
      },
    }),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Global search tool — wraps runSearch() and optionally drops a soft-reference
// node into the current project's canvas for the top hit.
// ─────────────────────────────────────────────────────────────────────────────

export function registerMediaStudioSearchAssetsTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'media_studio_search_assets',
      description:
        'Cross-project search across every project\'s asset library + finished canvas media nodes ' +
        '(catalog: "library" / "canvas"). Results are grouped into "current" (matches in the active ' +
        'project) and "other" (matches elsewhere). `alreadyRefCount` shows how many soft refs the ' +
        'scope project already holds for each match. When `addSoftRef=true` and exactly one item is ' +
        'supplied via `addAssetKey`, a soft-reference node is appended to the current canvas ' +
        '(`data.assetRef = { projectId, assetId }`) — no file is copied.',
      parameters: {
        q: { type: 'string', description: 'Search query (matches name > tags > prompt; substring, token AND).', required: true },
        scopeProjectId: { type: 'string', description: 'Scope project id (defaults to the active project).' },
        limit: { type: 'number', description: 'Max results per group (1–50, default 20).' },
        addSoftRef: { type: 'boolean', description: 'If true, also add a soft-reference node for the chosen asset.' },
        addAssetKey: { type: 'string', description: 'The exact `key` field from a previous search result (e.g. "library:p-abc:a-xyz"). Required when addSoftRef=true.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as { ok: boolean; hitCount?: number; addedNodeId?: string; error?: string }
          if (!v.ok) return [{ type: 'text' as const, text: `search failed: ${v.error}` }]
          const tail = v.addedNodeId ? `; soft-ref node ${v.addedNodeId} added` : ''
          return [{ type: 'text' as const, text: `${v.hitCount} hit(s)${tail}` }]
        },
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const ps = mst.projectStore
        if (!ps) return { ok: false, error: 'projectStore not initialized' }
        await ps.ready()
        const q = String(args.q ?? '')
        const scope = typeof args.scopeProjectId === 'string' && args.scopeProjectId.trim()
          ? args.scopeProjectId.trim()
          : (ps.activeCanvasId() ?? null)
        const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 20
        let result
        try {
          result = await runSearch({
            wsRoot: mst.workspaceRoot,
            canvasStore: mst.canvasStore,
            projects: ps.snapshot().projects,
            q,
            scopeProjectId: scope,
            limitPerGroup: limit,
          })
        } catch (e) {
          return { ok: false, error: (e as Error).message } as unknown as JsonValue
        }
        let addedNodeId: string | undefined
        if (args.addSoftRef && typeof args.addAssetKey === 'string' && args.addAssetKey) {
          // Decode "<catalog>:<owner>:<id>" — catalog 'canvas' isn't supported here
          // (canvas-node refs come through canvas_graph_patch + assetRef).
          const m = /^([^:]+):([^:]+):(.+)$/.exec(args.addAssetKey)
          if (!m) return { ok: false, error: `invalid addAssetKey "${args.addAssetKey}"` }
          const [, catalog, ownerId, assetId] = m
          if (catalog !== 'library') return { ok: false, error: 'addSoftRef only supports catalog=library results' }
          try {
            const asset = await resolveAsset(mst.workspaceRoot, ownerId, assetId, ps.resolveSourcePath(ownerId))
            const targetCanvas = scope ?? ps.activeCanvasId() ?? 'main'
            const r = addSoftRefToCanvas(mst.canvasStore, targetCanvas, mst.workspaceRoot, ownerId, asset, ps.resolveSourcePath(ownerId))
            addedNodeId = r.nodeId
          } catch (e) {
            return { ok: false, error: (e as Error).message } as unknown as JsonValue
          }
        }
        return { ok: true, hitCount: result.hitCount, groups: result.groups, addedNodeId } as unknown as JsonValue
      },
    }),
  )
}
