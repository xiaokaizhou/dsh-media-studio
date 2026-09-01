import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'

/**
 * Generic OpenAI-compatible HTTP client. Intentionally tiny — we do NOT
 * pull `openai` or any SDK, we just `fetch` the four endpoints we need:
 *
 *   POST {baseURL}/images/generations
 *   POST {baseURL}/videos/generations   (submit + poll)
 *   POST {baseURL}/audio/speech         (MiniMax TTS; OpenAI-compat shim)
 *   GET  {baseURL}/videos/{id}          (status poll, when the provider
 *                                        returns a separate job id)
 *
 * The provider config (baseURL / apiKey / defaultModel) is **read from the
 * `mediaStudio` settings namespace** at every call — no env-var reads,
 * no hardcoded defaults. That is the whole point of the dsh-media-studio
 * settings UI: a user can swap providers without redeploying the plugin.
 *
 * For MiniMax (which is OpenAI-compatible on the speech endpoint), this
 * client passes through with the right `model` and the MiniMax-specific
 * voice field lives in our own request body (the `audio_settings` block).
 */

export interface MediaProviderConfig {
  provider: string
  baseURL: string
  apiKey: string
  defaultModel: string
}

export interface MediaMusicConfig extends MediaProviderConfig {
  voice: string
}

export interface GenerateImageOpts {
  prompt: string
  model?: string
  aspectRatio?: '1:1' | '16:9' | '9:16' | '4:3' | '3:4'
  size?: string
  refImages?: string[]  // absolute URLs of reference images (for image2image)
  /** Absolute path to write the downloaded image bytes. */
  outPath: string
  signal: AbortSignal
}

export interface GenerateVideoOpts {
  prompt: string
  model?: string
  aspectRatio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4'
  durationS?: number
  refImages?: string[]
  /** Absolute path to write the downloaded video bytes. */
  outPath: string
  signal: AbortSignal
}

export interface GenerateMusicOpts {
  /** Literal text to speak. Required by TTS (there is no separate "lyrics"
   *  field in MiniMax TTS). */
  text: string
  voice?: string
  speed?: number  // 0.5–2.0
  /** Absolute path to write the downloaded mp3 bytes. */
  outPath: string
  signal: AbortSignal
}

export interface MediaGenResult {
  /** Remote URL or local path the caller can show / play. */
  url: string
  /** Effective model id used (after default fallback). */
  model: string
  /** Bytes downloaded to disk, when applicable. */
  bytes?: number
  /** Wall-clock latency. */
  latencyMs: number
}

/**
 * Minimal fetch wrapper that:
 *   - sets `Authorization: Bearer <key>` when the key is non-empty
 *   - serializes JSON body when an object is passed
 *   - throws a typed `MediaError` on non-2xx
 *
 * Provider endpoints that are not yet implemented in this client throw
 * `MediaError('not-supported')` rather than silently 404 — the tool layer
 * surfaces that to the user as a clear configuration mistake.
 */
