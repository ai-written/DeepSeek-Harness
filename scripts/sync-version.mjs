// sync-version.mjs — single source of truth for version: package.json
// Reads package.json version and writes it to Cargo.toml and tauri.conf.json.
// Lock files (package-lock.json / Cargo.lock) are updated automatically by
// `npm install` / `cargo check` and do not need manual edits.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = path.join(root, 'package.json')
const cargoPath = path.join(root, 'src-tauri', 'Cargo.toml')
const tauriPath = path.join(root, 'src-tauri', 'tauri.conf.json')

export function syncVersion() {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const version = pkg.version
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`invalid version in package.json: ${version}`)
  }

  // Cargo.toml: replace `version = "x.y.z"` under [package]
  let cargo = readFileSync(cargoPath, 'utf8')
  const beforeCargo = cargo
  cargo = cargo.replace(/^version\s*=\s*".*?"\s*$/m, `version = "${version}"`)
  if (cargo !== beforeCargo) {
    writeFileSync(cargoPath, cargo)
    console.log(`[sync-version] Cargo.toml -> ${version}`)
  }

  // tauri.conf.json: JSON property "version"
  const tauri = JSON.parse(readFileSync(tauriPath, 'utf8'))
  if (tauri.version !== version) {
    tauri.version = version
    writeFileSync(tauriPath, JSON.stringify(tauri, null, 2) + '\n')
    console.log(`[sync-version] tauri.conf.json -> ${version}`)
  }

  console.log(`[sync-version] done (source: package.json ${version})`)
  return version
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('sync-version.mjs')) {
  syncVersion()
}
