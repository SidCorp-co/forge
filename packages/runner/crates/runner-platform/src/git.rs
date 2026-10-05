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
