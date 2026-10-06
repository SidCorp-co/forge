/*
 * When a job pane that has finished its work stops needing its slot.
 *
 * Core's run verdict answers this for a run pane, and a job pane is the same
 * shape: a pane briefed ONCE has nothing left to do after its last turn, so
 * alive is evidence of nothing. Nothing in
 * `pool_jobs` ever asked it. A job pane's slot was spent on the pane EXISTING
 * and returned only when the pane died, when core disowned the job, or when
 * `turn_evidence` found the agent had never been asked anything — so an agent
 * that took its turn and stopped held a slot until a person noticed.
 *
 * Measured sid-xeon-1 2026-09-23 at `max_job_panes = 2`: two `release_batch`
 * panes at 101 and 80 minutes, 5% and 7% context, $0.29 and $0.68 of spend,
 * both parked at an empty prompt, both heartbeating every minute. Eight bound
 * projects were refused 48 times in two minutes behind them.
 *
 * Liveness is not activity: every signal the fleet had said those two were
 * alive, and none said either was doing anything. So this reads what the
 * agent's own hooks REPORTED it did. `turn_evidence` reads the same record for
 * the question one step earlier — whether a turn ever began at all — and the
 * two stay separate readings because they are separate questions.
 *
 * A hook can be lost, and a lost `Stop` leaves a pane reporting a turn that
 * never ends. Nothing this daemon registers fires while a lead works on tools
 * alone, so the last hook cannot age a live turn; the conversation's own
 * transcript can, because a running turn writes it (`transcript_age`). Every
 * window below that concludes a pane on silence measures that silence from the
 * later of the last hook and the last write (ISS-1244).
 */

use std::time::Duration;

use crate::agent_activity::{Activity, Doing, Event};
use crate::turn_evidence::Watch;

/// Nothing reported since a turn ENDED for this long: the agent is done.
pub const IDLE_BEFORE_FINISHED: Duration = Duration::from_secs(15 * 60);

/// Stopped on a question with nothing written since, for this long: nobody is
/// coming. Nothing on a box answers a job pane, so the wait has no end of its
/// own; the window is short of `IDLE_BEFORE_FINISHED` because it only spares a
/// dialog a hook resolves, or an operator who happens to be attached.
pub const ASKED_BEFORE_STOPPED: Duration = Duration::from_secs(5 * 60);

/// A transcript write this long after the question is the agent moving again,
/// so the question was answered. The slack keeps the write that records the
/// question itself, which can land just after its hook, from reading as one.
pub const ANSWERED_AFTER: Duration = Duration::from_secs(10);

/// Nothing reported and nothing written since a boundary that ended NOTHING for
/// this long. Longer than the one above, because a compaction is the one report
/// `agent_activity` reads as idle while the agent may still be mid-turn behind
/// it.
///
/// The same window bounds a turn whose end never arrived, and a lead that ended
/// its turn over a child with no reported end. Each is kept while its
/// transcript, or a child's, is still being written; the price is a single tool
/// call that writes nothing for the whole window, which is concluded with it.
pub const SILENT_BEFORE_ABANDONED: Duration = Duration::from_secs(60 * 60);

/// A duration as every text about a job pane states it, so the line an
/// operator reads at the ceiling and the reason core is told agree (ISS-1231).
pub fn minutes(ms: i64) -> String {
    format!("{}m", ms.max(0) / 60_000)
}

/// What one job's session last reported about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub doing: Doing,
    /// The event behind `doing`, which separates a turn that ENDED from a
    /// compaction that merely interrupted one.
    pub last_event: Event,
    /// When that event was reported, in wall-clock ms.
    pub at: i64,
    /// Submitted prompts this session has reported. Zero means no turn has
    /// begun, which is `turn_evidence`'s question and not this one.
    pub prompts: u64,
}

impl Reported {
    pub fn of(a: &Activity) -> Self {
        Self {
            doing: a.doing(),
            last_event: a.last_event,
            at: a.last_event_at,
            prompts: a.prompts,
        }
    }

