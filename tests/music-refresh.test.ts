/**
 * Regression tests for the MUSIC / TTS refresh contract (round-1 feedback #1, #4).
 *
 *   • M1  dub (TTS) nodes must read UPSTREAM TEXT RAW — never with the
 *        `[<label>]: ` prefix that image/video refresh uses, otherwise the
 *        spoken output literally recites "[剧本]: 我还是来晚了".
 *   • M2  a dub node with an upstream music node and NO explicit
 *        `data.clone_audio` must inherit that upstream audio as the
 *        voice-clone seed, and derive a stable `voice_name` (timbre
 *        propagation down the graph).
 *   • M3  refresh is strictly one-way: `data.prompt` (authored intent) is
 *        preserved; the compiled prompt lands in `data.lastPrompt`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdir, rm, writeFile } from 'node:fs/promises'

interface FakeCtx {
  tools: {
    execute: (input: { name: string; arguments: Record<string, unknown> }) => Promise<{ value: { success: boolean; url: string } }>
  }
}

function makeCtx(calls: Array<{ name: string; args: Record<string, unknown> }>): FakeCtx {
  return {
    tools: {
      execute: async (input) => {
        calls.push({ name: input.name, args: input.arguments })
        return { value: { success: true, url: 'https://provider/out.mp3' } }
      },
    },
  }
}

describe('M1: TTS/dub node reads RAW upstream text (no [label]: prefix)', () => {
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-music-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    canvasStore = new cs.CanvasStore(wsRoot)
    const ss = await import('../src/service-state')
    ss.setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
      projectStore: undefined,
      projectSseClients: new Set(),
    } as never)
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('strips the [label]: prefix and preserves data.prompt / writes lastPrompt', async () => {
    canvasStore.apply('p-m1', [
      { op: 'addNode', type: 'text', label: '剧本', nodeId: 's1', data: { text: '我还是来晚了' } },
      { op: 'addNode', type: 'music', label: '林台词', nodeId: 'm1', data: { dub: true, characterRef: 'lin', prompt: 'FALLBACK_PROMPT' } },
      { op: 'connect', from: 's1', to: 'm1' },
    ])

    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const t = await import('../src/tools')
    const result = await t.executeNodeRefresh(canvasStore, 'p-m1', 'm1', new AbortController().signal, makeCtx(calls) as never)

    expect(result.ok).toBe(true)
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('generate_tts')
    // The spoken text must be raw, label-free.
    expect(calls[0].args.text).toBe('我还是来晚了')
    expect(String(calls[0].args.text)).not.toContain('[剧本]')

    const snap = canvasStore.snapshot('p-m1')
    const n = snap.graph.nodes.find((x) => x.id === 'm1')!
    // Authored intent preserved; compiled prompt audited in lastPrompt.
    expect(n.data.prompt).toBe('FALLBACK_PROMPT')
    expect(n.data.lastPrompt).toBe('我还是来晚了')
    // Music nodes also mirror the text onto data.text for the card.
    expect(n.data.text).toBe('我还是来晚了')
  })
})

describe('M2: dub node inherits clone_audio + voice_name from upstream music', () => {
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-music2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    canvasStore = new cs.CanvasStore(wsRoot)
    const ss = await import('../src/service-state')
    ss.setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
      projectStore: undefined,
      projectSseClients: new Set(),
    } as never)
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('clones the upstream voice and names it after characterRef', async () => {
    // A real-ish absolute audio path on the upstream music node.
    const voiceSeed = '/tmp/ref-voice-lin.wav'
    await writeFile(voiceSeed, Buffer.from('RIFF....'))

    canvasStore.apply('p-m2', [
      { op: 'addNode', type: 'music', label: '林参考声', nodeId: 'ref', data: { text: 'reference voice', resultUrl: voiceSeed } },
      { op: 'addNode', type: 'music', label: '林台词', nodeId: 'm1', data: { dub: true, characterRef: 'lin', prompt: '台词' } },
      { op: 'connect', from: 'ref', to: 'm1' },
    ])

    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const t = await import('../src/tools')
    const result = await t.executeNodeRefresh(canvasStore, 'p-m2', 'm1', new AbortController().signal, makeCtx(calls) as never)

    expect(result.ok).toBe(true)
    expect(calls[0].name).toBe('generate_tts')
    // clone_audio must point at the upstream audio; voice_name derived.
    expect(calls[0].args.clone_audio).toBe(voiceSeed)
    expect(calls[0].args.voice_name).toBe('lin')
  })
})

describe('M3: non-dub music node uses generate_music with raw upstream text', () => {
  let wsRoot: string
  let canvasStore: import('../src/canvas-store').CanvasStore

  beforeEach(async () => {
    wsRoot = join(tmpdir(), `ms-music3-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(wsRoot, { recursive: true })
    const cs = await import('../src/canvas-store')
    canvasStore = new cs.CanvasStore(wsRoot)
    const ss = await import('../src/service-state')
    ss.setMediaStudioHandles({
      workspaceRoot: wsRoot,
      mediaRoots: [],
      defaultCanvasId: 'main',
      canvasStore,
      sseClients: new Set(),
      projectStore: undefined,
      projectSseClients: new Set(),
    } as never)
  })

  afterEach(async () => {
    await rm(wsRoot, { recursive: true, force: true })
  })

  it('routes BGM through generate_music and renders upstream text raw', async () => {
    canvasStore.apply('p-m3', [
      { op: 'addNode', type: 'text', label: '情绪', nodeId: 's1', data: { text: '一段忧伤的钢琴' } },
      { op: 'addNode', type: 'music', label: 'BGM', nodeId: 'm1', data: { prompt: 'FALLBACK' } },
      { op: 'connect', from: 's1', to: 'm1' },
    ])

    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const t = await import('../src/tools')
    const result = await t.executeNodeRefresh(canvasStore, 'p-m3', 'm1', new AbortController().signal, makeCtx(calls) as never)

    expect(result.ok).toBe(true)
    expect(calls[0].name).toBe('generate_music')
    expect(calls[0].args.text).toBe('一段忧伤的钢琴')
  })
})
