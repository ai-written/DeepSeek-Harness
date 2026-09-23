//! DeepSeek-Harness — a minimal Tauri v2 desktop shell around the DeepSeek
//! Harness web UI.
//!
//! The shell does four things:
//!   1. spawn the external `dsh --profile web --no-open --port 0` harness
//!   2. parse the printed `dsh web: http://127.0.0.1:<port>` ready line
//!   3. point the WebView at that loopback URL (same-origin, passes the
//!      harness /api trust fence unchanged), showing a placeholder page with
//!      live startup progress until then
//!   4. kill the whole child process tree when the window closes
//!
//! Nothing else. Usage statistics are deliberately NOT a shell feature: they
//! ship as a DSH plugin (`dsh-usage-badge`), and update checks / dsh version
//! management are left to the CLI.
//!
//! `dsh` is NOT bundled: the target machine needs Node >= 22 and a global
//! `@deepseek-ai/dsh`. DSH_HOME is not injected — dsh resolves its own home
//! (`$DSH_HOME` or `~/.dsh`), so the desktop app shares config/sessions/plugins
//! with the CLI.

// Build as a GUI (windows) subsystem, NOT a console subsystem: without this,
// the exe flashes a console window (titled with the exe path) on launch.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;
use tauri::{Emitter, Listener, Manager, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Parse the ready line `dsh web: http://127.0.0.1:<port>`.
const URL_LINE_RE: &str = "dsh web: http://127.0.0.1:";

/// How many recent dsh stdout/stderr lines to keep; dumped to the log if the
/// ready URL never appears within the timeout.
const TAIL_LINES: usize = 25;

/// How long dsh gets to print its ready line before the launch is failed.
const STARTUP_TIMEOUT_SECS: u64 = 120;

/// Suppress the console window a console child would otherwise create: a
/// GUI-subsystem parent has no console to hand down, so any console child gets
/// a brand-new console window unless this flag is set.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// ── Startup log ──────────────────────────────────────────────────────────────
// The shell is a GUI (windows-subsystem) app: eprintln goes nowhere a user can
// see. Mirror every notable step to %LOCALAPPDATA%\deepseek-harness\startup.log
// (truncated on each launch, so it always describes the latest run) to make
// "double-click and nothing happens" diagnosable. If %LOCALAPPDATA% is not
// writable (policy/sandbox), fall back to TEMP, then to the exe's directory.
// Logging failures are swallowed — the log must never break the app.
static START: OnceLock<Instant> = OnceLock::new();
static LOG: OnceLock<Mutex<Option<std::fs::File>>> = OnceLock::new();

fn log_path() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("deepseek-harness").join("startup.log")
}

fn init_log() {
    let _ = START.set(Instant::now());
    let (file, used) = open_log();
    let _ = LOG.set(Mutex::new(file));
    log_line("=== DeepSeek-Harness startup ===");
    match &used {
        Some(p) => log_line(&format!("log file -> {}", p.display())),
        None => log_line("WARNING: no writable location for the startup log; only console output remains"),
    }
    // Environment context that decides how dsh is located, so a misconfigured
    // machine is diagnosable from the log alone.
    for key in ["DSH_HOME", "DSH_BIN", "LOCALAPPDATA", "NVM_HOME"] {
        match std::env::var(key) {
            Ok(v) => log_line(&format!("env {key}={v}")),
            Err(_) => log_line(&format!("env {key}=(unset)")),
        }
    }
    let path_dirs = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).count())
        .unwrap_or(0);
    log_line(&format!("PATH dirs: {path_dirs}"));
    log_line(&format!(
        "args: {}",
        std::env::args().skip(1).collect::<Vec<_>>().join(" ")
    ));
}

/// Try to open the startup log, falling back to progressively more permissive
/// locations (%LOCALAPPDATA% → TEMP → next to the exe) so the log survives
/// even when %LOCALAPPDATA% is locked down (corporate policy, redirected
/// profiles, sandboxes). Returns the opened file and the path that won.
fn open_log() -> (Option<std::fs::File>, Option<std::path::PathBuf>) {
    let mut candidates: Vec<std::path::PathBuf> = vec![log_path()];
    candidates.push(std::env::temp_dir().join("deepseek-harness").join("startup.log"));
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("startup.log"));
        }
    }
    for c in &candidates {
        if let Some(parent) = c.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        match std::fs::File::create(c) {
            Ok(f) => return (Some(f), Some(c.clone())),
            Err(_) => continue,
        }
    }
    (None, None)
}

