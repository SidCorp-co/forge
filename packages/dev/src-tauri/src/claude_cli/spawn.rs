use super::{log, AgentSession, AgentStatus, Sessions, prune_sessions};
pub(crate) use super::platform::to_wsl_path;
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex as TokioMutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::mpsc;

/// No default agent timeout — Claude CLI is allowed to run as long as it
/// takes when the caller doesn't supply an explicit cap. Per-state
/// `appConfig.pipeline.states[stage].timeoutSeconds` is still honored via
/// the IPC `timeout_seconds` parameter on `send_chat` / `run_agent`; when
/// the caller leaves it unset the spawn waits indefinitely on stdout.
/// Rationale: the 30-minute global cap killed live sessions doing legitimate
/// long-running work (large builds, deep test suites, paused on rate-limit
/// reset). Server-side heartbeat sweeper still flags abandoned sessions.

/// Resolve the claude binary path. Cached in a OnceLock.
///
/// Strategy (in order):
///   1. Walk `$PATH` looking for `claude`. PATH was already corrected at
///      app startup by `env_path::fix_gui_path()` (login-shell probe), so
///      under GUI launches this picks up Homebrew / nvm / `~/.local/bin`
///      that the OS-inherited PATH would have missed.
///   2. Probe a list of common install locations on macOS/Linux. Belt-and-
///      suspenders for exotic setups where the user's shell rc doesn't
///      export the install dir, or where the login-shell probe failed
///      (timeout, broken rc).
///   3. Fall back to the literal `"claude"` and let Tokio's spawn surface
///      ENOENT — better than silently masking the error.
#[cfg(not(target_os = "windows"))]
fn resolve_claude_bin() -> &'static str {
    use std::sync::OnceLock;
    static CLAUDE_BIN: OnceLock<String> = OnceLock::new();
    CLAUDE_BIN.get_or_init(|| {
        if let Some(path) = which_on_path("claude") {
            log(&format!("[resolve] claude on PATH: {}", path.display()));
            return path.to_string_lossy().into_owned();
        }

        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidates: Vec<String> = vec![
            "/opt/homebrew/bin/claude".into(),
            "/usr/local/bin/claude".into(),
            format!("{home}/.local/bin/claude"),
            format!("{home}/.npm-global/bin/claude"),
            format!("{home}/.bun/bin/claude"),
        ];
        if let Ok(entries) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
            let mut versions: Vec<String> = entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect();
            versions.sort();
            if let Some(latest) = versions.last() {
                candidates.push(format!("{home}/.nvm/versions/node/{latest}/bin/claude"));
            }
        }
        for path in &candidates {
            if std::path::Path::new(path).is_file() {
                log(&format!("[resolve] claude via fallback: {path}"));
                return path.clone();
            }
        }

        log("[resolve] claude not found on PATH or in fallback list — spawn will likely ENOENT");
        "claude".to_string()
    })
}

