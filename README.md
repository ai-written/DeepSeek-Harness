# DeepSeek-Harness

极简 Tauri v2 桌面壳，把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI（`dsh web`）嵌进系统 WebView。壳本身不带任何业务功能。

**工作原理**：壳启动 `dsh --profile web --no-open --port 0` → 解析它打印的 URL → WebView 加载该地址 → 窗口关闭时清理整棵进程树。harness 本身零改动。

> 用量统计等业务能力由 DSH 插件提供（例如 [`dsh-usage-badge`](https://github.com/ai-written/dsh-usage-badge)），不放在壳里：壳只负责"把 dsh 的界面装进一个窗口"。

## 快速开始

前置要求：

- Rust 工具链（≥ 1.77）
- Node ≥ 22
- 全局安装 dsh：`npm i -g @deepseek-ai/dsh`（需为支持 `--no-open` 的新版，过低版本无法启动）
  - 壳只启动**全局安装**的那一个 dsh（没有版本管理器）。想换别的版本或自备构建，把 `DSH_BIN` 设成它的 `lib/bin.js` 绝对路径即可，不必动全局环境
- WebView2 Runtime（Win11 自带，Win10 需安装）

```bash
npm install
npm run dev      # 开发运行
npm run build    # 打包 release
```

## 特性

- **即开即见**：窗口先显示带进度提示的占位页，dsh 就绪后自动切换到实际界面，冷启动不"黑屏"
- **不会退回启动页**：进入实际界面后，一切**回启动页**的历史导航都被拒绝——鼠标侧键（后退 / 前进）、`Alt+←/→`、`Backspace` 都算在内（日志记 `navigation to the startup page refused`），窗口始终停在 dsh 界面上
- **共享配置**：不注入 DSH_HOME，桌面版与 CLI 共用同一套配置/会话/插件（`~/.dsh`）
- **无边框窗口**：自定义标题栏（最小化 / 最大化 / 关闭），支持拖拽与双击最大化
- **无控制台闪窗**：直接 spawn `node.exe`，不弹 cmd 窗口
- **不弹系统浏览器**：以 `--no-open` 启动 dsh，界面只出现在窗口内
- **启动失败可自救**：dsh 起不来时启动页给出「重试启动 / 打开日志」两个按钮，即使界面加载不出来也能重试或看原因
- **插件加载失败可诊断**：界面客户端插件 bundle 加载失败时（典型表现是页面报「Failed to load plugins」），底部弹一条提示并写明要删除的 WebView2 缓存目录（带「打开日志」按钮），启动日志同时记一行 `WEBVIEW BROKEN — …`。**不会**自动删库、也**不会**自动重启，删目录由你决定
- **启动日志**：所有关键步骤与 dsh 的 stderr 写入 `%LOCALAPPDATA%\deepseek-harness\startup.log`（不可写时回退 TEMP，再回退 exe 所在目录），"双击没反应"可从这里排查
- **干净退出**：关闭窗口即杀掉 dsh 整棵进程树，无残留

## 开发注意

> ⚠️ 不要与正在运行的正式实例同时启动 dev：两个实例并发读写同一 session 文件（`~/.dsh/sessions/...`）会触发 zstd 日志损坏崩溃。测试前先退出正式实例，或用 `$env:DSH_HOME = "<临时目录>"` 隔离。

排障用的位置：

- 启动日志：`%LOCALAPPDATA%\deepseek-harness\startup.log`（每次启动重写，日志里也记着它自己的实际路径）。日志里那行 `dsh bin.js -> … (version x.y.z)` 就是本次实际启动的 dsh
- WebView2 缓存目录：`%LOCALAPPDATA%\com.deepseekharness.desktop\deepseek-harness-webview`（dev 构建为 `deepseek-harness-dev`）。页面报「Failed to load plugins」这类缓存导致的怪问题时，退出应用后删掉它再启动即可；路径同样记在启动日志里
- **历史会话打不开**：界面报 `contains event type "…" unknown to this harness and not marked ignorable`（「拒绝解释日志」）时，是**读日志的 dsh 比写日志的那台旧了**，不是日志损坏。壳启动的就是全局安装的那个 dsh，所以把它更新到不低于写日志那台 harness（`npm i -g @deepseek-ai/dsh@latest`），或用 `DSH_BIN` 指向较新的 `lib/bin.js`，重启应用即可

> 这个目录**不会被壳自动清理**。检测到客户端插件 bundle 加载失败时，壳只做两件事：页面底部弹提示（写明要删的目录 + 「打开日志」按钮）、启动日志记一行 `WEBVIEW BROKEN — …` 并注明该删哪个目录；退出、删目录、重启都由你来做。删掉后 WebView2 会重新建立 profile，代价是下次启动稍慢。

`npm run dev` 期间可以用 `--close-test` 验证清理路径（启动后 6 秒自动关窗，走正常关闭流程）：

```bash
cd src-tauri && cargo run -- --close-test      # 直接跑壳
npm run tauri dev -- -- -- --close-test        # 或走 tauri CLI（第二个 -- 之后的参数给应用）
```

## 打包发布

```bash
npm run build
```

产物（`src-tauri/target/release/` 下）：

| 产物 | 说明 |
|---|---|
| `deepseek-harness.exe` | 免安装版，单文件双击即用（不含卸载器）；CI 发布为 `DeepSeek-Harness_<version>_x64-portable.exe` |
| `bundle/nsis/DeepSeek-Harness_<version>_x64-setup.exe` | NSIS 安装包（含卸载器） |
| `bundle/msi/DeepSeek-Harness_<version>_x64_en-US.msi` | MSI 安装包（含卸载器） |

> 版本号以 `package.json` 为准，`npm run build` 会先经 `scripts/sync-version.mjs` 同步到 `src-tauri/tauri.conf.json` 与 `Cargo.toml`。

> **免安装版首次运行**：浏览器下载的 exe 带"来自互联网"标记，SmartScreen 可能静默拦截双击。右键 exe → 属性 → 勾选**解除锁定**（或 `Unblock-File`）。彻底解决需代码签名。
>
> 目标机器需 Node ≥ 22 + 全局 `@deepseek-ai/dsh`；安装包本身**不含 dsh**。

## 目录结构

```
src-tauri/
├── src/main.rs        # 壳：spawn dsh、解析 URL、启动进度事件、进程清理
├── window-controls.js # 自定义标题栏 + 启动进度/失败自救（注入页面）
└── tauri.conf.json    # Tauri 配置
src/index.html         # 启动占位页（dsh 就绪前的窗口内容）
.github/workflows/release.yml  # 推送 v* tag 自动构建并发布 GitHub Release
```
