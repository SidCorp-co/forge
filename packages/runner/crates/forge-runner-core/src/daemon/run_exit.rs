/*
 * When a run session that has finished is allowed to be ended.
 *
 * `master_exit` answers this for a master pane. Nothing answered it for a run
 * pane, and the gap is not symmetric with it: a master is briefed again every
 * sweep, so an idle one is between passes, while a run pane is briefed ONCE
 * and has nothing left to do after its last turn. Alive is therefore evidence
 * of work for a master and evidence of nothing for a run.
 *
 * The beat cannot see the difference — it asserts "this box still holds this
 * run" and never progress — so a finished run pane is beaten forever, core's
 * reaper never fires over it, and the worktree and leases it holds are held by
 * derivation. Measured forge-vm 2026-09-12: 32 of 34 run panes idle, the
 * oldest 22 hours, every one of them beating; sidpeak held 20 slots and 19
 * checkouts against a budget of three.
 */

use std::time::Duration;

use crate::daemon::agent_activity::Doing;

/// How long a run pane may report idle before the box ends it.
// cm:guard a floor on REPORTED idleness and not on age: the clock starts at the turn boundary the session itself reported, so a run working for six hours is never near it and one that stopped six minutes ago is never past it. Fifteen minutes rather than the master's hour because the two are answering different questions — a master's idleness is a gap between passes and costs a cold context to restart, a run's is the end of its life and costs a slot for every minute it is indulged.
pub const RUN_IDLE_BEFORE_EXIT: Duration = Duration::from_secs(15 * 60);

/// What a run's own session last reported about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub doing: Doing,
    /// The last turn boundary this session reported, in wall-clock ms.
    pub at: i64,
}

/// Why a run pane is being kept, or that it may be ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Stay(StayReason),
    Exit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StayReason {
    /// A turn is running, or a child of it is.
    Working,
    /// Stopped on a question a human owes an answer to.
    AwaitingPermission,
    /// This session has never reported a boundary, so nothing is known.
    NeverReported,
    /// Idle, but not for long enough yet.
    RecentlyIdle,
}

/// The whole decision, from what the session said and the clock.
// cm:guard an absent report is `NeverReported` and NEVER idleness, which is the same refusal `Activities::get` makes for the same reason: a pane whose hooks failed to install, or which predates the hook channel, reports nothing — and reading that silence as "finished" would end live agents on every box that has not upgraded. The honest reading of no evidence is no verdict.
// cm:guard `AwaitingPermission` stays, and it outranks the clock rather than being aged out of. A question put to a human is answered on human time; ending the pane that asked it destroys the question along with the context needed to act on the answer, which is the same asymmetry `recovery::reconcile` grants a park before it reads either orphan premise.
pub fn verdict(reported: Option<Reported>, now: i64) -> Verdict {
    let Some(r) = reported else {
        return Verdict::Stay(StayReason::NeverReported);
    };
    match r.doing {
        Doing::Working => Verdict::Stay(StayReason::Working),
        Doing::AwaitingPermission => Verdict::Stay(StayReason::AwaitingPermission),
        // cm:guard a boundary in the FUTURE is treated as recent, never as an elapsed age. The timestamp is the pane's own clock reported over a socket, so a skewed one would otherwise subtract to a huge idle span and end a session that had just spoken.
        Doing::Idle => {
            let idle_for = now.saturating_sub(r.at);
            if idle_for >= RUN_IDLE_BEFORE_EXIT.as_millis() as i64 {
                Verdict::Exit
            } else {
                Verdict::Stay(StayReason::RecentlyIdle)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const WINDOW: i64 = RUN_IDLE_BEFORE_EXIT.as_millis() as i64;

    fn idle_since(at: i64) -> Option<Reported> {
        Some(Reported {
            doing: Doing::Idle,
            at,
        })
    }

    #[test]
    fn an_idle_run_past_the_window_is_ended() {
        assert_eq!(verdict(idle_since(NOW - WINDOW - 1), NOW), Verdict::Exit);
    }

    #[test]
    fn the_boundary_itself_ends_it() {
        assert_eq!(verdict(idle_since(NOW - WINDOW), NOW), Verdict::Exit);
    }

    #[test]
    fn an_idle_run_inside_the_window_is_kept() {
        assert_eq!(
            verdict(idle_since(NOW - WINDOW + 1), NOW),
            Verdict::Stay(StayReason::RecentlyIdle)
        );
    }

    // cm:guard the case that decides whether this may ever run at all: a pane
    // whose turn has been going for a day is not idle for a day.
    #[test]
    fn a_long_turn_is_not_idleness() {
        assert_eq!(
            verdict(
                Some(Reported {
                    doing: Doing::Working,
                    at: NOW - WINDOW * 100,
                }),
                NOW
            ),
            Verdict::Stay(StayReason::Working)
        );
    }

    #[test]
    fn a_question_a_human_owes_outlives_the_window() {
        assert_eq!(
            verdict(
                Some(Reported {
                    doing: Doing::AwaitingPermission,
                    at: NOW - WINDOW * 100,
                }),
                NOW
            ),
            Verdict::Stay(StayReason::AwaitingPermission)
        );
    }

    // cm:guard an unhooked pane is indistinguishable from a finished one by
    // screen and by process; only the absence of a report separates them.
    #[test]
    fn a_session_that_never_reported_is_never_ended() {
        assert_eq!(verdict(None, NOW), Verdict::Stay(StayReason::NeverReported));
    }

    #[test]
    fn a_boundary_in_the_future_does_not_end_the_run() {
        assert_eq!(
            verdict(idle_since(NOW + WINDOW), NOW),
            Verdict::Stay(StayReason::RecentlyIdle)
        );
    }
}
