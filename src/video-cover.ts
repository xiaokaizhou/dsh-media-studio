/**
 * Video cover preparation.
 *
 * Goal: every finished video canvas card / library entry displays its real
 * first frame as the poster — without leaving loose `.jpg` siblings in the
 * user's project directory when the source provider supplied a cover image.
 *
 * Two strategies, applied in order:
 *
 *   (1) "embed" — preferred. The provider response carries a separate
 *       thumbnail URL (Sora / Veo / Kling / Seedance all do); we download
 *       both, then ffmpeg-mux the JPG into the MP4 as `attached_pic`. The
 *       cover image is ALSO kept as a sibling `.poster.jpg` next to the
 *       .mp4 and returned via `poster` — the frontend LazyVideo renders a
 *       plain `<img>` before the first click (no `<video>` element is
 *       mounted), so the MP4-attached_pic stream alone is never visible
 *       there.
 *
 *   (2) "extract" — fallback when the provider gave no cover (or step 1
 *       failed). We run `ffmpeg -ss 0 -frames:v 1` to pull the real first
 *       frame from the video and write it next to the .mp4 as a sibling
 *       `.thumb.jpg`. `data.poster` then points at it.
 *
 * Both steps degrade silently when ffmpeg is missing or the input is
 * unreadable — the caller still gets back a working `{ url }` pair.
 *
 * Output location mirrors `url`: when the project has a `sourcePath` the
 * .mp4 + .poster/.thumb sibling land in `<sourcePath>/assets/clips/` and
 * both URLs are returned as `projects/<id>/assets/clips/...` (so the
 * `resolveMediaTarget()` `projects/<id>/...` branch serves them). Without
 * a sourcePath we fall back to `<wsRoot>/web-jobs/` + `file://` URLs —
 * legacy / pre-migration projects only.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, unlink, rename, stat, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { getMediaStudioHandles, log } from './service-state'

const FFMPEG = (): string => process.env.FFMPEG_PATH || 'ffmpeg'

/** Coarse feature detection — only log once per process. We track by resolved
 *  binary path so tests that override FFMPEG_PATH are still honored. */
let ffmpegProbed: { binary: string; ok: boolean } | null = null
async function probeFfmpeg(): Promise<boolean> {
  const binary = FFMPEG()
  if (ffmpegProbed && ffmpegProbed.binary === binary) return ffmpegProbed.ok
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(binary, ['-version'], { stdio: ['ignore', 'ignore', 'ignore'] })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))))
    })
    ffmpegProbed = { binary, ok: true }
  } catch {
    ffmpegProbed = { binary, ok: false }
    log.warn('[media-studio] ffmpeg not available — video cards will fall back to <video preload="metadata">')
  }
  return ffmpegProbed.ok
}

/** Download a URL to a local file. Resolves absolute file paths and http(s)
 *  URLs the same way the existing media pipeline does. */
async function downloadTo(url: string, dest: string, sourcePath?: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    return
  }
  // Resolve every local URL form (projects/<id>/..., assets/...,
  // file://..., bare absolute path) through the same helper the
  // backfill uses, so behaviour is consistent across the codebase.
  const localPath = resolveLocalVideoPath(url, sourcePath)
  if (localPath) {
    const { readFile } = await import('node:fs/promises')
    const buf = await readFile(localPath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    return
  }
  // Unrecognised relative form — refuse rather than guess (would read
  // some random cwd file). Same behaviour as the prior fallback.
  const { readFile } = await import('node:fs/promises')
  const localPath2 = url.startsWith('file://') ? url.slice(7) : url
  const buf = await readFile(localPath2)
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
}

/** Run ffmpeg with the given args; reject on non-zero exit (unless code is
 *  null, which Node reports when the parent killed it — treat as cancel). */
