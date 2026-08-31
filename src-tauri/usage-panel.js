// usage-panel.js — in-window daily-cost badge + a click-to-edit pricing dialog.
//
// Injected into the harness page alongside window-controls.js (WebviewWindowBuilder
// initialization_script). It paints a single-line pill at the bottom-left (right
// of the sidebar's settings button) showing today's estimated cost in CNY only;
// hovering shows requests / date / recent days. Clicking the pill opens a small
// dialog to view charts, filter by provider, and edit the exchange rate, the
// default per-million prices, and per-model overrides. Saving writes
// `~/.dsh/storages/usage-pricing.json` via the
// `save_usage_pricing` Tauri command; the sidecar re-reads it on every emit, so
// the displayed amount updates within a few seconds. The panel only appears once
// the first amount has rendered (no empty box).

(function () {
  'use strict'

  if (window.__deepseekHarnessUsage) return
  window.__deepseekHarnessUsage = true

  const Tauri = window.__TAURI__
  if (!Tauri || !Tauri.event) {
    console.warn('[deepseek-harness] __TAURI__ unavailable; usage panel disabled')
    return
  }

  // ── amount pill ─────────────────────────────────────────────────────────────
  const panel = document.createElement('div')
  panel.id = 'deepseek-harness-usage'
  panel.style.cssText =
    'position:fixed;left:76px;bottom:14px;z-index:2147483646;' +
    'display:inline-block;padding:5px 14px 5px 10px;border-radius:999px;' +
    'background:linear-gradient(180deg,#ffffff,#f3f5f8);color:#1f2328;white-space:nowrap;' +
    'border:1px solid #d0d7de;' +
    'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
    'font-size:14px;font-weight:700;line-height:1.5;' +
    'box-shadow:0 3px 12px rgba(31,35,40,0.14);' +
    'pointer-events:auto;-webkit-user-select:none;user-select:none;cursor:pointer;'
  panel.title = '点击查看用量与配置'
  panel.addEventListener('mouseenter', () => {
    panel.style.borderColor = '#3b82f6'
    panel.style.boxShadow = '0 4px 16px rgba(59,130,246,0.30)'
    panel.style.color = '#1f6feb'
  })
  panel.addEventListener('mouseleave', () => {
    panel.style.borderColor = '#d0d7de'
    panel.style.boxShadow = '0 3px 12px rgba(31,35,40,0.14)'
    panel.style.color = '#1f2328'
  })

  // Prettier amount: small ¥ symbol + larger number.
  function renderAmount(cny) {
    const sym = document.createElement('span')
    sym.textContent = '¥'
    sym.style.cssText = 'font-size:11px;font-weight:600;color:#57606a;margin-right:1px;'
    const num = document.createElement('span')
    num.textContent = String(cny)
    num.style.cssText = 'font-size:15px;font-weight:700;color:inherit;font-variant-numeric:tabular-nums;'
    panel.innerHTML = ''
    panel.appendChild(sym)
    panel.appendChild(num)
  }

  let lastPayload = null

  function fmtMoney(x, rate) {
    const v = typeof x === 'number' ? (x * (rate || 1)).toFixed(2) : '—'
    return '¥' + v
  }

  function fmtTokens(n) {
    const v = Number(n) || 0
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
    return String(v)
  }

  // Total tokens = input + cache read + cache write + output.
  function totalTokens(t) {
    return (Number(t?.input) || 0) + (Number(t?.cacheRead) || 0) + (Number(t?.cacheWrite) || 0) + (Number(t?.output) || 0)
  }

  // Cache hit rate = cacheRead / (input + cacheRead) as a percentage.
  function hitRateOf(t) {
    const inp = Number(t?.input) || 0
    const cr = Number(t?.cacheRead) || 0
    const denom = inp + cr
    return denom > 0 ? (cr / denom) * 100 : 0
  }

  function apply(payload) {
    const p = payload || {}
    const today = p.today || {}
    const cny = typeof today.cny === 'number' ? today.cny.toFixed(2) : '—'
    renderAmount(cny)
  }

  function show() {
    // Only on the harness page — never on the startup placeholder page (which
    // carries #startup-panel). The panel appears once navigation reaches dsh web.
    if (document.getElementById('startup-panel')) return
    if (!document.getElementById('deepseek-harness-usage')) document.body.appendChild(panel)
    if (lastPayload) apply(lastPayload)
  }

  // Modal element refs (filled by buildModal).
  let modal = null
  let modalContent = null
  let modalFooter = null
  let modalStatus = null
  let modalSaveBtn = null
  let tabChartEl = null
  let tabFormEl = null
  let modalPayload = null
  const FIELDS = [
    ['inputPerMillion', '输入（每百万$）'],
    ['cacheReadPerMillion', '缓存读（每百万$）'],
    ['cacheWritePerMillion', '缓存写（每百万$）'],
    ['outputPerMillion', '输出（每百万$）'],
  ]

  function buildModal() {
    if (modal) return modal
    modal = document.createElement('div')
    modal.id = 'deepseek-harness-usage-modal'
    modal.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:none;align-items:center;justify-content:center;' +
      'padding:24px;background:rgba(9,12,16,0.55);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);' +
      'font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;'
    const box = document.createElement('div')
    box.style.cssText =
      'width:460px;max-width:100%;max-height:84vh;overflow:auto;padding:20px 22px;border-radius:14px;' +
      'background:#ffffff;color:#1f2328;font-size:13px;' +
      'border:1px solid #d0d7de;box-shadow:0 18px 60px rgba(0,0,0,0.25);' +
      'scrollbar-width:thin;scrollbar-color:#c1c9d1 transparent;'

    const head = document.createElement('div')
    head.style.cssText = 'margin-bottom:14px;'
    const title = document.createElement('div')
    title.textContent = '用量统计'
    title.style.cssText = 'font-size:16px;font-weight:700;color:#1f2328;'
    const subtitle = document.createElement('div')
    subtitle.textContent = '近一周用量与费用配置（估算，非账单）'
    subtitle.style.cssText = 'margin-top:3px;font-size:11.5px;color:#57606a;'
    head.appendChild(title)
    head.appendChild(subtitle)

    // Tab bar (two sub-tabs, styled like harness settings tabs).
    const tabbar = document.createElement('div')
    tabbar.style.cssText =
      'display:flex;gap:4px;margin-bottom:14px;padding:3px;border-radius:9px;background:#f0f2f5;'
    tabChartEl = makeTab('周用量')
    tabFormEl = makeTab('单价配置')
    tabbar.appendChild(tabChartEl)
    tabbar.appendChild(tabFormEl)

    modalContent = document.createElement('div') // populated by renderChartTab / renderFormTab

    modalFooter = document.createElement('div')
    modalFooter.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:18px;'
    modalStatus = document.createElement('div')
    modalStatus.style.cssText = 'flex:1;min-width:0;font-size:11.5px;color:#57606a;'
    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display:flex;gap:8px;flex-shrink:0;'
    const cancel = makeButton('取消', 'ghost')
    modalSaveBtn = makeButton('保存', 'primary')
    modalFooter.appendChild(modalStatus)
    btnRow.appendChild(cancel)
    btnRow.appendChild(modalSaveBtn)
    modalFooter.appendChild(btnRow)

    box.appendChild(head)
    box.appendChild(tabbar)
    box.appendChild(modalContent)
    box.appendChild(modalFooter)
    modal.appendChild(box)
    document.body.appendChild(modal)

    tabChartEl.onclick = () => selectTab('chart')
    tabFormEl.onclick = () => selectTab('form')
    modal.addEventListener('mousedown', (e) => {
      if (e.target === modal) closeModal()
    })
    cancel.addEventListener('click', closeModal)
    return modal
  }

  // One tab pill. Active state = white bg + accent text + shadow, inactive =
  // transparent; hovering an inactive tab hints the accent color.
  function makeTab(text) {
    const t = document.createElement('button')
    t.type = 'button'
    t.textContent = text
    t.style.cssText =
      'flex:1;padding:6px 10px;border:none;border-radius:7px;font-size:12.5px;font-weight:600;cursor:pointer;' +
      'font-family:inherit;background:transparent;color:#57606a;transition:background .15s,color .15s,box-shadow .15s;'
    t.addEventListener('mouseenter', () => {
      if (!t._active) t.style.color = '#1f6feb'
    })
    t.addEventListener('mouseleave', () => {
      if (!t._active) t.style.color = '#57606a'
    })
    return t
  }

  function setTabActive(el, active) {
    el._active = active
    el.style.background = active ? '#ffffff' : 'transparent'
    el.style.color = active ? '#1f6feb' : '#57606a'
    el.style.boxShadow = active ? '0 1px 4px rgba(0,0,0,0.12)' : 'none'
    el.style.fontWeight = active ? '700' : '600'
  }

  function selectTab(name) {
    const isChart = name === 'chart'
    setTabActive(tabChartEl, isChart)
    setTabActive(tabFormEl, !isChart)
    if (isChart) {
      modalFooter.style.display = 'none'
      renderChartTab()
    } else {
      modalFooter.style.display = 'flex'
      renderFormTab()
    }
  }

  // Buttons: primary = blue gradient + glow, secondary = soft light fill.
  // Hover/press states via JS listeners (inline styles can't express :hover
  // under a strict CSP).
  function makeButton(text, kind) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = text
    const base =
      'padding:8px 20px;border-radius:9px;font-size:13px;font-weight:600;cursor:pointer;' +
      'font-family:inherit;transition:all .15s ease;'
    if (kind === 'primary') {
      b.style.cssText =
        base +
        'background:linear-gradient(135deg,#3b82f6,#2563eb);border:none;color:#ffffff;' +
        'box-shadow:0 2px 8px rgba(59,130,246,0.35);'
      b.addEventListener('mouseenter', () => {
        b.style.filter = 'brightness(1.08)'
        b.style.boxShadow = '0 4px 14px rgba(59,130,246,0.45)'
      })
      b.addEventListener('mouseleave', () => {
        b.style.filter = 'none'
        b.style.boxShadow = '0 2px 8px rgba(59,130,246,0.35)'
      })
    } else {
      b.style.cssText =
        base + 'background:#f6f8fa;border:1px solid #d0d7de;color:#24292f;'
      b.addEventListener('mouseenter', () => {
        b.style.borderColor = '#3b82f6'
        b.style.color = '#1f6feb'
        b.style.background = '#f0f6ff'
      })
      b.addEventListener('mouseleave', () => {
        b.style.borderColor = '#d0d7de'
        b.style.color = '#24292f'
        b.style.background = '#f6f8fa'
      })
    }
    b.addEventListener('mousedown', () => {
      b.style.transform = 'scale(0.97)'
    })
    b.addEventListener('mouseup', () => {
      b.style.transform = 'scale(1)'
    })
    return b
  }

  // Field label (muted) vs section heading (brighter, slightly larger).
  function label(text, color) {
    const l = document.createElement('div')
    l.textContent = text
    const isSection = color === '#e6edf3'
    l.style.cssText =
      'font-weight:' + (isSection ? '700' : '600') + ';' +
      'color:' + (isSection ? '#1f2328' : '#57606a') + ';' +
      (isSection
        ? 'margin:18px 0 10px;font-size:12px;letter-spacing:0.4px;text-transform:uppercase;'
        : 'margin:12px 0 5px;font-size:12px;')
    return l
  }

  const INPUT_STYLE =
    'width:100%;box-sizing:border-box;padding:7px 10px;border-radius:8px;border:1px solid #d0d7de;' +
    'background:#f6f8fa;color:#1f2328;font-size:13px;outline:none;' +
    'transition:border-color .15s,box-shadow .15s;'

  function focusableInput(el) {
    el.addEventListener('focus', () => {
      el.style.borderColor = '#388bfd'
      el.style.boxShadow = '0 0 0 3px rgba(56,139,253,0.18)'
    })
    el.addEventListener('blur', () => {
      el.style.borderColor = '#d0d7de'
      el.style.boxShadow = 'none'
    })
    return el
  }

  function numberInput(value) {
    const i = document.createElement('input')
    i.type = 'number'
    i.step = 'any'
    i.value = Number.isFinite(value) && value !== undefined ? String(value) : ''
    i.style.cssText = INPUT_STYLE
    return focusableInput(i)
  }

  // ── chart tab (Chart.js, bundled into the injected script) ─────────────────
  function chartTitle(text) {
    const d = document.createElement('div')
    d.textContent = text
    d.style.cssText = 'font-size:12px;font-weight:700;color:#24292f;margin:14px 0 6px;'
    return d
  }

  function emptyBox(text) {
    const d = document.createElement('div')
    d.textContent = text
    d.style.cssText = 'text-align:center;color:#8b949e;padding:40px 0;font-size:13px;'
    return d
  }

  let chartRange = 'day' // 'day' | 'week' | 'month'
  let chartInstance = null
  let providerFilter = '' // empty = all providers

  function providerEntries(summary) {
    return Array.isArray(summary?.providers) ? summary.providers : []
  }

  function providerNames(payload) {
    const names = new Set()
    for (const row of providerEntries(payload?.today)) {
      if (row.provider != null) names.add(String(row.provider))
    }
    for (const day of Array.isArray(payload?.recent) ? payload.recent : []) {
      for (const row of providerEntries(day)) {
        if (row.provider != null) names.add(String(row.provider))
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  function providerSummary(summary) {
    if (!providerFilter) return summary || null
    return providerEntries(summary).find((row) => String(row.provider) === providerFilter) || null
  }

  function usagePoint(source, date, title) {
    const row = source || {}
    return {
      date,
      title,
      usd: row.usd,
      requests: row.requests,
      input: row.input,
      cacheRead: row.cacheRead,
      cacheWrite: row.cacheWrite,
      output: row.output,
    }
  }

  function renderChartTab() {
    modalContent.innerHTML = ''
    const payload = modalPayload || lastPayload || {}
    const recent = Array.isArray(payload.recent) ? payload.recent : []
    const rate = payload.exchangeRate || 7.2

    // Provider filter. The sidecar supplies provider summaries alongside the
    // existing all-provider totals, so changing this menu only re-renders the
    // current chart and does not trigger another log scan.
    const providers = providerNames(payload)
    if (providerFilter && !providers.includes(providerFilter)) providerFilter = ''
    const filterRow = document.createElement('div')
    filterRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;'
    const filterLabel = document.createElement('label')
    filterLabel.textContent = '供应商'
    filterLabel.style.cssText = 'font-size:12px;font-weight:600;color:#57606a;white-space:nowrap;'
    const filter = document.createElement('select')
    filter.id = 'deepseek-harness-provider-filter'
    filter.setAttribute('aria-label', '供应商筛选')
    filter.style.cssText =
      'min-width:180px;max-width:100%;padding:6px 30px 6px 10px;border-radius:8px;border:1px solid #d0d7de;' +
      'background:#f6f8fa;color:#1f2328;font:inherit;font-size:12.5px;cursor:pointer;outline:none;'
    const allOption = document.createElement('option')
    allOption.value = ''
    allOption.textContent = '全部供应商'
    filter.appendChild(allOption)
    for (const name of providers) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      filter.appendChild(option)
    }
    filter.value = providerFilter
    filter.onchange = () => {
      providerFilter = filter.value
      renderChartTab()
    }
    filterRow.appendChild(filterLabel)
    filterRow.appendChild(filter)
    modalContent.appendChild(filterRow)

    // 天 / 周 / 月 range toggle.
    const bar = document.createElement('div')
    bar.style.cssText = 'display:flex;gap:6px;margin-bottom:2px;'
    const mk = (label, range) => {
      const b = makeButton(label, chartRange === range ? 'primary' : 'secondary')
      b.style.padding = '4px 14px'
      b.style.fontSize = '12px'
      b.onclick = () => {
        if (chartRange !== range) {
          chartRange = range
          renderChartTab()
        }
      }
      return b
    }
    bar.appendChild(mk('天', 'day'))
    bar.appendChild(mk('周', 'week'))
    bar.appendChild(mk('月', 'month'))
    modalContent.appendChild(bar)

    // Series data: 天 = today's 0–24 hourly; 周/月 = recent days (chronological).
    let points = []
    let rangeLabel = ''
    if (chartRange === 'day') {
      const today = providerSummary(payload.today)
      const hourly = Array.isArray(today?.hourly) ? today.hourly : []
      points = hourly.map((h, i) =>
        usagePoint(
          h,
          String(i).padStart(2, '0') + ':00',
          // hover range: "09:00 - 10:00"; the last hour ends at 24:00
          String(i).padStart(2, '0') + ':00 - ' + String(i + 1).padStart(2, '0') + ':00',
        ),
      )
      rangeLabel = '今日'
    } else {
      const limit = chartRange === 'month' ? 30 : 7
      points = recent
        .slice(0, limit)
        .reverse()
        .map((d) => usagePoint(providerSummary(d) || {}, (d.date || '').slice(5), (d.date || '').slice(5)))
      rangeLabel = chartRange === 'month' ? '近 30 日' : '近 7 日'
    }
    const hasData = points.some((p) => (Number(p.usd) || 0) !== 0 || totalTokens(p) !== 0 || (Number(p.requests) || 0) !== 0)
    if (!points.length || (providerFilter && !hasData)) {
      modalContent.appendChild(emptyBox('暂无用量数据'))
      return
    }
    const labels = points.map((p) => p.date)
    const amount = points.map((p) => +((p.usd || 0) * rate).toFixed(2))
    const tokens = points.map((p) => totalTokens(p))
    const reqs = points.map((p) => Number(p.requests) || 0)
    const hit = points.map((p) => +hitRateOf(p).toFixed(1))

    // ── range totals: day / week / month summary above the chart ──
    const totalUsd = points.reduce((s, p) => s + (Number(p.usd) || 0), 0)
    const totalTok = points.reduce((s, p) => s + totalTokens(p), 0)
    const totalReq = points.reduce((s, p) => s + (Number(p.requests) || 0), 0)
    const totIn = points.reduce((s, p) => s + (Number(p.input) || 0), 0)
    const totCr = points.reduce((s, p) => s + (Number(p.cacheRead) || 0), 0)
    const totalHit = totIn + totCr > 0 ? (totCr / (totIn + totCr)) * 100 : 0

    const scopeLabel = providerFilter ? '（' + providerFilter + '）' : ''
    modalContent.appendChild(chartTitle(rangeLabel + scopeLabel + '合计'))
    const statsRow = document.createElement('div')
    statsRow.style.cssText = 'display:flex;gap:10px;margin:0 0 4px;'
    const mkStat = (label, value) => {
      const box = document.createElement('div')
      box.style.cssText =
        'flex:1;padding:10px 12px;border-radius:10px;background:#f6f8fa;border:1px solid #eef0f3;'
      const v = document.createElement('div')
      v.textContent = value
      v.style.cssText =
        'font-size:17px;font-weight:700;color:#1f2328;font-variant-numeric:tabular-nums;white-space:nowrap;'
      const l = document.createElement('div')
      l.textContent = label
      l.style.cssText = 'margin-top:2px;font-size:11px;color:#57606a;'
      box.appendChild(v)
      box.appendChild(l)
      return box
    }
    statsRow.appendChild(mkStat('总金额（¥）', fmtMoney(totalUsd, rate)))
    statsRow.appendChild(mkStat('总 token', fmtTokens(totalTok)))
    statsRow.appendChild(mkStat('总请求数', fmtTokens(totalReq)))
    statsRow.appendChild(mkStat('缓存命中率', totalHit.toFixed(1) + '%'))
    modalContent.appendChild(statsRow)

    modalContent.appendChild(chartTitle(rangeLabel + scopeLabel + ' 用量概览（金额 / token / 请求数 / 缓存命中率）'))
    const wrap = document.createElement('div')
    wrap.style.cssText = 'position:relative;width:100%;height:300px;'
    const canvas = document.createElement('canvas')
    wrap.appendChild(canvas)
    modalContent.appendChild(wrap)

    if (chartInstance) {
      chartInstance.destroy()
      chartInstance = null
    }
    const ctx = canvas.getContext('2d')
    if (!ctx || typeof Chart === 'undefined') {
      modalContent.appendChild(emptyBox('图表库未加载'))
      return
    }
    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: '金额（¥）',
            data: amount,
            yAxisID: 'y',
            borderColor: '#1f6feb',
            backgroundColor: 'rgba(31,111,235,0.10)',
            fill: true,
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#1f6feb',
            pointBorderWidth: 2,
          },
          {
            label: 'token 总量',
            data: tokens,
            yAxisID: 'y1',
            borderColor: '#2da44e',
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#2da44e',
            pointBorderWidth: 2,
          },
          {
            label: '请求数',
            data: reqs,
            yAxisID: 'y3',
            borderColor: '#8250df',
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 2,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#8250df',
            pointBorderWidth: 2,
          },
          {
            label: '缓存命中率（%）',
            data: hit,
            yAxisID: 'y2',
            borderColor: '#e8930c',
            borderDash: [5, 3],
            tension: 0.35,
            borderWidth: 2,
            pointRadius: 3,
            pointBackgroundColor: '#ffffff',
            pointBorderColor: '#e8930c',
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, color: '#57606a' } },
          tooltip: {
            callbacks: {
              title: (items) =>
                items.length
                  ? points[items[0].dataIndex]?.title || points[items[0].dataIndex]?.date || ''
                  : '',
              label: (c) => {
                if (c.datasetIndex === 0) return '金额：¥' + c.parsed.y
                if (c.datasetIndex === 1) return 'token：' + fmtTokens(c.parsed.y)
                if (c.datasetIndex === 2) return '请求数：' + c.parsed.y
                return '命中率：' + c.parsed.y + '%'
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { maxRotation: 45, autoSkip: true, maxTicksLimit: 12, font: { size: 10 }, color: '#8b949e' },
          },
          y: {
            type: 'linear',
            position: 'left',
            ticks: { display: false },
            title: { display: false },
          },
          y1: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { display: false },
            title: { display: false },
          },
          y2: {
            type: 'linear',
            position: 'right',
            min: 0,
            max: 100,
            grid: { drawOnChartArea: false },
            ticks: { display: false },
            title: { display: false },
          },
          y3: {
            type: 'linear',
            position: 'right',
            grid: { drawOnChartArea: false },
            ticks: { display: false },
            title: { display: false },
          },
        },
      },
    })
  }

  function renderForm(body, status) {
    body.innerHTML = ''

    // ── exchange rate + refresh interval (one row) ──
    const topRow = document.createElement('div')
    topRow.style.cssText = 'display:flex;gap:12px;align-items:flex-end;'
    const rateCol = document.createElement('div')
    rateCol.style.cssText = 'flex:1;'
    rateCol.appendChild(label('汇率 USD→CNY'))
    const rateEl = numberInput(blank.exchangeRate)
    rateCol.appendChild(rateEl)
    const pollCol = document.createElement('div')
    pollCol.style.cssText = 'flex:1;'
    pollCol.appendChild(label('刷新间隔'))
    const POLL_OPTS = [
      [1000, '1 秒'],
      [3000, '3 秒'],
      [5000, '5 秒'],
      [10000, '10 秒'],
      [30000, '30 秒'],
      [60000, '1 分钟'],
      [180000, '3 分钟'],
      [300000, '5 分钟'],
      [600000, '10 分钟'],
    ]
    const pollSel = document.createElement('select')
    const curPoll = Number(blank.pollMs) || 3000
    for (const [ms, lab] of POLL_OPTS) {
      const opt = document.createElement('option')
      opt.value = String(ms)
      opt.textContent = lab
      if (ms === curPoll) opt.selected = true
      pollSel.appendChild(opt)
    }
    pollSel.style.cssText = INPUT_STYLE + 'width:100%;cursor:pointer;'
    focusableInput(pollSel)
    pollCol.appendChild(pollSel)
    topRow.appendChild(rateCol)
    topRow.appendChild(pollCol)
    body.appendChild(topRow)

    // ── editable rows (default row + one row per model override) ──
    const defTou = blank.timeOfUse || {}
    const defDays = normDays(defTou.days)
    const rows = [
      {
        isDefault: true,
        model: '默认',
        input: blank.default?.inputPerMillion,
        output: blank.default?.outputPerMillion,
        cacheRead: blank.default?.cacheReadPerMillion,
        cacheWrite: blank.default?.cacheWritePerMillion,
        mult: blank.multiplier ?? 1,
        peakRanges: Array.isArray(defTou.peakRanges) ? defTou.peakRanges.map((r) => r.join('-')).join(', ') : '',
        peakMultiplier: defTou.peakMultiplier,
        days: defDays,
        customDays: Array.isArray(defDays) ? defDays.slice() : null,
      },
    ]
    for (const [key, v] of Object.entries(blank.overrides || {})) {
      // Keep the complete override key so provider-qualified and wildcard rows
      // survive a read-edit-save round trip without being merged by model name.
      const overrideKey = key
      const model = key.includes('|') ? key.slice(key.lastIndexOf('|') + 1) : key
      const tou = v.timeOfUse || {}
      const nd = normDays(tou.days)
      const row = {
        isDefault: false,
        key: overrideKey,
        model,
        input: v.inputPerMillion,
        output: v.outputPerMillion,
        cacheRead: v.cacheReadPerMillion,
        cacheWrite: v.cacheWritePerMillion,
        mult: v.multiplier,
        peakRanges: Array.isArray(tou.peakRanges) ? tou.peakRanges.map((r) => r.join('-')).join(', ') : '',
        peakMultiplier: tou.peakMultiplier,
        days: nd,
        customDays: Array.isArray(nd) ? nd.slice() : null,
      }
      rows.push(row)
    }

    // ── table ──
    body.appendChild(label('单价维护（US$ / 百万 token；模型名不区分供应商，如 deepseek-v4-flash；峰时时间留空=不启用；峰时日期默认每天，可选工作日/周末/自定义）', '#e6edf3'))
    const wrap = document.createElement('div')
    wrap.style.cssText = 'overflow-x:auto;'
    const table = document.createElement('table')
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:12px;'
    const thead = document.createElement('thead')
    const trh = document.createElement('tr')
    for (const h of ['模型', '输入', '输出', '缓存读取', '缓存写入', '模型倍率', '峰时时间', '峰时日期', '峰时倍率', '']) {
      const th = document.createElement('th')
      th.textContent = h
      th.style.cssText = 'padding:4px 6px;text-align:left;color:#57606a;font-weight:600;border-bottom:1px solid #d0d7de;white-space:nowrap;'
      trh.appendChild(th)
    }
    thead.appendChild(trh)
    table.appendChild(thead)
    const tbody = document.createElement('tbody')
    table.appendChild(tbody)
    wrap.appendChild(table)
    body.appendChild(wrap)

    const cellInput = (value, width) => {
      const inp = numberInput(value)
      inp.style.cssText = INPUT_STYLE + 'padding:3px 6px;font-size:12px;width:' + width + ';'
      return inp
    }
    const textInput = (value, width) => {
      const inp = document.createElement('input')
      inp.value = value ?? ''
      inp.style.cssText = INPUT_STYLE + 'padding:3px 6px;font-size:12px;width:' + width + ';'
      return focusableInput(inp)
    }

    function rerender() {
      tbody.innerHTML = ''
      rows.forEach((r, idx) => {
        const tr = document.createElement('tr')
        tr.style.cssText = 'border-bottom:1px solid #eef0f3;'
        // model column
        const tdM = document.createElement('td')
        if (r.isDefault) {
          const span = document.createElement('span')
          span.textContent = r.model
          span.style.cssText = 'font-weight:700;color:#1f2328;padding:3px 6px;'
          tdM.appendChild(span)
        } else {
          const inp = textInput(r.key ?? r.model, '150px')
          inp.placeholder = '模型名或 provider|模型名'
          inp.oninput = () => {
            r.key = inp.value
            r.model = inp.value
          }
          tdM.appendChild(inp)
        }
        // price columns
        const mk = (key) => {
          const td = document.createElement('td')
          const inp = cellInput(r[key], '72px')
          inp.oninput = () => {
            r[key] = inp.value
          }
          td.appendChild(inp)
          return td
        }
        // model multiplier column (applies to the whole model cost)
        const tdMult = document.createElement('td')
        const multInp = cellInput(r.mult, '56px')
        multInp.oninput = () => {
          r.mult = multInp.value
        }
        tdMult.appendChild(multInp)
        // peak/valley columns
        const tdR = document.createElement('td')
        const rangesInp = textInput(r.peakRanges, '130px')
        rangesInp.oninput = () => {
          r.peakRanges = rangesInp.value
        }
        tdR.appendChild(rangesInp)
        // peak-hour dates column: 每天 / 工作日 / 周末 / 自定义 (select + chips)
        const tdDays = document.createElement('td')
        const daysSel = document.createElement('select')
        const DAY_OPTS = [
          ['all', '每天'],
          ['weekday', '工作日'],
          ['weekend', '周末'],
          ['custom', '自定义'],
        ]
        const selVal = Array.isArray(r.days) ? 'custom' : String(r.days || 'all')
        for (const [v, lab] of DAY_OPTS) {
          const o = document.createElement('option')
          o.value = v
          o.textContent = lab
          if (v === selVal) o.selected = true
          daysSel.appendChild(o)
        }
        daysSel.style.cssText = INPUT_STYLE + 'padding:3px 6px;font-size:12px;width:104px;cursor:pointer;'
        focusableInput(daysSel)
        const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
        let chipsRow = null
        function rebuildChips() {
          if (chipsRow) chipsRow.remove()
          chipsRow = null
          if (daysSel.value !== 'custom') return
          if (!Array.isArray(r.days) || !r.days.length) r.days = [1, 2, 3, 4, 5]
          chipsRow = document.createElement('div')
          chipsRow.style.cssText = 'display:flex;gap:2px;margin-top:3px;'
          for (let wd = 1; wd <= 7; wd++) {
            const on = r.days.indexOf(wd) >= 0
            const chip = document.createElement('button')
            chip.type = 'button'
            chip.textContent = WEEKDAY_NAMES[wd - 1]
            chip.title = '选择' + WEEKDAY_NAMES[wd - 1]
            chip.style.cssText =
              'flex:1;padding:2px 0;border-radius:5px;border:1px solid ' + (on ? '#2563eb' : '#d0d7de') + ';' +
              'font-size:10px;cursor:pointer;font-family:inherit;' +
              (on ? 'background:#2563eb;color:#fff;' : 'background:#f6f8fa;color:#57606a;')
            chip.onclick = () => {
              const i = r.days.indexOf(wd)
              if (i >= 0) r.days.splice(i, 1)
              else {
                r.days.push(wd)
                r.days.sort((a, b) => a - b)
              }
              rebuildChips()
            }
            chipsRow.appendChild(chip)
          }
          tdDays.appendChild(chipsRow)
        }
        daysSel.onchange = () => {
          if (daysSel.value === 'custom') {
            if (!Array.isArray(r.days)) r.days = Array.isArray(r.customDays) && r.customDays.length ? r.customDays.slice() : [1, 2, 3, 4, 5]
          } else {
            if (Array.isArray(r.days)) r.customDays = r.days.slice()
            r.days = daysSel.value
          }
          rebuildChips()
        }
        tdDays.appendChild(daysSel)
        rebuildChips()
        const tdP = document.createElement('td')
        const peakInp = cellInput(r.peakMultiplier, '56px')
        peakInp.oninput = () => {
          r.peakMultiplier = peakInp.value
        }
        tdP.appendChild(peakInp)
        // delete column
        const tdD = document.createElement('td')
        if (!r.isDefault) {
          const del = document.createElement('button')
          del.textContent = '✕'
          del.title = '删除该模型'
          del.style.cssText = 'padding:2px 7px;border-radius:6px;border:1px solid #d0d7de;background:#f6f8fa;color:#cf222e;cursor:pointer;font-size:12px;'
          del.onclick = () => {
            rows.splice(idx, 1)
            rerender()
          }
          tdD.appendChild(del)
        }
        tr.appendChild(tdM)
        tr.appendChild(mk('input'))
        tr.appendChild(mk('output'))
        tr.appendChild(mk('cacheRead'))
        tr.appendChild(mk('cacheWrite'))
        tr.appendChild(tdMult)
        tr.appendChild(tdR)
        tr.appendChild(tdDays)
        tr.appendChild(tdP)
        tr.appendChild(tdD)
        tbody.appendChild(tr)
      })
    }
    rerender()

    // add a model row
    const addBtn = makeButton('＋ 添加模型', 'secondary')
    addBtn.style.cssText += 'margin-top:8px;padding:5px 14px;font-size:12px;'
    addBtn.onclick = () => {
      rows.push({ isDefault: false, key: '', model: '', input: '', output: '', cacheRead: '', cacheWrite: '', mult: '', peakRanges: '', peakMultiplier: '', days: 'all', customDays: null })
      rerender()
    }
    body.appendChild(addBtn)

    function parseRanges(text) {
      const out = []
      for (const part of String(text || '').split(',')) {
        const m = /^\s*(\d{1,2})\s*[-~]\s*(\d{1,2})\s*$/.exec(part)
        if (m) {
          const s = +m[1]
          const e = +m[2]
          if (s >= 0 && s < 24 && e > 0 && e <= 24) out.push([s, e])
        }
      }
      return out
    }

    // Normalize a loaded `days` value for the form/display: number arrays as-is
    // (elements coerced to ints 1..7), weekday/workday variants → 'weekday',
    // 'weekend' → 'weekend', anything else (missing/unknown/empty) → 'all'.
    function normDays(days) {
      if (Array.isArray(days)) {
        const nums = days.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7)
        return nums.length ? nums : 'all'
      }
      if (typeof days === 'string') {
        const s = days.trim().toLowerCase()
        if (s === 'weekday' || s === 'workday') return 'weekday'
        if (s === 'weekend') return 'weekend'
      }
      return 'all'
    }

    // 峰时倍率: 留空/非法 → 1（原价）；显式填 0 或低于 1（如 0.5、负数）同样按 1 计——
    // 峰时是加价通道，倍率语义上不小于 1。
    function peakMult(v) {
      const n = parseFloat(v)
      return Number.isFinite(n) ? Math.max(1, n) : 1
    }

    // Days rule for save: "all" (default) | "weekday" | "weekend" | [1..7] (1=周一).
    function saveDays(days) {
      if (Array.isArray(days) && days.length) return days
      if (days === 'weekday' || days === 'weekend') return days
      return 'all'
    }

    return {
      save: () => {
        const num = (s) => {
          const v = parseFloat(s)
          return Number.isFinite(v) ? v : 0
        }
        // Reject duplicate override keys before writing anything: JSON object
        // keys would silently collapse to the last row, losing configuration.
        const seenKeys = new Set()
        const duplicateKeys = []
        for (const r of rows.slice(1)) {
          const k = String(r.key ?? r.model ?? '').trim()
          if (!k) continue
          if (seenKeys.has(k)) duplicateKeys.push(k)
          else seenKeys.add(k)
        }
        if (duplicateKeys.length) {
          status.textContent =
            '存在重复的模型键：' + [...new Set(duplicateKeys)].join('、') + '，请合并或改名后再保存'
          return
        }
        const defRow = rows[0]
        const def = {
          inputPerMillion: num(defRow.input),
          cacheReadPerMillion: num(defRow.cacheRead),
          cacheWritePerMillion: num(defRow.cacheWrite),
          outputPerMillion: num(defRow.output),
        }
        const overrides = {}
        for (const r of rows.slice(1)) {
          const key = String(r.key ?? r.model ?? '').trim()
          if (!key) continue
          const entry = {
            inputPerMillion: num(r.input),
            cacheReadPerMillion: num(r.cacheRead),
            cacheWritePerMillion: num(r.cacheWrite),
            outputPerMillion: num(r.output),
            multiplier: num(r.mult) || 1,
          }
          const ranges = parseRanges(r.peakRanges)
          if (ranges.length) {
            const tou = { enabled: true, peakMultiplier: peakMult(r.peakMultiplier), valleyMultiplier: 1, peakRanges: ranges }
            const days = saveDays(r.days)
            if (days !== 'all') tou.days = days
            entry.timeOfUse = tou
          }
          overrides[key] = entry
        }
        const obj = {
          exchangeRate: num(rateEl.value),
          default: def,
          overrides,
          pollMs: Number(pollSel.value),
          multiplier: num(defRow.mult) || 1,
        }
        const defRanges = parseRanges(defRow.peakRanges)
        if (defRanges.length) {
          const tou = { enabled: true, peakMultiplier: peakMult(defRow.peakMultiplier), valleyMultiplier: 1, peakRanges: defRanges }
          const days = saveDays(defRow.days)
          if (days !== 'all') tou.days = days
          obj.timeOfUse = tou
        }
        // Remember the just-saved config locally so reopening the dialog always
        // shows it, independent of the async read round-trip.
        lastPricingText = JSON.stringify(obj)
        lastStatusEl = status
        status.textContent = '保存中…'
        if (Tauri.event && Tauri.event.emit) {
          Tauri.event.emit('usage-pricing-save', obj).catch(() => {})
        } else {
          status.textContent = '事件通道不可用'
        }
      },
    }
  }

  // current pricing to seed the form (blank = empty fallback). The actual
  // defaults now live ONLY in the sidecar's DEFAULT_TEMPLATE, which is written
  // to usage-pricing.json on first run; this form always reads from the file.
  const defaultPricing = {
    exchangeRate: undefined,
    default: { inputPerMillion: undefined, cacheReadPerMillion: undefined, cacheWritePerMillion: undefined, outputPerMillion: undefined },
    overrides: {},
    timeOfUse: undefined,
    pollMs: undefined,
    multiplier: 1,
  }
  let blank = { ...defaultPricing, default: { ...defaultPricing.default } }
  let saveFn = null

  // pricing read/save over the event channel (command-invoke is not ACL-allowed
  // on the remote harness page).
  let lastPricingText = null
  let pendingPricingResolve = null
  let lastStatusEl = null

  // Read pricing from Rust, retrying a few times because the first round-trip
  // on a freshly loaded page can be slow/lost. Resolves with the latest known
  // text (or null) once a response arrives or retries are exhausted.
  function loadPricing() {
    return new Promise((resolve) => {
      if (!Tauri.event || !Tauri.event.emit) {
        resolve(lastPricingText)
        return
      }
      let attempts = 0
      const MAX = 8
      const tryOnce = () => {
        attempts++
        const timer = setTimeout(() => {
          pendingPricingResolve = null
          if (attempts < MAX) tryOnce()
          else resolve(lastPricingText)
        }, 800)
        pendingPricingResolve = (text) => {
          clearTimeout(timer)
          pendingPricingResolve = null
          resolve(text || lastPricingText)
        }
        Tauri.event.emit('usage-pricing-read').catch(() => {})
      }
      tryOnce()
    })
  }

  function parsePricing(text) {
    try {
      const p = JSON.parse(text)
      return {
        exchangeRate: p.exchangeRate,
        default: {
          inputPerMillion: p.default?.inputPerMillion,
          cacheReadPerMillion: p.default?.cacheReadPerMillion,
          cacheWritePerMillion: p.default?.cacheWritePerMillion,
          outputPerMillion: p.default?.outputPerMillion,
        },
        overrides: p.overrides || {},
        timeOfUse: p.timeOfUse,
        pollMs: p.pollMs,
        multiplier: p.multiplier ?? 1,
      }
    } catch {
      return { ...defaultPricing, default: { ...defaultPricing.default } }
    }
  }

  function openModal() {
    // Freeze the usage data at the moment the dialog opens. The sidecar keeps
    // running for the badge while closed, but its polling loop is paused until
    // this snapshot is dismissed.
    modalPayload = lastPayload
    try {
      Tauri.event.emit('usage-poll-pause').catch(() => {})
    } catch {}
    const m = buildModal()
    m.style.display = 'flex'
    selectTab('chart')
  }

  // Form tab: seed from the last known/saved config, then reconcile with the
  // on-disk file in the background (retrying until a response arrives).
  function renderFormTab() {
    const body = modalContent
    const status = modalStatus
    const render = () => {
      const r = renderForm(body, status)
      saveFn = r.save
      modalSaveBtn.onclick = () => saveFn && saveFn()
    }
    if (lastPricingText) {
      blank = parsePricing(lastPricingText)
      render()
      status.textContent = ''
    } else {
      status.textContent = '加载当前配置…'
    }
    loadPricing().then((text) => {
      if (!text || text === lastPricingText) return
      lastPricingText = text
      blank = parsePricing(text)
      render()
      status.textContent = ''
    })
  }

  function closeModal() {
    if (modal) modal.style.display = 'none'
    modalPayload = null
    try {
      Tauri.event.emit('usage-poll-resume').catch(() => {})
    } catch {}
  }

  // Navigation can discard the injected page without a click on the close
  // button. Make sure a paused sidecar is resumed for the next page/session.
  window.addEventListener('beforeunload', () => {
    if (!modalPayload) return
    try {
      Tauri.event.emit('usage-poll-resume').catch(() => {})
    } catch {}
  })

  panel.addEventListener('click', openModal)

  // ── events / mount ──────────────────────────────────────────────────────────
  function mount() {
    if (lastPayload) show()
  }

  if (Tauri.event) {
    Tauri.event
      .listen('dsh-usage', (e) => {
        try {
          const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload
          lastPayload = payload
          show()
        } catch {
          /* tolerate malformed payload */
        }
      })
      .catch(() => {})

    Tauri.event
      .listen('usage-pricing-data', (e) => {
        const text = typeof e.payload === 'string' ? e.payload : JSON.stringify(e.payload ?? {})
        lastPricingText = text
        if (pendingPricingResolve) {
          const r = pendingPricingResolve
          pendingPricingResolve = null
          try {
            r(text)
          } catch {
            /* noop */
          }
        }
      })
      .catch(() => {})

    Tauri.event
      .listen('usage-pricing-saved', (e) => {
        const ack = typeof e.payload === 'string' ? e.payload : ''
        if (lastStatusEl) {
          lastStatusEl.textContent = ack === 'ok' ? '已保存，3 秒内生效' : '保存失败：' + (ack || '无响应')
          if (ack === 'ok') setTimeout(closeModal, 900)
        }
      })
      .catch(() => {})
  }

  // Warm up: prefetch the pricing config shortly after load, so by the time the
  // user first clicks the panel, its config is already cached and the dialog
  // opens with data instead of a slow "加载当前配置…".
  setTimeout(() => {
    if (Tauri.event && Tauri.event.emit) {
      try {
        Tauri.event.emit('usage-pricing-read').catch(() => {})
      } catch {
        /* noop */
      }
    }
  }, 400)

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true })
  } else {
    mount()
  }
})()
