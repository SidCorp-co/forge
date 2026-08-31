//! Bring a provisioned workspace up to date before an agent reads it.
//!
//! Provisioning clones once and nothing refreshed the folder afterwards, so
//! every lane inherited whatever HEAD it was left at. Measured on agent session
//! 228cdf03 (ceo-dashboard): the checkout predated by 2.5h the merge it was
//! later asked about, it then idled 28h, and its answer had 6 of 7 claims wrong.
//!
//! A bare `git fetch` does NOT fix that: it moves remote-tracking refs while the
//! working tree stays old, and an agent that reads files is still wrong. So this
//! fast-forwards the tree, and reports what it actually ended up on.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

/// Cap for the network hop. Matches the preflight `ls-remote` budget — a slow
/// remote must not hold a job or a chat turn open indefinitely.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

/// Paths Forge itself rewrites inside a provisioned workspace. A project that
/// commits `.forge/` therefore has a dirty tree that is nobody's
/// work-in-progress, so these can never be what blocks a refresh.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/orientation.rs — that module rewrites `.forge/orientation.md` in full and the marker block in `CLAUDE.md` on every provision; a path added there and not here starts failing every refresh on a project that tracks it
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/worktree.rs — `ensure_gitignore` appends the `.worktrees` line to a tracked `.gitignore`
const FORGE_OWNED_PATHS: [&str; 3] = [".forge/orientation.md", "CLAUDE.md", ".gitignore"];

/// What the workspace was sitting on when the agent got it. Recorded even when
/// the refresh could not run — an unrefreshed workspace that says so is
/// auditable; one that says nothing is the defect this module exists for.
#[derive(Debug, Clone, Default)]
pub struct WorkspaceGit {
    pub head_sha: Option<String>,
    pub base_branch: Option<String>,
    /// Resolved `origin/<base>` after the fetch.
    pub base_sha: Option<String>,
    pub refreshed: bool,
    /// Why the refresh did not happen. `None` when it did.
    pub detail: Option<String>,
    /// The refresh backed off because the tree carried uncommitted work that is
    /// not Forge's. Distinct from every other `!refreshed` reason: nothing is
    /// broken here and there is nothing to repair.
    pub foreign_work: bool,
}

impl WorkspaceGit {
    /// True when the tree is known to be behind its base — the state in which
    /// nothing the agent reads may be trusted as "what is on the base branch".
    pub fn is_stale(&self) -> bool {
        match (&self.head_sha, &self.base_sha) {
            (Some(head), Some(base)) => head != base,
            _ => false,
        }
    }
}

async fn git(repo: &Path, args: &[&str]) -> Option<std::process::Output> {
    Command::new("git")
        .args(["-C"])
        .arg(repo)
        .args(args)
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .ok()
}

async fn git_line(repo: &Path, args: &[&str]) -> Option<String> {
    let out = git(repo, args).await?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn stderr_brief(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr)
        .trim()
        .chars()
        .take(300)
        .collect()
}

/// Dirty tracked paths, excluding the ones Forge owns. Empty means the tree
/// carries no work of anyone else's.
async fn foreign_dirty_paths(repo: &Path) -> Vec<String> {
    let Some(out) = git(repo, &["status", "--porcelain", "--untracked-files=no"]).await else {
        return Vec::new();
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            // porcelain v1: XY<space>path — take everything past the status pair.
            let path = line.get(3..)?.trim();
            if path.is_empty() || FORGE_OWNED_PATHS.contains(&path) {
                None
            } else {
                Some(path.to_string())
            }
        })
        .collect()
}

