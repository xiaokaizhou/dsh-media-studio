import { defineTool, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
// Side-effect import — picks up the cordis `Context` augmentation declared
// in index.ts (`ctx.mediaStudio: { getSettings(), workspaceRoot, llm, canvasStore }`).
// Without it, TS would only see the bare `Context` and error on `.getSettings`.
import './index'
import { callLlm } from './llm-bridge'
import { generateImage, generateVideo, generateMusic, MediaError, type MediaProviderConfig, type MediaMusicConfig } from './media-providers'
import { CanvasStore, type CanvasOp, type CanvasSnapshot } from './canvas-store'
import { join } from 'node:path'
import { DEFAULT_MEDIA_STUDIO, type MediaStudioSettingsShape } from './settings'

/**
 * Resolve the mediaStudio settings into a per-modality config object the
 * media-providers.ts client can consume. Falls back to DEFAULT_MEDIA_STUDIO
 * when the user section is empty so first-run works out of the box.
 */
function pickProvider(kind: 'image' | 'video'): MediaProviderConfig {
  const mst = ctxMediaStudio() as unknown as { getSettings(): MediaStudioSettingsShape }
  return mst.getSettings()[kind]
}
function pickMusic(): MediaMusicConfig {
  const mst = ctxMediaStudio() as unknown as { getSettings(): MediaStudioSettingsShape }
  return mst.getSettings().music
}

// Tiny indirection so tools can call `ctxMediaStudio()` from inside tool
// closures without capturing `ctx` in their scope. Replaced at module load
// by `installMediaTools(ctx)` which mutates the binding.
let _ctx: Context | null = null
function ctxMediaStudio(): NonNullable<typeof _ctx> {
  if (!_ctx) throw new MediaError('not-initialized', 'media-studio tools were called before apply() ran')
  return _ctx
}

/** Bound at apply() so the tool closures can read `ctx.mediaStudio`. */
export function bindMediaStudioContext(ctx: Context, store: CanvasStore): void {
  _ctx = ctx
  ctx.mediaStudio.canvasStore = store
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool output schema: one canonical shape per tool — `{ ok, url, model, ... }`
// plus a `render` that wraps the structured value in chat-friendly prose.
// ─────────────────────────────────────────────────────────────────────────────

// Each media tool returns ONE canonical shape — a discriminated union over
// the `ok` boolean. This lets the registry pass it through lossless JSON,
// and lets the renderer pick the right prose path per branch.
//
// Schema must declare the union (oneOf) so `InferValue<O>` widens to the
// full union and TypeScript stops collapsing the return to `never`.

const okImageOutput = {
  schema: {
    oneOf: [
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: true },
          url: { type: 'string' as const },
          model: { type: 'string' as const },
          bytes: { type: 'number' as const },
          latencyMs: { type: 'number' as const },
          kind: { type: 'string' as const, const: 'image' as const },
        },
      },
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: false as const },
          code: { type: 'string' as const },
          message: { type: 'string' as const },
          kind: { type: 'string' as const, const: 'image' as const },
        },
      },
    ],
  },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: (value as { ok: boolean; url?: string; code?: string; message?: string }).ok
      ? `image generated: ${(value as { url: string }).url}`
      : `image failed (${(value as { code: string }).code}): ${(value as { message: string }).message}`,
  }],
} satisfies { schema: ValueSchemaSpec; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }
const okVideoOutput = {
  schema: {
    oneOf: [
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: true },
          url: { type: 'string' as const },
          model: { type: 'string' as const },
          bytes: { type: 'number' as const },
          latencyMs: { type: 'number' as const },
          kind: { type: 'string' as const, const: 'video' as const },
        },
      },
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: false as const },
          code: { type: 'string' as const },
          message: { type: 'string' as const },
          kind: { type: 'string' as const, const: 'video' as const },
        },
      },
    ],
  },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: (value as { ok: boolean; url?: string; code?: string; message?: string }).ok
      ? `video generated: ${(value as { url: string }).url}`
      : `video failed (${(value as { code: string }).code}): ${(value as { message: string }).message}`,
  }],
} satisfies { schema: ValueSchemaSpec; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }

const okMusicOutput = {
  schema: {
    oneOf: [
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: true },
          url: { type: 'string' as const },
          model: { type: 'string' as const },
          bytes: { type: 'number' as const },
          latencyMs: { type: 'number' as const },
          voice: { type: 'string' as const },
          kind: { type: 'string' as const, const: 'audio' as const },
        },
      },
      {
        type: 'object' as const,
        additionalProperties: false as const,
        properties: {
          ok: { type: 'boolean' as const, const: false as const },
          code: { type: 'string' as const },
          message: { type: 'string' as const },
          voice: { type: 'string' as const },
          kind: { type: 'string' as const, const: 'audio' as const },
        },
      },
    ],
  },
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: (value as { ok: boolean; url?: string; code?: string; message?: string }).ok
      ? `audio generated: ${(value as { url: string }).url}`
      : `audio failed (${(value as { code: string }).code}): ${(value as { message: string }).message}`,
  }],
} satisfies { schema: ValueSchemaSpec; render: (args: any, value: any) => Array<{ type: 'text'; text: string }> }

// ─────────────────────────────────────────────────────────────────────────────
// Tool registration — one tool per modality, all reading from mediaStudio.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `canvas_graph_view` — read the current canvas snapshot. Agents should
 * call this before `canvas_graph_patch` so they don't operate blind.
 */
export function registerCanvasViewTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_view',
      description: 'Read the current canvas graph (nodes + edges) for a canvas. Returns JSON; pass canvasId to disambiguate when the user has multiple canvases open (defaults to the plugin-wide defaultCanvasId).',
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
      async execute(args, exec) {
        const mst = ctxMediaStudio() as unknown as { canvasStore: CanvasStore; getSettings(): MediaStudioSettingsShape }
        const store = mst.canvasStore
        const canvasId = args.canvasId?.trim() || mst.getSettings().textModel || 'main'
        return store.snapshot(canvasId || 'main') as unknown as object
      },
    }),
  )
}

/**
 * `canvas_graph_patch` — batched, atomic canvas mutation. This is the
 * primary tool the agent uses to "operate the canvas" from conversation.
 *
 * Why batch ops (vs. addNode / updateNode / deleteNode as separate tools)?
 *   - Atomic: the whole batch applies or nothing does. The agent can plan
 *     a 10-node workflow and ship it in one turn; no half-drawn canvases.
 *   - Cheap: model output tokens don't grow with tool count.
 *   - Composable: media-generate returns a nodeId that the next patch uses,
 *     and `batchAddMedia` lets the agent dump several results in one op.
 *
 * The store applies the 4-guard pattern from workflow-one (no-graph /
 * stale-version / empty-regression), persists to disk, and fires an SSE
 * event so the canvas tab reflects the change live.
 */