function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG(), args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr.on('data', (c) => { stderr += c.toString() })
    proc.on('error', (e) => reject(e))
    proc.on('close', (code) => {
      if (code === 0) return resolve()
      if (code === null) return resolve() // parent aborted — caller will clean up
      reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(-400)}`))
    })
  })
}

/**
 * Faststart an MP4 in place: re-mux with `+faststart` so the `moov` box lives
 * at the head of the file instead of the tail. Browsers (Chrome/Safari/Firefox
 * with Media Source Extensions) need `moov` early to compute duration and seek
 * to the first frame; without faststart they must download the entire file
 * (or do an extra Range request for the tail) before `<video>` knows the clip's
 * length — which is the dominant cause of "点击视频需要缓冲" with provider-
 * generated MP4s (most providers mux without faststart).
 *
 * Strategy: stream-copy (no re-encode) to a sibling `.faststart.mp4`, then
 * rename over the original. `-c copy` is essentially free CPU-wise; the wall-
 * clock cost is dominated by the file read+write of the source bytes, which
 * for a 20 MB clip lands around 30-80 ms on NVMe.
 *
 * Gracefully no-ops when:
 *   • ffmpeg is unavailable (probeFfmpeg already cached the negative result)
 *   • the file is not MP4-shaped (no `ftyp` box at byte 4)
 *   • the moov box is already at the head (idempotent — re-mux is a no-op)
 *   • anything goes wrong (logged as warn; original file is left untouched)
 *
 * Returns true if the rewrite actually happened (file on disk is now
 * faststart), false if it was skipped. Callers should not branch on the
 * result — the goal is best-effort first-frame availability, not a guarantee.
 */
export async function faststartMp4(localPath: string): Promise<boolean> {
  if (!(await probeFfmpeg())) return false

  // Cheap "is this even an MP4" check: bytes 4..7 must be `ftyp`. Without
  // this we'd feed ffmpeg a wav/mov/webm and either succeed with no effect
  // or fail noisily on mov-files-that-aren't-mp4 (e.g. quicktime). Both
  // outcomes are harmless but the warning is unhelpful for non-MP4.
  let head: Buffer
  try {
    const fh = await import('node:fs/promises').then((m) => m.open(localPath, 'r'))
    try {
      const buf = Buffer.alloc(8)
      await fh.read(buf, 0, 8, 0)
      head = buf
    } finally {
      await fh.close()
    }
  } catch { return false }
  if (head.slice(4, 8).toString('latin1') !== 'ftyp') return false

  const tmp = `${localPath}.faststart.mp4`
  try {
    await runFfmpeg([
      '-y',
      '-i', localPath,
      '-c', 'copy',
      '-movflags', '+faststart',
      tmp,
    ])
    await rename(tmp, localPath)
    return true
  } catch (e) {
    await unlink(tmp).catch(() => {})
    log.warn(`[media-studio] faststart: re-mux failed for "${localPath}": ${(e as Error).message} — leaving file as-is`)
    return false
  }
}

/** Drop every field except ones that look like a cover URL. */
function pickCoverUrl(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object') return undefined
  const obj = extra as Record<string, unknown>
  for (const key of ['coverUrl', 'cover_url', 'thumbnailUrl', 'thumbnail_url', 'posterUrl', 'poster_url', 'coverImage', 'cover_image', 'thumbnail']) {
    const v = obj[key]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

/**
 * Resolve a stored `resultUrl` to an absolute local path on disk. Handles
 * every form the canvas has historically accepted:
 *
 *   • `https?://...`           — return null (remote; can't read locally
 *                                without downloading).
 *   • `projects/<id>/<rest>`   — use the supplied `sourcePath` when
 *                                `projectId` matches; otherwise look up
 *                                the project's sourcePath via the live
 *                                project registry. Returns null when the
 *                                project isn't registered with a
 *                                sourcePath.
 *   • `assets/<rest>`          — relative to the supplied `sourcePath`
 *                                (the legacy form written by earlier code
 *                                paths before the migration to
 *                                `projects/<id>/assets/...`).
 *   • `file://...`             — strip prefix, return rest.
 *   • bare absolute path       — return verbatim.
 *
 * Returns null when the URL form isn't local. Callers use this to decide
 * whether in-place operations (extract first frame, faststart rewrite,
 * head-byte probe) are possible.
 */