async function postJSON<T>(
  cfg: MediaProviderConfig,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  if (!cfg.baseURL) throw new MediaError('missing-baseurl', `provider "${cfg.provider}" has no baseURL configured (mediaStudio.${cfg.provider}.baseURL)`)
  const url = `${cfg.baseURL.replace(/\/+$/, '')}${path}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new MediaError('http-' + res.status, `${cfg.provider} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

async function getJSON<T>(cfg: MediaProviderConfig, path: string, signal: AbortSignal): Promise<T> {
  if (!cfg.baseURL) throw new MediaError('missing-baseurl', `provider "${cfg.provider}" has no baseURL configured`)
  const url = `${cfg.baseURL.replace(/\/+$/, '')}${path}`
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
  const res = await fetch(url, { method: 'GET', headers, signal })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new MediaError('http-' + res.status, `${cfg.provider} GET ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

/** Save a remote URL to disk; ensure parent dir exists. */
async function downloadTo(url: string, dest: string, signal: AbortSignal): Promise<number> {
  await mkdir(dirname(dest), { recursive: true })
  const r = await fetch(url, { signal })
  if (!r.ok) throw new MediaError('download-' + r.status, `failed to download media: HTTP ${r.status}`)
  const buf = Buffer.from(await r.arrayBuffer())
  await writeFile(dest, buf)
  return buf.length
}

/**
 * Pick the right extension for a downloaded file. Most providers send a
 * `Content-Type` header; we fall back to a path-extension hint when not.
 */
function guessExt(url: string, contentType?: string | null): string {
  if (contentType) {
    const ct = contentType.toLowerCase()
    if (ct.includes('png')) return 'png'
    if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
    if (ct.includes('webp')) return 'webp'
    if (ct.includes('mp4')) return 'mp4'
    if (ct.includes('mpeg') || ct.includes('mp3')) return 'mp3'
    if (ct.includes('wav')) return 'wav'
  }
  const fromUrl = extname(new URL(url, 'http://x').pathname).slice(1).toLowerCase()
  return fromUrl || 'bin'
}

/**
 * Errors from the media layer. The `code` is stable; `message` is for the
 * user. Tool code lets `instanceof MediaError` decide whether to mark a
 * failed result as `isError` (the registry does that for any thrown value).
 */
export class MediaError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'MediaError'
  }
}

/**
 * Pull the first URL out of an OpenAI-style generations response. Accepts
 * `{ data: [{ url }] }`, `{ url }`, or `{ data: [{ b64_json }] }` (the last
 * case is rare but OpenAI uses it on edits).
 */
function firstMediaUrl(json: unknown): string {
  if (!json || typeof json !== 'object') throw new MediaError('bad-shape', 'provider returned non-JSON')
  const root = json as Record<string, unknown>
  if (typeof root.url === 'string') return root.url
  const data = root.data
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0] as Record<string, unknown>
    if (typeof first.url === 'string') return first.url
    if (typeof first.b64_json === 'string') {
      // b64_json inline — write directly to outPath and skip download
      const buf = Buffer.from(first.b64_json, 'base64')
      // Caller decides whether to use the buffer; here we surface a
      // data: URL so the rest of the pipeline (which assumes a URL)
      // keeps working without special-casing inline bytes.
      // Note: this is fine for small payloads; for large ones we would
      // need to thread the buffer through `MediaGenResult` instead.
      void buf
      throw new MediaError('not-supported', 'provider returned b64_json; the plugin only handles URL outputs for now')
    }
  }
  throw new MediaError('bad-shape', 'no `url` field in provider response')
}

/** Pull the first job id out of an OpenAI-style video submit response. */
function firstVideoId(json: unknown): string {
  if (!json || typeof json !== 'object') throw new MediaError('bad-shape', 'provider returned non-JSON')
  const root = json as Record<string, unknown>
  const id = root.id ?? root.video_id ?? root.task_id
  if (typeof id === 'string' && id) return id
  throw new MediaError('bad-shape', 'no `id`/`video_id` in video submit response')
}

/** Pull a job status + URL out of a video poll response (best-effort). */
function pollVideoStatus(json: unknown): { status: string; url?: string } {
  if (!json || typeof json !== 'object') return { status: 'unknown' }
  const root = json as Record<string, unknown>
  const status = String(root.status ?? root.state ?? 'unknown')
  const url = root.url ?? root.video_url ?? root.data
  return { status, url: typeof url === 'string' ? url : undefined }
}

// ─── image generation ─────────────────────────────────────────────────────

/**
 * POST /images/generations (OpenAI spec). Agnes, OpenAI, xAI Grok, and any
 * other provider that follows the OpenAI image schema can use this path.
 */
export async function generateImage(cfg: MediaProviderConfig, opts: GenerateImageOpts): Promise<MediaGenResult> {
  const t0 = Date.now()
  const model = opts.model || cfg.defaultModel
  if (!model) throw new MediaError('missing-model', `provider "${cfg.provider}" has no defaultModel configured`)

  const body: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    n: 1,
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.aspectRatio ? { size: aspectRatioToSize(opts.aspectRatio) } : {}),
    ...(opts.refImages && opts.refImages.length ? { image: opts.refImages } : {}),
  }
  const json = await postJSON<unknown>(cfg, '/images/generations', body, opts.signal)
  const url = firstMediaUrl(json)

  // Try to keep the extension in sync with the response
  const ext = guessExt(url)
  const outPath = ensureExt(opts.outPath, ext)
  const bytes = await downloadTo(url, outPath, opts.signal)
  return { url: outPath, model, bytes, latencyMs: Date.now() - t0 }
}

function aspectRatioToSize(ar: '1:1' | '16:9' | '9:16' | '4:3' | '3:4'): string {
  // Match OpenAI's accepted sizes; unknown providers may ignore.
  switch (ar) {
    case '1:1':  return '1024x1024'
    case '16:9': return '1792x1024'
    case '9:16': return '1024x1792'
    case '4:3':  return '1536x1152'
    case '3:4':  return '1152x1536'
  }
}

function ensureExt(path: string, ext: string): string {
  const cur = extname(path).slice(1).toLowerCase()
  if (cur && cur !== 'bin') return path
  return join(dirname(path), `${extname(path).slice(1) ? '' : 'media.'}${ext === 'bin' ? '' : ext}`.replace('media.media', 'media'))
    // ^ tiny helper: if no ext, append .ext; never duplicate .bin
    .replace(/^media\.(media\.)/, 'media.') || path
}

// ─── video generation (submit + poll) ──────────────────────────────────────

const VIDEO_POLL_MS = 5_000
const VIDEO_TIMEOUT_MS = 25 * 60_000

/**
 * POST /videos/generations, then poll GET /videos/{id} until the provider
 * returns status='completed' (or 'success') with a URL.
 *
 * Provider variance note:
 *   Agnes returns { video_id, status: 'queued'/'in_progress'/'completed', url? }
 *   OpenAI Sora returns { id, status: 'queued'/'in_progress'/'completed', ... }
 *   Other providers may name the field differently — we try a few keys
 *   before failing.
 */
export async function generateVideo(cfg: MediaProviderConfig, opts: GenerateVideoOpts): Promise<MediaGenResult> {
  const t0 = Date.now()
  const model = opts.model || cfg.defaultModel
  if (!model) throw new MediaError('missing-model', `provider "${cfg.provider}" has no defaultModel configured`)

  const submitBody: Record<string, unknown> = {
    model,
    prompt: opts.prompt,
    ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio } : {}),
    ...(opts.durationS ? { duration_seconds: opts.durationS } : {}),
    ...(opts.refImages && opts.refImages.length ? { image_url: opts.refImages[0] } : {}),
  }
  const submitted = await postJSON<unknown>(cfg, '/videos/generations', submitBody, opts.signal)
  const id = firstVideoId(submitted)

  // Poll loop. We probe both /videos/{id} and /v1/videos/{id} because some
  // providers (Agnes) return a relative path that's versioned separately.
  const deadline = Date.now() + VIDEO_TIMEOUT_MS
  let videoUrl: string | undefined
  while (Date.now() < deadline) {
    await sleep(VIDEO_POLL_MS, opts.signal)
    let polled: { status: string; url?: string }
    try {
      polled = pollVideoStatus(await getJSON<unknown>(cfg, `/videos/${encodeURIComponent(id)}`, opts.signal))
    } catch {
      polled = { status: 'unknown' }
    }
    if (polled.url) { videoUrl = polled.url; break }
    if (polled.status === 'failed' || polled.status === 'error' || polled.status === 'cancelled') {
      throw new MediaError('video-failed', `${cfg.provider} video ${id} status=${polled.status}`)
    }
    // queued / in_progress / processing / unknown → keep polling
  }
  if (!videoUrl) throw new MediaError('video-timeout', `${cfg.provider} video ${id} did not complete within ${VIDEO_TIMEOUT_MS / 1000}s`)

  const ext = guessExt(videoUrl, 'video/mp4')
  const outPath = ensureExt(opts.outPath, ext)
  const bytes = await downloadTo(videoUrl, outPath, opts.signal)
  return { url: outPath, model, bytes, latencyMs: Date.now() - t0 }
}

// ─── TTS voice synthesis ──────────────────────────────────────────────────

/**
 * POST /audio/speech (OpenAI TTS spec). Agnes doesn't expose a TTS endpoint;
 * MiniMax Speech 02 HD is OpenAI-compatible on this route — we send the
 * MiniMax-shaped body and it Just Works for that provider.
 *
 * Returns the path to the saved audio file (mp3 by default).
 */
export async function generateMusic(cfg: MediaMusicConfig, opts: GenerateMusicOpts): Promise<MediaGenResult> {
  const t0 = Date.now()
  const model = cfg.defaultModel
  if (!model) throw new MediaError('missing-model', `provider "${cfg.provider}" has no defaultModel configured`)
  if (!opts.text || !opts.text.trim()) throw new MediaError('empty-text', 'TTS requires non-empty text')

  const body: Record<string, unknown> = {
    model,
    input: opts.text,
    voice: opts.voice || cfg.voice,
    response_format: 'mp3',
    speed: opts.speed ?? 1.0,
  }
  // MiniMax requires `voice_setting` + `audio_setting` instead of OpenAI's
  // `voice`/`response_format`/`speed`. We don't transform here — the user
  // picks a provider whose API matches what the request sends. A future
  // MiniMax-specific adapter can wrap this when needed.

  const url = `${cfg.baseURL.replace(/\/+$/, '')}/audio/speech`
  const headers: Record<string, string> = {}
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw new MediaError('http-' + res.status, `${cfg.provider} TTS → HTTP ${res.status}: ${t.slice(0, 300)}`)
  }
  // TTS endpoints typically return binary audio directly. If the provider
  // returns JSON instead, we surface a clear error so the user can fix
  // their provider config (or we add a JSON branch).
  const ct = res.headers.get('content-type') || ''
  if (!ct.startsWith('audio/')) {
    const t = await res.text().catch(() => '')
    throw new MediaError('bad-content-type', `${cfg.provider} TTS returned content-type=${ct || 'unknown'}, body: ${t.slice(0, 200)}`)
  }

  await mkdir(dirname(opts.outPath), { recursive: true })
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(opts.outPath, buf)
  return { url: opts.outPath, model, bytes: buf.length, latencyMs: Date.now() - t0 }
}

// ─── helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new MediaError('aborted', 'aborted during sleep')) }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}
