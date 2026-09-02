import { describe, it, expect } from 'vitest'
import { callLlm, listTextModels, type LlmLike } from '../src/llm-bridge'
import type { GenerateOptions, LlmModelInfo, PreparedLlmCall, LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

/**
 * Lightweight fake LlmRuntime that drives the LLM bridge through its public
 * surface. We never reach into internals; we just implement `prepareCall`
 * and assert the bridge collects chunks correctly.
 */
class FakeLlm implements LlmLike {
  /** Override these per test to drive the chunk stream. */
  chunks: StreamChunk[] = []
  prepareCallArgs: LlmCallConfig | null = null

  async prepareCall(config: LlmCallConfig, _signal?: AbortSignal): Promise<PreparedLlmCall> {
    this.prepareCallArgs = config
    const chunks = this.chunks
    return {
      config,
      retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as never,
      adapterDefaults: {},
      async *stream(_opts: GenerateOptions) {
        for (const c of chunks) yield c
      },
    }
  }

  async listModels(_provider: string): Promise<LlmModelInfo[]> {
    return [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'openai', id: 'gpt-4o-mini', name: 'GPT-4o mini' },
    ]
  }
}

describe('callLlm', () => {
  it('returns undefined llm as a clear error', async () => {
    await expect(callLlm(undefined, 'deepseek', 'deepseek-chat', 'hi', new AbortController().signal)).rejects.toThrow(/ctx\.llm is not bound/)
  })

  it('concatenates text-delta chunks into a single text', async () => {
    const llm = new FakeLlm()
    llm.chunks = [
      { type: 'text-delta', index: 0, text: 'Hello ' },
      { type: 'text-delta', index: 0, text: 'world' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const r = await callLlm(llm, 'deepseek', 'deepseek-chat', 'hi', new AbortController().signal)
    expect(r.text).toBe('Hello world')
    expect(r.model).toBe('deepseek/deepseek-chat')
  })

  it('captures usage when the adapter emits a usage chunk', async () => {
    const llm = new FakeLlm()
    llm.chunks = [
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const r = await callLlm(llm, 'deepseek', 'deepseek-chat', 'a', new AbortController().signal)
    expect(r.usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  it('passes provider / model through to prepareCall', async () => {
    const llm = new FakeLlm()
    llm.chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
    await callLlm(llm, 'openai', 'gpt-4o-mini', 'hi', new AbortController().signal)
    expect(llm.prepareCallArgs).toEqual({ provider: 'openai', model: 'gpt-4o-mini', maxTokens: 4096 })
  })

  it('honors the AbortSignal mid-stream', async () => {
    // Adapter that blocks on a signal between chunks — proves the bridge
    // propagates the abort and doesn't silently keep reading.
    function makeFakeLlm(): LlmLike {
      return {
        prepareCall: async (config: LlmCallConfig): Promise<PreparedLlmCall> => ({
          config,
          retryPolicy: { maxAttempts: 3, initialDelayMs: 100 } as never,
          adapterDefaults: {},
          async *stream(opts: GenerateOptions) {
            const signal = opts.signal
            yield { type: 'text-delta', index: 0, text: 'partial ' }
            // Wait for abort or 50ms (whichever comes first).
            await new Promise<void>((resolve, reject) => {
              const t = setTimeout(resolve, 50)
              signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')) })
            })
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }),
        listModels: async () => [],
      }
    }
    const llm = makeFakeLlm()
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 5)
    await expect(callLlm(llm, 'deepseek', 'deepseek-chat', 'hi', ac.signal)).rejects.toThrow(/aborted/i)
  })
})

describe('listTextModels', () => {
  it('returns an empty list when llm is undefined', async () => {
    const r = await listTextModels(undefined)
    expect(r).toEqual([])
  })

  it('normalizes the LLM listModels response into { provider, modelId }', async () => {
    const llm = new FakeLlm()
    const r = await listTextModels(llm)
    expect(r).toEqual([
      { provider: 'deepseek', modelId: 'deepseek-chat', displayName: 'DeepSeek Chat' },
      { provider: 'openai', modelId: 'gpt-4o-mini', displayName: 'GPT-4o mini' },
    ])
  })

  it('returns an empty list when the adapter throws (graceful)', async () => {
    const llm: LlmLike = {
      prepareCall: async () => { throw new Error('not implemented') },
      listModels: async () => { throw new Error('not supported') },
    }
    expect(await listTextModels(llm)).toEqual([])
  })
})
