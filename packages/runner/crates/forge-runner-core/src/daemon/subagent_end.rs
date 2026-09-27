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

use std::path::Path;
use std::time::Duration;

use crate::daemon::run_exit::RUN_SILENT_BEFORE_EXIT;
use crate::daemon::transcript_age;

/// Silence after a turn-end past which a subagent run reads as quiet.
pub const SUBAGENT_QUIET: Duration = RUN_SILENT_BEFORE_EXIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// No turn-end is recorded, so the subagent is taken to be in its first turn.
    NoTurnEnd,
    /// The transcript has an entry after the last stop that is not one of that
    /// stop's own hook records: a turn resumed, and its end has not been heard.
    Resumed,
    /// A turn ended less than [`SUBAGENT_QUIET`] ago.
    Recent { silent_ms: i64 },
    /// A turn ended at least [`SUBAGENT_QUIET`] ago and nothing but that
    /// stop's own hook records was written after it. It may still be resumed,
    /// so this ends nothing.
    Quiet { silent_ms: i64 },
    /// A turn ended and the box cannot read the transcript that would say what
    /// followed.
    Unreadable,
}

/// `turn_ended_at` and `written_at` are wall-clock ms: the last `SubagentStop`
/// and the newest write to the subagent's own transcript. `ends_on_stop` says
/// the newest entry there is a `SubagentStop` hook's own record.
pub fn read(
    turn_ended_at: Option<i64>,
    written_at: Option<i64>,
    ends_on_stop: bool,
    now: i64,
) -> Evidence {
    let Some(stop) = turn_ended_at else {
        return Evidence::NoTurnEnd;
    };
    let Some(written) = written_at else {
        return Evidence::Unreadable;
    };
    // The stop hooks write their records after the stop is stamped, so a
    // write after the stop is a resumed turn only where it is something else
    // (ISS-1312). Silence is measured from the later of the two, so a stop
    // whose own frame never reached the box is still measured from its end.
    if written > stop && !ends_on_stop {
        return Evidence::Resumed;
    }
    let silent_ms = now.saturating_sub(stop.max(written));
    if silent_ms >= SUBAGENT_QUIET.as_millis() as i64 {
        Evidence::Quiet { silent_ms }
    } else {
        Evidence::Recent { silent_ms }
    }
}

/// [`read`], with the transcript at `transcript` read for it. A tail that
/// cannot be read is not taken to end on a stop.
pub fn observe(turn_ended_at: Option<i64>, transcript: Option<&Path>, now: i64) -> Evidence {
    let written = transcript.and_then(transcript_age::written_at);
    let ends_on_stop = transcript
        .and_then(transcript_age::ends_on_stop_records)
        .unwrap_or(false);
    read(turn_ended_at, written, ends_on_stop, now)
}

/// What the box says when it first finds a run in this state, or `None` for
/// the states it says nothing about.
pub fn notice(evidence: Evidence) -> Option<&'static str> {
    match evidence {
        Evidence::NoTurnEnd | Evidence::Resumed | Evidence::Recent { .. } => None,
        Evidence::Quiet { .. } => Some("quiet"),
        Evidence::Unreadable => Some("unreadable"),
    }
}