fn log_line(msg: &str) {
    if let Some(m) = LOG.get() {
        if let Ok(mut guard) = m.lock() {
            if let Some(f) = guard.as_mut() {
                let elapsed = START.get().map(|s| s.elapsed().as_secs_f64()).unwrap_or(0.0);
                let _ = writeln!(f, "[t+{elapsed:6.2}s] {msg}");
            }
        }
    }
    eprintln!("[deepseek-harness] {msg}");
}

// ── Harness child ────────────────────────────────────────────────────────────

/// The running `dsh` child and the state the window lifetime depends on.
struct HarnessState {
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
    /// Set the moment the window is sent to the harness URL. The placeholder
    /// page is a legal destination only until then — a launch that never
    /// yields a URL does not reach this point, so the error page's 重试启动
    /// keeps working. Afterwards every navigation back to it — the mouse's
    /// back/forward button (XButton1/2), Alt+Left/Right, Backspace, or a stray
    /// script — is refused, so the user cannot be dropped back onto the
    /// startup page while dsh keeps running behind it. See the `on_navigation`
    /// handler on the main window.
    harness_reached: std::sync::atomic::AtomicBool,
}

/// Startup progress forwarded to the placeholder page (`dsh-startup` event).
/// The window is visible from the moment it opens, so a cold first launch
/// after boot shows live feedback instead of an empty/nonexistent window.
#[derive(serde::Serialize, Clone)]
struct StartupMsg {
    level: &'static str,
    /// Which startup stage the message belongs to; drives the step indicator
    /// on the placeholder page: "locate" | "wait" | "ready" | "error".
    stage: &'static str,
    message: String,
}

fn emit_startup(
    app: &tauri::AppHandle,
    level: &'static str,
    stage: &'static str,
    message: impl Into<String>,
) {
    let _ = app.emit("dsh-startup", StartupMsg {
        level,
        stage,
        message: message.into(),
    });
}

// ── WebView2 data directory ──────────────────────────────────────────────────

/// WebView2 data directory for this build family.
///
/// Dev builds get their own stable store so a dev instance never shares
/// WebView2 state with a running release instance. Release builds use one
/// stable store as well: dsh serves a brand-new origin on every launch (the
/// shell passes `--port 0`), so nothing in the store is reused across launches
/// — but keeping it means WebView2 does not re-initialize its whole profile
/// (and its component caches) on every launch. The path is logged at startup,
/// so a store that does go bad can be deleted by hand (see the README).
fn webview_data_dir() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let root = base.join("com.deepseekharness.desktop");
    root.join(if cfg!(debug_assertions) {
        "deepseek-harness-dev"
    } else {
        "deepseek-harness-webview"
    })
}

/// Ensure this launch's WebView2 data directory exists, falling back to TEMP
/// when %LOCALAPPDATA% is not writable (a failed webview data dir is fatal,
/// unlike a failed log).
fn prepare_webview_data_dir() -> std::path::PathBuf {
    let dir = webview_data_dir();
    if std::fs::create_dir_all(&dir).is_ok() {
        log_line(&format!("webview data dir -> {}", dir.display()));
        dir
    } else {
        let fallback = std::env::temp_dir().join(if cfg!(debug_assertions) {
            "deepseek-harness-dev-webview"
        } else {
            "deepseek-harness-webview-fallback"
        });
        let _ = std::fs::create_dir_all(&fallback);
        log_line(&format!(
            "webview data dir not writable, falling back to {}",
            fallback.display()
        ));
        fallback
    }
}

// ── Locating and spawning dsh ────────────────────────────────────────────────

