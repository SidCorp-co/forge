use super::{log, AgentSession, AgentStatus, Sessions, prune_sessions};
pub(crate) use super::platform::to_wsl_path;
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// Default agent timeout: 30 minutes.
const AGENT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Resolve the claude binary path by checking common locations.
/// Caches result in a OnceLock for subsequent calls.
#[cfg(not(target_os = "windows"))]
fn resolve_claude_bin() -> &'static str {
    use std::sync::OnceLock;
    static CLAUDE_BIN: OnceLock<String> = OnceLock::new();
    CLAUDE_BIN.get_or_init(|| {
        // Try to resolve via NVM on the host (non-Windows)
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(output) = std::process::Command::new("bash")
                .args(["-lc", "which claude"])
                .output()
            {
                if output.status.success() {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    if !path.is_empty() {
                        log(&format!("[resolve] claude binary: {path}"));
                        return path;
                    }
                }
            }
        }
        // Fallback: assume it's in PATH
        "claude".to_string()
    })
}

/// Check if claude CLI is available natively on Windows (not WSL).
/// Resolve the full path to native Windows claude binary.
#[cfg(target_os = "windows")]
fn resolve_native_claude_path() -> String {
    use std::sync::OnceLock;
    static CLAUDE_PATH: OnceLock<String> = OnceLock::new();
    CLAUDE_PATH.get_or_init(|| {
        if let Ok(output) = std::process::Command::new("cmd")
            .args(["/c", "where", "claude"])
            .output()
        {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or("claude")
                    .trim()
                    .to_string();
                if !path.is_empty() {
                    return path;
                }
            }
        }
        "claude".to_string()
    }).clone()
}

#[cfg(target_os = "windows")]
pub(crate) fn has_native_claude() -> bool {
    use std::sync::OnceLock;
    static HAS_NATIVE: OnceLock<bool> = OnceLock::new();
    *HAS_NATIVE.get_or_init(|| {
        let result = std::process::Command::new("cmd")
            .args(["/c", "where", "claude"])
            .output();
        match result {
            Ok(output) => {
                let found = output.status.success();
                if found {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    log(&format!("[resolve] native Windows claude: {path}"));
                }
                found
            }
            Err(_) => false,
        }
    })
}

/// Check if claude CLI is available inside WSL.
#[cfg(target_os = "windows")]
pub(crate) fn has_wsl_claude() -> bool {
    use std::sync::OnceLock;
    static HAS_WSL: OnceLock<bool> = OnceLock::new();
    *HAS_WSL.get_or_init(|| {
        let distro = resolve_wsl_distro();
        let result = std::process::Command::new("wsl")
            .args(["-d", &distro, "bash", "-lc", "which claude"])
            .output();
        match result {
            Ok(output) => {
                let found = output.status.success();
                if found {
                    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    log(&format!("[resolve] WSL claude: {path}"));
                }
                found
            }
            Err(_) => false,
        }
    })
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn has_wsl_claude() -> bool { false }

/// Detect "out of extra usage" in a Claude CLI JSON message.
/// Checks text content blocks, system messages, and top-level error fields.
/// Returns the matched message string if found.
fn detect_usage_limit(json: &Value) -> Option<String> {
    // Check message.content text blocks (assistant/system messages)
    if let Some(content) = json.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                    if text.to_lowercase().contains("out of extra usage") {
                        return Some(text.chars().take(500).collect());
                    }
                }
            }
        }
    }
    // Check system-type messages
    if json.get("type").and_then(|t| t.as_str()) == Some("system") {
        let s = json.to_string();
        if s.to_lowercase().contains("out of extra usage") {
            return Some(s.chars().take(500).collect());
        }
    }
    // Check top-level error field
    if let Some(err) = json.get("error").and_then(|e| e.as_str()) {
        if err.to_lowercase().contains("out of extra usage") {
            return Some(err.chars().take(500).collect());
        }
    }
    None
}

