// build.mjs — `npm run build` wrapper.
//
// Two jobs: sync the version (package.json is the single source of truth) and
// then run `tauri build`. Nothing else — this shell ships no updater, so there
// is no signing key to inject and no updater artifacts to produce.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { syncVersion } from './sync-version.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Ensure Cargo.toml / tauri.conf.json follow package.json before build.
try {
  syncVersion()
} catch (e) {
  console.warn(`[sync-version] failed: ${e.message}`)
}

const child = spawn('tauri', ['build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  cwd: root,
  env: process.env,
})
child.on('error', (err) => {
  console.error(`[build.mjs] failed to spawn tauri: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0))
})
