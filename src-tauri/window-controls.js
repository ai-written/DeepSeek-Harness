// window-controls.js — custom titlebar controls injected into the harness
// page. The window is built without native decorations, so this script renders
// minimize / maximize / close buttons pinned to the top-right of the page plus
// a drag region, talking to the Tauri window through the global API
// (withGlobalTauri: true + window permissions in capabilities).
//
// It also owns the shell's only other page-side job: forwarding the Rust-side
// `dsh-startup` progress to the placeholder page, and offering 重试启动 /
// 打开日志 when the launch failed.
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

  const BAR_HEIGHT = 26
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

  // Nudge the harness UI's own top-right header utilities (the "Session log"
  // button container, generated class like wSkVaW_headerUtilities), the
  // header corner (the right-sidebar expand control, whose host container
  // carries the stable [data-conversation-header-corner]) AND the sidebar's
  // top tab strip (generated class like _tabStrip_1wfn9_92) down so all
  // clear the caption buttons pinned above them. The utilities and the tab
  // strip are matched by class-name substring because the leading hash of
  // the generated class can change between harness builds; the corner is
  // matched by its stable data attribute. !important wins over the
  // late-loading page CSS (this script runs before the page's own
  // stylesheets).
  //
  // The tab strip is nudged with a top MARGIN rather than the relative shift
  // used for the header utilities: it is the first child of a fixed-height
  // flex column whose next sibling (_paneBody) is position:relative and
  // painted after it, so a visual-only shift (position:relative; top) would
  // make the strip's bottom overlap the pane body and leave the lower part
  // of the strip's buttons covered and unclickable. A margin moves the strip
  // AND the pane body after it down in flow, so nothing overlaps.
  const nudgeStyle = document.createElement('style')
  nudgeStyle.id = 'deepseek-harness-header-nudge'
  nudgeStyle.textContent =
    '[class*="headerUtilities"],[data-conversation-header-corner]{position:relative !important;top:18px !important;}' +
    '[class*="tabStrip"]{margin-top:18px !important;}'

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

  function emit(name, payload) {
    try {
      if (Tauri.event && Tauri.event.emit) Tauri.event.emit(name, payload).catch(() => {})
    } catch {
      /* noop */
    }
  }

  // ── client-plugin bundle load failure ───────────────────────────────────────
  // A stale/corrupt WebView2 store makes this page fail to load the harness's
  // client-plugin bundles ("Failed to load plugins" / `client-modules: bundle
  // script … failed to load`), and it then stays broken on every reload and
  // every launch. The store cannot be cleared in place either (the bad state
  // also lives in the running WebView2 process, and its files are in use), so
  // the shell does NOT try to fix it automatically: this detector reports the
  // failure to the Rust side (one line in the startup log) and shows the user
  // which directory to delete after quitting.
  //
  // Detection keys on the failure MECHANISM, not on error text: a <script>
  // whose /plugins bundle failed to load (resource load errors do not bubble,
  // hence the capture phase), plus dsh's own `client-modules:` prefix on an
  // unhandled rejection as a second signal.
  let pluginFailureReported = false
  function reportPluginFailure(source, detail) {
    if (pluginFailureReported) return
    pluginFailureReported = true
    console.warn('[deepseek-harness] client plugin bundle failed to load:', source, detail)
    emit('dsh-webview-broken', { source, detail: String(detail).slice(0, 2000) })
    showPluginFailureNotice()
  }
  window.addEventListener(
    'error',
    (e) => {
      const target = e.target
      if (
        target &&
        target.tagName === 'SCRIPT' &&
        typeof target.src === 'string' &&
        target.src.indexOf('/plugins/') !== -1
      ) {
        reportPluginFailure('script', target.src)
      }
    },
    true
  )
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason
    const message = (reason && (reason.message || String(reason))) || ''
    if (message.indexOf('client-modules:') !== -1 || message.indexOf('Failed to load plugins') !== -1) {
      reportPluginFailure('rejection', message)
    }
  })

  // Non-blocking notice pinned to the bottom of the page: the harness UI stays
  // usable, so the user can read what to do and keep working until they quit.
  function showPluginFailureNotice() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', showPluginFailureNotice, { once: true })
      return
    }
    const id = 'deepseek-harness-plugin-failure'
    if (document.getElementById(id)) return

    const dir = window.__deepseekHarnessWebviewDir || '（路径见启动日志 startup.log 里的 webview data dir 行）'
    const box = document.createElement('div')
    box.id = id
    box.style.cssText =
      'position:fixed;left:50%;transform:translateX(-50%);bottom:16px;z-index:2147483647;' +
      'max-width:min(720px,92vw);box-sizing:border-box;padding:12px 14px;border-radius:12px;' +
      'background:#fff8f0;border:1px solid #e0b072;box-shadow:0 10px 30px rgba(0,0,0,0.18);' +
      'color:#5c3b12;text-align:left;user-select:text;' +
      'font:12.5px/1.7 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;'

    const heading = document.createElement('div')
    heading.textContent = '客户端插件加载失败'
    heading.style.cssText = 'margin-bottom:4px;font-size:13.5px;font-weight:700;'
    box.appendChild(heading)

    const body = document.createElement('div')
    body.textContent =
      '界面可能缺少部分功能（例如用量徽标），刷新无效。这通常是 WebView2 缓存目录损坏导致的：' +
      '退出应用后删掉下面这个目录，再重新打开即可。'
    box.appendChild(body)

    const pathEl = document.createElement('code')
    pathEl.textContent = dir
    pathEl.style.cssText =
      'display:block;margin:7px 0 9px;padding:5px 8px;border-radius:6px;user-select:all;' +
      'background:rgba(92,59,18,0.08);word-break:break-all;' +
      'font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:11.5px;'
    box.appendChild(pathEl)

    const actions = document.createElement('div')
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;'
    const mkBtn = (text, primary, onclick) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.style.cssText =
        'padding:5px 12px;border-radius:8px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;' +
        (primary
          ? 'border:none;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;'
          : 'border:1px solid #d0a06a;background:#fff;color:#5c3b12;')
      b.onclick = onclick
      return b
    }
    actions.appendChild(mkBtn('打开日志', true, () => emit('dsh-open-startup-log', {})))
    actions.appendChild(
      mkBtn('知道了', false, () => {
        box.remove()
      }),
    )
    box.appendChild(actions)

    document.body.appendChild(box)
  }

  // Forward Rust-side startup progress to the placeholder page
  // (#dsh-startup-status and the step indicator in #startup-steps). No-op on
  // the harness page (no such elements). Errors are styled red and the window
  // stays open so the user can read why the launch failed. Events may arrive
  // before the DOM is ready, so remember the latest message and replay it on
  // mount.
  let lastStartup = null
  // True once dsh reported ready: from then on the recovery controls are hidden.
  let serviceReady = false
  if (Tauri.event) {
    Tauri.event
      .listen('dsh-startup', (e) => {
        const ev = e.payload || {}
        const msg = typeof ev === 'string' ? { level: 'info', message: ev } : ev
        lastStartup = msg
        if (msg.stage === 'ready') serviceReady = true
        applyStartup(msg)
      })
      .catch(() => {})
  }

  // ── recovery controls (startup page only) ───────────────────────────────────
  // Visible while booting and after a failure; the container id keeps it off
  // the harness page (this script runs there too).
  function showRecoveryControls(visible) {
    const panel = document.getElementById('startup-panel')
    if (!panel) return
    let box = document.getElementById('dsh-recovery')
    if (!visible) {
      if (box) box.style.display = 'none'
      return
    }
    if (!box) {
      box = document.createElement('div')
      box.id = 'dsh-recovery'
      box.style.cssText =
        'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:16px;'

      const mkBtn = (text, primary, onclick) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.textContent = text
        b.style.cssText =
          'padding:7px 14px;border-radius:9px;font-size:12.5px;font-weight:600;cursor:pointer;' +
          'font-family:inherit;' +
          (primary
            ? 'border:none;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;'
            : 'border:1px solid #d0d7de;background:#fff;color:#24292f;')
        b.onclick = onclick
        return b
      }

      // Retry without restarting: cheap, and enough when the failure was
      // transient (a cold-start timeout, a port clash, an antivirus delay).
      box.appendChild(
        mkBtn('重试启动', true, () => {
          const status = document.getElementById('dsh-startup-status')
          if (status) {
            status.textContent = '正在重试启动 dsh…'
            status.className = 'status'
          }
          emit('dsh-retry-start', {})
        }),
      )
      box.appendChild(mkBtn('打开日志', false, () => emit('dsh-open-startup-log', {})))

      const hint = document.createElement('div')
      hint.style.cssText = 'width:100%;font-size:11.5px;color:#8b949e;text-align:center;'
      hint.textContent = '启动失败时先点「重试启动」；仍失败则点「打开日志」看具体原因。'
      box.appendChild(hint)

      const insertAfter = document.getElementById('dsh-startup-status') || panel.lastElementChild
      if (insertAfter && insertAfter.parentNode === panel) {
        panel.insertBefore(box, insertAfter.nextSibling)
      } else {
        panel.appendChild(box)
      }
    }
    box.style.display = 'flex'
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
    // Recovery controls: shown while the shell is still booting and kept on
    // screen after a failure, so a launch that never yields a URL is still
    // escapable from the page.
    showRecoveryControls(isError || !serviceReady)

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
      // The bar is transparent and sits on top of the page content; the
      // harness UI's own top-right controls are nudged down to clear it.
    }
    // Drop the header-utilities nudge style (idempotent per document).
    if (!document.getElementById('deepseek-harness-header-nudge')) {
      document.head.appendChild(nudgeStyle)
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
