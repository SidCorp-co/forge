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
//! pane and the next build adopts it (ISS-1379). Nor does it say when a
//! silence is long enough to call the subagent over: that bound is core's
//! (`devices/run-verdict.ts:subagentOver`), which the box reports this to.

use std::path::Path;

use crate::ledger::Run;
use crate::transcript_age::{self, Newest};

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
    /// `silent_ms` ago, and no reply has followed yet.
    AwaitingReply { silent_ms: i64 },
    /// A turn ended `silent_ms` ago and nothing but that stop's own hook
    /// records was written after it. It may still be resumed, so this ends
    /// nothing.
    TurnEnded { silent_ms: i64 },
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
    Evidence::TurnEnded {
        silent_ms: now.saturating_sub(stop.max(written)),
    }
}

impl Evidence {
    /// The evidence as core's `RUN_SUBAGENT_EVIDENCE` names it, and its silence
    /// in ms: since the run was declared for `no_turn_end`, none for `unreadable`.
    pub fn wire(self) -> (&'static str, Option<u64>) {
        let ms = |v: i64| Some(u64::try_from(v).unwrap_or(0));
        match self {
            Self::NoTurnEnd { since_ms } => ("no_turn_end", ms(since_ms)),
            Self::HostEnded { silent_ms } => ("host_ended", ms(silent_ms)),
            Self::Resumed { silent_ms } => ("resumed", ms(silent_ms)),
            Self::AwaitingReply { silent_ms } => ("awaiting_reply", ms(silent_ms)),
            Self::TurnEnded { silent_ms } => ("turn_ended", ms(silent_ms)),
            Self::Unreadable => ("unreadable", None),
            Self::TailUnreadable { silent_ms } => ("tail_unreadable", ms(silent_ms)),
        }
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

/// The value the box writes to `kept_notice` when core has it say why it keeps
/// a run in this state, or `None` for the states it says nothing about.
/// Recovery's other notices share the column, so none of them may be one of
/// these (`recovery::tests::no_two_writers_of_kept_notice_share_a_value`).
pub fn notice(evidence: Evidence) -> Option<&'static str> {
    match evidence {
        Evidence::NoTurnEnd { .. } | Evidence::Resumed { .. } => None,
        Evidence::TurnEnded { .. } => Some("quiet"),
        Evidence::AwaitingReply { .. } => Some("no-reply"),
        Evidence::HostEnded { .. } => Some("host-ended"),
        Evidence::Unreadable | Evidence::TailUnreadable { .. } => Some("unreadable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR_MS: i64 = 60 * 60 * 1000;

    /// The box reads no bound: a turn ended hours ago and one ended a second
    /// ago are the same evidence with a different silence, and core decides
    /// which is over (`devices/run-verdict.ts:subagentOver`).
    #[test]
    fn evidence_carries_its_silence_and_no_verdict() {
        let now = 10 * HOUR_MS;
        let long = read(
            0,
            Some(now - 3 * HOUR_MS),
            Some(now - 3 * HOUR_MS),
            None,
            now,
        );
        assert_eq!(long.wire(), ("turn_ended", Some(3 * 3_600_000)));
        let short = read(0, Some(now - 1000), Some(now - 1000), None, now);
        assert_eq!(short.wire(), ("turn_ended", Some(1000)));
        let handed = read(
            0,
            Some(now - 3 * HOUR_MS),
            Some(now - 2 * HOUR_MS),
            Some(Newest::AwaitingReply),
            now,
        );
        assert_eq!(handed.wire(), ("awaiting_reply", Some(2 * 3_600_000)));
        assert_eq!(read(0, None, None, None, now).wire().0, "no_turn_end");
    }
}
