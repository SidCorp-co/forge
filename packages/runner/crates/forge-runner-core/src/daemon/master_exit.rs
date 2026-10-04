/*
 * When a resident master is allowed to end itself.
 *
 * Residency is not free — a master is a live `claude` process holding a pane —
 * so a project with nothing to do gives its master back. Every half is
 * required: an hour of quiet on the pool says nothing about the runs already
 * in flight, and a master that leaves over a live child abandons the close
 * loop nobody else on the box will finish. Nor does it say anything about the
 * pane, where a turn runs that the pool never sees; the pane's own hooks are
 * the one channel that hears a turn begin and end, so they decide whether it
 * is busy (ISS-95).
 */

use std::time::Duration;

use crate::daemon::agent_activity::{Activity, Doing, Event};
use crate::error::Result;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, MasterRow};

pub const MASTER_IDLE_BEFORE_EXIT: Duration = Duration::from_secs(60 * 60);

/// One child run, reduced to what this decision asks of it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Child {
    pub run_id: String,
    pub closed: bool,
    /// The newest close mark the ledger stamped for it, in unix seconds. `None`
    /// where no mark carries a time.
    pub closed_at: Option<i64>,
}

/// What the master pane's own hooks last reported, narrowed to this decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pane {
    pub doing: Doing,
    /// The newest hook event the pane reported, and when, in wall-clock ms.
    /// A submitted prompt is one, so input inside the window moves it.
    pub last_event: Event,
    pub last_event_at: i64,
}

impl Pane {
    pub fn of(a: &Activity) -> Self {
        Self {
            doing: a.doing(),
            last_event: a.last_event,
            last_event_at: a.last_event_at,
        }
    }
}

/// Why a master is staying, or that it may go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Stay(StayReason),
    Exit(Quiet),
}

/// The signals a retirement read, carried to the line that says it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Quiet {
    pub pane: Pane,
    /// How long the pool has held nothing for this project.
    pub no_work_for: Duration,
    /// Child runs this master declared, every one of them closed.
    pub children_closed: Vec<String>,
    /// The newest close mark among them, in unix seconds.
    pub last_child_closed_at: Option<i64>,
}

impl Quiet {
    /// The retirement, said as the signals it read.
    pub fn reason(&self, now_ms: i64) -> String {
        let children = match (self.children_closed.len(), self.last_child_closed_at) {
            (0, _) => "it declared no child run".to_string(),
            (n, Some(at)) => format!(
                "all {n} child run(s) it declared are closed, the last at {}",
                utc(at.saturating_mul(1000))
            ),
            (n, None) => format!("all {n} child run(s) it declared are closed"),
        };
        format!(
            "its pane's last hook was `{}` at {} ({}m ago) with no turn running and no prompt submitted since, nothing was claimable for {}m, and {children}",
            self.pane.last_event.wire(),
            utc(self.pane.last_event_at),
            now_ms.saturating_sub(self.pane.last_event_at) / 60_000,
            self.no_work_for.as_secs() / 60,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StayReason {
    /// There was work inside the idle window.
    RecentWork,
    /// Children whose close loop has not finished, named.
    ChildrenUnfinished(Vec<String>),
    /// This daemon has heard no hook from the pane, so whether a turn is
    /// running cannot be told, and that is never read as idle.
    PaneUnreported,
    /// A turn is running, a child agent of it is, or it is stopped on a
    /// question a human owes.
    PaneBusy(Doing),
    /// The pane reported inside the window: input arrived or a turn ended.
    PaneRecent { last_event: Event, at: i64 },
    /// A child run closed inside the window.
    ChildClosedRecently(String),
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

/// Whether a resident master may be retired as idle.
///
/// Idle is every one of these holding for the whole of
/// [`MASTER_IDLE_BEFORE_EXIT`]: the pool held nothing, the pane's hooks report
/// no turn running and nothing since the last one ended, and no child run is
/// open or closed inside it. A pane this daemon has not heard is not idle.
pub fn verdict(idle_for: Duration, pane: Option<Pane>, children: &[Child], now_ms: i64) -> Verdict {
    let window_ms = MASTER_IDLE_BEFORE_EXIT.as_millis() as i64;
    if idle_for < MASTER_IDLE_BEFORE_EXIT {
        return Verdict::Stay(StayReason::RecentWork);
    }
    let unfinished: Vec<String> = children
        .iter()
        .filter(|c| !c.closed)
        .map(|c| c.run_id.clone())
        .collect();
    if !unfinished.is_empty() {
        return Verdict::Stay(StayReason::ChildrenUnfinished(unfinished));
    }
    let Some(pane) = pane else {
        return Verdict::Stay(StayReason::PaneUnreported);
    };
    if pane.doing != Doing::Idle {
        return Verdict::Stay(StayReason::PaneBusy(pane.doing));
    }
    if now_ms.saturating_sub(pane.last_event_at) < window_ms {
        return Verdict::Stay(StayReason::PaneRecent {
            last_event: pane.last_event,
            at: pane.last_event_at,
        });
    }
    let last_child_closed_at = children.iter().filter_map(|c| c.closed_at).max();
    if let Some(recent) = children.iter().find(|c| {
        c.closed_at
            .is_some_and(|at| now_ms.saturating_sub(at.saturating_mul(1000)) < window_ms)
    }) {
        return Verdict::Stay(StayReason::ChildClosedRecently(recent.run_id.clone()));
    }
    Verdict::Exit(Quiet {
        pane,
        no_work_for: idle_for,
        children_closed: children.iter().map(|c| c.run_id.clone()).collect(),
        last_child_closed_at,
    })
}

/// `ms` since the epoch as an RFC 3339 UTC instant, to the second.
fn utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}