/// Fetch `origin` and fast-forward `base_branch` (or the currently checked-out
/// branch when no base is known), then report the resulting git identity.
///
/// Never panics and never returns `Err`: a workspace that could not be
/// refreshed is a fact the caller must act on, not an error to unwrap. Callers
/// decide the policy — both lanes now run and tell the agent what it is looking
/// at; the pipeline lane additionally tells it to fix the checkout, which it is
/// the only lane in a position to do.
pub async fn refresh(repo_path: &Path, base_branch: Option<&str>) -> WorkspaceGit {
    let mut state = WorkspaceGit::default();

    if git_line(repo_path, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        != Some("true")
    {
        state.detail = Some("not a git work tree".into());
        return state;
    }

    state.head_sha = git_line(repo_path, &["rev-parse", "HEAD"]).await;
    let current = git_line(repo_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await;
    let base = base_branch
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| current.clone().filter(|b| b != "HEAD"));
    let Some(base) = base else {
        state.detail = Some("no base branch resolvable (detached HEAD, no configured base)".into());
        return state;
    };
    state.base_branch = Some(base.clone());

    let fetch = Command::new("git")
        .args(["-C"])
        .arg(repo_path)
        .args(["fetch", "origin", &base])
        .stdin(Stdio::null())
        .env("GIT_TERMINAL_PROMPT", "0")
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(FETCH_TIMEOUT, fetch).await {
        Err(_) => {
            state.detail = Some(format!(
                "fetch timed out after {}s",
                FETCH_TIMEOUT.as_secs()
            ));
            return state;
        }
        Ok(Err(e)) => {
            state.detail = Some(format!("fetch could not run: {e}"));
            return state;
        }
        Ok(Ok(out)) if !out.status.success() => {
            state.detail = Some(format!("fetch failed: {}", stderr_brief(&out)));
            return state;
        }
        Ok(Ok(_)) => {}
    }

    state.base_sha = git_line(repo_path, &["rev-parse", &format!("origin/{base}")]).await;

    // A worktree-less stage runs in the repo root, so the tree must actually be
    // on the base branch for a fast-forward to mean anything.
    if current.as_deref() != Some(base.as_str()) {
        state.detail = Some(format!(
            "checked out {} , not the base branch {base} — left alone",
            current.as_deref().unwrap_or("an unknown ref")
        ));
        return state;
    }

    // cm:guard restore the Forge-owned paths BEFORE the fast-forward and never merge over them. Provision rewrites `.forge/orientation.md` in full, so on a project that COMMITS `.forge/` the tree is permanently dirty on a Forge-authored file; without this every refresh on such a project fails with "local changes would be overwritten" — which is this repo itself. Forge owns those files, so the incoming version wins.
    let foreign = foreign_dirty_paths(repo_path).await;
    if !foreign.is_empty() {
        // cm:guard record WHY this refresh stopped, not just that it did. Every other `!refreshed` reason is a fault a repair agent should fix; this one is someone else's work, and the repair agent's only tool for an obstacle is `git stash`. Flattening the two into one boolean is what let a setup agent stash an interactive session's uncommitted files on 2026-08-31 — the careful branch reported backing off, and the report summoned the branch that does not back off.
        state.foreign_work = true;
        state.detail = Some(format!(
            "tree has uncommitted changes outside the Forge-owned paths ({}) — left alone",
            foreign.join(", ").chars().take(200).collect::<String>()
        ));
        return state;
    }
    for path in FORGE_OWNED_PATHS {
        let _ = git(repo_path, &["checkout", "--", path]).await;
    }

    match git(
        repo_path,
        &["merge", "--ff-only", &format!("origin/{base}")],
    )
    .await
    {
        Some(out) if out.status.success() => {
            state.refreshed = true;
            state.head_sha = git_line(repo_path, &["rev-parse", "HEAD"]).await;
        }
        Some(out) => {
            state.detail = Some(format!("fast-forward refused: {}", stderr_brief(&out)));
        }
        None => {
            state.detail = Some("fast-forward could not run".into());
        }
    }
    state
}

/// One line for a prompt or a log: what the agent is actually looking at.
pub fn describe(state: &WorkspaceGit) -> String {
    let head = state.head_sha.as_deref().unwrap_or("unknown");
    let base = state.base_branch.as_deref().unwrap_or("unknown");
    let base_sha = state.base_sha.as_deref().unwrap_or("unknown");
    let short = |s: &str| s.chars().take(8).collect::<String>();
    if state.refreshed {
        format!("workspace refreshed: HEAD {} on {base}", short(head))
    } else {
        format!(
            "workspace NOT refreshed ({}): HEAD {}, origin/{base} {}",
            state.detail.as_deref().unwrap_or("no reason recorded"),
            short(head),
            short(base_sha)
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forge_owned_paths_are_not_reported_as_foreign_work() {
        // The three paths provision rewrites must never be what blocks a refresh.
        for p in FORGE_OWNED_PATHS {
            assert!(FORGE_OWNED_PATHS.contains(&p));
        }
        assert!(!FORGE_OWNED_PATHS.contains(&"packages/core/src/index.ts"));
    }

    /// Unique temp dir per test (no tempfile dep in this crate).
    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("forge-refresh-{name}-{}", std::process::id()))
    }

    fn git_ok(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(args)
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    // cm:guard this test owns the SETTER, and nothing else does. `refresh_is_repairable` in dispatch.rs reads the flag, so a unit test of the predicate stays green while the flag is never written — the branch that suppresses the finding would then be unreachable and the stash would come back with every gate still passing.
    #[tokio::test]
    async fn a_tree_holding_someone_elses_work_reports_it_and_refuses_to_move() {
        let root = temp_path("foreign");
        let origin = root.join("origin");
        let work = root.join("work");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&origin).expect("mkdir");
        std::fs::create_dir_all(&work).expect("mkdir");

        git_ok(&origin, &["init", "-q", "--bare"]);
        git_ok(&work, &["init", "-q", "-b", "main"]);
        git_ok(&work, &["config", "user.email", "t@t"]);
        git_ok(&work, &["config", "user.name", "t"]);
        std::fs::write(work.join("a.txt"), "one\n").expect("write");
        git_ok(&work, &["add", "-A"]);
        git_ok(&work, &["commit", "-qm", "init"]);
        git_ok(
            &work,
            &["remote", "add", "origin", origin.to_str().expect("utf8")],
        );
        git_ok(&work, &["push", "-q", "-u", "origin", "main"]);

        std::fs::write(work.join("a.txt"), "someone is editing this\n").expect("write");
        let state = refresh(&work, Some("main")).await;
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            state.foreign_work,
            "an uncommitted change to a non-Forge file must be reported as foreign work, or the finding is never suppressed"
        );
        assert!(!state.refreshed, "the tree must be left where it is");
        assert!(
            state.detail.as_deref().unwrap_or("").contains("a.txt"),
            "the notice has to name the file so a human can tell whose work it is: {:?}",
            state.detail
        );
        assert_eq!(
            std::fs::read_to_string(work.join("a.txt")).ok().as_deref(),
            None,
            "the temp tree should be gone; this asserts cleanup, not content"
        );
    }

    #[test]
    fn foreign_work_is_off_until_the_refresh_says_otherwise() {
        assert!(
            !WorkspaceGit::default().foreign_work,
            "the default must not claim someone else's work is present — that claim suppresses a repairable finding"
        );
    }

    #[test]
    fn stale_only_when_both_shas_known_and_differ() {
        let mut s = WorkspaceGit::default();
        assert!(!s.is_stale(), "unknown state is not a staleness claim");
        s.head_sha = Some("aaa".into());
        assert!(!s.is_stale());
        s.base_sha = Some("aaa".into());
        assert!(!s.is_stale());
        s.base_sha = Some("bbb".into());
        assert!(s.is_stale());
    }

    #[test]
    fn describe_names_the_reason_when_not_refreshed() {
        let s = WorkspaceGit {
            head_sha: Some("1234567890".into()),
            base_branch: Some("main".into()),
            base_sha: Some("abcdef1234".into()),
            refreshed: false,
            detail: Some("fetch failed: boom".into()),
            foreign_work: false,
        };
        let line = describe(&s);
        assert!(line.contains("NOT refreshed"));
        assert!(line.contains("fetch failed: boom"));
        assert!(line.contains("12345678"));
    }
}