/// Spawn `dsh --profile web --port 0` and return the child.
///
/// On Windows the global install's `dsh` shim is a `.cmd` that forwards to
/// `node.exe <install>/lib/bin.js`. Never spawn `cmd`/`where`/console tools:
/// a GUI parent with no console gets a fresh console window for any console
/// child. Instead resolve node.exe + bin.js from PATH manually and spawn
/// node.exe directly with CREATE_NO_WINDOW.
fn spawn_harness() -> std::io::Result<Child> {
    // dsh web opens the default browser by default; the shell serves the UI in
    // its own WebView instead. --no-open is passed unconditionally: the shell
    // documents a minimum dsh that understands the flag (an older dsh rejects
    // the unknown option and aborts, which surfaces as a startup error).
    let args = vec!["--profile", "web", "--no-open", "--port", "0"];
    #[cfg(target_os = "windows")]
    {
        // Locate dsh first (DSH_BIN override → dsh.cmd on PATH), then pick a
        // node.exe — preferring one next to the npm global install, falling
        // back to any node.exe on PATH. This also works on machines where
        // node.exe and the npm global prefix live in different directories
        // (nvm / custom npm prefixes), not just the sibling-layout install.
        let bin_js = match resolve_dsh_bin_js() {
            Ok(p) => {
                let version = p
                    .parent()
                    .and_then(|lib| lib.parent())
                    .map(|dsh| dsh.join("package.json"))
                    .as_deref()
                    .and_then(read_package_version);
                log_line(&format!(
                    "dsh bin.js -> {} (version {})",
                    p.display(),
                    version.as_deref().unwrap_or("unknown")
                ));
                p
            }
            Err(e) => {
                log_line(&format!("resolve_dsh_bin_js failed: {e}"));
                return Err(e);
            }
        };
        // <npm-dir>/node_modules/@deepseek-ai/dsh/lib/bin.js → <npm-dir>
        let npm_dir = npm_install_dir(&bin_js);
        let node = match locate_node(npm_dir.as_deref()) {
            Ok(n) => {
                log_line(&format!("node.exe -> {}", n.display()));
                n
            }
            Err(e) => {
                log_line(&format!("locate_node failed: {e}"));
                return Err(e);
            }
        };
        let mut cmd = Command::new(node);
        cmd.arg(&bin_js).args(&args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            // Pipe stderr instead of discarding it: read_ready_url forwards
            // every line into the startup log, so a node/dsh crash (missing
            // module, syntax error, …) shows up in the log instead of being
            // invisible.
            .stderr(Stdio::piped());
        let result = cmd.spawn();
        match &result {
            Ok(c) => log_line(&format!("spawned node.exe pid={}", c.id())),
            Err(e) => log_line(&format!("spawn node.exe failed: {e}")),
        }
        result
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("dsh");
        cmd.args(&args);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        let result = cmd.spawn();
        match &result {
            Ok(c) => log_line(&format!("spawned dsh pid={}", c.id())),
            Err(e) => log_line(&format!("spawn dsh failed: {e}")),
        }
        result
    }
}

/// The npm global install directory, derived from
/// `<npm-dir>/node_modules/@deepseek-ai/dsh/lib/bin.js`.
#[cfg(target_os = "windows")]
fn npm_install_dir(bin_js: &std::path::Path) -> Option<std::path::PathBuf> {
    bin_js
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

/// Find `node.exe` to run dsh with. Prefers a node.exe next to the npm global
/// install directory (i.e. where the dsh.cmd shim lives), then any node.exe on
/// PATH. Never spawns `where`/`cmd` (which would flash a console window).
#[cfg(target_os = "windows")]
fn locate_node(preferred_dir: Option<&std::path::Path>) -> std::io::Result<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| std::io::Error::other("PATH not set"))?;
    let dirs: Vec<_> = std::env::split_paths(&path_var).collect();
    log_line(&format!("locate_node: scanning {} PATH dirs", dirs.len()));
    if let Some(dir) = preferred_dir {
        let node = dir.join("node.exe");
        if node.exists() {
            log_line(&format!("node.exe -> {} (next to npm global install)", node.display()));
            return Ok(node);
        }
        log_line("node.exe not next to npm global install; scanning PATH");
    }
    for dir in &dirs {
        let node = dir.join("node.exe");
        if node.exists() {
            log_line(&format!("node.exe -> {} (from PATH)", node.display()));
            return Ok(node);
        }
    }
    Err(std::io::Error::other(
        "node.exe not found — install Node >= 22 and run `npm install -g @deepseek-ai/dsh`",
    ))
}

