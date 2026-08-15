//! Git worktrees under `<repo>/.worktrees/<branch>`, so a code job runs on an
//! isolated branch checkout. Ported from the Tauri app's worktree helper.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::error::{Error, Result};

fn sanitize(branch: &str) -> String {
    branch.replace('/', "-")
}

async fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))
}

fn create_argv<'a>(rel: &'a str, branch: &'a str, start_point: Option<&'a str>) -> Vec<&'a str> {
    let mut argv = vec!["worktree", "add", rel, "-b", branch];
    argv.extend(start_point);
    argv
}

/// Create (or reuse) a worktree for `branch` and return its absolute path.
///
/// `start_point` is the commit-ish a NEW branch is cut from; `None` falls back
/// to the main worktree's HEAD.
pub async fn create(repo: &str, branch: &str, start_point: Option<&str>) -> Result<PathBuf> {
    ensure_gitignore(repo).await;
    let rel = format!(".worktrees/{}", sanitize(branch));

    // cm:edge ordering -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — dispatch resolves `start_point` to `origin/<base>` and is the only caller that can: it is the half that knows the project's base branch. Passing `None` cuts the branch from whatever the main worktree happens to sit on, which since the workspace refresh became a notice rather than a refusal can be ANY branch — `main` on anhome, 2026-08-15.
    // Try to create a new branch; if it already exists, attach without -b.
    let out = git(repo, &create_argv(&rel, branch, start_point)).await?;
    if !out.status.success() {
        let retry = git(repo, &["worktree", "add", &rel, branch]).await?;
        if !retry.status.success() {
            return Err(Error::Other(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&retry.stderr).trim()
            )));
        }
    }

    let abs = PathBuf::from(repo).join(&rel);
    // Carry skills into the worktree (mirrors the Tauri behavior).
    let _ = copy_skills(repo, &abs).await;
    Ok(abs)
}

/// Remove a worktree (force).
pub async fn remove(repo: &str, branch: &str) -> Result<()> {
    let rel = format!(".worktrees/{}", sanitize(branch));
    let out = git(repo, &["worktree", "remove", &rel, "--force"]).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git worktree remove failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(())
}

/// List worktree paths under `.worktrees/`.
pub async fn list(repo: &str) -> Result<Vec<String>> {
    let out = git(repo, &["worktree", "list", "--porcelain"]).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text
        .lines()
        .filter_map(|l| l.strip_prefix("worktree "))
        .filter(|p| p.contains("/.worktrees/"))
        .map(str::to_string)
        .collect())
}

async fn ensure_gitignore(repo: &str) {
    let p = PathBuf::from(repo).join(".gitignore");
    let has = std::fs::read_to_string(&p)
        .map(|c| c.lines().any(|l| l.trim() == ".worktrees"))
        .unwrap_or(false);
    if !has {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
        {
            let _ = writeln!(f, ".worktrees");
        }
    }
}

async fn copy_skills(repo: &str, worktree: &Path) -> Result<()> {
    let src = PathBuf::from(repo).join(".claude").join("skills");
    if !src.is_dir() {
        return Ok(());
    }
    let dst = worktree.join(".claude").join("skills");
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Best-effort recursive copy via `cp -r` (Unix) / robocopy is overkill here.
    #[cfg(unix)]
    {
        let _ = Command::new("cp")
            .arg("-r")
            .arg(&src)
            .arg(dst.parent().unwrap())
            .output()
            .await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_point_is_the_last_arg_so_the_new_branch_is_cut_from_it() {
        let argv = create_argv(".worktrees/ISS-1", "ISS-1", Some("origin/release/stg"));
        assert_eq!(
            argv,
            [
                "worktree",
                "add",
                ".worktrees/ISS-1",
                "-b",
                "ISS-1",
                "origin/release/stg"
            ]
        );
    }

    #[test]
    fn without_a_start_point_git_falls_back_to_head() {
        let argv = create_argv(".worktrees/ISS-1", "ISS-1", None);
        assert_eq!(argv, ["worktree", "add", ".worktrees/ISS-1", "-b", "ISS-1"]);
    }
}
