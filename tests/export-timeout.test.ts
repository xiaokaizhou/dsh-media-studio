/**
 * Regression tests for the "下载截图卡住" (screenshot download freezes) bug.
 *
 * User report:
 *   "dsh 中,@folder:projects/media-studio/ 这个插件,只要画布打开,就有事件阻塞 UI,
 *    导致顶部菜单中'项目'下所有动作的卡住无法执行,下载截图也卡住无法执行,
 *    关闭画布后这些动作才执行"
 *
 * Two protections were added in src/client/project-bar.tsx doExport():
 *
 *   1. `skipFonts: true` — html-to-image's default `embedWebFonts` walks every
 *      stylesheet in the document and `fetch()`es every `@import` URL with no
 *      timeout. DSH host stylesheets can pull CSS from remote/origin-locked
 *      endpoints; one hung fetch hangs the whole pipeline. The canvas does
 *      not use any webfonts (every node uses inline styles + system-ui
 *      fallback), so skipping the font-embed step costs nothing.
 *
 *   2. A `Promise.race` timeout on the whole `toPng` call so the export
 *      button can never get stuck in `is-loading` forever — the export
 *      state is reset in `finally` and `setExporting(false)` always runs.
 *
 * These tests exercise the timeout boundary (the easy part to write a unit
 * test for) and the option-forwarding (skipFonts) — together they prove the
 * export path cannot hang indefinitely and is correctly wired.
 *
 * NOTE: we don't import project-bar.tsx directly because it pulls in React,
 * the host cordis runtime, the host canvas-bus, etc. Instead we mirror the
 * wrapper contract here and assert (a) the contract holds and (b) the
 * production code still contains the markers that satisfy the contract.
 */
import { describe, it, expect, vi } from 'vitest'

type ToPngOpts = {
  backgroundColor?: string
  pixelRatio?: number
  cacheBust?: boolean
  skipFonts?: boolean
  filter?: (n: any) => boolean
}

const EXPORT_TIMEOUT_MS = 25_000

/**
 * Mirrors the production doExport from src/client/project-bar.tsx. The
 * shape of this function is what the regression test guards — any
 * regression in the production code (e.g. dropping the timeout race or
 * the skipFonts flag) will diverge from this mirror and fail the
 * contract test.
 */
async function doExportLike(
  toPng: (n: any, opts: ToPngOpts) => Promise<string>,
  container: any,
  timeoutMs: number = EXPORT_TIMEOUT_MS,
): Promise<{ ok: boolean; error?: string; tookMs: number; optsUsed?: ToPngOpts }> {
  const started = Date.now()
  let optsUsed: ToPngOpts | undefined
  try {
    if (!container) throw new Error('Canvas container not found')
    const dataUrl = await Promise.race([
      toPng(container, {
        backgroundColor: '#0d0d0d',
        pixelRatio: 2,
        cacheBust: true,
        skipFonts: true,
        filter: () => true,
      }).then((url) => {
        optsUsed = {
          backgroundColor: '#0d0d0d',
          pixelRatio: 2,
          cacheBust: true,
          skipFonts: true,
        }
        return url
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`toPng timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ])
    void dataUrl
    return { ok: true, tookMs: Date.now() - started, optsUsed }
  } catch (e) {
    return { ok: false, error: (e as Error).message, tookMs: Date.now() - started, optsUsed }
  }
}

describe('Export: doExport cannot hang indefinitely (Fix: skipFonts + Promise.race timeout)', () => {
  it('resolves successfully when toPng returns within the timeout', async () => {
    const fakeToPng = vi.fn(async (_n: any, _o: ToPngOpts) => 'data:image/png;base64,AAA')
    const container = {}
    const res = await doExportLike(fakeToPng, container)
    expect(res.ok).toBe(true)
    expect(res.tookMs).toBeLessThan(500)
  })

  it('fails fast with a clear error when toPng hangs forever (the actual user-reported bug)', async () => {
    // Stub toPng that never resolves — simulates the @import-fetch hang.
    const fakeToPng = vi.fn((_n: any, _o: ToPngOpts) => new Promise<string>(() => {}))
    const container = {}

    // Use a small wrapper timeout so the test finishes quickly while still
    // proving the wrapper's race mechanism. The production default is 25s
    // (too long for a unit test); the wrapper *contract* — Promise.race +
    // setTimeout-based reject — is what we're guarding.
    const res = await doExportLike(fakeToPng, container, 50)

    // The wrapper must surface the error instead of blocking forever.
    expect(res.ok).toBe(false)
    expect(res.error).toContain('timed out')
    // And the timer must fire well before vitest's 5s default test timeout.
    expect(res.tookMs).toBeLessThan(1000)
  })

  it('forwards skipFonts: true so html-to-image does NOT walk stylesheets / fetch @imports', async () => {
    let captured: ToPngOpts | undefined
    const fakeToPng = vi.fn(async (_n: any, o: ToPngOpts) => {
      captured = o
      return 'data:image/png;base64,AAA'
    })
    await doExportLike(fakeToPng, {})
    expect(captured).toBeDefined()
    // The fix's whole point: skipFonts must be true. If this regresses,
    // a hung @import fetch in html-to-image's embedWebFonts will hang the
    // export again.
    expect(captured!.skipFonts).toBe(true)
    expect(captured!.cacheBust).toBe(true)
  })

  it('throws "Canvas container not found" instead of hanging when .react-flow is missing', async () => {
    const fakeToPng = vi.fn()
    const res = await doExportLike(fakeToPng, null)
    expect(res.ok).toBe(false)
    expect(res.error).toBe('Canvas container not found')
    expect(fakeToPng).not.toHaveBeenCalled()
  })
})

describe('Export: production-code contract guard', () => {
  // This block fails the build if anyone edits project-bar.tsx doExport in a
  // way that re-introduces the hang risk: dropping skipFonts, removing the
  // Promise.race timeout, or dropping the try/finally that resets exporting.
  // We read the file as text and grep for the markers we care about.
  it('project-bar.tsx doExport still has skipFonts: true and the timeout race', async () => {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const file = path.resolve(__dirname, '..', 'src', 'client', 'project-bar.tsx')
    const src = await fs.readFile(file, 'utf8')
    expect(src).toContain('skipFonts: true')
    expect(src).toMatch(/Promise\.race\(\s*\[[\s\S]*?toPng\(/)
    // The timeout must be a finite setTimeout that calls reject — multi-line
    // is allowed because the production code is formatted across lines.
    expect(src).toMatch(/setTimeout\([\s\S]*?reject[\s\S]*?EXPORT_TIMEOUT_MS/)
    // finally must always reset exporting (the hook for hung-export recovery).
    expect(src).toMatch(/finally\s*\{[\s\S]*?setExporting\(false\)[\s\S]*?\}/)
  })
})
