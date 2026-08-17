# DeepSeek-Harness

Tauri v2 桌面壳，把 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web UI（`dsh web`）嵌入系统 WebView 窗口。

架构一句话：**壳 spawn `dsh --profile web --port 0` → 解析它打印的 URL → WebView 加载 → 窗口关闭时杀进程树**。harness 本身不改一行代码。

## 快速开始

前置要求：

- **Rust 工具链**（rustc/cargo ≥ 1.77）
- **Node ≥ 22**（dsh 依赖 `node:sqlite`）
- **全局 `@deepseek-ai/dsh`**：`npm i -g @deepseek-ai/dsh`
- **WebView2 Runtime**（Win11 自带；Win10 需安装）

```bash
npm install          # 装 @tauri-apps/cli + sharp
npm run dev          # tauri dev，启动壳 + 外部 dsh
```

## 运行时行为

- **启动即见占位窗口**：窗口创建后立即显示（不再等 dsh 就绪才 show），占位页带 spinner + 实时进度（定位 dsh → 启动 → 等待服务 → 加载界面），开机冷启动慢时用户有明确反馈而非"黑屏干等"；
- **DSH_HOME 不注入**：dsh 用自己的官方解析链（`$DSH_HOME` → `~/.dsh`），桌面版与 CLI **共享同一套配置、会话、凭据和插件**；
- **原生目录选择器**：走 dsh 默认 Win32 文件夹对话框；
- **自定义标题栏**：系统标题栏隐藏（`decorations: false`），右上角注入 最小化/最大化/关闭 按钮，标题栏区域可拖拽（双击最大化）；
- **无控制台窗口**：直接 spawn `node.exe` + `bin.js`（`CREATE_NO_WINDOW`），不弹 cmd/PowerShell 窗口；
- **启动日志**：GUI 无控制台，eprintln 用户不可见——所有关键步骤（环境变量/PATH 扫描 → 定位 node → 找到 dsh bin.js → spawn → 等待 URL → 页面加载 → 关闭清理）同时写入 `%LOCALAPPDATA%\deepseek-harness\startup.log`（每次启动截断重写，带 t+相对时间戳）。dsh 子进程的 stderr 也会逐行转发进日志；启动超时时会把超时前最后 25 行输出一并 dump——"双击没反应"可直接看日志定位。`%LOCALAPPDATA%` 不可写（策略/沙箱）时自动回退 TEMP、再退到 exe 同目录，日志首行会打印实际路径；
- **关闭清理**：窗口关闭（X / Alt+F4）→ `CloseRequested` → `kill_tree`（Windows `taskkill /T /F` 杀整个进程树）→ 退出；已通过 `--close-test` 自动化验证，无进程残留；
- **dev/release WebView 隔离**：debug 构建使用独立 WebView2 数据目录（`%LOCALAPPDATA%\com.deepseekharness.desktop\deepseek-harness-dev`，不可写时回退 TEMP），dev 实例不会与正在运行的 release 实例共享 cookie/本地存储/WebView 状态（同 identifier 默认同目录会导致 dev 窗口加载 release 窗口的页面）。

## 开发注意（重要）

**不要与正在运行的正式实例同时启动 dev**：dsh 的会话持久化按工作目录索引（`~/.dsh/sessions/<项目路径>/...`），两个实例并发读写同一 session 文件会触发 `corrupt Zstandard session log` 崩溃。dev 测试前请先退出正式实例，或用独立 home 隔离：`$env:DSH_HOME = "<临时目录>"; npm run dev`（dsh 尊重 `$DSH_HOME`）。

## 打包发布

```bash
npm run build        # tauri build → release 产物
```

产物：

- 免安装版：`src-tauri/target/release/deepseek-harness.exe`（单文件，双击即用）；CI 发布时以 `DeepSeek-Harness_<version>_x64-portable.exe` 附加到 GitHub Release 资产

  > **免安装版首次运行**：从浏览器下载的 exe 带"来自互联网"标记（MOTW），无代码签名时 Windows SmartScreen 可能**静默拦截双击**（无进程、无窗口、无提示；命令行运行则正常）。解决：右键 exe → 属性 → 勾选 **解除锁定** → 确定，再双击；或 PowerShell 执行 `Unblock-File .\DeepSeek-Harness_*_x64-portable.exe`。每次下载新版本都需重复一次（信誉按文件哈希计算）。彻底解决需代码签名（见下文）。
- NSIS 安装包：`src-tauri/target/release/bundle/nsis/DeepSeek-Harness_0.1.0_x64-setup.exe`
- MSI 安装包：`src-tauri/target/release/bundle/msi/DeepSeek-Harness_0.1.0_x64_en-US.msi`

要点：

- **不打包 dsh**：安装包只有壳，目标机器需 Node ≥ 22 + 全局 dsh；
- 图标：`node scripts/make-ico.mjs` 从 `assets/favicon.svg`（官方 DSH logo）渲染黑色多尺寸 `icon.ico`；
- Windows 分发建议代码签名（SmartScreen）。

## 核心实现（src-tauri/src/main.rs）

| 职责 | 实现 |
|---|---|
| spawn dsh | Windows 定位 `dsh.cmd` shim → 直接 spawn `node.exe <install>/lib/bin.js`（CREATE_NO_WINDOW） |
| 解析 URL | 后台线程读 stdout，匹配 `dsh web: http://127.0.0.1:<port>`，120s 超时 |
| 加载页面 | `window.navigate(url)`，同源直连过 `/api` 信任栅栏 |
| 自定义标题栏 | `window-controls.js` 通过 `initialization_script` 注入（占位页与 harness 页都生效） |
| 关闭清理 | `on_window_event(CloseRequested)` → kill_tree → exit |
| 启动失败 | 占位页红字显示原因，窗口保持打开可读（标题栏 X 关闭仍走清理路径） |

## 验证记录

- `cargo check` 零警告；
- 启动 → dsh spawn → 监听新端口（不与既有 3080 宿主冲突）；
- 无边框窗口 + 自定义按钮运行正常；
- `--close-test` 自动关闭 → 应用退出 + dsh 进程树清理，全链路日志确认；
- 启动日志实测：日志含环境变量、PATH 扫描、spawn pid、dsh stderr 转发（崩溃堆栈逐行可见）、失败原因、taskkill 结果，全部带 t+ 时间戳；`%LOCALAPPDATA%` 不可写时回退 TEMP 验证通过。
