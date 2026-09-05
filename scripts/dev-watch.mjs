#!/usr/bin/env node
/**
 * Development watch mode for dsh-media-studio.
 *
 * Watches src/** for changes, auto-rebuilds, and restarts the DSH web
 * process so plugin code changes take effect without manual restart.
 *
 * Usage: node scripts/dev-watch.mjs
 *   - DSH_PORT=3080  (default)
 *   - DSH_CMD="dsh web"  (default)
 */

import { watch } from 'node:fs'
import { spawn, exec } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const SRC_DIR = resolve(ROOT, 'src')
const DSH_PORT = process.env.DSH_PORT || '3080'
const DSH_CMD = process.env.DSH_CMD || 'dsh web'

let dshProcess = null
let rebuildTimer = null
let isBuilding = false
let pendingRebuild = false

function log(msg) {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${time}] ${msg}`)
}

function killDsh() {
  return new Promise((resolve) => {
    if (!dshProcess) { resolve(); return }
    log('Stopping DSH...')
    dshProcess.kill('SIGTERM')
    // Also kill any lingering "dsh web" processes
    exec(`pkill -f "dsh web" 2>/dev/null`, () => {
      setTimeout(resolve, 800)
    })
  })
}

function startDsh() {
  log('Starting DSH...')
  const [cmd, ...args] = DSH_CMD.split(' ')
  dshProcess = spawn(cmd, args, {
    cwd: ROOT,
    env: { ...process.env, PORT: DSH_PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  dshProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split('\n').filter(l => l.trim())
    lines.forEach(l => log(`DSH: ${l.slice(0, 120)}`))
  })
  dshProcess.stderr.on('data', (data) => {
    const lines = data.toString().trim().split('\n').filter(l => l.trim())
    lines.forEach(l => console.error(`[DSH ERR] ${l.slice(0, 120)}`))
  })
  dshProcess.on('exit', (code) => {
    log(`DSH exited (code ${code})`)
    dshProcess = null
  })
}

async function build() {
  if (isBuilding) { pendingRebuild = true; return }
  isBuilding = true
  log('Building...')
  try {
    await new Promise((resolve, reject) => {
      const proc = spawn('pnpm', ['run', 'build'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      proc.stderr.on('data', (d) => { stderr += d.toString() })
      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(stderr || `Build failed with code ${code}`))
      })
    })
    log('Build complete ✓')
    return true
  } catch (e) {
    log(`Build failed: ${e.message}`)
    return false
  } finally {
    isBuilding = false
    if (pendingRebuild) {
      pendingRebuild = false
      setTimeout(() => build(), 100)
    }
  }
}

async function rebuildAndRestart() {
  const ok = await build()
  if (!ok) return
  await killDsh()
  startDsh()
  log('Hot reload complete ✓')
}

function scheduleRebuild(filename) {
  if (rebuildTimer) clearTimeout(rebuildTimer)
  log(`Change detected: ${filename}`)
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null
    rebuildAndRestart()
  }, 300) // debounce
}

// ── Main ──────────────────────────────────────────────────────────────────

log('dsh-media-studio dev watch mode')
log(`Watching: ${SRC_DIR}`)
log(`DSH command: ${DSH_CMD} (port ${DSH_PORT})`)
log('Press Ctrl+C to stop\n')

// Initial build + start
await build()
startDsh()

// Watch src directory recursively
const watcher = watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
  if (!filename) return
  if (!/\.(ts|tsx|mjs|css)$/.test(filename)) return
  // Ignore temp files
  if (filename.endsWith('.swp') || filename.endsWith('~') || filename.startsWith('.')) return
  scheduleRebuild(filename)
})

watcher.on('error', (err) => {
  console.error('Watcher error:', err)
})

process.on('SIGINT', async () => {
  log('\nShutting down...')
  await killDsh()
  watcher.close()
  process.exit(0)
})
