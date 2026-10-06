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

use crate::ledger::Run;
use crate::transcript_age::{self, Newest};

/// Silence after a turn-end past which a subagent run reads as quiet: the
/// hour core's run verdict also waits before it calls a silent run over.
pub const SUBAGENT_QUIET: Duration = Duration::from_secs(60 * 60);

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
