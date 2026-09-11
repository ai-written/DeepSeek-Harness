// Temporary harness for the usage panel's "dsh 版本" tab (not part of the app).
// Drives the injected usage-panel.js against a minimal DOM: opens the dialog,
// switches to the version tab, renders a payload, and clicks the actions while
// recording the events the panel emits to Rust.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const emitted = []

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.style = { cssText: '', setProperty() {} }
    this.attrs = {}
    this.textContent = ''
    this.value = ''
    this.type = ''
    this.disabled = false
    this._handlers = {}
  }
  set id(v) {
    this.attrs.id = v
  }
  get id() {
    return this.attrs.id || ''
  }
  // A real browser clears children when innerHTML is assigned ''; the panel relies
  // on that to rebuild its modal content, so the fake DOM must honour it.
  set innerHTML(v) {
    this.children.forEach((c) => (c.parentNode = null))
    this.children = []
    this._innerHTML = String(v)
  }
  get innerHTML() {
    return this._innerHTML || ''
  }
  setAttribute(k, v) {
    this.attrs[k] = v
  }
  getAttribute(k) {
    return this.attrs[k]
  }
  appendChild(c) {
    this.children.push(c)
    c.parentNode = this
    return c
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c)
    if (c) c.parentNode = null
    return c
  }
  addEventListener(name, fn) {
    ;(this._handlers[name] = this._handlers[name] || []).push(fn)
  }
  removeEventListener() {}
  dispatch(name, ev = {}) {
    for (const fn of this._handlers[name] || []) fn({ target: this, ...ev })
  }
  getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0 }
  }
  focus() {}
  click() {
    this.dispatch('click', {})
    if (this.onclick) this.onclick()
  }
  get text() {
    return (this.textContent || '') + this.children.map((c) => c.text).join(' ')
  }
  findAll(pred, out = []) {
    if (pred(this)) out.push(this)
    for (const c of this.children) c.findAll(pred, out)
    return out
  }
}

const body = new El('body')
const doc = {
  readyState: 'complete',
  body,
  createElement: (t) => new El(t),
  getElementById: (id) => body.findAll((e) => e.attrs.id === id)[0] || null,
  addEventListener() {},
  documentElement: new El('html'),
}
const listeners = new Map()
const store = new Map()
globalThis.window = {
  __TAURI__: {
    event: {
      listen: (n, cb) => (listeners.set(n, cb), Promise.resolve(() => {})),
      emit: (n, p) => (emitted.push({ n, p }), Promise.resolve()),
    },
  },
  addEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1200,
  location: { href: 'http://127.0.0.1:1234/' },
  sessionStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
}
globalThis.document = doc
globalThis.Chart = function Chart() {
  return { destroy() {}, update() {}, resize() {} }
}
globalThis.Chart.register = () => {}
globalThis.Chart.defaults = { font: {}, color: '' }
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' })
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}

const chartJs = fs.readFileSync(path.resolve('src-tauri/chart.umd.min.js'), 'utf8')
const globalEval = eval
globalEval(chartJs)
await import(pathToFileURL(path.resolve('src-tauri/usage-panel.js')).href)

let bad = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) bad++
}

const fire = (name, payload) => {
  const cb = listeners.get(name)
  if (!cb) throw new Error('no listener for ' + name)
  cb({ payload })
}
const modal = () => doc.getElementById('deepseek-harness-usage-modal')
const tab = (label) =>
  modal()
    ?.findAll((e) => e.tagName === 'BUTTON')
    .find((b) => (b.textContent || '') === label)
const btnStartingWith = (prefix) =>
  modal()
    ?.findAll((e) => e.tagName === 'BUTTON')
    .find((b) => (b.textContent || '').startsWith(prefix))

check('listeners registered', listeners.has('dsh-versions-data') && listeners.has('dsh-versions-install-result'))

// The badge mounts on a dsh-usage payload; then clicking it opens the dialog.
fire('dsh-usage', { today: { cny: 1.23, total: {} }, recent: [], exchangeRate: 7.2 })
const badge = doc.getElementById('deepseek-harness-usage')
check('badge mounted', !!badge)
badge.click()
check('dialog opened', modal() && modal().style.display === 'flex')

// Switch to the version tab: it must ask Rust for the list.
emitted.length = 0
check('version tab exists', !!tab('dsh 版本'))
tab('dsh 版本').click()
check('list requested on open', emitted.some((e) => e.n === 'dsh-versions-list'), JSON.stringify(emitted.map((e) => e.n)))
check('loading text shown', (modal().text || '').includes('正在读取'))

// Rust answers with a payload: current + installed + registry versions.
fire('dsh-versions-data', {
  ok: true,
  source: 'global',
  sourceLabel: '全局安装',
  activeVersion: '0.1.5-rc.1',
  activePath: 'D:\\nodejs\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  installed: [],
  versions: [
    { version: '0.1.5-rc.2', tags: ['next'], installed: false, active: false, broken: false },
    { version: '0.1.5-rc.1', tags: ['latest'], installed: false, active: false, broken: false },
    { version: '0.1.5-alpha.2', tags: ['alpha'], installed: false, active: false, broken: false },
  ],
  registryBase: 'https://registry.npmjs.org',
  registryError: null,
  versionsRoot: 'C:\\Users\\u\\.dsh\\versions',
  limit: 15,
})
const text = modal().text || ''
check('shows the running version', text.includes('当前 dsh：0.1.5-rc.1'))
check('shows the source chip', text.includes('全局安装'))
check('shows the registry versions', text.includes('0.1.5-rc.2') && text.includes('0.1.5-alpha.2'))
check('dist-tags rendered', text.includes('latest') && text.includes('next') && text.includes('alpha'))

