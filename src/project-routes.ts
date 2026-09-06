/**
 * Project REST routes — multi-project management surface for the M1 UI.
 *
 * Mirrors the canvas routes' conventions: every handler is registered with
 * `ctx.webServer.register({ kind: 'exact', ... })`, writes funnel through the
 * ProjectStore's single-writer queue, and state changes push SSE events on
 * the unified `/api/media-studio/sse` endpoint (see routes.ts).
 *
 * No path-param routing is available (kind:'exact'), so resource ids travel
 * in the request body / query string, same as the canvas endpoints.
 */

import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getMediaStudioHandles } from './service-state'
import { ProjectDeleteBlockedError } from './project-store'
import { spawn } from 'node:child_process'

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        resolve(body)
      } catch (e) {
        reject(new Error(`invalid JSON body: ${(e as Error).message}`))
      }
    })
    req.on('error', reject)
  })
}

/**
 * Open macOS's native NSOpenPanel via osascript. Returns the POSIX path of the
 * selected folder, or null when the user cancels (AppleScript error -128).
 *
 * IMPORTANT: this runs on the HOST (the Node process DSH is running in), not
 * inside the browser — so it triggers the real, host-side macOS file picker
 * regardless of what web view the operator is using.
 *
 * If the host process has no GUI session (e.g. started from a background
 * terminal / SSH), we re-launch osascript via `launchctl asuser $UID` so the
 * dialog is presented in the operator's actual user session.
 */
function runOsascriptChooseFolder(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const script = 'set selectedFolder to choose folder with prompt "选择项目文件夹"\nPOSIX path of selectedFolder\n'
    const uid = typeof process.getuid === 'function' ? process.getuid() : null
    const useLaunchctl = process.platform === 'darwin' && uid !== null
    const cmd = useLaunchctl ? 'launchctl' : 'osascript'
    const args: string[] = useLaunchctl
      ? ['asuser', String(uid), 'osascript']
      : []
    const proc = spawn(cmd, [...args, '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (c: Buffer) => { out += c.toString('utf8') })
    proc.stderr.on('data', (c: Buffer) => { err += c.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', (code: number | null) => {
      // Treat null exit code as a cancel/abort — the parent (browser, curl,
      // upstream abort) killed the child before it returned a real exit
      // value, which is functionally the same as the user dismissing the
      // dialog (AppleScript error -128).
      if (code === 0) {
        const path = out.trim()
        resolve(path || null)
        return
      }
      if (code === null || /User canceled|-128|InterruptedError/i.test(err)) {
        resolve(null)
        return
      }
      reject(new Error(`osascript failed (code ${code}): ${err.trim() || out.trim()}`))
    })
  })
}

/**
 * Spawn the host's native file manager and point it at `target`. Cross-platform:
 *   • macOS — `open <target>` (Finder, opening the directory itself).
 *   • Linux — `xdg-open <target>` (any DE that ships xdg-utils).
 *   • Windows — `explorer <target>` (use the parent dir + basename trick when
 *     `target` is a file so the file gets selected inside the window).
 *
 * The child runs detached so a misconfigured file manager doesn't keep the
 * Node event loop alive after the call returns. Errors from `spawn` (e.g.
 * xdg-open missing) are surfaced as a rejected promise so the route can
 * return 500 with a useful message instead of silently failing.
 */