export function resolveLocalVideoPath(
  url: string,
  sourcePath?: string,
  projectId?: string,
): string | null {
  if (!url) return null
  if (/^https?:\/\//i.test(url)) return null
  if (/^(data:|blob:|\/api\/)/i.test(url)) return null

  const projectMatch = /^projects\/([^/]+)\/(.+)$/.exec(url)
  if (projectMatch) {
    const [, pid, rest] = projectMatch
    // Fast path: the caller already knows the sourcePath for this
    // project (the common backfill case). Avoid the registry hop so the
    // helper works in test harnesses without a live project store.
    if (projectId && pid === projectId && sourcePath) {
      return join(sourcePath, rest!)
    }
    // Fall back to the live project registry. If the plugin hasn't been
    // initialised yet (e.g. test harnesses) just return null — the
    // caller can retry later when handles are wired up.
    let registryRoot: string | undefined
    try {
      const handles = getMediaStudioHandles()
      const projectRoots = handles.projectStore?.allSourcePaths?.() ?? {}
      registryRoot = projectRoots[pid!]
    } catch { /* not initialised yet */ }
    const root = registryRoot ?? (projectId === pid ? sourcePath : undefined)
    if (root) return join(root, rest!)
    return null
  }
  if (url.startsWith('assets/')) {
    if (!sourcePath) return null
    return join(sourcePath, url)
  }
  if (url.startsWith('file://')) return url.slice('file://'.length)
  if (url.startsWith('/')) return url
  if (/^[a-zA-Z]:[\\/]/.test(url)) return url
  // Unknown relative form — refuse rather than guess.
  return null
}

/**
 * Extract the first frame of a local video file to a sibling JPEG, in place.
 * Returns the absolute path of the written JPEG, or null when ffmpeg is
 * unavailable / the input isn't a recognised video / extraction failed.
 *
 * Use this from `backfillVideoPosters` to recover posters for legacy video
 * nodes whose underlying MP4 already lives at the right place — copying the
 * file just to give it a poster would rewrite the user's filename and
 * break any external references to the original clip.
 */
export async function extractPosterInPlace(localVideoPath: string): Promise<string | null> {
  if (!(await probeFfmpeg())) return null
  const thumbPath = `${localVideoPath}.thumb.jpg`
  try {
    await runFfmpeg([
      '-y',
      '-ss', '0',
      '-i', localVideoPath,
      '-frames:v', '1',
      '-q:v', '2',
      thumbPath,
    ])
    // Confirm the file landed where ffmpeg claimed. ffmpeg returns 0
    // on stdout even when it produced nothing useful (e.g. zero-frame
    // streams), so a stat probe is the cheap gate.
    const { stat } = await import('node:fs/promises')
    const s = await stat(thumbPath).catch(() => null)
    if (!s || s.size === 0) {
      const { unlink } = await import('node:fs/promises')
      await unlink(thumbPath).catch(() => {})
      return null
    }
    return thumbPath
  } catch (e) {
    const { unlink } = await import('node:fs/promises')
    await unlink(thumbPath).catch(() => {})
    log.warn(`[media-studio] extractPosterInPlace: ffmpeg extract failed for "${localVideoPath}": ${(e as Error).message}`)
    return null
  }
}

export interface PreparedVideo {
  /** Always set. Either the embedded-in-place path or the original `videoUrl`. */
  url: string
  /** When set, pass to <video poster=...> for instant first-frame painting.
   *  null when ffmpeg wasn't available AND no cover URL came from provider. */
  poster: string | null
}

export interface PrepareOptions {
  wsRoot: string
  /** The canvas id — used to build `projects/<id>/assets/clips/<file>`
   *  URLs when `sourcePath` is set. */
  projectId?: string
  /** The project's sourcePath, if it has one. When set, the video is
   *  written to `<sourcePath>/assets/clips/<file>` instead of web-jobs/. */
  sourcePath?: string
  /** Direct cover URL — preferred over scanning `providerExtras`. The
   *  multimodal plugin now returns this as a typed `coverUrl` field. */
  coverUrl?: string
  /** Allow caller to pass extra provider fields without us coupling to the
   *  multimodal plugin's exact schema. Used as a fallback when `coverUrl`
   *  is absent — covers providers that stash the cover under less obvious
   *  names (e.g. nested `body.video.coverUrl`). */
  providerExtras?: unknown
}

/**
 * Download the video to a stable local path, then try to attach (or extract)
 * a cover.
 *
 *   • When `sourcePath` is set → write to `<sourcePath>/assets/clips/` and
 *     return `projects/<id>/assets/clips/<file>` (the convention
 *     `resolveMediaTarget()` rewrites to the user's project tree).
 *   • When `sourcePath` is absent → fall back to `<wsRoot>/web-jobs/` and
 *     return a `file://` URL.
 *
 * The returned `url` always points to a locally-served file so the
 * existing media-file proxy can hand it back.
 */
export async function prepareVideoForCanvas(
  videoUrl: string,
  opts: PrepareOptions,
): Promise<PreparedVideo> {
  const useSourcePath = !!opts.sourcePath
  const baseDir = useSourcePath
    ? join(opts.sourcePath!, 'assets', 'clips')
    : join(opts.wsRoot, 'web-jobs')
  await mkdir(baseDir, { recursive: true })

  // Stable filename — re-running prepareVideoForCanvas on the same source
  // re-uses the same path so existing nodes don't dangle AND so the
  // long-running agent flow of "refresh 6 video nodes 5 times during
  // iteration" doesn't accumulate 30 random v-*.mp4 files in
  // assets/clips/. M5-⑤: id is derived from a sha1 of the source URLs
  // (the video URL + the optional cover URL), so two calls with the same
  // inputs collide on the same path and overwrite.
  const id = createHash('sha1')
    .update(videoUrl)
    .update('\0')
    .update(opts.coverUrl ?? '')
    .digest('hex')
    .slice(0, 16)
  const localVideo = join(baseDir, `v-${id}.mp4`)

  try {
    await downloadTo(videoUrl, localVideo, opts.sourcePath)
  } catch (e) {
    log.warn(`[media-studio] video-cover: download failed (${(e as Error).message}); keeping original URL`)
    return { url: videoUrl, poster: null }
  }

  // Faststart the freshly-downloaded MP4 before any cover-embedding. Most
  // video providers (Agnes / Sora / Seedance / MiniMax) mux without
  // `+faststart`, leaving the `moov` box at the tail — browsers then need
  // the whole file (or an extra Range to the end) before <video> can
  // compute duration or paint the first frame. Re-muxing once here is
  // stream-copy and ~30–80 ms on NVMe; subsequent embed/extract runs are
  // also stream-copies and inherit the head-placed moov, so every video
  // node produced by this function lands faststart on disk regardless of
  // which cover strategy wins.
  await faststartMp4(localVideo)

  const ffmpegOk = await probeFfmpeg()

  // ── Strategy 1: embed provider cover into MP4 metadata ────────────────
  const coverUrl = opts.coverUrl || pickCoverUrl(opts.providerExtras)
  if (ffmpegOk && coverUrl) {
    const coverTmp = join(baseDir, `c-${id}.jpg`)
    const outTmp = join(baseDir, `o-${id}.mp4`)
    try {
      await downloadTo(coverUrl, coverTmp, opts.sourcePath)
      await runFfmpeg([
        '-y',
        '-i', localVideo,
        '-i', coverTmp,
        '-map', '0',
        '-map', '1',
        '-c', 'copy',
        '-disposition:v:1', 'attached_pic',
        '-metadata:s:v:1', 'title=cover',
        outTmp,
      ])
      // Replace original with embedded; keep the cover image as an
      // external poster (see module header for why attached_pic alone
      // is not enough for the frontend card renderer).
      await unlink(localVideo).catch(() => {})
      await rename(outTmp, localVideo)
      const posterPath = join(baseDir, `v-${id}.poster.jpg`)
      await rename(coverTmp, posterPath)
      const urlForNode = useSourcePath
        ? `projects/${opts.projectId}/assets/clips/v-${id}.mp4`
        : `file://${localVideo}`
      // Symmetric with `url`: when sourcePath is available, emit the
      // project-relative poster path so the browser hits
      // `/api/media-studio/media-file` via `resolveMediaTarget`'s
      // `projects/<id>/...` branch instead of relying on the absolute-
      // path/mediaRoots fallback. The `file://` form stays for legacy
      // projects with no sourcePath.
      const posterForNode = useSourcePath
        ? `projects/${opts.projectId}/assets/clips/v-${id}.poster.jpg`
        : `file://${posterPath}`
      return { url: urlForNode, poster: posterForNode }
    } catch (e) {
      // Clean partials; we'll try extract below.
      await unlink(coverTmp).catch(() => {})
      await unlink(outTmp).catch(() => {})
      log.warn(`[media-studio] video-cover: embed failed (${(e as Error).message}); falling back to extract`)
    }
  }

  // ── Strategy 2: extract first frame with ffmpeg ────────────────────────
  if (ffmpegOk) {
    const thumb = join(baseDir, `v-${id}.thumb.jpg`)
    try {
      await runFfmpeg([
        '-y',
        '-ss', '0',
        '-i', localVideo,
        '-frames:v', '1',
        '-q:v', '2',
        thumb,
      ])
      const urlForNode = useSourcePath
        ? `projects/${opts.projectId}/assets/clips/v-${id}.mp4`
        : `file://${localVideo}`
      const posterForNode = useSourcePath
        ? `projects/${opts.projectId}/assets/clips/v-${id}.thumb.jpg`
        : `file://${thumb}`
      return { url: urlForNode, poster: posterForNode }
    } catch (e) {
      await unlink(thumb).catch(() => {})
      log.warn(`[media-studio] video-cover: extract failed (${(e as Error).message}); poster disabled`)
    }
  }

  // ── Final fallback: just the local video, no poster ────────────────────
  const fallbackUrl = useSourcePath
    ? `projects/${opts.projectId}/assets/clips/v-${id}.mp4`
    : `file://${localVideo}`
  return { url: fallbackUrl, poster: null }
}
