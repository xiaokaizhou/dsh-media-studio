/**
 * Media-prefetch Service Worker for dsh-media-studio.
 *
 * Purpose: turn "click → stream from localhost → first byte ~200 ms" into
 * "click → bytes already in cache → playback starts instantly".
 *
 * How it works:
 *   1. Main thread calls `preloadVideo(url)` whenever a <video> node becomes
 *      visible (IntersectionObserver in the React component fires). This
 *      posts a message to the SW which kicks off a background fetch.
 *   2. For files smaller than `FULL_FILE_THRESHOLD` the SW fetches the
 *      ENTIRE body (not just the header) — small clips then play with zero
 *      network round-trip on click, because the cached entry IS the full
 *      media and the response below returns 200 + complete bytes.
 *   3. For larger files the SW keeps the legacy 256 KB header prefetch:
 *      ftyp + moov + the first track frames. The browser issues its own
 *      Range request for the rest on click and the SW stays out of the way.
 *   4. Cache-Control: `immutable` is set on every served response so the
 *      browser HTTP cache also short-circuits conditional revalidation
 *      while the asset filename is stable (filenames carry Date.now()+rand,
 *      so they're effectively write-once per node).
 *
 * The size threshold uses a HEAD probe with `Range: bytes=0-0`; servers
 * (including dsh's `/api/media-studio/media-file`) reply with a
 * `Content-Range: bytes 0-0/<total>` header from which we read the total.
 * If the probe fails or returns no total, we fall back to the header-only
 * path — never block a click on size discovery.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const HEADER_PREFETCH_SIZE = 256 * 1024  // 256 KB — ftyp + moov + a fraction of track data
const FULL_FILE_THRESHOLD = 5 * 1024 * 1024  // < 5 MB → cache the whole file
const MAX_CACHE_BYTES = 200 * 1024 * 1024   // 200 MB total hard cap
const CONCURRENCY_CAP = 4                   // don't blast 20 videos at once on a big canvas
const SIZE_PROBE_TIMEOUT_MS = 1500          // bail out of HEAD probe fast

const MEDIA_EXT = new Set([
  '.mp4', '.webm', '.mov', '.m4v',
  '.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac',
])

// ── In-memory cache ─────────────────────────────────────────────────────────
// Keyed by the FULL request URL (including query string) so each <video>
// element gets its own cache entry even if they share a base path.
const cache = new Map<string, ArrayBuffer>()
const inflight = new Set<string>()
const queue: string[] = []
let usedBytes = 0

// ── Helpers ──────────────────────────────────────────────────────────────────

function extOf(url: string): string {
  try { return new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '' }
  catch { return '' }
}

function isMedia(url: string): boolean {
  return /\/api\/media-studio\/media-file\?path=/.test(url) && MEDIA_EXT.has(extOf(url))
}

/** Guess content-type from URL extension. Mirrors the server's
 *  `MEDIA_MIME` map for the cases the SW actually serves. */
function mimeOf(url: string): string {
  const ext = extOf(url)
  if (ext === 'mp4' || ext === 'm4v') return 'video/mp4'
  if (ext === 'webm') return 'video/webm'
  if (ext === 'mov') return 'video/quicktime'
  if (ext === 'mp3') return 'audio/mpeg'
  if (ext === 'wav') return 'audio/wav'
  if (ext === 'm4a') return 'audio/mp4'
  if (ext === 'aac') return 'audio/aac'
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg'
  if (ext === 'flac') return 'audio/flac'
  return 'application/octet-stream'
}

/** Evict oldest entries until `usedBytes <= targetBytes`. */
function evict(targetBytes: number): void {
  if (usedBytes <= targetBytes || cache.size === 0) return
  const it = cache.entries()
  while (usedBytes > targetBytes && !it.next().done) {
    const [k, v] = it.next().value as [string, ArrayBuffer]
    cache.delete(k)
    usedBytes -= v.byteLength
  }
}

/** Probe total file size via a single-byte Range request. Returns total
 *  bytes or 0 if the probe failed/timed out / server didn't honour Range. */
async function probeSize(url: string): Promise<number> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), SIZE_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: ctrl.signal,
    })
    if (res.status !== 206 && res.status !== 200) return 0
    const cr = res.headers.get('Content-Range')  // "bytes 0-0/12345678"
    if (cr) {
      const m = /\/(\d+)$/.exec(cr)
      if (m) return parseInt(m[1], 10) || 0
    }
    // Fall back to Content-Length if the server omitted the total in
    // Content-Range (rare; non-spec compliant but happens on plain 200).
    const cl = res.headers.get('Content-Length')
    if (cl) return parseInt(cl, 10) || 0
    // Drain the body so the connection releases back to the pool.
    try { await res.arrayBuffer() } catch { /* ignore */ }
    return 0
  } catch {
    return 0
  } finally {
    clearTimeout(timer)
  }
}

