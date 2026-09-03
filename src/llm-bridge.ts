// The plugin used to `import { MessageId, type LlmRuntime } from
// '@deepseek-ai/dsh-llm'`. `MessageId` is a brand factory function that
// returns the same string it was given. Pulling it as a value forced
// rolldown to keep `require('@deepseek-ai/dsh-llm')` in the bundle, and
// the @deepseek-ai/dsh-llm runtime ships a top-of-file
// `import { createRequire } from "node:module"` attribution header that
// the DSH client-modules loader has no way to resolve (browser-only
// module table; no `node:` seeds). Outcome: the BROWSER entry's factory
// aborted with `require("node:module") missed the module table`.
//
// We reproduce `MessageId` as a type-only re-export from the package's
// .d.ts augmentation (no runtime call). The brand identity
// (`string & { readonly [BRAND]: 'MessageId' }`) is owned by
// `@deepseek-ai/dsh-brand` and we cannot mint an equivalent locally.
// Instead, we declare an internal type alias and cast at the boundary
// (the only call site: `prep.stream({ messages: [{ id, ... }] })`).
// The cast is identity-safe — `MessageId(id)` is literally `(id) => id`
// in the real package, so a plain string cast back to that brand is
// observably indistinguishable from a real brand at runtime.
import type { MessageId as MessageIdReal, LlmRuntime } from '@deepseek-ai/dsh-llm'
/** Identity brand factory — `MessageId(id) === id` at runtime. */
export const MessageId = (id: string): MessageIdReal => id as unknown as MessageIdReal
export type MessageId = MessageIdReal

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
 * One provider × model pair surfaced from the harness's LLM runtime. The
 * settings card uses these for both the text-model picker and the media
 * provider/model dropdowns. We deliberately do NOT pretend image / video /
 * music live on ctx.llm — those are custom media providers, surfaced
 * separately through their own provider picker.
 */
export interface DiscoveredModel {
  provider: string
  modelId: string
  displayName?: string
  description?: string
  inputModalities?: readonly string[]
}

/**
 * Modality tag used by the settings card to filter the model list per
 * picker. Matches the DSH `ModelModality` type (`'text' | 'image'`); we
 * keep the type narrow here because the card only needs to discriminate
 * text from image/video.
 */
export type ModelModality = 'text' | 'image'

interface LlmModelInfoLike {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly { toString(): string }[]
}

interface LlmLikeFull {
  /** One sync call returning every registered provider. */
  listProviders(): Array<{ id: string; name: string }>
  /** One async call listing models the adapter advertises for `provider`. */
  listModels(provider: string): Promise<readonly LlmModelInfoLike[]>
  /** Optional — used by `discoverMediaModels` for endpoint interrogation. */
  discoverModels?(settingsNs: string, request: {
    provider?: string
    baseURL?: string
    apiKey?: string
    signal?: AbortSignal
  }): Promise<Array<{ id: string; name?: string }>>
}

/**
 * Enumerate every provider × model the user has already configured with
 * the harness. Iterates over `listProviders()` so we do not depend on
 * adapters honouring an empty-string probe (which is not part of the
 * `LlmRuntime.listModels` contract).
 *
 * `listProviders()` returns only currently-registered providers (i.e. those
 * with an active adapter); adapters that are configurable but dormant are
 * listed separately via `listConfigurableProviders`. Media-studio merges
 * both into the picker so a user can pre-fill a profile from a dormant
 * provider and activate it through their existing settings.yaml edit.
 */