/// Locate the `dsh.cmd` shim on PATH. npm always places the shim in the same
/// directory as its node_modules, so the sibling `lib/bin.js` of the global
/// install resolves relative to the shim's directory — this works even when
/// node.exe and the npm global prefix are in different directories (nvm /
/// custom npm prefixes). [`resolve_dsh_bin_js`] builds on this.
#[cfg(target_os = "windows")]
fn locate_dsh_cmd() -> std::io::Result<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| std::io::Error::other("PATH not set"))?;
    for dir in std::env::split_paths(&path_var) {
        let shim = dir.join("dsh.cmd");
        if shim.exists() {
            log_line(&format!("dsh.cmd -> {}", shim.display()));
            return Ok(shim);
        }
    }
    Err(std::io::Error::other(
        "dsh.cmd not found on PATH — run `npm install -g @deepseek-ai/dsh`",
    ))
}

/// Resolve the `lib/bin.js` the shell should run with node.exe:
/// `$DSH_BIN` when it points at an existing file, otherwise the global npm
/// install behind the `dsh.cmd` shim on PATH.
#[cfg(target_os = "windows")]
fn resolve_dsh_bin_js() -> std::io::Result<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("DSH_BIN") {
        if !explicit.is_empty() {
            let p = std::path::PathBuf::from(&explicit);
            if p.exists() {
                log_line(&format!("dsh bin.js -> {} (from DSH_BIN)", p.display()));
                return Ok(p);
            }
            log_line(&format!(
                "DSH_BIN set but not found: {explicit}; falling back to the global install"
            ));
        }
    }
    let shim = locate_dsh_cmd()?;
    let dir = shim
        .parent()
        .ok_or_else(|| std::io::Error::other("dsh.cmd has no parent dir"))?;
    let bin_js = dir
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    if bin_js.exists() {
        Ok(bin_js)
    } else {
        Err(std::io::Error::other(format!(
            "dsh install not found at {} — run `npm install -g @deepseek-ai/dsh`",
            bin_js.display()
        )))
    }
}

/// The version recorded in a package's `package.json`, read as cheaply as
/// possible: only the first 4 KB are parsed, which covers `"version"` for any
/// npm-generated manifest. Returns None when the file is missing/unreadable.
#[cfg(target_os = "windows")]
fn read_package_version(pkg_json: &std::path::Path) -> Option<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(pkg_json).ok()?;
    let mut buf = vec![0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    let head = String::from_utf8_lossy(&buf);
    let rest = head.split("\"version\"").nth(1)?;
    let after_colon = rest.split(':').nth(1)?;
    let after_quote = after_colon.split('"').nth(1)?;
    let value = after_quote.trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

/// Blocking: read dsh's stdout until the ready line appears, return the URL.
/// Enforces a startup timeout so a wedged harness cannot hang the shell.
///
/// Diagnostics: if the child's stderr is piped (Windows), every line is
/// forwarded into the startup log as `[dsh stderr]`; and the last
/// [`TAIL_LINES`] output lines are dumped to the log if the timeout hits, so a
/// hung cold start is diagnosable from the log alone.
fn read_ready_url(child: &mut Child) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("no stdout on dsh child")?;
    let (tx, rx) = std::sync::mpsc::channel();
    let recent: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));

    // Forward dsh's stderr into the startup log (no-op when stderr was kept
    // inherited, i.e. POSIX builds).
    if let Some(stderr) = child.stderr.take() {
        let recent = recent.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_line(&format!("[dsh stderr] {line}"));
                let mut q = recent.lock().unwrap();
                if q.len() >= TAIL_LINES {
                    q.pop_front();
                }
                q.push_back(line);
            }
        });
    }

    let recent_for_stdout = recent.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    let _ = tx.send(Err(format!("reading dsh stdout: {e}")));
                    return;
                }
            };
            if let Some(pos) = line.find(URL_LINE_RE) {
                let url = line[pos + URL_LINE_RE.len()..].trim().to_string();
                log_line(&format!("ready line parsed: http://127.0.0.1:{url}"));
                let _ = tx.send(Ok(format!("http://127.0.0.1:{url}")));
                return;
            }
            let mut q = recent_for_stdout.lock().unwrap();
            if q.len() >= TAIL_LINES {
                q.pop_front();
            }
            q.push_back(line);
        }
        log_line("dsh stdout closed before ready line");
        let _ = tx.send(Err("dsh exited before printing its URL".into()));
    });
    rx.recv_timeout(std::time::Duration::from_secs(STARTUP_TIMEOUT_SECS))
        .map_err(|_| {
            log_line(&format!("timeout waiting for ready URL ({STARTUP_TIMEOUT_SECS}s)"));
            let tail = recent.lock().unwrap();
            log_line(&format!("--- last {TAIL_LINES} dsh output lines before timeout ---"));
            for l in tail.iter() {
                log_line(&format!("  {l}"));
            }
            format!("dsh 启动超时（{STARTUP_TIMEOUT_SECS}s）。请检查 DSH_HOME 下 web profile 的首次初始化是否卡住。")
        })?
}

