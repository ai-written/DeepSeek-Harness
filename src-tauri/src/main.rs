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

use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager, WindowEvent};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Parse the ready line `dsh web: http://127.0.0.1:<port>`.
const URL_LINE_RE: &str = "dsh web: http://127.0.0.1:";

struct HarnessState {
    child: Mutex<Option<Child>>,
    pid: Mutex<Option<u32>>,
}

/// Startup progress forwarded to the placeholder page (`dsh-startup` event).
/// The window is now visible from the moment it opens, so a cold first launch
/// after boot shows live feedback instead of an empty/nonexistent window.
#[derive(serde::Serialize, Clone)]
struct StartupMsg {
    level: &'static str,
    message: String,
}

fn emit_startup(app: &tauri::AppHandle, level: &'static str, message: impl Into<String>) {
    let _ = app.emit("dsh-startup", StartupMsg {
        level,
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

fn spawn_harness() -> std::io::Result<Child> {
    let args = ["--profile", "web", "--port", "0"];
    #[cfg(target_os = "windows")]
    {
        let node = locate_node()?;
        let bin_js = locate_dsh_bin_js()?;
        let mut cmd = Command::new(node);
        cmd.arg(&bin_js).args(args);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
    }
    #[cfg(not(target_os = "windows"))]
    {
        let mut cmd = Command::new("dsh");
        cmd.args(args);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
    }
}

/// Find `node.exe` by scanning PATH for the directory that also holds the
/// `dsh.cmd` shim (they are siblings in the npm global install dir). This
/// avoids spawning `where`/`cmd` (which would flash a console window).
#[cfg(target_os = "windows")]
fn locate_node() -> std::io::Result<std::path::PathBuf> {
    let path_var = std::env::var_os("PATH").ok_or_else(|| std::io::Error::other("PATH not set"))?;
    for dir in std::env::split_paths(&path_var) {
        let node = dir.join("node.exe");
        let shim = dir.join("dsh.cmd");
        if node.exists() && shim.exists() {
            return Ok(node);
        }
    }
    // Fall back to any node.exe on PATH (dsh might be shimmed elsewhere).
    for dir in std::env::split_paths(&path_var) {
        let node = dir.join("node.exe");
        if node.exists() {
            return Ok(node);
        }
    }
    Err(std::io::Error::other(
        "node.exe not found — install Node >= 22 and run `npm install -g @deepseek-ai/dsh`",
    ))
}

/// Resolve `node_modules/@deepseek-ai/dsh/lib/bin.js` relative to the node
/// install directory found by [`locate_node`].
#[cfg(target_os = "windows")]
fn locate_dsh_bin_js() -> std::io::Result<std::path::PathBuf> {
    let node = locate_node()?;
    let dir = node
        .parent()
        .ok_or_else(|| std::io::Error::other("node.exe has no parent dir"))?;
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
fn read_ready_url(child: &mut Child) -> Result<String, String> {
    let stdout = child.stdout.take().ok_or("no stdout on dsh child")?;
    let (tx, rx) = std::sync::mpsc::channel();
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
                let _ = tx.send(Ok(format!("http://127.0.0.1:{url}")));
                return;
            }
        }
        let _ = tx.send(Err("dsh exited before printing its URL".into()));
    });
    rx.recv_timeout(std::time::Duration::from_secs(120))
        .map_err(|_| "dsh 启动超时（120s）。请检查 DSH_HOME 下 web profile 的首次初始化是否卡住。".to_string())?
}

/// Kill the harness process tree. On Windows this is a synchronous taskkill
/// /T /F (the tree may include cmd shims, ripgrep, shells); on POSIX signal
/// the process group.
fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    if cfg!(target_os = "windows") {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = cmd.status();
    } else {
        let _ = Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

fn main() {
    let close_test = std::env::args().any(|a| a == "--close-test");

    // Custom titlebar controls injected into every page load (the native
    // decorations are off via tauri.conf.json decorations:false). The script
    // is idempotent (guards on window.__deepseekHarnessControls).
    let controls_js = include_str!("../window-controls.js");

    tauri::Builder::default()
        .setup(move |app| {
            let state = Arc::new(HarnessState {
                child: Mutex::new(None),
                pid: Mutex::new(None),
            });
            app.manage(state.clone());

            // Create the main window in code so the custom titlebar controls
            // can be injected as an initialization script (runs on the
            // placeholder page AND after navigate to the harness URL).
            //
            // The window is visible right away: the placeholder page is shown
            // immediately. During a cold first launch after boot the dsh
            // spawn can take a while (cold file cache + Defender rescans), so
            // the user sees the "正在启动…" placeholder with live status
            // updates instead of nothing at all.
            let _window = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("DeepSeek-Harness")
                .inner_size(1280.0, 860.0)
                .center()
                .resizable(true)
                .decorations(false)
                .initialization_script(controls_js)
                .build()
                .expect("failed to build main window");

            if close_test {
                // After the harness is up, auto-close the window through the
                // normal Tauri path to exercise the cleanup handlers.
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    eprintln!("[deepseek-harness] close-test: closing window");
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
                emit_startup(&handle, "info", "正在定位 dsh 并启动（首次开机冷启动可能较慢）…");
                let result = (|| -> Result<String, String> {
                    let child = spawn_harness().map_err(|e| {
                        format!(
                            "未找到 dsh：{e}。请先安装 Node >= 22 并全局安装：npm install -g @deepseek-ai/dsh \
                             （或设置 DSH_BIN 指向 dsh 的 lib/bin.js 绝对路径）"
                        )
                    })?;
                    let pid = child.id();
                    *state_for_thread.pid.lock().unwrap() = Some(pid);
                    *state_for_thread.child.lock().unwrap() = Some(child);
                    emit_startup(&handle, "info", "dsh 已启动，等待服务就绪…");
                    read_ready_url(state_for_thread.child.lock().unwrap().as_mut().unwrap())
                })();

                match result {
                    Ok(url) => {
                        emit_startup(&handle, "info", "服务已就绪，正在加载界面…");
                        eprintln!("[deepseek-harness] harness ready: {url}");
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.navigate(url.parse().expect("loopback url"));
                            let _ = window.show();
                            let _ = window.set_focus();
                            eprintln!("[deepseek-harness] window navigated & shown");
                        } else {
                            eprintln!("[deepseek-harness] ERROR: main window not found");
                        }
                    }
                    Err(msg) => {
                        eprintln!("[deepseek-harness] harness startup failed: {msg}");
                        kill_tree(*state_for_thread.pid.lock().unwrap());
                        // Keep the window open with the reason on the
                        // placeholder page (styled as an error) instead of a
                        // silent exit — the user can close it via the custom
                        // titlebar X, which still runs the cleanup path.
                        emit_startup(&handle, "error", &msg);
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
                eprintln!("[deepseek-harness] CloseRequested fired");
                let state = window.state::<Arc<HarnessState>>();
                let pid = *state.pid.lock().unwrap();
                eprintln!("[deepseek-harness] killing harness pid={pid:?}");
                kill_tree(pid);
                window.app_handle().exit(0);
                eprintln!("[deepseek-harness] exit requested");
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                eprintln!("[deepseek-harness] RunEvent::ExitRequested");
                let state = app_handle.state::<Arc<HarnessState>>();
                let pid = *state.pid.lock().unwrap();
                kill_tree(pid);
            }
            if let tauri::RunEvent::Exit = event {
                eprintln!("[deepseek-harness] RunEvent::Exit");
            }
        });
}
