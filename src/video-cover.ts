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
 *       browser renders the attached pic as the first-frame automatically
 *       and `data.poster` stays unset. Project directory ends up holding
 *       exactly one file: the .mp4.
 *
 *   (2) "extract" — fallback when the provider gave no cover (or step 1
 *       failed). We run `ffmpeg -ss 0 -frames:v 1` to pull the real first
 *       frame from the video and write it next to the .mp4 as a sibling
 *       `.thumb.jpg`. `data.poster` then points at it. Slightly less clean
 *       (one extra hidden file per video) but still hidden on macOS Finder
 *       and never enters the project's asset index.
 *
 * Both steps degrade silently when ffmpeg is missing or the input is
 * unreadable — the caller still gets back a working `{ url }` pair.
 *
 * No step ever copies anything into the project's `assets/` tree; outputs
 * live entirely under `<wsRoot>/web-jobs/`, so cleanup on project deletion
 * is unaffected and the user's project directory stays clean.
 */

import { spawn } from 'node:child_process'
import { mkdir, writeFile, unlink, rename } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

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
    console.warn('[media-studio] ffmpeg not available — video cards will fall back to <video preload="metadata">')
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
  // Local path — copy bytes via fs.readFile/writeFile to keep this module
  // dependency-light and side-effect free on the source location.
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(url)
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
 * Download the video to a stable path under `<wsRoot>/web-jobs/`, then try
 * to attach (or extract) a cover. The returned `url` always points to a
 * locally-served file so the existing media-file proxy can hand it back.
 */
export async function prepareVideoForCanvas(
  videoUrl: string,
  opts: PrepareOptions,
): Promise<PreparedVideo> {
  const jobsDir = join(opts.wsRoot, 'web-jobs')
  await mkdir(jobsDir, { recursive: true })

  // Stable filename — re-running prepareVideoForCanvas on the same source
  // re-uses the same path so existing nodes don't dangle.
  const id = randomBytes(8).toString('hex')
  const localVideo = join(jobsDir, `v-${id}.mp4`)

  try {
    await downloadTo(videoUrl, localVideo)
  } catch (e) {
    console.warn(`[media-studio] video-cover: download failed (${(e as Error).message}); keeping original URL`)
    return { url: videoUrl, poster: null }
  }

  const ffmpegOk = await probeFfmpeg()

  // ── Strategy 1: embed provider cover into MP4 metadata ────────────────
  const coverUrl = opts.coverUrl || pickCoverUrl(opts.providerExtras)
  if (ffmpegOk && coverUrl) {
    const coverTmp = join(jobsDir, `c-${id}.jpg`)
    const outTmp = join(jobsDir, `o-${id}.mp4`)
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
      // Replace original with embedded; delete the sidecar.
      await unlink(localVideo).catch(() => {})
      await unlink(coverTmp).catch(() => {})
      await rename(outTmp, localVideo)
      // Success — browsers render attached_pic as the first frame; no
      // separate poster file needed, project dir stays one .mp4.
      return { url: localVideo, poster: null }
    } catch (e) {
      // Clean partials; we'll try extract below.
      await unlink(coverTmp).catch(() => {})
      await unlink(outTmp).catch(() => {})
      console.warn(`[media-studio] video-cover: embed failed (${(e as Error).message}); falling back to extract`)
    }
  }

  // ── Strategy 2: extract first frame with ffmpeg ────────────────────────
  if (ffmpegOk) {
    const thumb = join(jobsDir, `v-${id}.thumb.jpg`)
    try {
      await runFfmpeg([
        '-y',
        '-ss', '0',
        '-i', localVideo,
        '-frames:v', '1',
        '-q:v', '2',
        thumb,
      ])
      return { url: localVideo, poster: thumb }
    } catch (e) {
      await unlink(thumb).catch(() => {})
      console.warn(`[media-studio] video-cover: extract failed (${(e as Error).message}); poster disabled`)
    }
  }

  // ── Final fallback: just the local video, no poster ────────────────────
  return { url: localVideo, poster: null }
}
