//! Closing a run (ISS-933 step 4): three marks, none of them declared.
//!
//! A run is done when its session is terminal, its worktree is off the disk,
//! and every issue's lease is back. The measured failure is not that a master
//! forgets to do those things — it is that a master reports having done them.
//! One did, having finished one and a half of three.
//!
//! So no mark here is set by doing the work. Each is set by READING THE WORLD
//! BACK afterwards, by its own protocol, and the response to the write that
//! did the work is discarded in every case. That cuts both ways on purpose: a
//! dropped response over work that landed still ends with the mark set, and a
//! cheerful `200` over work that did not land does not.

use std::path::Path;

use crate::worktree::Residence;
use runner_core::ledger::{CheckoutReturn, Ledger};
use runner_platform::error::Result;
pub use runner_transport::run_sessions::Outcome;

/// Reads back the authoritative session row. Never the ack of a write.
#[async_trait::async_trait]
pub trait SessionReader: Send + Sync {
    async fn is_terminal(&self, agent_session_id: &str) -> Result<bool>;
}

#[async_trait::async_trait]
pub trait RunCloser: Send + Sync {
    async fn close(
        &self,
        agent_session_id: &str,
        outcome: Outcome,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> Result<()>;
}

/// Returns a lease, and separately reads back whether it is actually returned.
///
/// Both carry the project the run belongs to: a lease is keyed by project and
/// issue, and a box serving two projects holds two rows under one key, so a
/// call naming only the key is a question core cannot answer (ISS-1139).
#[async_trait::async_trait]
pub trait LeaseKeeper: Send + Sync {
    async fn release(&self, project_id: Option<&str>, issue_key: &str) -> Result<()>;
    async fn is_returned(&self, project_id: Option<&str>, issue_key: &str) -> Result<bool>;

    /// Whether the ISSUE that key names is over — `closed` or `dropped` — as
    /// opposed to whether its lease is back. The two are different questions
    /// and a run outlives its issue by exactly the gap between them (ISS-1245).
    ///
    /// `None` says *not known to be over*, which is the answer a keeper that
    /// cannot ask gives and the answer an older core's reply carries. It is a
    /// refusal to claim, not a softened `false`: every caller here keeps the
    /// run it would otherwise have closed, so the default below changes no
    /// behaviour and a keeper that never overrides it behaves as it does today.
    async fn issue_is_over(
        &self,
        _project_id: Option<&str>,
        _issue_key: &str,
    ) -> Result<Option<bool>> {
        Ok(None)
    }
}

/// What the ledger says, with no process inspected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseState {
    pub session_terminal: bool,
    /// The run no longer holds a checkout it owes back. Not the same claim as
    /// *a directory went*, which is `worktree_gone_at`'s and only overlaps
    /// with this one (ISS-1193).
    pub checkout_returned: bool,
    pub leases_returned: usize,
    pub leases_total: usize,
}

impl CloseState {
    /// Every mark set. Anything else is a run still owed work.
    pub fn is_closed(&self) -> bool {
        self.session_terminal && self.checkout_returned && self.leases_returned == self.leases_total
    }
}

pub fn state(ledger: &Ledger, run_id: &str) -> Result<CloseState> {
    let run = ledger.run(run_id)?;
    let issues = ledger.issues(run_id)?;
    Ok(CloseState {
        session_terminal: run
            .as_ref()
            .is_some_and(|r| r.session_terminal_at.is_some()),
        checkout_returned: run.as_ref().is_some_and(|r| r.released_as.is_some()),
        leases_returned: issues
            .iter()
            .filter(|m| m.lease_returned_at.is_some())
            .count(),
        leases_total: issues.len(),
    })
}

/// What the world says about the checkout this run was declared against, or
/// `None` where it still holds one and the mark is not owed yet.
///
/// An absent path used to answer this on its own, and it is not an answer.
/// `git worktree move` leaves a live, registered worktree behind a path that
/// no longer resolves, and a sweep reading that absence as removal recorded
/// three runs on sid-xeon-1 as having given back checkouts that were sitting
/// on disk holding a `wip(salvage)` commit (ISS-1193). So the filesystem
/// decides nothing here: git's registry is asked, through `residence_of`, and
/// every reading but its two conclusive ones leaves the run holding.
///
/// The main working tree is the other way to hold none, and it earns its own
/// value rather than the `gone` one: a run declared against a repository's own
/// checkout never took it from the pool and it has to outlive the run
/// (ISS-1183), so nothing about it went anywhere.
///
/// `repo` is the repository whose registry answers. Without one there is no
/// registry to ask and the run keeps holding — which is the conservative half
/// of this change and not a gap: the release path always has the repo root,
/// and a run whose project this box cannot resolve is one an operator is
/// already being warned about.
async fn checkout_returned(
    run_id: &str,
    repo: Option<&Path>,
    path: &Path,
) -> Option<CheckoutReturn> {
    let repo = repo?;
    match crate::worktree::residence_of(repo, path).await {
        Residence::Gone => Some(CheckoutReturn::Gone),
        Residence::MainWorkingTree => Some(CheckoutReturn::MainWorkingTreeKept),
        // Git answered for the checkout around this path, which says nothing
        // about this one: the path stands and nothing established that it is
        // back. Recording it as the repository's own tree is how sid-desk's
        // ISS-689 checkout was called "left standing" and then went (ISS-1250).
        Residence::Enclosed(top) => {
            tracing::warn!(
                "[close] run={run_id}: {} stands, but git, asked at the path, answers for the \
                 enclosing checkout {} — it is no checkout of its own, so the run keeps holding \
                 it until git registers it or it is gone",
                path.display(),
                top.display()
            );
            None
        }
        Residence::Linked
        | Residence::NotAWorktree
        | Residence::MovedTo(_)
        | Residence::RegisteredButMissing(_)
        | Residence::Ambiguous(_) => None,
        Residence::Unknown(why) => {
            tracing::warn!(
                "[close] run={run_id}: {}: git could not be asked whether this checkout is still registered ({why}) — the run keeps holding it",
                path.display()
            );
            None
        }
    }
}

