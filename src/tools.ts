import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { CanvasStore, type CanvasOp, type CanvasSnapshot, type CanvasNode } from './canvas-store'
import { join } from 'node:path'
import { getMediaStudioHandles } from './service-state'

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
): Promise<{ ok: boolean; url?: string; model?: string; code?: string; message?: string }> {
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
    const v = out as { success?: boolean; videoUrl?: string; url?: string; model?: string; message?: string }
    if (v && v.success) {
      const url = v.videoUrl || v.url
      return { ok: true, url, model: v.model }
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
      resultUrl = r.url
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
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            graph: {
              type: 'object',
              additionalProperties: false,
              properties: {
                nodes: { type: 'array', items: { type: 'object' as const, additionalProperties: true as const } },
                edges: { type: 'array', items: { type: 'object' as const, additionalProperties: true as const } },
              },
            },
            version: { type: 'number' },
          },
        },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `canvas version ${(value as { version: number }).version}: ${(value as { graph: { nodes: unknown[] } }).graph.nodes.length} nodes, ${(value as { graph: { edges: unknown[] } }).graph.edges.length} edges`,
        }],
      },
      async execute(args) {
        const mst = getMediaStudioHandles()
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        return store.snapshot(canvasId) as unknown as object
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
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'number' },
            version: { type: 'number' },
            lintOk: { type: 'boolean' },
            issues: { type: 'array', items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{
          type: 'text' as const,
          text: `applied ${(value as { applied: number }).applied} ops → version ${(value as { version: number }).version}; lint: ${(value as { lintOk: boolean }).lintOk ? 'pass' : 'warnings'}`,
        }],
      },
      async execute(args) {
        const store = getMediaStudioHandles().canvasStore
        const canvasId = args.canvasId?.trim() || resolveCanvasId()
        const ops = Array.isArray(args.ops) ? (args.ops as unknown as CanvasOp[]) : []
        if (ops.length === 0) throw new Error('canvas_graph_patch: ops must be a non-empty array')
        if (ops.length > 60) throw new Error(`canvas_graph_patch: batch too large (${ops.length} ops, max 60)`)
        const result = store.apply(canvasId, ops)
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
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            applied: { type: 'number' },
            version: { type: 'number' },
            lintOk: { type: 'boolean' },
            issues: { type: 'array', items: { type: 'string' } },
          },
        },
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
