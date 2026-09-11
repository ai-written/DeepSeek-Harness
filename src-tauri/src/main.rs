//! DeepSeek-Harness — Tauri v2 desktop shell.
//!
//! The shell's responsibilities:
//!   1. spawn the external `dsh --profile web --port 0` harness
//!   2. parse the printed `dsh web: http://127.0.0.1:<port>` ready line
//!   3. point the WebView at that loopback URL (same-origin, passes the
//!      harness /api trust fence unchanged)
//!   4. kill the whole child process tree when the window closes.
//!
//! `dsh` is NOT bundled: the target machine needs Node >= 22 and a global
//! `@deepseek-ai/dsh` (same strategy as the Electron shell's strategy A).
//! DSH_HOME is not injected — dsh resolves its own home (`$DSH_HOME` or
//! `~/.dsh`), so the desktop app shares config/sessions/plugins with the CLI.

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

struct HarnessState {
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
}

/// The usage sidecar child (the badge's data source). Kept so it is killed on
/// close alongside the harness.
struct UsageState {
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
    paused: Mutex<bool>,
}

/// Startup progress forwarded to the placeholder page (`dsh-startup` event).
/// The window is now visible from the moment it opens, so a cold first launch
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

/// Spawn `dsh --profile web --port 0` and return the child.
///
/// On Windows the global install's `dsh` shim is a `.cmd` that forwards to
/// `node.exe <install>/lib/bin.js`. Never spawn `cmd`/`where`/console tools:
/// a GUI parent with no console gets a fresh console window for any console
/// child. Instead resolve node.exe + bin.js from PATH manually and spawn
/// node.exe directly with CREATE_NO_WINDOW.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Auto-reset loop guard: how many consecutive store resets the recovery path
/// may perform before it gives up and leaves the error visible.
const MAX_AUTO_RESETS: u32 = 2;
/// A store reset older than this many seconds no longer counts against the loop
/// guard, so a fresh failure much later starts with a new reset budget.
const RESET_WINDOW_SECS: u64 = 600;

/// WebView2 data directory for this build family.
///
/// Dev builds get their own stable store so a dev instance never shares
/// WebView2 state with a running release instance. Release builds use one
/// stable store as well: dsh serves a brand-new origin on every launch (the
/// shell passes `--port 0` and dsh appends a fresh session token), so nothing in
/// the store is reused across launches — but keeping it means WebView2 does not
/// re-initialize its whole profile (and its component caches) on every launch.
/// A store that does go bad — stale state that makes the harness page fail to
/// load its client-plugin bundles — is cleared on demand by the recovery path
/// (see [`request_webview_reset`]) instead of on every launch.
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

/// Recovery bookkeeping shared across launches (see [`request_webview_reset`]).
#[derive(serde::Serialize, serde::Deserialize, Default)]
struct WebviewRecovery {
    /// A reset was requested and has not run yet: the next launch clears the
    /// WebView2 store before creating the window.
    #[serde(default, rename = "pendingReset")]
    pending_reset: bool,
    /// Auto-resets already performed inside the current loop-guard window.
    #[serde(default)]
    attempts: u32,
    /// Unix seconds of the last auto-reset, for the loop-guard window.
    #[serde(default, rename = "lastReset")]
    last_reset: u64,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Path of the recovery bookkeeping file, next to the startup log.
fn webview_recovery_path() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    base.join("deepseek-harness").join("webview-recovery.json")
}

fn read_webview_recovery() -> WebviewRecovery {
    std::fs::read_to_string(webview_recovery_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_webview_recovery(state: &WebviewRecovery) -> std::io::Result<()> {
    let path = webview_recovery_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(state).unwrap_or_else(|_| "{}".into());
    std::fs::write(path, json)
}

/// Remove the legacy per-launch stores an earlier build created
/// (`deepseek-harness-webview-<millis>`), best-effort: the fixed store replaced
/// them, so they are dead weight (tens of MB each). The fixed store's own name
/// has no trailing dash and so never matches.
fn cleanup_legacy_webview_stores(root: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let legacy = path.is_dir()
            && path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("deepseek-harness-webview-"));
        if !legacy {
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => log_line(&format!("removed legacy per-launch WebView2 store -> {}", path.display())),
            Err(e) => log_line(&format!("could not remove legacy WebView2 store {} ({e})", path.display())),
        }
    }
}