// Install button -> dsh-versions-install with the version.
emitted.length = 0
const installBtn = btnStartingWith('安装')
check('install button present', !!installBtn)
installBtn.click()
const installReq = emitted.find((e) => e.n === 'dsh-versions-install')
check('install requested with the version', !!installReq && installReq.p.version === '0.1.5-rc.2', JSON.stringify(installReq))
check('busy state shown', (modal().text || '').includes('正在安装 0.1.5-rc.2'))

// Progress lines from npm update the status area.
fire('dsh-versions-install-progress', { version: '0.1.5-rc.2', line: 'added 3 packages in 12s' })
check('npm progress shown', (modal().text || '').includes('added 3 packages'))

// Result -> refresh + a success message; the payload now lists it as installed.
emitted.length = 0
fire('dsh-versions-install-result', { ok: true, state: 'done', version: '0.1.5-rc.2', message: '安装完成，重启应用后生效' })
check('install result refreshed the list', emitted.some((e) => e.n === 'dsh-versions-list'))
fire('dsh-versions-data', {
  ok: true,
  source: 'local',
  sourceLabel: '版本目录',
  activeVersion: '0.1.5-rc.2',
  activePath: 'C:\\Users\\u\\.dsh\\versions\\0.1.5-rc.2\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  installed: [{ version: '0.1.5-rc.2', complete: true, active: true }],
  versions: [
    { version: '0.1.5-rc.2', tags: ['next'], installed: true, active: true, broken: false },
    { version: '0.1.5-rc.1', tags: ['latest'], installed: true, active: false, broken: false },
  ],
  registryBase: 'https://registry.npmjs.org',
  registryError: null,
  versionsRoot: 'C:\\Users\\u\\.dsh\\versions',
  limit: 15,
})
const after = modal().text || ''
check('install success message kept', after.includes('安装完成'), after.slice(0, 120))
check('loading text cleared after data', !after.includes('正在读取'), after.slice(0, 160))
check('now shows the version dir as source', after.includes('版本目录'))
check('installed versions listed', after.includes('版本目录中已安装'))

// Switch -> dsh-versions-switch; back to global -> global:true
emitted.length = 0
btnStartingWith('切换')?.click()
check('switch requested', emitted.some((e) => e.n === 'dsh-versions-switch'), JSON.stringify(emitted.map((e) => e.n)))
emitted.length = 0
btnStartingWith('回到全局安装')?.click()
const globalReq = emitted.find((e) => e.n === 'dsh-versions-switch')
check('global switch requested', !!globalReq && globalReq.p.global === true, JSON.stringify(globalReq))

// Restart + refresh
emitted.length = 0
btnStartingWith('重启应用')?.click()
check('restart requested', emitted.some((e) => e.n === 'dsh-app-restart'))
emitted.length = 0
btnStartingWith('刷新列表')?.click()
check('refresh requested', emitted.some((e) => e.n === 'dsh-versions-list'))

// Delete needs confirmation (two clicks) and never for the active version.
fire('dsh-versions-data', {
  ok: true,
  source: 'local',
  sourceLabel: '版本目录',
  activeVersion: '0.1.5-rc.2',
  activePath: 'x',
  installed: [
    { version: '0.1.5-rc.2', complete: true, active: true },
    { version: '0.1.5-rc.1', complete: true, active: false },
  ],
  versions: [
    { version: '0.1.5-rc.2', tags: [], installed: true, active: true, broken: false },
    { version: '0.1.5-rc.1', tags: [], installed: true, active: false, broken: false },
  ],
  registryError: null,
  versionsRoot: 'r',
  limit: 15,
})
emitted.length = 0
btnStartingWith('删除')?.click()
check('first delete click only asks for confirmation', emitted.length === 0, JSON.stringify(emitted))
check('confirmation shown', (modal().text || '').includes('确认删除'))
btnStartingWith('确认删除')?.click()
const delReq = emitted.find((e) => e.n === 'dsh-versions-remove')
check('confirmed delete requested', !!delReq && delReq.p.version === '0.1.5-rc.1', JSON.stringify(delReq))

// Registry failure: still usable, error surfaced above the list.
fire('dsh-versions-data', {
  ok: true,
  source: 'global',
  sourceLabel: '全局安装',
  activeVersion: '0.1.5-rc.1',
  activePath: 'x',
  installed: [],
  versions: [],
  registryError: 'HTTP 403',
  registryBase: 'https://registry.npmjs.org',
  versionsRoot: 'r',
  limit: 15,
})
check('registry error surfaced', (modal().text || '').includes('读取 npm 失败') && (modal().text || '').includes('HTTP 403'))
check('still shows the running version', (modal().text || '').includes('当前 dsh：0.1.5-rc.1'))

console.log(bad === 0 ? '\nVERSIONS TAB OK' : `\n${bad} CHECK(S) FAILED`)
process.exit(bad === 0 ? 0 : 1)
