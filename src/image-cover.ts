/**
 * Image preparation for canvas nodes.
 *
 * Goal: take whatever the multimodal plugin returned (CDN URL, base64, or a
 * `file://` path on disk) and place a stable local file at a path the canvas
 * media-file proxy can serve.
 *
 * When the current project has a `sourcePath` set (i.e. the user picked a
 * host directory at project creation), the file is written into
 * `<sourcePath>/assets/<kind>/<file>` and the returned `url` is the
 * `projects/<id>/assets/<kind>/<file>` convention that
 * `resolveMediaTarget()` rewrites to `<sourcePath>/assets/...` on every
 * read. This is how the canvas client keeps using a stable URL even when
 * bytes live inside the user's project tree.
 *
 * When the project has no `sourcePath`, we fall back to
 * `<wsRoot>/web-jobs/` (the same directory `prepareVideoForCanvas` uses)
 * and return a `file://` URL. That keeps non-sourcePath projects working
 * without forcing every user to pick a folder.
 *
 * The download helper is duplicated from `video-cover.ts` rather than
 * imported, to keep the two modules decoupled — the video path has
 * ffmpeg-specific state (probeFfmpeg, runFfmpeg) that image prep does not
 * need, and forcing a shared base module would create a circular import
 * surface for a 15-line fetch wrapper.
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { log } from './service-state'

export interface PreparedImage {
  /** Canvas-friendly URL: `projects/<id>/assets/<kind>/<file>` for sourcePath
   *  projects, `file://<abs>` for default projects. Always set; falls back
   *  to the original input on download failure. */
  url: string
  /** The kind bucket the file landed in. Lets the caller register the asset
   *  without re-deriving the path. */
  kindDir: AssetKindDir
  /** Absolute path on disk where the bytes were written. */
  localPath: string
}

/**
 * Asset subdirectories under `<sourcePath>/assets/`. We use the plural
 * convention (`characters/`, not `character/`) to match the existing
 * project tree that `media_studio_list_assets` already scans.
 *
 * Adding a new bucket is intentionally cheap — extend this union AND the
 * `inferImageKindDir` heuristic below. The runtime then picks it up
 * automatically; no other plugin code needs to change because the canvas
 * client reads these subdirectories transparently via
 * `resolveMediaTarget()`.
 */
export type AssetKindDir =
  | 'characters'
  | 'scenes'
  | 'clips'
  | 'audio'
  | 'props'
  | 'conceptart'
  | 'reference'
  // Fallback bucket — if no inference rule matches, files land here.
  | 'misc'

export interface PrepareImageOptions {
  wsRoot: string
  /** The canvas id, used to build `projects/<id>/assets/...` URLs. */
  projectId: string
  /** The project's sourcePath, if it has one. Drives the destination
   *  directory + the URL convention. */
  sourcePath?: string
  /** Explicit kind override. When set, takes precedence over inference. */
  kindDir?: AssetKindDir
  /** Node data fields used by the inference fallback. Any of these can be
   *  undefined; the inference rule is a small priority chain rather than a
   *  one-hot switch. */
  nodeHints?: {
    /** Set when this image represents a character (portrait, turnaround). */
    characterRef?: unknown
    /** Free-form tags — anything matching `prop*` / `concept*` etc. wins. */
    tags?: readonly string[]
    /** Explicit user-picked category. Currently accepts the same union as
     *  `AssetKindDir` (singular or plural). */
    category?: string
    /** The prompt / upstream context that produced this image. When no
     *  explicit signal exists, a lightweight semantic keyword scan over this
     *  text is the last resort (covers "character design sheet" prompts). */
    content?: string
  }
}

/**
 * Pick the right subdirectory for a generated image. Priority:
 *
 *   1. `opts.kindDir` (explicit override, wins).
 *   2. `opts.nodeHints.category` if it matches a known bucket.
 *   3. `opts.nodeHints.tags` — first tag matching `character|prop|concept|
 *      scene|clip|reference`.
 *   4. `opts.nodeHints.characterRef` set → `characters`.
 *   5. Default → `misc`.
 *
 * We don't try to be clever with prompt parsing — the multimodal plugin
 * already produces tagged output via `data.characterRef`, and any future
 * tags land here via `data.tags`. Adding a new bucket is a one-line
 * union extension.
 */
