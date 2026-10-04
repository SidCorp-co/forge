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

use crate::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::repo_cred::RepoCred;
use crate::salvage::{self, Outcome, Salvage};
use crate::worktree::Residence;
use runner_core::inflight::Reaped;
use runner_core::ledger::{Incarnation, Ledger, Run};
use runner_platform::error::{Error, Result};

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
        runner_core::inflight::kill_group(pid).await
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
    /// The run's own checkout was preserved and then removed.
    Released,
    /// The run named the repository's MAIN working tree, which it never held
    /// and which has to outlive it. Nothing was preserved and nothing removed.
    MainWorkingTreeKept,
    /// Git registered no checkout at the path and none that had ever been at
    /// it, so there was nothing to preserve and nothing to remove. This used
    /// to wear `Released`, which said the release had done something it had
    /// not (ISS-1193).
    NothingRegistered,
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
    cred: &RepoCred,
) -> Result<Commits> {
    if let Some(branch) = branch {
        if !matches!(
            salvage::publication_of(worktree, cred).await,
            salvage::Publication::Published
        ) {
            let pushed = salvage::publish(worktree, branch, cred).await;
            match (&pushed.refused, &pushed.publication) {
                (_, salvage::Publication::Published) => {}
                (Some(refused), publication) => tracing::info!(
                    "[terminate] run {run_id}: `{branch}` in {} did not reach a remote: {refused}; \
                     afterwards {publication} — the release goes on the refs this repository \
                     keeps instead",
                    worktree.display()
                ),
                // git took the push, so nothing here may say it did not land:
                // what is not known is what the reading after it found.
                (None, publication) => tracing::info!(
                    "[terminate] run {run_id}: git took the push of `{branch}` in {}, and \
                     afterwards {publication} — the release goes on the refs this repository \
                     keeps instead",
                    worktree.display()
                ),
            }
        }
    }
    match salvage::fate_of(worktree).await {
        salvage::Fate::Named => Ok(Commits::AlreadyNamed),
        salvage::Fate::NeedsARef { commits } => salvage::keep_at(worktree, run_id)
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
        salvage::Fate::Kept { why } => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: this box cannot tell whether the commits in {} \
             are named by any ref besides this checkout's own HEAD ({why}) — the checkout stays, \
             because not knowing is not the same as knowing it is safe",
            worktree.display()
        ))),
    }
}

