// update-banner.js — GitHub 更新提示横幅
// 注入到 harness 页面，监听 Rust 后端发来的 dsh-update-available 事件。
// 设计：启动时一次性检查（Rust 侧 24h 节流、静默失败），前端仅负责展示。
(function () {
  'use strict'
  if (window.__deepseekUpdateBanner) return
  window.__deepseekUpdateBanner = true

  const Tauri = window.__TAURI__
  if (!Tauri || !Tauri.event) return

  let banner = null

  function closeBanner() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner)
    banner = null
  }

  function openUrl(url) {
    try {
      // The embedded WebView2 swallows window.open, so route through Rust:
      // emit dsh-update-open and let the backend open the system default
      // browser (see the dsh-update-open listener in main.rs).
      if (Tauri.event && Tauri.event.emit) {
        Tauri.event.emit('dsh-update-open', { url }).catch(() => {})
        return
      }
    } catch {}
    try {
      window.open(url, '_blank')
    } catch {}
  }

  function showUpdate(payload) {
    const p = payload || {}
    const version = p.version || p.tag || ''
    const current = p.current || ''
    const releaseUrl = p.releaseUrl || p.url || 'https://github.com/ai-written/DeepSeek-Harness'
    const url = p.url || releaseUrl
    if (!version) return
    if (banner) closeBanner()

    banner = document.createElement('div')
    banner.id = 'deepseek-harness-update-banner'
    banner.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'display:flex;align-items:center;gap:12px;max-width:min(720px,calc(100% - 32px));' +
      'padding:10px 12px 10px 14px;border-radius:12px;' +
      'background:linear-gradient(180deg,#ffffff,#f6f8fa);color:#1f2328;' +
      'border:1px solid #d0d7de;box-shadow:0 12px 32px rgba(31,35,40,0.18);' +
      'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.4;'

    const dot = document.createElement('div')
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#1f6feb;flex-shrink:0;box-shadow:0 0 0 6px rgba(31,111,235,0.12);'
    banner.appendChild(dot)

    const text = document.createElement('div')
    text.style.cssText = 'flex:1;min-width:0;'
    const title = document.createElement('div')
    title.style.cssText = 'font-weight:700;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    title.textContent = `发现新版本 ${version}` + (current ? `（当前 ${current}）` : '')
    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:11.5px;color:#57606a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    sub.textContent = '点击前往下载，或忽略此版本'
    if (p.notes) sub.title = String(p.notes).slice(0, 400)
    text.appendChild(title)
    text.appendChild(sub)
    banner.appendChild(text)

    const btnGo = document.createElement('button')
    btnGo.type = 'button'
    btnGo.textContent = '前往下载'
    btnGo.style.cssText =
      'padding:6px 14px;border:none;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-weight:600;font-size:12.5px;cursor:pointer;flex-shrink:0;'
    btnGo.onclick = () => openUrl(releaseUrl || url)
    banner.appendChild(btnGo)

    const btnIgnore = document.createElement('button')
    btnIgnore.type = 'button'
    btnIgnore.textContent = '忽略此版本'
    btnIgnore.style.cssText =
      'padding:6px 12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;color:#24292f;font-weight:600;font-size:12.5px;cursor:pointer;flex-shrink:0;'
    btnIgnore.onclick = () => {
      try {
        if (Tauri.event && Tauri.event.emit) Tauri.event.emit('dsh-update-ignore', { version }).catch(() => {})
      } catch {}
      closeBanner()
    }
    banner.appendChild(btnIgnore)

    const btnClose = document.createElement('button')
    btnClose.type = 'button'
    btnClose.textContent = '×'
    btnClose.title = '关闭'
    btnClose.style.cssText =
      'width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:transparent;color:#57606a;font-size:18px;line-height:1;cursor:pointer;flex-shrink:0;'
    btnClose.onmouseenter = () => (btnClose.style.background = '#f0f2f5')
    btnClose.onmouseleave = () => (btnClose.style.background = 'transparent')
    btnClose.onclick = closeBanner
    banner.appendChild(btnClose)

    function mount() {
      if (!document.getElementById('deepseek-harness-update-banner')) document.body.appendChild(banner)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
    else mount()
  }

  Tauri.event
    .listen('dsh-update-available', (e) => {
      try {
        const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload
        showUpdate(payload)
      } catch {}
    })
    .catch(() => {})
})()
