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
 *
 * A run pane whose `Stop` was lost reports a turn that never ends, and nothing
 * this daemon registers fires during a turn to age it; its transcript does
 * (`transcript_age`), so the longer window counts from the later of the last
 * hook and the last write, the same rule `job_exit` keeps (ISS-1244).
 */

use std::time::Duration;

use crate::daemon::agent_activity::Doing;

pub const RUN_IDLE_BEFORE_EXIT: Duration = Duration::from_secs(15 * 60);

/// Nothing reported and nothing written for this long, by a turn whose end
/// never arrived or by a lead awaiting a child with no reported end.
/// `job_exit::SILENT_BEFORE_ABANDONED`'s window and its price: a single tool
/// call that writes nothing for this long is ended with the run.
pub const RUN_SILENT_BEFORE_EXIT: Duration = Duration::from_secs(60 * 60);

/// What a run's own session last reported about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub doing: Doing,
    /// The last turn boundary this session reported, in wall-clock ms.
    pub at: i64,
    /// The newest write this box can read to the session's own transcript,
    /// `None` where it can read none.
    pub written_at: Option<i64>,
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
    /// The lead ended its turn over a child with no reported end, and not long
    /// enough ago.
    AwaitingChildren,
}

pub fn verdict(reported: Option<Reported>, now: i64) -> Verdict {
    let Some(r) = reported else {
        return Verdict::Stay(StayReason::NeverReported);
    };
    let quiet_for = now.saturating_sub(r.at);
    let silent_for = now.saturating_sub(r.written_at.map_or(r.at, |w| w.max(r.at)));
    let past = |q: i64, w: Duration| q >= w.as_millis() as i64;
    match r.doing {
        // No transcript to read is no evidence, and never silence.
        Doing::Working if r.written_at.is_none() => Verdict::Stay(StayReason::Working),
        Doing::Working if past(silent_for, RUN_SILENT_BEFORE_EXIT) => Verdict::Exit,
        Doing::Working => Verdict::Stay(StayReason::Working),
        Doing::AwaitingPermission => Verdict::Stay(StayReason::AwaitingPermission),
        Doing::AwaitingChildren if past(silent_for, RUN_SILENT_BEFORE_EXIT) => Verdict::Exit,
        Doing::AwaitingChildren => Verdict::Stay(StayReason::AwaitingChildren),
        Doing::Idle if past(quiet_for, RUN_IDLE_BEFORE_EXIT) => Verdict::Exit,
        Doing::Idle => Verdict::Stay(StayReason::RecentlyIdle),
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
            written_at: None,
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

    #[test]
    fn a_long_turn_is_not_idleness() {
        assert_eq!(
            verdict(
                Some(Reported {
                    doing: Doing::Working,
                    at: NOW - WINDOW * 100,
                    written_at: None,
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
                    written_at: None,
                }),
                NOW
            ),
            Verdict::Stay(StayReason::AwaitingPermission)
        );
    }

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

    const CHILDREN: i64 = RUN_SILENT_BEFORE_EXIT.as_millis() as i64;

    fn awaiting_since(at: i64) -> Option<Reported> {
        Some(Reported {
            doing: Doing::AwaitingChildren,
            at,
            written_at: None,
        })
    }

    #[test]
    fn a_run_awaiting_an_unreported_child_stays_inside_the_longer_window() {
        assert_eq!(
            verdict(awaiting_since(NOW - CHILDREN + 1), NOW),
            Verdict::Stay(StayReason::AwaitingChildren)
        );
        assert_eq!(
            verdict(awaiting_since(NOW - WINDOW), NOW),
            Verdict::Stay(StayReason::AwaitingChildren),
            "the idle window is for a turn with nothing behind it"
        );
    }

    #[test]
    fn a_run_awaiting_an_unreported_child_is_ended_at_the_longer_window() {
        assert_eq!(
            verdict(awaiting_since(NOW - CHILDREN), NOW),
            Verdict::Exit,
            "a child's end that never arrived must not hold a run pane for its whole life (ISS-1232)"
        );
    }

    fn began(at: i64, written_at: Option<i64>) -> Option<Reported> {
        Some(Reported {
            doing: Doing::Working,
            at,
            written_at,
        })
    }

    #[test]
    fn a_run_whose_end_was_lost_is_ended_once_its_transcript_has_been_still_for_the_window() {
        assert_eq!(
            verdict(began(NOW - CHILDREN * 72, Some(NOW - CHILDREN)), NOW),
            Verdict::Exit,
            "a lost Stop must not hold a run pane for its whole life (ISS-1244)"
        );
    }

    #[test]
    fn a_run_still_writing_stays_however_long_ago_its_turn_began() {
        assert_eq!(
            verdict(began(NOW - CHILDREN * 72, Some(NOW - CHILDREN + 1)), NOW),
            Verdict::Stay(StayReason::Working)
        );
    }

    #[test]
    fn a_run_with_no_transcript_to_read_is_never_ended_on_silence() {
        assert_eq!(
            verdict(began(NOW - CHILDREN * 72, None), NOW),
            Verdict::Stay(StayReason::Working)
        );
    }

    #[test]
    fn a_run_awaiting_a_child_that_is_still_writing_stays() {
        assert_eq!(
            verdict(
                Some(Reported {
                    doing: Doing::AwaitingChildren,
                    at: NOW - CHILDREN * 72,
                    written_at: Some(NOW - 1),
                }),
                NOW
            ),
            Verdict::Stay(StayReason::AwaitingChildren)
        );
    }
}
