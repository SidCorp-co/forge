//! The external way out of every state (ISS-964 criteria 32, 33).
//!
//! Four states — `incarnation` × `work` — and two verbs. `Kill` where a
//! process exists, `Abandon` where none does; which one applies follows from
//! `incarnation` and is never a caller's choice, because a caller that could
//! pick would eventually pick `Abandon` over a live agent and leave it writing
//! git into a worktree the record says is free.
//!
//! Both verbs are enforced on the RECORD. Neither asks the agent to stop and
//! neither waits for it to agree. What they do wait for is the diff: the work a
//! parked agent left is the only thing here that cannot be recreated, so the
//! preserve step runs BEFORE the worktree is released and a preserve that could
//! not be trusted refuses the whole verb rather than releasing anyway.
//!
//! What "cannot be recreated" means is the repository's answer and not a
//! remote's. `git worktree remove` takes a directory and an administrative
//! entry; it leaves every ref where it was, so work already named by a branch,
//! a tag or a remote-tracking ref survives the release whatever any remote
//! says. Reading it as a remote's answer instead needed a branch name and a
//! reachable remote, and a checkout that could supply neither was refused every
//! sweep for as long as the box lived, with the run's leases inside the refusal
//! (ISS-1188).
//!
//! And a refusal here ENDS. [`release`] gives one a window to clear in and
//! decides it when it does not: the leases go back, the run is over, and the
//! checkout stays on disk with nobody's permission to remove it. A release
//! nobody can make is a state to report once, never a thing to attempt for ever.

use std::path::Path;

use crate::error::{Error, Result};
use crate::runner::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::runner::inflight::Reaped;
use crate::runner::ledger::{Incarnation, Ledger, Run};
use crate::workspace::salvage::{self, Outcome, Salvage};
use crate::workspace::worktree::Kind as WorktreeKind;

/// How a run's process group is stopped. A port so the verb is testable
/// without a real agent on the box.
#[async_trait::async_trait]
pub trait ProcessGroup: Send + Sync {
    async fn kill(&self, pid: u32) -> Reaped;
}

/// The box's own process table.
pub struct SystemProcesses;

#[async_trait::async_trait]
impl ProcessGroup for SystemProcesses {
    async fn kill(&self, pid: u32) -> Reaped {
        crate::runner::inflight::kill_group(pid).await
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verb {
    Kill,
    Abandon,
}

/// What forcing a run terminal actually did.
#[derive(Debug)]
pub struct Forced {
    pub verb: Verb,
    /// `None` when the worktree was already off the disk.
    pub salvage: Option<Salvage>,
    pub close: CloseState,
    /// What became of the checkout the run named.
    pub worktree: WorktreeOutcome,
    /// How the commits the checkout held were kept. `None` where there was no
    /// checkout to take back.
    pub commits: Option<Commits>,
}

/// What the release did with the path the run was declared against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeOutcome {
    /// The run's own checkout was released, or there was none at the path.
    Released,
    /// The run named the repository's MAIN working tree, which it never held
    /// and which has to outlive it. Nothing was preserved and nothing removed.
    MainWorkingTreeKept,
}

pub fn verb_for(run: &Run, this_boot: &str) -> Result<Verb> {
    match run.incarnation {
        Incarnation::Exited => Ok(Verb::Abandon),
        Incarnation::Live | Incarnation::Starting if run.boot_id == this_boot => Ok(Verb::Kill),
        _ => Err(Error::Other(format!(
            "run {} is `{:?}` from boot {} and this box is {} — liveness is unknown, \
             so nothing may be reclaimed; resolve the boot first",
            run.run_id, run.incarnation, run.boot_id, this_boot
        ))),
    }
}

async fn branch_of(worktree: &Path) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(["symbolic-ref", "--short", "HEAD"])
        .current_dir(worktree)
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!name.is_empty()).then_some(name)
}

fn committed(outcome: Outcome) -> bool {
    matches!(outcome, Outcome::Pushed | Outcome::CommittedNotPushed)
}

/// What the release did about the commits the checkout held.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Commits {
    /// A ref this repository keeps already named every one of them.
    AlreadyNamed,
    /// Nothing named them, so the release wrote this ref before the checkout
    /// went. `git log <ref>` is where they are.
    NamedBy(String),
}

/// Make sure the commits in this checkout outlive it, and say how.
///
/// Publication is attempted first and is still worth having — where there is a
/// branch to name and a remote that answers, the push happens as it always did.
/// What it is NOT is the thing that makes the release safe. It used to be, and
/// two of its inputs can be missing: a detached HEAD has no branch to push, and
/// a repository with no remote, or one that cannot be reached, can never answer
/// "is this on a remote?" with a yes. Each of those was refused every sweep
/// forever, holding the run's leases out of every queue on the box (ISS-1188).
///
/// What release safety actually turns on is whether the commits survive the
/// checkout's removal, and the repository answers that by sha on every input.
/// `git worktree remove` takes the directory, never the refs.
async fn keep_before_release(
    run_id: &str,
    verb: Verb,
    worktree: &Path,
    branch: Option<&str>,
) -> Result<Commits> {
    if let Some(branch) = branch {
        if !matches!(
            salvage::publication_of(worktree).await,
            salvage::Publication::Published
        ) {
            let published = salvage::publish(worktree, branch).await;
            if !matches!(published, salvage::Publication::Published) {
                tracing::info!(
                    "[terminate] run {run_id}: `{branch}` in {} did not reach a remote ({published:?}) — \
                     the release goes on the refs this repository keeps instead",
                    worktree.display()
                );
            }
        }
    }
    match salvage::retention_of(worktree).await {
        salvage::Retention::Kept => Ok(Commits::AlreadyNamed),
        salvage::Retention::AtRisk { commits } => salvage::keep_at(worktree, run_id)
            .await
            .map(Commits::NamedBy)
            .map_err(|why| {
                Error::Other(format!(
                    "refusing to {verb:?} run {run_id}: {commits} commit(s) in {} are named by \
                     this checkout and by nothing else, and they could not be given a ref of \
                     their own ({why}) — the checkout stays, because removing it is what would \
                     lose them",
                    worktree.display()
                ))
            }),
        salvage::Retention::Unknown { why } => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: this box cannot tell whether the commits in {} \
             are named by any ref besides this checkout's own HEAD ({why}) — the checkout stays, \
             because not knowing is not the same as knowing it is safe",
            worktree.display()
        ))),
    }
}

