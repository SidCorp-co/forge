//! What a subagent run's own evidence says about it, and what that decides.
//!
//! A subagent shares its master's Claude Code process, so the box has no pid of
//! its own to refute and hears its turn boundaries and that process. `SubagentStop` is one of those: a subagent
//! ends a turn to wait on a monitor or a suite it started, and a background
//! notification resumes it. Measured sid-xeon-1 2026-09-24: ISS-1135's run
//! stopped with "Waiting on the baseline integration monitor", was resumed 56 s
//! later, and wrote for fifty minutes more, but the stop had already been read
//! as the end and its tree was gone within 45 s. A subagent that finished can
//! also be resumed by its dispatcher (ISS-1217's judge, the same day).
//!
//! So nothing here ends a run. A subagent run ends by its master's
//! `forge-runner run close` or by the Claude Code process it runs in being
//! gone, because the master is the only party that can resume it. That
//! process is read by pid and start time (`subagent_host`), never inferred
//! from the master's tmux pane: Claude Code can run the conversation as a
//! background session outside it (ISS-1312, run e67c08e0). This reading decides
//! what the box says about a run it keeps (ISS-1246), and nothing more: no run
//! holds a daemon's handover to a new build, since a run lives in its master's
//! pane and the next build adopts it (ISS-1379).

use std::path::Path;
use std::time::Duration;

use crate::daemon::run_exit::RUN_SILENT_BEFORE_EXIT;
use crate::daemon::transcript_age::{self, Newest};
use crate::runner::ledger::Run;

/// Silence after a turn-end past which a subagent run reads as quiet.
pub const SUBAGENT_QUIET: Duration = RUN_SILENT_BEFORE_EXIT;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// No turn-end is recorded, so the subagent is taken to be in its first
    /// turn. `since_ms` is since its run was declared.
    NoTurnEnd { since_ms: i64 },
    /// The Claude Code process the subagent lived in was read gone `silent_ms`
    /// ago, and nothing has been heard from the subagent since. A subagent
    /// cannot outlive the process it runs in, so whatever turn it was in ended
    /// then (ISS-1312).
    HostEnded { silent_ms: i64 },
    /// The newest entry after the last stop is a turn's own: a turn resumed,
    /// and its end has not been heard. `silent_ms` is since that entry.
    Resumed { silent_ms: i64 },
    /// The newest entry after the last stop is one the model answers, written
    /// less than [`SUBAGENT_QUIET`] ago, and no reply has followed yet.
    AwaitingReply { silent_ms: i64 },
    /// A turn ended less than [`SUBAGENT_QUIET`] ago.
    Recent { silent_ms: i64 },
    /// A turn ended at least [`SUBAGENT_QUIET`] ago and nothing but that
    /// stop's own hook records was written after it. It may still be resumed,
    /// so this ends nothing.
    Quiet { silent_ms: i64 },
    /// The newest entry after the last stop is one the model answers, and at
    /// least [`SUBAGENT_QUIET`] has passed with no reply: nothing took it up.
    /// It may still be resumed, so this ends nothing.
    Unanswered { silent_ms: i64 },
    /// A turn ended and the box cannot read when the transcript that would
    /// say what followed was last written, or has no path for it.
    Unreadable,
    /// The transcript was written after the last stop, `silent_ms` ago, and
    /// cannot be opened to read what that write was.
    TailUnreadable { silent_ms: i64 },
}

