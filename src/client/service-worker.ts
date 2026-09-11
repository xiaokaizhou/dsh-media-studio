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
//
// Each entry stores the actual file size alongside the cached bytes — for
// header-only entries the size is REQUIRED so the 206 response below can
// include `bytes start-end/<total>` instead of `bytes start-end/*`. The `*`
// form (unknown total) confuses Chrome / Safari into thinking the partial
// response is the entire file, which leaves <video> stuck on a 256 KB stub
// and the user sees "video won't play" with no obvious error.
interface CacheEntry { buf: ArrayBuffer; total: number; isFull: boolean }
const cache = new Map<string, CacheEntry>()
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
    const [k, v] = it.next().value as [string, CacheEntry]
    cache.delete(k)
    usedBytes -= v.buf.byteLength
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
      // `total` may be 0 if the size probe didn't return Content-Range /
      // Content-Length; we still cache the bytes but can't represent the
      // real length in subsequent 206 responses — fall back to `*` (which
      // the browser interprets as "complete response", so we must only
      // do that for full-file entries where the cached bytes ARE the file).
      const isFull = plan.total > 0 && plan.total <= FULL_FILE_THRESHOLD
      fetch(url, { headers: { Range: plan.range } })
        .then((r) => r.arrayBuffer())
        .then((buf) => {
          if (buf.byteLength > 0) {
            // For full-file entries, the probe told us total === buf.byteLength
            // (we fetched 0..total-1). For header-only entries, treat the
            // probe's total as authoritative — the cached prefix is
            // HEADER_PREFETCH_SIZE bytes but the file is `total` bytes long.
            const entryTotal = isFull
              ? buf.byteLength
              : (plan!.total > 0 ? plan!.total : buf.byteLength)
            // If the server returned the full body (despite our Range
            // header) on a probe we thought was "header-only", treat it as
            // a full file entry to avoid the broken partial-response bug.
            const actuallyFull = isFull
              || (plan!.total > 0 && buf.byteLength >= plan!.total)
            cache.set(url, { buf, total: entryTotal, isFull: actuallyFull })
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

/** Parse `Range: bytes=a-b` (open-ended allowed on either side) into
 *  `[start, end]` against the total file size. Returns null when the header
 *  is missing / malformed; returns null when the requested range falls
 *  entirely outside the cached window (caller passes through to network). */
function parseRange(header: string | null, cachedLen: number, total: number):
    { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  const start = m[1] ? parseInt(m[1], 10) : Math.max(0, total - cachedLen)
  const end = m[2] ? parseInt(m[2], 10) : total - 1
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start < 0 || end < start) return null
  return { start, end }
}

self.addEventListener('fetch', (event: FetchEvent) => {
  const url = event.request.url
  if (!isMedia(url)) return

  const cached = cache.get(url)
  if (cached) {
    const { buf, total, isFull } = cached

    // Full-file entries are served as 200 — the browser can play straight
    // through with no further network. This is the common case for short
    // clips (< 5 MB) and never has a "stuck on 256 KB" problem.
    if (isFull) {
      event.respondWith(new Response(buf, {
        status: 200,
        statusText: 'OK',
        headers: {
          'Content-Type': mimeOf(url),
          'Content-Length': String(buf.byteLength),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'private, max-age=86400, immutable',
        },
      }))
      return
    }

    // Header-only cache: only intercept when the browser's request fits
    // inside our cached prefix. Anything that asks for bytes beyond
    // HEADER_PREFETCH_SIZE must go to the network — we have no bytes to
    // serve and lying about the response with `Content-Range: .../*`
    // leaves the browser thinking the file is 256 KB long.
    const rangeHeader = event.request.headers.get('Range')
    const parsed = parseRange(rangeHeader, buf.byteLength, total)
    if (!parsed) {
      // No Range header, or the file is too small for partial — let the
      // browser have the full document from the network. Future Range
      // requests for the head will hit the cache.
      return
    }
    if (parsed.start >= buf.byteLength) {
      // Asked for bytes we don't have (e.g. bytes=262144- on a 256 KB
      // prefix). Network has them — let the request through.
      return
    }
    // Clip the requested end to our cached window. Total is known from the
    // probe; the browser uses it to set up the seekable timeline correctly.
    const end = Math.min(parsed.end, buf.byteLength - 1)
    const slice = buf.slice(parsed.start, end + 1)
    event.respondWith(new Response(slice, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': mimeOf(url),
        'Content-Length': String(slice.byteLength),
        'Content-Range': `bytes ${parsed.start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=86400, immutable',
      },
    }))
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