/// Whether the path the run names is a checkout this run has to give back.
///
/// `true` means it is the repository's own MAIN working tree: the run never
/// took it from the pool, so there is nothing to preserve and nothing to
/// remove, and it has to outlive the run. `false` means an ordinary checkout,
/// released the way it always was.
///
/// An unidentifiable path is neither, and is refused rather than guessed at.
/// Falling through to the release on `Unknown` would publish and remove a path
/// this box could not name — not knowing what something is is not a licence to
/// delete it, and a run whose kind could not be read has not been released.
fn holds_no_checkout(kind: WorktreeKind, verb: Verb, run_id: &str, path: &Path) -> Result<bool> {
    match kind {
        WorktreeKind::MainWorkingTree => Ok(true),
        WorktreeKind::Linked | WorktreeKind::NotAWorktree => Ok(false),
        WorktreeKind::Unknown => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: this box could not ask git what {} is — the \
             checkout stays, because not knowing is not the same as knowing it is safe",
            path.display()
        ))),
    }
}

pub async fn force_terminal(
    ledger: &mut Ledger,
    run_id: &str,
    what: Forcing<'_>,
    ports: Ports<'_>,
) -> Result<Forced> {
    let Some(run) = ledger.run(run_id)? else {
        return Err(Error::Other(format!("run {run_id} is not in this ledger")));
    };
    let verb = verb_for(&run, what.this_boot)?;

    if verb == Verb::Kill {
        if let Some(pid) = run.pid {
            ports.procs.kill(pid).await;
        }
    }

    let worktree = Path::new(&run.worktree_path);

    // A run declared against the repository's OWN checkout never took a
    // worktree from the pool, so it has none to preserve and none to give
    // back, and the checkout has to outlive it. Both branches below ask after
    // a tree this run never held: `git worktree remove` refuses a main working
    // tree by design, and `salvage::pick_target` already excludes the repo
    // root, so the preserve step could not have saved anything there either —
    // a dirty checkout would just fail the guard instead. Reading that out of
    // a failed removal, as this used to, cannot tell a refusal that will never
    // succeed from one that might, so the run was retried every sweep forever
    // and its leases never came back (ISS-1183). Git is asked instead, before
    // anything here is touched.
    let main_working_tree = holds_no_checkout(
        crate::workspace::worktree::kind_at(worktree).await,
        verb,
        run_id,
        worktree,
    )?;

    // A checkout whose branch this box cannot name is a DETACHED one, not an
    // unreadable one, and it is no longer fatal here. The branch name is what
    // builds a push refspec and what `salvage_wip` picks a target by; the
    // question the release turns on is asked by sha and needs neither.
    let mut commits = None;
    let salvage = if main_working_tree {
        None
    } else if worktree.exists() && crate::workspace::worktree_reap::holds_work(worktree).await {
        let branch = branch_of(worktree).await;
        // `salvage::pick_target` drops detached entries by design, so a detached
        // checkout has no salvage to run rather than a failed one. The guard
        // below is what decides whether its diff may be let go, and it says no.
        let report = match branch.as_deref() {
            Some(branch) => Some(
                salvage::salvage_wip(salvage::SalvageInput {
                    repo_root: what.repo_root,
                    base_branch: what.base_branch,
                    agent_branch: branch,
                    job_id: run_id,
                    attempt: 0,
                    failure: what.reason,
                })
                .await,
            ),
            None => None,
        };
        if !report.as_ref().is_some_and(|r| committed(r.outcome))
            && crate::workspace::worktree_reap::has_unsaved_changes(worktree).await
        {
            return Err(Error::Other(format!(
                "refusing to {verb:?} run {run_id}: the diff in {} was not preserved ({})",
                run.worktree_path.display(),
                report
                    .as_ref()
                    .and_then(|r| r.detail.as_deref())
                    .unwrap_or("this checkout is on no branch, so there was no salvage to run")
            )));
        }
        commits = Some(keep_before_release(run_id, verb, worktree, branch.as_deref()).await?);
        crate::workspace::worktree::remove_at(&what.repo_root.to_string_lossy(), worktree).await?;
        report
    } else {
        if worktree.exists() {
            let branch = branch_of(worktree).await;
            commits = Some(keep_before_release(run_id, verb, worktree, branch.as_deref()).await?);
            crate::workspace::worktree::remove_at(&what.repo_root.to_string_lossy(), worktree)
                .await?;
        }
        None
    };

    let close = close_loop::close(ledger, run_id, ports.sessions, ports.leases).await?;
    if close.is_closed() {
        ledger.end_run(run_id, what.by, what.reason)?;
    }
    Ok(Forced {
        verb,
        salvage,
        close,
        worktree: if main_working_tree {
            WorktreeOutcome::MainWorkingTreeKept
        } else {
            WorktreeOutcome::Released
        },
        commits,
    })
}

/// How long one refusal may stand before it is decided rather than retried.
///
/// Five minutes is about fifteen sweeps: long enough for a git lock, a slow
/// remote or a core that is not answering to clear on its own, and short enough
/// that the issues this run holds are not out of every queue on the box for
/// longer than somebody would notice. It is priced deliberately: a refusal that
/// WOULD have cleared at six minutes is decided at five and costs an operator
/// one `run release`, where the same refusal left to retry costs every issue
/// the run holds for as long as the box lives.
pub const RELEASE_GRACE_SECS: i64 = 5 * 60;

/// How many attempts one refusal may take before it is decided, whatever the
/// clock says.
///
/// The window above is wall-clock, and a wall clock moves both ways. One
/// correction is handled where the stamp is written; a box correcting itself
/// backwards over and over — a bad RTC, a hypervisor resuming a snapshot — can
/// hold any deadline off for as long as it keeps doing it, which is this
/// issue's own defect with a different input. A count cannot be corrected. The
/// two bounds are `or`: whichever is reached first decides, so a normal box is
/// decided by the window and a box whose clock cannot be trusted is still
/// decided.
pub const RELEASE_ATTEMPT_BOUND: i64 = 15;