export async function listTextModels(llm: LlmLike | LlmLikeFull | undefined): Promise<DiscoveredModel[]> {
  if (!llm) return []
  const out: DiscoveredModel[] = []
  const seen = new Set<string>()
  const addOne = (m: LlmModelInfoLike): void => {
    if (!m.provider || !m.id) return
    const key = `${m.provider}/${m.id}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      provider: m.provider,
      modelId: m.id,
      displayName: m.name,
      description: m.description,
      inputModalities: m.inputModalities?.map((mod) => mod.toString()),
    })
  }
  const tryListModels = (providerId: string): Promise<readonly LlmModelInfoLike[]> => {
    const fn = (llm as LlmLikeFull).listModels
    if (typeof fn !== 'function') return Promise.resolve([])
    return Promise.resolve(fn.call(llm, providerId)).catch(() => [])
  }
  // 1. Active providers (those with a registered adapter).
  let activeIds: string[] = []
  try {
    if (typeof (llm as LlmLikeFull).listProviders === 'function') {
      activeIds = (llm as LlmLikeFull).listProviders().map((p) => p.id)
    } else {
      activeIds = [''] // legacy adapter that probed all from listModels('')
    }
  } catch {
    activeIds = []
  }
  for (const pid of activeIds) {
    const models = await tryListModels(pid)
    for (const m of models) addOne(m)
  }
  return out
}

/**
 * Models whose `inputModalities` include the requested modality, OR whose
 * modalities are absent (DSH convention: "absence means unknown, not
 * incapable"). Models that explicitly carry the OPPOSITE modality are
 * excluded — an image-only model never surfaces in the text picker.
 */
export function filterModelsByModality(
  models: readonly DiscoveredModel[],
  modality: ModelModality,
): DiscoveredModel[] {
  return models.filter((m) => {
    const mods = m.inputModalities
    if (!mods || mods.length === 0) return true // unknown → include
    return mods.includes(modality)
  })
}

/**
 * `provider/modelId` strings grouped by provider, in adapter-preferred
 * order. Used by the picker dropdowns.
 */
export function groupModelsByProvider(
  models: readonly DiscoveredModel[],
): Map<string, DiscoveredModel[]> {
  const byProvider = new Map<string, DiscoveredModel[]>()
  for (const m of models) {
    const arr = byProvider.get(m.provider) ?? []
    arr.push(m)
    byProvider.set(m.provider, arr)
  }
  return byProvider
}

/**
 * Pick the rows the picker renders. Each row carries `value` (the
 * `provider/modelId` string the card writes to the settings namespace) and
 * a human-readable `label`.
 */
export function modelPickerEntries(
  models: readonly DiscoveredModel[],
): Array<{ value: string; label: string; provider: string; modelId: string; displayName?: string }> {
  const out: Array<{ value: string; label: string; provider: string; modelId: string; displayName?: string }> = []
  for (const m of models) {
    const value = `${m.provider}/${m.modelId}`
    const label = m.displayName && m.displayName !== m.modelId
      ? `${m.displayName} · ${value}`
      : value
    out.push({ value, label, provider: m.provider, modelId: m.modelId, displayName: m.displayName })
  }
  return out
}

/**
 * List provider routes the harness exposes, regardless of whether they are
    currently registered or only declared in the configurable-provider directory.
    The settings card uses this to populate the "provider" dropdowns for
    image / video / music.
 */
export interface LlmProviderRow {
  id: string
  displayName: string
  /** Whether the route is currently active (has a registered adapter). */
  active: boolean
  /** Optional baseURL from the provider profile, when discoverable. */
  baseURL?: string
}

export function listProviderRoutes(llm: LlmLikeFull | undefined): LlmProviderRow[] {
  if (!llm) return []
  const out: LlmProviderRow[] = []
  const seen = new Set<string>()
  // 1. Active providers (registered adapter) — baseURL unknown here.
  if (typeof llm.listProviders === 'function') {
    try {
      for (const p of llm.listProviders()) {
        if (seen.has(p.id)) continue
        seen.add(p.id)
        out.push({ id: p.id, displayName: p.name || p.id, active: true })
      }
    } catch { /* swallow */ }
  }
  // 2. Configurable providers (declared but possibly dormant).
  //    We re-use the `discoverModels` API surface by looking at the
  //    configurable-provider directory if available; otherwise fall back
  //    to whatever the configured llm-pi-ai section declared on disk
  //    (see `readPiAiProvidersSnapshot`).
  for (const row of readPiAiProvidersSnapshot()) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    out.push({ id: row.id, displayName: row.displayName, active: out.some((r) => r.id === row.id), baseURL: row.baseURL })
  }
  return out
}

/**
 * One row the settings card can use to pre-fill a media provider profile:
 * the provider id, its display name, and its declared baseURL (so we can
 * auto-populate the baseURL field).
 */
export interface PiAiProviderSnapshot {
  id: string
  displayName: string
  baseURL?: string
  apiKeyEnv?: string
}

/**
 * Read the `llm-pi-ai` section from the live settings document and flatten
 * it to one row per provider. The media-studio settings card uses this to
 * show the user which providers are already wired up in DSH, without
 * asking the user to retype their baseURL / apiKeyEnv.
 *
 * Implementation note: we read through `fs` only on the Node host (the
 * settings panel card calls this through the `/api/media-studio/providers`
 * endpoint, which runs on the server). The client side gets the same
 * snapshot over JSON.
 */
export function readPiAiProvidersSnapshot(): PiAiProviderSnapshot[] {
  // Lazy import so a browser-only bundle never pulls in node:fs. The server
  // entry (routes.ts) is the only caller; the require() calls are evaluated
  // lazily on the host.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os')
  // yaml package (declared dep). The full DSH settings file uses YAML flow
  // style for arrays/objects (`models: [{ id: MiniMax-M3 }]`); a hand-
  // rolled lite parser would misread them, so we delegate to `yaml`.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const yaml: typeof import('yaml') = require('yaml')

  const home = nodeOs.homedir()
  const candidates = [
    process.env.DSH_SETTINGS_PATH,
    nodePath.join(home, '.dsh', 'settings.yaml'),
    nodePath.join(home, '.dsh', 'settings.yml'),
    nodePath.join(home, '.dsh', 'settings.json'),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)

  for (const path of candidates) {
    if (!nodeFs.existsSync(path)) continue
    try {
      const text = nodeFs.readFileSync(path, 'utf8')
      const isJson = nodePath.extname(path).toLowerCase() === '.json'
      const doc = isJson ? JSON.parse(text) : yaml.parse(text)
      if (!doc || typeof doc !== 'object') continue
      const piAi = (doc as Record<string, unknown>)['llm-pi-ai'] as { providers?: Record<string, Record<string, unknown>> } | undefined
      if (!piAi?.providers) continue
      const out: PiAiProviderSnapshot[] = []
      for (const [id, profile] of Object.entries(piAi.providers)) {
        if (!profile || typeof profile !== 'object') continue
        const baseURL = typeof profile['baseURL'] === 'string' ? (profile['baseURL'] as string) : undefined
        const displayName = typeof profile['displayName'] === 'string' ? (profile['displayName'] as string) : id
        const apiKeyEnv = typeof profile['apiKeyEnv'] === 'string' ? (profile['apiKeyEnv'] as string) : undefined
        out.push({ id, displayName, baseURL, apiKeyEnv })
      }
      if (out.length > 0) return out
    } catch {
      // try next candidate
    }
  }
  return []
}