/// Delete the WebView2 store directory, retrying: the relaunch starts while the
/// previous instance's WebView2 processes may still be releasing these files,
/// so the first attempts can hit a lock. Best-effort — if it never succeeds the
/// relaunch still proceeds (the window may just stay broken, and the loop guard
/// keeps that from repeating forever).
fn clear_webview_store(dir: &std::path::Path) {
    const ATTEMPTS: u32 = 8;
    for attempt in 1..=ATTEMPTS {
        match std::fs::remove_dir_all(dir) {
            Ok(()) => {
                log_line(&format!("webview recovery: cleared store -> {}", dir.display()));
                return;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                log_line(&format!("webview recovery: store already absent -> {}", dir.display()));
                return;
            }
            Err(e) => {
                if attempt == ATTEMPTS {
                    log_line(&format!(
                        "webview recovery: could not clear {} after {ATTEMPTS} attempts ({e})",
                        dir.display()
                    ));
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
        }
    }
}

/// Decide whether a detected webview failure should trigger the clear-and-
/// rebuild path, and record it for the next launch. Returns true when the
/// caller should relaunch the app. Bounded by [`MAX_AUTO_RESETS`] per
/// [`RESET_WINDOW_SECS`], so a failure the store cannot explain (an actually
/// incompatible dsh build) cannot turn into a restart loop.
fn request_webview_reset(signal: &str) -> bool {
    let mut state = read_webview_recovery();
    let now = unix_now();
    if now.saturating_sub(state.last_reset) > RESET_WINDOW_SECS {
        state.attempts = 0;
    }
    if state.attempts >= MAX_AUTO_RESETS {
        log_line(&format!(
            "webview recovery: giving up after {} resets within {RESET_WINDOW_SECS}s (signal: {signal}); \
             the WebView2 store does not explain this failure — delete it manually if the UI stays broken: {}",
            state.attempts,
            webview_data_dir().display()
        ));
        return false;
    }
    state.attempts += 1;
    state.last_reset = now;
    state.pending_reset = true;
    match write_webview_recovery(&state) {
        Ok(()) => {
            log_line(&format!(
                "webview recovery: reset #{} scheduled (signal: {signal})",
                state.attempts
            ));
            true
        }
        Err(e) => {
            log_line(&format!("webview recovery: could not record the reset request: {e}"));
            false
        }
    }
}

/// Ensure this launch's WebView2 data directory exists, falling back to TEMP
/// when %LOCALAPPDATA% is not writable (a failed webview data dir is fatal,
/// unlike a failed log). A reset requested by [`request_webview_reset`] is
/// carried out here: before the window is created, i.e. before WebView2
/// initializes its environment on this directory.
fn prepare_webview_data_dir() -> std::path::PathBuf {
    let dir = webview_data_dir();
    if let Some(root) = dir.parent() {
        cleanup_legacy_webview_stores(root);
    }
    let mut state = read_webview_recovery();
    if state.pending_reset {
        log_line(&format!(
            "webview recovery: clearing the store before startup -> {}",
            dir.display()
        ));
        clear_webview_store(&dir);
        state.pending_reset = false;
        if let Err(e) = write_webview_recovery(&state) {
            log_line(&format!("webview recovery: could not clear the pending flag: {e}"));
        }
    }
    if std::fs::create_dir_all(&dir).is_ok() {
        dir
    } else {
        let fallback = std::env::temp_dir().join(if cfg!(debug_assertions) {
            "deepseek-harness-dev-webview"
        } else {
            "deepseek-harness-webview-fallback"
        });
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    }
}

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
        let bin_js = match locate_dsh_bin_js() {
            Ok(b) => {
                log_line(&format!("dsh bin.js -> {}", b.display()));
                b
            }
            Err(e) => {
                log_line(&format!("locate_dsh_bin_js failed: {e}"));
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
/// directory as its node_modules, so `lib/bin.js` resolves relative to the
/// shim's directory — this works even when node.exe and the npm global prefix
/// are in different directories (nvm / custom npm prefixes).
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

/// Resolve dsh's `lib/bin.js`. Priority:
///   1. `$DSH_BIN` — explicit override (absolute path to bin.js)
///   2. the `dsh.cmd` shim on PATH → sibling `node_modules/@deepseek-ai/dsh/lib/bin.js`
#[cfg(target_os = "windows")]
fn locate_dsh_bin_js() -> std::io::Result<std::path::PathBuf> {
    if let Ok(explicit) = std::env::var("DSH_BIN") {
        let p = std::path::PathBuf::from(&explicit);
        if p.exists() {
            log_line(&format!("dsh bin.js -> {} (from DSH_BIN)", p.display()));
            return Ok(p);
        }
        log_line(&format!("DSH_BIN set but not found: {explicit}; falling back to dsh.cmd on PATH"));
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
    rx.recv_timeout(std::time::Duration::from_secs(120)).map_err(|_| {
        log_line("timeout waiting for ready URL (120s)");
        let tail = recent.lock().unwrap();
        log_line(&format!("--- last {TAIL_LINES} dsh output lines before timeout ---"));
        for l in tail.iter() {
            log_line(&format!("  {l}"));
        }
        "dsh 启动超时（120s）。请检查 DSH_HOME 下 web profile 的首次初始化是否卡住。".to_string()
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

// ── Daily-usage badge sidecar ───────────────────────────────────────────────
// A second node child folds the DSH session logs (~/.dsh/sessions) and prints
// one JSON line to stdout on start and every few seconds. main.rs forwards each
// line to the in-window usage panel as a `dsh-usage` event. It is optional:
// if the script or node cannot be resolved, the badge is simply unavailable and
// the harness still runs.

// Embedded copy of the sidecar script, used only as a last resort so the
// standalone portable exe (which ships with no resource files next to it) can
// still run the badge. The file IS the source of truth — keep this in sync
// with usage/usage-sidecar.mjs (it is included verbatim at compile time).
const USAGE_SIDECAR_SRC: &str = include_str!("../usage/usage-sidecar.mjs");

/// Resolve the usage sidecar script path: env override → dev cwd → exe dir →
/// packaged resource dir → embedded copy extracted to a writable per-user
/// location. Strips the Windows `\\?\` extended-length prefix (Tauri's
/// resource_dir may return one, which Node's module loader mishandles as
/// EISDIR).
fn usage_sidecar_path(app: &tauri::AppHandle) -> std::path::PathBuf {
    let probe = |label: &str, p: std::path::PathBuf| -> Option<std::path::PathBuf> {
        let p = strip_extended_prefix(p);
        if p.exists() {
            log_line(&format!("usage sidecar ({label}) -> {}", p.display()));
            Some(p)
        } else {
            None
        }
    };
    if let Ok(p) = std::env::var("DSH_USAGE_SIDECAR") {
        if let Some(p) = probe("DSH_USAGE_SIDECAR", std::path::PathBuf::from(p)) {
            return p;
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(p) = probe("dev cwd", cwd.join("src-tauri").join("usage").join("usage-sidecar.mjs")) {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            if let Some(p) = probe("exe dir", dir.join("usage").join("usage-sidecar.mjs")) {
                return p;
            }
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        if let Some(p) = probe("resource dir", dir.join("usage").join("usage-sidecar.mjs")) {
            return p;
        }
    }
    // No external copy: fall back to the embedded script so the standalone
    // portable exe keeps the badge. Extraction failure is swallowed — the
    // badge is optional, the harness always runs.
    match extract_embedded_sidecar() {
        Some(p) => p,
        None => {
            log_line("WARNING: could not resolve usage sidecar script and could not extract the embedded copy; usage badge disabled");
            std::path::PathBuf::from("usage-sidecar.mjs")
        }
    }
}

/// Write the embedded sidecar script to `%LOCALAPPDATA%\deepseek-harness\`
/// (fallback: `TEMP\deepseek-harness\`) and return the absolute path. Always
/// overwrites, so a newer exe refreshes an older extracted copy. Returns None
/// only when every candidate location is unwritable.
fn extract_embedded_sidecar() -> Option<std::path::PathBuf> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Some(base) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(
            std::path::PathBuf::from(base)
                .join("deepseek-harness")
                .join("usage-sidecar.mjs"),
        );
    }
    candidates.push(
        std::env::temp_dir()
            .join("deepseek-harness")
            .join("usage-sidecar.mjs"),
    );
    for c in &candidates {
        if let Some(parent) = c.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if std::fs::write(c, USAGE_SIDECAR_SRC).is_ok() {
            log_line(&format!("usage sidecar (embedded extract) -> {}", c.display()));
            return Some(c.clone());
        }
        log_line(&format!(
            "usage sidecar: could not write embedded copy to {}",
            c.display()
        ));
    }
    None
}

/// Strip the Windows extended-length `\\?\` prefix, which Node's CJS module
/// loader cannot resolve (it fails with EISDIR on the drive root).
#[cfg(target_os = "windows")]
fn strip_extended_prefix(p: std::path::PathBuf) -> std::path::PathBuf {
    if let Some(s) = p.to_str() {
        if let Some(rest) = s.strip_prefix("\\\\?\\") {
            return std::path::PathBuf::from(rest);
        }
        if let Some(rest) = s.strip_prefix("\\\\?\\UNC\\") {
            return std::path::PathBuf::from(format!("\\\\{}", rest));
        }
    }
    p
}

#[cfg(not(target_os = "windows"))]
fn strip_extended_prefix(p: std::path::PathBuf) -> std::path::PathBuf {
    p
}

/// Spawn `node <usage-sidecar.mjs>`. Reads its stdout: each `{...}` line is
/// emitted as `dsh-usage`; stderr and non-JSON stdout are forwarded to the
/// startup log. Returns the child (kept so we can kill it on close).
#[cfg(target_os = "windows")]
fn spawn_usage_sidecar(app: &tauri::AppHandle) -> std::io::Result<Child> {
    let script = usage_sidecar_path(app);
    let node = locate_node(None)?;
    let mut cmd = Command::new(node);
    cmd.arg(&script)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    log_line(&format!("usage sidecar spawned pid={}", child.id()));
    if let Some(out) = child.stdout.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if t.starts_with('{') {
                    let _ = h.emit("dsh-usage", t);
                } else {
                    log_line(&format!("[usage sidecar stdout] {t}"));
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log_line(&format!("[usage sidecar stderr] {line}"));
            }
        });
    }
    Ok(child)
}

#[cfg(not(target_os = "windows"))]
fn spawn_usage_sidecar(app: &tauri::AppHandle) -> std::io::Result<Child> {
    let script = usage_sidecar_path(app);
    let mut cmd = Command::new("node");
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    log_line(&format!("usage sidecar spawned pid={}", child.id()));
    if let Some(out) = child.stdout.take() {
        let h = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                let t = line.trim();
                if t.is_empty() {
                    continue;
                }
                if t.starts_with('{') {
                    let _ = h.emit("dsh-usage", t);
                } else {
                    log_line(&format!("[usage sidecar stdout] {t}"));
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                log_line(&format!("[usage sidecar stderr] {line}"));
            }
        });
    }
    Ok(child)
}

/// Pause or resume the sidecar's polling loop. The sidecar keeps stdin open
/// as a tiny control channel so opening the usage dialog can hold a stable
/// snapshot without killing and recreating the child process.
fn set_usage_polling(state: &Arc<UsageState>, paused: bool) {
    let command = if paused { "pause\n" } else { "resume\n" };
    if let Ok(mut value) = state.paused.lock() {
        *value = paused;
    }
    let mut guard = match state.child.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(child) = guard.as_mut() else {
        log_line("usage polling control: sidecar child is not ready");
        return;
    };
    let Some(stdin) = child.stdin.as_mut() else {
        log_line("usage polling control: sidecar stdin is unavailable");
        return;
    };
    if let Err(e) = stdin.write_all(command.as_bytes()).and_then(|_| stdin.flush()) {
        log_line(&format!("usage polling control failed ({command:?}): {e}"));
    }
}

/// A file under the dsh home's `storages` directory, shared with the CLI.
/// `DSH_HOME` (when set) IS the `.dsh` directory itself — the same convention
/// as the usage sidecar and dsh's own home resolution; otherwise fall back to
/// `~/.dsh`.
fn dsh_storages_file(name: &str) -> std::path::PathBuf {
    let home = match std::env::var("DSH_HOME") {
        Ok(h) => std::path::PathBuf::from(h),
        Err(_) => std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(".dsh"),
    };
    home.join("storages").join(name)
}

/// Resolve the pricing config file path (shared with the sidecar).
fn usage_pricing_path() -> std::path::PathBuf {
    dsh_storages_file("usage-pricing.json")
}

/// Ensure `desktop-settings.json` exists, writing the default config when
/// missing (same pattern as the sidecar's first-run usage-pricing.json).
/// Failures are swallowed — a read-only home simply keeps the defaults.
fn ensure_desktop_settings() {
    let path = dsh_storages_file("desktop-settings.json");
    if path.exists() {
        return;
    }
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log_line(&format!("desktop-settings: create storages dir failed: {e}"));
            return;
        }
    }
    match std::fs::write(
        &path,
        "{\n  \"decorations\": false,\n  \"usageBadge\": true,\n  \"updateCheck\": true\n}\n",
    ) {
        Ok(()) => log_line(&format!(
            "desktop-settings.json created with defaults -> {}",
            path.display()
        )),
        Err(e) => log_line(&format!(
            "desktop-settings: could not create {} ({e}); using defaults",
            path.display()
        )),
    }
}

/// Default "latest release" page for update checks. This is GitHub's HTML
/// endpoint — it 302-redirects to the newest release tag and does NOT consume
/// the GitHub API quota (60 req/h/IP unauthenticated), so update checks can no
/// longer be silently killed by rate limiting.
const DEFAULT_UPDATE_ENDPOINT: &str =
    "https://github.com/ai-written/DeepSeek-Harness/releases/latest";
/// Best-effort release-notes source (GitHub API). Only consulted when a newer
/// version is actually detected; a rate-limited/failed call degrades to empty
/// notes and never blocks the banner.
const DEFAULT_API_ENDPOINT: &str =
    "https://api.github.com/repos/ai-written/DeepSeek-Harness/releases/latest";
const DEFAULT_UPDATE_URL: &str = "https://github.com/ai-written/DeepSeek-Harness";

/// Parsed `desktop-settings.json` (auto-created with defaults on first launch).
struct DesktopSettings {
    /// Use the native system titlebar instead of the custom injected one.
    native_decorations: bool,
    /// Show the daily-usage badge (¥ amount pill + stats dialog) and run the
    /// usage sidecar that feeds it real-time data.
    usage_badge: bool,
    /// Whether to perform GitHub update checks. Default true.
    update_check: bool,
    /// Override "latest release" page for update checks (expects the HTML
    /// `/releases/latest` URL that redirects to the newest tag). Default is
    /// DEFAULT_UPDATE_ENDPOINT.
    update_endpoint: String,
    /// Ignored update version tag (e.g. "v0.1.6").
    ignored_update: Option<String>,
}

/// Read `desktop-settings.json` under the dsh storages dir, applying defaults
/// for any missing/unknown field: `decorations` = false, `usageBadge` = true,
/// `updateCheck` = true, etc.
fn read_desktop_settings() -> DesktopSettings {
    ensure_desktop_settings();
    let value = std::fs::read_to_string(dsh_storages_file("desktop-settings.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let get_bool = |key: &str, default: bool| {
        value
            .as_ref()
            .and_then(|v| v.get(key))
            .and_then(|v| v.as_bool())
            .unwrap_or(default)
    };
    let update_endpoint = value
        .as_ref()
        .and_then(|v| v.get("updateEndpoint"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| DEFAULT_UPDATE_ENDPOINT.to_string());
    let ignored_update = value
        .as_ref()
        .and_then(|v| v.get("ignoredUpdate"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let settings = DesktopSettings {
        native_decorations: get_bool("decorations", false),
        usage_badge: get_bool("usageBadge", true),
        update_check: get_bool("updateCheck", true),
        update_endpoint,
        ignored_update,
    };
    log_line(&format!(
        "native window decorations (desktop-settings.json): {}",
        settings.native_decorations
    ));
    log_line(&format!("usage badge (desktop-settings.json): {}", settings.usage_badge));
    log_line(&format!("update check (desktop-settings.json): {}", settings.update_check));
    log_line(&format!("update endpoint: {}", settings.update_endpoint));
    if let Some(ref ig) = settings.ignored_update {
        log_line(&format!("ignoredUpdate: {ig}"));
    }
    settings
}

fn persist_ignored_update(version: &str) -> Result<(), String> {
    let path = dsh_storages_file("desktop-settings.json");
    let mut value: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !value.is_object() {
        value = serde_json::json!({});
    }
    if let Some(obj) = value.as_object_mut() {
        obj.insert("ignoredUpdate".to_string(), serde_json::Value::String(version.to_string()));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

fn parse_version_core(v: &str) -> (Vec<u64>, Option<String>) {
    let (core, pre) = match v.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (v, None),
    };
    let nums = core
        .split('.')
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    (nums, pre)
}

/// Return true if `latest` > `current` (both without leading `v`).
fn is_newer_version(current: &str, latest: &str) -> bool {
    let (cur_nums, cur_pre) = parse_version_core(current);
    let (lat_nums, lat_pre) = parse_version_core(latest);
    let max_len = cur_nums.len().max(lat_nums.len());
    for i in 0..max_len {
        let c = *cur_nums.get(i).unwrap_or(&0);
        let l = *lat_nums.get(i).unwrap_or(&0);
        if l > c {
            return true;
        }
        if l < c {
            return false;
        }
    }
    match (cur_pre, lat_pre) {
        (None, None) => false,
        (None, Some(_)) => false, // prerelease < release
        (Some(_), None) => true,  // release > prerelease
        (Some(cp), Some(lp)) => lp > cp, // lexical
    }
}

/// Minimal HTTP GET using system `curl` (and PowerShell fallback on Windows),
/// so the update check needs no extra Rust TLS crates. Timeout 9s, silent failure.
fn http_get(url: &str) -> Result<String, String> {
    // Try curl first (present on modern Windows, macOS, linux)
    let curl_candidates: &[&str] = &["curl", "curl.exe"];
    for bin in curl_candidates {
        let mut cmd = Command::new(bin);
        cmd.args([
            "-sL",
            "--max-time",
            "9",
            "-H",
            "User-Agent: deepseek-harness-desktop",
            "-H",
            "Accept: application/vnd.github+json",
            url,
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        match cmd.output() {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8(out.stdout).map_err(|e| format!("utf8: {e}"))?;
                if s.trim().is_empty() {
                    return Err("empty response from curl".into());
                }
                return Ok(s);
            }
            Ok(out) => {
                let code = out.status.code().unwrap_or(-1);
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                log_line(&format!("curl {bin} failed code={code} stderr={stderr}"));
                // try next candidate / fallback
                continue;
            }
            Err(_) => continue,
        }
    }
    // PowerShell fallback on Windows
    #[cfg(target_os = "windows")]
    {
        let escaped = url.replace('\'', "''");
        let ps_script = format!(
            "$ProgressPreference='SilentlyContinue'; try {{ $r = Invoke-WebRequest -Uri '{escaped}' -Headers @{{'User-Agent'='deepseek-harness-desktop'; 'Accept'='application/vnd.github+json'}} -TimeoutSec 9 -UseBasicParsing; $r.Content }} catch {{ Write-Error $_.Exception.Message; exit 1 }}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &ps_script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let s = String::from_utf8(out.stdout).map_err(|e| format!("utf8: {e}"))?;
                if !s.trim().is_empty() {
                    return Ok(s);
                }
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            log_line(&format!("http_get: powershell route failed: {stderr}"));
        }
    }
    // Last route: Node (its OpenSSL stack works where Windows' schannel/.NET TLS
    // stack does not, and the shell requires Node anyway). See node_get().
    match node_get(url) {
        Ok(s) => Ok(s),
        Err(e) => {
            log_line(&format!("http_get: node route failed: {e}"));
            Err(format!(
                "http GET failed: curl/powershell/node all failed ({e})"
            ))
        }
    }
}

/// HTTP GET through the machine's `node` (OpenSSL TLS), used as the last route
/// when the platform TLS stacks cannot reach the host — e.g. a Windows box whose
/// schannel credential store is locked down by policy, where curl fails with
/// `SEC_E_NO_CREDENTIALS` and .NET with "Authentication failed". Node is already
/// a hard requirement of this shell, so it is a dependable route.
fn node_get(url: &str) -> Result<String, String> {
    const SCRIPT: &str = r#"
const target = process.argv[2];
const req = require('https').get(target, { headers: { 'User-Agent': 'deepseek-harness-desktop', 'Accept': 'application/vnd.github+json' } }, (res) => {
  if (res.statusCode >= 400) { process.stderr.write('HTTP ' + res.statusCode); process.exit(1); }
  let body = '';
  res.on('data', (c) => { body += c; });
  res.on('end', () => { process.stdout.write(body); });
});
req.on('error', (e) => { process.stderr.write(String(e.message || e)); process.exit(1); });
req.setTimeout(12000, () => { process.stderr.write('timeout after 12s'); req.destroy(); });
"#;
    let node = locate_node(None).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.args(["-e", SCRIPT, url]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("could not run node: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { "node exited with an error".into() } else { err });
    }
    let body = String::from_utf8_lossy(&out.stdout).to_string();
    if body.trim().is_empty() {
        return Err("empty response from node".into());
    }
    Ok(body)
}

/// Minimal HTTP GET that follows redirects but returns only the final URL
/// (`%{url_effective}`), discarding the body. Used by the update check to hit
/// GitHub's HTML `/releases/latest` page — a plain 302 to the newest release —
/// which does NOT consume the GitHub API quota. Timeout 9s, silent failure.
fn http_get_final_url(url: &str) -> Result<String, String> {
    let curl_candidates: &[&str] = &["curl", "curl.exe"];
    for bin in curl_candidates {
        let mut cmd = Command::new(bin);
        cmd.args([
            "-sL",
            "--max-time",
            "9",
            "-H",
            "User-Agent: deepseek-harness-desktop",
            "-o",
            "NUL",
            "-w",
            "%{url_effective}",
            url,
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        match cmd.output() {
            Ok(out) if out.status.success() => {
                let s = String::from_utf8(out.stdout).map_err(|e| format!("utf8: {e}"))?;
                let s = s.trim();
                if s.is_empty() {
                    return Err("empty url_effective from curl".into());
                }
                return Ok(s.to_string());
            }
            Ok(out) => {
                let code = out.status.code().unwrap_or(-1);
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                log_line(&format!(
                    "curl {bin} (final-url) failed code={code} stderr={stderr}"
                ));
                // try next candidate / fallback
                continue;
            }
            Err(_) => continue,
        }
    }
    // PowerShell fallback on Windows (follows redirects; read the final URI).
    #[cfg(target_os = "windows")]
    {
        let escaped = url.replace('\'', "''");
        let ps_script = format!(
            "$ProgressPreference='SilentlyContinue'; try {{ $r = Invoke-WebRequest -Uri '{escaped}' -Headers @{{'User-Agent'='deepseek-harness-desktop'}} -TimeoutSec 9 -UseBasicParsing; $r.BaseResponse.RequestMessage.RequestUri.AbsoluteUri }} catch {{ Write-Error $_.Exception.Message; exit 1 }}"
        );
        let mut cmd = Command::new("powershell");
        cmd.args(["-NoProfile", "-Command", &ps_script]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let s = String::from_utf8(out.stdout).map_err(|e| format!("utf8: {e}"))?;
                if !s.trim().is_empty() {
                    return Ok(s.trim().to_string());
                }
            }
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            return Err(format!("powershell Invoke-WebRequest failed: {stderr}"));
        }
    }
    Err("final-url GET failed: no curl/powershell available or all attempts failed".into())
}

/// Extract the release tag from a final "latest" URL like
/// `https://github.com/<owner>/<repo>/releases/tag/v0.1.7`. Returns `None`
/// when the URL has no tag (e.g. a repo with no releases redirects to
/// `/releases` instead).
fn parse_tag_from_release_url(final_url: &str) -> Option<String> {
    let marker = "/releases/tag/";
    let idx = final_url.find(marker)?;
    let rest = &final_url[idx + marker.len()..];
    let tag = rest
        .split(|c| c == '/' || c == '?' || c == '#')
        .next()
        .unwrap_or("");
    if tag.is_empty() {
        None
    } else {
        Some(tag.to_string())
    }
}

fn truncate_notes(body: &str) -> String {
    if body.chars().count() > 2000 {
        let truncated: String = body.chars().take(2000).collect();
        format!("{truncated}…")
    } else {
        body.to_string()
    }
}

/// Release notes, best-effort. Only called when a new version is detected, so
/// the GitHub API (60 req/h/IP unauthenticated) is barely touched; a failed or
/// rate-limited call degrades to empty notes and is only logged — it never
/// blocks the update banner.
fn fetch_release_notes() -> String {
    let text = match http_get(DEFAULT_API_ENDPOINT) {
        Ok(t) => t,
        Err(e) => {
            log_line(&format!(
                "update check: release notes fetch failed (best-effort): {e}"
            ));
            return String::new();
        }
    };
    let v: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            log_line(&format!(
                "update check: release notes parse failed (best-effort): {e}"
            ));
            return String::new();
        }
    };
    let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
    if body.is_empty() {
        let msg = v
            .get("message")
            .and_then(|x| x.as_str())
            .unwrap_or("no body");
        log_line(&format!("update check: release notes empty ({msg})"));
        return String::new();
    }
    truncate_notes(body)
}

/// Compare `tag` against the running version; when newer (and not ignored),
/// cache and emit `dsh-update-available`. `notes` is optional — when `None`,
/// release notes are fetched best-effort from the GitHub API. Returns true
/// when an update was announced.
fn maybe_announce_update(
    app: &tauri::AppHandle,
    cache: &Arc<Mutex<Option<serde_json::Value>>>,
    tag: &str,
    release_url: &str,
    ignored: Option<&str>,
    notes: Option<String>,
    endpoint: &str,
) -> bool {
    let current = env!("CARGO_PKG_VERSION");
    let latest_stripped = tag.trim_start_matches('v').trim_start_matches('V');
    let current_stripped = current.trim_start_matches('v').trim_start_matches('V');
    if !is_newer_version(current_stripped, latest_stripped) {
        log_line(&format!(
            "update check: no new version (current {current}, latest {tag})"
        ));
        return false;
    }
    if let Some(ig) = ignored {
        if ig == tag {
            log_line(&format!("update check: ignored version {tag} skipped"));
            return false;
        }
    }
    let notes = notes.unwrap_or_else(fetch_release_notes);
    // Which build this user should get: the release's own asset list, ranked so
    // the first entry matches the running build (portable exe → portable asset,
    // installed copy → NSIS setup). Best-effort — an empty list means the banner
    // falls back to opening the release page.
    let assets = fetch_release_assets(endpoint, tag);
    let asset_label = assets
        .first()
        .map(|a| asset_kind_label(&a.kind).to_string())
        .unwrap_or_default();
    let payload = serde_json::json!({
        "version": tag,
        "current": current,
        "url": DEFAULT_UPDATE_URL,
        "releaseUrl": release_url,
        "notes": notes,
        "assets": assets,
        "assetLabel": asset_label,
        "portable": running_portable(),
    });
    log_line(&format!("update available: {tag} (current {current})"));
    *cache.lock().unwrap() = Some(payload.clone());
    let _ = app.emit("dsh-update-available", payload);
    true
}

/// Open a URL in the system default browser. The update banner's "前往下载"
/// button cannot use `window.open` (swallowed by the embedded WebView2), so
/// the page emits `dsh-update-open` and this opens it with the OS instead.
fn open_url_in_browser(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        log_line(&format!("open url refused (non-http(s)): {url}"));
        return;
    }
    #[cfg(target_os = "windows")]
    {
        // `rundll32 url.dll,FileProtocolHandler` opens the URL with the system
        // default browser. No shell is involved, so there are none of the
        // quoting pitfalls of `cmd /C start "" "url"` (which mangles the URL
        // when Rust re-quotes the argument).
        let mut cmd = Command::new("rundll32");
        cmd.args(["url.dll,FileProtocolHandler", url]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        if let Err(e) = cmd.spawn() {
            log_line(&format!("open url failed (rundll32): {e}"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = Command::new("open").arg(url).spawn() {
            log_line(&format!("open url failed (open): {e}"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Err(e) = Command::new("xdg-open").arg(url).spawn() {
            log_line(&format!("open url failed (xdg-open): {e}"));
        }
    }
}

fn filename_from_url(url: &str) -> Option<String> {
    let no_frag = url.split('#').next().unwrap_or(url);
    let no_query = no_frag.split('?').next().unwrap_or(no_frag);
    // A URL ending in "/" names a directory, not a file: without this check the
    // rsplit below would return the last path segment (or the host).
    if no_query.ends_with('/') {
        return None;
    }
    let tail = no_query.rsplit('/').next().unwrap_or("");
    let name = sanitize_filename(tail);
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

/// Strip characters Windows rejects in a file name and any path separator, so a
/// server-provided name can never escape the download directory.
fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect();
    cleaned.trim().trim_matches('.').to_string()
}

/// Windows: does the uninstall registry hold a DeepSeek-Harness install? NSIS
/// and MSI both register one, so this catches an installed copy whose exe the
/// user happens to be running from somewhere else.
#[cfg(target_os = "windows")]
fn installed_in_registry() -> bool {
    let script = "$keys = @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', \
                  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', \
                  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'); \
                  $hit = Get-ItemProperty $keys -ErrorAction SilentlyContinue | \
                  Where-Object { $_.DisplayName -like 'DeepSeek-Harness*' } | Select-Object -First 1; \
                  if ($hit) { 'yes' } else { 'no' }";
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    match cmd.output() {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim().eq_ignore_ascii_case("yes")
        }
        _ => false,
    }
}

#[cfg(not(target_os = "windows"))]
fn installed_in_registry() -> bool {
    false
}

/// True when this build is the standalone (免安装) exe rather than an installed
/// copy. Drives which release asset to download: portable users get
/// `..._x64-portable.exe`, installed users get the NSIS `..._x64-setup.exe`
/// (MSI for an MSI install), so nobody has to think about which file is theirs.
///
/// Two signals, cheapest first:
///   1. an uninstaller next to the running exe — NSIS/MSI always installs one,
///      the portable build never ships one;
///   2. otherwise the uninstall registry, which catches the case where a
///      portable exe is being run on a machine that also has the app installed.
/// Detection is a preference only: a mis-detected portable user simply gets the
/// installer, which is the build GitHub also leads with.
fn running_portable() -> bool {
    // The registry probe below starts a PowerShell process; do that at most
    // once per launch, however often the banner asks.
    static CACHED: OnceLock<bool> = OnceLock::new();
    if let Some(v) = CACHED.get() {
        return *v;
    }
    let exe_dir_has_uninstaller = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|d| d.to_path_buf()))
        .is_some_and(|dir| {
            dir.join("uninstall.exe").exists() || dir.join("Uninstall.exe").exists()
        });
    let portable = !exe_dir_has_uninstaller && !installed_in_registry();
    log_line(&format!(
        "update download: build kind -> {} (uninstaller next to exe: {exe_dir_has_uninstaller})",
        if portable { "免安装版 portable" } else { "安装版 installed" }
    ));
    let _ = CACHED.set(portable);
    portable
}

/// One downloadable asset from the release. `url` is answered directly by
/// GitHub's asset host, so the banner can download without opening the browser.
#[derive(serde::Serialize, Clone, Debug)]
struct AssetEntry {
    name: String,
    url: String,
    size: u64,
    /// "installer" | "portable" | "msi" | "other"
    kind: String,
    /// GitHub's asset digest when available (`sha256:<hex>`); verified after
    /// download. Empty when the API did not report one.
    digest: String,
}

/// Classify a release asset by name, or None for non-payload files (updater
/// signatures, checksums, source archives) that must not be offered.
fn classify_asset(name: &str) -> Option<&'static str> {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".sig") || n.ends_with(".sha256") || n.ends_with(".txt") {
        return None;
    }
    if n.ends_with(".msi") {
        return Some("msi");
    }
    if n.contains("portable") && n.ends_with(".exe") {
        return Some("portable");
    }
    if n.contains("setup") && n.ends_with(".exe") {
        return Some("installer");
    }
    if n.ends_with(".exe") {
        return Some("portable");
    }
    None
}

/// Ordering key for one asset, relative to this build. Lower sorts first.
fn asset_rank(kind: &str, portable: bool, name: &str) -> u32 {
    let x64 = if name.to_ascii_lowercase().contains("x64") { 0 } else { 1 };
    let base = match (kind, portable) {
        ("portable", true) => 0,
        ("installer", false) => 0,
        ("installer", true) => 1,
        ("portable", false) => 1,
        ("msi", _) => 2,
        _ => 3,
    };
    base * 10 + x64
}

/// Every usable asset of the release, best candidate for this build first.
fn collect_assets(value: &serde_json::Value) -> Vec<AssetEntry> {
    let portable = running_portable();
    let mut out: Vec<AssetEntry> = Vec::new();
    if let Some(arr) = value.get("assets").and_then(|x| x.as_array()) {
        for a in arr {
            let name = a.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string();
            // GitHub answers at browser_download_url with the file itself
            // (Content-Disposition: attachment), so this needs no redirect.
            let url = a
                .get("browser_download_url")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() || url.is_empty() {
                continue;
            }
            let Some(kind) = classify_asset(&name) else { continue };
            out.push(AssetEntry {
                name,
                url,
                size: a.get("size").and_then(|x| x.as_u64()).unwrap_or(0),
                kind: kind.to_string(),
                digest: a.get("digest").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            });
        }
    }
    out.sort_by_key(|a| asset_rank(&a.kind, portable, &a.name));
    log_line(&format!(
        "update check: {} downloadable asset(s) (running {})",
        out.len(),
        if portable { "portable exe" } else { "installed copy" }
    ));
    for a in &out {
        log_line(&format!("  asset [{}] {} ({} bytes)", a.kind, a.name, a.size));
    }
    if let Some(first) = out.first() {
        log_line(&format!(
            "update check: best match for this build -> {} ({})",
            first.name,
            asset_kind_label(&first.kind)
        ));
    }
    out
}

/// Human-readable label for an asset kind, shown in the banner so the user sees
/// which build they are about to download.
fn asset_kind_label(kind: &str) -> &'static str {
    match kind {
        "portable" => "免安装版",
        "installer" => "安装版（NSIS 安装包）",
        "msi" => "安装版（MSI 安装包）",
        _ => "其他",
    }
}

/// `https://api.github.com/repos/<owner>/<repo>/releases/tags/<tag>` for the
/// repo the update endpoint points at. None when the endpoint is not the
/// expected GitHub release URL (e.g. a custom mirror), in which case the banner
/// falls back to opening the release page — as it always did.
fn release_api_url_for_tag(endpoint: &str, tag: &str) -> Option<String> {
    let after_host = endpoint.split("github.com/").nth(1)?;
    let mut parts = after_host.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let encoded_tag: String = tag
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            other => format!("%{other:02X}"),
        })
        .collect();
    Some(format!(
        "https://api.github.com/repos/{owner}/{repo}/releases/tags/{encoded_tag}"
    ))
}

/// Best-effort asset list for the release the banner just announced: hits the
/// API for THIS tag (one request, only when a newer version exists). When that
/// fails — the anonymous API quota (60 req/h per IP) is easily exhausted behind
/// a shared/VPN address, which is a real 403 in the wild — the download URL is
/// derived from the repo's fixed release naming instead, so an in-app download
/// never depends on the API being available. Only a custom (non-GitHub)
/// endpoint leaves the list empty, and the banner falls back to the release page.
fn fetch_release_assets(endpoint: &str, tag: &str) -> Vec<AssetEntry> {
    let Some(api) = release_api_url_for_tag(endpoint, tag) else {
        log_line(&format!(
            "update check: no tag API URL for endpoint {endpoint}; direct download unavailable"
        ));
        return Vec::new();
    };
    log_line(&format!("update check: GET {api} (assets)"));
    let from_api = match http_get(&api) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(v) => collect_assets(&v),
            Err(e) => {
                log_line(&format!("update check: asset list parse failed (best-effort): {e}"));
                Vec::new()
            }
        },
        Err(e) => {
            log_line(&format!("update check: asset list fetch failed (best-effort): {e}"));
            Vec::new()
        }
    };
    if !from_api.is_empty() {
        return from_api;
    }
    let derived = derived_assets(endpoint, tag);
    if derived.is_empty() {
        log_line("update check: no assets from the API and none derivable; the banner will open the release page");
    } else {
        log_line(&format!(
            "update check: API gave no assets; derived {} from the release naming convention (no digest available)",
            derived.len()
        ));
    }
    derived
}

/// Fallback asset list built from the repo's fixed release naming — no API call
/// at all. The workflow publishes `DeepSeek-Harness_<version>_x64-{portable,setup}.exe`
/// plus the MSI, so the names are predictable from the tag (the release docs
/// require the tag and the project version to match). Ranked exactly like the
/// API path, so the build-kind preference still applies. `digest` is unknown
/// here; the caller reports that the sha256 check was skipped.
fn derived_assets(endpoint: &str, tag: &str) -> Vec<AssetEntry> {
    let version = tag.trim_start_matches('v').trim_start_matches('V');
    // Guard against a tag that is not a version at all (a `--latest` style
    // alias): deriving a name from it would only produce a 404.
    if version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return Vec::new();
    }
    // The endpoint must be `<repo>/releases/...`; anything else (a mirror, a bare
    // host) has no derivable release-download path.
    let Some((repo_root, _)) = endpoint.split_once("/releases") else {
        return Vec::new();
    };
    let owner_repo = repo_root.trim_start_matches("https://github.com/").trim_matches('/');
    if !repo_root.starts_with("https://github.com/")
        || owner_repo.is_empty()
        || owner_repo.split('/').count() != 2
        || owner_repo.split('/').any(|s| s.is_empty())
    {
        return Vec::new();
    }
    let repo_root = repo_root.trim_end_matches('/');
    let names = [
        ("portable", format!("DeepSeek-Harness_{version}_x64-portable.exe")),
        ("installer", format!("DeepSeek-Harness_{version}_x64-setup.exe")),
        ("msi", format!("DeepSeek-Harness_{version}_x64_en-US.msi")),
    ];
    let portable = running_portable();
    let mut out: Vec<AssetEntry> = names
        .into_iter()
        .map(|(kind, name)| AssetEntry {
            url: format!("{repo_root}/releases/download/{tag}/{name}"),
            name,
            size: 0,
            kind: kind.to_string(),
            digest: String::new(),
        })
        .collect();
    out.sort_by_key(|a| asset_rank(&a.kind, portable, &a.name));
    out
}

// ── Direct download (banner "下载更新") ──────────────────────────────────────
// The banner used to hand the user off to GitHub. It now downloads the right
// asset itself straight into the user's Downloads folder, verifies it, unblocks
// it and reveals it in the file manager. Nothing is executed: the user
// double-clicks the installer/portable exe when they are ready. The transfer
// prefers node (progress + Range resume + OpenSSL TLS) with curl as fallback.

/// How long a single asset download may take. The installers are tens of MB;
/// on a slow link that is minutes, so this is generous but bounded.
#[cfg(target_os = "windows")]
const DOWNLOAD_TIMEOUT_SECS: u32 = 900;

/// Downloads one asset through node: follows redirects (GitHub answers release
/// assets with a 302 to its asset host), streams to the `.part` file, resumes
/// with a Range request when the partial file matches the announced size,
/// reports progress as JSON lines on stdout, and verifies the final byte count.
/// Arguments: <url> <part-path> <expected-len>.
const NODE_DOWNLOAD_SCRIPT: &str = r#"
const fs = require('fs');
const https = require('https');
// `node -e <script> <args…>` puts the script text at argv[1], so the real
// arguments start at argv[2] (verified, not assumed).
const [url, partPath, expectedArg] = process.argv.slice(2);
const expected = Number(expectedArg) || 0;
const fail = (m) => { process.stderr.write(String(m)); process.exit(1); };
if (!/^https?:\/\//.test(String(url))) fail('bad url: ' + url);

const already = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
const headers = {
  'User-Agent': 'deepseek-harness-desktop',
  'Accept': 'application/octet-stream',
};
// Stream flags are 'w' / 'a' ('wb'/'ab' are fs.open flags and are rejected here).
let mode = 'w';
if (already > 0) { headers['Range'] = 'bytes=' + already + '-'; mode = 'a'; }

const req = https.get(url, { headers }, (res) => {
  const redirect = res.headers.location;
  if (res.statusCode >= 300 && res.statusCode < 400 && redirect) {
    // Follow the redirect once, absolutely, and restart from scratch.
    res.resume();
    const again = https.get(new URL(redirect, url), { headers: { 'User-Agent': headers['User-Agent'], 'Accept': headers['Accept'] } }, (r2) => {
      if (r2.statusCode >= 400) return fail('HTTP ' + r2.statusCode);
      stream(r2, 'w');
    });
    again.on('error', (e) => fail(e.message));
    again.setTimeout(60000, () => { again.destroy(); fail('timeout'); });
    return;
  }
  if (res.statusCode >= 400) return fail('HTTP ' + res.statusCode);
  // 200 means the server ignored the Range header, so the file restarts.
  stream(res, res.statusCode === 206 ? mode : 'w');
});

function stream(res, writeMode) {
  const out = fs.createWriteStream(partPath, { flags: writeMode });
  const from = writeMode === 'a' ? already : 0;
  let received = from;
  // On a 206 the Content-Length covers only the remaining bytes, so the real
  // total is what is already on disk plus what this response will deliver.
  const contentLength = Number(res.headers['content-length'] || 0);
  const total = contentLength ? from + contentLength : expected;
  let lastReport = 0;
  res.on('data', (c) => {
    received += c.length;
    const now = Date.now();
    // Throttle: one line per second (plus the final one) is plenty for a banner.
    if (now - lastReport >= 1000 || (total && received >= total)) {
      lastReport = now;
      process.stdout.write(JSON.stringify({ event: 'progress', received, total }) + '\n');
    }
  });
  res.on('error', (e) => fail(e.message));
  out.on('error', (e) => fail(e.message));
  res.pipe(out);
  out.on('close', () => {
    const size = fs.statSync(partPath).size;
    if (expected && size !== expected) fail('size mismatch ' + size + '/' + expected);
    process.stdout.write(JSON.stringify({ event: 'done', bytes: size }) + '\n');
    process.exit(0);
  });
}

req.on('error', (e) => fail(e.message));
req.setTimeout(900000, () => { req.destroy(); fail('timeout after 900s'); });
"#;

/// The user's Downloads folder. USERPROFILE is enough on Windows (no shell
/// lookups needed); anything else falls back to cwd, then TEMP, so a download
/// always has a home.
fn download_dir() -> std::path::PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Some(profile) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            let dir = std::path::PathBuf::from(profile).join("Downloads");
            if std::fs::create_dir_all(&dir).is_ok() {
                return dir;
            }
            log_line(&format!(
                "update download: could not create {}; falling back",
                dir.display()
            ));
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Some(home) = std::env::var_os("HOME").filter(|v| !v.is_empty()) {
            let dir = std::path::PathBuf::from(home).join("Downloads");
            if std::fs::create_dir_all(&dir).is_ok() {
                return dir;
            }
        }
    }
    match std::env::current_dir() {
        Ok(dir) if dir.is_dir() => dir,
        _ => std::env::temp_dir(),
    }
}

/// A free path for `file_name` in `dir`: the name itself when unused, otherwise
/// `stem (2).ext`, `stem (3).ext`, … so a re-download never clobbers a file the
/// user already has.
fn resolve_free_path(dir: &std::path::Path, file_name: &str) -> std::path::PathBuf {
    let safe = sanitize_filename(file_name);
    let safe = if safe.is_empty() { "DeepSeek-Harness-update.exe".to_string() } else { safe };
    let candidate = dir.join(&safe);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(&safe);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("DeepSeek-Harness-update");
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    for n in 2..1000 {
        let name = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        let candidate = dir.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(safe)
}

/// The directory holding `path` (`.` when it has none).
fn dir_of(path: &std::path::Path) -> &std::path::Path {
    path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(std::path::Path::new("."))
}

/// `file.exe` → (`file`, `exe`) and `file (2).exe` → (`file (2)`, `exe`): the
/// same stem/extension split [`resolve_free_path`] uses when numbering a retry.
fn split_partial_name(base_name: &str) -> (&str, &str) {
    match base_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (base_name, ""),
    }
}

/// True when two `.part` base names (the name without the `.part` suffix) belong
/// to the same download. [`resolve_free_path`] numbers the stem and keeps the
/// extension, so one attempt can be `file.exe` and the next `file (2).exe`, and a
/// later one `file (3).exe` — all three name the same download, while
/// `other.exe` does not. The ` (n)` numbering is therefore stripped before
/// comparing, which is what makes two DIFFERENT variants (2 and 3) match.
fn same_partial_group(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (a_stem, a_ext) = split_partial_name(a);
    let (b_stem, b_ext) = split_partial_name(b);
    a_ext == b_ext && base_stem_of(a_stem) == base_stem_of(b_stem)
}

/// `file` → `file`; `file (2)` → `file`. Only a trailing ` (digits)` is removed,
/// and never the whole name (so `(2).exe` alone keeps a usable stem).
fn base_stem_of(stem: &str) -> &str {
    if let Some(idx) = stem.rfind(" (") {
        let (base, suffix) = stem.split_at(idx);
        if suffix.ends_with(')') && !base.is_empty() {
            let digits = &suffix[2..suffix.len().saturating_sub(1)];
            if !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()) {
                return base;
            }
        }
    }
    stem
}