    /// The shape a sweep leaves on a job's record, so the reading survives the
    /// daemon that took it.
    pub fn to_json(self) -> serde_json::Value {
        serde_json::json!({
            "doing": self.doing.wire(),
            "lastEvent": self.last_event.wire(),
            "at": self.at,
            "prompts": self.prompts,
        })
    }

    /// `None` where any field is missing or unreadable: a half-read snapshot is
    /// a session this box knows nothing about, never a finished one.
    pub fn from_json(v: &serde_json::Value) -> Option<Self> {
        Some(Self {
            doing: Doing::from_wire(v.get("doing")?.as_str()?)?,
            last_event: Event::from_wire(v.get("lastEvent")?.as_str()?)?,
            at: v.get("at")?.as_i64()?,
            prompts: v.get("prompts")?.as_u64()?,
        })
    }
}

/// Whether a job pane still needs the slot it is holding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Keep(KeepReason),
    /// The agent's last report ended a turn and nothing followed it.
    Finished {
        quiet_for: i64,
    },
    /// Stopped on a question nothing on this box answers.
    Blocked {
        quiet_for: i64,
    },
    /// A turn ran, the last report ended nothing, and nothing followed it.
    Silent {
        quiet_for: i64,
    },
    /// The lead ended its turn over a child that never reported an end, and
    /// nothing at all followed.
    ChildrenSilent {
        quiet_for: i64,
    },
    /// The last report began a turn, no end ever arrived, and the conversation
    /// has written nothing since.
    LeadSilent {
        quiet_for: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeepReason {
    /// This session has reported nothing, so nothing is known about it.
    Unreported,
    /// It has reported, and no turn has begun.
    NoTurnYet,
    /// A turn is running, or a child of it is, and its transcript says so.
    Working,
    /// The agent's hooks say a turn is running and this box has no transcript
    /// it can read to age that by. Kept, because the claim is not disproved,
    /// and named, because nothing bounds it.
    WorkingUnaged,
    /// A turn ended, and not long enough ago.
    RecentlyEnded,
    /// Stopped on a question, and not long enough ago.
    RecentlyAsked,
    /// The last thing it reported was a compaction, inside the longer window.
    Compacting,
    /// Its lead ended a turn over a child with no reported end, inside the
    /// longer window.
    AwaitingChildren,
}

/// `written_at` is the newest write this box can read to the session's own
/// transcript (`transcript_age::last_written`), `None` where it can read none.
pub fn verdict(
    watch: &Watch,
    reported: Option<Reported>,
    written_at: Option<i64>,
    now: i64,
) -> Verdict {
    let Some(r) = reported else {
        return Verdict::Keep(KeepReason::Unreported);
    };
    // The counter is this daemon's. `Activities` starts empty and a submission
    // is counted where it is REPORTED, so for a pane this box adopted the
    // prompt was delivered, and any submission reported, to a daemon that is
    // gone: zero there is the missing delivery `turn_evidence` declines to
    // read, and not evidence no turn began. Reading it as one held the slot of
    // every adopted pane that finished its turn after the restart, which is the
    // defect this module was written for returning by another door (ISS-1230).
    // So only a pane THIS daemon briefed has its zero believed, and every other
    // one is judged on the boundary its agent did report.
    if r.prompts == 0 && matches!(watch, Watch::Hooked { .. }) {
        return Verdict::Keep(KeepReason::NoTurnYet);
    }
    // Saturating, so a boundary reported in the future — clock skew, or a
    // record written by a box whose clock ran ahead — reads as no time having
    // passed at all and keeps the pane. Every window below is compared
    // inclusively, so the boundary instant itself concludes it.
    let quiet_for = now.saturating_sub(r.at);
    // The longer window reads the agent's latest sign of life, whichever of
    // the two channels carried it: a transcript written after the last hook is
    // a turn still running, and one written before it says nothing newer.
    let silent_for = now.saturating_sub(written_at.map_or(r.at, |w| w.max(r.at)));
    let past = |q: i64, w: Duration| q >= w.as_millis() as i64;
    match r.doing {
        Doing::Working if written_at.is_none() => Verdict::Keep(KeepReason::WorkingUnaged),
        Doing::Working if past(silent_for, SILENT_BEFORE_ABANDONED) => Verdict::LeadSilent {
            quiet_for: silent_for,
        },
        Doing::Working => Verdict::Keep(KeepReason::Working),
        // No hook reports an answer: the turn simply carries on, writing its
        // transcript, so a write after the question is read as one.
        Doing::AwaitingPermission
            if written_at
                .is_some_and(|w| w.saturating_sub(r.at) >= ANSWERED_AFTER.as_millis() as i64) =>
        {
            if past(silent_for, SILENT_BEFORE_ABANDONED) {
                Verdict::LeadSilent {
                    quiet_for: silent_for,
                }
            } else {
                Verdict::Keep(KeepReason::Working)
            }
        }
        Doing::AwaitingPermission if past(quiet_for, ASKED_BEFORE_STOPPED) => {
            Verdict::Blocked { quiet_for }
        }
        Doing::AwaitingPermission => Verdict::Keep(KeepReason::RecentlyAsked),
        Doing::AwaitingChildren if past(silent_for, SILENT_BEFORE_ABANDONED) => {
            Verdict::ChildrenSilent {
                quiet_for: silent_for,
            }
        }
        Doing::AwaitingChildren => Verdict::Keep(KeepReason::AwaitingChildren),
        Doing::Idle if r.last_event == Event::Compacted => {
            if past(silent_for, SILENT_BEFORE_ABANDONED) {
                Verdict::Silent {
                    quiet_for: silent_for,
                }
            } else {
                Verdict::Keep(KeepReason::Compacting)
            }
        }
        Doing::Idle if past(quiet_for, IDLE_BEFORE_FINISHED) => Verdict::Finished { quiet_for },
        Doing::Idle => Verdict::Keep(KeepReason::RecentlyEnded),
    }
}

/// The words a job ended on a question opens with. Core classifies the ending
/// by them (`packages/core/src/pipeline/failure-classifier.ts`), so they are a
/// contract and not prose.
pub const STOPPED_ON_A_QUESTION: &str = "stopped on a question";

impl Verdict {
    /// What core is told where this verdict ends the job. `None` is a keep.
    ///
    /// Each reads differently on purpose: an operator meeting one of these in
    /// a journal has no second source to ask what the pane was doing, and each
    /// wants a different next act.
    pub fn reason(self, pane: &str) -> Option<String> {
        Some(match self {
            Verdict::Keep(_) => return None,
            Verdict::Finished { quiet_for } => format!(
                "the job's pane `{pane}` has reported nothing since its agent ended a turn {} ago — a job pane is briefed once and has nothing left to do after its last turn, so the slot it held was holding a finished agent and not work in flight",
                minutes(quiet_for)
            ),
            Verdict::Blocked { quiet_for } => format!(
                "{STOPPED_ON_A_QUESTION}: the job's pane `{pane}` has waited on a question only a human can answer for {} — nothing on this box answers a job pane's question, so that wait had no end of its own and the slot was holding it",
                minutes(quiet_for)
            ),
            Verdict::Silent { quiet_for } => format!(
                "the job's pane `{pane}` has reported nothing since it compacted {} ago — in that time its agent neither ended a turn nor asked anything, so this box can no longer call the slot work in flight",
                minutes(quiet_for)
            ),
            Verdict::ChildrenSilent { quiet_for } => format!(
                "the job's pane `{pane}` ended its turn over a child it started that never reported an end, and has reported nothing for {} since — a child's end reaches this box by a hook that can be lost, so the slot was holding a claim of work nothing had confirmed in that time",
                minutes(quiet_for)
            ),
            Verdict::LeadSilent { quiet_for } => format!(
                "the job's pane `{pane}` last reported a turn beginning, never reported it ending, and has written nothing to its transcript for {} — a turn's end reaches this box by a hook that can be lost, and a turn still running writes its transcript as it works, so the slot was holding a turn nothing had shown running in that time",
                minutes(quiet_for)
            ),
        })
    }
}

/// What to say about a pane that is holding a slot, for the one line an
/// operator reads when this box can take no more work.
pub fn holding_phrase(
    watch: &Watch,
    reported: Option<Reported>,
    written_at: Option<i64>,
    now: i64,
) -> &'static str {
    match verdict(watch, reported, written_at, now) {
        Verdict::Keep(KeepReason::Unreported) => "its agent has reported nothing",
        Verdict::Keep(KeepReason::NoTurnYet) => "its prompt is delivered and no turn has begun",
        Verdict::Keep(KeepReason::Working) => "working",
        Verdict::Keep(KeepReason::WorkingUnaged) => {
            "working by its own report, with no transcript this box can read to age that claim by"
        }
        Verdict::Keep(KeepReason::RecentlyEnded) => "idle since its turn ended",
        Verdict::Keep(KeepReason::RecentlyAsked) => "stopped on a question a human owes",
        Verdict::Keep(KeepReason::Compacting) => "compacting",
        Verdict::Keep(KeepReason::AwaitingChildren) => {
            "its turn ended over a child that has reported no end"
        }
        Verdict::Finished { .. } => "finished, and this sweep has not let it go yet",
        Verdict::Blocked { .. } => "blocked on a question, and this sweep has not let it go yet",
        Verdict::Silent { .. } => "silent since it compacted, and this sweep has not let it go yet",
        Verdict::ChildrenSilent { .. } => {
            "its turn ended over a child that never reported an end, silent since, and this sweep has not let it go yet"
        }
        Verdict::LeadSilent { .. } => {
            "its turn never reported an end and its transcript has been still since, and this sweep has not let it go yet"
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASKED_AT: i64 = 1_000_000;

    fn asked() -> Reported {
        Reported {
            doing: Doing::AwaitingPermission,
            last_event: Event::PermissionRequested,
            at: ASKED_AT,
            prompts: 1,
        }
    }

    fn after(d: Duration) -> i64 {
        ASKED_AT + d.as_millis() as i64
    }

    #[test]
    fn an_unanswered_question_ends_the_job_at_its_own_window_naming_the_question() {
        let w = Watch::Unhooked;
        let just_short = after(ASKED_BEFORE_STOPPED) - 1;
        assert_eq!(
            verdict(&w, Some(asked()), Some(ASKED_AT), just_short),
            Verdict::Keep(KeepReason::RecentlyAsked)
        );
        let at = after(ASKED_BEFORE_STOPPED);
        let v = verdict(&w, Some(asked()), Some(ASKED_AT), at);
        assert!(matches!(v, Verdict::Blocked { .. }), "{v:?}");
        let reason = v.reason("forge-job-x").unwrap();
        assert!(reason.starts_with(STOPPED_ON_A_QUESTION), "{reason}");
    }

    #[test]
    fn a_write_after_the_question_is_an_answer_and_keeps_the_turn() {
        let w = Watch::Unhooked;
        let wrote = after(ANSWERED_AFTER);
        let now = after(ASKED_BEFORE_STOPPED * 3);
        assert_eq!(
            verdict(&w, Some(asked()), Some(wrote), now),
            Verdict::Keep(KeepReason::Working)
        );
        let long_after = wrote + SILENT_BEFORE_ABANDONED.as_millis() as i64;
        assert!(matches!(
            verdict(&w, Some(asked()), Some(wrote), long_after),
            Verdict::LeadSilent { .. }
        ));
    }

    #[test]
    fn the_write_recording_the_question_itself_is_not_an_answer() {
        let w = Watch::Unhooked;
        let wrote = after(ANSWERED_AFTER) - 1;
        let v = verdict(&w, Some(asked()), Some(wrote), after(ASKED_BEFORE_STOPPED));
        assert!(matches!(v, Verdict::Blocked { .. }), "{v:?}");
    }
}