/// Wall-clock seconds, for the one stamp this module writes.
///
/// The settle below is a record of when an observation was made, not a
/// deadline anything is measured against, so a clock that moves cannot hold it
/// off or bring it on the way `note_release_refusal`'s window can.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub async fn close(
    ledger: &mut Ledger,
    run_id: &str,
    repo: Option<&Path>,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
) -> Result<CloseState> {
    let Some(run) = ledger.run(run_id)? else {
        return state(ledger, run_id);
    };

    let session_terminal = match run.session_id.as_deref() {
        Some(id) => matches!(sessions.is_terminal(id).await, Ok(true)),
        None => true,
    };
    if run.session_terminal_at.is_none() && session_terminal {
        ledger.mark_session_terminal_observed(run_id)?;
    }

    let mut checkout_is_back = run.released_as.is_some();
    if !checkout_is_back {
        if let Some(how) = checkout_returned(run_id, repo, Path::new(&run.worktree_path)).await {
            ledger.mark_checkout_returned_observed(run_id, how)?;
            // The one writer of `worktree_gone_at`, so the one place a line
            // covers every checkout recorded gone — including the ones a
            // master or a person removed, which no removal line of this box's
            // could ever name (ISS-1250, judge finding 5).
            match how {
                CheckoutReturn::Gone => tracing::info!(
                    "[close] run={run_id}: {} is no longer a checkout git registers, so it is \
                     recorded as gone",
                    run.worktree_path.display()
                ),
                // What git answered and what the run is recorded as, and
                // nothing about the directory's future (ISS-1250, judge j3).
                CheckoutReturn::MainWorkingTreeKept => tracing::info!(
                    "[close] run={run_id}: git answers that {} is the repository's own working \
                     tree, so the run holds no checkout of the pool's and is recorded as having \
                     none to return",
                    run.worktree_path.display()
                ),
            }
            checkout_is_back = true;
        }
    }

    // A checkout that is back overtakes a refusal the release left standing:
    // the thing the refusal was about is gone, so the refusal will never be
    // taken again and will never reach its own decision. The condition is that
    // the checkout IS back, not that this call was the one that saw it — the
    // rows ISS-1242 names were all marked returned by an earlier sweep, so a
    // settle guarded by the observation would miss every one of them.
    if checkout_is_back
        && run.release_refused_at.is_some()
        && run.release_terminal_at.is_none()
        && ledger.settle_release_refusal(run_id, now_secs())?
    {
        tracing::info!(
            "[close] run={run_id}: its checkout is back, so the release refusal standing over \
                 it ({}) is settled rather than left open — it was never decided and will never \
                 be taken again",
            run.release_refusal.as_deref().unwrap_or("no text recorded")
        );
    }

    let project = run.project_id.clone();
    for m in ledger.issues(run_id)? {
        if m.lease_returned_at.is_some() {
            continue;
        }
        if !matches!(
            leases.is_returned(project.as_deref(), &m.issue_key).await,
            Ok(true)
        ) {
            // The mark answers to the read-back below and never to this
            // response, so the outcome decides nothing here. What it carries
            // does: a refusal names the way out — the project to send, the key
            // that reaches no lease — and a run whose release is refused says
            // so rather than passing in silence (ISS-1139).
            if let Err(e) = leases.release(project.as_deref(), &m.issue_key).await {
                tracing::warn!(
                    "[close] run={run_id} {}: lease release refused: {e}",
                    m.issue_key
                );
            }
        }
        if matches!(
            leases.is_returned(project.as_deref(), &m.issue_key).await,
            Ok(true)
        ) {
            ledger.mark_lease_returned_observed(run_id, &m.issue_key)?;
        }
    }

    state(ledger, run_id)
}