/// Which `.part` file the transfer should use.
///
/// [`resolve_free_path`] picks a fresh final name (`file (2).exe`) when the
/// previous attempt failed and left a file behind, so taking the exact
/// `<final>.part` path would abandon a resumable partial and start from byte 0.
/// Any sibling partial of the same download (numbered retry variants included)
/// is a candidate, and the largest one wins so the most progress is kept.
/// Unrelated `.part` files are never touched.
fn pick_partial(exact: &std::path::Path, dir: &std::path::Path) -> Option<std::path::PathBuf> {
    let target = exact.file_name()?.to_str()?;
    let target_stem = target.strip_suffix(".part")?;
    let mut best: Option<(std::path::PathBuf, u64)> = None;
    for entry in std::fs::read_dir(dir).ok()?.filter_map(Result::ok) {
        let name = match entry.file_name().into_string() {
            Ok(n) => n,
            Err(_) => continue,
        };
        let Some(candidate_stem) = name.strip_suffix(".part") else { continue };

        if !same_partial_group(candidate_stem, target_stem) {
            continue;
        }
        let len = entry.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map_or(true, |(_, best_len)| len > *best_len) {
            best = Some((entry.path(), len));
        }
    }
    match best {
        Some((path, len)) => {
            log_line(&format!(
                "update download: reusing partial file ({len} bytes) -> {}",
                path.display()
            ));
            Some(path)
        }
        None => Some(exact.to_path_buf()),
    }
}