#[cfg(not(target_os = "windows"))]
fn which_on_path(bin: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
    timeout_seconds: Option<u64>,
) -> Result<(), String> {
    // Resolve per-call timeout. `None` (or 0) means "no timeout" — the
    // 30-minute global default that used to live here was removed because
    // it was killing legitimate long-running sessions (see file header).
    let agent_timeout: Option<Duration> = timeout_seconds
        .filter(|s| *s > 0)
        .map(Duration::from_secs);
    // PR-5c — only treat CLI errors as RESUME_FAILED when --resume was actually
    // requested. Prevents false positives where a fresh invocation's stderr
    // happens to mention "session" or "resume" (help text, deprecation notes).
    // `.starts_with` covers both `--resume <id>` (current syntax) and a
    // hypothetical `--resume=<id>` combined-form a future CLI might adopt.
    let invoked_with_resume = args.iter().any(|a| a.starts_with("--resume"));

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

    // Shared stream outcome — (succeeded, usage_limit_msg) — written by the
    // stdout reader AS IT PARSES each line, so the completion task can read the
    // captured result even if the reader is later aborted while still parked on
    // a stdout pipe that never reaches EOF (ISS-264: MCP server grandchildren
    // spawned by `claude` keep the pipe open after `claude` itself exits).
    let outcome: Arc<TokioMutex<(Option<bool>, Option<String>)>> =
        Arc::new(TokioMutex::new((None, None)));
    let outcome_reader = outcome.clone();

    // Exit status code of the `claude` child, recorded by the completion task's
    // exit-poll loop when `try_wait` observes the process gone. Lets completion
    // treat a clean exit (code 0) as success even when no `type:"result"` line
    // was parsed — e.g. the result was never emitted, or was still buffered in a
    // pipe held open by MCP grandchildren when the 2s drain grace elapsed
    // (ISS-264). Without this, a clean exit with no result line would default to
    // failure and the job would be marked `failed` instead of `done`.
    let exit_code: Arc<TokioMutex<Option<i32>>> = Arc::new(TokioMutex::new(None));

    let stderr_handle = tokio::spawn(async move {
        let mut err_output = String::new();
        let mut err_reader = BufReader::new(stderr);
        let _ = err_reader.read_to_string(&mut err_output).await;
        if !err_output.is_empty() {
            log(&format!("[stderr] {err_output}"));
        }
        err_output
    });

    // Stdout reader: parse JSONL and send to channel. Captured result state is
    // pushed to `outcome` / the session row incrementally (not returned at EOF)
    // so it survives an abort of this task — see the completion task below.
    let stdout_reader = tokio::spawn(async move {
        let reader = BufReader::new(stdout);
        let mut lines = reader.lines();
        let mut captured_sid = false;
        let mut captured_usage_limit = false;

        while let Ok(Some(line)) = lines.next_line().await {
            log(&format!("[stdout] {}", line.chars().take(200).collect::<String>()));
            let parsed = serde_json::from_str::<Value>(&line);
            if parsed.is_err() && !line.trim().is_empty() {
                // Surface non-JSON output (CLI warnings, panics, debug prints)
                // so it shows up in the Tauri log instead of being silently
                // dropped by the JSONL parser.
                log(&format!(
                    "[stdout-non-json] {}",
                    line.chars().take(500).collect::<String>()
                ));
            }
            if let Ok(json) = parsed {
                // Capture claude session ID from the stream — persist inline to
                // the session row so the completion task can read it even if
                // this reader never observes EOF (ISS-264).
                if !captured_sid {
                    if let Some(sid) = json.get("session_id").and_then(|v| v.as_str()) {
                        let mut s = sessions_for_capture.lock().await;
                        if let Some(session) = s.get_mut(&sid2) {
                            session.claude_session_id = Some(sid.to_string());
                        }
                        captured_sid = true;
                    }
                }

                // Detect usage limit in message content or system messages
                if !captured_usage_limit {
                    if let Some(msg) = detect_usage_limit(&json) {
                        log(&format!("[stdout] USAGE LIMIT DETECTED: {msg}"));
                        outcome_reader.lock().await.1 = Some(msg);
                        captured_usage_limit = true;
                    }
                }

                // The `result` line is the FINAL message claude emits in
                // stream-json `--print` mode. Treat it as the definitive
                // completion signal: record the outcome, forward the line, then
                // STOP reading. We must not wait for stdout EOF or for `claude`
                // to exit — `claude` frequently lingers after emitting `result`
                // because its MCP server children keep the process (and the
                // inherited stdout pipe) alive. Breaking here lets the
                // completion task proceed immediately and reap the whole process
                // group (claude + MCP grandchildren) via graceful_kill (ISS-264;
                // 0.2.9's exit-poll alone hung when claude never exited).
                let is_result =
                    json.get("type").and_then(|t| t.as_str()) == Some("result");
                if is_result {
                    let is_error = json.get("is_error").and_then(|v| v.as_bool()).unwrap_or(true);
                    outcome_reader.lock().await.0 = Some(!is_error);
                }
                if tx.send(json).await.is_err() {
                    log("[stdout] event channel closed");
                    break;
                }
                if is_result {
                    log("[stdout] result line seen — completing");
                    break;
                }
            }
        }

        log("[stdout] stream ended");
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
    let outcome_complete = outcome.clone();
    let exit_code_complete = exit_code.clone();
    tokio::spawn(async move {
        // Wait for the agent to finish. We must NOT rely on stdout EOF alone:
        // MCP server grandchildren spawned by `claude` can keep the stdout (and
        // stderr) pipe open after `claude` itself has exited, so the reader
        // would block forever on a pipe that never reaches EOF. That hang meant
        // `agent:complete` was never emitted, the runner never POSTed
        // /api/jobs/:id/complete, and the job sat at `dispatched` until the
        // server's heartbeat sweeper falsely reaped it (ISS-264). So we race the
        // stream end against the child-process exit; once the process is gone we
        // grant the reader a short grace to drain, then stop waiting and reap
        // the whole process group. When `agent_timeout` is Some we also cap the
        // total wait; otherwise we wait for one of the two signals (the
        // server-side heartbeat sweeper still backstops a truly hung `claude`).
        let mut reader = stdout_reader;
        let sessions_poll = sessions2.clone();
        let sid_poll = sid_complete.clone();
        let exit_code_poll = exit_code_complete.clone();
        let exit_poll = async move {
            loop {
                {
                    let mut s = sessions_poll.lock().await;
                    match s.get_mut(&sid_poll) {
                        // try_wait reports exit without blocking or reaping.
                        Some(session) => match session.child.as_mut() {
                            Some(child) => match child.try_wait() {
                                Ok(Some(status)) => {
                                    // Record the exit code so completion can fall
                                    // back to it when no result line was parsed.
                                    *exit_code_poll.lock().await = Some(status.code().unwrap_or(-1));
                                    break; // process exited
                                }
                                Ok(None) => {} // still running
                                Err(_) => break, // treat error as gone
                            },
                            None => break, // child already taken (aborted)
                        },
                        None => break, // session gone
                    }
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };

        match agent_timeout {
            Some(d) => {
                tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => {
                        // process exited; let the reader flush buffered lines.
                        let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await;
                    }
                    _ = tokio::time::sleep(d) => {
                        log(&format!("[timeout] session={sid_complete} exceeded {}s", d.as_secs()));
                    }
                }
            }
            None => {
                tokio::select! {
                    _ = &mut reader => {}
                    _ = exit_poll => {
                        let _ = tokio::time::timeout(Duration::from_secs(2), &mut reader).await;
                    }
                }
            }
        }

        // Stop the reader if it's still parked on a non-EOF pipe.
        reader.abort();

        // Result captured incrementally by the reader (valid even after abort —
        // the `result` line is parsed long before the pipe would EOF).
        let (succeeded_opt, usage_limit_msg) = {
            let o = outcome_complete.lock().await;
            (o.0, o.1.clone())
        };
        // Fall back to the child's exit status when no `type:"result"` line was
        // parsed: a clean exit (code 0) is a success, anything else (non-zero,
        // signal, or never-observed exit) is a failure (ISS-264).
        let exited_zero = matches!(*exit_code_complete.lock().await, Some(0));
        let succeeded = succeeded_opt.unwrap_or(exited_zero);

        // Reap the child + its process group now, so lingering MCP grandchildren
        // don't pile up and their open pipe FDs are released. The child may
        // already have exited (exit_poll path) — graceful_kill handles that and
        // still SIGTERMs the group to clean up grandchildren.
        {
            let mut s = sessions2.lock().await;
            if let Some(session) = s.get_mut(&sid_complete) {
                if let Some(mut child) = session.child.take() {
                    graceful_kill(&mut child).await;
                }
            }
        }

        // stderr: same leaked-pipe risk as stdout — bound the wait so a held
        // pipe can't hang completion. Once the process group is gone the FD is
        // released and this returns immediately.
        let err_output = match tokio::time::timeout(Duration::from_secs(3), stderr_handle).await {
            Ok(Ok(s)) => s,
            _ => String::new(),
        };

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

        // Wait for emitter to flush (bounded — aborting the reader drops its tx
        // which closes the channel, so this normally returns at once).
        let _ = tokio::time::timeout(Duration::from_secs(2), emitter_handle).await;
        log(&format!("[complete] succeeded={succeeded} usage_limit={}", final_usage_limit.is_some()));

        // Child was already reaped above (graceful_kill). Just record final
        // status and read back the claude session id for the complete event.
        let captured_cid = {
            let mut s = sessions2.lock().await;
            let cid = s.get(&sid_complete).and_then(|x| x.claude_session_id.clone());
            if let Some(session) = s.get_mut(&sid_complete) {
                session.status = if succeeded {
                    AgentStatus::Completed
                } else {
                    AgentStatus::Failed
                };
            }
            cid
        };

        // PR-5c — detect resume failure so the server can re-dispatch the
        // job without claudeSessionId (or fail it, per onResumeFail config).
        // Gated on `invoked_with_resume` to avoid false positives for fresh
        // invocations that happen to mention "session" / "resume" in stderr.
        // Match only specific phrases that name a missing/unreadable session
        // file — avoid the bare `--resume` substring (would match help text,
        // deprecation notices, etc.).
        //
        // TODO(PR-6): once the manual `--resume` interaction test is run
        // (see docs/proposals/pipeline-prompt-ssot.md §PR-5/PR-6), expand
        // this phrase list to cover whatever the CLI actually emits when it
        // rejects `--append-system-prompt` alongside `--resume` (if anything).
        let resume_failed = invoked_with_resume
            && !succeeded
            && {
                let blob = err_output.to_lowercase();
                blob.contains("session not found")
                    || blob.contains("could not resume")
                    || blob.contains("no such session")
                    || blob.contains("session file missing")
                    || blob.contains("session id not found")
            };

        let error_msg = if let Some(ref ulm) = final_usage_limit {
            // Tag usage limit errors for downstream parsing
            Some(format!("[USAGE_LIMIT] {ulm}"))
        } else if resume_failed {
            let trimmed = err_output.trim();
            let body = trimmed.chars().take(500).collect::<String>();
            Some(format!("[RESUME_FAILED] {body}"))
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
            "claudeSessionId": captured_cid,
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
