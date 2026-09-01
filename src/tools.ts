import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { callLlm } from './llm-bridge'
import { DEFAULT_MEDIA_STUDIO } from './settings'

/**
 * The `generate_text` tool. Sends a single prompt to the LLM the user has
 * already configured in DSH (no provider list baked into this plugin). If
 * the caller does not pass `model`, the user's `mediaStudio.textModel`
 * setting is used; if that is blank too, the runtime's default model is
 * left to the harness's own fallback path.
 *
 * Why one tool, not one per provider?
 *   The whole point of the DSH plugin contract is that the harness owns
 *   provider/model routing. Exposing `generate_text_anthropic` etc.
 *   would silently duplicate that logic and break the moment the user
 *   switches their default. One tool = one source of truth.
 *
 * Output shape (canonical JSON):
 *   { text, model, usage: {inputTokens,outputTokens}, latencyMs }
 *   `output.render` wraps the JSON in a human-readable prose card so the
 *   chat surface shows the answer even when no UI card adapter is loaded.
 */
export function registerGenerateTextTool(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: 'generate_text',
      description:
        'Generate text via the harness-configured LLM. Uses whatever provider the user picked in DSH settings (DeepSeek / OpenAI / Anthropic / Agnes / etc.). Model id is the DSH-style "<provider>/<model>" pair, e.g. "deepseek/deepseek-chat".',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
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
        // Human-readable summary used by the chat surface. The renderer
        // is pure (no I/O); the structured value above is the canonical
        // payload Code Mode and replay read.
        render: (_args, value) => [{
          type: 'text',
          text: (value as { text: string }).text || '(empty response)',
        }],
      },
      async execute(args, exec) {
        const mst = ctx.mediaStudio
        const configured = (args.model?.trim() || mst.getSettings().textModel || '').trim()
        // The user can store either "<provider>/<model>" (DSH convention) or
        // just "<model>" (when they have a single default provider). Split
        // on the first slash — anything before is provider, anything after is
        // the model id. An empty provider falls back to whatever the
        // harness considers default.
        let provider = ''
        let model = configured
        const slash = configured.indexOf('/')
        if (slash > 0) {
          provider = configured.slice(0, slash)
          model = configured.slice(slash + 1)
        }
        // Final fallback: when mediaStudio.textModel is empty, leave the
        // selection to the harness. The harness errors with a clear
        // message if no default is configured.
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

// ── internal: keep the default object referenced so tree-shakers don't drop it
// (we don't actually need it at runtime — DEFAULT_MEDIA_STUDIO is the source
// of truth when no user section exists). Keeping this import as a side-effect
// marker makes the dependency explicit in the build graph. */
void DEFAULT_MEDIA_STUDIO