/// Download `url` to `final_path`, resuming a leftover `.part` when possible.
/// `expected_len` (0 = unknown) short-circuits a `.part` that is already
/// complete, and lets a truncated `.part` restart instead of resuming into a
/// corrupted file. `progress` receives (received, total) byte counts.
fn download_asset_to(
    url: &str,
    final_path: &std::path::Path,
    expected_len: u64,
    progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("refusing non-http(s) download URL: {url}"));
    }
    let part_path = std::path::PathBuf::from(format!("{}.part", final_path.display()));
    let part_path = match pick_partial(&part_path, dir_of(final_path)) {
        Some(p) => p,
        None => return Err("could not prepare the download path".into()),
    };
    let part_len = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    let complete_part = expected_len > 0 && part_len == expected_len;
    // A leftover `.part` may only be resumed when its size proves it is the same
    // file: resuming a partial file that is already too large makes curl append
    // and still exit 0, silently producing a corrupt download. Without a known
    // length nothing can be proven, so the partial file is simply discarded —
    // restarting only costs the bytes already fetched.
    if part_len > 0 && !complete_part {
        let why = if expected_len == 0 {
            "release reported no size".to_string()
        } else {
            format!("{part_len}/{expected_len} bytes")
        };
        log_line(&format!(
            "update download: discarding unverifiable partial file ({why}) -> {}",
            part_path.display()
        ));
        let _ = std::fs::remove_file(&part_path);
    }
    if !complete_part {
        // Prefer node: it reports progress, resumes, and its OpenSSL TLS works on
        // Windows machines where schannel does not (see node_get). curl remains
        // the fallback for machines without a usable node.
        match node_download(url, &part_path, expected_len, progress) {
            Ok(()) => {
                log_line("update download: node route ok");
            }
            Err(node_err) => {
                log_line(&format!("update download: node route failed ({node_err}); trying curl"));
                curl_download(url, &part_path)?;
            }
        }
    } else {
        log_line("update download: partial file already complete; skipping the transfer");
    }

    let size = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    // `expected_len` of 0 means the API withheld the size (rare); the size the
    // download ended with is then all there is to go on.
    let target_len = if expected_len > 0 { expected_len } else { size };
    // Never hand a file to the rename below unless it is exactly the announced
    // size: a short file is a truncated download and a long one means curl
    // appended to a stale partial, so the cleanup stops junk accumulating in the
    // Downloads folder for a retry to trip over.
    if size == 0 {
        let _ = std::fs::remove_file(&part_path);
        return Err("downloaded file is empty".into());
    }
    if size != target_len {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "download size mismatch ({size}/{target_len} bytes); discarded"
        ));
    }
    std::fs::rename(&part_path, final_path)
        .map_err(|e| format!("could not move the downloaded file into place: {e}"))?;
    log_line(&format!(
        "update download: {} bytes -> {}",
        size,
        final_path.display()
    ));
    Ok(())
}

