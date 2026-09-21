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
use crate::runner::ledger::{Ledger, MasterRow};

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

/// One run a resident master still holds, named the way an operator who is
/// about to end that master needs it named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldRun {
    pub run_id: String,
    /// The master session the run answers to. Printed because a stand-down
    /// that named a project's runs rather than this master's would ask an
    /// operator to force past work belonging to somebody else.
    pub master_session_id: String,
    pub issues: Vec<String>,
}

/// What this box can say about the runs one project's resident master holds.
///
/// Three answers and not two. A `masters` row written before the session id
/// was recorded makes the question structurally unanswerable, and reporting
/// that as zero is what would let a stand-down end a pane holding work nobody
/// checked (ISS-1118).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holding {
    /// The master's identity is known and no run of its is still open.
    Nothing,
    /// The master's identity is known and these runs are still open.
    These(Vec<HeldRun>),
    /// The identity could not be established, so no count is possible. Carries
    /// what it was that could not be established.
    Unknown(String),
}

/// The runs a project's master holds, from the `masters` row that names it.
pub fn holding(ledger: &Ledger, row: Option<&MasterRow>) -> Result<Holding> {
    let Some(row) = row else {
        return Ok(Holding::Unknown(
            "this box holds no ledger row for that project's master pane, so the session id its runs are keyed by is not known here".into(),
        ));
    };
    let Some(session) = row.session_id.as_deref() else {
        return Ok(Holding::Unknown(format!(
            "the ledger row for {} was written by a runner build that did not record the master's session id, so which runs that pane holds cannot be established on this box",
            row.pane_name
        )));
    };
    let mut held = Vec::new();
    for run in ledger.runs_for_master(session)? {
        if close_loop::state(ledger, &run.run_id)?.is_closed() {
            continue;
        }
        held.push(HeldRun {
            run_id: run.run_id.clone(),
            master_session_id: session.to_string(),
            issues: ledger
                .issues(&run.run_id)?
                .into_iter()
                .map(|m| m.issue_key)
                .collect(),
        });
    }
    if held.is_empty() {
        Ok(Holding::Nothing)
    } else {
        Ok(Holding::These(held))
    }
}

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

    fn row(session: Option<&str>) -> MasterRow {
        MasterRow {
            project_id: "proj-1".into(),
            pane_name: "forge-master-forge-dev".into(),
            conversation_id: Some("conv-abc".into()),
            session_id: session.map(str::to_string),
            boot_id: "boot-a".into(),
            cold_started_at: 1,
            last_seen_at: 1,
        }
    }

    /// Criterion 19. Zero and "cannot tell" are different answers, and only
    /// one of them is safe to end a pane on.
    #[test]
    fn a_master_row_with_no_session_id_reads_as_unknown_and_never_as_nothing() {
        let led = Ledger::open_in_memory().unwrap();
        match holding(&led, Some(&row(None))).unwrap() {
            Holding::Unknown(why) => assert!(
                why.contains("session id"),
                "the refusal names the identity it could not establish: {why}"
            ),
            other => panic!(
                "a row written before the column existed cannot answer this question, and answering `{other:?}` would let a stand-down end a pane holding work nobody checked"
            ),
        }
    }

    #[test]
    fn no_master_row_at_all_is_unknown_too() {
        let led = Ledger::open_in_memory().unwrap();
        assert!(
            matches!(holding(&led, None).unwrap(), Holding::Unknown(_)),
            "a pane this box has never heard from holds runs it cannot count, which is not the same as holding none"
        );
    }

    #[test]
    fn a_master_holding_nothing_reads_as_nothing_and_one_holding_a_run_names_it() {
        let mut led = Ledger::open_in_memory().unwrap();
        assert_eq!(
            holding(&led, Some(&row(Some("sess-a")))).unwrap(),
            Holding::Nothing,
            "a known master with no open run is safe to end without --force"
        );
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "sess-a".into(),
            worktree_path: PathBuf::from("/tmp/forge-run-1"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1201".into()],
        })
        .unwrap();
        let Holding::These(held) = holding(&led, Some(&row(Some("sess-a")))).unwrap() else {
            panic!("an open run under this master must be named");
        };
        assert_eq!(held.len(), 1);
        assert_eq!(held[0].run_id, "run-1");
        assert_eq!(
            held[0].master_session_id, "sess-a",
            "the run is named WITH the master session holding it, so an operator can tell this master's work from the project's"
        );
        assert_eq!(held[0].issues, vec!["ISS-1201".to_string()]);
    }

    #[test]
    fn another_masters_runs_are_not_counted_against_this_one() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "theirs".into(),
            project_id: "proj-1".into(),
            master_session_id: "sess-somebody-else".into(),
            worktree_path: PathBuf::from("/tmp/forge-theirs"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1202".into()],
        })
        .unwrap();
        assert_eq!(
            holding(&led, Some(&row(Some("sess-a")))).unwrap(),
            Holding::Nothing,
            "counting a PROJECT's runs rather than this master's would ask an operator to force past work belonging to somebody else"
        );
    }

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
