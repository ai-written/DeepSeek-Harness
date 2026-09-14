// Temporary harness: the failure mode where dsh never starts. Verifies the
// startup page still offers version switching / retry / log, and that the
// version dialog really opens from there (no usage data available).
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const emitted = []

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.style = { cssText: '', setProperty() {}, display: '' }
    this.attrs = {}
    this.classList = {
      _s: new Set(),
      add: (c) => this.classList._s.add(c),
      remove: (c) => this.classList._s.delete(c),
      contains: (c) => this.classList._s.has(c),
      toggle: (c, on) => (on ? this.classList._s.add(c) : this.classList._s.delete(c)),
    }
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
  set className(v) {
    this.attrs.class = v
  }
  get className() {
    return this.attrs.class || ''
  }
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
  insertBefore(c, ref) {
    const i = this.children.indexOf(ref)
    this.children.splice(i < 0 ? this.children.length : i, 0, c)
    c.parentNode = this
    return c
  }
  removeChild(c) {
    this.children = this.children.filter((x) => x !== c)
    return c
  }
  addEventListener(n, f) {
    ;(this._handlers[n] = this._handlers[n] || []).push(f)
  }
  removeEventListener() {}
  dispatch(n, ev = {}) {
    for (const f of this._handlers[n] || []) f({ target: this, ...ev })
    if (this['on' + n]) this['on' + n]({ target: this, ...ev })
  }
  getBoundingClientRect() {
    return { width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20 }
  }
  querySelector() {
    return null
  }
  querySelectorAll() {
    return []
  }
  focus() {}
  click() {
    this.dispatch('click', {})
  }
  get text() {
    return (this.textContent || '') + this.children.map((c) => c.text).join(' ')
  }
  findAll(p, o = []) {
    if (p(this)) o.push(this)
    for (const c of this.children) c.findAll(p, o)
    return o
  }
}

// Placeholder page skeleton (the parts the scripts touch).
const body = new El('body')
const panel = new El('div')
panel.id = 'startup-panel'
const status = new El('div')
status.id = 'dsh-startup-status'
status.className = 'status'
status.textContent = '正在定位 dsh…'
const steps = new El('div')
steps.id = 'startup-steps'
panel.appendChild(steps)
panel.appendChild(status)
body.appendChild(panel)

const doc = {
  readyState: 'complete',
  body,
  head: new El('head'),
  createElement: (t) => new El(t),
  getElementById: (id) => body.findAll((e) => e.attrs.id === id)[0] || null,
  addEventListener() {},
  documentElement: new El('html'),
  querySelector: () => null,
  querySelectorAll: () => [],
}
const listeners = new Map()
globalThis.window = {
  __TAURI__: {
    event: {
      listen: (n, cb) => (listeners.set(n, cb), Promise.resolve(() => {})),
      emit: (n, p) => (emitted.push({ n, p }), Promise.resolve()),
    },
    // window-controls.js needs the window API to get past its guard and to wire
    // the custom caption buttons (it calls these on the current window).
    window: {
      getCurrentWindow: () => ({
        close: () => Promise.resolve(),
        minimize: () => Promise.resolve(),
        toggleMaximize: () => Promise.resolve(),
        startDragging: () => Promise.resolve(),
        isMaximized: () => Promise.resolve(false),
        setFullscreen: () => Promise.resolve(),
        setDecorations: () => Promise.resolve(),
        onResized: () => Promise.resolve(() => {}),
      }),
    },
  },
  addEventListener() {},
  devicePixelRatio: 1,
  innerWidth: 1200,
  getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', getPropertyValue: () => '' }),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  location: { href: 'tauri://localhost/index.html' },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
}
globalThis.document = doc
globalThis.Chart = function () {
  return { destroy() {}, update() {}, resize() {} }
}
globalThis.Chart.register = () => {}
globalThis.Chart.defaults = { font: {}, color: '' }
globalThis.getComputedStyle = window.getComputedStyle
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
}
const globalEval = eval
globalEval(fs.readFileSync(path.resolve('src-tauri/chart.umd.min.js'), 'utf8'))
await import(pathToFileURL(path.resolve('src-tauri/usage-panel.js')).href)
await import(pathToFileURL(path.resolve('src-tauri/window-controls.js')).href)