/// Download through the machine's `node` (OpenSSL TLS, streaming with progress
/// reporting and Range resume). The script writes one JSON object per line to
/// stdout — `{"event":"progress","received":…,"total":…}` / `{"event":"done",…}`
/// — and exits non-zero with the reason on stderr when anything fails.
fn node_download(
    url: &str,
    part_path: &std::path::Path,
    expected_len: u64,
    progress: &dyn Fn(u64, u64),
) -> Result<(), String> {
    let node = locate_node(None).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(node);
    cmd.args([
        "-e",
        NODE_DOWNLOAD_SCRIPT,
        url,
        &part_path.display().to_string(),
        &expected_len.to_string(),
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("could not run node: {e}"))?;

    // stderr is drained on its own thread so a chatty failure can neither fill the
    // pipe nor block the child while stdout is being read.
    let stderr = child.stderr.take();
    let err_slot: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    if let Some(err) = stderr {
        let slot = err_slot.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut g = slot.lock().unwrap();
                if !g.is_empty() {
                    g.push_str(" | ");
                }
                g.push_str(line.trim());
            }
        });
    }

    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            let Ok(v) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
            match v.get("event").and_then(|x| x.as_str()) {
                Some("progress") => {
                    let received = v.get("received").and_then(|x| x.as_u64()).unwrap_or(0);
                    let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(expected_len);
                    progress(received, total);
                }
                Some("done") => log_line(&format!(
                    "update download: node reported {} bytes",
                    v.get("bytes").and_then(|x| x.as_u64()).unwrap_or(0)
                )),
                _ => {}
            }
        }
    }
    let status = child.wait().map_err(|e| format!("waiting for node: {e}"))?;
    if !status.success() {
        let err = err_slot.lock().unwrap().clone();
        return Err(if err.is_empty() {
            format!("node exited with code {:?}", status.code())
        } else {
            err
        });
    }
    Ok(())
}

/// Download through the bundled Windows curl. Used when the node route is
/// unavailable, so the pre-existing behavior is preserved.
#[cfg(target_os = "windows")]
fn curl_download(url: &str, part_path: &std::path::Path) -> Result<(), String> {
    let mut cmd = Command::new("curl");
    let timeout = DOWNLOAD_TIMEOUT_SECS.to_string();
    let mut args: Vec<String> = vec![
        "-L".into(),
        "--fail".into(),
        "--silent".into(),
        "--show-error".into(),
        "--max-time".into(),
        timeout,
        "-H".into(),
        "User-Agent: deepseek-harness-desktop".into(),
        "-H".into(),
        "Accept: application/octet-stream".into(),
    ];
    if part_path.exists() {
        args.push("--continue-at".into());
        args.push("-".into());
    }
    args.push("--output".into());
    args.push(part_path.display().to_string());
    args.push(url.to_string());
    cmd.args(&args);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    log_line(&format!(
        "update download: curl{} -> {}",
        if part_path.exists() { " (resume)" } else { "" },
        part_path.display()
    ));
    let out = cmd.output().map_err(|e| format!("could not run curl: {e}"))?;
    if !out.status.success() {
        let code = out.status.code().unwrap_or(-1);
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "curl failed (exit {code}){}{err}",
            if err.is_empty() { "" } else { ": " }
        ));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn curl_download(_url: &str, _part_path: &std::path::Path) -> Result<(), String> {
    Err("no curl fallback on this platform".into())
}

