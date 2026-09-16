//! Reaping the agent worktrees nothing else removes.
//!
//! Two directories, from two different conventions, and nothing used to remove
//! either: `<repo>/.claude/worktrees/<slug>` is Claude Code's own, and
//! `<repo>/.worktrees/<branch>` is what `worktree::create` cuts for a job. They
//! accumulate for the life of the box.
//!
//! A liveness problem rather than tidiness: a full disk fails every job on the
//! box (ubuntu6, 2026-08-20).
//!
//! The predicate is deliberately timid — this deletes work, and a wrong
//! judgement here is unrecoverable. A worktree is reaped only when all four
//! hold: no run in the ledger still holds it, it is older than `MIN_AGE`, it
//! has no commit the remote lacks, and nothing in it is unsaved — a modified
//! tracked file, or a file git has never been told about. Files `.gitignore`
//! claims protect nothing, which is what keeps build output from pinning a
//! checkout forever.
//!
//! The ledger is first among those because the other three are all SHAPE, and
//! a well-behaved park has exactly the shape of an abandoned tree (ISS-964
//! criteria 25, 36).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};

use tokio::process::Command;

use crate::error::Result;
use crate::runner::ledger::Ledger;

pub const MIN_AGE: Duration = Duration::from_secs(14 * 24 * 3600);

/// Every directory a checkout can be cut into, relative to the repo root.
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
pub async fn holds_work(wt: &Path) -> bool {
    if has_unsaved_changes(wt).await {
        return true;
    }
    match git(wt, &["log", "--oneline", "@{u}..", "-1"]).await {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        _ => !head_is_on_a_remote(wt).await,
    }
}

/// Whether a tracked file in this worktree differs from its commit.
pub async fn has_uncommitted_changes(wt: &Path) -> bool {
    match git(wt, &["status", "--porcelain", "--untracked-files=no"]).await {
        Some(out) => !out.stdout.is_empty(),
        None => true,
    }
}

/// Whether this worktree holds anything a `git worktree remove` would destroy.
///
/// Tracked modifications, plus files git has never been told about.
pub async fn has_unsaved_changes(wt: &Path) -> bool {
    if has_uncommitted_changes(wt).await {
        return true;
    }
    match git(wt, &["ls-files", "--others", "--exclude-standard"]).await {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        _ => true,
    }
}

/// Whether some remote-tracking branch already contains this HEAD.
async fn head_is_on_a_remote(wt: &Path) -> bool {
    matches!(
        git(wt, &["branch", "-r", "--contains", "HEAD"]).await,
        Some(out) if out.status.success() && !out.stdout.is_empty()
    )
}

fn older_than(p: &Path, age: Duration) -> bool {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|m| SystemTime::now().duration_since(m).ok())
        .is_some_and(|d| d >= age)
}

/// The trees the ledger says a run still holds, snapshotted for one sweep.
///
/// A snapshot rather than a query per tree because `rusqlite::Connection` is
/// not `Send` and the sweep awaits `git` between candidates; taken immediately
/// before each repo's pass, so the window it can be stale over is that pass.
#[derive(Debug, Default)]
pub struct HeldTrees(std::collections::HashMap<PathBuf, String>);

impl HeldTrees {
    pub fn from_ledger(ledger: &Ledger) -> Result<Self> {
        let mut held = std::collections::HashMap::new();
        for (path, run_id) in ledger.held_worktrees()? {
            if let Ok(real) = path.canonicalize() {
                held.insert(real, run_id.clone());
            }
            held.insert(path, run_id);
        }
        Ok(Self(held))
    }

    fn holder(&self, path: &Path) -> Option<&str> {
        path.canonicalize()
            .ok()
            .and_then(|real| self.0.get(&real))
            .or_else(|| self.0.get(path))
            .map(String::as_str)
    }
}

/// What one sweep of a repo did, and what it refused to do.
#[derive(Debug, Default)]
pub struct Reaped {
    pub removed: Vec<PathBuf>,
    /// Each tree left alone, with the run id that holds it.
    pub held: Vec<(PathBuf, String)>,
}

