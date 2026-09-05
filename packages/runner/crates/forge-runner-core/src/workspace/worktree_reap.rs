//! Reaping the agent worktrees nothing else removes.
//!
//! Two directories, from two different conventions, and nothing used to remove
//! either: `<repo>/.claude/worktrees/<slug>` is Claude Code's own, and
//! `<repo>/.worktrees/<branch>` is what `worktree::create` cuts for a job. They
//! accumulate for the life of the box.
//!
//! Measured 2026-08-20: ubuntu6 reached 100% disk (342M free) with 64 stale
//! worktrees holding 29G; ubuntu2/3/5 held another 12G between them. A full
//! disk fails every job on the box, so this is a liveness problem, not tidiness.
//!
//! The predicate is deliberately timid — this deletes work, and a wrong
//! judgement here is unrecoverable. A worktree is reaped only when all three
//! hold: it is older than `MIN_AGE`, it has no commit the remote lacks, and no
//! tracked file in it is modified. Untracked files do not protect it, or every
//! build artifact would pin a worktree forever.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use tokio::process::Command;

// cm:guard far longer than any session, deliberately — a drive session runs
// 60-90 minutes, so nothing this old can be live. The margin is what lets the
// age gate carry the safety on its own if a git probe below ever misreads.
pub const MIN_AGE: Duration = Duration::from_secs(14 * 24 * 3600);

/// Every directory a checkout can be cut into, relative to the repo root.
// cm:edge naming -> packages/runner/crates/forge-runner-core/src/workspace/worktree.rs — that module owns `.worktrees/` and names each tree after the branch. They stay two directories with one sweep: `.claude/worktrees/` is Claude Code's convention and is not ours to rename.
// cm:guard `.worktrees/` MUST stay in this list now that a master names its own agents. Until 2026-09-05 core derived every branch from the issue key, so an issue reused one checkout however many stages it ran and the naming was the ceiling on how many could exist. A master invents a name per pass, so nothing bounds them — and unreaped worktrees are a liveness problem, not tidiness: ubuntu6 reached 100% disk (342M free) on 2026-08-20 with 64 stale trees holding 29G, which fails every job on the box.
const WORKTREE_ROOTS: [&str; 2] = [".claude/worktrees", ".worktrees"];

async fn git(dir: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
}

/// True when the worktree holds something losing it would destroy.
async fn holds_work(wt: &Path) -> bool {
    if let Some(out) = git(wt, &["status", "--porcelain", "--untracked-files=no"]).await {
        if !out.stdout.is_empty() {
            return true;
        }
    } else {
        return true;
    }
    match git(wt, &["log", "--oneline", "@{u}..", "-1"]).await {
        // No upstream is not evidence of safety: a branch that was never pushed
        // is exactly the one whose commits exist nowhere else.
        Some(out) if !out.status.success() => true,
        Some(out) => !out.stdout.is_empty(),
        None => true,
    }
}

fn older_than(p: &Path, age: Duration) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|d| d >= age)
}