/// Verify the downloaded file against GitHub's `sha256:` digest.
/// `Ok(true)` verified, `Ok(false)` mismatch (the caller must delete the file),
/// `Err` when the check could not run at all (recorded, not fatal: the file
/// still came over HTTPS from the asset host).
#[cfg(target_os = "windows")]
fn verify_sha256(path: &std::path::Path, digest: &str) -> Result<bool, String> {
    let want = digest.trim().trim_start_matches("sha256:").to_ascii_lowercase();
    if want.len() != 64 {
        return Err(format!("unusable digest: {digest}"));
    }
    let escaped = path.display().to_string().replace('\'', "''");
    let script = format!(
        "(Get-FileHash -Algorithm SHA256 -LiteralPath '{escaped}').Hash"
    );
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let out = cmd.output().map_err(|e| format!("could not run PowerShell: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "Get-FileHash failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let got = String::from_utf8_lossy(&out.stdout).trim().to_ascii_lowercase();
    if got.len() != 64 {
        return Err(format!("unexpected hash output: {got}"));
    }
    Ok(got == want)
}

#[cfg(not(target_os = "windows"))]
fn verify_sha256(_path: &std::path::Path, _digest: &str) -> Result<bool, String> {
    Err("sha256 verification is only implemented on Windows".into())
}

/// Clear the "downloaded from the internet" mark (Zone.Identifier) so a
/// portable exe is not silently blocked by SmartScreen on first run — the same
/// step the README tells users to do by hand. Best-effort.
#[cfg(target_os = "windows")]
fn unblock_file(path: &std::path::Path) {
    let escaped = path.display().to_string().replace('\'', "''");
    let script = format!("Unblock-File -LiteralPath '{escaped}'");
    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &script]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    match cmd.status() {
        Ok(s) if s.success() => log_line(&format!("update download: unblocked {}", path.display())),
        Ok(s) => log_line(&format!("update download: Unblock-File exit {s} for {}", path.display())),
        Err(e) => log_line(&format!("update download: could not run Unblock-File: {e}")),
    }
}

#[cfg(not(target_os = "windows"))]
fn unblock_file(_path: &std::path::Path) {}

/// Show the downloaded file in the file manager, selected.
fn reveal_in_file_manager(path: &std::path::Path) {
    #[cfg(target_os = "windows")]
    {
        // The `/select,` switch must not be quoted on its own; the whole
        // argument is quoted as one unit so a path with spaces survives.
        let arg = format!("/select,\"{}\"", path.display());
        match Command::new("explorer").arg(&arg).spawn() {
            Ok(_) => return,
            Err(e) => {
                log_line(&format!("update download: explorer /select failed ({e}); opening the folder"));
                if let Some(dir) = path.parent() {
                    let _ = Command::new("explorer").arg(dir).spawn();
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = path.parent().unwrap_or(path);
        let _ = Command::new("xdg-open").arg(dir).spawn();
    }
}

/// Download one release asset into the Downloads folder, verify it and reveal
/// it. Runs on its own thread; every outcome is reported to the banner as a
/// `dsh-update-progress` event (`state` = started | done | failed) and logged.
/// When the direct download cannot proceed at all, `release_page` is opened in
/// the browser instead, so the button is never a dead end.
fn download_update_asset(
    app: &tauri::AppHandle,
    url: String,
    file_name: String,
    expected_len: u64,
    digest: Option<String>,
    release_page: String,
) {
    let report = |state: &str, message: &str, path: Option<String>| {
        let _ = app.emit(
            "dsh-update-progress",
            serde_json::json!({
                "state": state,
                "message": message,
                "file": path,
            }),
        );
    };
    let dir = download_dir();
    let target = resolve_free_path(&dir, &file_name);
    log_line(&format!(
        "update download: start {} -> {} ({expected_len} bytes, digest {})",
        url,
        target.display(),
        digest.as_deref().unwrap_or("none")
    ));
    report("started", "正在下载…", Some(target.display().to_string()));
    // Progress goes to the banner as its own state so the sub-line can show real
    // byte counts instead of a static "下载中…". Updates are throttled by byte
    // delta (plus the final byte) so a fast link cannot flood the page with events.
    let total = expected_len;
    let last_reported = std::sync::atomic::AtomicU64::new(0);
    let progress = move |received: u64, reported_total: u64| {
        let prev = last_reported.load(std::sync::atomic::Ordering::Relaxed);
        let is_final = reported_total > 0 && received >= reported_total;
        if !is_final && received.saturating_sub(prev) < 256 * 1024 {
            return;
        }
        last_reported.store(received, std::sync::atomic::Ordering::Relaxed);
        let total = if reported_total > 0 { reported_total } else { total };
        let message = match total {
            0 => format!("已下载 {:.1} MB", received as f64 / (1024.0 * 1024.0)),
            _ => format!(
                "已下载 {:.1} / {:.1} MB",
                received as f64 / (1024.0 * 1024.0),
                total as f64 / (1024.0 * 1024.0)
            ),
        };
        let _ = app.emit(
            "dsh-update-progress",
            serde_json::json!({
                "state": "progress",
                "message": message,
                "received": received,
                "total": total,
                "file": null,
            }),
        );
    };
    match download_asset_to(&url, &target, expected_len, &progress) {
        Ok(()) => {
            match digest.as_deref() {
                Some(d) => match verify_sha256(&target, d) {
                    Ok(true) => log_line("update download: sha256 verified"),
                    Ok(false) => {
                        let _ = std::fs::remove_file(&target);
                        let msg = "校验失败，已删除下载文件".to_string();
                        log_line(&format!("update download: sha256 MISMATCH — deleted {}", target.display()));
                        report("failed", &msg, None);
                        return;
                    }
                    Err(e) => log_line(&format!("update download: sha256 check skipped: {e}")),
                },
                None => log_line("update download: release published no digest; skipping sha256"),
            }
            unblock_file(&target);
            reveal_in_file_manager(&target);
            let size_mb = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0) as f64 / (1024.0 * 1024.0);
            report(
                "done",
                &format!("已下载（{size_mb:.1} MB），已在文件夹中选中"),
                Some(target.display().to_string()),
            );
        }
        Err(e) => {
            log_line(&format!("update download: failed: {e}"));
            report("failed", &e, None);
            // Never leave the button a dead end — send the user to the release
            // page where they can pick a file by hand (the original behavior).
            // Asset URLs derived without the API are a naming-convention guess,
            // so a 404 in particular means "the real file is named differently".
            let guess_missed = e.contains("HTTP 404");
            if release_page.starts_with("http") {
                log_line(&format!(
                    "update download: falling back to the release page: {release_page} (derived-asset miss: {guess_missed})"
                ));
                open_url_in_browser(&release_page);
            }
        }
    }
}

/// Decode an event payload emitted by the page. A JS `emit` of a *string* is
/// delivered as JSON-encoded text, so unwrap that one extra layer; everything
/// else (an object payload, or a bare version string) is used as-is.
fn unwrap_event_payload(payload_str: &str) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_str(payload_str).ok()?;
    Some(match v {
        serde_json::Value::String(s) => {
            serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::Value::String(s))
        }
        other => other,
    })
}

fn check_update_once(app: &tauri::AppHandle, cache: Arc<Mutex<Option<serde_json::Value>>>) {
    let settings = read_desktop_settings();
    if !settings.update_check {
        log_line("update check: skipped (updateCheck=false)");
        return;
    }
    let endpoint = settings.update_endpoint.clone();
    let ignored = settings.ignored_update.clone();
    log_line(&format!("update check: GET {endpoint} (HTML latest page)"));
    let result: Result<(), String> = (|| {
        // Primary route: GitHub's HTML /releases/latest — a plain 302 to the
        // newest release tag — which does NOT consume the GitHub API quota, so
        // checks can no longer be silently killed by rate limiting.
        match http_get_final_url(&endpoint) {
            Ok(final_url) => {
                log_line(&format!("update check: latest release URL -> {final_url}"));
                match parse_tag_from_release_url(&final_url) {
                    Some(tag) => {
                        maybe_announce_update(
                            app,
                            &cache,
                            &tag,
                            &final_url,
                            ignored.as_deref(),
                            None,
                            &endpoint,
                        );
                    }
                    None => log_line(&format!(
                        "update check: no release found (final URL has no /releases/tag/): {final_url}"
                    )),
                }
            }
            Err(html_err) => {
                // Fallback route: the old JSON API (only when the HTML route
                // fails, e.g. github.com unreachable but api.github.com works).
                // It may itself be rate-limited — then it degrades to a clear,
                // logged no-op rather than a silent failure.
                log_line(&format!(
                    "update check: HTML route failed ({html_err}); falling back to API"
                ));
                let text = http_get(DEFAULT_API_ENDPOINT)?;
                let v: serde_json::Value =
                    serde_json::from_str(&text).map_err(|e| format!("json parse: {e}"))?;
                let tag = v
                    .get("tag_name")
                    .and_then(|x| x.as_str())
                    .ok_or_else(|| {
                        let msg = v
                            .get("message")
                            .and_then(|x| x.as_str())
                            .unwrap_or("unknown");
                        if msg.contains("rate limit") {
                            "GitHub API rate limited (anonymous quota 60/h/IP exhausted; the HTML route is the primary check and is not affected)".to_string()
                        } else {
                            format!("missing tag_name (API error response: {msg})")
                        }
                    })?;
                let html_url = v
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let release_url = if html_url.is_empty() {
                    format!("{DEFAULT_UPDATE_URL}/releases/tag/{tag}")
                } else {
                    html_url.to_string()
                };
                let body = v.get("body").and_then(|x| x.as_str()).unwrap_or("");
                let notes = truncate_notes(body);
                maybe_announce_update(
                    app,
                    &cache,
                    tag,
                    &release_url,
                    ignored.as_deref(),
                    Some(notes),
                    &endpoint,
                );
            }
        }
        Ok(())
    })();
    if let Err(e) = result {
        log_line(&format!("update check failed (silent): {e}"));
    }
}

/// Read the current pricing config as text, for the edit dialog in the panel.
fn pricing_read() -> String {
    match std::fs::read_to_string(usage_pricing_path()) {
        Ok(s) => s,
        Err(e) => format!("{{\"error\":{}}}", serde_json::to_string(&e.to_string()).unwrap_or_else(|_| "\"?\"".into())),
    }
}

/// Validate and write the pricing config back. Returns "ok" or an error string.
/// The sidecar re-reads the file on every emit, so a change lands within seconds.
///
/// `e.payload()` delivers the JSON-encoding of whatever JS emitted, which for a
/// JS emit of a *string* is the string itself wrapped in JSON quotes/escapes.
/// Accept both that and a direct JSON object, unwrap to the object, and write
/// it pretty — this avoids ever persisting a "JSON-string-wrapping-the-object".
fn pricing_write(pricing: &str) -> String {
    let as_obj = |v: serde_json::Value| -> Result<serde_json::Value, String> {
        match v {
            serde_json::Value::String(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
            other => Ok(other),
        }
    };
    let first: serde_json::Value = match serde_json::from_str(pricing) {
        Err(e) => return e.to_string(),
        Ok(v) => v,
    };
    let obj = match as_obj(first) {
        Err(e) => return e.to_string(),
        Ok(o) => o,
    };
    if !obj.is_object() {
        return "expected a JSON object for pricing".to_string();
    }
    let pretty = match serde_json::to_string_pretty(&obj) {
        Err(e) => return e.to_string(),
        Ok(s) => s,
    };
    let path = usage_pricing_path();
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return e.to_string();
        }
    }
    match std::fs::write(&path, pretty) {
        Ok(()) => "ok".to_string(),
        Err(e) => e.to_string(),
    }
}