/// Build a tokio Command that spawns claude directly (no shell wrapper).
/// On Windows: respects claude_mode config ("native", "wsl", or "auto").
///   - "native": only use Windows Claude, error if not found
///   - "wsl": only use WSL Claude
///   - "auto" (default): prefer native, fall back to WSL
/// On Linux/Mac: spawns claude binary directly with args.
/// Returns (Command, Option<temp_script_path>) — caller should clean up the script.
pub(crate) fn build_command(args: &[&str], repo_path: &str) -> Result<(Command, Option<std::path::PathBuf>), String> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let claude_mode = crate::config::load_config().claude_mode.unwrap_or_default();
        let use_native = match claude_mode.as_str() {
            "native" => {
                if !has_native_claude() {
                    return Err("claude_mode is 'native' but Claude CLI not found in Windows PATH. Install Claude or change claude_mode to 'wsl'.".to_string());
                }
                true
            }
            "wsl" => false,
            _ => {
                // Auto: prefer WSL if available, fall back to native
                let has_wsl = has_wsl_claude();
                if has_wsl { false } else { has_native_claude() }
            }
        };

        if use_native {
            // Native Windows: run claude directly with Windows paths
            let win_path = super::platform::to_windows_path(repo_path);
            let claude_bin = resolve_native_claude_path();
            log(&format!("[cmd] {} {} (cwd={})", claude_bin, args.join(" "), win_path));
            let mut std_cmd = std::process::Command::new(&claude_bin);
            std_cmd.args(args)
                .current_dir(&win_path)
                .creation_flags(CREATE_NO_WINDOW);
            std_cmd.env_remove("CLAUDECODE");
            return Ok((Command::from(std_cmd), None));
        }

        // Fallback: WSL mode
        let wsl_path = to_wsl_path(repo_path);
        let claude_args: Vec<String> = args.iter().map(|a| {
            if a.contains(' ') || a.contains('"') || a.contains('\'') || a.contains('\n') {
                format!("'{}'", a.replace('\'', "'\\''"))
            } else {
                a.to_string()
            }
        }).collect();
        let shell_cmd = format!(
            "unset CLAUDECODE && export PATH=\"$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node 2>/dev/null | tail -1)/bin:$PATH\" && export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" 2>/dev/null; cd '{}' && claude {}",
            wsl_path, claude_args.join(" ")
        );

        let script_path = std::env::temp_dir().join(format!("forge-cmd-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&script_path, &shell_cmd)
            .map_err(|e| format!("Failed to write temp script: {e}"))?;
        let wsl_script = to_wsl_path(&script_path.to_string_lossy());

        let wsl_distro = resolve_wsl_distro();
        let wsl_user = resolve_wsl_user(&wsl_distro);
        let wsl_cmd = if wsl_user.is_empty() {
            format!("wsl -d {} bash -l {}", wsl_distro, wsl_script)
        } else {
            format!("wsl -d {} -u {} bash -l {}", wsl_distro, wsl_user, wsl_script)
        };
        log(&format!("[cmd] {wsl_cmd}"));

        let mut std_cmd = std::process::Command::new("cmd");
        std_cmd.args(["/c", &wsl_cmd])
            .creation_flags(CREATE_NO_WINDOW);
        Ok((Command::from(std_cmd), Some(script_path)))
    }

    #[cfg(not(target_os = "windows"))]
    {
        let claude_bin = resolve_claude_bin();
        log(&format!("[cmd] {} {} (cwd={})", claude_bin, args.join(" "), repo_path));
        let mut cmd = Command::new(claude_bin);
        cmd.args(args)
            .current_dir(repo_path);
        cmd.env_remove("CLAUDECODE");
        Ok((cmd, None))
    }
}

