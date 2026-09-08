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
use crate::runner::ledger::Ledger;

/// Reads back the authoritative session row. Never the ack of a write.
#[async_trait::async_trait]
pub trait SessionReader: Send + Sync {
    async fn is_terminal(&self, agent_session_id: &str) -> Result<bool>;
}

/// Returns a lease, and separately reads back whether it is actually returned.
#[async_trait::async_trait]
pub trait LeaseKeeper: Send + Sync {
    async fn release(&self, issue_key: &str) -> Result<()>;
    async fn is_returned(&self, issue_key: &str) -> Result<bool>;
}

/// What the ledger says, with no process inspected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseState {
    pub session_terminal: bool,
    pub worktree_gone: bool,
    pub leases_returned: usize,
    pub leases_total: usize,
}

impl CloseState {
    /// Every mark set. Anything else is a run still owed work.
    pub fn is_closed(&self) -> bool {
        self.session_terminal && self.worktree_gone && self.leases_returned == self.leases_total
    }
}

/// Read the three marks from the ledger alone.
// cm:guard answers from the LEDGER and inspects no process (ISS-933 criterion 15). A reader that consults a pid cannot answer for a box whose master is gone, which is the case this exists for.
pub fn state(ledger: &Ledger, run_id: &str) -> Result<CloseState> {
    let run = ledger.run(run_id)?;
    let issues = ledger.issues(run_id)?;
    Ok(CloseState {
        session_terminal: run
            .as_ref()
            .is_some_and(|r| r.session_terminal_at.is_some()),
        worktree_gone: run.as_ref().is_some_and(|r| r.worktree_gone_at.is_some()),
        leases_returned: issues
            .iter()
            .filter(|m| m.lease_returned_at.is_some())
            .count(),
        leases_total: issues.len(),
    })
}

/// Attempt every mark this run still owes. Safe to call again.
// cm:guard takes NO argument by which a caller could assert a mark — that is what makes "a master's declaration sets none of the three" true by construction rather than by convention (ISS-933 criterion 13). Adding a `done: bool` here would reopen the exact hole.
// cm:guard idempotent and partial by design: each mark is attempted independently, an error on one leaves the others free to land, and a mark already set is never revisited. A close that gives up on the first failure leaves a run stuck behind whichever check happened to be first.
pub async fn close(
    ledger: &mut Ledger,
    run_id: &str,
    sessions: &dyn SessionReader,
    leases: &dyn LeaseKeeper,
) -> Result<CloseState> {
    let Some(run) = ledger.run(run_id)? else {
        return state(ledger, run_id);
    };

    // cm:guard a missing session id reads as "never started", and that is only true because `run_session::start` opens the session BEFORE it spawns anything. Reverse that order and this arm closes the loop over a live agent core cannot name.
    let session_terminal = match run.session_id.as_deref() {
        Some(id) => matches!(sessions.is_terminal(id).await, Ok(true)),
        None => true,
    };
    if run.session_terminal_at.is_none() && session_terminal {
        ledger.mark_session_terminal_observed(run_id)?;
    }

    if run.worktree_gone_at.is_none() && !Path::new(&run.worktree_path).exists() {
        ledger.mark_worktree_gone_observed(run_id)?;
    }

    for m in ledger.issues(run_id)? {
        if m.lease_returned_at.is_some() {
            continue;
        }
        if !matches!(leases.is_returned(&m.issue_key).await, Ok(true)) {
            let _ = leases.release(&m.issue_key).await;
        }
        if matches!(leases.is_returned(&m.issue_key).await, Ok(true)) {
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
    }

    impl Leases {
        fn new(write_fails: bool, lands: &[&str]) -> Self {
            Self {
                write_fails,
                lands: lands.iter().map(|s| (*s).to_string()).collect(),
                returned: Mutex::new(HashSet::new()),
                releases: Mutex::new(0),
            }
        }

        fn already_back(self, issue: &str) -> Self {
            self.returned.lock().unwrap().insert(issue.to_string());
            self
        }
    }

    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, issue_key: &str) -> Result<()> {
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
        async fn is_returned(&self, issue_key: &str) -> Result<bool> {
            Ok(self.returned.lock().unwrap().contains(issue_key))
        }
    }

    fn seeded(issues: &[&str], worktree: PathBuf) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
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

    #[tokio::test]
    async fn a_cheerful_response_over_work_that_did_not_land_sets_nothing() {
        let mut led = seeded(&["ISS-957"], gone());
        let leases = Leases::new(false, &[]);
        let st = close(&mut led, "run-1", &Sessions(true), &leases)
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
        let st = close(&mut led, "run-1", &Sessions(true), &leases)
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
        let dir = std::env::temp_dir().join(format!("forge-cl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut led = seeded(&["ISS-957"], dir.clone());
        let st = close(
            &mut led,
            "run-1",
            &Sessions(true),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();
        assert!(
            !st.worktree_gone,
            "the worktree mark is a FILESYSTEM check on this box, and the path is still there"
        );
        std::fs::remove_dir_all(&dir).unwrap();

        let st = close(
            &mut led,
            "run-1",
            &Sessions(true),
            &Leases::new(false, &["ISS-957"]),
        )
        .await
        .unwrap();
        assert!(
            st.worktree_gone,
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
                worktree_gone: true,
                leases_returned: 1,
                leases_total: 2
            }
        );

        close(
            &mut led,
            "run-1",
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
        let st = close(&mut led, "run-1", &Sessions(true), &leases)
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
        close(&mut led, "run-1", &Sessions(true), &first)
            .await
            .unwrap();
        let at = led.issues("run-1").unwrap()[0].lease_returned_at;

        let second = Leases::new(false, &["ISS-957"]);
        let st = close(&mut led, "run-1", &Sessions(true), &second)
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
}