fn main() {
    init_log();
    log_line("main() entered");
    let close_test = std::env::args().any(|a| a == "--close-test");
    log_line(&format!("close-test mode: {close_test}"));

    // Custom titlebar controls injected into every page load (the native
    // decorations are off by default). The script is idempotent (guards on
    // window.__deepseekHarnessControls). When desktop-settings.json sets
    // "decorations": true, use the native system titlebar instead and prepend
    // a flag so the injected script skips its custom caption bar (it still
    // forwards startup progress).
    let desktop = read_desktop_settings();
    let native_decorations = desktop.native_decorations;
    let usage_badge_enabled = desktop.usage_badge;
    let controls_js = include_str!("../window-controls.js");
    let controls_js = if native_decorations {
        format!("window.__deepseekHarnessNativeDecorations = true;\n{controls_js}")
    } else {
        controls_js.to_string()
    };
    // Daily-usage badge panel, injected on every page load (same mechanism as
    // the titlebar). Listens for `dsh-usage` events emitted from the sidecar.
    // Chart.js (bundled locally, see src-tauri/chart.umd.min.js) is prepended to
    // the panel script: initialization scripts run outside the page CSP, so the
    // library is always available to window.Chart inside the panel code.
    // Skipped entirely when desktop-settings.json sets "usageBadge": false.
    let usage_panel_js = if usage_badge_enabled {
        let chart_js = include_str!("../chart.umd.min.js");
        Some(format!("{chart_js}\n{}", include_str!("../usage-panel.js")))
    } else {
        None
    };
    // Update banner (always injected; Rust side decides whether to emit).
    let update_banner_js = include_str!("../update-banner.js");

    tauri::Builder::default()
        .setup(move |app| {
            let state = Arc::new(HarnessState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
            });
            app.manage(state.clone());

            // Daily-usage sidecar: spawn + read stdout on a background thread,
            // forwarding each JSON line as a `dsh-usage` event to the usage
            // panel. Disabled entirely when "usageBadge": false — no sidecar,
            // no real-time updates, no panel.
            let usage_state = Arc::new(UsageState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
                paused: Mutex::new(false),
            });
            app.manage(usage_state.clone());
            if usage_badge_enabled {
                let usage_app = app.handle().clone();
                let usage_state_thread = usage_state.clone();
                std::thread::spawn(move || {
                    log_line("usage sidecar: starting…");
                    match spawn_usage_sidecar(&usage_app) {
                        Ok(child) => {
                            let pid = child.id();
                            *usage_state_thread.pid.lock().unwrap() = Some(pid);
                            *usage_state_thread.child.lock().unwrap() = Some(child);
                            log_line(&format!("usage sidecar: pid stored={pid}"));
                            // Read the flag into a plain bool so this lock is
                            // released before set_usage_polling takes it again
                            // (Mutex is not reentrant) and so we never hold
                            // `child` and `paused` at the same time.
                            let was_paused = *usage_state_thread.paused.lock().unwrap();
                            if was_paused {
                                set_usage_polling(&usage_state_thread, true);
                            }
                        }
                        Err(e) => log_line(&format!("usage sidecar start failed: {e}")),
                    }
                });
                // Pricing read/save over events, not command-invoke: event IPC is
                // ACL-allowed on the remote harness page, whereas custom command
                // invoke is not allowed by default there.
                let pricing_app = app.handle().clone();
                app.handle().listen("usage-pricing-read", move |_e| {
                    let _ = pricing_app.emit("usage-pricing-data", pricing_read());
                });
                let pricing_app2 = app.handle().clone();
                app.handle().listen("usage-pricing-save", move |e| {
                    let payload = e.payload();
                    let ack = pricing_write(payload);
                    let _ = pricing_app2.emit("usage-pricing-saved", ack);
                });
                let usage_state_pause = usage_state.clone();
                app.handle().listen("usage-poll-pause", move |_e| {
                    set_usage_polling(&usage_state_pause, true);
                });
                let usage_state_resume = usage_state.clone();
                app.handle().listen("usage-poll-resume", move |_e| {
                    set_usage_polling(&usage_state_resume, false);
                });
            }

            // GitHub update check: once per launch (every launch, no interval
            // config — the HTML endpoint is quota-free so checking is cheap),
            // silent failure. Runs in parallel with dsh spawn; all errors only
            // log_line.
            //
            // The result is cached here so it can be re-emitted from on_page_load
            // (below): the check finishes on a background thread while the window
            // is still on the placeholder page, and a one-shot event would race
            // the banner listener on the real harness page. Re-emitting the
            // cached payload on every page-load "Finished" guarantees the banner
            // always receives it.
            let update_cache: Arc<Mutex<Option<serde_json::Value>>> = Arc::new(Mutex::new(None));
            {
                let update_app = app.handle().clone();
                let update_cache_thread = update_cache.clone();
                std::thread::spawn(move || {
                    check_update_once(&update_app, update_cache_thread);
                });
                app.handle().listen("dsh-update-ignore", move |event| {
                    let payload_str = event.payload();
                    let version_opt: Option<String> = (|| {
                        let v: serde_json::Value = serde_json::from_str(payload_str).ok()?;
                        let inner = match v {
                            serde_json::Value::String(s) => {
                                serde_json::from_str::<serde_json::Value>(&s).unwrap_or(serde_json::Value::String(s))
                            }
                            other => other,
                        };
                        if let Some(s) = inner.as_str() {
                            return Some(s.to_string());
                        }
                        if let Some(obj) = inner.as_object() {
                            if let Some(ver) = obj.get("version").and_then(|x| x.as_str()) {
                                return Some(ver.to_string());
                            }
                            if let Some(ver) = obj.get("ignoredUpdate").and_then(|x| x.as_str()) {
                                return Some(ver.to_string());
                            }
                        }
                        None
                    })();
                    if let Some(ver) = version_opt {
                        match persist_ignored_update(&ver) {
                            Ok(()) => log_line(&format!("update check: ignored version set to {ver}")),
                            Err(e) => log_line(&format!("update check: persist ignoredUpdate failed: {e}")),
                        }
                    } else {
                        log_line(&format!(
                            "update check: dsh-update-ignore bad payload: {payload_str}"
                        ));
                    }
                });
                // Update banner actions. The page cannot open windows (WebView2
                // swallows window.open) and cannot download files from the
                // remote harness origin, so both route through this event:
                //   {mode:"download"} → fetch the release asset matching this
                //     build straight into the Downloads folder (no browser);
                //   {mode:"download"} without a usable URL, {mode:"browser"},
                //     or any bad payload → open the release page in the system
                //     default browser, exactly as the banner always did.
                //
                // The listener captures an owned AppHandle, not `app`: the
                // closure later spawns the download thread, which requires a
                // Send context, and the setup closure's `&App` is not Send.
                let update_open_app = app.handle().clone();
                app.handle().listen("dsh-update-open", move |event| {
                    let app_handle = update_open_app.clone();
                    let payload_str = event.payload().to_string();
                    let payload = unwrap_event_payload(&payload_str);
                    let obj = payload.as_ref().and_then(|v| v.as_object());
                    let mode = obj
                        .and_then(|o| o.get("mode"))
                        .and_then(|x| x.as_str())
                        .unwrap_or("browser")
                        .to_string();
                    let url = obj
                        .and_then(|o| o.get("url").and_then(|x| x.as_str()))
                        .map(|s| s.to_string())
                        .or_else(|| payload.as_ref().and_then(|v| v.as_str()).map(|s| s.to_string()));
                    let name = obj
                        .and_then(|o| o.get("name"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_default();
                    let size = obj.and_then(|o| o.get("size")).and_then(|x| x.as_u64()).unwrap_or(0);
                    let digest = obj
                        .and_then(|o| o.get("digest"))
                        .and_then(|x| x.as_str())
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    // Where to send the user when a direct download cannot run.
                    let release_page = obj
                        .and_then(|o| o.get("releaseUrl"))
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| DEFAULT_UPDATE_URL.to_string());
                    match (mode.as_str(), url) {
                        ("download", Some(url)) if url.starts_with("http") => {
                            let file_name = if name.is_empty() {
                                filename_from_url(&url).unwrap_or_else(|| "deepseek-harness-update.exe".into())
                            } else {
                                name
                            };
                            log_line(&format!(
                                "update download: requested by banner -> {file_name} ({url})"
                            ));
                            // The download (and the sha256 step after it) blocks
                            // for up to DOWNLOAD_TIMEOUT_SECS, so it must not run
                            // on the event-loop thread.
                            let app_for_thread = app_handle.clone();
                            std::thread::spawn(move || {
                                download_update_asset(&app_for_thread, url, file_name, size, digest, release_page);
                            });
                        }
                        ("reveal", Some(path)) => {
                            // The banner's post-download shortcut: show the file
                            // that was just downloaded, selected in Explorer.
                            reveal_in_file_manager(std::path::Path::new(&path));
                        }
                        ("download", _) => {
                            log_line("update download: no usable asset URL in the banner request; opening the release page instead");
                            open_url_in_browser(&release_page);
                        }
                        _ => {
                            log_line(&format!("update check: opening release page: {release_page}"));
                            open_url_in_browser(&release_page);
                        }
                    }
                });
            }

            // WebView2 store self-healing. A stale/corrupt WebView2 user-data
            // store can make the harness page fail to load its client-plugin
            // bundles ("Failed to load plugins" / `client-modules: bundle
            // script … failed to load`), and it stays broken on every launch
            // and on every reload. The poisoned state also lives in the running
            // WebView2 process and the files are in use, so it cannot be cleared
            // in place: the injected detector (window-controls.js) reports the
            // failure here, this records a reset for the next launch and
            // relaunches the app once (release builds only — see below), instead
            // of leaving a permanently broken window. Bounded by MAX_AUTO_RESETS
            // so a non-store failure cannot loop.
            {
                let broken_seen = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let _broken_app = app.handle().clone();
                app.handle().listen("dsh-webview-broken", move |event| {
                    let signal = event.payload().to_string();
                    log_line(&format!("webview broken signal: {signal}"));
                    // One recovery per launch: the page can report several
                    // symptoms of the same broken boot.
                    if broken_seen.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        return;
                    }
                    if !request_webview_reset(&signal) {
                        return;
                    }
                    // Relaunching is a product feature for installed builds.
                    // Under `tauri dev` the cargo watcher owns the app lifecycle,
                    // so relaunching here could race it into two instances (and
                    // two dsh trees on one DSH_HOME — the corruption case the
                    // README warns about). Debug builds therefore only schedule
                    // the reset: the next dev start clears the store.
                    #[cfg(debug_assertions)]
                    {
                        log_line("webview recovery: debug build — reset scheduled, not relaunching");
                        return;
                    }
                    #[cfg(not(debug_assertions))]
                    {
                        let app = _broken_app.clone();
                        std::thread::spawn(move || {
                            // Let the log line land and the page settle before the
                            // window disappears.
                            std::thread::sleep(std::time::Duration::from_millis(1200));
                            let state = app.state::<Arc<HarnessState>>();
                            let pid = *state.pid.lock().unwrap();
                            log_line(&format!("webview recovery: killing harness pid={pid:?}"));
                            kill_tree(pid);
                            let usage_state = app.state::<Arc<UsageState>>();
                            let usage_pid = *usage_state.pid.lock().unwrap();
                            kill_tree(usage_pid);
                            let exe = match std::env::current_exe() {
                                Ok(exe) => exe,
                                Err(e) => {
                                    log_line(&format!("webview recovery: current_exe failed: {e}"));
                                    return;
                                }
                            };
                            // A fresh process is what actually gives WebView2 a new
                            // environment on the (now cleared) store; a reload in
                            // this process would not.
                            match std::process::Command::new(&exe)
                                .stdin(Stdio::null())
                                .stdout(Stdio::null())
                                .stderr(Stdio::null())
                                .spawn()
                            {
                                Ok(child) => log_line(&format!(
                                    "webview recovery: relaunched {} pid={}",
                                    exe.display(),
                                    child.id()
                                )),
                                Err(e) => {
                                    log_line(&format!("webview recovery: relaunch failed: {e}"));
                                    return;
                                }
                            }
                            log_line("webview recovery: exiting so the new instance starts clean");
                            std::process::exit(0);
                        });
                    }
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
            // updates instead of nothing at all.
            let mut window_builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("DeepSeek-Harness")
                    .inner_size(1280.0, 860.0)
                    .center()
                    .resizable(true)
                    .decorations(native_decorations)
                    .initialization_script(controls_js)
                    .initialization_script(update_banner_js);
            // Usage badge panel: only injected when enabled in desktop-settings.
            if let Some(panel_js) = usage_panel_js {
                window_builder = window_builder.initialization_script(panel_js);
            }
            let update_cache_load = update_cache.clone();
            let update_app_load = app.handle().clone();
            let usage_state_load = usage_state.clone();
            let usage_badge_load = usage_badge_enabled;
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
                                // Safety net for the usage-panel pause: if the
                                // previous page was discarded while the usage
                                // dialog was open, the panel's beforeunload
                                // resume event may have been lost. A fresh page
                                // means no modal is open anymore, so unpause the
                                // sidecar to keep the badge updating.
                                if usage_badge_load && *usage_state_load.paused.lock().unwrap() {
                                    set_usage_polling(&usage_state_load, false);
                                }
                                // Re-emit a cached update result so the banner
                                // listener on THIS page always gets it, even when
                                // the check completed before this page loaded.
                                if let Some(cached) = update_cache_load.lock().unwrap().clone() {
                                    let _ = update_app_load.emit("dsh-update-available", cached);
                                }
                            }
                        }
                    });
            // Give the WebView a dedicated data directory in both dev and
            // release builds (see prepare_webview_data_dir): dev keeps its own
            // stable store so a dev instance never bleeds into a running
            // release instance's WebView state, and release keeps one stable
            // store too — a bad store is cleared on demand by the recovery path
            // rather than on every launch, so normal startups pay nothing.
            let window_builder = window_builder.data_directory(prepare_webview_data_dir());
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
            let handle = app.handle().clone();
            let state_for_thread = state.clone();
            std::thread::spawn(move || {
                log_line("background thread started: spawning dsh…");
                emit_startup(&handle, "info", "locate", "正在定位 dsh 并启动（首次开机冷启动可能较慢）…");
                let result = (|| -> Result<String, String> {
                    let child = spawn_harness().map_err(|e| {
                        let msg = format!(
                            "未找到 dsh：{e}。请先安装 Node >= 22 并全局安装：npm install -g @deepseek-ai/dsh \
                             （或设置 DSH_BIN 指向 dsh 的 lib/bin.js 绝对路径）"
                        );
                        log_line(&format!("spawn_harness failed: {msg}"));
                        msg
                    })?;
                    let pid = child.id();
                    *state_for_thread.pid.lock().unwrap() = Some(pid);
                    *state_for_thread.child.lock().unwrap() = Some(child);
                    log_line(&format!("child stored pid={pid}; waiting for ready URL"));
                    emit_startup(&handle, "info", "wait", "dsh 已启动，等待服务就绪…");
                    read_ready_url(state_for_thread.child.lock().unwrap().as_mut().unwrap())
                })();

                match result {
                    Ok(url) => {
                        log_line(&format!("harness ready: {url}; navigating"));
                        emit_startup(&handle, "info", "ready", "服务已就绪，正在加载界面…");
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
                        kill_tree(*state_for_thread.pid.lock().unwrap());
                        // Keep the window open with the reason on the
                        // placeholder page (styled as an error) instead of a
                        // silent exit — the user can close it via the custom
                        // titlebar X, which still runs the cleanup path.
                        emit_startup(&handle, "error", "error", format!("{msg}\n\n详细日志：{}", log_path().display()));
                    }
                }
            });

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
                let usage_state = window.state::<Arc<UsageState>>();
                let usage_pid = *usage_state.pid.lock().unwrap();
                log_line(&format!("killing usage sidecar pid={usage_pid:?}"));
                kill_tree(usage_pid);
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
                let usage_state = app_handle.state::<Arc<UsageState>>();
                let usage_pid = *usage_state.pid.lock().unwrap();
                kill_tree(usage_pid);
            }
            if let tauri::RunEvent::Exit = event {
                log_line("RunEvent::Exit — app finished");
            }
        });
}

