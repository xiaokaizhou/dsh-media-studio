/**
 * Pipeline regression tests — 生成 → 下载 → 渲染 链路上的缺陷复现与回归。
 *
 * 对应缺陷（详见分析结论）：
 *   P1  music/TTS 刷新后不落本地，provider URL 会过期破卡
 *   P2  batchAddMedia 视频忽略 sourcePath，永远落 web-jobs/
 *   P3  后处理用 activeCanvasId 而非 patch 目标 canvasId（跨画布错位）
 *   P4a 已 pin 的 https 图片/音频被 auto-register 重复复制进素材库
 *   P4c sourcePath 项目下 registerCanvasAsset 读不到 projects/<id>/… 指向的用户目录文件
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasStore } from '../src/canvas-store'
import { ProjectStore } from '../src/project-store'
import { setMediaStudioHandles } from '../src/service-state'
import { postProcessCanvasPatch, executeNodeRefresh } from '../src/tools'
import { registerCanvasAsset, loadAssetIndex } from '../src/asset-store'

let wsRoot: string
let canvasStore: CanvasStore
let projectStore: ProjectStore

async function setup(): Promise<void> {
  wsRoot = mkdtempSync(join(tmpdir(), 'ms-pipe-reg-'))
  canvasStore = new CanvasStore(wsRoot)
  projectStore = new ProjectStore(wsRoot, canvasStore, { recentLimit: 10, trashEnabled: true, defaultSourcePath: join(wsRoot, "Movies") })
  await projectStore.ready()
  setMediaStudioHandles({
    workspaceRoot: wsRoot,
    mediaRoots: [],
    defaultCanvasId: 'main',
    canvasStore,
    sseClients: new Set(),
    projectStore,
    projectSseClients: new Set(),
  } as never)
}

/** Stub global fetch so https pinning downloads a tiny body without network. */
function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(6),
  })))
}

function filesIn(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith(suffix))
}

afterEach(() => {
  vi.unstubAllGlobals()
  if (wsRoot) rmSync(wsRoot, { recursive: true, force: true })
})

describe('P3: postProcess resolves the TARGET canvas project, not the active one', () => {
  it('pins batchAddMedia media into the target project assets when patching a non-active canvas', async () => {
    await setup()
    stubFetch()
    const activeProj = await projectStore.createProject('active-proj')
    const targetProj = await projectStore.createProject('target-proj')
    await projectStore.openProject(activeProj.id) // active = activeProj, target ≠ active

    const ops = [{ op: 'batchAddMedia' as const, items: [{ kind: 'image' as const, url: 'https://provider/x.png', nodeId: 'n1', prompt: 'cat' }] }]
    const res = canvasStore.apply(targetProj.id, ops)
    const issues = await postProcessCanvasPatch(canvasStore, targetProj.id, ops, res.issues)
    expect(issues.filter((s) => s.startsWith('warn:'))).toHaveLength(0)

    // The pinned file must land in the TARGET project's assets.
    expect(filesIn(join(targetProj.sourcePath!, 'assets', 'characters'), '.png')).toHaveLength(1)
    // …and NOT in the active project's assets.
    expect(filesIn(join(activeProj.sourcePath!, 'assets', 'characters'), '.png')).toHaveLength(0)

    // The node URL must be rewritten to the target project's convention.
    const snap = canvasStore.snapshot(targetProj.id)
    const n = snap.graph.nodes.find((x) => x.id === 'n1')
    expect(n?.data.resultUrl).toMatch(new RegExp(`^projects/${targetProj.id}/`))
  })
})

describe('P4a: pinned media is not double-copied by auto-register', () => {
  it('registers exactly one asset entry and one file for a pinned https image', async () => {
    await setup()
    stubFetch()
    const a = await projectStore.createProject('only-proj')
    const ops = [{ op: 'batchAddMedia' as const, items: [{ kind: 'image' as const, url: 'https://provider/x.png', nodeId: 'n1' }] }]
    const res = canvasStore.apply(a.id, ops)
    const issues = await postProcessCanvasPatch(canvasStore, a.id, ops, res.issues)
    expect(issues.filter((s) => s.startsWith('warn:'))).toHaveLength(0)

    const idx = await loadAssetIndex(join(a.sourcePath!, 'assets'), '.index.json')
    expect(idx.assets).toHaveLength(1)
    expect(filesIn(join(a.sourcePath!, 'assets', 'characters'), '.png')).toHaveLength(1)
  })
})