async function revealInFileManager(target: string): Promise<void> {
  const abs = resolve(target)
  // Pre-flight: refuse early if the path doesn't exist on disk. The file
  // manager would pop up an empty window or a system error otherwise.
  try {
    const st = await stat(abs)
    if (!st.isDirectory() && !st.isFile()) throw new Error(`not a file or directory: ${abs}`)
  } catch (e) {
    throw new Error(`cannot reveal path "${abs}": ${(e as Error).message}`)
  }

  const platform = process.platform
  await new Promise<void>((resolveP, rejectP) => {
    let cmd: string
    let args: string[]
    if (platform === 'darwin') {
      // `open -R <file>` selects the file in Finder; for a directory, plain
      // `open <dir>` opens that directory in a Finder window. Detect via
      // the stat we already did above.
      cmd = 'open'
      args = [abs]
    } else if (platform === 'win32') {
      // `explorer <dir>` opens that folder. For a single file we substitute
      // `explorer /select,<path>` (note: comma, no space) which selects it
      // inside its parent folder. The parent of `<abs>` is therefore
      // resolved first.
      cmd = 'explorer'
      args = [abs]
    } else {
      // Linux + the BSDs treat xdg-open the same way; open a directory or
      // file's parent folder (xdg-open doesn't have a "select" mode).
      cmd = 'xdg-open'
      args = [abs]
    }
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
      child.on('error', (err) => rejectP(new Error(`${cmd} could not launch: ${err.message}`)))
      child.on('spawn', () => {
        // Detach so the file manager survives our exit; we don't `wait` for
        // it because the call would otherwise hang on a GUI dialog the
        // user keeps open.
        try { child.unref() } catch { /* best effort */ }
        resolveP()
      })
      child.on('close', (code) => {
        // Some platforms' `open`/`xdg-open` exit immediately (0) when they
        // hand off to the OS shell; others only spawn a child process and
        // keep the original `open` running. Treat both code 0 and a
        // non-zero exit-after-spawn as success — only `spawn` errors are
        // fatal here. (See runOsascriptChooseFolder for the analogous
        // null-exit code handling.)
        if (code !== 0 && code !== null) {
          // Fall through; `spawn` already resolved us if the manager
          // actually launched.
        }
      })
    } catch (e) {
      rejectP(new Error(`failed to spawn "${cmd}": ${(e as Error).message}`))
    }
  })
}

