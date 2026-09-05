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