/// `declared_at`, `turn_ended_at` and `written_at` are wall-clock ms: when the
/// run was declared, the last `SubagentStop` and the newest write to the
/// subagent's own transcript. `newest` is what that transcript's newest entry
/// is, `None` where it could not be read; it is read only where the write
/// follows the stop.
pub fn read(
    declared_at: i64,
    turn_ended_at: Option<i64>,
    written_at: Option<i64>,
    newest: Option<Newest>,
    now: i64,
) -> Evidence {
    let Some(stop) = turn_ended_at else {
        return Evidence::NoTurnEnd {
            since_ms: now.saturating_sub(declared_at),
        };
    };
    let Some(written) = written_at else {
        return Evidence::Unreadable;
    };
    let quiet = SUBAGENT_QUIET.as_millis() as i64;
    if written > stop {
        // The stop hooks write their records after the stop is stamped, so a
        // write after the stop is a turn only where it is something else
        // (ISS-1312).
        let since_write = now.saturating_sub(written);
        match newest {
            None => {
                return Evidence::TailUnreadable {
                    silent_ms: since_write,
                }
            }
            Some(Newest::Turn) => {
                return Evidence::Resumed {
                    silent_ms: since_write,
                }
            }
            Some(Newest::AwaitingReply) if since_write >= quiet => {
                return Evidence::Unanswered {
                    silent_ms: since_write,
                };
            }
            Some(Newest::AwaitingReply) => {
                return Evidence::AwaitingReply {
                    silent_ms: since_write,
                };
            }
            Some(Newest::StopRecord) => {}
        }
    }
    // Silence is measured from the later of the two, so a stop whose own
    // frame never reached the box is still measured from its end.
    let silent_ms = now.saturating_sub(stop.max(written));
    if silent_ms >= quiet {
        Evidence::Quiet { silent_ms }
    } else {
        Evidence::Recent { silent_ms }
    }
}

/// What `run`'s own evidence says, the one reading recovery takes. An end of the process its subagent lived in speaks first, unless the
/// subagent has been heard from since: a turn-end or a transcript write later
/// than it, or a start, which clears it on the row. A mark on a row that
/// records no such process, as rows written before the box recorded one carry,
/// was a pane's end and is no evidence about the subagent.
pub fn of_run(run: &Run, now: i64) -> Evidence {
    let transcript = run.agent_transcript.as_deref().map(Path::new);
    if let Some(ended) = run.host_ended_at_ms.filter(|_| run.host_pid.is_some()) {
        let heard = run
            .turn_ended_at_ms
            .max(transcript.and_then(transcript_age::written_at));
        if heard.is_none_or(|h| h <= ended) {
            return Evidence::HostEnded {
                silent_ms: now.saturating_sub(ended),
            };
        }
    }
    observe(
        run.created_at.saturating_mul(1000),
        run.turn_ended_at_ms,
        transcript,
        now,
    )
}

/// [`read`], with the transcript at `transcript` read for it.
pub fn observe(
    declared_at: i64,
    turn_ended_at: Option<i64>,
    transcript: Option<&Path>,
    now: i64,
) -> Evidence {
    let written = transcript.and_then(transcript_age::written_at);
    let after_stop = matches!((turn_ended_at, written), (Some(stop), Some(w)) if w > stop);
    let newest = if after_stop {
        transcript.and_then(transcript_age::newest_entry)
    } else {
        None
    };
    read(declared_at, turn_ended_at, written, newest, now)
}

/// What the box says when it first finds a run in this state, or `None` for
/// the states it says nothing about. The value is written to `kept_notice`,
/// which recovery's other notices share, so none of them may be one of these
/// (`recovery::tests::no_two_writers_of_kept_notice_share_a_value`).
pub fn notice(evidence: Evidence) -> Option<&'static str> {
    match evidence {
        Evidence::NoTurnEnd { .. }
        | Evidence::Resumed { .. }
        | Evidence::AwaitingReply { .. }
        | Evidence::Recent { .. } => None,
        Evidence::Quiet { .. } => Some("quiet"),
        Evidence::Unanswered { .. } => Some("no-reply"),
        Evidence::HostEnded { .. } => Some("host-ended"),
        Evidence::Unreadable | Evidence::TailUnreadable { .. } => Some("unreadable"),
    }
}