/// Resolve the default WSL distro name.
#[cfg(target_os = "windows")]
fn resolve_wsl_distro() -> String {
    use std::sync::OnceLock;
    static WSL_DISTRO: OnceLock<String> = OnceLock::new();
    WSL_DISTRO.get_or_init(|| {
        if let Ok(output) = std::process::Command::new("wsl")
            .args(["--list", "--quiet"])
            .output()
        {
            if output.status.success() {
                // wsl --list outputs UTF-16LE on Windows; decode accordingly
                let out = if output.stdout.len() >= 2 && output.stdout[0] == 0xFF && output.stdout[1] == 0xFE {
                    // Has BOM — skip it
                    let u16s: Vec<u16> = output.stdout[2..].chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else if output.stdout.iter().any(|&b| b == 0) {
                    // No BOM but contains null bytes — likely UTF-16LE
                    let u16s: Vec<u16> = output.stdout.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else {
                    String::from_utf8_lossy(&output.stdout).into_owned()
                };
                // Find first non-empty, non-docker distro
                let distros: Vec<String> = out.lines()
                    .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                log(&format!("[wsl] available distros: {:?}", distros));
                if let Some(distro) = distros.iter().find(|d| !d.to_lowercase().contains("docker")) {
                    log(&format!("[wsl] detected distro: {distro}"));
                    return distro.clone();
                }
                if let Some(distro) = distros.first() {
                    log(&format!("[wsl] detected distro (docker): {distro}"));
                    return distro.clone();
                }
            }
        }
        log("[wsl] fallback to Ubuntu-24.04");
        "Ubuntu-24.04".to_string()
    }).clone()
}

/// Resolve the default WSL user for a given distro.
/// Runs `wsl -d <distro> whoami` to get the user that has Claude logged in.
#[cfg(target_os = "windows")]
fn resolve_wsl_user(distro: &str) -> String {
    use std::sync::OnceLock;
    static WSL_USER: OnceLock<String> = OnceLock::new();
    WSL_USER.get_or_init(|| {
        if let Ok(output) = std::process::Command::new("wsl")
            .args(["-d", distro, "whoami"])
            .output()
        {
            if output.status.success() {
                let user = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !user.is_empty() {
                    log(&format!("[wsl] default user: {user}"));
                    return user;
                }
            }
        }
        log("[wsl] could not detect user, using distro default");
        String::new()
    }).clone()
}

/// Gracefully kill a child process: SIGTERM first, then SIGKILL after 5s.
pub(crate) async fn graceful_kill(child: &mut tokio::process::Child) {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        let _ = child.wait().await;
    }

    #[cfg(not(target_os = "windows"))]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        if let Some(pid) = child.id() {
            // Send SIGTERM to process group (negative PID)
            let pgid = Pid::from_raw(-(pid as i32));
            let _ = kill(pgid, Signal::SIGTERM);

            // Wait up to 5s for graceful exit
            let wait_result = tokio::time::timeout(
                Duration::from_secs(5),
                child.wait(),
            ).await;

            if wait_result.is_err() {
                // Timeout — force kill
                log(&format!("[kill] SIGTERM timeout, sending SIGKILL to pgid {}", pid));
                let _ = kill(pgid, Signal::SIGKILL);
                let _ = child.wait().await;
            }
        } else {
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
    }
}

