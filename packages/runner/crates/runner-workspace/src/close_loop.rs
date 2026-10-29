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
use runner_platform::clock::now_secs;
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
///
/// Both carry the run's session too. Two runs on one box can name one key —
/// an ended judge's and the build that took the issue after it — and a call
/// naming only the box read the newer run's lease as the older one's, gave it
/// back, and left the newer run refused `NO_HOLDER` on its own move (ISS-752).
#[async_trait::async_trait]
pub trait LeaseKeeper: Send + Sync {
    async fn release(
        &self,
        project_id: Option<&str>,
        session_id: Option<&str>,
        issue_key: &str,
    ) -> Result<()>;
    async fn is_returned(
        &self,
        project_id: Option<&str>,
        session_id: Option<&str>,
        issue_key: &str,
    ) -> Result<bool>;
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
                // Never read off the world here: only the release decides a
                // checkout is left to another open run, and it says so itself.
                CheckoutReturn::KeptForOpenRun => {}
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
    let session = run.session_id.clone();
    for m in ledger.issues(run_id)? {
        if m.lease_returned_at.is_some() {
            continue;
        }
        if !matches!(
            leases
                .is_returned(project.as_deref(), session.as_deref(), &m.issue_key)
                .await,
            Ok(true)
        ) {
            // The mark answers to the read-back below and never to this
            // response, so the outcome decides nothing here. What it carries
            // does: a refusal names the way out — the project to send, the key
            // that reaches no lease — and a run whose release is refused says
            // so rather than passing in silence (ISS-1139).
            if let Err(e) = leases
                .release(project.as_deref(), session.as_deref(), &m.issue_key)
                .await
            {
                tracing::warn!(
                    "[close] run={run_id} {}: lease release refused: {e}",
                    m.issue_key
                );
            }
        }
        if matches!(
            leases
                .is_returned(project.as_deref(), session.as_deref(), &m.issue_key)
                .await,
            Ok(true)
        ) {
            ledger.mark_lease_returned_observed(run_id, &m.issue_key)?;
        }
    }

    state(ledger, run_id)
}

/// Two runs on one box over one key (ISS-752): the close of the older one,
/// whose session took no lease, against a core that answers per session.
#[cfg(test)]
mod tests {
    use super::*;
    use runner_core::ledger::NewRun;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Core's lease store as one box sees it: rows of (session, key). A
    /// give-back naming a session reaches that session's row; one naming none
    /// is refused over a live lease, as core refuses `ISSUE_LEASE_RUN_UNNAMED`.
    struct Core {
        rows: Mutex<Vec<(String, String)>>,
        released: Mutex<Vec<(Option<String>, String)>>,
    }

    #[async_trait::async_trait]
    impl SessionReader for Core {
        async fn is_terminal(&self, _id: &str) -> Result<bool> {
            Ok(true)
        }
    }

    #[async_trait::async_trait]
    impl LeaseKeeper for Core {
        async fn release(&self, _p: Option<&str>, session: Option<&str>, key: &str) -> Result<()> {
            self.released
                .lock()
                .unwrap()
                .push((session.map(str::to_string), key.to_string()));
            let mut rows = self.rows.lock().unwrap();
            match session {
                Some(s) => rows.retain(|(rs, rk)| !(rs == s && rk == key)),
                None if rows.iter().any(|(_, rk)| rk == key) => {
                    return Err(runner_platform::error::Error::Other(
                        "ISSUE_LEASE_RUN_UNNAMED".into(),
                    ))
                }
                None => {}
            }
            Ok(())
        }
        async fn is_returned(
            &self,
            _p: Option<&str>,
            session: Option<&str>,
            key: &str,
        ) -> Result<bool> {
            let rows = self.rows.lock().unwrap();
            Ok(!rows
                .iter()
                .any(|(rs, rk)| rk == key && session.is_none_or(|s| s == rs)))
        }
    }

    fn declare(led: &mut Ledger, run_id: &str, key: &str) {
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: PathBuf::from(format!("/nonexistent/{run_id}")),
            boot_id: "boot-1".into(),
            issue_keys: vec![key.into()],
            role: None,
        })
        .unwrap();
    }

    #[tokio::test]
    async fn criterion_3_an_older_runs_close_completes_while_a_newer_run_holds_the_key() {
        let dir = std::env::temp_dir().join(format!(
            "forge-iss752-{}-{}",
            std::process::id(),
            runner_core::agent_activity::now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = Ledger::open(&dir.join("ledger.db")).unwrap();

        // ISS-572's shape: the judge over the closed issue took no lease and
        // ended; the build declared after it took the issue's lease.
        declare(&mut led, "judge", "ISS-572");
        led.attach_session("judge", "session-judge").unwrap();
        led.end_run("judge", "test", "the judge ended").unwrap();
        declare(&mut led, "build", "ISS-572");
        led.attach_session("build", "session-build").unwrap();
        let core = Core {
            rows: Mutex::new(vec![("session-build".into(), "ISS-572".into())]),
            released: Mutex::new(vec![]),
        };

        let closed = close(&mut led, "judge", None, &core, &core).await.unwrap();

        assert_eq!(
            (closed.leases_returned, closed.leases_total),
            (1, 1),
            "the judge's close stayed owed a lease the build holds"
        );
        assert_eq!(
            *core.rows.lock().unwrap(),
            vec![("session-build".to_string(), "ISS-572".to_string())],
            "the judge's close gave back the build's lease"
        );
        assert!(
            core.released.lock().unwrap().is_empty(),
            "a lease the judge never took was given back: {:?}",
            core.released.lock().unwrap()
        );
        let build = state(&led, "build").unwrap();
        assert_eq!(build.leases_returned, 0);

        // The build's own close still gives back what it took, by its session.
        let closed = close(&mut led, "build", None, &core, &core).await.unwrap();
        assert_eq!((closed.leases_returned, closed.leases_total), (1, 1));
        assert!(core.rows.lock().unwrap().is_empty());
        assert_eq!(
            *core.released.lock().unwrap(),
            vec![(Some("session-build".to_string()), "ISS-572".to_string())]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