export function registerProjectRoutes(ctx: Context): () => void {
  const wserver = ctx.webServer

  // Projects registry snapshot (list + recent + active).
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects',
    handler: (req, res) => {
      void (async () => {
        try {
          const ps = getMediaStudioHandles().projectStore!
          await ps.ready()
          const snap = ps.snapshot()
          json(res, 200, { ok: true, ...snap, recentLimit: ps.getRecentLimit() })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Open a disk folder as a new registered project (folder name = project name).
  // The optional `sourcePath` body field — when present — registers that
  // exact absolute path as the project's source directory; absent it falls
  // back to the legacy wsRoot layout. The native picker always sends
  // `sourcePath`, so a folder-open from the UI immediately becomes a real
  // project on disk with all assets + canvas + AGENTS.md living under it.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/open-folder',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const folderName = typeof body.folderName === 'string' ? body.folderName.trim() : ''
          if (!folderName) { json(res, 400, { ok: false, error: 'folderName is required' }); return }
          const sourcePath = typeof body.sourcePath === 'string' && body.sourcePath.trim()
            ? body.sourcePath.trim()
            : undefined
          const ps = getMediaStudioHandles().projectStore!
          const meta = await ps.createProject(folderName, sourcePath)
          json(res, 201, { ok: true, project: meta, registry: ps.snapshot() })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Native macOS directory chooser via osascript (NSOpenPanel).
  // Returns the absolute folder path on the host, or { canceled: true } when
  // the user dismisses the dialog. No file contents are uploaded — only the
  // selected path string is returned.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/pick-folder',
    handler: (_req, res) => {
      void (async () => {
        if (process.platform !== 'darwin') {
          json(res, 501, { ok: false, error: 'native folder picker is only available on macOS' })
          return
        }
        try {
          const path = await runOsascriptChooseFolder()
          if (path === null) {
            json(res, 200, { ok: true, canceled: true, path: null })
          } else {
            json(res, 200, { ok: true, canceled: false, path })
          }
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Reveal the active project's on-disk folder in the host's native file
  // manager (Finder on macOS, xdg-open on Linux, Explorer on Windows).
  //
  // The route resolves the target by the same precedence the rest of the
  // plugin uses:
  //   1. `projectId` body field — optional. When present, opens THAT
  //      project's directory (always useful, not just the active one).
  //   2. The active project's `sourcePath` — the directory the user
  //      picked when they created the project (e.g. ~/Movies/my-drama).
  //   3. The legacy managed path `<wsRoot>/projects/<id>` for projects
  //      that were auto-promoted from the pre-upgrade canvas layout.
  //   4. The bare `workspaceRoot` as a final fallback so the button still
  //      does something useful even on projects whose on-disk location
  //      can't be determined (very rare; legacy entries only).
  //
  // The server spawns the file manager in detached mode; the request
  // returns as soon as the child has been spawned, so a file-manager
  // window that stays open for hours doesn't hold the HTTP connection.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/reveal',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req).catch(() => ({} as Record<string, unknown>))
          const handles = getMediaStudioHandles()
          const ps = handles.projectStore!
          await ps.ready()
          const requestedId = typeof body.projectId === 'string' && body.projectId.trim()
            ? body.projectId.trim()
            : ps.snapshot().activeId
          if (!requestedId) {
            json(res, 400, { ok: false, error: 'no active project to reveal' })
            return
          }
          const meta = ps.snapshot().projects.find((p) => p.id === requestedId)
          if (!meta) {
            json(res, 404, { ok: false, error: `project not found: ${requestedId}` })
            return
          }
          // Path resolution mirrors `ProjectStore.resolveAssetRoot`'s
          // precedence: a real `sourcePath` wins; otherwise fall back to
          // the managed `<wsRoot>/projects/<id>` directory (legacy
          // pre-upgrade layout); only as a last resort open wsRoot.
          let target: string
          if (meta.sourcePath) {
            target = meta.sourcePath
          } else {
            const fallback = resolve(handles.workspaceRoot, 'projects', meta.id)
            target = fallback
          }
          await revealInFileManager(target)
          json(res, 200, { ok: true, projectId: meta.id, path: target })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Create project (name optional → auto default) + activate.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/create',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const ps = getMediaStudioHandles().projectStore!
          const sourcePath = typeof body.sourcePath === 'string' && body.sourcePath.trim()
            ? body.sourcePath.trim()
            : undefined
          const meta = await ps.createProject(typeof body.name === 'string' ? body.name : undefined, sourcePath)
          json(res, 201, { ok: true, project: meta, registry: ps.snapshot() })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Open (activate + bump recent).
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/open',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const id = String(body.projectId ?? '').trim()
          if (!id) { json(res, 400, { ok: false, error: 'projectId is required' }); return }
          const ps = getMediaStudioHandles().projectStore!
          const meta = await ps.openProject(id)
          json(res, 200, { ok: true, project: meta, registry: ps.snapshot() })
        } catch (e) {
          json(res, 404, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Rename (id immutable; name only).
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/rename',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          // Accept both `projectId` (canonical) and `id` (alias) so callers
          // that use the field name from create-project responses keep working.
          const id = String(body.projectId ?? body.id ?? '').trim()
          const name = typeof body.name === 'string' ? body.name : ''
          if (!id) { json(res, 400, { ok: false, error: 'projectId is required' }); return }
          const ps = getMediaStudioHandles().projectStore!
          const meta = await ps.renameProject(id, name)
          json(res, 200, { ok: true, project: meta, registry: ps.snapshot() })
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Deletion dependency preflight.
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/dependents',
    handler: (req, res) => {
      void (async () => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          const id = url.searchParams.get('projectId') ?? url.searchParams.get('id') ?? ''
          if (!id) { json(res, 400, { ok: false, error: 'projectId is required' }); return }
          const ps = getMediaStudioHandles().projectStore!
          const dependents = await ps.dependentsOf(id)
          json(res, 200, { ok: true, dependents })
        } catch (e) {
          json(res, 500, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  // Delete project (mode: trash|permanent; cascade: cancel|break-refs|migrate-shared).
  wserver.register({
    kind: 'exact',
    path: '/api/media-studio/projects/delete',
    handler: (req, res) => {
      void (async () => {
        try {
          const body = await readBody(req)
          const id = String(body.projectId ?? body.id ?? '').trim()
          if (!id) { json(res, 400, { ok: false, error: 'projectId is required' }); return }
          const ps = getMediaStudioHandles().projectStore!
          const mode = body.mode === 'permanent' ? 'permanent' : 'trash'
          const cascadeRaw = String(body.cascade ?? 'cancel')
          const cascade = cascadeRaw === 'break-refs' || cascadeRaw === 'migrate-shared' ? cascadeRaw : 'cancel'
          const result = await ps.deleteProject(id, mode, cascade)
          json(res, 200, { ok: true, result, registry: ps.snapshot() })
        } catch (e) {
          if (e instanceof ProjectDeleteBlockedError) {
            json(res, 409, { ok: false, code: 'project-referenced', error: e.message, dependents: e.dependents })
            return
          }
          json(res, 400, { ok: false, error: (e as Error).message })
        }
      })()
    },
  })

  return () => {}
}
