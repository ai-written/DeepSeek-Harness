// update-banner.js — 更新提示横幅（直接下载，不跳转 GitHub）
// 注入到 harness 页面，监听 Rust 后端发来的 dsh-update-available 事件。
// 设计：启动时一次性检查（Rust 侧静默失败、可配置），前端仅负责展示与发起下载。
//
// 下载流程：Rust 后端在检测到新版本时已按“当前是免安装版还是安装版”对
// release 资产排序（assets[0] 即本机该用的包）。点击“下载更新”后，前端把该
// 资产交给后端（dsh-update-open，mode=download），由 Rust 用 curl 下载到
// 「下载」文件夹、校验 sha256、解除“来自互联网”标记，并在资源管理器中选中。
// 只有在拿不到可下载资产或下载失败时，才回退到打开 GitHub 发布页。
(function () {
  'use strict'
  if (window.__deepseekUpdateBanner) return
  window.__deepseekUpdateBanner = true

  const Tauri = window.__TAURI__
  if (!Tauri || !Tauri.event) return

  /** 忽略的版本号（用户点过“忽略此版本”），用于下载回调里识别“已跳过”。 */
  let ignoredVersion = ''
  /** 本次下载请求对应的资产文件名（后端完成事件里可能不带文件名）。 */
  let pendingName = ''

  /** 把 {url,mode}/string 交给 Rust 后端处理；返回是否成功投递。 */
  function requestBackend(payload) {
    try {
      if (Tauri.event && Tauri.event.emit) {
        Tauri.event.emit('dsh-update-open', JSON.stringify(payload)).catch(() => {})
        return true
      }
    } catch {}
    return false
  }

  /** 打开 GitHub 发布页（后端用系统默认浏览器打开，WebView2 里 window.open 会被吞掉）。 */
  function fallbackToBrowser(url) {
    if (requestBackend({ url, mode: 'browser' })) return
    try {
      window.open(url, '_blank')
    } catch {}
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0
    if (n <= 0) return ''
    const mb = n / (1024 * 1024)
    return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`
  }

  function showUpdate(payload) {
    const p = payload || {}
    const version = p.version || p.tag || ''
    const current = p.current || ''
    const releaseUrl = p.releaseUrl || p.url || 'https://github.com/ai-written/DeepSeek-Harness'
    const assets = Array.isArray(p.assets) ? p.assets.filter((a) => a && a.url) : []
    const asset = assets[0] || null
    const kb = (p.portable ? '免安装版' : '安装版') + (p.assetLabel ? ` → ${p.assetLabel}` : '')
    if (!version) return

    // 重建横幅：清掉上一个版本的残留节点。
    const old = document.getElementById('deepseek-harness-update-banner')
    if (old && old.parentNode) old.parentNode.removeChild(old)

    const banner = document.createElement('div')
    banner.id = 'deepseek-harness-update-banner'
    banner.style.cssText =
      'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2147483647;' +
      'display:flex;align-items:center;gap:12px;max-width:min(760px,calc(100% - 32px));' +
      'padding:10px 12px 10px 14px;border-radius:12px;' +
      'background:linear-gradient(180deg,#ffffff,#f6f8fa);color:#1f2328;' +
      'border:1px solid #d0d7de;box-shadow:0 12px 32px rgba(31,35,40,0.18);' +
      'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.4;'

    const dot = document.createElement('div')
    dot.style.cssText =
      'width:8px;height:8px;border-radius:50%;background:#1f6feb;flex-shrink:0;box-shadow:0 0 0 6px rgba(31,111,235,0.12);'
    banner.appendChild(dot)

    const text = document.createElement('div')
    text.style.cssText = 'flex:1;min-width:0;'
    const title = document.createElement('div')
    title.style.cssText =
      'font-weight:700;color:#1f2328;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    title.textContent = `发现新版本 ${version}` + (current ? `（当前 ${current}）` : '')
    const sub = document.createElement('div')
    sub.style.cssText =
      'font-size:11.5px;color:#57606a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
    if (asset) {
      // 让用户一眼看到“会下哪个包、下完放哪”：按当前形态（免安装/安装版）选好的资产。
      const size = formatSize(asset.size)
      sub.textContent = `将下载${asset.kind === 'installer' ? '安装版' : '免安装版'} ${asset.name}${size ? `（${size}）` : ''} 到「下载」文件夹`
      sub.title = `当前：${kb}\n将下载：${asset.name}\n${releaseUrl}`
    } else {
      sub.textContent = '未取到可直连的安装包，将打开 GitHub 发布页'
      sub.title = releaseUrl
    }
    if (p.notes) sub.title = String(p.notes).slice(0, 400)
    text.appendChild(title)
    text.appendChild(sub)
    banner.appendChild(text)

    const btnGo = document.createElement('button')
    btnGo.type = 'button'
    btnGo.textContent = asset ? '下载更新' : '打开发布页'
    btnGo.title = asset ? `直接下载 ${asset.name}` : '在浏览器中打开 release 页面'
    btnGo.style.cssText =
      'padding:6px 14px;border:none;border-radius:8px;background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;font-weight:600;font-size:12.5px;cursor:pointer;flex-shrink:0;'
    banner.appendChild(btnGo)

    const btnNotes = document.createElement('button')
    btnNotes.type = 'button'
    btnNotes.textContent = '更新说明'
    btnNotes.style.cssText =
      'padding:6px 12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;color:#24292f;font-weight:600;font-size:12.5px;cursor:pointer;flex-shrink:0;'
    btnNotes.onclick = () => {
      if (p.notes) {
        // 复用副标题做行内展开，避免额外的弹窗/跳转。
        sub.textContent = String(p.notes).slice(0, 500)
        sub.title = String(p.notes).slice(0, 2000)
        sub.style.whiteSpace = 'normal'
        sub.style.maxHeight = '72px'
        sub.style.overflowY = 'auto'
      } else {
        fallbackToBrowser(releaseUrl)
      }
    }
    banner.appendChild(btnNotes)

    const btnIgnore = document.createElement('button')
    btnIgnore.type = 'button'
    btnIgnore.textContent = '忽略此版本'
    btnIgnore.style.cssText =
      'padding:6px 12px;border:1px solid #d0d7de;border-radius:8px;background:#f6f8fa;color:#24292f;font-weight:600;font-size:12.5px;cursor:pointer;flex-shrink:0;'
    btnIgnore.onclick = () => {
      try {
        if (Tauri.event && Tauri.event.emit) Tauri.event.emit('dsh-update-ignore', { version }).catch(() => {})
      } catch {}
      ignoredVersion = version
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

    /** 下载期间禁用按钮并提示进行中。 */
    function setDownloading(on) {
      btnGo.disabled = on
      btnGo.style.opacity = on ? '0.7' : '1'
      btnGo.style.cursor = on ? 'default' : 'pointer'
      btnGo.textContent = on ? '下载中…' : '下载更新'
    }

    /** 发起下载：把后端选好的资产交给 Rust 拉取（node 优先，curl 兜底）。 */
    function startDownload() {
      if (!asset) {
        fallbackToBrowser(releaseUrl)
        return
      }
      pendingName = asset.name || ''
      const delivered = requestBackend({
        mode: 'download',
        url: asset.url,
        name: asset.name || '',
        size: asset.size || 0,
        digest: asset.digest || '',
        releaseUrl,
      })
      if (!delivered) fallbackToBrowser(releaseUrl)
      else setDownloading(true)
    }

    btnGo.onclick = () => {
      setDownloading(false) // 允许重试；下面立刻切回下载中
      startDownload()
    }

    /** Rust 后端下载结果回调：更新按钮与提示文案。 */
    function onProgress(raw) {
      let e = raw
      if (typeof e === 'string') {
        try {
          e = JSON.parse(e)
        } catch {
          return
        }
      }
      const d = e && typeof e === 'object' ? e.payload || e : {}
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d)
        } catch {
          return
        }
      }
      const state = d.state
      if (!state) return
      if (state === 'started') {
        setDownloading(true)
        sub.textContent = pendingName ? `正在下载 ${pendingName}…` : '正在下载…'
        return
      }
      if (state === 'progress') {
        // Real byte counts from the backend (node route reports them); the curl
        // fallback simply never emits this state, so the text stays as-is.
        setDownloading(true)
        if (d.message) sub.textContent = `${d.message}${pendingName ? `（${pendingName}）` : ''}`
        return
      }
      if (state === 'done') {
        setDownloading(false)
        btnGo.textContent = '重新下载'
        // 后端下载完会自动在资源管理器中选中该文件；这里保留一个手动入口。
        btnGo.onclick = () => {
          if (d.file) {
            requestBackend({ mode: 'reveal', path: d.file, releaseUrl })
          } else {
            startDownload()
          }
        }
        sub.textContent = d.message || '已下载，已在文件夹中选中'
        sub.style.whiteSpace = 'normal'
        return
      }
      if (state === 'failed') {
        setDownloading(false)
        btnGo.textContent = '重试下载'
        sub.style.whiteSpace = 'normal'
        sub.textContent = `下载失败：${d.message || '未知错误'}（后端已尝试打开 GitHub 发布页，也可点此重试）`
      }
    }

    function mount() {
      if (!document.getElementById('deepseek-harness-update-banner')) document.body.appendChild(banner)
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true })
    else mount()

    return { onProgress }
  }

  /** 当前横幅的进度回调（每次 showUpdate 替换）。 */
  let active = null

  Tauri.event
    .listen('dsh-update-available', (e) => {
      try {
        const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload
        active = showUpdate(payload)
      } catch {}
    })
    .catch(() => {})

  Tauri.event
    .listen('dsh-update-progress', (e) => {
      try {
        if (active && active.onProgress) active.onProgress(e)
      } catch {}
    })
    .catch(() => {})

  function closeBanner() {
    const b = document.getElementById('deepseek-harness-update-banner')
    if (b && b.parentNode) b.parentNode.removeChild(b)
    active = null
  }
})()
