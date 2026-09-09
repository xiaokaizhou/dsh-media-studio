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
import { mkdir, writeFile, unlink, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
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
async function downloadTo(url: string, dest: string): Promise<void> {
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, buf)
    return
  }
  // `projects/<pid>/assets/<kind>/<file>` (the public form returned by
  // `dsh-llm-multimodal.localizeVideoUrl` when outputStrategy=project).
  // Resolve to the on-disk path through the same handler the
  // `/api/media-studio/media-file` proxy uses, then copy the bytes.
  const projectMatch = /^projects\/([^/]+)\/(.+)$/.exec(url)
  if (projectMatch) {
    const handles = getMediaStudioHandles()
    const projectRoots = handles.projectStore?.allSourcePaths?.() ?? {}
    const sourcePath = projectRoots[projectMatch[1]!]
    if (sourcePath) {
      const localPath = join(sourcePath, projectMatch[2]!)
      const { readFile } = await import('node:fs/promises')
      const buf = await readFile(localPath)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, buf)
      return
    }
  }
  // Local path — strip `file://` prefix if present, then copy bytes via
  // fs.readFile/writeFile to keep this module dependency-light and
  // side-effect free on the source location. The multimodal plugin's
  // `localizeVideoUrl` hands us back a `file://` URL after downloading
  // the CDN bytes into the project's `assets/clips/`, so we MUST handle
  // the prefix here — otherwise `prepareVideoForCanvas` returns the
  // original `file://` URL and the canvas card never gets the stable
  // `projects/<pid>/assets/clips/v-<id>.mp4` form (which in turn breaks
  // the media-file proxy and leaves the card looking like a streaming
  // video with no poster first-frame).
  const { readFile } = await import('node:fs/promises')
  const localPath = url.startsWith('file://') ? url.slice(7) : url
  const buf = await readFile(localPath)
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
  // re-uses the same path so existing nodes don't dangle.
  const id = randomBytes(8).toString('hex')
  const localVideo = join(baseDir, `v-${id}.mp4`)

  try {
    await downloadTo(videoUrl, localVideo)
  } catch (e) {
    log.warn(`[media-studio] video-cover: download failed (${(e as Error).message}); keeping original URL`)
    return { url: videoUrl, poster: null }
  }

  const ffmpegOk = await probeFfmpeg()

  // ── Strategy 1: embed provider cover into MP4 metadata ────────────────
  const coverUrl = opts.coverUrl || pickCoverUrl(opts.providerExtras)
  if (ffmpegOk && coverUrl) {
    const coverTmp = join(baseDir, `c-${id}.jpg`)
    const outTmp = join(baseDir, `o-${id}.mp4`)
    try {
      await downloadTo(coverUrl, coverTmp)
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