/// Reap one repo's stale agent worktrees. Returns the paths removed.
pub async fn reap_repo(repo: &Path, min_age: Duration) -> Vec<PathBuf> {
    let mut removed = Vec::new();
    for root in WORKTREE_ROOTS {
        let Ok(entries) = std::fs::read_dir(repo.join(root)) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() || !older_than(&p, min_age) || holds_work(&p).await {
                continue;
            }
            let ok = git(
                repo,
                &["worktree", "remove", "--force", &p.to_string_lossy()],
            )
            .await
            .is_some_and(|o| o.status.success())
                || std::fs::remove_dir_all(&p).is_ok();
            if ok && !p.exists() {
                removed.push(p);
            }
        }
    }
    if !removed.is_empty() {
        git(repo, &["worktree", "prune"]).await;
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A repo with one agent worktree. `NOW` as `min_age` isolates the git
    /// predicates from the age gate, which its own test covers.
    /// The runner's own lane, `.worktrees/<branch>` — unswept until 2026-09-05
    /// and unbounded since the master began naming its own agents.
    #[tokio::test]
    async fn reaps_the_runners_own_worktree_lane_too() {
        let (repo, _wt) = repo_with_worktree_in("runner-lane", WORKTREE_ROOTS[1]).await;
        let removed = reap_repo(&repo, NOW).await;
        assert_eq!(removed.len(), 1, "{removed:?}");
        assert!(removed[0].to_string_lossy().contains("/.worktrees/"));
        let _ = std::fs::remove_dir_all(&repo);
    }

    async fn repo_with_worktree(tag: &str) -> (PathBuf, PathBuf) {
        repo_with_worktree_in(tag, WORKTREE_ROOTS[0]).await
    }

    async fn repo_with_worktree_in(tag: &str, root: &str) -> (PathBuf, PathBuf) {
        let repo = std::env::temp_dir().join(format!(
            "forge-wt-reap-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        run(&repo, &["init", "-b", "main"]).await;
        run(&repo, &["config", "user.email", "t@t"]).await;
        run(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "one").unwrap();
        run(&repo, &["add", "."]).await;
        run(&repo, &["commit", "-m", "init"]).await;
        // A bare remote so `@{u}` resolves: on the fleet the agent pushes its
        // ISS-* branch, and a worktree with no upstream is spared by design.
        let remote = repo.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        run(&remote, &["init", "--bare", "-b", "main"]).await;
        run(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        run(&repo, &["push", "-u", "origin", "main"]).await;

        let wt = repo.join(root).join(format!("iss-{tag}"));
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        run(
            &repo,
            &["worktree", "add", &wt.to_string_lossy(), "-b", tag],
        )
        .await;
        run(&wt, &["push", "-u", "origin", tag]).await;
        (repo, wt)
    }

    const NOW: Duration = Duration::ZERO;

    #[tokio::test]
    async fn reaps_a_clean_worktree() {
        let (repo, wt) = repo_with_worktree("clean").await;
        assert_eq!(reap_repo(&repo, NOW).await.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard the age gate carries the safety on its own — a drive session runs
    // 60-90 minutes, so a fresh worktree may be a LIVE session and no git probe
    // would show it, the files being mid-write rather than committed or dirty.
    #[tokio::test]
    async fn spares_every_worktree_younger_than_the_gate() {
        let (repo, wt) = repo_with_worktree("fresh").await;
        assert!(reap_repo(&repo, MIN_AGE).await.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard a modified tracked file is work that exists nowhere else, and age
    // is no evidence it was abandoned — ISS-452 sat `waiting` for days with one.
    #[tokio::test]
    async fn spares_a_worktree_with_a_modified_tracked_file() {
        let (repo, wt) = repo_with_worktree("dirty").await;
        std::fs::write(wt.join("f.txt"), "changed").unwrap();
        assert!(reap_repo(&repo, NOW).await.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_whose_commits_were_never_pushed() {
        let (repo, wt) = repo_with_worktree("unpushed").await;
        std::fs::write(wt.join("g.txt"), "new").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-m", "local only"]).await;
        assert!(reap_repo(&repo, NOW).await.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard untracked output must NOT protect a worktree — node_modules would
    // otherwise pin every one of them forever, which is the leak itself.
    #[tokio::test]
    async fn untracked_build_output_does_not_pin_a_worktree() {
        let (repo, wt) = repo_with_worktree("artifacts").await;
        std::fs::create_dir_all(wt.join("node_modules")).unwrap();
        std::fs::write(wt.join("node_modules/x.js"), "built").unwrap();
        assert_eq!(reap_repo(&repo, NOW).await.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_repo_with_no_agent_worktrees_is_a_no_op() {
        let repo = std::env::temp_dir().join(format!("forge-wt-none-{}", std::process::id()));
        std::fs::create_dir_all(&repo).unwrap();
        assert!(reap_repo(&repo, NOW).await.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }
}
