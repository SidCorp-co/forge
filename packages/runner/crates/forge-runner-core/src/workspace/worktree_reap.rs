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
//! has no commit the remote lacks, and no tracked file in it is modified.
//! Untracked files do not protect it, or every build artifact would pin a
//! worktree forever.
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

// cm:guard the age gate is a MARGIN over the git probes, never the liveness test, and it stopped being one the day a run could park: a park waits on a person with no time limit and outlives a reboot (ISS-964 criterion 8), so a tree older than this may be perfectly live. The ledger is what answers that, and this number only bounds how long a tree nothing holds is kept.
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
// cm:guard the ONE definition of "this tree still holds work", read by the reaper before it deletes and by `runner/terminate.rs` before it releases — so what `Abandon` calls preserved is exactly what this reader calls safe. A second copy would let one of them delete what the other was still protecting (ISS-964 criteria 33, 37).
pub async fn holds_work(wt: &Path) -> bool {
    if let Some(out) = git(wt, &["status", "--porcelain", "--untracked-files=no"]).await {
        if !out.stdout.is_empty() {
            return true;
        }
    } else {
        return true;
    }
    match git(wt, &["log", "--oneline", "@{u}..", "-1"]).await {
        Some(out) if out.status.success() => !out.stdout.is_empty(),
        // cm:guard a missing upstream is not the question and must not be the answer. The question is whether these commits exist anywhere else, and a branch cut with `worktree add -b` has no upstream while sitting exactly on the base the remote already carries — measured on forge-vm 2026-09-11, 30 runs whose trees were clean and whose HEAD was on `origin/main` were refused release under the old reading, permanently: salvage then found nothing to preserve, `terminate` refused the disagreement, and the run could never end. Asking the remote directly answers the same safety question without the dead end.
        _ => !head_is_on_a_remote(wt).await,
    }
}

/// Whether some remote-tracking branch already contains this HEAD.
// cm:guard a repo with no remote, or a git that cannot answer, reports NOT reachable — the timid direction, because this is the reader that licenses a delete. Losing a tree whose only copy was local is unrecoverable; keeping one too long costs disk the sweep reclaims on the next pass.
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
// cm:guard the only way to build one is `from_ledger`, and that is the point: `reap_repo` cannot be called without having asked the ledger, so "no ledger available" stops the sweep at the call site instead of licensing a shape-only judgement (ISS-964 criterion 25).
#[derive(Debug, Default)]
pub struct HeldTrees(std::collections::HashMap<PathBuf, String>);

impl HeldTrees {
    // cm:guard every hold is keyed under BOTH its written spelling and its resolved one, because the two sides of this comparison do not derive the path from the same source: a run's tree is `resolve_repo`'s repo path, which prefers what the SERVER serves (`daemon/dispatch.rs`), while the sweep enumerates `cfg.bindings`. On the fleet those differ — jobs run under `/home/forge/projects/<slug>` — so one symlink or bind mount makes the same directory two strings, the lookup miss, and the park eaten by the reaper that exists to spare it (ISS-964 criterion 25).
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

    // cm:guard the resolved spelling is tried FIRST and the written one is the fallback, never the reverse: a candidate the sweep is looking at always exists, so its `canonicalize` succeeds, while a ledger row whose tree is already gone can only ever be keyed by the raw path.
    fn holder(&self, path: &Path) -> Option<&str> {
        path.canonicalize()
            .ok()
            .and_then(|real| self.0.get(&real))
            .or_else(|| self.0.get(path))
            .map(String::as_str)
    }
}

/// What one sweep of a repo did, and what it refused to do.
// cm:guard `held` is RETURNED and not merely logged: a refusal nothing can assert is a refusal that quietly stops happening, and this pair is what `refuses_a_tree_the_ledger_still_holds` reads (ISS-964 criterion 25).
#[derive(Debug, Default)]
pub struct Reaped {
    pub removed: Vec<PathBuf>,
    /// Each tree left alone, with the run id that holds it.
    pub held: Vec<(PathBuf, String)>,
}

