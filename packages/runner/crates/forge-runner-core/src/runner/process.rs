//! Process helpers: resolve the `claude` binary, build the spawn command, and
//! gracefully kill a process group.
//!
//! TODO(M-win): the Tauri app's Windows/WSL spawn (native vs WSL detection,
//! UTF-16 distro parsing, temp shell script) is intentionally omitted here —
//! this targets native Linux/macOS first. Windows falls back to a bare
//! `claude` invocation.

use std::process::ExitStatus;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::process::{Child, Command};

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