/// Take the directory, having established at THIS moment that the commits do
/// not need it.
///
/// The predicate is read once more here, immediately before the removal, and
/// nothing but a fresh `Named` opens the door. A checkout it now calls kept is
/// refused by name: a keep decision and a removal for one path is the failure
/// itself, not a step on the way to one — this box printed both about the same
/// two directories inside one sweep (ISS-1250) — and the way a reader tells a
/// real change of state from a contradiction is that one of them says so.
///
/// `NeedsARef` is the reading `keep_before_release`'s answer cannot cover, and
/// refusing on a stale `AlreadyNamed` is how the whole guard would have let the
/// work go: the ref that named these commits a moment ago can be deleted or
/// rewritten before this line runs, and a removal taken on the older reading
/// leaves them reachable from the directory being deleted and from nothing else
/// (consult 653841 F1). So another ref is written, and the reading has to have
/// settled on `Named` before the directory may go. Writing one rather than
/// refusing is deliberate: the commits are what must survive, and a refusal
/// here holds every lease the run took for as long as the box lives (ISS-1188).
async fn take_the_directory(
    run_id: &str,
    verb: Verb,
    repo_root: &Path,
    worktree: &Path,
    commits: &Commits,
) -> Result<()> {
    let rewritten = match salvage::fate_of(worktree).await {
        salvage::Fate::Named => None,
        salvage::Fate::NeedsARef { commits } => Some((
            commits,
            salvage::keep_at(worktree, run_id).await.map_err(|why| {
                Error::Other(format!(
                    "refusing to {verb:?} run {run_id}: {commits} commit(s) in {} are named by \
                     this checkout and by nothing else at the moment its removal was reached, \
                     and they could not be given a ref of their own ({why}) — the checkout stays, \
                     because removing it is what would lose them",
                    worktree.display()
                ))
            })?,
        )),
        salvage::Fate::Kept { why } => {
            return Err(Error::Other(format!(
                "refusing to {verb:?} run {run_id}: this box keeps {} ({why}) and was about to \
                 remove it in the same breath — a keep and a removal for one path is the failure, \
                 not a step",
                worktree.display()
            )))
        }
    };
    if let Some((at_risk, name)) = &rewritten {
        if salvage::fate_of(worktree).await != salvage::Fate::Named {
            return Err(Error::Other(format!(
                "refusing to {verb:?} run {run_id}: {at_risk} commit(s) in {} were given {name}, \
                 and this repository still does not name them from a ref that outlives the \
                 directory — the checkout stays",
                worktree.display()
            )));
        }
    }
    let why = match (&rewritten, commits) {
        (Some((at_risk, name)), _) => format!(
            "run {run_id} is over and the ref its release wrote no longer named the work, so \
             {at_risk} commit(s) at its HEAD were given {name} before this"
        ),
        (None, Commits::AlreadyNamed) => match salvage::named_by(worktree).await {
            Some(name) => format!(
                "run {run_id} is over and every commit at its HEAD is already named by {name}, \
                 which this repository keeps"
            ),
            None => format!(
                "run {run_id} is over and every commit at its HEAD is already named by a ref this \
                 repository keeps, though git would not say which"
            ),
        },
        (None, Commits::NamedBy(name)) => format!(
            "run {run_id} is over and the commits at its HEAD were given {name} first, which \
             outlives the directory"
        ),
    };
    crate::worktree::remove_at(&repo_root.to_string_lossy(), worktree, &why).await
}

/// What this release may do about the path the run names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Held {
    /// A linked checkout this run took from the pool and owes back. Preserve
    /// it, then remove it.
    Ours,
    /// The repository's own MAIN working tree. The run never took it from the
    /// pool, so there is nothing to preserve and nothing to remove, and it has
    /// to outlive the run (ISS-1183).
    MainWorkingTree,
    /// Git registers no checkout at the path and none that was ever at it.
    /// There is nothing here to release.
    Nothing,
}