/// Reap one repo's stale agent worktrees, asking the ledger before each.
pub async fn reap_repo(repo: &Path, min_age: Duration, held_by: &HeldTrees) -> Reaped {
    let mut removed: Vec<PathBuf> = Vec::new();
    let mut held: Vec<(PathBuf, String)> = Vec::new();
    for root in WORKTREE_ROOTS {
        let Ok(entries) = std::fs::read_dir(repo.join(root)) else {
            continue;
        };
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_dir() {
                continue;
            }
            if let Some(run_id) = held_by.holder(&p) {
                tracing::info!(
                    "[worktree-reap] keeping {} — run {run_id} still holds it in the ledger",
                    p.display()
                );
                held.push((p, run_id.to_string()));
                continue;
            }
            if !older_than(&p, min_age) || holds_work(&p).await {
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
    Reaped { removed, held }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::runner::ledger::NewRun;

    /// A ledger holding nothing, for the cases about the git and age predicates.
    fn led() -> HeldTrees {
        HeldTrees::default()
    }

    /// A ledger with one run holding `wt`, in whatever state the caller names.
    fn led_holding(wt: &Path, park: bool, ended: bool) -> HeldTrees {
        let mut l = Ledger::open_in_memory().unwrap();
        l.create_run_group(NewRun {
            run_id: "run-held".into(),
            project_id: "p-1".into(),
            master_session_id: "m-1".into(),
            boot_id: "boot-before-the-reboot".into(),
            worktree_path: wt.to_path_buf(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        if park {
            l.begin_question("q-1", "run-held", 1, "q-1").unwrap();
            l.declare_parked_human("run-held", Some("resume-1"), None)
                .unwrap();
        }
        if ended {
            l.end_run("run-held", "operator", "abandoned").unwrap();
        }
        HeldTrees::from_ledger(&l).unwrap()
    }

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
        let removed = reap_repo(&repo, NOW, &led()).await.removed;
        assert_eq!(removed.len(), 1, "{removed:?}");
        assert!(
            removed[0]
                .components()
                .any(|c| c.as_os_str() == std::ffi::OsStr::new(WORKTREE_ROOTS[1])),
            "{removed:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn refuses_a_clean_pushed_silent_tree_a_park_still_holds() {
        let (repo, wt) = repo_with_worktree("parked").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        assert_eq!(
            swept
                .held
                .iter()
                .map(|(_, r)| r.as_str())
                .collect::<Vec<_>>(),
            vec!["run-held"],
            "{swept:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn holds_a_park_the_ledger_recorded_under_a_different_spelling() {
        let (repo, wt) = repo_with_worktree("spelling").await;
        let link = repo.with_extension("served");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&repo, &link).unwrap();
        let served = link.join(WORKTREE_ROOTS[0]).join("iss-spelling");
        assert_ne!(served, wt, "the two spellings must differ as strings");

        let swept = reap_repo(&repo, NOW, &led_holding(&served, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn holds_a_park_when_the_sweep_is_the_one_walking_a_symlink() {
        let (repo, wt) = repo_with_worktree("bound").await;
        let link = repo.with_extension("bound-link");
        let _ = std::fs::remove_file(&link);
        std::os::unix::fs::symlink(&repo, &link).unwrap();

        let swept = reap_repo(&link, NOW, &led_holding(&wt, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        let _ = std::fs::remove_file(&link);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn holds_a_park_that_outlived_the_boot_it_was_made_in() {
        let (repo, wt) = repo_with_worktree("rebooted").await;
        let held = led_holding(&wt, true, false);
        assert_eq!(held.holder(&wt), Some("run-held"));

        let swept = reap_repo(&repo, NOW, &held).await;
        assert!(swept.removed.is_empty(), "{swept:?}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn holds_a_tree_a_live_run_is_working_in() {
        let (repo, wt) = repo_with_worktree("live-run").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, false, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn reaps_a_tree_whose_run_has_ended() {
        let (repo, wt) = repo_with_worktree("ended").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, true)).await;

        assert_eq!(swept.removed.len(), 1, "{swept:?}");
        assert!(swept.held.is_empty(), "{swept:?}");
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_hold_on_another_tree_shields_nothing() {
        let (repo, wt) = repo_with_worktree("unrelated").await;
        let swept = reap_repo(
            &repo,
            NOW,
            &led_holding(Path::new("/somewhere/else"), true, false),
        )
        .await;

        assert_eq!(swept.removed.len(), 1, "{swept:?}");
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    async fn repo_with_worktree(tag: &str) -> (PathBuf, PathBuf) {
        repo_with_worktree_in(tag, WORKTREE_ROOTS[0]).await
    }

    async fn repo_with_worktree_in(tag: &str, root: &str) -> (PathBuf, PathBuf) {
        repo_with_worktree_pushed(tag, root, true).await
    }

    async fn repo_with_worktree_pushed(tag: &str, root: &str, push: bool) -> (PathBuf, PathBuf) {
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
        if push {
            run(&wt, &["push", "-u", "origin", tag]).await;
        }
        (repo, wt)
    }

    const NOW: Duration = Duration::ZERO;

    #[tokio::test]
    async fn reaps_a_clean_worktree() {
        let (repo, wt) = repo_with_worktree("clean").await;
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_every_worktree_younger_than_the_gate() {
        let (repo, wt) = repo_with_worktree("fresh").await;
        assert!(reap_repo(&repo, MIN_AGE, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_with_a_modified_tracked_file() {
        let (repo, wt) = repo_with_worktree("dirty").await;
        std::fs::write(wt.join("f.txt"), "changed").unwrap();
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_whose_commits_were_never_pushed() {
        let (repo, wt) = repo_with_worktree("unpushed").await;
        std::fs::write(wt.join("g.txt"), "new").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-m", "local only"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn ignored_build_output_does_not_pin_a_worktree() {
        let (repo, wt) = repo_with_worktree("artifacts").await;
        // Written to `.git/info/exclude` rather than a committed `.gitignore`, because committing
        // one would put an unpushed commit on the branch and this test would then be spared for a
        // reason it is not about. `--exclude-standard` reads both.
        std::fs::write(repo.join(".git/info/exclude"), "node_modules/\n").unwrap();
        std::fs::create_dir_all(wt.join("node_modules")).unwrap();
        std::fs::write(wt.join("node_modules/x.js"), "built").unwrap();
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_holding_an_untracked_file_the_repo_does_not_ignore() {
        let (repo, wt) = repo_with_worktree("untracked").await;
        std::fs::write(wt.join("notes.md"), "the only copy of this").unwrap();
        assert!(
            reap_repo(&repo, NOW, &led()).await.removed.is_empty(),
            "a file the repository did not call disposable is work, and this sweep deletes work irreversibly"
        );
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn a_repo_with_no_agent_worktrees_is_a_no_op() {
        let repo = std::env::temp_dir().join(format!("forge-wt-none-{}", std::process::id()));
        std::fs::create_dir_all(&repo).unwrap();
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        let _ = std::fs::remove_dir_all(&repo);
    }
    /// The forge-vm shape: `worktree add -b` leaves no upstream, and the base is already on the remote.
    #[tokio::test]
    async fn reaps_a_clean_worktree_whose_branch_was_never_given_an_upstream() {
        let (repo, wt) = repo_with_worktree_pushed("noup", WORKTREE_ROOTS[0], false).await;
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_with_no_upstream_carrying_a_commit_of_its_own() {
        let (repo, wt) = repo_with_worktree_pushed("noup-commit", WORKTREE_ROOTS[0], false).await;
        std::fs::write(wt.join("g.txt"), "local").unwrap();
        run(&wt, &["add", "."]).await;
        run(&wt, &["commit", "-m", "nowhere else"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn spares_a_worktree_in_a_repo_that_has_no_remote() {
        let (repo, wt) = repo_with_worktree_pushed("noremote", WORKTREE_ROOTS[0], false).await;
        run(&repo, &["remote", "remove", "origin"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }
}
