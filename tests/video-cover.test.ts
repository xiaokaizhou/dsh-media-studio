/**
 * video-cover tests — exercise both happy paths and the silent fallback
 * chain (provider cover → ffmpeg embed → ffmpeg extract → no-op).
 *
 * Each test gets its own wsRoot so web-jobs/ cannot leak across tests
 * (the extract branch intentionally writes a sibling .thumb.jpg there).
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readdir, copyFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { prepareVideoForCanvas, resolveLocalVideoPath, extractPosterInPlace } from '../src/video-cover'

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
  it('embeds provider cover into MP4 and returns the cover as external poster', async () => {
    if (!ffmpegAvailable) return
    const wsRoot = await newWs()
    try {
      const result = await prepareVideoForCanvas(fixtureVideo, {
        wsRoot,
        providerExtras: { coverUrl: fixtureCover },
      })
      expect(result.url).toMatch(/web-jobs[\\/]v-[0-9a-f]+\.mp4$/)
      // Embed branch still keeps the cover as an external .poster.jpg because
      // the frontend LazyVideo renders a plain <img> before first click (no
      // <video> element), so the MP4-attached_pic alone is never visible.
      expect(result.poster).toMatch(/v-[0-9a-f]+\.poster\.jpg$/)
      // prepareVideoForCanvas returns file://-prefixed URLs (the same
      // convention as resultUrl); strip the prefix before stat.
      const posterStat = await stat(result.poster!.replace(/^file:\/\//, ''))
      expect(posterStat.size).toBeGreaterThan(0)

      const jobsDir = join(wsRoot, 'web-jobs')
      const entries = await readdir(jobsDir)
      // Embed branch → exactly one .mp4 + one .poster.jpg, no .thumb.jpg.
      expect(entries.filter((n) => n.endsWith('.mp4'))).toHaveLength(1)
      expect(entries.filter((n) => n.endsWith('.poster.jpg'))).toHaveLength(1)
      expect(entries.filter((n) => n.endsWith('.thumb.jpg'))).toHaveLength(0)

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
      const posterStat = await stat(result.poster!.replace(/^file:\/\//, ''))
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
        // Embed branch → poster is the external .poster.jpg; confirms the
        // field was picked up and the cover was downloaded.
        expect(r.poster).toMatch(/v-[0-9a-f]+\.poster\.jpg$/)
        const jobsDir = join(wsRoot, 'web-jobs')
        const entries = await readdir(jobsDir)
        expect(entries.filter((n) => n.endsWith('.mp4'))).toHaveLength(1)
        expect(entries.filter((n) => n.endsWith('.poster.jpg'))).toHaveLength(1)
      } finally {
        await rm(wsRoot, { recursive: true, force: true })
      }
    }
  }, 60_000)
})

describe('backfillVideoPosters', () => {
  it('extracts posters in place for legacy `assets/...` urls and leaves resultUrl unchanged', async () => {
    if (!ffmpegAvailable) return
    // Dynamic import — tools.ts pulls in cordis context bits that aren't
    // safe to load at module-evaluation time in a test harness.
    const { CanvasStore } = await import('../src/canvas-store')
    const { backfillVideoPosters } = await import('../src/tools')

    const wsRoot = await newWs()
    const sourcePath = await mkdtemp(join(tmpdir(), 'media-studio-vc-backfill-'))
    const clipsDir = join(sourcePath, 'assets', 'clips')
    await mkdir(clipsDir, { recursive: true })
    // Stage the fixture inside the project's assets/clips/ — that's
    // exactly the legacy layout (a previously-written file the canvas
    // references by its bare `assets/...` URL form).
    const stagedClip = join(clipsDir, 'final.mp4')
    await copyFile(fixtureVideo, stagedClip)
    try {
      const store = new CanvasStore(wsRoot)
      const projectId = 'p-test'
      store.setCanvasSourcePath(projectId, sourcePath)

      // v1 — legacy bare `assets/...` URL (the form that broke before).
      const r1 = store.apply(projectId, [{
        op: 'addNode', type: 'video', nodeId: 'v1', label: '片段一_开场', data: {
          resultUrl: 'assets/clips/final.mp4',
          status: 'done',
        }, position: { x: 0, y: 0 },
      }])
      if (r1.issues.length) throw new Error('addNode v1 failed: ' + r1.issues.join('; '))

      // v2 — already has a poster, must be skipped (idempotent).
      const r2 = store.apply(projectId, [{
        op: 'addNode', type: 'video', nodeId: 'v2', label: '已带封面', data: {
          resultUrl: 'assets/clips/final.mp4',
          status: 'done',
          poster: 'file:///already-here.jpg',
        }, position: { x: 200, y: 0 },
      }])
      if (r2.issues.length) throw new Error('addNode v2 failed: ' + r2.issues.join('; '))

      // v3 — remote URL; out of scope for the in-place backfill (the user
      // would need to refresh the node to repopulate resultUrl).
      const r3 = store.apply(projectId, [{
        op: 'addNode', type: 'video', nodeId: 'v3', label: '远端', data: {
          resultUrl: 'https://example.com/foo.mp4',
          status: 'done',
        }, position: { x: 400, y: 0 },
      }])
      if (r3.issues.length) throw new Error('addNode v3 failed: ' + r3.issues.join('; '))

      const result = await backfillVideoPosters(projectId, wsRoot, sourcePath, store)
      expect(result.processed).toBe(1) // only v1 — v2 already covered, v3 is remote
      expect(result.succeeded).toBe(1)
      expect(result.issues).toEqual([])

      const snap = store.snapshot(projectId)
      const v1 = snap.graph.nodes.find((n) => n.id === 'v1')!
      // resultUrl MUST stay the legacy `assets/clips/final.mp4` form —
      // the whole point of the in-place backfill is not to rename the
      // user's video file.
      expect((v1.data as Record<string, unknown>).resultUrl).toBe('assets/clips/final.mp4')
      // Poster is the bare `assets/clips/...` sibling URL — same convention
      // the canvas already uses, so `mediaSrc` rewrites it through
      // `projects/<id>/...` automatically. The exact filename mirrors
      // the source video (so `final.mp4` → `final.mp4.thumb.jpg`).
      expect((v1.data as Record<string, unknown>).poster).toBe('assets/clips/final.mp4.thumb.jpg')

      // v2 was untouched.
      const v2 = snap.graph.nodes.find((n) => n.id === 'v2')!
      expect((v2.data as Record<string, unknown>).poster).toBe('file:///already-here.jpg')

      // v3 was skipped entirely (no poster, no error — it's a remote URL
      // the in-place backfill deliberately doesn't touch).
      const v3 = snap.graph.nodes.find((n) => n.id === 'v3')!
      expect((v3.data as Record<string, unknown>).poster).toBeUndefined()

      // The original MP4 must still exist where the user left it.
      const stillThere = await stat(stagedClip)
      expect(stillThere.size).toBeGreaterThan(0)
      // ...and the .thumb.jpg sibling landed next to it.
      const thumbStat = await stat(join(clipsDir, 'final.mp4.thumb.jpg'))
      expect(thumbStat.size).toBeGreaterThan(0)
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
      await rm(sourcePath, { recursive: true, force: true })
    }
  }, 30_000)

  it('handles `projects/<id>/...` urls the same way', async () => {
    if (!ffmpegAvailable) return
    const { CanvasStore } = await import('../src/canvas-store')
    const { backfillVideoPosters } = await import('../src/tools')

    const wsRoot = await newWs()
    const sourcePath = await mkdtemp(join(tmpdir(), 'media-studio-vc-proj-'))
    const clipsDir = join(sourcePath, 'assets', 'clips')
    await mkdir(clipsDir, { recursive: true })
    const stagedClip = join(clipsDir, 'clip.mp4')
    await copyFile(fixtureVideo, stagedClip)
    try {
      const store = new CanvasStore(wsRoot)
      const projectId = 'p-proj'
      store.setCanvasSourcePath(projectId, sourcePath)
      store.apply(projectId, [{
        op: 'addNode', type: 'video', nodeId: 'v1', label: 'clip', data: {
          resultUrl: `projects/${projectId}/assets/clips/clip.mp4`,
          status: 'done',
        }, position: { x: 0, y: 0 },
      }])
      const result = await backfillVideoPosters(projectId, wsRoot, sourcePath, store)
      expect(result.succeeded).toBe(1)
      const v1 = store.snapshot(projectId).graph.nodes.find((n) => n.id === 'v1')!
      // resultUrl stays put.
      expect((v1.data as Record<string, unknown>).resultUrl)
        .toBe(`projects/${projectId}/assets/clips/clip.mp4`)
      // poster points at the sibling thumb (filename mirrors the source).
      expect((v1.data as Record<string, unknown>).poster as string)
        .toMatch(/clip\.mp4\.thumb\.jpg$/)
    } finally {
      await rm(wsRoot, { recursive: true, force: true })
      await rm(sourcePath, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('resolveLocalVideoPath', () => {
  it('returns null for remote URLs (https / data: / blob: / /api/)', () => {
    expect(resolveLocalVideoPath('https://example.com/x.mp4')).toBeNull()
    expect(resolveLocalVideoPath('http://example.com/x.mp4')).toBeNull()
    expect(resolveLocalVideoPath('data:video/mp4;base64,AAA')).toBeNull()
    expect(resolveLocalVideoPath('blob:http://localhost/abc')).toBeNull()
    expect(resolveLocalVideoPath('/api/media-studio/media-file?path=foo')).toBeNull()
  })
  it('strips file:// prefix', () => {
    expect(resolveLocalVideoPath('file:///tmp/foo.mp4')).toBe('/tmp/foo.mp4')
  })
  it('passes absolute POSIX / Windows paths through', () => {
    expect(resolveLocalVideoPath('/tmp/foo.mp4')).toBe('/tmp/foo.mp4')
    expect(resolveLocalVideoPath('C:\\tmp\\foo.mp4')).toBe('C:\\tmp\\foo.mp4')
  })
  it('refuses bare relative paths when no sourcePath is supplied', () => {
    expect(resolveLocalVideoPath('assets/clips/foo.mp4')).toBeNull()
  })
  it('joins bare `assets/...` paths onto sourcePath', () => {
    expect(resolveLocalVideoPath('assets/clips/foo.mp4', '/projects/x'))
      .toBe('/projects/x/assets/clips/foo.mp4')
  })
  it('resolves `projects/<id>/...` via supplied sourcePath when id matches (no registry needed)', () => {
    expect(resolveLocalVideoPath('projects/p-test/assets/clips/foo.mp4', '/projects/x', 'p-test'))
      .toBe('/projects/x/assets/clips/foo.mp4')
  })
  it('returns null for `projects/<id>/...` when no sourcePath / registry is available', () => {
    expect(resolveLocalVideoPath('projects/p-test/assets/clips/foo.mp4')).toBeNull()
  })
})

describe('extractPosterInPlace', () => {
  it('writes a sibling .thumb.jpg and returns its absolute path', async () => {
    if (!ffmpegAvailable) return
    const stagedDir = await mkdtemp(join(tmpdir(), 'media-studio-extract-'))
    try {
      const stagedClip = join(stagedDir, 'movie.mp4')
      await copyFile(fixtureVideo, stagedClip)
      const out = await extractPosterInPlace(stagedClip)
      expect(out).toBe(`${stagedClip}.thumb.jpg`)
      const s = await stat(out!)
      expect(s.size).toBeGreaterThan(0)
    } finally {
      await rm(stagedDir, { recursive: true, force: true })
    }
  }, 30_000)

  it('returns null for non-existent input (does not throw)', async () => {
    if (!ffmpegAvailable) return
    const stagedDir = await mkdtemp(join(tmpdir(), 'media-studio-extract-missing-'))
    try {
      const out = await extractPosterInPlace(join(stagedDir, 'nope.mp4'))
      expect(out).toBeNull()
    } finally {
      await rm(stagedDir, { recursive: true, force: true })
    }
  }, 30_000)
})