/// What one attempt at releasing a finished run came to.
#[derive(Debug)]
pub enum Release {
    /// The checkout is back and the run is closed.
    Done(Box<Forced>),
    /// Refused, and the refusal is young enough that the next sweep tries
    /// again. `first` is true on the one attempt that opened this streak.
    Refusing {
        why: String,
        first: bool,
        standing_secs: i64,
    },
    /// Refused for longer than any retry can help. The leases are back, the run
    /// is over, and the checkout is still on disk with nobody's permission to
    /// remove it.
    Terminal {
        why: String,
        /// What ended it: the window, or the attempt bound on a box whose clock
        /// could not be trusted to reach the window.
        after: Decided,
        close: CloseState,
    },
}

/// Which bound decided a refusal, in the words a journal line needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decided {
    /// It stood for the whole window.
    ByTheWindow { standing_secs: i64 },
    /// It was taken this many times, which no clock correction can undo.
    ByTheAttempts { attempts: i64 },
}

/// One attempt at releasing a finished run, and the decision about the refusal
/// if there is one.
///
/// [`force_terminal`] answers `Err` for a refusal and says nothing about
/// whether trying again could ever help. Every caller there was retried on the
/// next sweep, so a refusal whose inputs never change was taken every twenty
/// seconds for as long as the box lived, and the run's leases — which are
/// returned by the close loop at the END of a release that got through — never
/// came back (ISS-1188). This is where that ends: a refusal is given a window,
/// and one still standing at the end of it is decided.
///
/// The decision is NOT that the checkout was released. Nothing stamps
/// `worktree_gone_at`, because the checkout really is still there, and a ledger
/// that said otherwise would be lying about the one thing this verb exists to
/// keep honest.
///
/// `now_secs` is the caller's clock, which on a box is the wall clock and can
/// move either way. What that does to the window is `note_release_refusal`'s
/// own documentation; the short of it is that the window always ends, and a
/// correction can only make it end sooner.
pub async fn release(
    ledger: &mut Ledger,
    run_id: &str,
    what: Forcing<'_>,
    ports: Ports<'_>,
    now_secs: i64,
) -> Result<Release> {
    match force_terminal(ledger, run_id, what, ports).await {
        Ok(forced) => {
            ledger.clear_release_refusal(run_id)?;
            Ok(Release::Done(Box::new(forced)))
        }
        Err(e) => {
            let why = e.to_string();
            let refusal = ledger.note_release_refusal(run_id, &why, now_secs)?;
            let standing_secs = now_secs - refusal.since;
            let after = if standing_secs >= RELEASE_GRACE_SECS {
                Decided::ByTheWindow { standing_secs }
            } else if refusal.attempts >= RELEASE_ATTEMPT_BOUND {
                Decided::ByTheAttempts {
                    attempts: refusal.attempts,
                }
            } else {
                return Ok(Release::Refusing {
                    why,
                    first: refusal.opened_the_streak,
                    standing_secs,
                });
            };
            // The leases first and the decision second: a run ended over a
            // refusal whose leases were never asked for is the defect wearing
            // a terminal state.
            let close = close_loop::close(ledger, run_id, ports.sessions, ports.leases).await?;
            ledger.conclude_release_refusal(run_id, now_secs, what.by, &why)?;
            Ok(Release::Terminal { why, after, close })
        }
    }
}

/// What is being forced, and by whom.
#[derive(Clone, Copy)]
pub struct Forcing<'a> {
    pub this_boot: &'a str,
    pub repo_root: &'a Path,
    pub base_branch: Option<&'a str>,
    pub by: &'a str,
    pub reason: &'a str,
}