let bad = 0
const check = (l, c, x = '') => {
  console.log(`${c ? 'PASS' : 'FAIL'}  ${l}${x ? ` — ${x}` : ''}`)
  if (!c) bad++
}
const fire = (n, payload) => {
  const cb = listeners.get(n)
  if (!cb) throw new Error('no listener for ' + n)
  cb({ payload })
}
const recovery = () => doc.getElementById('dsh-recovery')
const btnIn = (root, label) => (root ? root.findAll((e) => e.tagName === 'BUTTON').find((b) => (b.textContent || '') === label) : null)

check('panel exposed the recovery entry point', typeof window.__deepseekHarnessOpenVersions === 'function')
check('no usage badge on the startup page', !doc.getElementById('deepseek-harness-usage'))

// dsh fails to start: the page must offer a way out.
fire('dsh-startup', { level: 'error', stage: 'error', message: '未找到 dsh：dsh.cmd not found on PATH\n\n详细日志：C:\\x\\startup.log' })
check('recovery controls appear on failure', !!recovery(), recovery() ? recovery().text : '')
check('offers 切换 dsh 版本', !!btnIn(recovery(), '切换 dsh 版本'))
check('offers 重试启动', !!btnIn(recovery(), '重试启动'))
check('offers 打开日志', !!btnIn(recovery(), '打开日志'))
check('error text still shown', (status.textContent || '').includes('详细日志'))

// 切换 dsh 版本 opens the dialog straight on the version tab, with no usage data.
emitted.length = 0
btnIn(recovery(), '切换 dsh 版本').click()
const modal = doc.getElementById('deepseek-harness-usage-modal')
check('version dialog opened from the error page', !!modal && modal.style.display === 'flex')
check('version list requested on open', emitted.some((e) => e.n === 'dsh-versions-list'), JSON.stringify(emitted.map((e) => e.n)))
const chartTab = () => btnIn(modal, '周用量')
const versionsTab = () => btnIn(modal, 'dsh 版本')
check('版本 tab is active', !!versionsTab() && versionsTab()._active === true)

// Version payload arrives: switching must be possible without dsh running.
fire('dsh-versions-data', {
  ok: true,
  source: 'local',
  sourceLabel: '版本目录',
  activeVersion: '0.1.5-rc.9',
  activePath: 'C:\\u\\.dsh\\versions\\0.1.5-rc.9\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
  installed: [
    { version: '0.1.5-rc.9', complete: true, active: true },
    { version: '0.1.5-rc.1', complete: true, active: false },
  ],
  versions: [
    { version: '0.1.5-rc.9', tags: [], installed: true, active: true, broken: false },
    { version: '0.1.5-rc.1', tags: ['latest'], installed: true, active: false, broken: false },
  ],
  registryError: null,
  versionsRoot: 'C:\\u\\.dsh\\versions',
  limit: 15,
})
check('active (broken) version shown', (modal.text || '').includes('0.1.5-rc.9'))
emitted.length = 0
const switchBtn = modal.findAll((e) => e.tagName === 'BUTTON').find((b) => b.textContent === '切换')
check('a working version offers 切换', !!switchBtn)
switchBtn.click()
const sw = emitted.find((e) => e.n === 'dsh-versions-switch')
check('switch requested for the other version', !!sw && sw.p.version === '0.1.5-rc.1', JSON.stringify(sw))
emitted.length = 0
const restartBtn = modal.findAll((e) => e.tagName === 'BUTTON').find((b) => b.textContent === '重启应用')
check('重启应用 offered', !!restartBtn)
restartBtn.click()
check('restart requested', emitted.some((e) => e.n === 'dsh-app-restart'))

// The chart tab must not crash without usage data.
chartTab().click()
check('chart tab explains missing data', (modal.text || '').includes('没有用量数据'), (modal.text || '').slice(-80))

// Back on the version tab: 重试启动 and 打开日志 wire to the backend.
emitted.length = 0
btnIn(recovery(), '重试启动').click()
check('retry start requested', emitted.some((e) => e.n === 'dsh-retry-start'), JSON.stringify(emitted.map((e) => e.n)))
emitted.length = 0
btnIn(recovery(), '打开日志').click()
check('open log requested', emitted.some((e) => e.n === 'dsh-open-startup-log'))

// A successful start hides the recovery controls again.
fire('dsh-startup', { level: 'info', stage: 'ready', message: '服务已就绪，正在加载界面…' })
check('recovery controls hidden after ready', !recovery() || recovery().style.display === 'none')

console.log(bad === 0 ? '\nRECOVERY PATH OK' : `\n${bad} CHECK(S) FAILED`)
process.exit(bad === 0 ? 0 : 1)