// ── Background pre-fetcher ──────────────────────────────────────────────────

/** Decide what range to pull for `url`. Returns null when the URL is already
 *  cached / in flight and doesn't need another fetch. The returned tuple
 *  is `(rangeHeader | null, isFullFile)`:
 *    • `isFullFile=true` and the Range covers the whole body → on click the
 *      browser can play from the cache directly (no extra fetch).
 *    • `isFullFile=false` and the Range covers HEADER_PREFETCH_SIZE bytes →
 *      on click the browser does its own Range for the rest of the file.
 */
async function planRange(url: string): Promise<{ range: string | null; total: number } | null> {
  if (cache.has(url) || inflight.has(url)) return null
  const total = await probeSize(url)
  if (total > 0 && total <= FULL_FILE_THRESHOLD) {
    return { range: `bytes=0-${total - 1}`, total }
  }
  return { range: `bytes=0-${HEADER_PREFETCH_SIZE - 1}`, total }
}

function drain(): void {
  while (queue.length > 0 && inflight.size < CONCURRENCY_CAP) {
    const url = queue.shift()!
    inflight.add(url)
    void planRange(url).then((plan) => {
      if (!plan || !plan.range) {
        inflight.delete(url)
        drain()
        return
      }
      fetch(url, { headers: { Range: plan.range } })
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          if (buf.byteLength > 0) {
            cache.set(url, buf)
            usedBytes += buf.byteLength
            if (usedBytes >= MAX_CACHE_BYTES * 0.8) evict(MAX_CACHE_BYTES * 0.5)
          }
        })
        .catch(() => { /* best-effort */ })
        .finally(() => { inflight.delete(url); drain() })
    })
  }
}

// ── Install / Activate ──────────────────────────────────────────────────────

self.addEventListener('install', () => {
  // Take control of pages immediately — don't wait for next navigation.
  ;(self as ServiceWorkerGlobalScope).skipWaiting()
})

self.addEventListener('activate', () => {
  // Claim all clients under our scope so they can talk to us right away.
  ;(self as ServiceWorkerGlobalScope).clients.claim()
})

// ── Fetch interceptor ────────────────────────────────────────────────────────

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = event.request.url
  if (!isMedia(url)) return

  const cached = cache.get(url)
  if (cached) {
    const isFull = cached.byteLength > HEADER_PREFETCH_SIZE
    // Full-file entries are served as 200 — the browser can play straight
    // through with no further network. Header-only entries are served as
    // 206 with the correct Content-Range so <video> keeps seeking the rest.
    const status = isFull ? 200 : 206
    const statusText = isFull ? 'OK' : 'Partial Content'
    const headers: Record<string, string> = {
      'Content-Type': mimeOf(url),
      'Content-Length': String(cached.byteLength),
      'Accept-Ranges': 'bytes',
      // `immutable` means the browser HTTP cache won't even bother with a
      // conditional request (If-None-Match / If-Modified-Since) inside
      // max-age; filenames in this app are ts+rand, so they're effectively
      // write-once. Combined with max-age=86400 this turns repeat views of
      // the same node into a pure cache hit even after the SW process
      // restarts and loses its in-memory Map.
      'Cache-Control': 'private, max-age=86400, immutable',
    }
    if (!isFull) {
      headers['Content-Range'] = `bytes 0-${cached.byteLength - 1}/*`
    }
    event.respondWith(new Response(cached, { status, statusText, headers }))
    return
  }

  // No cache hit — kick off a background prefetch (size-aware) and let the
  // original request proceed. Future Range requests for this URL will hit.
  if (!inflight.has(url)) { queue.push(url); drain() }
})

// ── Main-thread API ──────────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if ((data.type === 'ms-preload-video' || data.type === 'ms-preload-audio')
      && typeof data.url === 'string') {
    if (!cache.has(data.url) && !inflight.has(data.url)) {
      queue.push(data.url)
      drain()
    }
  }
})

// ── Global API (callable from main thread) ─────────────────────────────────
// Exposed as `window.__msPreheatVideo(url)` / `window.__msPreheatAudio(url)` so
// React components can trigger a preheat without importing the SW module
// (SWs don't share module scope). The functions below live inside the SW's
// globalThis — the main-thread mirrors them via `navigator.serviceWorker.
// controller.postMessage(...)` in `src/client.tsx`. Anything set here is only
// visible inside the SW itself; do not rely on it from the page.
if (typeof globalThis !== 'undefined') {
  ;(globalThis as Record<string, unknown>).__msPreheatVideo = (url: string) => {
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) return
    ctrl.postMessage({ type: 'ms-preload-video', url })
  }
  ;(globalThis as Record<string, unknown>).__msPreheatAudio = (url: string) => {
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) return
    ctrl.postMessage({ type: 'ms-preload-audio', url })
  }
}