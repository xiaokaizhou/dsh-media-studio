import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CanvasStore } from '../src/canvas-store'
import { collectMediaNodesFromOps } from '../src/tools'

let workspaceRoot: string
let store: CanvasStore

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'media-studio-autorreg-'))
  store = new CanvasStore(workspaceRoot)
})

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

describe('collectMediaNodesFromOps', () => {
  it('picks up addNode ops with image/video/music + resultUrl', () => {
    const ops = [
      { op: 'addNode' as const, type: 'image' as const, label: 'A', nodeId: 'n1', data: { resultUrl: 'foo.png' } },
      { op: 'addNode' as const, type: 'video' as const, label: 'B', nodeId: 'n2', data: { resultUrl: 'foo.mp4' } },
      { op: 'addNode' as const, type: 'music' as const, label: 'C', nodeId: 'n3', data: { resultUrl: 'foo.mp3' } },
      { op: 'addNode' as const, type: 'text' as const, label: 'D', nodeId: 'n4', data: { text: 'no media' } },
    ]
    const result = collectMediaNodesFromOps(ops as [], [])
    expect(result).toHaveLength(3)
    expect(result.map((r) => r.nodeId)).toEqual(['n1', 'n2', 'n3'])
  })

  it('skips media nodes without resultUrl (advisory not warranted)', () => {
    const ops = [
      { op: 'addNode' as const, type: 'image' as const, label: 'A', nodeId: 'n1', data: { prompt: 'will be filled later' } },
    ]
    const result = collectMediaNodesFromOps(ops as [], [])
    expect(result).toHaveLength(0)
  })

  it('picks up updateNode ops when post-patch node has resultUrl', () => {
    const postNodes = [
      { id: 'n1', type: 'image' as const, label: 'A', data: { resultUrl: 'foo.png' }, position: { x: 0, y: 0 } },
    ]
    const ops = [
      { op: 'updateNode' as const, id: 'n1', data: { status: 'done', resultUrl: 'foo.png' } },
    ]
    const result = collectMediaNodesFromOps(ops as [], postNodes as [])
    expect(result).toHaveLength(1)
    expect(result[0].nodeId).toBe('n1')
    expect(result[0].nodeType).toBe('image')
  })

  it('handles batchAddMedia items', () => {
    const ops = [{
      op: 'batchAddMedia' as const,
      items: [
        { kind: 'image' as const, url: 'foo.png', nodeId: 'n1' },
        { kind: 'video' as const, url: 'foo.mp4', nodeId: 'n2' },
        { kind: 'audio' as const, url: 'foo.mp3', nodeId: 'n3' },
      ],
    }]
    const result = collectMediaNodesFromOps(ops as [], [])
    expect(result).toHaveLength(3)
    // audio items map to 'music' canvas node type for asset registration
    expect(result[2].nodeType).toBe('music')
  })
})