/// Kill the harness process tree. On Windows this is a synchronous taskkill
/// /T /F (the tree may include cmd shims, ripgrep, shells); on POSIX signal
/// the process group.
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else {
        log_line("kill_tree: no pid recorded, nothing to kill");
        return;
    };
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        match cmd.status() {
            Ok(s) => log_line(&format!("taskkill /T /F pid={pid} -> {s}")),
            Err(e) => log_line(&format!("taskkill failed: {e}")),
        }
    } else {
        match Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
        {
            Ok(s) => log_line(&format!("kill -9 pid={pid} -> {s}")),
            Err(e) => log_line(&format!("kill failed: {e}")),
        }
    }
}

/// Show `path` in the system file manager: a directory is opened directly, a
/// file is revealed/selected inside its folder. Text artifacts (startup.log)
/// are additionally handed to their default handler, which is what 打开日志
/// asks for.
fn reveal_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        // A directory is opened directly; `/select` on a directory would select it
        // inside its PARENT, which is not what the caller means.
        let mut cmd = Command::new("explorer");
        if path.is_dir() {
            cmd.raw_arg(format!("\"{}\"", path.display()));
        } else {
            cmd.raw_arg(format!("/select,\"{}\"", path.display()));
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if let Err(e) = cmd.spawn() {
            log_line(&format!("explorer failed ({e}); opening the folder instead"));
            let fallback = if path.is_dir() {
                Some(path.to_path_buf())
            } else {
                path.parent().map(|p| p.to_path_buf())
            };
            if let Some(dir) = fallback {
                let _ = Command::new("explorer").arg(dir).spawn();
            }
        }
        // Text artifacts (startup.log) are meant to be READ: `start` hands them to
        // the default handler, which is what the user asked for by pressing 打开日志.
        if path.is_file()
            && path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "log" | "txt" | "json"))
        {
            let mut cmd = Command::new("cmd");
            cmd.args(["/C", "start", "", &path.display().to_string()]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            if let Err(e) = cmd.spawn() {
                log_line(&format!("could not open {} with its default handler: {e}", path.display()));
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
}

// ── Navigation policy ────────────────────────────────────────────────────────

fn is_placeholder_url(url: &tauri::Url) -> bool {
    url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || url.path().ends_with("/index.html")
}

/// Whether a navigation to `target` must be refused.
///
/// The startup page is a legal destination only while the harness UI has not
/// been reached yet (its own first load, and a reload after a failed launch).
/// Once the window has been sent to the harness URL, navigating back to it is
/// always a history traversal the user did not ask for — the mouse's back
/// button, Alt+Left, Backspace — so it is refused and the harness page stays
/// where it is.
fn refuses_navigation(harness_reached: bool, target: &tauri::Url) -> bool {
    harness_reached && is_placeholder_url(target)
}

/// Spawn dsh, wait for its URL and navigate the window — the whole launch, on
/// its own thread. Used for the initial start and for the error page's 重试启动.
///
/// `attempts` counts launches so a stale attempt (the first one timing out
/// while the user already retried) cannot overwrite the current state or
/// navigate the window after a newer attempt succeeded.
fn start_harness(
    app: &tauri::AppHandle,
    state: Arc<HarnessState>,
    attempts: Arc<std::sync::atomic::AtomicU64>,
) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let attempt = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        log_line(&format!("background thread started: spawning dsh (attempt {attempt})…"));
        emit_startup(&handle, "info", "locate", "正在定位 dsh 并启动（首次开机冷启动可能较慢）…");
        let result = (|| -> Result<String, String> {
            // A retry may run while the previous child is still alive (e.g. the
            // first attempt is stuck waiting for its ready line): never leave two
            // dsh trees on one DSH_HOME, which corrupts sessions.
            {
                let mut child_slot = state.child.lock().unwrap();
                if let Some(mut old) = child_slot.take() {
                    log_line("start_harness: killing the previous harness child before retrying");
                    let _ = old.kill();
                }
            }
            let previous_pid = *state.pid.lock().unwrap();
            if previous_pid.is_some() {
                kill_tree(previous_pid);
                *state.pid.lock().unwrap() = None;
            }

            let child = spawn_harness().map_err(|e| {
                let msg = format!(
                    "未找到 dsh：{e}。请先安装 Node >= 22 并全局安装：npm install -g @deepseek-ai/dsh \
                     （或设置 DSH_BIN 指向 dsh 的 lib/bin.js 绝对路径）"
                );
                log_line(&format!("spawn_harness failed: {msg}"));
                msg
            })?;
            let pid = child.id();
            *state.pid.lock().unwrap() = Some(pid);
            *state.child.lock().unwrap() = Some(child);
            log_line(&format!("child stored pid={pid}; waiting for ready URL"));
            emit_startup(&handle, "info", "wait", "dsh 已启动，等待服务就绪…");
            read_ready_url(state.child.lock().unwrap().as_mut().unwrap())
        })();

        let current = attempts.load(std::sync::atomic::Ordering::SeqCst) > attempt;
        if current {
            log_line(&format!(
                "start_harness: attempt {attempt} finished after a newer attempt started; ignoring its result"
            ));
            return;
        }

        match result {
            Ok(url) => {
                log_line(&format!("harness ready: {url}; navigating"));
                emit_startup(&handle, "info", "ready", "服务已就绪，正在加载界面…");
                // Flag this before the navigation is issued, so a back press
                // during the page load cannot win the race and land the window
                // back on the startup page.
                state
                    .harness_reached
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(window) = handle.get_webview_window("main") {
                    match window.navigate(url.parse().expect("loopback url")) {
                        Ok(()) => log_line("window.navigate() accepted"),
                        Err(e) => log_line(&format!("ERROR: window.navigate failed: {e}")),
                    }
                    let _ = window.show();
                    let _ = window.set_focus();
                    log_line("window navigated & shown");
                } else {
                    log_line("ERROR: main window not found");
                }
            }
            Err(msg) => {
                log_line(&format!("startup failed: {msg}"));
                // Keep the window open with the reason on the placeholder page
                // (styled as an error) instead of a silent exit — the page offers
                // 重试启动 / 打开日志, and the titlebar X still runs the cleanup path.
                kill_tree(*state.pid.lock().unwrap());
                emit_startup(&handle, "error", "error", format!("{msg}\n\n详细日志：{}", log_path().display()));
            }
        }
    });
}