// ── Tests for the update-download helpers ────────────────────────────────────
// Pure logic only (no network, no Tauri state): which release asset the banner
// picks for this build, how the tag API URL is derived, and that a download can
// never write outside the Downloads folder or clobber an existing file.
// Run with `cargo test --bin deepseek-harness`.
#[cfg(test)]
mod update_download_tests {
    use super::*;

    /// Mirror of the release layout the workflow publishes.
    fn release_json() -> serde_json::Value {
        serde_json::json!({
            "tag_name": "v0.1.18",
            "assets": [
                { "name": "DeepSeek-Harness_0.1.18_x64_en-US.msi", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.18/a.msi", "size": 9_000_000, "digest": "sha256:aaa" },
                { "name": "DeepSeek-Harness_0.1.18_x64-setup.exe", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.18/a-setup.exe", "size": 8_000_000, "digest": "sha256:bbb" },
                { "name": "DeepSeek-Harness_0.1.18_x64-setup.exe.sig", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.18/a-setup.exe.sig", "size": 400 },
                { "name": "DeepSeek-Harness_0.1.18_x64-portable.exe", "browser_download_url": "https://github.com/o/r/releases/download/v0.1.18/a-portable.exe", "size": 7_000_000, "digest": "sha256:ccc" },
                { "name": "source.tar.gz", "browser_download_url": "https://github.com/o/r/archive/x.tar.gz", "size": 1000 }
            ]
        })
    }

    #[test]
    fn file_name_classification() {
        assert_eq!(classify_asset("DeepSeek-Harness_0.1.8_x64-setup.exe"), Some("installer"));
        assert_eq!(classify_asset("DeepSeek-Harness_0.1.8_x64-portable.exe"), Some("portable"));
        assert_eq!(classify_asset("DeepSeek-Harness_0.1.8_x64_en-US.msi"), Some("msi"));
        assert_eq!(classify_asset("deepseek-harness.exe"), Some("portable"));
        // Signatures / archives / checksums are never offered as a download.
        assert_eq!(classify_asset("x-setup.exe.sig"), None);
        assert_eq!(classify_asset("source.tar.gz"), None);
        assert_eq!(classify_asset("SHA256SUMS.txt"), None);
    }

    #[test]
    fn portable_build_prefers_the_portable_exe() {
        let portable = asset_rank("portable", true, "DeepSeek-Harness_0.1.18_x64-portable.exe");
        let setup = asset_rank("installer", true, "DeepSeek-Harness_0.1.18_x64-setup.exe");
        let msi = asset_rank("msi", true, "a.msi");
        assert!(portable < setup, "portable {portable} should win over setup {setup}");
        assert!(setup < msi);
    }

    #[test]
    fn installed_build_prefers_the_nsis_setup() {
        let portable = asset_rank("portable", false, "DeepSeek-Harness_0.1.18_x64-portable.exe");
        let setup = asset_rank("installer", false, "DeepSeek-Harness_0.1.18_x64-setup.exe");
        let msi = asset_rank("msi", false, "a.msi");
        assert!(setup < portable, "setup {setup} should win over portable {portable}");
        assert!(portable < msi);
    }

    #[test]
    fn x64_wins_over_unknown_arch() {
        let x64 = asset_rank("portable", true, "DeepSeek-Harness_0.1.18_x64-portable.exe");
        let unknown = asset_rank("portable", true, "DeepSeek-Harness_0.1.18-portable.exe");
        assert!(x64 < unknown);
    }

    #[test]
    fn asset_list_is_filtered_and_ranked_for_this_build() {
        let assets = collect_assets(&release_json());
        assert_eq!(assets.len(), 3, "signatures and source archives must be dropped: {assets:?}");
        let expected_lead = if running_portable() {
            "DeepSeek-Harness_0.1.18_x64-portable.exe"
        } else {
            "DeepSeek-Harness_0.1.18_x64-setup.exe"
        };
        assert_eq!(assets[0].name, expected_lead);
        // Whichever leads, the other build kind is second and the MSI last, so a
        // shuffle in the release asset order cannot change the pick.
        assert_ne!(assets[0].kind, "msi");
        assert_eq!(assets[2].kind, "msi");
        assert_eq!(assets[0].digest, "sha256:ccc");
        assert_eq!(assets[0].size, 7_000_000);
        assert!(assets.iter().all(|a| a.url.starts_with("https://")));
        assert_eq!(asset_kind_label("portable"), "免安装版");
        assert_eq!(asset_kind_label("installer"), "安装版（NSIS 安装包）");
    }

    #[test]
    fn derived_assets_work_without_the_github_api() {
        // The anonymous API quota (60/h/IP) is easily exhausted behind a shared
        // or VPN address; the download must still be offered then.
        let endpoint = "https://github.com/ai-written/DeepSeek-Harness/releases/latest";
        let assets = derived_assets(endpoint, "v0.1.18");
        assert_eq!(assets.len(), 3);
        let portable = assets.iter().find(|a| a.kind == "portable").unwrap();
        let installer = assets.iter().find(|a| a.kind == "installer").unwrap();
        let msi = assets.iter().find(|a| a.kind == "msi").unwrap();
        assert_eq!(portable.name, "DeepSeek-Harness_0.1.18_x64-portable.exe");
        assert_eq!(
            portable.url,
            "https://github.com/ai-written/DeepSeek-Harness/releases/download/v0.1.18/DeepSeek-Harness_0.1.18_x64-portable.exe"
        );
        assert_eq!(installer.name, "DeepSeek-Harness_0.1.18_x64-setup.exe");
        assert_eq!(msi.name, "DeepSeek-Harness_0.1.18_x64_en-US.msi");
        // Still ranked for this build, and sizes/digests are simply unknown.
        let expected_lead = if running_portable() { "portable" } else { "installer" };
        assert_eq!(assets[0].kind, expected_lead);
        assert_eq!(assets[0].size, 0);
        assert!(assets[0].digest.is_empty());
        // A tag with an uppercase V or no prefix resolves to the same version.
        assert_eq!(derived_assets(endpoint, "V0.1.18")[0].name.contains("0.1.18_"), true);
        assert_eq!(derived_assets(endpoint, "0.1.18")[0].name.contains("0.1.18_"), true);
        // A non-GitHub mirror has no derivable release path.
        assert!(derived_assets("https://mirror.example.com/latest", "v1").is_empty());
        // A tag that is not a version at all cannot name an asset.
        assert!(derived_assets(endpoint, "v").is_empty());
        assert!(derived_assets(endpoint, "latest").is_empty());
    }

    #[test]
    fn release_api_url_is_derived_from_the_endpoint() {
        let endpoint = "https://github.com/ai-written/DeepSeek-Harness/releases/latest";
        assert_eq!(
            release_api_url_for_tag(endpoint, "v0.1.18").as_deref(),
            Some("https://api.github.com/repos/ai-written/DeepSeek-Harness/releases/tags/v0.1.18")
        );
        // A tag needing escaping is percent-encoded.
        assert_eq!(
            release_api_url_for_tag(endpoint, "v1.0.0+rc1").as_deref(),
            Some("https://api.github.com/repos/ai-written/DeepSeek-Harness/releases/tags/v1.0.0%2Brc1")
        );
        // A non-GitHub mirror has no tag API -> no direct download.
        assert_eq!(release_api_url_for_tag("https://mirror.example.com/latest", "v1"), None);
    }

    #[test]
    fn download_names_stay_inside_the_download_folder() {
        assert_eq!(
            filename_from_url("https://github.com/o/r/releases/download/v0.1.18/DeepSeek-Harness_0.1.18_x64-portable.exe").as_deref(),
            Some("DeepSeek-Harness_0.1.18_x64-portable.exe")
        );
        assert_eq!(
            filename_from_url("https://x.test/a/b/file.exe?token=1#frag").as_deref(),
            Some("file.exe")
        );
        assert_eq!(filename_from_url("https://x.test/").as_deref(), None);
        // Path separators can never survive into the resolved name.
        assert_eq!(sanitize_filename("..\\..\\evil.exe"), "evil.exe");
        assert_eq!(sanitize_filename("a/b:c.exe"), "abc.exe");
        assert_eq!(sanitize_filename("..."), "");
    }

    #[test]
    fn a_retry_reuses_the_partial_file_left_by_the_previous_attempt() {
        let dir = std::env::temp_dir().join("dsh-update-test-partial");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing on disk: the exact name is used.
        let exact = dir.join("DeepSeek-Harness_0.1.18_x64-portable.exe.part");
        assert_eq!(pick_partial(&exact, &dir).unwrap(), exact);
        // An unrelated download's partial must never be picked up.
        std::fs::write(dir.join("other-file.part"), b"xxxxx").unwrap();
        assert_eq!(pick_partial(&exact, &dir).unwrap(), exact);

        // A failed attempt left a partial under the exact name: reuse it.
        std::fs::write(&exact, vec![0u8; 4096]).unwrap();
        assert_eq!(pick_partial(&exact, &dir).unwrap(), exact);

        // A failed attempt left the FINAL file behind, so the retry's free path is
        // "… (2).exe" — the partial from attempt 1 must still be found, not
        // silently restarted from zero.
        std::fs::remove_file(&exact).unwrap();
        std::fs::write(dir.join("DeepSeek-Harness_0.1.18_x64-portable.exe"), b"attempt 1").unwrap();
        let retry_final = resolve_free_path(&dir, "DeepSeek-Harness_0.1.18_x64-portable.exe");
        assert_eq!(retry_final.file_name().unwrap(), "DeepSeek-Harness_0.1.18_x64-portable (2).exe");
        std::fs::write(
            dir.join("DeepSeek-Harness_0.1.18_x64-portable.exe.part"),
            vec![0u8; 8192],
        )
        .unwrap();
        let reused = pick_partial(
            &std::path::PathBuf::from(format!("{}.part", retry_final.display())),
            dir_of(&retry_final),
        )
        .unwrap();
        assert_eq!(
            reused.file_name().unwrap(),
            "DeepSeek-Harness_0.1.18_x64-portable.exe.part"
        );
        assert_eq!(std::fs::metadata(&reused).unwrap().len(), 8192);

        // With several partials for the same download, keep the most complete one
        // (resuming the largest wastes the least bandwidth).
        std::fs::write(
            dir.join("DeepSeek-Harness_0.1.18_x64-portable (3).exe.part"),
            vec![0u8; 9000],
        )
        .unwrap();
        let reused = pick_partial(
            &std::path::PathBuf::from(format!("{}.part", retry_final.display())),
            dir_of(&retry_final),
        )
        .unwrap();
        assert_eq!(
            reused.file_name().unwrap(),
            "DeepSeek-Harness_0.1.18_x64-portable (3).exe.part"
        );
        assert_eq!(std::fs::metadata(&reused).unwrap().len(), 9000);

        // A different download's partial is never reused, however large, even
        // when its name shares the prefix.
        std::fs::write(dir.join("DeepSeek-Harness_0.1.18_x64-setup.exe.part"), vec![0u8; 99999]).unwrap();
        let reused = pick_partial(
            &std::path::PathBuf::from(format!("{}.part", retry_final.display())),
            dir_of(&retry_final),
        )
        .unwrap();
        assert_eq!(std::fs::metadata(&reused).unwrap().len(), 9000);
        let _ = std::fs::remove_dir_all(&dir);
    }


    #[test]
    fn existing_downloads_are_never_clobbered() {
        let dir = std::env::temp_dir().join("dsh-update-test-resolve");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let name = "DeepSeek-Harness_0.1.18_x64-portable.exe";
        let first = resolve_free_path(&dir, name);
        assert_eq!(first, dir.join(name));
        std::fs::write(&first, b"x").unwrap();
        let second = resolve_free_path(&dir, name);
        assert_eq!(second, dir.join("DeepSeek-Harness_0.1.18_x64-portable (2).exe"));
        std::fs::write(&second, b"x").unwrap();
        assert_eq!(
            resolve_free_path(&dir, name),
            dir.join("DeepSeek-Harness_0.1.18_x64-portable (3).exe")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

