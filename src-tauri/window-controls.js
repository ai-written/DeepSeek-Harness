// window-controls.js — custom titlebar controls injected into the harness
// page. The native decorations are off (decorations: false); this script
// renders minimize / maximize / close buttons pinned to the top-right of the
// page and a drag region, talking to the Tauri window through the global API
// (withGlobalTauri: true + window permissions in capabilities).
//
// Injected with WebviewWindowBuilder::initialization_script so it runs before
// the page scripts on every navigation (placeholder and harness pages).

(function () {
  'use strict'

  // Only act once per document.
  if (window.__deepseekHarnessControls) return
  window.__deepseekHarnessControls = true

  // Tauri's global API is exposed as window.__TAURI__ when withGlobalTauri is
  // enabled. Guard for pages loaded without it.
  const Tauri = window.__TAURI__
  if (!Tauri || !Tauri.window) {
    console.warn('[deepseek-harness] __TAURI__ not available; window controls disabled')
    return
  }
  const appWindow = Tauri.window.getCurrentWindow()

  const BAR_HEIGHT = 38
  const BTN_W = 46

  // Container pinned to the top of the page. It must float above the harness
  // UI, so use a high z-index. Pointer events on the bar drag the window.
  const bar = document.createElement('div')
  bar.id = 'deepseek-harness-titlebar'
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;height:' + BAR_HEIGHT + 'px;' +
    'z-index:2147483647;display:flex;align-items:center;justify-content:flex-end;' +
    '-webkit-user-select:none;user-select:none;' +
    'background:transparent;'

  // Drag region: left part of the bar (buttons stay interactive on the right).
  const drag = document.createElement('div')
  drag.style.cssText =
    'position:absolute;top:0;left:0;right:' + (BTN_W * 3) + 'px;height:' + BAR_HEIGHT + 'px;'
  drag.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return
    appWindow.startDragging().catch(() => {})
    e.preventDefault()
  })
  // Double-click the drag region toggles maximize, like a native titlebar.
  drag.addEventListener('dblclick', () => {
    appWindow.toggleMaximize().catch(() => {})
  })
  bar.appendChild(drag)

  const ICONS = {
    minimize: '<svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1.2"/></svg>',
    maximize: '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    restore: '<svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="3.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 3.5V2.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  }

  function makeButton(icon, label, onClick) {
    const btn = document.createElement('div')
    btn.setAttribute('role', 'button')
    btn.setAttribute('aria-label', label)
    btn.title = label
    btn.className = 'dsh-caption-btn'
    btn.style.cssText =
      'width:' + BTN_W + 'px;height:' + BAR_HEIGHT + 'px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'color:#c9d1d9;cursor:default;'
    btn.innerHTML = icon
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      onClick()
    })
    return btn
  }

  // Decide whether the caption buttons need dark icons (light page) or light
  // icons (dark page) by sampling the page's actual background luminance.
  // The harness page theme is unknown at build time, so never assume it is
  // dark — a light-themed page would otherwise hide the light icons.
  function pageIsLight() {
    if (document.getElementById('startup-panel')) return true
    let el = document.body
    while (el) {
      const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(getComputedStyle(el).backgroundColor)
      if (m) {
        const lum = 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]
        return lum >= 128
      }
      el = el.parentElement
    }
    // Fully transparent background: fall back to dark (harness UI default).
    return false
  }

  // Hover feedback: close turns red, others lighten. Colors follow the page's
  // actual background (checked live on every hover, not cached at mount).
  function attachHover(btn, close) {
    btn.addEventListener('mouseenter', () => {
      if (close) {
        btn.style.background = '#e81123'
        btn.style.color = '#ffffff'
        return
      }
      const light = pageIsLight()
      btn.style.background = light ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.12)'
      btn.style.color = light ? '#1f2328' : '#ffffff'
    })
    btn.addEventListener('mouseleave', () => {
      btn.style.background = 'transparent'
      btn.style.color = pageIsLight() ? '#57606a' : '#c9d1d9'
    })
  }

  const minBtn = makeButton(ICONS.minimize, '最小化', () => appWindow.minimize())
  attachHover(minBtn, false)
  bar.appendChild(minBtn)

  const maxBtn = makeButton(ICONS.maximize, '最大化', () => appWindow.toggleMaximize())
  attachHover(maxBtn, false)
  bar.appendChild(maxBtn)

  const closeBtn = makeButton(ICONS.close, '关闭', () => appWindow.close())
  attachHover(closeBtn, true)
  bar.appendChild(closeBtn)

  // Keep the maximize icon in sync with the actual window state.
  function refreshMaxIcon() {
    appWindow
      .isMaximized()
      .then((max) => {
        maxBtn.innerHTML = max ? ICONS.restore : ICONS.maximize
        maxBtn.title = max ? '还原' : '最大化'
      })
      .catch(() => {})
  }
  refreshMaxIcon()
  if (Tauri.event) {
    Tauri.event.listen('tauri://resize', refreshMaxIcon).catch(() => {})
  }

  // Forward Rust-side startup progress to the placeholder page
  // (#dsh-startup-status and the step indicator in #startup-steps). No-op on
  // the harness page (no such elements). Errors are styled red and the window
  // stays open so the user can read why the launch failed. Events may arrive
  // before the DOM is ready, so remember the latest message and replay it on
  // mount.
  let lastStartup = null
  if (Tauri.event) {
    Tauri.event
      .listen('dsh-startup', (e) => {
        const ev = e.payload || {}
        const msg = typeof ev === 'string' ? { level: 'info', message: ev } : ev
        lastStartup = msg
        applyStartup(msg)
      })
      .catch(() => {})
  }

  // Map of startup stages (sent by main.rs) to step indices. Falls back to
  // keyword matching on the message text for robustness.
  const STAGE_STEP = { locate: 0, wait: 1, ready: 2 }
  function stageOf(msg) {
    if (msg.stage && STAGE_STEP[msg.stage] !== undefined) return msg.stage
    if (msg.level === 'error') return 'error'
    if (/就绪|加载/.test(msg.message)) return 'ready'
    if (/等待|已启动/.test(msg.message)) return 'wait'
    return 'locate'
  }

  function applyStartup(msg) {
    const status = document.getElementById('dsh-startup-status')
    if (!status || !msg || !msg.message) return
    const isError = msg.level === 'error'
    const stage = stageOf(msg)

    status.textContent = msg.message
    status.className = 'status' + (isError ? ' error' : stage === 'ready' ? ' ready' : '')
    // Restart the fade-in animation on every message change.
    status.style.animation = 'none'
    void status.offsetWidth
    status.style.animation = ''

    const panel = document.getElementById('startup-panel')
    if (panel) panel.classList.toggle('has-error', isError)

    const steps = document.getElementById('startup-steps')
    if (!steps) return
    const stepEls = steps.querySelectorAll('.step')
    const lineEls = steps.querySelectorAll('.step-line')
    if (!stepEls.length) return

    // The step currently in flight becomes the error step; completed steps
    // stay green so the user can see how far the launch got.
    const cur = STAGE_STEP[stage] !== undefined ? STAGE_STEP[stage] : Math.max(0, currentActiveStep(steps) - 1)
    stepEls.forEach((el, i) => {
      el.classList.remove('is-active', 'is-done', 'is-error')
      if (i < cur) el.classList.add('is-done')
      else if (i === cur) el.classList.add(isError ? 'is-error' : 'is-active')
    })
    lineEls.forEach((el, i) => {
      el.classList.toggle('is-done', i < cur)
    })
  }

  // How many steps have reached 'active' or beyond (count, 1-based); used to
  // decide which step shows the error marker when stage info is missing.
  function currentActiveStep(steps) {
    let max = 0
    steps.querySelectorAll('.step').forEach((el, i) => {
      if (el.classList.contains('is-active') || el.classList.contains('is-done')) max = i + 1
    })
    return max
  }

  // Append on DOMContentLoaded if the document is still loading, else now.
  function mount() {
    if (!document.getElementById('deepseek-harness-titlebar')) {
      document.body.appendChild(bar)
      // Push harness content down so it isn't hidden under the transparent
      // bar's drag strip; the buttons themselves sit on top of content.
    }
    // Initial caption-button color: match the page's actual background
    // luminance (light page → dark icons, dark page → light icons).
    const light = pageIsLight()
    const fg = light ? '#57606a' : '#c9d1d9'
    bar.querySelectorAll('.dsh-caption-btn').forEach((b) => {
      b.style.color = fg
    })
    if (lastStartup) applyStartup(lastStartup)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