/// Reap one repo's stale agent worktrees, asking the ledger before each.
// cm:guard `HeldTrees` is a REQUIRED argument and never an `Option`: "no ledger available" must stop the sweep, not license it to judge on shape alone. A sweeper that deletes when it cannot ask is the exact failure criterion 25 names, and an `Option` makes it the default at every future call site.
// cm:edge protocol -> packages/runner/crates/forge-runner-core/src/runner/ledger.rs — `held_worktrees` is the question, and it must stay the one that ignores incarnation and boot; `live_run_at_path` answers a different question and would report every park as unheld.
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
            // cm:guard asked BEFORE the age and git probes and refused by NAME in the log: those three read shape, and a well-behaved park's shape is indistinguishable from abandonment, so shape alone eats the best-behaved park first.
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
        // cm:guard compare PATH COMPONENTS, never a slash-delimited substring — the separator is `\\` on Windows, so `contains("/.worktrees/")` asserts the platform rather than the lane and fails the windows leg of ci.yml's `runner` matrix while passing everywhere a developer looks.
        assert!(
            removed[0]
                .components()
                .any(|c| c.as_os_str() == std::ffi::OsStr::new(WORKTREE_ROOTS[1])),
            "{removed:?}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard criterion 36's own case, and the one the pre-ISS-964 predicate got wrong: this tree is old, clean, fully pushed and silent — every shape signal says abandoned — and it is a live park holding a diff a person is being asked about. No reaper may conclude abandonment from shape.
    #[tokio::test]
    async fn refuses_a_clean_pushed_silent_tree_a_park_still_holds() {
        let (repo, wt) = repo_with_worktree("parked").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, false)).await;

        assert!(swept.removed.is_empty(), "{swept:?}");
        assert!(wt.exists());
        // cm:guard the refusal NAMES the run, because a log line saying only "kept 1" leaves an operator unable to tell a held tree from a bug in the sweep.
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

    // cm:guard the two sides of the hold do NOT derive the path from one source: a run records `resolve_repo`'s answer, which prefers what the server serves, and the sweep enumerates `cfg.bindings`. This test spells the hold through a symlink to the very tree the sweep walks directly, which is the fleet's own shape (`/home/forge/projects/<slug>` vs the binding) — without canonicalisation on both sides the lookup misses and the park is deleted (ISS-964 criterion 25).
    // cm:why unix-only because the case IS a symlink: creating one on Windows needs Developer Mode or an elevated process, so the windows leg of ci.yml's `runner` matrix would fail on the fixture rather than on the property.
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

    // cm:guard the SAME divergence with the spellings swapped, and it needs its own case because the two halves of the fix cover one direction each: keying the ledger row under its resolved path covers a hold written through the symlink, and resolving the candidate covers a binding that IS the symlink. Either half alone leaves one of these two green and the other eating a park.
    // cm:why unix-only because the case IS a symlink: creating one on Windows needs Developer Mode or an elevated process, so the windows leg of ci.yml's `runner` matrix would fail on the fixture rather than on the property.
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

    // cm:guard the park's `boot_id` is a PREVIOUS boot and its incarnation is `none`, which is exactly what `live_run_at_path` predicates against. Answer this question with that one and every park across a reboot reads as unheld — the reboot survival criterion 8 promises is what makes this the realistic case rather than an exotic one.
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

    // cm:guard the hold ENDS with the run, or the ledger becomes a permanent pin and the disk problem this sweep exists for comes back with a tidier cause.
    #[tokio::test]
    async fn reaps_a_tree_whose_run_has_ended() {
        let (repo, wt) = repo_with_worktree("ended").await;
        let swept = reap_repo(&repo, NOW, &led_holding(&wt, true, true)).await;

        assert_eq!(swept.removed.len(), 1, "{swept:?}");
        assert!(swept.held.is_empty(), "{swept:?}");
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard a tree held under a DIFFERENT path must not shield this one — the snapshot is keyed by path, and a holder lookup that ignored the key would pin every tree on the box the moment one run existed.
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

    // cm:guard the age gate is the LAST line, not the first: the ledger above it
    // is what knows a tree is live, and no git probe
    // would show it, the files being mid-write rather than committed or dirty.
    #[tokio::test]
    async fn spares_every_worktree_younger_than_the_gate() {
        let (repo, wt) = repo_with_worktree("fresh").await;
        assert!(reap_repo(&repo, MIN_AGE, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard a modified tracked file is work that exists nowhere else, and age
    // is no evidence it was abandoned — ISS-452 sat `waiting` for days with one.
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

    // cm:guard untracked output must NOT protect a worktree — node_modules would
    // otherwise pin every one of them forever, which is the leak itself.
    #[tokio::test]
    async fn untracked_build_output_does_not_pin_a_worktree() {
        let (repo, wt) = repo_with_worktree("artifacts").await;
        std::fs::create_dir_all(wt.join("node_modules")).unwrap();
        std::fs::write(wt.join("node_modules/x.js"), "built").unwrap();
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
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
    // cm:guard this is the line the old reading had no test for, and the one that stalled a box: every other test here pushes its branch, so `@{u}` resolved and the no-upstream arm was never exercised. Reaping it is safe because HEAD is `origin/main` — nothing in the tree exists only here.
    #[tokio::test]
    async fn reaps_a_clean_worktree_whose_branch_was_never_given_an_upstream() {
        let (repo, wt) = repo_with_worktree_pushed("noup", WORKTREE_ROOTS[0], false).await;
        assert_eq!(reap_repo(&repo, NOW, &led()).await.removed.len(), 1);
        assert!(!wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }

    // cm:guard the safety half of the same change, and it must never soften: no upstream AND a commit no remote ref contains is work that exists nowhere else.
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

    // cm:guard a repo with no remote at all cannot prove anything is copied, so the tree stays.
    #[tokio::test]
    async fn spares_a_worktree_in_a_repo_that_has_no_remote() {
        let (repo, wt) = repo_with_worktree_pushed("noremote", WORKTREE_ROOTS[0], false).await;
        run(&repo, &["remote", "remove", "origin"]).await;
        assert!(reap_repo(&repo, NOW, &led()).await.removed.is_empty());
        assert!(wt.exists());
        let _ = std::fs::remove_dir_all(&repo);
    }
}
