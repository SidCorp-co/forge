//! The one way the runner reads git: a non-interactive child in `dir`, killed
//! with its caller, whose failure is `None` rather than an error to plumb.

use std::path::Path;
use std::process::{Output, Stdio};

use tokio::process::Command;

pub async fn git(dir: &Path, args: &[&str]) -> Option<Output> {
    non_interactive(Command::new("git").args(args).current_dir(dir))
        .output()
        .await
        .ok()
}

/// Make `cmd`, a git child, one that can never wait on a person: stdin closed,
/// no terminal prompt, no askpass program (an empty `GIT_ASKPASS` also stops
/// git falling back to `SSH_ASKPASS`), Git Credential Manager told not to open
/// a dialog, and the child killed when its caller's future is dropped, so a
/// timeout around it leaves no git behind. A credential git needs and has not
/// got is then a refusal it prints at once, never a prompt nobody answers.
pub fn non_interactive(cmd: &mut Command) -> &mut Command {
    cmd.stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "")
        .env("GCM_INTERACTIVE", "never")
        .kill_on_drop(true)
}

/// Trimmed stdout of a successful git call, or `None` when it failed or said nothing.
pub async fn git_line(dir: &Path, args: &[&str]) -> Option<String> {
    let out = git(dir, args).await?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !s.is_empty()).then_some(s)
}

/// Seconds since the Unix epoch; 0 on a clock before it.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Days from 1970-01-01 to the proleptic Gregorian date `y-m-d`.
pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}