export function registerCanvasPatchTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'canvas_graph_patch',
      description:
        'Batch-apply canvas graph ops atomically. Ops: addNode (type: text|image|video|music|note, label, data?, position?); updateNode (id, data); renameNode (id, label); deleteNode (id); moveNode (id, position); connect (from, to, branch?); deleteEdge (id); batchAddMedia (items: [{kind, url, prompt?, model?, position?, nodeId?}]). On reject, the whole batch fails — fix the lint hint and retry.',
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
      async execute(args, exec) {
        const store = (ctxMediaStudio() as unknown as { canvasStore: CanvasStore }).canvasStore
        const canvasId = args.canvasId?.trim() || 'main'
        const ops = Array.isArray(args.ops) ? (args.ops as unknown as CanvasOp[]) : []
        if (ops.length === 0) throw new Error('canvas_graph_patch: ops must be a non-empty array')
        if (ops.length > 60) throw new Error(`canvas_graph_patch: batch too large (${ops.length} ops, max 60)`)
        const result = store.apply(canvasId, ops)
        // Persist + SSE notify (SSE handler is registered by registerRoutes).
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

export function registerGenerateTextTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_text',
      description:
        'Generate text via the harness-configured LLM. Uses whatever provider the user picked in DSH settings (DeepSeek / OpenAI / Anthropic / Agnes / etc.). Model id is the DSH-style "<provider>/<model>" pair, e.g. "deepseek/deepseek-chat".',
      parameters: {
        prompt: {
          type: 'string', required: true,
          description: 'The user prompt to send. Plain text only — multi-modal content blocks live behind separate tools.',
        },
        model: {
          type: 'string',
          description: 'Optional "<provider>/<model>" override. If blank, uses mediaStudio.textModel from settings; if that is also blank, falls back to the harness default.',
        },
        system: {
          type: 'string',
          description: 'Optional system prompt. Passed through to GenerateOptions.system (adapters map to the provider system slot).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string' },
            model: { type: 'string' },
            usage: {
              type: 'object',
              additionalProperties: false,
              properties: {
                inputTokens: { type: 'number' },
                outputTokens: { type: 'number' },
              },
            },
            latencyMs: { type: 'number' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { text: string }).text || '(empty response)',
        }],
      },
      async execute(args, exec) {
        const mst = ctx.mediaStudio
        const configured = (args.model?.trim() || mst.getSettings().textModel || '').trim()
        // Split "<provider>/<model>" into provider + model. Empty provider
        // falls back to whatever the harness considers default.
        let provider = ''
        let model = configured
        const slash = configured.indexOf('/')
        if (slash > 0) {
          provider = configured.slice(0, slash)
          model = configured.slice(slash + 1)
        }
        return callLlm(
          mst.llm as Parameters<typeof callLlm>[0],
          provider,
          model,
          args.system ? `${args.system}\n\n${args.prompt}` : args.prompt,
          exec.signal,
        )
      },
    }),
  )
}

export function registerGenerateImageTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_image',
      description:
        'Generate an image via the user-configured mediaStudio.image provider. Any OpenAI-compatible provider works (Agnes, OpenAI, xAI Grok, etc.). Provider config (baseURL / apiKey / defaultModel) is read live from the mediaStudio settings namespace.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Image prompt.' },
        model: { type: 'string', description: 'Override mediaStudio.image.defaultModel for this call.' },
        aspectRatio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], description: 'Optional aspect ratio. Mapped to OpenAI size when the provider honors it.' },
        refImageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute URLs of reference images for image-to-image (multi-reference fusion). The provider may ignore this.',
        },
      },
      output: okImageOutput,
      async execute(args, exec) {
        const cfg = pickProvider('image')
        const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const outPath = join(workspaceRoot(), 'web-jobs', `${jobId}.png`)
        try {
          const r = await generateImage(cfg, {
            prompt: args.prompt,
            model: args.model,
            aspectRatio: args.aspectRatio as '1:1' | '16:9' | '9:16' | '4:3' | '3:4' | undefined,
            refImages: Array.isArray(args.refImageUrls) ? args.refImageUrls as string[] : undefined,
            outPath,
            signal: exec.signal,
          })
          return {
            ok: true as const,
            url: r.url,
            model: r.model,
            bytes: r.bytes,
            latencyMs: r.latencyMs,
            kind: 'image' as const,
          }
        } catch (e) {
          return errorResult(e, 'image')
        }
      },
    }),
  )
}