/// Read git's answer about the path, or refuse the verb by name.
///
/// Five of the nine readings refuse, and each refuses for the same reason in
/// a different shape: this box has not established that the checkout is gone,
/// and releasing on an unestablished fact is what writes a ledger row nobody
/// can trust. A refusal costs an operator one `forge-runner run release`; the
/// alternative cost three runs on sid-xeon-1 a record saying their work had
/// been given back while it sat on disk under a new path (ISS-1193).
///
/// None of them loops: a refusal is given a window and then decided (ISS-1188).
fn held_checkout(residence: &Residence, verb: Verb, run_id: &str, path: &Path) -> Result<Held> {
    match residence {
        Residence::MainWorkingTree => Ok(Held::MainWorkingTree),
        Residence::Linked | Residence::NotAWorktree => Ok(Held::Ours),
        Residence::Gone => Ok(Held::Nothing),
        // Everything past this point reads the checkout at its path — its
        // branch, its dirt, what a salvage would push — and every one of those
        // readings would be the enclosing checkout's (ISS-1250, judge j3).
        Residence::Enclosed(top) => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: {} stands, but it is no checkout of its own — \
             git, asked at the path, answers for the enclosing checkout {}, so anything read, \
             preserved or pushed from it would be that checkout's. Nothing was preserved, pushed \
             or removed; a directory reads this way partway through a removal, where a \
             checkout's `.git` file is missing, or where it was never a checkout",
            path.display(),
            top.display()
        ))),
        Residence::MovedTo(now_at) => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: git still registers this run's checkout, moved \
             to {} — the ledger names {}, which holds nothing. Nothing was preserved and \
             nothing removed; point the run at the new path or move the checkout back",
            now_at.display(),
            path.display()
        ))),
        Residence::RegisteredButMissing(registered) => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: git still registers this run's checkout at {}, \
             and that directory is not there — the ledger names {}. Nothing on this box removed \
             it, so what the checkout held cannot be examined; `git worktree prune` in the \
             repository is the operator's decision to make, not this release's",
            registered.display(),
            path.display()
        ))),
        Residence::Ambiguous(candidates) => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: {} holds nothing and git registers {} worktrees \
             that could be this run's ({}) — a basename is not an identity once two checkouts \
             share one, and releasing on the wrong one of them is what this refusal is for",
            path.display(),
            candidates.len(),
            candidates
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ))),
        Residence::Unknown(why) => Err(Error::Other(format!(
            "refusing to {verb:?} run {run_id}: this box could not ask git about {} ({why}) — \
             the checkout stays, because not knowing is not the same as knowing it is safe",
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

    // What is at the path is git's answer and never the filesystem's, asked
    // before anything here is touched. A run declared against the repository's
    // OWN checkout never took a worktree from the pool, so it has none to
    // preserve and none to give back (ISS-1183); a path that does not resolve
    // is a question about where the checkout went and not an answer that it is
    // gone (ISS-1193). Both used to be read off `exists()`, one of them
    // wrongly, and the wrong one skipped the salvage guard below on its way
    // past.
    let held = held_checkout(
        &crate::worktree::residence_of(what.repo_root, worktree).await,
        verb,
        run_id,
        worktree,
    )?;

    // One credential for this release, resolved from what this box provisioned
    // rather than from what a git child happens to read (ISS-1250). It is read
    // at the path, so only once git has answered that the path is a checkout
    // of its own: at an enclosed one it would be the enclosing checkout's
    // configuration (consult on 9ecec0c09 F1).
    let cred = RepoCred::of(worktree).await;

    // A checkout whose branch this box cannot name is a DETACHED one, not an
    // unreadable one, and it is no longer fatal here. The branch name is what
    // builds a push refspec and what `salvage_wip` picks a target by; the
    // question the release turns on is asked by sha and needs neither.
    let mut commits = None;
    let salvage = if held != Held::Ours {
        None
    } else if crate::worktree_reap::holds_work(worktree).await {
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
                    cred: &cred,
                })
                .await,
            ),
            None => None,
        };
        if !report.as_ref().is_some_and(|r| committed(r.outcome))
            && crate::worktree_reap::has_unsaved_changes(worktree).await
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
        let kept = keep_before_release(run_id, verb, worktree, branch.as_deref(), &cred).await?;
        take_the_directory(run_id, verb, what.repo_root, worktree, &kept).await?;
        commits = Some(kept);
        report
    } else {
        let branch = branch_of(worktree).await;
        let kept = keep_before_release(run_id, verb, worktree, branch.as_deref(), &cred).await?;
        take_the_directory(run_id, verb, what.repo_root, worktree, &kept).await?;
        commits = Some(kept);
        None
    };

    let close = close_loop::close(
        ledger,
        run_id,
        Some(what.repo_root),
        ports.sessions,
        ports.leases,
    )
    .await?;
    if close.is_closed() {
        ledger.end_run(run_id, what.by, what.reason)?;
    }
    Ok(Forced {
        verb,
        salvage,
        close,
        worktree: match held {
            Held::Ours => WorktreeOutcome::Released,
            Held::MainWorkingTree => WorktreeOutcome::MainWorkingTreeKept,
            Held::Nothing => WorktreeOutcome::NothingRegistered,
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
    Refusing { why: String, first: bool },
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
            ledger.forget_release_refusal(run_id)?;
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
                });
            };
            // The leases first and the decision second: a run ended over a
            // refusal whose leases were never asked for is the defect wearing
            // a terminal state.
            let close = close_loop::close(
                ledger,
                run_id,
                Some(what.repo_root),
                ports.sessions,
                ports.leases,
            )
            .await?;
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
