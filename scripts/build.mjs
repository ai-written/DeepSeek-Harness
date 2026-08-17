// build.mjs — npm run build wrapper that injects the updater signing key.
//
// `tauri build` signs updater artifacts when createUpdaterArtifacts is on.
// Instead of requiring TAURI_SIGNING_PRIVATE_KEY to be set in the system
// environment (registry write, easy to forget), this script loads the key
// from .tauri/deepseek-harness.key and the optional password from
// .tauri/key-password.txt (both gitignored) and forwards them to the child
// process.
//
// If the private key is NOT password-protected, leave key-password.txt
// absent/empty. If you regenerate the keypair (tauri signer generate), the
// .pub must be copied into tauri.conf.json -> plugins.updater.pubkey.

import { readFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const keyPath = path.join(root, '.tauri', 'deepseek-harness.key')
const pwPath = path.join(root, '.tauri', 'key-password.txt')

if (existsSync(keyPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, 'utf8').trim()
}
if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && existsSync(pwPath)) {
  process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = readFileSync(pwPath, 'utf8').replace(/\r?\n$/, '')
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
