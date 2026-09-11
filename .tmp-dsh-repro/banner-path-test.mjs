// Temporary: confirms the banner shows the FULL save path on completion (the
// message changed so a user who cannot find the file can read where it went).
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const emitted = []
class El {
  constructor(t) {
    this.tagName = String(t || 'div').toUpperCase()
    this.children = []
    this.style = { cssText: '' }
    this.attrs = {}
    this.textContent = ''
    this.disabled = false
  }
  appendChild(c) {
    this.children.push(c)
    c.parentNode = this
    return c
  }
  set id(v) {
    this.attrs.id = v
  }
  get id() {
    return this.attrs.id || ''
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c)
    return c
  }
  addEventListener() {}
  get text() {
    return (this.textContent || '') + this.children.map((c) => c.text).join('|')
  }
  find(p) {
    if (p(this)) return this
    for (const c of this.children) {
      const h = c.find(p)
      if (h) return h
    }
    return null
  }
  findAll(p, o = []) {
    if (p(this)) o.push(this)
    for (const c of this.children) c.findAll(p, o)
    return o
  }
}
const doc = {
  readyState: 'complete',
  body: new El('body'),
  createElement: (t) => new El(t),
  getElementById: (id) => doc.body.find((e) => e.attrs.id === id),
  addEventListener() {},
}
const listeners = new Map()
globalThis.window = {
  __TAURI__: {
    event: {
      listen: (n, cb) => (listeners.set(n, cb), Promise.resolve(() => {})),
      emit: (n, p) => (emitted.push({ n, p }), Promise.resolve()),
    },
  },
  open() {},
}
globalThis.document = doc
await import(pathToFileURL(path.resolve('src-tauri/update-banner.js')).href)
const fire = (n, p) => listeners.get(n)({ payload: p })
const banner = () => doc.getElementById('deepseek-harness-update-banner')
const btn = (l) => banner().findAll((e) => e.tagName === 'BUTTON').find((b) => (b.textContent || '').includes(l))

let bad = 0
const check = (l, c, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? ` — ${x}` : ''}`)
  if (!c) bad++
}

fire('dsh-update-available', {
  version: 'v0.1.20',
  current: '0.1.19',
  releaseUrl: 'https://github.com/ai-written/DeepSeek-Harness/releases/tag/v0.1.20',
  assets: [{ name: 'DeepSeek-Harness_0.1.20_x64-portable.exe', url: 'https://x.test/a.exe', size: 100, kind: 'portable', digest: '' }],
})
btn('下载更新').onclick()
fire('dsh-update-progress', {
  state: 'done',
  message: '已下载（8.1 MB）到：C:\\Users\\15476\\Downloads\\DeepSeek-Harness_0.1.20_x64-portable.exe',
  file: 'C:\\Users\\15476\\Downloads\\DeepSeek-Harness_0.1.20_x64-portable.exe',
})
const text = banner().text || ''
check('full path shown in the banner', text.includes('C:\\Users\\15476\\Downloads\\DeepSeek-Harness_0.1.20_x64-portable.exe'), text.slice(0, 160))
check('re-download button still offered', !!btn('重新下载'))
console.log(bad === 0 ? '\nBANNER PATH OK' : `\n${bad} FAILED`)
process.exit(bad === 0 ? 0 : 1)
