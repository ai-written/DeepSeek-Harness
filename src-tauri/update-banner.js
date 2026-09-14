// update-banner.js — 更新提示横幅（直接下载 → 自动安装 → 自动清理）
// 注入到 harness 页面，监听 Rust 后端发来的 dsh-update-available 事件。
// 设计：启动时一次性检查（Rust 侧静默失败、可配置），前端仅负责展示与发起下载。
//
// 下载流程：Rust 后端在检测到新版本时已按“当前形态”（免安装版 / NSIS 安装版 /
// MSI 安装版）对 release 资产排序（assets[0] 即本机该用的包）。点击“下载更新”后，
// 前端把该资产交给后端（dsh-update-open，mode=download），Rust 下载到系统「下载」
// 文件夹、校验 sha256、解除“来自互联网”标记，然后：
//   · 安装版（setup.exe / .msi）→ 直接启动安装程序，安装结束后自动删除安装包；
//   · 免安装版 → 不执行（执行只会又开一个实例），在资源管理器中选中该文件。
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
  /** 请求序号：横幅实例与它发起的每个请求都带 id，后端原样回传，用于丢弃过期事件。 */
  let requestSeq = 0

  function nextRequestId(prefix) {
    requestSeq += 1
    return prefix + '-' + Date.now().toString(36) + '-' + requestSeq
  }

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

  /** 资产形态的中文名。MSI 曾经被当成免安装版显示，故这里是三分支。 */
  function kindLabel(kind) {
    switch (kind) {
      case 'installer':
        return '安装版（NSIS 安装包）'
      case 'msi':
        return '安装版（MSI 安装包）'
      case 'portable':
        return '免安装版'
      default:
        return '更新包'
    }
  }

  /** 安装版才会被自动执行；免安装版只下载（执行它只会又开一个实例）。 */
  function isInstallerKind(kind) {
    return kind === 'installer' || kind === 'msi'
  }

  function showUpdate(payload) {
    const p = payload || {}
    const version = p.version || p.tag || ''
    const current = p.current || ''
    const releaseUrl = p.releaseUrl || p.url || 'https://github.com/ai-written/DeepSeek-Harness'
    const assets = Array.isArray(p.assets) ? p.assets.filter((a) => a && a.url) : []
    const asset = assets[0] || null
    const packagingLabel = p.packaging ? kindLabel(p.packaging) : p.portable ? '免安装版' : '安装版'
    if (!version) return

    // 重建横幅：清掉上一个版本的残留节点。本实例有一个唯一 token，后端回传的
    // 事件里带上它，因此上一个横幅（或上一次下载）的迟到事件不会被应用到这里。
    const old = document.getElementById('deepseek-harness-update-banner')
    if (old && old.parentNode) old.parentNode.removeChild(old)
    const bannerToken = nextRequestId('banner')
    let reqCounter = 0
    function requestId() {
      reqCounter += 1
      return bannerToken + '-r' + reqCounter
    }

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
      // 让用户一眼看到“会下哪个包、下完放哪、会不会自动装”：按当前形态选好的资产。
      const size = formatSize(asset.size)
      if (isInstallerKind(asset.kind)) {
        sub.textContent = `将下载并自动安装 ${asset.name}${size ? `（${size}）` : ''}，安装完成后自动删除安装包`
      } else {
        sub.textContent = `将下载${kindLabel(asset.kind)} ${asset.name}${size ? `（${size}）` : ''} 到「下载」文件夹并选中`
      }
      sub.title = `当前形态：${packagingLabel}\n将下载：${asset.name}（${kindLabel(asset.kind)}）\n${releaseUrl}`
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

    /** 下载/安装完成后 Rust 报告的真实落盘路径（“打开所在文件夹”/“重新安装”用）。 */
    let downloadedFile = ''

    /** 主按钮状态：禁用即表示进行中。 */
    function setBusy(on, label) {
      btnGo.disabled = on
      btnGo.style.opacity = on ? '0.7' : '1'
      btnGo.style.cursor = on ? 'default' : 'pointer'
      if (label) btnGo.textContent = label
    }

    /** 主按钮动作：改成“打开所在文件夹”。 */
    function setPrimaryReveal() {
      setBusy(false, '打开所在文件夹')
      btnGo.title = downloadedFile ? `在资源管理器中选中 ${downloadedFile}` : '打开「下载」文件夹'
      btnGo.onclick = () => {
        if (downloadedFile) requestBackend({ mode: 'reveal', path: downloadedFile, releaseUrl })
        else fallbackToBrowser(releaseUrl)
      }
    }

    /** 主按钮动作：改成“重新安装”（安装被取消或失败、安装包仍在时）。 */
    function setPrimaryInstall() {
      setBusy(false, '重新安装')
      btnGo.title = '再次运行已下载的安装程序'
      btnGo.onclick = () => {
        if (!downloadedFile) return startDownload()
        const req = requestId()
        const delivered = requestBackend({
          mode: 'install',
          url: downloadedFile,
          name: pendingName,
          kind: assetKind(),
          releaseUrl,
          req,
        })
        if (!delivered) fallbackToBrowser(releaseUrl)
        else setBusy(true, '安装中…')
      }
    }

    function assetKind() {
      return asset && asset.kind ? asset.kind : ''
    }

    /** 发起下载：把后端选好的资产交给 Rust 拉取（node 优先，curl 兜底）。 */
    function startDownload() {
      if (!asset) {
        fallbackToBrowser(releaseUrl)
        return
      }
      pendingName = asset.name || ''
      downloadedFile = ''
      const req = requestId()
      const delivered = requestBackend({
        mode: 'download',
        url: asset.url,
        name: asset.name || '',
        kind: asset.kind || '',
        size: asset.size || 0,
        digest: asset.digest || '',
        releaseUrl,
        req,
      })
      if (!delivered) fallbackToBrowser(releaseUrl)
      else setBusy(true, '下载中…')
    }

    btnGo.onclick = () => {
      setBusy(false, '下载更新') // 允许重试；下面立刻切回下载中
      startDownload()
    }

    /** Rust 后端结果回调：更新按钮与提示文案。 */
    function onProgress(raw) {
      let e = raw
      if (typeof e === 'string') {
        try {
          e = JSON.parse(e)
        } catch {
          return
        }
      }
      let d = e && typeof e === 'object' ? e.payload || e : {}
      // 后端的 payload 可能被 JSON 再包一层（JS emit 字符串的转义规则）。
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d)
        } catch {
          return
        }
      }
      const state = d.state
      if (!state) return
      // 只接受本横幅实例发起的请求的事件：换了一个版本、或重新发起下载后，
      // 旧请求（含仍在下载中的那一次）的迟到事件不能覆盖当前横幅。
      if (d.req && !String(d.req).startsWith(bannerToken)) return
      if (state === 'started') {
        setBusy(true, '下载中…')
        sub.textContent = pendingName ? `正在下载 ${pendingName}…` : '正在下载…'
        return
      }
      if (state === 'progress') {
        // Real byte counts from the backend (node route reports them); the curl
        // fallback simply never emits this state, so the text stays as-is.
        setBusy(true, '下载中…')
        if (d.message) sub.textContent = `${d.message}${pendingName ? `（${pendingName}）` : ''}`
        return
      }
      if (state === 'installing') {
        // 后端已下载完成并启动了安装程序：这里只等它装完。
        setBusy(true, '安装中…')
        sub.style.whiteSpace = 'normal'
        sub.textContent = d.message || '正在启动安装程序…'
        return
      }
      if (state === 'installed') {
        // 安装完成且安装包已自动删除：没有再要下的东西了。
        setBusy(true, '已安装')
        btnGo.title = '安装完成'
        sub.style.whiteSpace = 'normal'
        sub.textContent = d.message || '安装完成，安装包已自动删除'
        return
      }
      if (state === 'launched') {
        // 用户取消了 UAC / 安装程序失败：安装包被保留，可再次运行。
        if (d.file) downloadedFile = d.file
        setPrimaryInstall()
        sub.style.whiteSpace = 'normal'
        sub.textContent = (d.message || '安装未完成') + (downloadedFile ? `：${downloadedFile}` : '')
        return
      }
      if (state === 'done') {
        if (d.file) downloadedFile = d.file
        // 免安装版：后端已自动在资源管理器中选中；这里保留一个手动入口。
        // 安装版若落到 done，说明自动安装没能启动（例如非 Windows），
        // 也提供“重新安装”让用户点一下。
        if (isInstallerKind(assetKind())) setPrimaryInstall()
        else setPrimaryReveal()
        sub.style.whiteSpace = 'normal'
        sub.textContent = d.message || '已下载，已在文件夹中选中'
        return
      }
      if (state === 'failed') {
        // 后端给的 message 是完整的（含“已打开发布页/可重试”等提示），这里原样显示，
        // 避免前端再去猜后端到底做了什么。
        setBusy(false, '重试下载')
        sub.style.whiteSpace = 'normal'
        sub.textContent = d.message || '下载失败：未知错误（可点此重试）'
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
