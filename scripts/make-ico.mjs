// make-ico.mjs — generate Tauri app icons from the official DSH favicon.
//
// Pipeline: assets/favicon.svg (official DSH logo) → 512px black PNG (in
// memory) → multi-size icon.ico (16..256). Self-contained: sharp comes from
// this app's node_modules.
//
// Usage: node scripts/make-ico.mjs [path/to/favicon.svg]

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(here, '..')

const svgArg = process.argv[2]
const svgPath = svgArg ? resolve(svgArg) : resolve(appRoot, 'assets', 'favicon.svg')
const outDir = process.argv[3] ?? resolve(appRoot, 'src-tauri', 'icons')

const { default: sharp } = await import(
  pathToFileURL(resolve(appRoot, 'node_modules', 'sharp', 'dist', 'index.mjs')).href
)

// Rebuild a minimal black SVG from the source path data (the source carries
// its own fill="#000" plus style markup; drop it all, keep one black fill).
const raw = readFileSync(svgPath, 'utf8')
const ds = [...raw.matchAll(/<path[^>]*\sd="([^"]*)"[^>]*\/?>/g)].map((m) => m[1])
if (ds.length === 0) throw new Error(`no <path d="..."> found in ${svgPath}`)
const blackSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 50 50">' +
  ds.map((d) => `<path fill="#000000" d="${d}"/>`).join('') +
  '</svg>'

const master = await sharp(Buffer.from(blackSvg)).resize(512, 512).png().toBuffer()

const sizes = [16, 24, 32, 48, 64, 128, 256]
const pngs = []
for (const s of sizes) {
  pngs.push(await sharp(master).resize(s, s).png().toBuffer())
}

// ICO format: 6-byte header, 16-byte per entry, then PNG data blobs.
const count = pngs.length
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(count, 4)
const entries = []
let offset = 6 + 16 * count
for (let i = 0; i < count; i++) {
  const b = pngs[i]
  const sizeByte = sizes[i] >= 256 ? 0 : sizes[i]
  const e = Buffer.alloc(16)
  e.writeUInt8(sizeByte, 0)
  e.writeUInt8(sizeByte, 1)
  e.writeUInt8(0, 2) // colors
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // planes
  e.writeUInt16LE(32, 6) // bpp
  e.writeUInt32LE(b.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += b.length
}
writeFileSync(resolve(outDir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]))
console.log(`icon.ico written with ${count} sizes (${sizes.join(',')})`)