/// Spawn claude CLI, stream stdout as events, and handle completion.
/// `temp_mcp_config` is an optional path to a temp MCP config file to clean up on completion.
pub(crate) async fn spawn_and_stream(
    app: AppHandle,
    sessions: Sessions,
    args: &[&str],
    repo_path: &str,
    session_id: String,
    temp_mcp_config: Option<std::path::PathBuf>,
    worktree_path: Option<String>,
) -> Result<(), String> {
    let (mut cmd, temp_script) = build_command(args, repo_path)?;

    // Create new process group so we can kill the entire tree
    #[cfg(not(target_os = "windows"))]
    unsafe {
        cmd.pre_exec(|| {
            nix::unistd::setsid().map(|_| ()).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
        });
    }

    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            log(&format!("[spawn] Failed: {e}"));
            if let Some(ref p) = temp_script { let _ = std::fs::remove_file(p); }
            format!("Failed to spawn claude: {e}")
        })?;

    log(&format!("[spawn] OK session={session_id}"));

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    {
        let mut s = sessions.lock().await;
        s.insert(session_id.clone(), AgentSession {
            status: AgentStatus::Running,
            child: Some(child),
            claude_session_id: None,
            worktree_path,
        });
    }

    let sid2 = session_id.clone();
    let sessions_for_capture = sessions.clone();

    // Bounded channel for backpressure between stdout reader and event emitter
    let (tx, mut rx) = mpsc::channel::<Value>(100);

    let stderr_handle = tokio::spawn(async move {
        let mut err_output = String::new();
        let mut err_reader = BufReader::new(stderr);
        let _ = err_reader.read_to_string(&mut err_output).await;
        if !err_output.is_empty() {
            log(&format!("[stderr] {err_output}"));
        }
        err_output
    });

    // Stdout reader: parse JSONL and send to channel
    let stdout_reader = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut succeeded: Option<bool> = None;
        let mut captured_claude_session_id: Option<String> = None;
        let mut usage_limit_msg: Option<String> = None;

        while let Ok(Some(line)) = lines.next_line().await {
            log(&format!("[stdout] {}", line.chars().take(200).collect::<String>()));
            if let Ok(json) = serde_json::from_str::<Value>(&line) {
                // Capture claude session ID from the stream
                if captured_claude_session_id.is_none() {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        captured_claude_session_id = Some(sid.to_string());
                    }
                }

                // Detect usage limit in message content or system messages
                if usage_limit_msg.is_none() {
                    if let Some(msg) = detect_usage_limit(&json) {
                        log(&format!("[stdout] USAGE LIMIT DETECTED: {msg}"));
                        usage_limit_msg = Some(msg);
                    }
                }

                if json.get("type").and_then(|t| t.as_str()) == Some("result") {
                    let is_error = json.get("is_error").and_then(|v| v.as_bool()).unwrap_or(true);
                    succeeded = Some(!is_error);
                }
                if tx.send(json).await.is_err() {
                    log("[stdout] event channel closed");
                    break;
                }
            }
        }

        // Store captured session ID
        if let Some(ref cid) = captured_claude_session_id {
            let mut s = sessions_for_capture.lock().await;
            if let Some(session) = s.get_mut(&sid2) {
                session.claude_session_id = Some(cid.clone());
            }
        }

        log("[stdout] stream ended");
        (succeeded, usage_limit_msg)
    });

    // Event emitter: reads from channel, emits to Tauri frontend
    let app_emitter = app.clone();
    let sid_emitter = session_id.clone();
    let emitter_handle = tokio::spawn(async move {
        while let Some(json) = rx.recv().await {
            let r = app_emitter.emit("agent:message", serde_json::json!({
                "sessionId": sid_emitter,
                "data": json,
            }));
            log(&format!("[emit] agent:message -> {r:?}"));
        }
    });

    let sid_complete = session_id.clone();
    let sessions2 = sessions.clone();
    tokio::spawn(async move {
        // Wait for stdout with timeout
        let timed_result = tokio::time::timeout(AGENT_TIMEOUT, stdout_reader).await;

        let (succeeded, usage_limit_msg) = match timed_result {
            Ok(Ok((s, ulm))) => (s.unwrap_or(false), ulm),
            Ok(Err(_)) => (false, None), // join error
            Err(_) => {
                // Timeout — kill the agent
                log(&format!("[timeout] session={sid_complete} exceeded {}s", AGENT_TIMEOUT.as_secs()));
                let mut s = sessions2.lock().await;
                if let Some(session) = s.get_mut(&sid_complete) {
                    if let Some(mut child) = session.child.take() {
                        graceful_kill(&mut child).await;
                    }
                }
                drop(s);
                (false, None)
            }
        };

        let err_output = stderr_handle.await.unwrap_or_default();

        // Also check stderr for usage limit message
        let usage_limit_from_stderr = if usage_limit_msg.is_none() {
            let lower = err_output.to_lowercase();
            if lower.contains("out of extra usage") {
                Some(err_output.trim().chars().take(500).collect::<String>())
            } else {
                None
            }
        } else {
            None
        };
        let final_usage_limit = usage_limit_msg.or(usage_limit_from_stderr);

        // Usage limit forces failure regardless of CLI exit code
        let succeeded = if final_usage_limit.is_some() { false } else { succeeded };

        // Wait for emitter to flush
        let _ = emitter_handle.await;
        log(&format!("[complete] succeeded={succeeded} usage_limit={}", final_usage_limit.is_some()));

        let mut s = sessions2.lock().await;
        if let Some(session) = s.get_mut(&sid_complete) {
            // Reap child process to avoid zombies
            if let Some(mut child) = session.child.take() {
                let _ = child.wait().await;
            }
            session.status = if succeeded {
                AgentStatus::Completed
            } else {
                AgentStatus::Failed
            };
        }
        drop(s);

        let error_msg = if let Some(ref ulm) = final_usage_limit {
            // Tag usage limit errors for downstream parsing
            Some(format!("[USAGE_LIMIT] {ulm}"))
        } else if !succeeded {
            // Include stderr in error message for better diagnostics
            let trimmed = err_output.trim();
            if trimmed.is_empty() {
                Some("Agent completed with errors".to_string())
            } else {
                Some(trimmed.chars().take(500).collect::<String>())
            }
        } else {
            None
        };

        let _ = app.emit("agent:complete", serde_json::json!({
            "sessionId": sid_complete,
            "error": error_msg,
        }));
        log("[emit] agent:complete");

        // Clean up temp files
        if let Some(p) = temp_script { let _ = std::fs::remove_file(p); }
        if let Some(p) = temp_mcp_config { let _ = std::fs::remove_file(p); }
        prune_sessions(&sessions2).await;
    });

    Ok(())
}