describe('P2: batchAddMedia video honors the project sourcePath', () => {
  it('lands the video in <sourcePath>/assets/clips and returns projects/<id>/… URL', async () => {
    const src = mkdtempSync(join(tmpdir(), 'ms-srcpath-'))
    try {
      await setup()
      const a = await projectStore.createProject('src-proj', src)
      const vid = join(src, 'fixture.mp4')
      writeFileSync(vid, Buffer.from('fake-mp4-bytes'))

      const ops = [{ op: 'batchAddMedia' as const, items: [{ kind: 'video' as const, url: vid, nodeId: 'v1' }] }]
      const res = canvasStore.apply(a.id, ops)
      await postProcessCanvasPatch(canvasStore, a.id, ops, res.issues)

      const clips = join(src, 'assets', 'clips')
      expect(filesIn(clips, '.mp4')).toHaveLength(1)
      const snap = canvasStore.snapshot(a.id)
      const n = snap.graph.nodes.find((x) => x.id === 'v1')
      expect(n?.data.resultUrl).toMatch(new RegExp(`^projects/${a.id}/assets/clips/`))
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })
})

describe('P4c: registerCanvasAsset reads sourcePath-backed projects/… URLs', () => {
  it('registers a node whose file lives in the user project directory', async () => {
    const src = mkdtempSync(join(tmpdir(), 'ms-srcpath2-'))
    try {
      await setup()
      const a = await projectStore.createProject('src2-proj', src)
      // Simulate a refresh-produced file sitting in the user's project tree.
      const charsDir = join(src, 'assets', 'characters')
      mkdirSync(charsDir, { recursive: true })
      const file = 'i-deadbeef.png'
      writeFileSync(join(charsDir, file), Buffer.from('img-bytes'))
      canvasStore.apply(a.id, [
        { op: 'addNode', type: 'image', label: 'img', nodeId: 'n1', data: { resultUrl: `projects/${a.id}/assets/characters/${file}`, status: 'done' } },
      ])

      const { asset, created } = await registerCanvasAsset({
        wsRoot,
        roots: [],
        canvasStore,
        projectId: a.id,
        sourcePath: src,
        canvasNodeId: 'n1',
        kind: 'character',
      })
      expect(created).toBe(true)
      expect(asset.id).toBeTruthy()
    } finally {
      rmSync(src, { recursive: true, force: true })
    }
  })
})

describe('P1: executeNodeRefresh persists music/TTS output to a stable local file', () => {
  it('rewrites a provider audio URL to a file under web-jobs (default project)', async () => {
    await setup()
    const a = await projectStore.createProject('music-proj')
    const tmpAudio = join(wsRoot, 'provider-tts.mp3')
    writeFileSync(tmpAudio, Buffer.from('tts-bytes'))

    canvasStore.apply(a.id, [
      { op: 'addNode', type: 'music', label: 'vo', nodeId: 'm1', data: { prompt: 'hello', dub: true, status: 'idle' } },
    ])
    const fakeCtx = {
      tools: { execute: async () => ({ value: { success: true, url: tmpAudio } }) },
    }
    const result = await executeNodeRefresh(canvasStore, a.id, 'm1', new AbortController().signal, fakeCtx as never)
    expect(result.ok).toBe(true)

    const snap = canvasStore.snapshot(a.id)
    const n = snap.graph.nodes.find((x) => x.id === 'm1')
    const url = n?.data.resultUrl as string
    // Must be a stable local copy, not the provider temp path.
    expect(url).not.toBe(tmpAudio)
    expect(url.startsWith('file://') || url.startsWith('projects/')).toBe(true)
    expect(filesIn(join(a.sourcePath!, 'assets', 'audio'), '.mp3')).toHaveLength(1)
  })
})