/// Why a subagent run in this state holds a restart, in the words the drain's
/// lines carry, so a held drain is read from its own line (ISS-1312).
pub fn held_because(evidence: Evidence, transcript: Option<&str>) -> String {
    let bound = SUBAGENT_QUIET.as_secs() / 60;
    match evidence {
        Evidence::NoTurnEnd => "its subagent has not ended a turn".to_string(),
        Evidence::Resumed => {
            "its subagent's transcript has an entry after its last turn-end, so a resumed turn is running"
                .to_string()
        }
        Evidence::Recent { silent_ms } => format!(
            "its subagent ended a turn {}m ago, inside the {bound}m it is given to resume",
            silent_ms / 60_000
        ),
        Evidence::Quiet { silent_ms } => format!(
            "its subagent ended a turn {}m ago and wrote nothing after it",
            silent_ms / 60_000
        ),
        Evidence::Unreadable => format!(
            "its subagent ended a turn and its transcript ({}) cannot be read, so nothing says what followed",
            transcript.unwrap_or("no path was recorded")
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const STOP: i64 = 1_800_000_000_000;
    const WINDOW: i64 = SUBAGENT_QUIET.as_millis() as i64;
    /// How long after the stamp the stop hooks' records landed on ISS-1312's
    /// two runs: 213 ms and 120 ms.
    const HOOKS_LAND: i64 = 213;

    #[test]
    fn a_run_that_never_ended_a_turn_is_working() {
        assert_eq!(read(None, None, false, STOP), Evidence::NoTurnEnd);
        assert_eq!(
            read(None, Some(STOP), true, STOP + 10 * WINDOW),
            Evidence::NoTurnEnd
        );
    }

    #[test]
    fn a_turn_ended_moments_ago_is_not_quiet() {
        assert_eq!(
            read(Some(STOP), Some(STOP), false, STOP + MIN),
            Evidence::Recent { silent_ms: MIN }
        );
    }

    #[test]
    fn quiet_starts_at_the_window_and_not_a_millisecond_before() {
        assert_eq!(
            read(Some(STOP), Some(STOP), false, STOP + WINDOW - 1),
            Evidence::Recent {
                silent_ms: WINDOW - 1
            }
        );
        assert_eq!(
            read(Some(STOP), Some(STOP), false, STOP + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    /// ISS-1312: the stop hooks' own records are the write after the stop,
    /// and they are the stop, not a turn after it.
    #[test]
    fn the_stop_hooks_own_records_after_the_stamp_are_not_a_resumed_turn() {
        let written = STOP + HOOKS_LAND;
        assert_eq!(
            read(Some(STOP), Some(written), true, written + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW }
        );
        assert_eq!(
            read(Some(STOP), Some(written), false, written + WINDOW),
            Evidence::Resumed,
            "the same write, followed by anything else, is a resumed turn"
        );
    }

    #[test]
    fn silence_is_measured_from_the_stop_records_where_they_land_after_the_stamp() {
        let written = STOP + 30 * MIN;
        assert_eq!(
            read(Some(STOP), Some(written), true, STOP + WINDOW),
            Evidence::Recent {
                silent_ms: WINDOW - 30 * MIN
            },
            "a later stop whose frame the box never heard ends a later turn, and its silence starts there"
        );
    }

    #[test]
    fn a_write_after_the_stop_is_a_resumed_turn_however_long_ago() {
        assert_eq!(
            read(Some(STOP), Some(STOP + 10 * MIN), false, STOP + 70 * MIN),
            Evidence::Resumed,
            "resumed at minute 10 with no stop heard since: its turn is still running, and only the next stop can make it quiet again"
        );
    }

    #[test]
    fn a_write_older_than_the_stop_is_no_sign_of_a_resumed_turn() {
        assert_eq!(
            read(Some(STOP), Some(STOP - 5 * MIN), false, STOP + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    #[test]
    fn an_unreadable_transcript_is_no_evidence_and_never_silence() {
        assert_eq!(
            read(Some(STOP), None, true, STOP + 10 * WINDOW),
            Evidence::Unreadable
        );
    }

    #[test]
    fn quiet_and_unreadable_are_the_states_something_is_said_about() {
        assert_eq!(notice(Evidence::NoTurnEnd), None);
        assert_eq!(notice(Evidence::Resumed), None);
        assert_eq!(notice(Evidence::Recent { silent_ms: MIN }), None);
        assert_eq!(notice(Evidence::Quiet { silent_ms: WINDOW }), Some("quiet"));
        assert_eq!(notice(Evidence::Unreadable), Some("unreadable"));
    }

    #[test]
    fn each_holding_state_is_named_apart() {
        let lines = [
            held_because(Evidence::NoTurnEnd, None),
            held_because(Evidence::Resumed, None),
            held_because(Evidence::Recent { silent_ms: 5 * MIN }, None),
            held_because(Evidence::Unreadable, Some("/t/agent-a.jsonl")),
        ];
        assert!(lines[0].contains("has not ended a turn"), "{}", lines[0]);
        assert!(lines[1].contains("resumed turn"), "{}", lines[1]);
        assert!(lines[2].contains("5m ago, inside the 60m"), "{}", lines[2]);
        assert!(lines[3].contains("/t/agent-a.jsonl"), "{}", lines[3]);
    }

    #[test]
    fn observing_the_incident_s_own_tail_reads_quiet() {
        let dir = crate::test_scratch::Scratch::new("subagent-end");
        let path = dir.path().join("agent-a9860d00885b2b2d0.jsonl");
        std::fs::write(&path, transcript_age::STOP_TAIL).unwrap();
        let written = transcript_age::written_at(&path).unwrap();
        let stop = written - HOOKS_LAND;
        assert!(matches!(
            observe(Some(stop), Some(&path), written + WINDOW),
            Evidence::Quiet { .. }
        ));
        let resumed = format!(
            "{}{}",
            transcript_age::STOP_TAIL,
            transcript_age::RESUMED_TAIL
        );
        std::fs::write(&path, &resumed).unwrap();
        let written = transcript_age::written_at(&path).unwrap();
        assert_eq!(
            observe(Some(stop), Some(&path), written + 10 * WINDOW),
            Evidence::Resumed
        );

        // The resumed turn ended too, and the box never heard its stop: the
        // stop records after it are that turn's end, and silence starts there.
        let ended = transcript_age::STOP_TAIL.lines().last().unwrap();
        std::fs::write(&path, format!("{resumed}{ended}\n")).unwrap();
        let written = transcript_age::written_at(&path).unwrap();
        assert_eq!(
            observe(Some(stop), Some(&path), written + MIN),
            Evidence::Recent { silent_ms: MIN }
        );
        assert!(matches!(
            observe(Some(stop), Some(&path), written + WINDOW),
            Evidence::Quiet { .. }
        ));
    }
}
