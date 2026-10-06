/*
 * What a resident master holds: the runs it declared and whether each is over.
 *
 * When an idle master may end is core's verdict (`masters/verdict.ts`, ADR
 * 0009 What core takes over: Retirement); this reads the facts it is judged on,
 * which only this box's ledger and process table hold.
 */

use runner_core::ledger::{Ledger, MasterRow};
use runner_core::subagent_end;
use runner_platform::error::Result;
use runner_workspace::close_loop;

/// One child run, reduced to what core's retirement verdict asks of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub run_id: String,
    pub closed: bool,
    /// The newest close mark the ledger stamped for it, in unix seconds. `None`
    /// where no mark carries a time.
    pub closed_at: Option<i64>,
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
    /// Why its subagent is over, in recovery's words, where the box reads it so:
    /// the process it ran in is gone, or it ended a turn at least
    /// [`subagent_end::SUBAGENT_QUIET`] ago with nothing after. `None` while it
    /// may still be working, or nothing can be read. A pane ended over a run
    /// whose subagent is over ends no work; its successor inherits the run.
    pub ended: Option<String>,
}

/// Recovery's evidence for a run's subagent, narrowed to whether it is over.
pub fn subagent_over(evidence: subagent_end::Evidence, transcript: Option<&str>) -> Option<String> {
    match evidence {
        subagent_end::Evidence::HostEnded { .. }
        | subagent_end::Evidence::Quiet { .. }
        | subagent_end::Evidence::Unanswered { .. } => {
            Some(subagent_end::held_because(evidence, transcript))
        }
        subagent_end::Evidence::NoTurnEnd { .. }
        | subagent_end::Evidence::Resumed { .. }
        | subagent_end::Evidence::AwaitingReply { .. }
        | subagent_end::Evidence::Recent { .. }
        | subagent_end::Evidence::Unreadable
        | subagent_end::Evidence::TailUnreadable { .. } => None,
    }
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
    if let Some(why) = row.unattributed.as_deref() {
        return Ok(Holding::Unknown(format!(
            "{why}, so which runs {} holds cannot be established on this box until each ends or is read",
            row.pane_name
        )));
    }
    let mut held = Vec::new();
    let now = runner_core::agent_activity::now_ms();
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
            ended: subagent_over(
                subagent_end::of_run(&run, now),
                run.agent_transcript.as_deref(),
            ),
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
        let leases = ledger
            .issues(&run.run_id)?
            .into_iter()
            .filter_map(|m| m.lease_returned_at);
        let closed_at = [run.session_terminal_at, run.worktree_gone_at]
            .into_iter()
            .flatten()
            .chain(leases)
            .max();
        out.push(Child {
            run_id: run.run_id,
            closed,
            closed_at,
        });
    }
    Ok(out)
}