function inferImageKindDir(opts: PrepareImageOptions): AssetKindDir {
  if (opts.kindDir) return opts.kindDir
  const hints = opts.nodeHints
  if (hints?.category) {
    const c = hints.category.toLowerCase().trim()
    if (c === 'character' || c === 'characters') return 'characters'
    if (c === 'scene' || c === 'scenes') return 'scenes'
    if (c === 'clip' || c === 'clips') return 'clips'
    if (c === 'prop' || c === 'props') return 'props'
    if (c === 'concept' || c === 'conceptart' || c === 'conceptart') return 'conceptart'
    if (c === 'reference' || c === 'references') return 'reference'
    if (c === 'audio') return 'audio'
  }
  if (hints?.tags && hints.tags.length > 0) {
    for (const raw of hints.tags) {
      const t = raw.toLowerCase().trim()
      if (t === 'character' || t.startsWith('character')) return 'characters'
      if (t === 'prop' || t.startsWith('prop')) return 'props'
      if (t === 'concept' || t.startsWith('concept')) return 'conceptart'
      if (t === 'scene' || t.startsWith('scene')) return 'scenes'
      if (t === 'reference' || t.startsWith('reference')) return 'reference'
      if (t === 'clip' || t.startsWith('clip')) return 'clips'
    }
  }
  if (hints?.characterRef) return 'characters'
  // Last resort: semantic keyword scan over the prompt / upstream content.
  // This mirrors what an LLM would judge from the generation prompt when
  // the agent did not attach an explicit classification — cheap, local,
  // deterministic. Character-ish phrasing wins over scene-ish phrasing.
  if (hints?.content) {
    const c = hints.content.toLowerCase()
    // Character: portrait / character design / 立绘 / 人物 / turnaround.
    const characterHits = /character|portrait|turnaround|persona|立绘|角色|人物|人设|headshot/.exec(c)
    // Scene: background / establishing / environment / 场景 / 背景 / 环境.
    const sceneHits = /scene|background|establishing|environment|landscape|场景|背景|环境|全景/.exec(c)
    // Prop: standalone object 道具/物件/物品 (exclude when a person is
    // the subject, e.g. "holding a prop" should still land in characters).
    const propHits = /^\s*(a|an|the)?\s*(prop|道具|物件|物品)/.exec(c) || /\bprop\b|(?:道具|物件|物品)(?:设计|设定)?$/.exec(c)
    // Reference board.
    const refHits = /reference\s*(board|sheet|image)?|参考图|参考/.exec(c)
    // Concept art.
    const conceptHits = /concept\s*art|concept|概念(设计|图|稿)/.exec(c)
    if (characterHits) return 'characters'
    if (conceptHits) return 'conceptart'
    if (propHits) return 'props'
    if (refHits) return 'reference'
    if (sceneHits) return 'scenes'
  }
  return 'misc'
}

/** Pick a file extension from the input URL, the data: URI MIME, or default
 *  to .png. We don't try to sniff content bytes — the multimodal plugin's
 *  outputs are predictable (Agnes → png, OpenAI → png) and over-sniffing
 *  is fragile when the input is a `data:image/jpeg;base64,...` payload. */
function guessImageExt(input: string): string {
  const lower = input.toLowerCase()
  if (lower.includes('.png') || lower.startsWith('data:image/png')) return '.png'
  if (lower.includes('.webp') || lower.startsWith('data:image/webp')) return '.webp'
  if (lower.includes('.gif') || lower.startsWith('data:image/gif')) return '.gif'
  if (lower.includes('.jpg') || lower.includes('.jpeg') || lower.startsWith('data:image/jpeg')) return '.jpg'
  return '.png'
}

