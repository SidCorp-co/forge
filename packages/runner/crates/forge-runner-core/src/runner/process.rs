//! Process helpers: resolve the `claude` binary, build the spawn command, and
//! gracefully kill a process group.
//!
//! TODO(M-win): the Tauri app's Windows/WSL spawn (native vs WSL detection,
//! UTF-16 distro parsing, temp shell script) is intentionally omitted here —
//! this targets native Linux/macOS first. Windows falls back to a bare
//! `claude` invocation.

use std::ffi::OsStr;
use std::process::ExitStatus;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::{Child, Command};

/// Default per-MCP-tool-call wall-clock bound, in milliseconds (10 min).
///
/// Claude Code's `MCP_TOOL_TIMEOUT` defaults to ~28h when unset, so a single
/// misbehaving MCP tool call (e.g. a Playwright `browser_evaluate` awaiting a
/// `navigator.clipboard.readText()` promise that hangs on a permission gate)
/// blocks the agent turn indefinitely — the job never produces a `result`, the
/// process never exits, and the runner's completion select waits forever
/// (ISS-25 wedge). The timeout is a hard limit PER TOOL CALL: on expiry Claude
/// aborts only that call and returns an error to the model, so the turn
/// continues. It does NOT bound Bash (own timeout), subagents (a Task is not an
/// MCP call), or any non-MCP work — so long/legit jobs are never killed. 10 min
/// sits well above any real single MCP call (Forge data tools are sub-second,
/// `forge_coolify_deploy` only enqueues, Playwright actions self-bound ~30-60s).
const DEFAULT_MCP_TOOL_TIMEOUT_MS: &str = "600000";

/// Resolve the `MCP_TOOL_TIMEOUT` to inject when spawning `claude`: `None` when
/// the operator already set it in the environment (respect their override),
/// else the bounded default. Pure (env read passed in) so it stays testable.
fn mcp_tool_timeout_default(existing: Option<&OsStr>) -> Option<&'static str> {
    match existing {
        Some(v) if !v.is_empty() => None,
        _ => Some(DEFAULT_MCP_TOOL_TIMEOUT_MS),
    }
}

/// Resolve the `claude` binary: `$PATH` first, then common install dirs.
#[cfg(not(target_os = "windows"))]
pub fn resolve_claude_bin() -> &'static str {
    static CLAUDE_BIN: OnceLock<String> = OnceLock::new();
    CLAUDE_BIN.get_or_init(|| {
        if let Ok(p) = which::which("claude") {
            return p.to_string_lossy().into_owned();
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let mut candidates = vec![
            "/opt/homebrew/bin/claude".to_string(),
            "/usr/local/bin/claude".to_string(),
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
        candidates
            .into_iter()
            .find(|p| std::path::Path::new(p).is_file())
            .unwrap_or_else(|| "claude".to_string())
    })
}

#[cfg(target_os = "windows")]
pub fn resolve_claude_bin() -> &'static str {
    "claude"
}

/// Build a `claude` command rooted at `repo_path` with `CLAUDECODE` unset
/// (so a nested `claude` doesn't think it's inside the parent session).
pub fn build_command(args: &[String], repo_path: &str) -> Command {
    let mut cmd = Command::new(resolve_claude_bin());
    cmd.args(args).current_dir(repo_path);
    cmd.env_remove("CLAUDECODE");
    // Bound every MCP tool call so a hung MCP server can't wedge the job forever
    // (see DEFAULT_MCP_TOOL_TIMEOUT_MS). Respect an operator-set value.
    if let Some(v) = mcp_tool_timeout_default(std::env::var_os("MCP_TOOL_TIMEOUT").as_deref()) {
        cmd.env("MCP_TOOL_TIMEOUT", v);
    }
    cmd
}

/// SIGTERM the process group, then SIGKILL after 5s. On Windows, `taskkill /T`.
///
/// Returns the child's [`ExitStatus`] when it could be reaped (carrying the
/// exit code / terminating signal), so callers can derive a precise
/// failure reason. `None` if the wait failed.
pub async fn graceful_kill(child: &mut Child) -> Option<ExitStatus> {
    #[cfg(target_os = "windows")]
    {
        if let Some(pid) = child.id() {
            let _ = std::process::Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
        }
        return child.wait().await.ok();
    }

    #[cfg(not(target_os = "windows"))]
    {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        if let Some(pid) = child.id() {
            let pgid = Pid::from_raw(-(pid as i32));
            let _ = kill(pgid, Signal::SIGTERM);
            match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
                Ok(status) => status.ok(),
                Err(_) => {
                    let _ = kill(pgid, Signal::SIGKILL);
                    child.wait().await.ok()
                }
            }
        } else {
            let _ = child.kill().await;
            child.wait().await.ok()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn injects_default_mcp_tool_timeout_when_unset() {
        assert_eq!(
            mcp_tool_timeout_default(None),
            Some(DEFAULT_MCP_TOOL_TIMEOUT_MS)
        );
    }

    #[test]
    fn treats_empty_value_as_unset() {
        assert_eq!(
            mcp_tool_timeout_default(Some(OsStr::new(""))),
            Some(DEFAULT_MCP_TOOL_TIMEOUT_MS)
        );
    }

    #[test]
    fn respects_operator_override() {
        assert_eq!(
            mcp_tool_timeout_default(Some(OsStr::new("120000"))),
            None
        );
    }
}
