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

/// WebView2 data directory for dev builds: separate from the release app so a
/// dev instance never shares cookies/localStorage/WebView2 process state with
/// a running release instance (same bundle identifier → same default
/// directory → cross-instance page bleed, e.g. the dev window loading the
/// release window's page). Falls back to TEMP when %LOCALAPPDATA% is not
/// writable (policy/sandbox) — a failed webview data dir is fatal, unlike a
/// failed log.
#[cfg(debug_assertions)]
fn webview_data_dir() -> std::path::PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let dir = base
        .join("com.deepseekharness.desktop")
        .join("deepseek-harness-dev");
    if std::fs::create_dir_all(&dir).is_ok() {
        dir
    } else {
        std::env::temp_dir().join("deepseek-harness-dev-webview")
    }
}

/// Whether the installed dsh web supports `--no-open`; feature-detected once
/// per process by asking the web command's `--help` (see supports_no_open).
static SUPPORTS_NO_OPEN: OnceLock<bool> = OnceLock::new();

fn spawn_harness() -> std::io::Result<Child> {
    // Newer dsh web versions open the default browser by default; the shell
    // serves the UI in its own WebView instead. Only pass --no-open when the
    // installed dsh understands it — older versions reject the unknown option
    // and abort the boot (see supports_no_open).
    let mut args = vec!["--profile", "web", "--port", "0"];
    if supports_no_open() {
        args.insert(2, "--no-open");
    }
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

/// Run `dsh --profile web --help` and return its stdout (None when the probe
/// itself fails: dsh/node missing or a spawn error). The web app parses flags
/// before binding anything, so this starts no server and needs no profile.
fn dsh_help_output() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let bin_js = locate_dsh_bin_js().ok()?;
        let node = locate_node(npm_install_dir(&bin_js).as_deref()).ok()?;
        let output = Command::new(node)
            .arg(&bin_js)
            .args(["--profile", "web", "--help"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        String::from_utf8(output.stdout).ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = Command::new("dsh")
            .args(["--profile", "web", "--help"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        String::from_utf8(output.stdout).ok()
    }
}

/// Whether the installed dsh web supports `--no-open` (detected once per
/// process). Older dsh versions reject the flag as an unknown option and abort
/// the boot, so the shell only passes it when the help text lists it. When the
/// probe cannot run, defaults to false: an older dsh keeps its old behavior,
/// and a newer one may open the browser — cosmetic, not fatal.
fn supports_no_open() -> bool {
    *SUPPORTS_NO_OPEN.get_or_init(|| {
        let supported = dsh_help_output()
            .map(|help| help.contains("--no-open"))
            .unwrap_or(false);
        log_line(&format!("dsh web supports --no-open: {supported}"));
        supported
    })
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
        .stdin(Stdio::null())
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
        .stdin(Stdio::null())
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

/// Resolve the pricing config file path (shared with the sidecar).
fn usage_pricing_path() -> std::path::PathBuf {
    let home = std::env::var("DSH_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
        });
    home.join(".dsh").join("storages").join("usage-pricing.json")
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
    // decorations are off via tauri.conf.json decorations:false). The script
    // is idempotent (guards on window.__deepseekHarnessControls).
    let controls_js = include_str!("../window-controls.js");
    // Daily-usage badge panel, injected on every page load (same mechanism as
    // the titlebar). Listens for `dsh-usage` events emitted from the sidecar.
    // Chart.js (bundled locally, see src-tauri/chart.umd.min.js) is prepended to
    // the panel script: initialization scripts run outside the page CSP, so the
    // library is always available to window.Chart inside the panel code.
    let chart_js = include_str!("../chart.umd.min.js");
    let usage_panel_js = format!("{chart_js}\n{}", include_str!("../usage-panel.js"));

    tauri::Builder::default()
        .setup(move |app| {
            let state = Arc::new(HarnessState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
            });
            app.manage(state.clone());

            // Daily-usage sidecar: spawn + read stdout on a background thread,
            // forwarding each JSON line as a `dsh-usage` event to the usage panel.
            let usage_state = Arc::new(UsageState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
            });
            app.manage(usage_state.clone());
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

            // Create the main window in code so the custom titlebar controls
            // can be injected as an initialization script (runs on the
            // placeholder page AND after navigate to the harness URL).
            //
            // The window is visible right away: the placeholder page is shown
            // immediately. During a cold first launch after boot the dsh
            // spawn can take a while (cold file cache + Defender rescans), so
            // the user sees the "正在启动…" placeholder with live status
            // updates instead of nothing at all.
            let window_builder =
                tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                    .title("DeepSeek-Harness")
                    .inner_size(1280.0, 860.0)
                    .center()
                    .resizable(true)
                    .decorations(false)
                    .initialization_script(controls_js)
                    .initialization_script(usage_panel_js)
                    // Log every page load (placeholder page AND the harness URL) so
                    // the log confirms the WebView actually reached the dsh UI —
                    // if navigation fails, the harness URL never appears here.
                    .on_page_load(|_window, payload| {
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
            // Dev builds get their own WebView2 data directory (see
            // webview_data_dir) so a dev instance never bleeds into a running
            // release instance's WebView state. The cfg'd `let` shadows the
            // builder only in debug builds, so release builds never reassign
            // it and rustc doesn't warn about an unused `mut`.
            #[cfg(debug_assertions)]
            let window_builder = window_builder.data_directory(webview_data_dir());
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