/** Pick a file extension for an audio output (TTS / BGM). Defaults to .mp3. */
function guessAudioExt(input: string): string {
  const lower = input.toLowerCase()
  const m = /\.([a-z0-9]{2,5})$/i.exec(lower.split(/[?#]/, 1)[0] ?? '')
  if (m && /^(mp3|wav|m4a|aac|ogg|oga|flac|opus|mp4|webm)$/i.test(m[1])) return `.${m[1].toLowerCase()}`
  const mime = /^data:audio\/([a-z0-9.+-]+)/i.exec(lower)
  if (mime) {
    const t = mime[1].toLowerCase()
    if (t === 'mpeg') return '.mp3'
    if (t === 'x-wav' || t === 'wav') return '.wav'
    if (t === 'x-m4a' || t === 'mp4' || t === 'x-aac' || t === 'aac') return t === 'mp4' || t === 'x-m4a' ? '.m4a' : '.aac'
    if (t === 'ogg') return '.ogg'
    if (t === 'flac') return '.flac'
    if (t.startsWith('mp4')) return '.m4a'
    return `.${t.replace(/[^a-z0-9]/g, '') || 'mp3'}`
  }
  return '.mp3'
}

export interface PreparedAudio {
  /** Canvas-friendly URL: `projects/<id>/assets/audio/<file>` for sourcePath
   *  projects, `file://<abs>` for default projects. Falls back to the original
   *  input on download failure (same degrade-as-silent contract as images). */
  url: string
  /** Absolute path on disk where the bytes were written ('' on failure). */
  localPath: string
}

/**
 * Take whatever the multimodal plugin returned for a music/TTS node (CDN URL,
 * base64, or a `file://` temp path) and place a stable local file at:
 *   • `<sourcePath>/assets/audio/<file>` for sourcePath projects
 *   • `<wsRoot>/web-jobs/a-<id>.<ext>`       for default projects
 *
 * Mirrors prepareImageForCanvas so refresh-path music nodes stop holding
 * expiring provider URLs (OpenAI TTS links die in ~2h) — the exact failure
 * mode the pin step already prevents for batchAddMedia audio.
 */
export async function prepareAudioForCanvas(
  audioInput: string,
  opts: { wsRoot: string; projectId: string; sourcePath?: string },
): Promise<PreparedAudio> {
  // M5-⑤ — stable filename keyed by the input URL so repeated
  // preps overwrite the same file instead of accumulating orphans.
  const id = createHash('sha1').update(audioInput).digest('hex').slice(0, 16)
  const ext = guessAudioExt(audioInput)
  const filename = `a-${id}${ext}`

  if (opts.sourcePath) {
    const assetsDir = join(opts.sourcePath, 'assets', 'audio')
    const destPath = join(assetsDir, filename)
    try {
      await downloadTo(audioInput, destPath)
    } catch (e) {
      log.warn(`[media-studio] image-cover: audio write to sourcePath failed (${(e as Error).message}); keeping original input`)
      return { url: audioInput, localPath: '' }
    }
    return { url: `projects/${opts.projectId}/assets/audio/${filename}`, localPath: destPath }
  }

  const jobsDir = join(opts.wsRoot, 'web-jobs')
  const destPath = join(jobsDir, filename)
  try {
    await downloadTo(audioInput, destPath)
  } catch (e) {
    log.warn(`[media-studio] image-cover: audio download failed (${(e as Error).message}); keeping original input`)
    return { url: audioInput, localPath: '' }
  }
  return { url: `file://${destPath}`, localPath: destPath }
}

/** Same semantics as `downloadTo` in video-cover.ts — fetch http(s) into a
 *  local file, or copy bytes for `file://` / absolute paths. Inline base64
 *  is decoded and written. */
async function downloadTo(url: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })

  if (/^data:([^;,]+)?;base64,(.*)$/i.test(url)) {
    const m = url.match(/^data:[^;]*;base64,(.*)$/i)
    if (!m) throw new Error('data URI is missing base64 payload')
    await writeFile(dest, Buffer.from(m[1], 'base64'))
    return
  }
  if (/^https?:\/\//i.test(url)) {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download ${url} → HTTP ${res.status}`)
    await writeFile(dest, Buffer.from(await res.arrayBuffer()))
    return
  }
  // file:// / absolute path — copy.
  const localPath = url.startsWith('file://') ? url.slice('file://'.length) : url
  const buf = await readFile(localPath)
  await writeFile(dest, buf)
}

/**
 * Take whatever the multimodal plugin returned (CDN URL / base64 / local
 * file) and place a stable local file at:
 *   • `<sourcePath>/assets/<kindDir>/<file>` for sourcePath projects
 *   • `<wsRoot>/web-jobs/i-<id>.<ext>`     for default projects
 *
 * Returns the canvas-friendly URL the calling tool should write to
 * `resultUrl` / `data.resultUrl`.
 *
 * On any download failure we **do not throw** — we fall back to the
 * original input URL so the canvas card still renders something, and log
 * a warning. The old `image` refresh path had the same silent-fail
 * behavior, so we're not making things worse.
 */
export async function prepareImageForCanvas(
  imageInput: string,
  opts: PrepareImageOptions,
): Promise<PreparedImage> {
  // Pick the destination subdirectory via explicit override → category →
  // tag scan → characterRef → misc fallback. See `inferImageKindDir` for
  // the priority chain; the only thing that *must* change to add a new
  // bucket is the `AssetKindDir` union at the top of this file.
  const kindDir = inferImageKindDir(opts)
  // M5-⑤ — stable filename keyed by the input URL so repeated preps
  // overwrite the same file instead of accumulating orphans.
  const id = createHash('sha1').update(imageInput).digest('hex').slice(0, 16)
  const ext = guessImageExt(imageInput)

  if (opts.sourcePath) {
    const assetsDir = join(opts.sourcePath, 'assets', kindDir)
    const filename = `i-${id}${ext}`
    const destPath = join(assetsDir, filename)
    try {
      await downloadTo(imageInput, destPath)
    } catch (e) {
      log.warn(`[media-studio] image-cover: write to sourcePath failed (${(e as Error).message}); keeping original input`)
      return { url: imageInput, kindDir, localPath: '' }
    }
    // The convention every other media node uses — resolves via
    // `resolveMediaTarget()` to `<sourcePath>/assets/...` at request time.
    return {
      url: `projects/${opts.projectId}/assets/${kindDir}/${filename}`,
      kindDir,
      localPath: destPath,
    }
  }

  // Default project: drop into web-jobs/ and return file:// — same shape
  // `prepareVideoForCanvas` uses, so the media-file proxy can serve it.
  const jobsDir = join(opts.wsRoot, 'web-jobs')
  const filename = `i-${id}${ext}`
  const destPath = join(jobsDir, filename)
  try {
    await downloadTo(imageInput, destPath)
  } catch (e) {
    log.warn(`[media-studio] image-cover: download failed (${(e as Error).message}); keeping original input`)
    return { url: imageInput, kindDir, localPath: '' }
  }
  return { url: `file://${destPath}`, kindDir, localPath: destPath }
}

// Extname re-export to keep the import surface clean.
export { extname as _extnameForTests }