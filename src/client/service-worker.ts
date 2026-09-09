/**
 * Media-prefetch Service Worker for dsh-media-studio.
 *
 * Purpose: turn "click → stream from localhost → first byte ~200 ms" into
 * "click → bytes already in cache → playback starts instantly".
 *
 * How it works:
 *   1. Main thread calls `preloadVideo(url)` whenever a <video> node becomes
 *      visible (IntersectionObserver in the React component fires). This
 *      posts a message to the SW which kicks off a background fetch for the
 *      first 256 KB of the file.
 *   2. When the user clicks play, the browser issues a GET for the full file
 *      (or a Range request). The SW intercepts it: if we have the header in
 *      cache, serve it as 206 immediately; otherwise forward to the network.
 *   3. The 256 KB header contains the MP4 `ftyp` + `moov` boxes — enough for
 *      the player to compute duration and paint the first frame. Playback
 *      starts instantly while the rest streams in the background.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const PREFETCH_SIZE = 256 * 1024          // 256 KB — ftyp + moov + a fraction of track data
const MAX_CACHE_BYTES = 200 * 1024 * 1024 // 200 MB total hard cap
const CONCURRENCY_CAP = 4                 // don't blast 20 videos at once on a big canvas

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

function evict(targetBytes: number): void {
  if (usedBytes <= targetBytes || cache.size === 0) return
  const it = cache.entries()
  while (usedBytes > targetBytes && !it.next().done) {
    const [k, v] = it.next().value as [string, ArrayBuffer]
    cache.delete(k)
    usedBytes -= v.byteLength
  }
}

// ── Background pre-fetcher ──────────────────────────────────────────────────

function drain(): void {
  while (queue.length > 0 && inflight.size < CONCURRENCY_CAP) {
    const url = queue.shift()!
    inflight.add(url)
    // Fetch the first PREFETCH_SIZE bytes; store in cache; release slot.
    fetch(url, { headers: { Range: `bytes=0-${PREFETCH_SIZE - 1}` } })
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
    event.respondWith(new Response(cached, {
      status: 206,
      statusText: 'Partial Content',
      headers: {
        'Content-Type': `video/${extOf(url).replace('.', '')}` || 'application/octet-stream',
        'Content-Range': `bytes 0-${cached.byteLength - 1}/*`,
        'Content-Length': String(cached.byteLength),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, max-age=86400',
      },
    }))
    return
  }

  // No cache hit — kick off a background prefetch for the header and let the
  // original request proceed. Future Range requests for this URL will hit.
  if (!inflight.has(url)) { queue.push(url); drain() }
})

// ── Main-thread API ──────────────────────────────────────────────────────────

self.addEventListener('message', (event: MessageEvent) => {
  const data = event.data
  if (!data || typeof data !== 'object') return
  if (data.type === 'ms-preload-video' && typeof data.url === 'string') {
    if (!cache.has(data.url) && !inflight.has(data.url)) {
      queue.push(data.url)
      drain()
    }
  }
})

// ── Global API (callable from main thread) ─────────────────────────────────
// Exposed as `window.__msPreheatVideo(url)` so React components can trigger
// a preheat without importing the SW module (SWs don't share module scope).
if (typeof globalThis !== 'undefined') {
  ;(globalThis as Record<string, unknown>).__msPreheatVideo = (url: string) => {
    const ctrl = navigator.serviceWorker?.controller
    if (!ctrl) return
    ctrl.postMessage({ type: 'ms-preload-video', url })
  }
}
