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

/// Where `create` puts (or finds) the worktree for `branch`. Split out so the
/// sanitising rule has one home.
pub fn path(repo: &str, branch: &str) -> PathBuf {
    PathBuf::from(repo).join(format!(".worktrees/{}", sanitize(branch)))
}

/// Create (or reuse) a worktree for `branch` and return its absolute path.
///
/// `start_point` is the commit-ish a NEW branch is cut from; `None` falls back
/// to the main worktree's HEAD.
pub async fn create(repo: &str, branch: &str, start_point: Option<&str>) -> Result<PathBuf> {
    ensure_gitignore(repo).await;
    let rel = format!(".worktrees/{}", sanitize(branch));

    let abs = path(repo, branch);

    // cm:guard REUSE comes first, and it is not an optimisation. `git worktree add` refuses a
    // path that exists — with or without `-b` — so without this arm the SECOND stage of an issue
    // gets `fatal: '.worktrees/ISS-n' already exists` and the job dies before the agent starts.
    // Core sends one branch for the whole issue precisely so the stages share a tree; that
    // contract is this branch of this function and nothing else.
    if let Some(existing) = reusable(repo, &abs, branch).await {
        let _ = copy_skills(repo, &existing).await;
        return Ok(existing);
    }

    // cm:edge ordering -> packages/runner/crates/forge-runner-core/src/daemon/dispatch.rs — dispatch resolves `start_point` to `origin/<base>` and is the only caller that can: it is the half that knows the project's base branch. Passing `None` cuts the branch from whatever the main worktree happens to sit on, which since the workspace refresh became a notice rather than a refusal can be ANY branch — `main` on anhome, 2026-08-15.
    // Try to create a new branch; if it already exists, attach without -b.
    let out = git(repo, &create_argv(&rel, branch, start_point)).await?;
    if !out.status.success() {
        // cm:why prune first: a worktree whose directory was deleted by hand stays REGISTERED, and git then refuses both `add` arms for a path it still believes is checked out
        let _ = git(repo, &["worktree", "prune"]).await;
        let retry = git(repo, &["worktree", "add", &rel, branch]).await?;
        if !retry.status.success() {
            return Err(Error::Other(format!(
                "git worktree add failed: {}",
                String::from_utf8_lossy(&retry.stderr).trim()
            )));
        }
    }

    // Carry skills into the worktree (mirrors the Tauri behavior).
    let _ = copy_skills(repo, &abs).await;
    Ok(abs)
}

/// `abs` when it is ALREADY this branch's registered worktree, else `None`.
///
/// Both halves are load-bearing. HEAD must be the branch asked for, or a stage
/// would resume in a tree holding some other issue's work; and the path must be
/// one git lists for THIS repo, so a stray directory left by a deleted worktree
/// falls through to the create path rather than being handed to an agent as a
/// checkout git does not track.
async fn reusable(repo: &str, abs: &Path, branch: &str) -> Option<PathBuf> {
    if !abs.is_dir() {
        return None;
    }
    let out = git(&abs.to_string_lossy(), &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .ok()?;
    if !out.status.success() || String::from_utf8_lossy(&out.stdout).trim() != branch {
        return None;
    }
    let want = abs.canonicalize().ok()?;
    let listed = list(repo).await.ok()?;
    listed
        .iter()
        .any(|p| PathBuf::from(p).canonicalize().ok().as_ref() == Some(&want))
        .then(|| abs.to_path_buf())
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

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
    }

    /// Unique temp repo per test on `main` with one commit (no tempfile dep in
    /// this crate — same pattern as `refresh.rs` and `salvage.rs`).
    async fn repo(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "forge-worktree-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        run(&root, &["init", "-b", "main"]).await;
        run(&root, &["config", "user.email", "t@t"]).await;
        run(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "one\n").unwrap();
        run(&root, &["add", "."]).await;
        run(&root, &["commit", "-m", "init"]).await;
        root
    }

    async fn branch_of(dir: &Path) -> String {
        let out = Command::new("git")
            .args(["rev-parse", "--abbrev-ref", "HEAD"])
            .current_dir(dir)
            .output()
            .await
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[tokio::test]
    async fn cuts_the_branch_and_puts_it_where_path_says() {
        let root = repo("cuts").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "ISS-1", None).await.unwrap();
        assert_eq!(wt, path(&r, "ISS-1"));
        assert!(wt.join("f.txt").is_file(), "worktree has the repo's content");
        assert_eq!(branch_of(&wt).await, "ISS-1");
        assert_eq!(branch_of(&root).await, "main", "the root did not move");
        let _ = std::fs::remove_dir_all(&root);
    }

    // cm:guard the SECOND call is the whole assertion, and the first cannot stand in for it. `git worktree add -b` fails on a branch that exists, so create-or-reuse rests entirely on the retry arm — and that arm is what makes every stage of one issue land in the SAME checkout, which is the reason `pipeline/orchestrator.ts` sends one branch name for the whole issue rather than one per job. Delete the retry and only this goes red.
    #[tokio::test]
    async fn the_second_stage_of_an_issue_reuses_the_first_stages_checkout() {
        let root = repo("reuse").await;
        let r = root.to_string_lossy().to_string();
        let first = create(&r, "ISS-2", None).await.unwrap();
        std::fs::write(first.join("code-stage.txt"), "written by code\n").unwrap();

        let second = create(&r, "ISS-2", None).await.unwrap();
        assert_eq!(second, first, "same issue, same tree");
        assert!(
            second.join("code-stage.txt").is_file(),
            "the test stage must see what the code stage wrote"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // cm:guard two issues must get two trees on ONE box. This is the property a per-runner cap above 1 would rest on — with every stage in the repo root, refusing a second job was the only thing keeping two agents out of one checkout.
    #[tokio::test]
    async fn two_issues_get_two_independent_checkouts() {
        let root = repo("two").await;
        let r = root.to_string_lossy().to_string();
        let a = create(&r, "ISS-3", None).await.unwrap();
        let b = create(&r, "ISS-4", None).await.unwrap();
        assert_ne!(a, b);
        std::fs::write(a.join("only-a.txt"), "a\n").unwrap();
        assert!(!b.join("only-a.txt").exists(), "b cannot see a's work");
        assert_eq!(branch_of(&a).await, "ISS-3");
        assert_eq!(branch_of(&b).await, "ISS-4");
        let listed = list(&r).await.unwrap();
        assert_eq!(listed.len(), 2, "both are real worktrees to git");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_slash_in_the_branch_becomes_a_directory_name_not_a_directory() {
        let root = repo("slash").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "feat/ISS-5", None).await.unwrap();
        assert!(wt.ends_with(".worktrees/feat-ISS-5"));
        assert_eq!(branch_of(&wt).await, "feat/ISS-5", "the BRANCH keeps its slash");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn the_ignore_line_is_written_once_not_once_per_job() {
        let root = repo("ignore").await;
        let r = root.to_string_lossy().to_string();
        create(&r, "ISS-6", None).await.unwrap();
        create(&r, "ISS-7", None).await.unwrap();
        let body = std::fs::read_to_string(root.join(".gitignore")).unwrap();
        assert_eq!(
            body.lines().filter(|l| l.trim() == ".worktrees").count(),
            1,
            "a repeated append would grow a tracked file on every job"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