/// The outside world this verb reaches through.
#[derive(Clone, Copy)]
pub struct Ports<'a> {
    pub procs: &'a dyn ProcessGroup,
    pub sessions: &'a dyn SessionReader,
    pub leases: &'a dyn LeaseKeeper,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const SOURCE: &str = include_str!("terminate.rs");

    struct Sessions;
    #[async_trait::async_trait]
    impl SessionReader for Sessions {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(true)
        }
    }

    struct Leases(Mutex<HashSet<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, _project_id: Option<&str>, issue_key: &str) -> Result<()> {
            self.0.lock().unwrap().insert(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, _project_id: Option<&str>, issue_key: &str) -> Result<bool> {
            Ok(self.0.lock().unwrap().contains(issue_key))
        }
    }

    struct Procs(Mutex<Vec<u32>>);
    #[async_trait::async_trait]
    impl ProcessGroup for Procs {
        async fn kill(&self, pid: u32) -> Reaped {
            self.0.lock().unwrap().push(pid);
            Reaped::Killed
        }
    }

    async fn git(dir: &Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .output()
            .await
            .unwrap();
    }

    /// A repo with a remote and one agent worktree on `ISS-964`, dirty.
    async fn repo(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "forge-terminate-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]).await;
        git(&root, &["config", "user.email", "t@t"]).await;
        git(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(&root, &["add", "."]).await;
        git(&root, &["commit", "-m", "base"]).await;

        let remote = root.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]).await;
        git(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        git(&root, &["push", "-u", "origin", "main"]).await;

        let wt = root.join(".worktrees/ISS-964");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(
            &root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", "ISS-964"],
        )
        .await;
        std::fs::write(wt.join("work.txt"), "the diff a park left").unwrap();
        (root, wt)
    }

    /// Make the fixture's bare remote reject every push, as a protected branch would.
    async fn refuse_pushes(root: &Path) {
        let hooks = root.with_extension("remote.git").join("hooks");
        std::fs::create_dir_all(&hooks).expect("hooks dir");
        let hook = hooks.join("pre-receive");
        std::fs::write(&hook, "#!/bin/sh\necho 'refused by policy' >&2\nexit 1\n").expect("hook");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755))
                .expect("hook mode");
        }
    }

    /// The run every fixture here releases, seeded into whichever ledger the
    /// test opened — in memory for most, on disk for the one about restarts.
    fn seed_run(led: &mut Ledger, wt: &Path, boot: &str) {
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: wt.to_path_buf(),
            boot_id: boot.into(),
            issue_keys: vec!["ISS-964".into()],
        })
        .unwrap();
        led.attach_session("run-1", "sess-1").unwrap();
        led.attach_pid("run-1", 4242).unwrap();
        led.begin_question("q-1", "run-1", 1, "q-1").unwrap();
        led.declare_parked_human("run-1", Some("resume-1"), None)
            .unwrap();
    }

    fn ledger_for(wt: &Path, incarnation: Incarnation, boot: &str) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: wt.to_path_buf(),
            boot_id: boot.into(),
            issue_keys: vec!["ISS-964".into()],
        })
        .unwrap();
        led.attach_session("run-1", "sess-1").unwrap();
        led.attach_pid("run-1", 4242).unwrap();
        if incarnation == Incarnation::Exited {
            led.begin_question("q-1", "run-1", 1, "q-1").unwrap();
            led.declare_parked_human("run-1", Some("resume-1"), None)
                .unwrap();
        }
        led
    }

    fn ports<'a>(p: &'a Procs, s: &'a Sessions, l: &'a Leases) -> Ports<'a> {
        Ports {
            procs: p,
            sessions: s,
            leases: l,
        }
    }

    fn forcing<'a>(root: &'a Path, boot: &'a str) -> Forcing<'a> {
        Forcing {
            this_boot: boot,
            repo_root: root,
            base_branch: Some("main"),
            by: "operator",
            reason: "the park was abandoned by hand",
        }
    }

    #[test]
    fn the_verb_follows_from_the_state_and_never_from_the_caller() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/wt"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        let live = led.run("run-1").unwrap().unwrap();
        assert_eq!(verb_for(&live, "boot-a").unwrap(), Verb::Kill);

        led.begin_question("q", "run-1", 1, "q").unwrap();
        led.declare_parked_human("run-1", None, None).unwrap();
        let parked = led.run("run-1").unwrap().unwrap();
        assert_eq!(verb_for(&parked, "boot-a").unwrap(), Verb::Abandon);
        // A park outlives the boot it was made in, and it is still Abandon.
        assert_eq!(verb_for(&parked, "boot-b").unwrap(), Verb::Abandon);
    }

    #[test]
    fn a_live_run_from_another_boot_admits_neither_verb() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: PathBuf::from("/tmp/wt"),
            boot_id: "boot-before-the-reboot".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        let err = verb_for(&run, "boot-now")
            .expect_err("unknown liveness must be refused, never reclaimed")
            .to_string();
        assert!(err.contains("unknown"), "{err}");
        assert!(err.contains("boot-before-the-reboot"), "{err}");
    }

    #[tokio::test]
    async fn abandon_preserves_the_diff_then_releases_the_worktree() {
        let (root, wt) = repo("abandon").await;
        git(&wt, &["add", "work.txt"]).await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert_eq!(out.verb, Verb::Abandon);
        assert!(p.0.lock().unwrap().is_empty(), "{:?}", p.0.lock().unwrap());
        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);

        // The diff is on the branch, which outlives the checkout.
        let log = tokio::process::Command::new("git")
            .args([
                "log",
                "--oneline",
                "refs/remotes/origin/ISS-964",
                "--",
                "work.txt",
            ])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the diff must be committed on the branch BEFORE the worktree goes"
        );

        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.ended_by.as_deref(), Some("operator"));
        assert_eq!(
            run.ended_reason.as_deref(),
            Some("the park was abandoned by hand")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn an_untracked_file_is_work_and_is_preserved_before_the_checkout_goes() {
        let (root, wt) = repo("untracked").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a tree holding an untracked file must reach terminal, not refuse");

        assert!(
            committed(out.salvage.expect("salvage ran").outcome),
            "salvage must have RUN and committed — a release that reached the clean branch never looked at the file"
        );
        assert!(
            !wt.exists(),
            "the worktree must still be released once it is safe"
        );
        let log = tokio::process::Command::new("git")
            .args([
                "log",
                "--oneline",
                "refs/remotes/origin/ISS-964",
                "--",
                "work.txt",
            ])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the untracked file must be committed and published BEFORE the checkout goes — git cannot see a file it has never been told about, and the checkout was its only copy"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_detached_checkout_whose_commits_a_ref_holds_is_released_by_sha() {
        let (root, wt) = repo("nobranch").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;
        // The remote loses the ref; this box keeps `refs/remotes/origin/ISS-964`, so every local
        // reader still calls this tree clean and published.
        git(
            &root.with_extension("remote.git"),
            &["update-ref", "-d", "refs/heads/ISS-964"],
        )
        .await;
        // `symbolic-ref` is what `branch_of` asks, and a detached HEAD is what it cannot answer.
        git(&wt, &["checkout", "--detach", "-q"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect(
            "a checkout this box cannot name a branch for is one it can still ask about by sha, \
             and a run it cannot answer for holds its leases for as long as the box lives",
        );

        assert_eq!(
            out.commits,
            Some(Commits::AlreadyNamed),
            "`ISS-964` still names the commit, whatever HEAD is pointing at"
        );
        assert!(!wt.exists(), "the checkout must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "the lease is the point: an issue held by a run nobody can release is admissible to \
             no other run on this box"
        );
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A fixture whose release is refused on EVERY attempt, whatever changes
    /// around it: a dirty checkout, and a repo root that is no repository, so
    /// the preserve step can neither find nor commit the tree holding the diff.
    /// It is the shape the window exists for — a refusal no retry gets past.
    async fn a_release_that_will_never_succeed(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
        let (root, wt) = repo(tag).await;
        git(&wt, &["add", "work.txt"]).await;
        let not_a_repo = root.with_extension("not-a-repo");
        std::fs::create_dir_all(&not_a_repo).unwrap();
        (root, wt, not_a_repo)
    }

    const T0: i64 = 1_790_000_000;

    #[tokio::test]
    async fn a_refusal_younger_than_the_window_is_tried_again_and_said_once() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("young").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let first = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0,
        )
        .await
        .unwrap();
        assert!(
            matches!(first, Release::Refusing { first: true, .. }),
            "the attempt that opens a streak is the one worth a line in the journal: {first:?}"
        );

        let again = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 + 1,
        )
        .await
        .unwrap();
        assert!(
            matches!(again, Release::Refusing { first: false, .. }),
            "and every sweep after it is the same refusal, not a new one: {again:?}"
        );

        let last_inside = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 + RELEASE_GRACE_SECS - 1,
        )
        .await
        .unwrap();
        assert!(
            matches!(last_inside, Release::Refusing { .. }),
            "one second inside the window is still inside it: {last_inside:?}"
        );
        assert!(wt.exists(), "and nothing has been touched");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_refusal_that_reaches_the_window_is_decided_and_the_leases_come_back() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("decided").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0,
        )
        .await
        .unwrap();
        let decided = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 + RELEASE_GRACE_SECS,
        )
        .await
        .unwrap();

        let Release::Terminal { why, after, close } = decided else {
            panic!("the boundary itself is terminal, or the window never ends: {decided:?}");
        };
        assert_eq!(
            after,
            Decided::ByTheWindow {
                standing_secs: RELEASE_GRACE_SECS
            },
            "a box whose clock is fine is decided by the window, not by the count behind it"
        );
        assert!(
            why.contains("not preserved"),
            "the decision carries the question the box could not answer, not a code: {why}"
        );
        assert_eq!(
            (close.leases_returned, close.leases_total),
            (1, 1),
            "the lease is the whole point: an issue a run nobody can release still holds is \
             admissible to no other run on this box"
        );
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "and it was actually asked for, not just marked"
        );

        let run = led.run("run-1").unwrap().unwrap();
        assert!(run.ended_by.is_some(), "the run is over");
        assert_eq!(
            run.release_refusal
                .as_deref()
                .map(|w| w.contains("not preserved")),
            Some(true),
            "and the row says what it was over"
        );
        assert!(run.release_terminal_at.is_some());
        assert!(
            wt.exists(),
            "the checkout is still there — the decision was that the release cannot be made, \
             never that it was"
        );
        assert!(
            run.worktree_gone_at.is_none(),
            "and the ledger must not say the checkout is gone while it is standing right there"
        );
        assert!(
            led.held_worktrees()
                .unwrap()
                .iter()
                .any(|(path, _)| path == &wt),
            "a checkout the release refused to remove is not the reaper's to remove either"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_clock_that_moves_backwards_cannot_push_the_window_away_for_ever() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("rollback").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0,
        )
        .await
        .unwrap();

        // ntp corrects a box that booted on a bad clock. A stamp kept in the
        // future would move the end of the window further off every sweep
        // until the clock caught up, which is this issue's defect again.
        let after_the_correction = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 - 3600,
        )
        .await
        .unwrap();
        assert!(
            matches!(after_the_correction, Release::Refusing { .. }),
            "a correction is not a reason to decide early either: {after_the_correction:?}"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().release_refused_at,
            Some(T0 - 3600),
            "the stamp is pulled back to the clock now reading it"
        );

        let decided = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 - 3600 + RELEASE_GRACE_SECS,
        )
        .await
        .unwrap();
        assert!(
            matches!(decided, Release::Terminal { .. }),
            "and the window ends one grace after the correction, not one hour and one grace \
             after it: {decided:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_clock_corrected_backwards_over_and_over_is_decided_by_the_count_instead() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("neverarrives").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        // A box that corrects itself backwards before every window can end —
        // a bad RTC, a hypervisor resuming a snapshot. The window never
        // arrives, however honestly it is computed.
        let mut last = None;
        for attempt in 0..RELEASE_ATTEMPT_BOUND {
            last = Some(
                release(
                    &mut led,
                    "run-1",
                    forcing(&not_a_repo, "boot-a"),
                    ports(&p, &s, &l),
                    T0 - attempt * RELEASE_GRACE_SECS,
                )
                .await
                .unwrap(),
            );
        }

        let last = last.expect("the loop ran");
        let Release::Terminal { after, close, .. } = last else {
            panic!("a bound no clock can move is the only thing that ends this: {last:?}");
        };
        assert_eq!(
            after,
            Decided::ByTheAttempts {
                attempts: RELEASE_ATTEMPT_BOUND
            }
        );
        assert_eq!((close.leases_returned, close.leases_total), (1, 1));
        assert!(wt.exists(), "and the checkout is still not touched");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_run_given_up_on_is_marked_and_ended_in_one_write() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("atomic").await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0,
        )
        .await
        .unwrap();
        release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 + RELEASE_GRACE_SECS,
        )
        .await
        .unwrap();

        let run = led.run("run-1").unwrap().unwrap();
        assert!(
            run.release_terminal_at.is_some() && run.ended_by.is_some(),
            "a box that stopped between the two would come back holding a run no sweep picks up \
             — the stamp takes it off the release path — and that no sweep finishes either, \
             because it is not ended: the wedge again, wearing the mark meant to end one"
        );
        assert!(
            SOURCE
                .split("pub async fn release(")
                .nth(1)
                .expect("release must be findable")
                .split("pub struct Forcing")
                .next()
                .expect("the body")
                .contains("conclude_release_refusal"),
            "the two halves are one decision and go through the one verb that writes them \
             together, never two calls a crash can land between"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_refusal_keeps_its_age_across_the_restart_of_the_daemon_holding_it() {
        let (root, wt, not_a_repo) = a_release_that_will_never_succeed("restart").await;
        let ledger_path = root.join("ledger.sqlite");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        {
            let mut led = Ledger::open(&ledger_path).unwrap();
            seed_run(&mut led, &wt, "boot-a");
            let first = release(
                &mut led,
                "run-1",
                forcing(&not_a_repo, "boot-a"),
                ports(&p, &s, &l),
                T0,
            )
            .await
            .unwrap();
            assert!(matches!(first, Release::Refusing { .. }), "{first:?}");
        }

        // The daemon restarts. A window counted in this process would start again
        // here, and the run would be retried for ever across a box that restarts.
        let mut led = Ledger::open(&ledger_path).unwrap();
        let decided = release(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
            T0 + RELEASE_GRACE_SECS,
        )
        .await
        .unwrap();
        assert!(
            matches!(decided, Release::Terminal { .. }),
            "the refusal is as old as the ledger says it is, not as old as this process: {decided:?}"
        );
        drop(led);
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_release_that_gets_through_forgets_the_refusal_it_got_past() {
        let (root, wt) = repo("forgets").await;
        git(&wt, &["add", "-A"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );
        led.note_release_refusal("run-1", "an older sweep could not reach git", T0)
            .unwrap();

        let out = release(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
            T0 + 1,
        )
        .await
        .unwrap();

        assert!(matches!(out, Release::Done(_)), "{out:?}");
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            (run.release_refused_at, run.release_refusal),
            (None, None),
            "the stamp is the age of ONE streak — carrying a cleared refusal forward would \
             decide the next one before it had a window at all"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_release_is_written_before_the_run_is_ended() {
        let body = SOURCE
            .split("pub async fn force_terminal(")
            .nth(1)
            .expect("force_terminal must be findable");
        let salvage = body.find("salvage_wip").expect("the preserve step");
        let release = body.find("worktree::remove").expect("the release");
        let ended = body.find("end_run").expect("the terminal write");
        assert!(
            salvage < release,
            "the diff is preserved BEFORE the worktree is released (criterion 33)"
        );
        assert!(
            release < ended,
            "`end_run` un-holds the tree for the reaper, so it must come last"
        );
    }

    #[tokio::test]
    async fn a_diff_that_could_not_be_preserved_refuses_the_whole_verb() {
        let (root, wt) = repo("refuse").await;
        git(&wt, &["add", "work.txt"]).await;
        // The repo root salvage is given is not a git checkout, so
        // `git worktree list` there fails and salvage answers `failed`: it
        // cannot find, let alone commit, the tree holding the diff.
        let not_a_repo = root.with_extension("not-a-repo");
        std::fs::create_dir_all(&not_a_repo).unwrap();

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let err = force_terminal(
            &mut led,
            "run-1",
            forcing(&not_a_repo, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect_err("a diff that could not be preserved must refuse the verb")
        .to_string();

        assert!(err.contains("not preserved"), "{err}");
        assert!(wt.exists(), "a refused abandon must not touch the worktree");
        assert!(
            led.run("run-1").unwrap().unwrap().ended_by.is_none(),
            "and must leave the run non-terminal so the tree stays held"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_clean_park_is_released_even_with_a_strangers_dirty_tree_on_the_box() {
        let (root, wt) = repo("clean").await;
        git(&wt, &["add", "-A"]).await;
        git(&wt, &["commit", "-qm", "the agent committed its own work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;

        let decoy = root.join(".worktrees/ISS-999");
        git(
            &root,
            &["worktree", "add", &decoy.to_string_lossy(), "-b", "ISS-999"],
        )
        .await;
        std::fs::write(decoy.join("stranger.txt"), "not this run's work").unwrap();

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert!(
            out.salvage.is_none(),
            "nothing to preserve: {:?}",
            out.salvage
        );
        assert!(!wt.exists(), "a clean park's tree is still released");
        assert!(decoy.exists(), "and a stranger's tree is left alone");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn kill_signals_the_process_group_before_anything_is_released() {
        let (root, wt) = repo("kill").await;
        let mut led = ledger_for(&wt, Incarnation::Live, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert_eq!(out.verb, Verb::Kill);
        assert_eq!(*p.0.lock().unwrap(), vec![4242]);
        assert!(!wt.exists());
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_run_whose_tree_is_already_gone_still_reaches_terminal() {
        let gone = std::env::temp_dir().join("forge-terminate-absent-by-construction");
        let _ = std::fs::remove_dir_all(&gone);
        let mut led = ledger_for(&gone, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(Path::new("/nonexistent-repo"), "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert!(out.salvage.is_none(), "{:?}", out.salvage);
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
    }

    #[test]
    fn the_verb_stamps_no_mark_of_its_own() {
        let body = SOURCE
            .split("pub async fn force_terminal(")
            .nth(1)
            .expect("force_terminal must be findable");
        for mark in [
            "mark_session_terminal_observed",
            "mark_worktree_gone_observed",
            "mark_lease_returned_observed",
        ] {
            assert!(
                !body.contains(mark),
                "{mark} is close_loop's to set by reading the world back"
            );
        }
    }
    #[tokio::test]
    async fn a_checkout_whose_directory_is_not_named_after_its_branch_is_still_released() {
        let (root, _other) = repo("renamed").await;
        let wt = root.join(".worktrees/short");
        git(
            &root,
            &[
                "worktree",
                "add",
                &wt.to_string_lossy(),
                "-b",
                "a-much-longer-branch-name",
            ],
        )
        .await;
        git(
            &wt,
            &["push", "-q", "-u", "origin", "a-much-longer-branch-name"],
        )
        .await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a clean checkout must be released whatever its directory is called");

        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }
    /// A stale remote-tracking ref is still not publication — `publication_of`
    /// owns that and its own test holds it. What moved is that publication is
    /// no longer what the release turns on.
    #[tokio::test]
    async fn a_ref_only_this_box_remembers_is_still_a_ref_this_repository_keeps() {
        let (root, wt) = repo("stale").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-964"]).await;
        // The remote loses the ref and will not take it back; this box still has
        // `refs/remotes/origin/ISS-964` and an upstream that looks satisfied.
        git(
            &root.with_extension("remote.git"),
            &["update-ref", "-d", "refs/heads/ISS-964"],
        )
        .await;
        refuse_pushes(&root).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("the work is on `ISS-964` in this repository, which the release does not remove");

        assert_eq!(out.commits, Some(Commits::AlreadyNamed));
        assert!(!wt.exists(), "the checkout is released");
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "and the lease is back"
        );
        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "ISS-964", "--", "work.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the work must still be in the repository once the checkout is gone — that, and not \
             the remote's answer, is what made the release safe"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_push_the_remote_refuses_no_longer_holds_the_run_for_ever() {
        let (root, wt) = repo("refused").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work the remote will not take"]).await;
        refuse_pushes(&root).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a remote that will not take the work is not a reason to keep the run for ever");

        assert_eq!(out.commits, Some(Commits::AlreadyNamed));
        assert!(!wt.exists());
        assert!(l.0.lock().unwrap().contains("ISS-964"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_remote_this_box_cannot_reach_does_not_decide_the_release() {
        let (root, wt) = repo("unreachable").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;
        git(
            &wt,
            &["remote", "set-url", "origin", "/nonexistent/remote.git"],
        )
        .await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a remote this box cannot reach is not a question the release has to answer");

        assert_eq!(out.commits, Some(Commits::AlreadyNamed));
        assert!(!wt.exists(), "the checkout is released");
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "and the lease is back"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A repository with NO remote configured — the shape every MCP-only
    /// storefront project on the fleet has, and one no push can ever satisfy.
    async fn local_only_repo(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "forge-terminate-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]).await;
        git(&root, &["config", "user.email", "t@t"]).await;
        git(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(&root, &["add", "."]).await;
        git(&root, &["commit", "-m", "base"]).await;
        let wt = root.join(".worktrees/ISS-964");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(
            &root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", "ISS-964"],
        )
        .await;
        (root, wt)
    }

    #[tokio::test]
    async fn a_repository_with_no_remote_is_released_rather_than_retried_for_ever() {
        let (root, wt) = local_only_repo("noremote").await;
        std::fs::write(wt.join("work.txt"), "the only copy is this box").unwrap();
        git(&wt, &["add", "-A"]).await;
        git(&wt, &["commit", "-qm", "work"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect(
            "there is no remote to push to and none to check against, so a release that waits \
             for one waits for ever",
        );

        assert_eq!(out.commits, Some(Commits::AlreadyNamed));
        assert!(!wt.exists(), "the checkout is released");
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "and the lease is back"
        );
        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "ISS-964", "--", "work.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the branch lives in the main repository, not in the worktree — removing the \
             checkout never was what would lose it"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_commit_on_no_ref_at_all_is_named_before_the_checkout_goes() {
        let (root, wt) = local_only_repo("loose").await;
        git(&wt, &["checkout", "--detach", "-q"]).await;
        std::fs::write(wt.join("work.txt"), "on no branch at all").unwrap();
        git(&wt, &["add", "-A"]).await;
        git(&wt, &["commit", "-qm", "loose"]).await;
        let head = {
            let out = tokio::process::Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&wt)
                .output()
                .await
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("commits nothing names are given a name, not held against the release");

        assert_eq!(
            out.commits,
            Some(Commits::NamedBy("refs/forge/kept/run-1".into())),
            "the release must say where it put them, or the report is no use to anyone"
        );
        assert!(!wt.exists(), "the checkout is released");
        assert!(l.0.lock().unwrap().contains("ISS-964"));
        let kept = tokio::process::Command::new("git")
            .args(["rev-parse", "refs/forge/kept/run-1"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&kept.stdout).trim(),
            head,
            "and the ref must still name the commit once the checkout is gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The fixture's repo root and its bare remote, both removed when this
    /// goes out of scope — including on the unwind a failing assertion causes.
    struct Fixture(PathBuf);

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
            let _ = std::fs::remove_dir_all(self.0.with_extension("remote.git"));
        }
    }

    /// Everything about a checkout that releasing a run must not disturb.
    #[derive(Debug, PartialEq, Eq)]
    struct Snapshot {
        tracked: String,
        staged: String,
        untracked: String,
        branch: String,
        tip: String,
    }

    async fn snapshot(wt: &Path) -> Snapshot {
        async fn ask(wt: &Path, args: &[&str]) -> String {
            let out = tokio::process::Command::new("git")
                .args(args)
                .current_dir(wt)
                .stdin(std::process::Stdio::null())
                .output()
                .await
                .unwrap();
            String::from_utf8_lossy(&out.stdout).to_string()
        }
        Snapshot {
            tracked: std::fs::read_to_string(wt.join("f.txt")).unwrap_or_default(),
            staged: ask(wt, &["diff", "--cached", "--name-status"]).await,
            untracked: ask(wt, &["ls-files", "--others", "--exclude-standard"]).await,
            branch: ask(wt, &["rev-parse", "--abbrev-ref", "HEAD"]).await,
            tip: ask(wt, &["rev-parse", "HEAD"]).await,
        }
    }

    /// A run declared against the repo root itself, which is what the box on
    /// sid-xeon-1 had in its ledger: `work=done`, `incarnation=exited`, and a
    /// `worktree_path` naming the main checkout rather than a per-run tree.
    ///
    /// `repo` leaves an agent worktree under the root, and the root is not
    /// ignoring `.worktrees/`, so this shape reaches the release by the
    /// PRESERVE branch: the root reads as holding work, and the salvage guard
    /// is what refuses it.
    async fn main_tree_run(tag: &str) -> (Fixture, PathBuf, Ledger) {
        let (root, _wt) = repo(tag).await;
        let led = ledger_for(&root, Incarnation::Exited, "boot-a");
        (Fixture(root.clone()), root, led)
    }

    /// The incident's own shape: a main checkout with nothing uncommitted and
    /// no agent worktree under it, so the release reads it as clean and walks
    /// straight into `git worktree remove` — the call git refuses by design.
    async fn clean_main_tree_run(tag: &str) -> (Fixture, PathBuf, Ledger) {
        let root = std::env::temp_dir().join(format!(
            "forge-terminate-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]).await;
        git(&root, &["config", "user.email", "t@t"]).await;
        git(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(&root, &["add", "."]).await;
        git(&root, &["commit", "-m", "base"]).await;

        let remote = root.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]).await;
        git(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        git(&root, &["push", "-u", "origin", "main"]).await;

        let led = ledger_for(&root, Incarnation::Exited, "boot-a");
        (Fixture(root.clone()), root, led)
    }

    #[tokio::test]
    async fn a_clean_main_working_tree_is_never_handed_to_git_worktree_remove() {
        let (_fx, root, mut led) = clean_main_tree_run("cleanmain").await;
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect(
            "this is the shape sid-xeon-1 wedged on: a clean main checkout reads as having \
             nothing to preserve, so the release used to walk into `git worktree remove`, \
             which answers `fatal: ... is a main working tree` on every sweep forever",
        );

        assert_eq!(out.worktree, WorktreeOutcome::MainWorkingTreeKept);
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "the lease the loop was holding must come back"
        );
        assert!(root.join("f.txt").is_file(), "the checkout survives");
    }

    #[tokio::test]
    async fn a_run_declared_against_the_main_working_tree_is_released_and_the_checkout_stays() {
        let (_fx, root, mut led) = main_tree_run("maintree").await;
        let before = snapshot(&root).await;
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect(
            "a run whose worktree path is the main working tree must reach terminal: \
             `git worktree remove` refuses that path by design, so a release that learns \
             it from the failure retries it every sweep forever",
        );

        assert!(
            out.close.is_closed(),
            "the run must close on the FIRST pass, not stay partially closed: {:?}",
            out.close
        );
        assert_eq!(
            out.worktree,
            WorktreeOutcome::MainWorkingTreeKept,
            "the release must say the checkout was kept, not that it was removed"
        );
        assert!(out.salvage.is_none(), "{:?}", out.salvage);
        assert!(
            l.0.lock().unwrap().contains("ISS-964"),
            "the lease must come back — it was held only because the removal failed"
        );
        assert!(root.is_dir(), "the main checkout must survive the release");
        assert_eq!(
            snapshot(&root).await,
            before,
            "the release must leave the main checkout exactly as it found it"
        );
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());
    }

    #[tokio::test]
    async fn the_released_main_working_tree_run_is_gone_from_the_sweep_that_kept_retrying_it() {
        let (_fx, root, mut led) = main_tree_run("sweep").await;
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );
        assert!(
            led.unclosed_runs()
                .unwrap()
                .iter()
                .any(|r| r.run_id == "run-1"),
            "before the release the sweep is right to pick it up"
        );

        force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .unwrap();

        assert!(
            !led.unclosed_runs()
                .unwrap()
                .iter()
                .any(|r| r.run_id == "run-1"),
            "the next sweep must not select it again — the loop has to END, not get quieter"
        );
    }

    #[tokio::test]
    async fn the_operators_uncommitted_work_in_the_main_checkout_is_not_committed_by_the_release() {
        let (_fx, root, mut led) = main_tree_run("dirtymain").await;
        // The shared checkout as a person leaves it: a modified tracked file, a
        // staged one, and a file git has never been told about.
        std::fs::write(root.join("f.txt"), "the operator was editing this").unwrap();
        std::fs::write(root.join("staged.txt"), "staged by hand").unwrap();
        git(&root, &["add", "staged.txt"]).await;
        std::fs::write(root.join("scratch.txt"), "untracked notes").unwrap();
        let before = snapshot(&root).await;
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a dirty main checkout must not hold the release open either");

        assert!(out.close.is_closed(), "{:?}", out.close);
        assert_eq!(
            snapshot(&root).await,
            before,
            "a person's work-in-progress in the shared checkout is not this run's to commit — \
             `salvage::pick_target` excludes the repo root, so nothing here could be preserved \
             anyway, and the daemon must leave every byte of it alone"
        );
    }

    #[tokio::test]
    async fn a_worktree_nested_under_claude_worktrees_is_released_like_any_other() {
        let (root, _other) = repo("nested").await;
        let _fx = Fixture(root.clone());
        let wt = root.join(".claude/worktrees/ISS-970");
        std::fs::create_dir_all(wt.parent().unwrap()).unwrap();
        git(
            &root,
            &["worktree", "add", &wt.to_string_lossy(), "-b", "ISS-970"],
        )
        .await;
        git(&wt, &["push", "-q", "-u", "origin", "ISS-970"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("where a worktree sits decides nothing — git is asked what it IS");

        assert_eq!(
            out.worktree,
            WorktreeOutcome::Released,
            "a linked worktree inside the repo is still a linked worktree"
        );
        assert!(!wt.exists(), "and it is still removed");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(root.is_dir(), "the repository it lives in survives it");
    }

    #[tokio::test]
    async fn a_linked_worktree_still_standing_is_not_declared_released() {
        let (root, wt) = repo("stillthere").await;
        let _fx = Fixture(root.clone());
        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (_p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let state = close_loop::close(&mut led, "run-1", &s, &l).await.unwrap();

        assert!(
            !state.worktree_gone,
            "a checkout that is still on the disk has not been given back, \
             and only a main working tree is released without being removed"
        );
    }

    #[test]
    fn a_path_git_could_not_identify_is_refused_rather_than_released() {
        let p = Path::new("/some/checkout");
        let err = holds_no_checkout(WorktreeKind::Unknown, Verb::Abandon, "run-1", p)
            .expect_err(
                "an unidentifiable path must not fall through to the release: publishing and \
                 removing a path this box could not name is exactly the silent substitution \
                 the refusal exists to prevent",
            )
            .to_string();
        assert!(err.contains("could not ask git"), "{err}");
        assert!(
            err.contains("/some/checkout"),
            "the refusal must name the path, or an operator cannot act on it: {err}"
        );
    }

    #[test]
    fn only_the_main_working_tree_is_a_checkout_the_run_never_held() {
        let p = Path::new("/some/checkout");
        assert!(
            holds_no_checkout(WorktreeKind::MainWorkingTree, Verb::Abandon, "run-1", p).unwrap(),
            "the repo's own checkout is not the run's to give back"
        );
        for kind in [WorktreeKind::Linked, WorktreeKind::NotAWorktree] {
            assert!(
                !holds_no_checkout(kind, Verb::Abandon, "run-1", p).unwrap(),
                "{kind:?} still takes the release path it always took"
            );
        }
    }

    #[test]
    fn what_the_path_is_is_asked_before_anything_is_removed() {
        let body = SOURCE
            .split("pub async fn force_terminal(")
            .nth(1)
            .expect("force_terminal must be findable");
        let asked = body.find("kind_at").expect("the question put to git");
        let salvage = body.find("salvage_wip").expect("the preserve step");
        let release = body.find("worktree::remove").expect("the release");
        assert!(
            asked < salvage && asked < release,
            "a main working tree must be recognised BEFORE the preserve step and before \
             `git worktree remove` — reading it out of the removal's failure is the defect"
        );
    }

    #[tokio::test]
    async fn a_clean_checkout_whose_commits_are_only_local_is_released_and_keeps_them() {
        let (root, wt) = repo("localonly").await;
        git(&wt, &["add", "work.txt"]).await;
        git(&wt, &["commit", "-qm", "work no remote has"]).await;

        let mut led = ledger_for(&wt, Incarnation::Exited, "boot-a");
        let (p, s, l) = (
            Procs(Mutex::new(Vec::new())),
            Sessions,
            Leases(Mutex::new(HashSet::new())),
        );

        let out = force_terminal(
            &mut led,
            "run-1",
            forcing(&root, "boot-a"),
            ports(&p, &s, &l),
        )
        .await
        .expect("a clean checkout must be released even when salvage had nothing to do");

        assert!(!wt.exists(), "the worktree must be released");
        assert!(out.close.is_closed(), "{:?}", out.close);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_some());

        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "ISS-964", "--", "work.txt"])
            .current_dir(&root)
            .output()
            .await
            .unwrap();
        assert!(
            !log.stdout.is_empty(),
            "the commit must survive on the branch after the checkout is gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
