//! What a subagent run's own evidence says about it, and what that decides.
//!
//! A subagent shares its master's process, so the box has no pid to refute and
//! hears only its turn boundaries. `SubagentStop` is one of those: a subagent
//! ends a turn to wait on a monitor or a suite it started, and a background
//! notification resumes it. Measured sid-xeon-1 2026-09-24: ISS-1135's run
//! stopped with "Waiting on the baseline integration monitor", was resumed 56 s
//! later, and wrote for fifty minutes more, but the stop had already been read
//! as the end and its tree was gone within 45 s. A subagent that finished can
//! also be resumed by its dispatcher (ISS-1217's judge, the same day).
//!
//! So nothing here ends a run. A subagent run ends by its master's
//! `forge-runner run close` or by its master's pane being gone, because the
//! master is the only party that can resume it. This reading decides two
//! things only: what the box says about a run it keeps, and whether a daemon
//! restart waits for it (ISS-1246).

use std::time::Duration;

use crate::daemon::run_exit::RUN_SILENT_BEFORE_EXIT;

/// Silence after a turn-end past which a subagent run reads as quiet.
pub const SUBAGENT_QUIET: Duration = RUN_SILENT_BEFORE_EXIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// No turn-end is recorded, or something was written after the last one,
    /// or the silence since it is shorter than [`SUBAGENT_QUIET`].
    Working,
    /// A turn ended at least [`SUBAGENT_QUIET`] ago and nothing was written
    /// after it. It may still be resumed, so this ends nothing.
    Quiet { silent_ms: i64 },
    /// A turn ended and the box cannot read the transcript that would say what
    /// followed.
    Unreadable,
}

/// `turn_ended_at` and `written_at` are wall-clock ms: the last `SubagentStop`
/// and the newest write to the subagent's own transcript.
pub fn read(turn_ended_at: Option<i64>, written_at: Option<i64>, now: i64) -> Evidence {
    let Some(stop) = turn_ended_at else {
        return Evidence::Working;
    };
    let Some(written) = written_at else {
        return Evidence::Unreadable;
    };
    // A write after the stop is a turn running whose own end has not arrived,
    // and it stays so until the next stop is heard.
    if written > stop {
        return Evidence::Working;
    }
    let silent_ms = now.saturating_sub(stop);
    if silent_ms >= SUBAGENT_QUIET.as_millis() as i64 {
        Evidence::Quiet { silent_ms }
    } else {
        Evidence::Working
    }
}

/// What the box says when it first finds a run in this state, or `None` for
/// the state it says nothing about.
pub fn notice(evidence: Evidence) -> Option<&'static str> {
    match evidence {
        Evidence::Working => None,
        Evidence::Quiet { .. } => Some("quiet"),
        Evidence::Unreadable => Some("unreadable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const STOP: i64 = 1_800_000_000_000;
    const WINDOW: i64 = SUBAGENT_QUIET.as_millis() as i64;

    #[test]
    fn a_run_that_never_ended_a_turn_is_working() {
        assert_eq!(read(None, None, STOP), Evidence::Working);
        assert_eq!(
            read(None, Some(STOP), STOP + 10 * WINDOW),
            Evidence::Working
        );
    }

    #[test]
    fn a_turn_ended_moments_ago_is_not_quiet() {
        assert_eq!(read(Some(STOP), Some(STOP), STOP + MIN), Evidence::Working);
    }

    #[test]
    fn quiet_starts_at_the_window_and_not_a_millisecond_before() {
        assert_eq!(
            read(Some(STOP), Some(STOP), STOP + WINDOW - 1),
            Evidence::Working
        );
        assert_eq!(
            read(Some(STOP), Some(STOP), STOP + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    #[test]
    fn a_write_after_the_stop_is_a_resumed_turn_however_long_ago() {
        assert_eq!(
            read(Some(STOP), Some(STOP + 10 * MIN), STOP + 70 * MIN),
            Evidence::Working,
            "resumed at minute 10 with no stop heard since: its turn is still running, and only the next stop can make it quiet again"
        );
    }

    #[test]
    fn a_write_older_than_the_stop_is_no_sign_of_a_resumed_turn() {
        assert_eq!(
            read(Some(STOP), Some(STOP - 5 * MIN), STOP + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    #[test]
    fn an_unreadable_transcript_is_no_evidence_and_never_silence() {
        assert_eq!(
            read(Some(STOP), None, STOP + 10 * WINDOW),
            Evidence::Unreadable
        );
    }

    #[test]
    fn working_is_the_one_state_nothing_is_said_about() {
        assert_eq!(notice(Evidence::Working), None);
        assert_eq!(notice(Evidence::Quiet { silent_ms: WINDOW }), Some("quiet"));
        assert_eq!(notice(Evidence::Unreadable), Some("unreadable"));
    }
}