export function registerGenerateVideoTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_video',
      description:
        'Generate a short video via the user-configured mediaStudio.video provider. Submit+poll flow — the call may block 30-90s for typical 5s clips. Honor exec.signal for cancellation.',
      parameters: {
        prompt: { type: 'string', required: true, description: 'Video motion/scene prompt.' },
        model: { type: 'string', description: 'Override mediaStudio.video.defaultModel.' },
        aspectRatio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        durationS: { type: 'number', description: 'Integer 4-12s for most providers. Honored as-is.' },
        refImageUrls: { type: 'array', items: { type: 'string' }, description: 'First frame reference (image-to-video).' },
      },
      output: okVideoOutput,
      async execute(args, exec) {
        const cfg = pickProvider('video')
        const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const outPath = join(workspaceRoot(), 'web-jobs', `${jobId}.mp4`)
        try {
          const r = await generateVideo(cfg, {
            prompt: args.prompt,
            model: args.model,
            aspectRatio: args.aspectRatio as '16:9' | '9:16' | '1:1' | '4:3' | '3:4' | undefined,
            durationS: args.durationS,
            refImages: Array.isArray(args.refImageUrls) ? args.refImageUrls as string[] : undefined,
            outPath,
            signal: exec.signal,
          })
          return {
            ok: true as const,
            url: r.url,
            model: r.model,
            bytes: r.bytes,
            latencyMs: r.latencyMs,
            kind: 'video' as const,
          }
        } catch (e) {
          return errorResult(e, 'video')
        }
      },
    }),
  )
}

export function registerGenerateMusicTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_music',
      description:
        'Synthesize a voice clip via the user-configured mediaStudio.music provider (MiniMax TTS or any OpenAI-compat /audio/speech endpoint). Returns an mp3 file. Reads `text` as the literal text to speak aloud.',
      parameters: {
        text: { type: 'string', required: true, description: 'Literal text to speak aloud. NOT a song lyric — TTS reads this verbatim.' },
        voice: { type: 'string', description: 'Voice preset id (e.g. "male-qn-jingying"). Falls back to mediaStudio.music.voice.' },
        speed: { type: 'number', description: 'Speech speed 0.5–2.0. Default 1.0.' },
      },
      output: okMusicOutput,
      async execute(args, exec) {
        const cfg = pickMusic()
        const jobId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
        const outPath = join(workspaceRoot(), 'web-jobs', `${jobId}.mp3`)
        try {
          const r = await generateMusic(cfg, {
            text: args.text,
            voice: args.voice,
            speed: args.speed,
            outPath,
            signal: exec.signal,
          })
          return {
            ok: true as const,
            url: r.url,
            model: r.model,
            bytes: r.bytes,
            latencyMs: r.latencyMs,
            voice: args.voice || cfg.voice,
            kind: 'audio' as const,
          }
        } catch (e) {
          return errorResult(e, 'audio')
        }
      },
    }),
  )
}

// ── shared helpers ─────────────────────────────────────────────────────────

type ImageError = { ok: false; code: string; message: string; kind: 'image' }
type VideoError = { ok: false; code: string; message: string; kind: 'video' }
type AudioError = { ok: false; code: string; message: string; voice?: string; kind: 'audio' }

function errorResult(e: unknown, kind: 'image'): ImageError
function errorResult(e: unknown, kind: 'video'): VideoError
function errorResult(e: unknown, kind: 'audio'): AudioError
function errorResult(e: unknown, kind: 'image' | 'video' | 'audio'): ImageError | VideoError | AudioError {
  const code = e instanceof MediaError ? e.code : (e instanceof Error ? 'unknown' : 'unknown')
  const message = e instanceof Error ? e.message : String(e)
  if (kind === 'audio') return { ok: false as const, code, message, kind }
  return { ok: false as const, code, message, kind } as AudioError | ImageError | VideoError
}

/** Resolve workspaceRoot from the plugin's cordis config. We read it back
 *  from the ctx extension set in apply(). */
function workspaceRoot(): string {
  const mst = ctxMediaStudio() as unknown as { workspaceRoot?: string }
  return mst.workspaceRoot || `${process.env.HOME || '~'}/.franklin/media-studio`
}
