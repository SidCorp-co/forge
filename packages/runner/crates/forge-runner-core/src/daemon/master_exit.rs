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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::path::PathBuf;

    static SOURCE: std::sync::LazyLock<&str> =
        std::sync::LazyLock::new(|| crate::test_scratch::lf(include_str!("master_exit.rs")));

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

    const NOW: i64 = 1_791_055_458_000;
    const HOUR_MS: i64 = MASTER_IDLE_BEFORE_EXIT.as_millis() as i64;
    const PAST_THE_HOUR: Duration = Duration::from_secs(60 * 60 + 1);

    fn child(id: &str, closed: bool) -> Child {
        Child {
            run_id: id.into(),
            closed,
            closed_at: closed.then_some((NOW - 2 * HOUR_MS) / 1000),
        }
    }

    fn pane(doing: Doing, last_event: Event, ago_ms: i64) -> Option<Pane> {
        Some(Pane {
            doing,
            last_event,
            last_event_at: NOW - ago_ms,
        })
    }

    fn quiet_pane() -> Option<Pane> {
        pane(Doing::Idle, Event::Stopped, HOUR_MS + 1_000)
    }

    #[test]
    fn an_idle_hour_with_a_live_child_is_not_enough_to_leave() {
        let v = verdict(
            PAST_THE_HOUR,
            quiet_pane(),
            &[child("run-1", true), child("run-2", false)],
            NOW,
        );
        assert_eq!(
            v,
            Verdict::Stay(StayReason::ChildrenUnfinished(vec!["run-2".into()])),
            "both halves are required — a master that leaves over an open child takes the only process that would have closed that run's loop, and the run then waits out core's ten-minute reaper instead (ISS-933 criterion 19)"
        );
    }

    #[test]
    fn an_idle_hour_with_every_child_closed_and_a_quiet_pane_is_the_one_case_that_leaves() {
        assert!(matches!(
            verdict(PAST_THE_HOUR, quiet_pane(), &[child("run-1", true)], NOW),
            Verdict::Exit(_)
        ));
        assert!(matches!(
            verdict(MASTER_IDLE_BEFORE_EXIT, quiet_pane(), &[], NOW),
            Verdict::Exit(_)
        ));
    }

    #[test]
    fn work_inside_the_window_keeps_a_master_whatever_its_children_did() {
        assert_eq!(
            verdict(
                MASTER_IDLE_BEFORE_EXIT - Duration::from_secs(1),
                quiet_pane(),
                &[child("run-1", true)],
                NOW,
            ),
            Verdict::Stay(StayReason::RecentWork),
            "a master with work inside the hour stays even with nothing open — the idle clock is the first half and closed children are not a reason to leave on their own (ISS-933 criterion 19)"
        );
    }

    /// The incident, replayed: the pool had held nothing for an hour and every
    /// child was closed, and the pane was mid-turn on input an operator typed
    /// four minutes before. The rule that read only the first two retired it.
    #[test]
    fn a_pane_mid_turn_is_never_retired_however_quiet_the_pool_and_its_children() {
        for (doing, last_event, ago) in [
            (Doing::Working, Event::PromptSubmitted, 4 * 60_000),
            (Doing::Working, Event::PromptSubmitted, 5 * HOUR_MS),
            (Doing::Working, Event::SubagentStopped, 2 * HOUR_MS),
            (
                Doing::AwaitingPermission,
                Event::PermissionRequested,
                3 * HOUR_MS,
            ),
            (Doing::AwaitingChildren, Event::Stopped, 3 * HOUR_MS),
        ] {
            assert_eq!(
                verdict(
                    Duration::from_secs(10 * 60 * 60),
                    pane(doing, last_event, ago),
                    &[child("run-1", true)],
                    NOW,
                ),
                Verdict::Stay(StayReason::PaneBusy(doing)),
                "a pane whose hooks say {doing:?} is busy whatever the pool and the ledger say — ending it kills the turn the operator is in the middle of (ISS-95)"
            );
        }
    }

    #[test]
    fn a_pane_typed_into_inside_the_window_stays_after_its_turn_has_ended() {
        let v = verdict(
            PAST_THE_HOUR,
            pane(Doing::Idle, Event::Stopped, 3 * 60_000),
            &[child("run-1", true)],
            NOW,
        );
        assert_eq!(
            v,
            Verdict::Stay(StayReason::PaneRecent {
                last_event: Event::Stopped,
                at: NOW - 3 * 60_000,
            }),
            "a prompt submitted inside the hour, and the turn it began, are both inside the window — the hour counts from the pane's last hook, never from the pool's last work (ISS-95)"
        );
        assert_eq!(
            verdict(
                PAST_THE_HOUR,
                pane(Doing::Idle, Event::Stopped, HOUR_MS - 1),
                &[],
                NOW
            ),
            Verdict::Stay(StayReason::PaneRecent {
                last_event: Event::Stopped,
                at: NOW - HOUR_MS + 1,
            }),
            "one millisecond short of the window is inside it"
        );
    }

    #[test]
    fn a_hook_stamped_ahead_of_this_clock_is_inside_the_window() {
        assert!(matches!(
            verdict(
                PAST_THE_HOUR,
                pane(Doing::Idle, Event::Stopped, -60_000),
                &[],
                NOW
            ),
            Verdict::Stay(StayReason::PaneRecent { .. })
        ));
    }

    #[test]
    fn a_pane_this_daemon_never_heard_is_not_idle() {
        assert_eq!(
            verdict(PAST_THE_HOUR, None, &[child("run-1", true)], NOW),
            Verdict::Stay(StayReason::PaneUnreported),
            "no report is no evidence: a pane mid-turn when this daemon restarted reports nothing until its turn ends, and reading that silence as idle retires it"
        );
    }

    #[test]
    fn a_child_that_closed_inside_the_window_keeps_the_master() {
        let recent = Child {
            run_id: "run-2".into(),
            closed: true,
            closed_at: Some((NOW - 10 * 60_000) / 1000),
        };
        assert_eq!(
            verdict(
                PAST_THE_HOUR,
                quiet_pane(),
                &[child("run-1", true), recent],
                NOW
            ),
            Verdict::Stay(StayReason::ChildClosedRecently("run-2".into())),
            "no child open for the whole window, not merely at the moment of reading"
        );
    }

    #[test]
    fn the_retirement_names_every_signal_it_read() {
        let Verdict::Exit(quiet) = verdict(
            Duration::from_secs(65 * 60),
            pane(Doing::Idle, Event::Stopped, 61 * 60_000),
            &[child("run-1", true)],
            NOW,
        ) else {
            panic!("a quiet pane, an idle pool and closed children retire");
        };
        let said = quiet.reason(NOW);
        for signal in [
            "`Stop` at 2026-10-03T18:23:18Z (61m ago)",
            "no turn running and no prompt submitted since",
            "nothing was claimable for 65m",
            "all 1 child run(s) it declared are closed, the last at 2026-10-03T17:24:18Z",
        ] {
            assert!(
                said.contains(signal),
                "the line a reader finds after a pane is gone names `{signal}`: {said}"
            );
        }
        let Verdict::Exit(none) = verdict(PAST_THE_HOUR, quiet_pane(), &[], NOW) else {
            panic!("no children at all is closed children");
        };
        assert!(none.reason(NOW).contains("it declared no child run"));
    }

    #[test]
    fn instants_are_said_in_utc() {
        assert_eq!(utc(1_791_055_458_000), "2026-10-03T19:24:18Z");
        assert_eq!(utc(1_709_164_800_000), "2024-02-29T00:00:00Z");
        assert_eq!(utc(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn a_childs_close_time_is_its_newest_stamped_mark() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "sess-a".into(),
            worktree_path: PathBuf::from("/tmp/forge-run-1"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-95".into()],
        })
        .unwrap();
        assert_eq!(
            children(&led, "sess-a").unwrap()[0].closed_at,
            None,
            "a run with no mark stamped has no close time"
        );
        led.mark_lease_returned_observed("run-1", "ISS-95").unwrap();
        let read = children(&led, "sess-a").unwrap();
        assert!(
            read[0].closed_at.is_some(),
            "a returned lease is a stamped close mark: {read:?}"
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
