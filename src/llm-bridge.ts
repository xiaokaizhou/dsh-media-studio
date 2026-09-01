import { MessageId, type LlmRuntime } from '@deepseek-ai/dsh-llm'

/**
 * Type-only subset of the LlmRuntime surface we depend on. We type against
 * the real `LlmRuntime` (declared via `import '@deepseek-ai/dsh-llm'` in
 * index.ts so the cordis context augmentation is in scope), but document
 * only the methods we call. Replace this with the full `LlmRuntime`
 * once we exercise more of it.
 */
export type LlmLike = Pick<LlmRuntime, 'prepareCall' | 'listModels'>

/**
 * Result of one model call — collected text plus optional usage stats and
 * the resolved model id (so the caller can surface it to the user).
 */
export interface CallLlmResult {
  /** Concatenation of every `text-delta` chunk from the model. */
  text: string
  /** Resolved provider/model identity as the harness recorded it. */
  model: string
  /** Token usage if the adapter emitted a `usage` chunk. */
  usage: { inputTokens: number; outputTokens: number }
  /** Wall-clock latency for the call. */
  latencyMs: number
}

/**
 * Send one prompt to the configured LLM and collect the streamed text.
 *
 * Why a thin wrapper?
 *   The harness's `LlmRuntime.stream(...)` is an async iterable of
 *   `StreamChunk` events. Tools must return canonical JSON values (not
 *   strings), so callers expect a synchronous-looking object. This
 *   helper drains the stream into a single `{ text, model, usage }` so
 *   tool code stays a one-liner.
 *
 * Cancellation:
 *   We respect the tool exec's AbortSignal. If it aborts mid-stream,
 *   the adapter will surface the abort and we propagate as a thrown
 *   DOMException; the DSH tools pipeline turns it into an `isError`
 *   result, never a silent half-answer.
 */
export async function callLlm(
  llm: LlmLike | undefined,
  provider: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
): Promise<CallLlmResult> {
  if (!llm) {
    throw new Error('dsh-media-studio: ctx.llm is not bound — the harness is running without an LLM adapter. Check `~/.dsh/settings.yaml`.')
  }

  const t0 = Date.now()
  const prep = await llm.prepareCall({ provider, model, maxTokens: 4096 }, signal)

  let text = ''
  let usage = { inputTokens: 0, outputTokens: 0 }
  let resolvedModel = `${provider}/${model}`

  for await (const chunk of prep.stream({
    // `PreparedAdapterCall.stream` still expects a full `GenerateOptions`
    // shape (provider + model echoed back) — it is the runtime variant
    // of `LlmAdapter.stream`. The harness validates the config matches the
    // prepared call before dispatch.
    provider,
    model,
    messages: [{
      // DSH requires `id` and `source` on every Message. For a one-shot
      // tool call we mint a fresh id; `source.kind = 'user'` matches the
      // role we picked.
      id: MessageId(`media-studio:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`),
      role: 'user',
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }],
    signal, // forward cancellation so adapters can short-circuit
  })) {
    // StreamChunk is a discriminated union; we narrow by `type` and only
    // handle the chunks that contribute text or usage. Reasoning and tool-call
    // chunks are passed through (model may emit them while answering).
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        break
      case 'usage':
        usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
        break
      case 'block-end':
        // `block-end` carries the authoritative whole block (text / tool-call
        // / reasoning / etc.). For text blocks we could replace our streaming
        // concat with the verbatim value, but text-delta accumulation is
        // identical for any well-behaved adapter and avoids trusting one
        // path over another. Tool-call / reasoning blocks: ignore — we are
        // a plain-text endpoint.
        break
      case 'block-start':
      case 'finish':
      case 'reasoning-delta':
      case 'tool-call-delta':
        // Either terminator or non-text block — ignore for plain text gen.
        break
      default: {
        // Exhaustiveness guard — if a new chunk type lands we want to know.
        const _exhaustive: never = chunk
        void _exhaustive
      }
    }
  }

  return {
    text,
    model: resolvedModel,
    usage,
    latencyMs: Date.now() - t0,
  }
}

/**
 * Enumerate every provider × model the user has already configured with
 * the harness. The canvas settings UI surfaces this list so the user can
 * pick a model without re-typing the id. Media (image / video / audio)
 * models do NOT come from here — those need their own provider configs in
 * `mediaStudio` settings because they are not LLMs.
 */
export interface DiscoveredModel {
  provider: string
  modelId: string
  displayName?: string
}

export async function listTextModels(llm: LlmLike | undefined): Promise<DiscoveredModel[]> {
  if (!llm) return []
  // Each adapter registers an opaque listModels(provider) helper; we
  // probe with an empty string and let the adapter decide whether to
  // return all routes or only the default one.
  const out: DiscoveredModel[] = []
  try {
    const models = await llm.listModels('') as Array<{ provider?: string; id: string; name?: string }>
    for (const m of models) {
      if (m.provider) out.push({ provider: m.provider, modelId: m.id, displayName: m.name })
    }
  } catch {
    // Not all adapters implement listModels — swallow so the caller
    // (settings UI) renders an empty picker instead of an error.
  }
  return out
}