fn main() {
    init_log();
    log_line("main() entered");
    let close_test = std::env::args().any(|a| a == "--close-test");
    log_line(&format!("close-test mode: {close_test}"));

    // WebView2 data directory for this launch. It has to exist before the
    // window is built (WebView2 initializes its environment on it), and the
    // path is handed to the injected script so that a client-plugin bundle
    // load failure can name the directory the user has to delete — the shell
    // deliberately does NOT clear that store by itself any more (see README).
    let webview_dir = prepare_webview_data_dir();
    let webview_dir_js = serde_json::to_string(&webview_dir.display().to_string())
        .unwrap_or_else(|_| "\"\"".to_string());

    // Custom titlebar controls, injected into every page load (the placeholder
    // page and the harness page alike). The script is idempotent (it guards on
    // window.__deepseekHarnessControls) and doubles as the bridge that forwards
    // startup progress to the placeholder page and reports a failed
    // client-plugin bundle load.
    let controls_js = format!(
        "window.__deepseekHarnessWebviewDir = {webview_dir_js};\n{}",
        include_str!("../window-controls.js")
    );

    tauri::Builder::default()
        .setup(move |app| {
            let state = Arc::new(HarnessState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
                harness_reached: std::sync::atomic::AtomicBool::new(false),
            });
            app.manage(state.clone());

            // "打开日志" on the startup page: the page cannot open files, and
            // printing the path as text is the difference between reading the
            // reason for a failed start and giving up.
            app.handle().listen("dsh-open-startup-log", move |_e| {
                let path = log_path();
                log_line(&format!(
                    "startup log requested by the page -> {} (exists: {})",
                    path.display(),
                    path.exists()
                ));
                if path.exists() {
                    reveal_in_file_manager(&path);
                } else if let Some(dir) = path.parent() {
                    // No log at all (nowhere writable): at least show the folder.
                    reveal_in_file_manager(dir);
                }
            });

            // The injected script reports a client-plugin bundle that failed to
            // load — the signature of a bad WebView2 store. Nothing is cleared
            // and nothing is restarted automatically: the signal is recorded in
            // the startup log (next to the webview directory logged above) and
            // the page tells the user which directory to delete. Bounded so a
            // misbehaving page cannot flood the log.
            {
                let webview_dir_for_log = webview_dir.clone();
                app.handle().listen("dsh-webview-broken", move |event| {
                    let signal: String = event
                        .payload()
                        .chars()
                        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
                        .take(500)
                        .collect();
                    log_line(&format!(
                        "WEBVIEW BROKEN — client plugin bundle failed to load: {signal}"
                    ));
                    log_line(&format!(
                        "  no automatic recovery: quit the app, delete {} and start it again",
                        webview_dir_for_log.display()
                    ));
                });
            }

            // Create the main window in code so the custom titlebar controls
            // can be injected as an initialization script (runs on the
            // placeholder page AND after navigate to the harness URL).
            //
            // The window is visible right away: the placeholder page is shown
            // immediately. During a cold first launch after boot the dsh
            // spawn can take a while (cold file cache + Defender rescans), so
            // the user sees the "正在启动…" placeholder with live status
            // updates instead of nothing at all. Native decorations are off;
            // window-controls.js draws the caption bar.
            let mut window_builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("DeepSeek-Harness")
                    .inner_size(1280.0, 860.0)
                    .center()
                    .resizable(true)
                    .decorations(false)
                    .initialization_script(controls_js);
            // Refuse navigation back to the startup page once the harness UI
            // has been reached.
            //
            // WebView2 raises NavigationStarting for every navigation the user
            // can trigger — the mouse's back/forward buttons (XButton1/2),
            // Alt+Left/Right and Backspace included — and wry cancels the
            // navigation when this handler returns false. Without it, a single
            // press of the mouse back button walks the window's history one
            // entry back onto the placeholder page while dsh keeps running
            // behind it; the placeholder then looks like a fresh startup (its
            // step indicator resets, 重试启动 refuses because the harness page
            // is no longer current) and there is no way forward again. The
            // harness page itself is untouched: it is a loopback URL, and
            // in-app (pushState) history stays entirely inside the page.
            let nav_state = state.clone();
            window_builder = window_builder.on_navigation(move |url| {
                let reached = nav_state
                    .harness_reached
                    .load(std::sync::atomic::Ordering::SeqCst);
                if refuses_navigation(reached, url) {
                    log_line(&format!("navigation to the startup page refused: {url}"));
                    return false;
                }
                true
            });
            let window_builder = window_builder
                // Log every page load (placeholder page AND the harness URL) so
                // the log confirms the WebView actually reached the dsh UI —
                // if navigation fails, the harness URL never appears here.
                .on_page_load(move |_window, payload| {
                    let url = payload.url().to_string();
                    match payload.event() {
                        tauri::webview::PageLoadEvent::Started => {
                            log_line(&format!("page load started: {url}"));
                        }
                        tauri::webview::PageLoadEvent::Finished => {
                            log_line(&format!("page load finished: {url}"));
                        }
                    }
                });
            let window_builder = window_builder.data_directory(webview_dir);
            let _window = window_builder.build().expect("failed to build main window");

            if close_test {
                // After the harness is up, auto-close the window through the
                // normal Tauri path to exercise the cleanup handlers.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    log_line("close-test: closing window");
                    if let Some(w) = handle.get_webview_window("main") {
                        let _ = w.close();
                    }
                });
            }

            // Spawn the harness and wait for its URL on a background thread,
            // then navigate the main window to it. Every stage is forwarded to
            // the placeholder page as a `dsh-startup` event so the user sees
            // progress while the cold (post-boot) spawn chain runs.
            let harness_attempts = Arc::new(std::sync::atomic::AtomicU64::new(0));
            start_harness(&app.handle().clone(), state.clone(), harness_attempts.clone());

            // 重试启动 from the placeholder page: relaunch dsh without restarting
            // the whole app. Only meaningful while the window is still on the
            // placeholder — once the harness page is up, a retry would navigate
            // away from a working UI, so it is refused.
            {
                let retry_app = app.handle().clone();
                let retry_state = state.clone();
                let retry_attempts = harness_attempts.clone();
                app.handle().listen("dsh-retry-start", move |_e| {
                    let on_placeholder = retry_app
                        .get_webview_window("main")
                        .and_then(|w| w.url().ok())
                        .map(|url| is_placeholder_url(&url))
                        .unwrap_or(false);
                    if !on_placeholder {
                        log_line("retry start ignored: the harness page is already loaded");
                        return;
                    }
                    log_line("retry start requested by the startup page");
                    start_harness(&retry_app, retry_state.clone(), retry_attempts.clone());
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            // When the window is asked to close (titlebar X, Alt+F4, taskbar
            // close), kill the harness tree and exit the app for real. The
            // WebView2 runtime can keep the process alive after the window
            // handle disappears, so rely on the request event, not Destroyed.
            if let WindowEvent::CloseRequested { .. } = event {
                log_line("CloseRequested fired");
                let state = window.state::<Arc<HarnessState>>();
                let pid = *state.pid.lock().unwrap();
                log_line(&format!("killing harness pid={pid:?}"));
                kill_tree(pid);
                window.app_handle().exit(0);
                log_line("exit requested");
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                log_line("RunEvent::ExitRequested");
                let state = app_handle.state::<Arc<HarnessState>>();
                let pid = *state.pid.lock().unwrap();
                kill_tree(pid);
            }
            if let tauri::RunEvent::Exit = event {
                log_line("RunEvent::Exit — app finished");
            }
        });
}

// ── Tests for the navigation policy ──────────────────────────────────────────
// Pure logic only (no Tauri state, no child processes): the shell may refuse a
// navigation back to its own startup page, and only after the harness UI was
// actually reached. Run with `cargo test`.
#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().expect("test url")
    }

    #[test]
    fn placeholder_urls_are_recognized() {
        assert!(is_placeholder_url(&url("tauri://localhost/index.html")));
        assert!(is_placeholder_url(&url("http://tauri.localhost/index.html")));
        assert!(is_placeholder_url(&url("https://example.com/index.html")));
        assert!(!is_placeholder_url(&url("http://127.0.0.1:34567/")));
    }

    #[test]
    fn startup_page_is_reachable_until_the_harness_is_up() {
        assert!(!refuses_navigation(false, &url("tauri://localhost/index.html")));
    }

    #[test]
    fn startup_page_is_refused_once_the_harness_is_up() {
        assert!(refuses_navigation(true, &url("tauri://localhost/index.html")));
        assert!(!refuses_navigation(true, &url("http://127.0.0.1:34567/chat")));
    }
}
