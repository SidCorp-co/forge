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

use crate::error::Result;
use crate::runner::ledger::{CheckoutReturn, Ledger};
pub use crate::transport::run_sessions::Outcome;
use crate::workspace::worktree::Residence;

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
async fn checkout_returned(repo: Option<&Path>, path: &Path) -> Option<CheckoutReturn> {
    let repo = repo?;
    match crate::workspace::worktree::residence_of(repo, path).await {
        Residence::Gone => Some(CheckoutReturn::Gone),
        Residence::MainWorkingTree => Some(CheckoutReturn::MainWorkingTreeKept),
        Residence::Linked
        | Residence::NotAWorktree
        | Residence::MovedTo(_)
        | Residence::RegisteredButMissing(_)
        | Residence::Ambiguous(_) => None,
        Residence::Unknown(why) => {
            tracing::warn!(
                "[close] {}: git could not be asked whether this checkout is still registered ({why}) — the run keeps holding it",
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
        if let Some(how) = checkout_returned(repo, Path::new(&run.worktree_path)).await {
            ledger.mark_checkout_returned_observed(run_id, how)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::{Ledger, NewRun};
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const SOURCE: &str = include_str!("close_loop.rs");

    struct Sessions(bool);

    #[async_trait::async_trait]
    impl SessionReader for Sessions {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(self.0)
        }
    }

    /// The tracker as a world with its own state. `lands` names the issues whose
    /// release actually takes effect there; `write_fails` makes the RESPONSE to
    /// that release fail regardless. The two are independent on purpose — that
    /// separation is the whole thing under test.
    struct Leases {
        write_fails: bool,
        lands: HashSet<String>,
        returned: Mutex<HashSet<String>>,
        releases: Mutex<usize>,
        /// Every (project, issue) the loop asked to release, in order.
        asked_for: Mutex<Vec<(Option<String>, String)>>,
        /// Every (project, issue) the loop read back, in order.
        read_for: Mutex<Vec<(Option<String>, String)>>,
    }

    impl Leases {
        fn new(write_fails: bool, lands: &[&str]) -> Self {
            Self {
                write_fails,
                lands: lands.iter().map(|s| (*s).to_string()).collect(),
                returned: Mutex::new(HashSet::new()),
                releases: Mutex::new(0),
                asked_for: Mutex::new(Vec::new()),
                read_for: Mutex::new(Vec::new()),
            }
        }

        fn already_back(self, issue: &str) -> Self {
            self.returned.lock().unwrap().insert(issue.to_string());
            self
        }
    }

    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, project_id: Option<&str>, issue_key: &str) -> Result<()> {
            self.asked_for
                .lock()
                .unwrap()
                .push((project_id.map(str::to_string), issue_key.to_string()));
            *self.releases.lock().unwrap() += 1;
            if self.lands.contains(issue_key) {
                self.returned.lock().unwrap().insert(issue_key.to_string());
            }
            if self.write_fails {
                Err(crate::error::Error::Other("connection reset".into()))
            } else {
                Ok(())
            }
        }
        async fn is_returned(&self, project_id: Option<&str>, issue_key: &str) -> Result<bool> {
            self.read_for
                .lock()
                .unwrap()
                .push((project_id.map(str::to_string), issue_key.to_string()));
            Ok(self.returned.lock().unwrap().contains(issue_key))
        }
    }

    fn seeded(issues: &[&str], worktree: PathBuf) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: worktree,
            boot_id: "boot-a".into(),
            issue_keys: issues.iter().map(|s| (*s).to_string()).collect(),
        })
        .unwrap();
        led.attach_session("run-1", "sess-1").unwrap();
        led
    }

    fn gone() -> PathBuf {
        PathBuf::from("/tmp/forge-close-loop-absent-by-construction")
    }

    /// The repository whose registry answers *do you register a worktree at
    /// this path?*. An absent path is a question for it and not an answer on
    /// its own (ISS-1193), so every close here has one to ask.
    ///
    /// One per test rather than one per process: a process-wide fixture has no drop, so it would
    /// outlive the run. libtest gives every test a thread of its own, and this goes with it.
    fn a_repository() -> PathBuf {
        thread_local! {
            static REPO: crate::test_scratch::Scratch = {
                let root = crate::test_scratch::Scratch::new("close-loop-repo");
                let _ = std::process::Command::new("git")
                    .args(["init", "-q", "-b", "main"])
                    .current_dir(&root)
                    .output();
                root
            };
        }
        REPO.with(|r| r.to_path_buf())
    }

    #[tokio::test]
    async fn a_cheerful_response_over_work_that_did_not_land_sets_nothing() {
        let mut led = seeded(&["ISS-957"], gone());
        let leases = Leases::new(false, &[]);
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &leases,
        )
        .await
        .unwrap();
        assert_eq!(
            st.leases_returned, 0,
            "the lease mark must come from READING THE TRACKER BACK, never from the response to the return — a stale success is exactly the shape that let a master report a loop it had not closed (ISS-933 criterion 13)"
        );
        assert!(!st.is_closed());
    }

    #[tokio::test]
    async fn a_dropped_response_over_work_that_did_land_still_closes() {
        let mut led = seeded(&["ISS-957"], gone());
        let leases = Leases::new(true, &["ISS-957"]);
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &leases,
        )
        .await
        .unwrap();
        assert_eq!(
            st.leases_returned, 1,
            "the world says this lease is back, so the mark is owed however the write's response arrived — treating a dropped response as failure leaves a run open forever on work that is done (ISS-933 criterion 13)"
        );
        assert!(st.is_closed());
    }

    #[tokio::test]
    async fn a_master_that_says_it_is_done_sets_no_mark() {
        let production = SOURCE.split("#[cfg(test)]").next().unwrap();
        let sig = production
            .split("pub async fn close(")
            .nth(1)
            .expect("close must exist")
            .split(')')
            .next()
            .unwrap();
        for declared in ["done", "closed", "terminal:", "finished", "success"] {
            assert!(
                !sig.contains(declared),
                "`close` must take no argument by which a caller could ASSERT a mark; found `{declared}` in its signature (ISS-933 criterion 13)"
            );
        }
    }

    #[tokio::test]
    async fn a_live_session_leaves_its_mark_unset() {
        let mut led = seeded(&["ISS-957"], gone());
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(false),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();
        assert!(
            !st.session_terminal,
            "a session that is not terminal must not be marked so"
        );
        assert!(!st.is_closed());
    }

    #[tokio::test]
    async fn a_worktree_still_on_disk_leaves_its_mark_unset() {
        let dir = crate::test_scratch::Scratch::new("cl");
        let mut led = seeded(&["ISS-957"], dir.to_path_buf());

        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();
        assert!(
            !st.checkout_returned,
            "the worktree mark is a FILESYSTEM check on this box, and the path is still there"
        );
        std::fs::remove_dir_all(&dir).unwrap();

        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();
        assert!(
            st.checkout_returned,
            "and it lands on the retry, once the path is actually absent"
        );
        assert!(st.is_closed());
    }

    #[tokio::test]
    async fn one_of_three_returned_reads_as_exactly_that() {
        let mut led = seeded(&["ISS-943", "ISS-944", "ISS-957"], gone());
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &Leases::new(false, &["ISS-944"]),
        )
        .await
        .unwrap();
        assert_eq!((st.leases_returned, st.leases_total), (1, 3));
        assert!(
            !st.is_closed(),
            "a run that returned one of three leases is NOT closed — the other two issues still stand in the name of a dead run (ISS-933 criterion 14)"
        );
        let marks = led.issues("run-1").unwrap();
        assert!(marks
            .iter()
            .find(|m| m.issue_key == "ISS-944")
            .unwrap()
            .lease_returned_at
            .is_some());
        assert!(marks
            .iter()
            .find(|m| m.issue_key == "ISS-943")
            .unwrap()
            .lease_returned_at
            .is_none());
    }

    #[tokio::test]
    async fn a_partial_close_is_distinguishable_from_a_clean_one_by_the_ledger_alone() {
        let mut led = seeded(&["ISS-943", "ISS-944"], gone());
        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(false),
            &Leases::new(false, &["ISS-944"]),
        )
        .await
        .unwrap();
        let partial = state(&led, "run-1").unwrap();
        assert_eq!(
            partial,
            CloseState {
                session_terminal: false,
                checkout_returned: true,
                leases_returned: 1,
                leases_total: 2
            }
        );

        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &Leases::new(false, &["ISS-943", "ISS-944"]),
        )
        .await
        .unwrap();
        let clean = state(&led, "run-1").unwrap();
        assert!(clean.is_closed());
        assert_ne!(
            partial, clean,
            "the two must not read alike (ISS-933 criterion 15)"
        );
    }

    #[tokio::test]
    async fn a_lease_already_back_is_marked_without_being_returned_again() {
        let mut led = seeded(&["ISS-957"], gone());
        let leases = Leases::new(false, &[]).already_back("ISS-957");
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &leases,
        )
        .await
        .unwrap();
        assert!(st.is_closed());
        assert_eq!(
            *leases.releases.lock().unwrap(),
            0,
            "the mark answers to the WORLD, not to this runner having been the one to act — a lease someone else already returned is returned, and releasing it again is a write nobody asked for"
        );
    }

    #[tokio::test]
    async fn closing_twice_neither_double_marks_nor_re_releases_what_is_already_back() {
        let mut led = seeded(&["ISS-957"], gone());
        let first = Leases::new(false, &["ISS-957"]);
        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &first,
        )
        .await
        .unwrap();
        let at = led.issues("run-1").unwrap()[0].lease_returned_at;

        let second = Leases::new(false, &["ISS-957"]);
        let st = close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &second,
        )
        .await
        .unwrap();
        assert!(st.is_closed());
        assert_eq!(
            *second.releases.lock().unwrap(),
            0,
            "a mark already set is never revisited"
        );
        assert_eq!(
            led.issues("run-1").unwrap()[0].lease_returned_at,
            at,
            "and its timestamp is not rewritten"
        );
    }

    /// A refusal core sends back over a release, as the transport reports it.
    struct RefusingRelease(&'static str);

    #[async_trait::async_trait]
    impl LeaseKeeper for RefusingRelease {
        async fn release(&self, _: Option<&str>, _: &str) -> Result<()> {
            Err(crate::error::Error::Other(self.0.to_string()))
        }
        async fn is_returned(&self, _: Option<&str>, _: &str) -> Result<bool> {
            Ok(false)
        }
    }

    /// A scoped subscriber over one call, so a claim about the log is read back
    /// rather than trusted. Siblings in `master.rs` and `session_tokens.rs`
    /// carry their own; each is local to the module whose log it reads.
    fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::Arc;
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// ISS-1139 — a release core refused names its refusal where a person reads.
    ///
    /// The mark answers to the read-back and never to this response, so the run
    /// correctly stays open. What must not happen is the message going nowhere:
    /// a box sending no project meets the `409` that names `?projectId=` as the
    /// way out, and an operator left with a run that will not close and no
    /// reason has nothing to act on.
    #[test]
    fn a_release_core_refuses_names_its_refusal_in_the_log() {
        let out = logged_while(|| {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let mut led = seeded(&["ISS-880"], gone());
                let st = close(
                    &mut led,
                    "run-1",
                    Some(&a_repository()),
                    &Sessions(true),
                    &RefusingRelease(
                        "issue-lease release: 409: this box holds 2 leases on ISS-880; send `?projectId=<id>`",
                    ),
                )
                .await
                .unwrap();
                assert!(
                    !st.is_closed(),
                    "the lease is not back, so the run is not closed — the log is what this test is about"
                );
            });
        });

        assert!(
            out.contains("ISS-880"),
            "a refusal discarded reaches no log, and the operator is left with a run that will not close and no reason: {out}"
        );
        assert!(
            out.contains("projectId"),
            "the refusal carries the way out, which is the whole of what makes it worth printing: {out}"
        );
    }

    /// ISS-1139 — a lease is keyed by project and issue, so both calls carry the
    /// run's project. Without it core cannot tell which of two projects sharing
    /// a key this box means, and answers about neither.
    #[tokio::test]
    async fn both_lease_calls_name_the_run_project() {
        let mut led = seeded(&["ISS-880"], gone());
        let leases = Leases::new(false, &["ISS-880"]);

        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &leases,
        )
        .await
        .unwrap();

        assert_eq!(
            leases.asked_for.lock().unwrap().as_slice(),
            [(Some("proj-1".to_string()), "ISS-880".to_string())],
            "a release that names no project is refused by core, and the run never closes"
        );
        assert!(
            leases
                .read_for
                .lock()
                .unwrap()
                .iter()
                .all(|(p, _)| p.as_deref() == Some("proj-1")),
            "a read-back against another project answers about a lease this run never held"
        );
    }

    /// ISS-1242 — `f0c38b4e`, one minute later.
    ///
    /// A release is refused over a checkout, and a minute afterwards the
    /// checkout goes: the master pruned its own worktree after the merge. The
    /// refusal will never be taken again, so it never reaches its own decision,
    /// and the row kept `release_refused_at` with a null `release_terminal_at`
    /// for ever. Measured on this box 2026-09-25: three closed runs in that
    /// shape, the oldest two days old.
    #[tokio::test]
    async fn a_refusal_the_returned_checkout_overtook_is_settled_and_keeps_its_text() {
        let mut led = seeded(&["ISS-308"], gone());
        led.note_release_refusal(
            "run-1",
            "the diff in /home/dev/... was not preserved (this checkout is on no branch)",
            1_790_000_000,
        )
        .unwrap();
        led.end_run("run-1", "subagent", "its subagent ended its turn")
            .unwrap();

        let leases = Leases::new(false, &["ISS-308"]);
        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &leases,
        )
        .await
        .unwrap();

        let run = led.run("run-1").unwrap().unwrap();
        assert!(
            run.released_as.is_some(),
            "the case under test is a checkout observed back: {run:?}"
        );
        assert!(
            run.release_terminal_at.is_some(),
            "a refusal that can never be taken again is settled here, or the row reports one that was never decided for ever: {run:?}"
        );
        assert_eq!(
            run.release_refusal.as_deref(),
            Some("the diff in /home/dev/... was not preserved (this checkout is on no branch)"),
            "and what was refused stays on the row verbatim — an operator reading it is owed the text, not a cleared column"
        );
        assert_eq!(
            run.ended_by.as_deref(),
            Some("subagent"),
            "the ending another path already wrote is not overwritten by the settle"
        );
    }

    /// ISS-1242 — the boundary. A refusal over a checkout that has NOT come
    /// back is still live: the next sweep takes it again and the window or the
    /// attempt bound decides it. Settling it here would end a retry that was
    /// still working.
    #[tokio::test]
    async fn a_refusal_over_a_checkout_still_held_is_not_settled() {
        let held = crate::test_scratch::Scratch::new("close-loop-still-held");
        let root = a_repository();
        let _ = std::process::Command::new("git")
            .args([
                "worktree",
                "add",
                "-q",
                "--detach",
                &held.to_path_buf().to_string_lossy(),
            ])
            .current_dir(&root)
            .output();
        let mut led = seeded(&["ISS-957"], held.to_path_buf());
        led.note_release_refusal("run-1", "git worktree remove failed", 1_790_000_000)
            .unwrap();

        close(
            &mut led,
            "run-1",
            Some(&root),
            &Sessions(true),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();

        let run = led.run("run-1").unwrap().unwrap();
        assert!(
            run.released_as.is_none(),
            "the case under test is a checkout git still registers: {run:?}"
        );
        assert!(
            run.release_terminal_at.is_none(),
            "nothing overtook this refusal, so the retry that would decide it must still be owed: {run:?}"
        );
    }

    /// ISS-1242's own rows, which a settle guarded by the OBSERVATION misses.
    ///
    /// `f0c38b4e`, `af39c60d` and `daff6570` were all marked `released_as` by
    /// the sweep that came after their refusal, days before any fix runs. A
    /// settle that only fires on the call that first sees the checkout back
    /// therefore never fires for any of them, and the rows the issue is about
    /// stay unsettled for ever. The condition is that the checkout IS back.
    #[tokio::test]
    async fn a_checkout_marked_back_by_an_earlier_sweep_still_settles_its_refusal() {
        let mut led = seeded(&["ISS-308"], gone());
        led.note_release_refusal("run-1", "the diff was not preserved", 1_790_000_000)
            .unwrap();
        led.end_run("run-1", "subagent", "its subagent ended its turn")
            .unwrap();
        led.mark_checkout_returned_observed("run-1", crate::runner::ledger::CheckoutReturn::Gone)
            .unwrap();
        assert!(
            led.run("run-1")
                .unwrap()
                .unwrap()
                .release_terminal_at
                .is_none(),
            "the case under test starts unsettled"
        );

        close(
            &mut led,
            "run-1",
            Some(&a_repository()),
            &Sessions(true),
            &Leases::new(false, &["ISS-308"]),
        )
        .await
        .unwrap();

        let run = led.run("run-1").unwrap().unwrap();
        assert!(
            run.release_terminal_at.is_some(),
            "a row whose checkout an EARLIER sweep marked back is exactly the row this issue is \
             about, and a settle it cannot reach settles nothing: {run:?}"
        );
        assert_eq!(
            run.release_refusal.as_deref(),
            Some("the diff was not preserved"),
            "and the refusal text is still the evidence"
        );
    }
}
