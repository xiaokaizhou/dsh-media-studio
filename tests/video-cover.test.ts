/**
 * video-cover tests — exercise both happy paths and the silent fallback
 * chain (provider cover → ffmpeg embed → ffmpeg extract → no-op).
 *
 * Each test gets its own wsRoot so web-jobs/ cannot leak across tests
 * (the extract branch intentionally writes a sibling .thumb.jpg there).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { prepareVideoForCanvas } from '../src/video-cover'

let ffmpegAvailable = false
let fixtureDir: string
let fixtureVideo: string
let fixtureCover: string

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c) => { err += c.toString() })
    p.on('error', reject)
    p.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`)),
    )
  })
}

async function newWs(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'media-studio-vc-'))
}

beforeAll(async () => {
  // Probe ffmpeg once — environment without ffmpeg will skip the
  // dependent tests rather than fail.
  try {
    await runFfmpeg(['-version'])
    ffmpegAvailable = true
  } catch {
    ffmpegAvailable = false
  }

  if (!ffmpegAvailable) return

  // Build the fixture set once: one tiny MP4 + one tiny JPG cover.
  fixtureDir = await mkdtemp(join(tmpdir(), 'media-studio-vc-fixtures-'))
  fixtureVideo = join(fixtureDir, 'src.mp4')
  fixtureCover = join(fixtureDir, 'cover.jpg')
  await runFfmpeg([
    '-y', '-f', 'lavfi',
    '-i', 'testsrc=duration=1:size=64x64:rate=8',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
    fixtureVideo,
  ])
  await runFfmpeg([
    '-y', '-f', 'lavfi',
    '-i', 'color=red:s=32x32:d=0.04',
    '-frames:v', '1',
    fixtureCover,
  ])
})

afterEach(async () => {
  // No-op: each test creates + cleans its own wsRoot.
})

describe('prepareVideoForCanvas', () => {
  it('embeds provider cover into MP4 and returns no separate poster', async () => {
    if (!ffmpegAvailable) return
    const wsRoot = await newWs()
    try {
      const result = await prepareVideoForCanvas(fixtureVideo, {
        wsRoot,
        providerExtras: { coverUrl: fixtureCover },
      })
      expect(result.url).toMatch(/web-jobs[\\/]v-[0-9a-f]+\.mp4$/)
      expect(result.poster).toBeNull()

      const jobsDir = join(wsRoot, 'web-jobs')
      const entries = await readdir(jobsDir)
      // Embed branch → exactly one .mp4, no sibling .thumb.jpg.
      expect(entries.filter((n) => n.endsWith('.mp4'))).toHaveLength(1)
      expect(entries.filter((n) => n.endsWith('.jpg'))).toHaveLength(0)

      // Confirm a stream with disposition "attached pic" exists.
      const probe = await new Promise<string>((resolve, reject) => {
        const p = spawn('ffmpeg', ['-i', result.url], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', (c) => { err += c.toString() })
        p.on('error', reject)
        p.on('close', () => resolve(err))
      })
      expect(probe).toMatch(/Stream #0:1.*Video:/)
      expect(probe).toMatch(/attached pic/)
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('extracts first frame when provider has no cover', async () => {
    if (!ffmpegAvailable) return
    const wsRoot = await newWs()
    try {
      const result = await prepareVideoForCanvas(fixtureVideo, {
        wsRoot,
        providerExtras: { /* no cover */ },
      })
      expect(result.url).toMatch(/web-jobs[\\/]v-[0-9a-f]+\.mp4$/)
      expect(result.poster).toMatch(/v-[0-9a-f]+\.thumb\.jpg$/)
      const posterStat = await stat(result.poster!)
      expect(posterStat.size).toBeGreaterThan(0)

      // Local mp4 should NOT have an extra stream (no embed was attempted).
      const probe = await new Promise<string>((resolve, reject) => {
        const p = spawn('ffmpeg', ['-i', result.url], { stdio: ['ignore', 'ignore', 'pipe'] })
        let err = ''
        p.stderr.on('data', (c) => { err += c.toString() })
        p.on('error', reject)
        p.on('close', () => resolve(err))
      })
      expect(probe).not.toMatch(/attached pic/)
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
    }
  }, 30_000)

  it('falls back to local copy with no poster when ffmpeg is unavailable', async () => {
    // Force the no-ffmpeg branch by pointing at a binary that does not exist.
    const prev = process.env.FFMPEG_PATH
    process.env.FFMPEG_PATH = '/nonexistent/ffmpeg-binary-that-should-not-exist'
    try {
      const wsRoot = await newWs()
      try {
        const result = await prepareVideoForCanvas(fixtureVideo, {
          wsRoot,
          providerExtras: { coverUrl: fixtureCover },
        })
        // Both embed and extract must be skipped → poster stays null.
        expect(result.poster).toBeNull()
        expect(result.url).toMatch(/web-jobs[\\/]v-[0-9a-f]+\.mp4$/)
        const jobsDir = join(wsRoot, 'web-jobs')
        const entries = await readdir(jobsDir)
        // Should be exactly one .mp4 (no .thumb.jpg sidecar, no cover.jpg).
        expect(entries.filter((n) => n.endsWith('.thumb.jpg'))).toHaveLength(0)
        expect(entries.filter((n) => n.endsWith('.mp4'))).toHaveLength(1)
      } finally {
        await rm(wsRoot, { recursive: true, force: true })
      }
    } finally {
      if (prev === undefined) delete process.env.FFMPEG_PATH
      else process.env.FFMPEG_PATH = prev
    }
  }, 30_000)

  it('returns original URL when download fails', async () => {
    const wsRoot = await newWs()
    try {
      const result = await prepareVideoForCanvas(join(wsRoot, 'does-not-exist.mp4'), {
        wsRoot,
        providerExtras: {},
      })
      expect(result.url).toMatch(/does-not-exist\.mp4$/)
      expect(result.poster).toBeNull()
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
    }
  })

  it('picks cover URL from any of the common provider field names', async () => {
    if (!ffmpegAvailable) return
    const aliases = [
      'coverUrl',
      'cover_url',
      'thumbnailUrl',
      'thumbnail_url',
      'posterUrl',
      'coverImage',
      'thumbnail',
    ]
    for (const key of aliases) {
      const wsRoot = await newWs()
      try {
        const r = await prepareVideoForCanvas(fixtureVideo, {
          wsRoot,
          providerExtras: { [key]: fixtureCover },
        })
        // Embed branch → poster null; just confirms the field was picked up.
        expect(r.poster).toBeNull()
        const jobsDir = join(wsRoot, 'web-jobs')
        const entries = await readdir(jobsDir)
        expect(entries.filter((n) => n.endsWith('.mp4'))).toHaveLength(1)
        expect(entries.filter((n) => n.endsWith('.jpg'))).toHaveLength(0)
      } finally {
        await rm(wsRoot, { recursive: true, force: true })
      }
    }
  }, 60_000)
})