/// What the run's evidence says, in the words recovery's lines carry, so a kept
/// run is read from its own line (ISS-1312).
pub fn held_because(evidence: Evidence, transcript: Option<&str>) -> String {
    let bound = SUBAGENT_QUIET.as_secs() / 60;
    let path = transcript.unwrap_or("no path was recorded");
    match evidence {
        Evidence::NoTurnEnd { since_ms } => format!(
            "its subagent has not ended a turn since its run was declared {}m ago",
            since_ms / 60_000
        ),
        Evidence::HostEnded { silent_ms } => format!(
            "the Claude Code process its subagent ran in was read gone {}m ago, and nothing has \
             been heard from its subagent since",
            silent_ms / 60_000
        ),
        Evidence::Resumed { silent_ms } => format!(
            "its subagent's transcript has an entry written {}m ago, after its last turn-end, that is \
             neither that turn-end's own record nor one awaiting a reply, so a resumed turn is taken to be running",
            silent_ms / 60_000
        ),
        Evidence::AwaitingReply { silent_ms } => format!(
            "its subagent was handed an entry written {}m ago, after its last turn-end, and has written \
             no reply yet, inside the {bound}m a reply is given to start",
            silent_ms / 60_000
        ),
        Evidence::Recent { silent_ms } => format!(
            "its subagent ended a turn {}m ago, inside the {bound}m it is given to resume",
            silent_ms / 60_000
        ),
        Evidence::Quiet { silent_ms } => format!(
            "its subagent ended a turn {}m ago and wrote nothing after it",
            silent_ms / 60_000
        ),
        Evidence::Unanswered { silent_ms } => format!(
            "its subagent ended a turn, and the entry handed to it after that, written {}m ago, has had no reply",
            silent_ms / 60_000
        ),
        Evidence::Unreadable => format!(
            "its subagent ended a turn and its transcript ({path}) cannot be read, so nothing says what followed"
        ),
        Evidence::TailUnreadable { silent_ms } => format!(
            "its subagent's transcript ({path}) was written {}m ago, after its last turn-end, and cannot be \
             opened to read what that write was, so nothing says whether a turn resumed",
            silent_ms / 60_000
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
    /// When the run under test was declared: an hour before its stop.
    const DECLARED: i64 = STOP - 60 * MIN;

    #[test]
    fn a_run_that_never_ended_a_turn_is_working() {
        assert_eq!(
            read(DECLARED, None, None, None, STOP),
            Evidence::NoTurnEnd { since_ms: 60 * MIN }
        );
        assert_eq!(
            read(
                DECLARED,
                None,
                Some(STOP),
                Some(Newest::StopRecord),
                STOP + 10 * WINDOW
            ),
            Evidence::NoTurnEnd {
                since_ms: STOP + 10 * WINDOW - DECLARED
            }
        );
    }

    #[test]
    fn a_turn_ended_moments_ago_is_not_quiet() {
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(STOP),
                Some(Newest::Turn),
                STOP + MIN
            ),
            Evidence::Recent { silent_ms: MIN }
        );
    }

    #[test]
    fn quiet_starts_at_the_window_and_not_a_millisecond_before() {
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(STOP),
                Some(Newest::Turn),
                STOP + WINDOW - 1
            ),
            Evidence::Recent {
                silent_ms: WINDOW - 1
            }
        );
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(STOP),
                Some(Newest::Turn),
                STOP + WINDOW
            ),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    /// ISS-1312: the stop hooks' own records are the write after the stop,
    /// and they are the stop, not a turn after it.
    #[test]
    fn the_stop_hooks_own_records_after_the_stamp_are_not_a_resumed_turn() {
        let written = STOP + HOOKS_LAND;
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(written),
                Some(Newest::StopRecord),
                written + WINDOW
            ),
            Evidence::Quiet { silent_ms: WINDOW }
        );
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(written),
                Some(Newest::Turn),
                written + WINDOW
            ),
            Evidence::Resumed { silent_ms: WINDOW },
            "the same write, followed by anything else, is a resumed turn"
        );
    }

    #[test]
    fn silence_is_measured_from_the_stop_records_where_they_land_after_the_stamp() {
        let written = STOP + 30 * MIN;
        assert_eq!(
            read(DECLARED, Some(STOP), Some(written), Some(Newest::StopRecord), STOP + WINDOW),
            Evidence::Recent {
                silent_ms: WINDOW - 30 * MIN
            },
            "a later stop whose frame the box never heard ends a later turn, and its silence starts there"
        );
    }

    #[test]
    fn a_write_after_the_stop_is_a_resumed_turn_however_long_ago() {
        assert_eq!(
            read(DECLARED, Some(STOP), Some(STOP + 10 * MIN), Some(Newest::Turn), STOP + 70 * MIN),
            Evidence::Resumed { silent_ms: 60 * MIN },
            "resumed at minute 10 with no stop heard since: its turn is still running, and only the next stop can make it quiet again"
        );
    }

    #[test]
    fn a_write_older_than_the_stop_is_no_sign_of_a_resumed_turn() {
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(STOP - 5 * MIN),
                Some(Newest::Turn),
                STOP + WINDOW
            ),
            Evidence::Quiet { silent_ms: WINDOW }
        );
    }

    #[test]
    fn an_unreadable_transcript_is_no_evidence_and_never_silence() {
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                None,
                Some(Newest::StopRecord),
                STOP + 10 * WINDOW
            ),
            Evidence::Unreadable
        );
    }

    #[test]
    fn quiet_unanswered_and_unreadable_are_the_states_something_is_said_about() {
        assert_eq!(notice(Evidence::NoTurnEnd { since_ms: MIN }), None);
        assert_eq!(
            notice(Evidence::HostEnded { silent_ms: MIN }),
            Some("host-ended")
        );
        assert_eq!(notice(Evidence::Resumed { silent_ms: MIN }), None);
        assert_eq!(notice(Evidence::AwaitingReply { silent_ms: MIN }), None);
        assert_eq!(notice(Evidence::Recent { silent_ms: MIN }), None);
        assert_eq!(notice(Evidence::Quiet { silent_ms: WINDOW }), Some("quiet"));
        assert_eq!(
            notice(Evidence::Unanswered { silent_ms: WINDOW }),
            Some("no-reply")
        );
        assert_eq!(notice(Evidence::Unreadable), Some("unreadable"));
        assert_eq!(
            notice(Evidence::TailUnreadable { silent_ms: MIN }),
            Some("unreadable")
        );
    }

    #[test]
    fn each_holding_state_is_named_apart() {
        let path = Some("/t/agent-a.jsonl");
        let lines = [
            held_because(Evidence::NoTurnEnd { since_ms: 95 * MIN }, None),
            held_because(
                Evidence::Resumed {
                    silent_ms: 125 * MIN,
                },
                None,
            ),
            held_because(Evidence::Recent { silent_ms: 5 * MIN }, None),
            held_because(Evidence::Unreadable, path),
            held_because(
                Evidence::TailUnreadable {
                    silent_ms: 180 * MIN,
                },
                path,
            ),
            held_because(Evidence::AwaitingReply { silent_ms: 7 * MIN }, None),
        ];
        assert!(
            lines[0].contains("has not ended a turn") && lines[0].contains("declared 95m ago"),
            "{}",
            lines[0]
        );
        assert!(
            lines[1].contains("resumed turn") && lines[1].contains("written 125m ago"),
            "{}",
            lines[1]
        );
        assert!(lines[2].contains("5m ago, inside the 60m"), "{}", lines[2]);
        assert!(lines[3].contains("/t/agent-a.jsonl"), "{}", lines[3]);
        assert!(
            lines[4].contains("/t/agent-a.jsonl")
                && lines[4].contains("written 180m ago")
                && lines[4].contains("cannot be opened")
                && !lines[4].contains("resumed turn"),
            "{}",
            lines[4]
        );
        assert!(
            lines[5].contains("written 7m ago") && lines[5].contains("no reply yet"),
            "{}",
            lines[5]
        );
    }

    #[test]
    fn observing_the_incident_s_own_tail_reads_quiet() {
        let dir = crate::test_scratch::Scratch::new("subagent-end");
        let path = dir.path().join("agent-a9860d00885b2b2d0.jsonl");
        std::fs::write(&path, transcript_age::STOP_TAIL).unwrap();
        let written = transcript_age::written_at(&path).unwrap();
        let stop = written - HOOKS_LAND;
        assert!(matches!(
            observe(DECLARED, Some(stop), Some(&path), written + WINDOW),
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
            observe(DECLARED, Some(stop), Some(&path), written + 10 * WINDOW),
            Evidence::Resumed {
                silent_ms: 10 * WINDOW
            }
        );

        // The resumed turn ended too, and the box never heard its stop: the
        // stop records after it are that turn's end, and silence starts there.
        let ended = transcript_age::STOP_TAIL.lines().last().unwrap();
        std::fs::write(&path, format!("{resumed}{ended}\n")).unwrap();
        let written = transcript_age::written_at(&path).unwrap();
        assert_eq!(
            observe(DECLARED, Some(stop), Some(&path), written + MIN),
            Evidence::Recent { silent_ms: MIN }
        );
        assert!(matches!(
            observe(DECLARED, Some(stop), Some(&path), written + WINDOW),
            Evidence::Quiet { .. }
        ));
    }

    #[test]
    fn a_write_after_the_stop_that_cannot_be_opened_is_named_as_that() {
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(STOP + HOOKS_LAND),
                None,
                STOP + 3 * WINDOW
            ),
            Evidence::TailUnreadable {
                silent_ms: 3 * WINDOW - HOOKS_LAND
            },
            "nothing was read, so nothing says a turn resumed or that none did"
        );
    }

    #[test]
    fn an_entry_awaiting_a_reply_is_held_inside_the_bound_and_quiet_past_it() {
        let written = STOP + 5 * MIN;
        let entry = Some(Newest::AwaitingReply);
        assert_eq!(
            read(
                DECLARED,
                Some(STOP),
                Some(written),
                entry,
                written + WINDOW - 1
            ),
            Evidence::AwaitingReply {
                silent_ms: WINDOW - 1
            }
        );
        let unanswered = read(DECLARED, Some(STOP), Some(written), entry, written + WINDOW);
        assert_eq!(unanswered, Evidence::Unanswered { silent_ms: WINDOW });
    }

    #[test]
    fn a_tail_that_cannot_be_opened_before_the_stop_is_not_read_at_all() {
        assert_eq!(
            read(DECLARED, Some(STOP), Some(STOP - MIN), None, STOP + WINDOW),
            Evidence::Quiet { silent_ms: WINDOW },
            "a write at or before the stop is no sign of a turn after it, whatever it holds"
        );
    }

    /// ISS-488's notification bare, and ISS-553/554's with the context
    /// Claude Code wrote beside it.
    #[test]
    fn observing_a_notification_nobody_answered() {
        for tail in [
            transcript_age::NOTIFIED_TAIL,
            transcript_age::NOTIFIED_WITH_CONTEXT_TAIL,
        ] {
            let dir = crate::test_scratch::Scratch::new("subagent-end");
            let path = dir.path().join("agent-aa8c118c2d62d166d.jsonl");
            std::fs::write(&path, format!("{}{tail}", transcript_age::STOP_TAIL)).unwrap();
            let written = transcript_age::written_at(&path).unwrap();
            let stop = written - 10 * MIN;
            assert_eq!(
                observe(DECLARED, Some(stop), Some(&path), written + MIN),
                Evidence::AwaitingReply { silent_ms: MIN }
            );
            assert_eq!(
                observe(
                    DECLARED,
                    Some(stop),
                    Some(&path),
                    written + 3 * 24 * 60 * MIN
                ),
                Evidence::Unanswered {
                    silent_ms: 3 * 24 * 60 * MIN
                }
            );
        }
    }
}
