//! Pre-claim environment checks (ISS-451 / ISS-442 C5, invariant I6).
//!
//! Runs after `resolve_repo` and BEFORE the runner claims the job
//! (`runner.start`): a broken repo path, an unreachable push remote, or a
//! dangling hooks path must surface as a fast `preflight_failed: …` failure —
//! core's classifier maps that prefix to failureKind=infra for fast device
//! failover — instead of a 40-minute mid-run discovery.

use std::path::{Path, PathBuf};
use std::process::Output;
use std::time::Duration;

use tokio::process::Command;

/// Cap for `git ls-remote --heads origin`. Generous for a slow network,
/// tiny next to a wasted run. `GIT_TERMINAL_PROMPT=0` keeps a missing
/// credential from hanging until this fires.
const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(20);

/// Run the preflight checks in order, returning `Err("<check>: <detail>")` on
/// the first failure:
///
/// 1. `repo_path` exists and is a directory.
/// 2. It is a valid git working tree (`rev-parse --is-inside-work-tree`).
/// 3. An `origin` remote exists AND `ls-remote --heads origin` succeeds within
///    [`LS_REMOTE_TIMEOUT`] — pipeline jobs push branches, so no origin and
///    unreachable push credentials are both infra failures.
/// 4. If `core.hooksPath` is configured, that path exists (relative paths
///    resolve against the repo root). Unset passes.
pub async fn preflight(repo_path: &Path) -> Result<(), String> {
    // a. Path exists and is a directory.
    if !repo_path.is_dir() {
        return Err(format!(
            "repo_path: not a directory: {}",
            repo_path.display()
        ));
    }

    // b. Valid git working tree.
    let out = git(repo_path, &["rev-parse", "--is-inside-work-tree"]).await?;
    if !out.status.success() {
        return Err(format!("work_tree: {}", stderr_brief(&out)));
    }

    // c. Push-credential reachability. No origin at all is a failure too —
    //    pipeline jobs push branches.
    let origin = git(repo_path, &["remote", "get-url", "origin"]).await?;
    if !origin.status.success() {
        return Err("origin_remote: no 'origin' remote configured".into());
    }
    let ls = Command::new("git")
        .args(["-C"])
        .arg(repo_path)
        .args(["ls-remote", "--heads", "origin"])
        // Never block on an interactive credential prompt; fail instead.
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(LS_REMOTE_TIMEOUT, ls).await {
        Err(_) => {
            return Err(format!(
                "push_credentials: ls-remote timed out after {}s",
                LS_REMOTE_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(e)) => return Err(format!("push_credentials: failed to run git: {e}")),
        Ok(Ok(out)) if !out.status.success() => {
            return Err(format!("push_credentials: {}", stderr_brief(&out)))
        }
        Ok(Ok(_)) => {}
    }

    // d. Hooks sanity: a configured core.hooksPath must exist. Exit code 1
    //    from `git config` means unset, which passes.
    let hooks = git(repo_path, &["config", "core.hooksPath"]).await?;
    if hooks.status.success() {
        let raw = String::from_utf8_lossy(&hooks.stdout).trim().to_string();
        if !raw.is_empty() {
            let path = PathBuf::from(&raw);
            let abs = if path.is_absolute() {
                path
            } else {
                repo_path.join(path)
            };
            if !abs.exists() {
                return Err(format!("hooks_path: core.hooksPath does not exist: {raw}"));
            }
        }
    }

    Ok(())
}

/// Run `git -C <repo> <args>` capturing output. Err only when git itself
/// cannot be spawned (missing binary counts as an infra failure too).
async fn git(repo_path: &Path, args: &[&str]) -> Result<Output, String> {
    Command::new("git")
        .args(["-C"])
        .arg(repo_path)
        .args(args)
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("git: failed to run git {}: {e}", args.join(" ")))
}

/// First stderr line, trimmed — keeps the failure detail short.
fn stderr_brief(out: &Output) -> String {
    let text = String::from_utf8_lossy(&out.stderr);
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        format!("git exited with {}", out.status)
    } else {
        line.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unique temp dir per test (no tempfile dep in this crate); removed by
    /// the caller via `cleanup`.
    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("forge-preflight-{name}-{}", std::process::id()))
    }

    fn cleanup(path: &Path) {
        let _ = std::fs::remove_dir_all(path);
    }

    #[tokio::test]
    async fn fails_on_missing_path() {
        let dir = temp_path("missing");
        let err = preflight(&dir).await.unwrap_err();
        assert!(err.starts_with("repo_path:"), "got: {err}");
    }

    #[tokio::test]
    async fn fails_on_non_git_dir() {
        let dir = temp_path("nogit");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let err = preflight(&dir).await.unwrap_err();
        cleanup(&dir);
        assert!(err.starts_with("work_tree:"), "got: {err}");
    }

    #[tokio::test]
    async fn passes_work_tree_but_fails_without_origin() {
        let dir = temp_path("noorigin");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let status = std::process::Command::new("git")
            .args(["-C"])
            .arg(&dir)
            .args(["init", "-q"])
            .status()
            .expect("git init");
        assert!(status.success(), "git init failed");
        let err = preflight(&dir).await.unwrap_err();
        cleanup(&dir);
        // Past repo_path + work_tree, stopped by the no-origin rule.
        assert!(err.starts_with("origin_remote:"), "got: {err}");
    }
}
