/*
 * When a resident master is allowed to end itself.
 *
 * Residency is not free — a master is a live `claude` process holding a pane —
 * so a project with nothing to do gives its master back. Both halves are
 * required and the second is the one that is easy to lose: an hour of quiet
 * says nothing about the runs already in flight, and a master that leaves over
 * a live child abandons the close loop nobody else on the box will finish.
 */

use std::time::Duration;

use crate::error::Result;
use crate::runner::close_loop;
use crate::runner::ledger::Ledger;

/// How long a master may go without work before it is allowed to leave.
// cm:guard an hour, and it is a floor on IDLENESS rather than on residency. Restarting a master costs a cold context and a skill install, so leaving after one empty sweep would trade the whole point of residency for a pane; leaving never makes a box serving six quiet projects carry six permanent processes.
pub const MASTER_IDLE_BEFORE_EXIT: Duration = Duration::from_secs(60 * 60);

/// One child run, reduced to the only thing this decision asks of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub run_id: String,
    pub closed: bool,
}

/// Why a master is staying, or that it may go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Stay(StayReason),
    Exit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StayReason {
    /// There was work inside the idle window.
    RecentWork,
    /// Children whose close loop has not finished, named.
    ChildrenUnfinished(Vec<String>),
}

/// Read this master's children out of the ledger.
// cm:guard the ledger answers this, never a job counter (ISS-933 criterion 20). `pool load` reported `jobsRunning: 1` while six agents ran, and a master that trusted that number would have exited over five live runs; the ledger is the only thing on the box that knows what it started.
pub fn children(ledger: &Ledger, master_session_id: &str) -> Result<Vec<Child>> {
    let mut out = Vec::new();
    for run in ledger.runs_for_master(master_session_id)? {
        let closed = close_loop::state(ledger, &run.run_id)?.is_closed();
        out.push(Child {
            run_id: run.run_id,
            closed,
        });
    }
    Ok(out)
}

/// Both halves, in one answer.
// cm:guard BOTH conditions, and the conjunction is the deliverable (ISS-933 criterion 19). Idleness alone is the failure this replaces: a master that leaves while a child run is open takes the only process that would have closed that run's loop, and the run then waits out core's ten-minute heartbeat reaper instead of ending on the box that owns it.
pub fn verdict(idle_for: Duration, children: &[Child]) -> Verdict {
    if idle_for < MASTER_IDLE_BEFORE_EXIT {
        return Verdict::Stay(StayReason::RecentWork);
    }
    let unfinished: Vec<String> = children
        .iter()
        .filter(|c| !c.closed)
        .map(|c| c.run_id.clone())
        .collect();
    if unfinished.is_empty() {
        Verdict::Exit
    } else {
        Verdict::Stay(StayReason::ChildrenUnfinished(unfinished))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::path::PathBuf;

    const SOURCE: &str = include_str!("master_exit.rs");

    fn child(id: &str, closed: bool) -> Child {
        Child {
            run_id: id.into(),
            closed,
        }
    }

    #[test]
    fn an_idle_hour_with_a_live_child_is_not_enough_to_leave() {
        let v = verdict(
            MASTER_IDLE_BEFORE_EXIT + Duration::from_secs(1),
            &[child("run-1", true), child("run-2", false)],
        );
        assert_eq!(
            v,
            Verdict::Stay(StayReason::ChildrenUnfinished(vec!["run-2".into()])),
            "both halves are required — a master that leaves over an open child takes the only process that would have closed that run's loop, and the run then waits out core's ten-minute reaper instead (ISS-933 criterion 19)"
        );
    }

    #[test]
    fn an_idle_hour_with_every_child_closed_is_the_one_case_that_leaves() {
        assert_eq!(
            verdict(
                MASTER_IDLE_BEFORE_EXIT + Duration::from_secs(1),
                &[child("run-1", true)]
            ),
            Verdict::Exit
        );
        assert_eq!(verdict(MASTER_IDLE_BEFORE_EXIT, &[]), Verdict::Exit);
    }

    #[test]
    fn work_inside_the_window_keeps_a_master_whatever_its_children_did() {
        assert_eq!(
            verdict(
                MASTER_IDLE_BEFORE_EXIT - Duration::from_secs(1),
                &[child("run-1", true)]
            ),
            Verdict::Stay(StayReason::RecentWork),
            "a master with work inside the hour stays even with nothing open — the idle clock is the first half and closed children are not a reason to leave on their own (ISS-933 criterion 19)"
        );
    }

    #[test]
    fn the_decision_is_handed_children_and_never_a_count() {
        let sig = SOURCE
            .split("pub fn verdict(")
            .nth(1)
            .and_then(|r| r.split(')').next())
            .unwrap_or_default();
        for banned in ["count", "running", "jobs", "usize", "u32"] {
            assert!(
                !sig.contains(banned),
                "the children question is answered from the ledger, never from a counter — `pool load` reported jobsRunning: 1 while six agents ran, and a master trusting that number exits over five live runs (ISS-933 criterion 20); signature was: {sig}"
            );
        }
    }

    #[test]
    fn one_master_is_never_held_open_by_another_masters_run() {
        let mut led = Ledger::open_in_memory().unwrap();
        for (run, master, issue) in [
            ("run-mine", "master-a", "ISS-957"),
            ("run-theirs", "master-b", "ISS-958"),
        ] {
            led.create_run_group(NewRun {
                run_id: run.into(),
                project_id: "proj-1".into(),
                master_session_id: master.into(),
                worktree_path: PathBuf::from(format!("/tmp/forge-{run}")),
                boot_id: "boot-a".into(),
                issue_keys: vec![issue.into()],
            })
            .unwrap();
        }

        let mine = children(&led, "master-a").unwrap();
        assert_eq!(
            mine.iter().map(|c| c.run_id.as_str()).collect::<Vec<_>>(),
            ["run-mine"],
            "two masters share this box's ledger, so a question asked over EVERY run has one project's master held open by another project's work (ISS-933 criterion 20)"
        );
        assert!(
            !mine[0].closed,
            "a run with a lease still out is not closed"
        );
    }
}
