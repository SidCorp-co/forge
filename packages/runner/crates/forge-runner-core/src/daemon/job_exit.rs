/*
 * When a job pane that has finished its work stops needing its slot.
 *
 * `run_exit` answers this for a run pane, and its header already states why a
 * job pane is the same shape: a pane briefed ONCE "has nothing left to do
 * after its last turn", so alive is evidence of nothing. Nothing in
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

use crate::daemon::agent_activity::{Activity, Doing, Event};
use crate::daemon::turn_evidence::Watch;

/// Nothing reported since a turn ENDED for this long: the agent is done.
pub const IDLE_BEFORE_FINISHED: Duration = Duration::from_secs(15 * 60);

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
        Doing::AwaitingPermission if past(quiet_for, IDLE_BEFORE_FINISHED) => {
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
                "the job's pane `{pane}` has been stopped on a question only a human can answer for {} — nothing on this box answers a job pane's question, so that wait had no end of its own and the slot was holding it",
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

    const NOW: i64 = 1_800_000_000_000;
    const IDLE: i64 = IDLE_BEFORE_FINISHED.as_millis() as i64;
    const SILENT: i64 = SILENT_BEFORE_ABANDONED.as_millis() as i64;

    /// A pane THIS daemon briefed, which is the watch every case below is
    /// about unless it says otherwise.
    fn hooked() -> Watch {
        Watch::Hooked {
            session_id: "sess-1".into(),
            delivered_at: NOW,
        }
    }

    /// The verdict with no transcript to read, which is what every case below
    /// is about unless it passes a write time of its own.
    fn judge(watch: &Watch, reported: Option<Reported>, now: i64) -> Verdict {
        verdict(watch, reported, None, now)
    }

    fn phrase(watch: &Watch, reported: Option<Reported>, now: i64) -> &'static str {
        holding_phrase(watch, reported, None, now)
    }

    fn reported(doing: Doing, last_event: Event, at: i64) -> Option<Reported> {
        Some(Reported {
            doing,
            last_event,
            at,
            prompts: 1,
        })
    }

    fn ended(at: i64) -> Option<Reported> {
        reported(Doing::Idle, Event::Stopped, at)
    }

    #[test]
    fn a_pane_whose_turn_ended_past_the_window_is_finished() {
        assert_eq!(
            judge(&hooked(), ended(NOW - IDLE - 1), NOW),
            Verdict::Finished {
                quiet_for: IDLE + 1
            }
        );
    }

    #[test]
    fn the_boundary_instant_itself_concludes_the_pane() {
        assert_eq!(
            judge(&hooked(), ended(NOW - IDLE), NOW),
            Verdict::Finished { quiet_for: IDLE }
        );
    }

    #[test]
    fn a_turn_that_ended_a_moment_ago_keeps_its_slot() {
        assert_eq!(
            judge(&hooked(), ended(NOW - IDLE + 1), NOW),
            Verdict::Keep(KeepReason::RecentlyEnded)
        );
    }

    #[test]
    fn a_turn_still_writing_keeps_its_slot_however_long_ago_it_began() {
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::Working, Event::PromptSubmitted, NOW - SILENT * 10),
                Some(NOW - 60_000),
                NOW
            ),
            Verdict::Keep(KeepReason::Working)
        );
    }

    fn began(at: i64) -> Option<Reported> {
        reported(Doing::Working, Event::PromptSubmitted, at)
    }

    #[test]
    fn a_turn_whose_end_was_lost_is_concluded_once_its_transcript_has_been_still_for_the_window() {
        assert_eq!(
            verdict(
                &hooked(),
                began(NOW - SILENT * 72),
                Some(NOW - SILENT * 72),
                NOW
            ),
            Verdict::LeadSilent {
                quiet_for: SILENT * 72
            },
            "three days after a lost Stop the pane must not still read as working (ISS-1244)"
        );
    }

    #[test]
    fn the_boundary_instant_of_a_still_transcript_concludes_the_turn() {
        assert_eq!(
            verdict(&hooked(), began(NOW - SILENT * 3), Some(NOW - SILENT), NOW),
            Verdict::LeadSilent { quiet_for: SILENT }
        );
        assert_eq!(
            verdict(
                &hooked(),
                began(NOW - SILENT * 3),
                Some(NOW - SILENT + 1),
                NOW
            ),
            Verdict::Keep(KeepReason::Working),
            "one millisecond inside the window is a turn still running"
        );
    }

    #[test]
    fn a_hook_newer_than_the_last_write_is_the_sign_of_life_the_window_counts_from() {
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::Working, Event::SubagentStarted, NOW - SILENT + 1),
                Some(NOW - SILENT * 10),
                NOW
            ),
            Verdict::Keep(KeepReason::Working),
            "the later of the two channels is the agent's latest sign of life"
        );
    }

    #[test]
    fn a_working_claim_with_no_transcript_to_read_is_kept_and_says_so() {
        assert_eq!(
            verdict(&hooked(), began(NOW - SILENT * 72), None, NOW),
            Verdict::Keep(KeepReason::WorkingUnaged),
            "no evidence is not silence: concluding here would decide on the absence of an event"
        );
        let said = holding_phrase(&hooked(), began(NOW - SILENT * 72), None, NOW);
        assert!(said.contains("no transcript"), "{said}");
        assert_ne!(
            said,
            holding_phrase(&hooked(), began(NOW), Some(NOW), NOW),
            "an operator must be able to tell a claim this box can age from one it cannot"
        );
    }

    #[test]
    fn a_write_stamped_in_the_future_concludes_no_turn() {
        assert_eq!(
            verdict(&hooked(), began(NOW - SILENT * 72), Some(NOW + SILENT), NOW),
            Verdict::Keep(KeepReason::Working)
        );
    }

    #[test]
    fn a_write_time_no_clock_could_have_produced_does_not_panic_the_sweep() {
        assert!(matches!(
            verdict(&hooked(), began(i64::MIN), Some(i64::MIN), NOW),
            Verdict::LeadSilent { .. }
        ));
        assert_eq!(
            verdict(&hooked(), began(i64::MIN), Some(i64::MAX), NOW),
            Verdict::Keep(KeepReason::Working)
        );
    }

    #[test]
    fn an_adopted_pane_whose_end_was_lost_is_concluded_on_the_same_window() {
        let adopted = Watch::Adopted {
            session_id: "sess-1".into(),
        };
        let seen_before_the_restart = Some(Reported {
            doing: Doing::Working,
            last_event: Event::PromptSubmitted,
            at: NOW - SILENT * 5,
            prompts: 0,
        });
        assert_eq!(
            verdict(
                &adopted,
                seen_before_the_restart,
                Some(NOW - SILENT * 5),
                NOW
            ),
            Verdict::LeadSilent {
                quiet_for: SILENT * 5
            }
        );
    }

    #[test]
    fn a_lead_awaiting_a_child_that_is_still_writing_keeps_its_slot_past_the_hook_silence() {
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::AwaitingChildren, Event::Stopped, NOW - SILENT * 72),
                Some(NOW - 60_000),
                NOW
            ),
            Verdict::Keep(KeepReason::AwaitingChildren),
            "a background child writing its own transcript is work in flight, not a lost end"
        );
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::AwaitingChildren, Event::Stopped, NOW - SILENT * 72),
                Some(NOW - SILENT),
                NOW
            ),
            Verdict::ChildrenSilent { quiet_for: SILENT }
        );
    }

    #[test]
    fn a_compaction_followed_by_writes_keeps_its_slot_past_the_hook_silence() {
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::Idle, Event::Compacted, NOW - SILENT * 72),
                Some(NOW - 60_000),
                NOW
            ),
            Verdict::Keep(KeepReason::Compacting)
        );
        assert_eq!(
            verdict(
                &hooked(),
                reported(Doing::Idle, Event::Compacted, NOW - SILENT * 72),
                Some(NOW - SILENT),
                NOW
            ),
            Verdict::Silent { quiet_for: SILENT }
        );
    }

    #[test]
    fn a_write_after_a_turn_ended_does_not_move_the_idle_window() {
        assert_eq!(
            verdict(&hooked(), ended(NOW - IDLE), Some(NOW), NOW),
            Verdict::Finished { quiet_for: IDLE },
            "the short window is about a turn that ENDED, which a later write does not undo"
        );
    }

    #[test]
    fn a_failed_turn_ends_a_turn_as_surely_as_a_clean_one() {
        assert_eq!(
            judge(
                &hooked(),
                reported(Doing::Idle, Event::StoppedFailed, NOW - IDLE),
                NOW
            ),
            Verdict::Finished { quiet_for: IDLE }
        );
    }

    #[test]
    fn a_child_closing_over_a_lead_that_stopped_ends_the_work_too() {
        // `doing()` answers `Idle` for these only when the lead's turn has
        // ALSO ended and no other child is left; a lead still mid-turn behind
        // one of them is `Working` and is kept by the arm above.
        for event in [Event::SubagentStopped, Event::TeammateWentIdle] {
            assert_eq!(
                judge(&hooked(), reported(Doing::Idle, event, NOW - IDLE), NOW),
                Verdict::Finished { quiet_for: IDLE },
                "{event:?}"
            );
            assert_eq!(
                verdict(
                    &hooked(),
                    reported(Doing::Working, event, NOW - IDLE * 10),
                    Some(NOW),
                    NOW
                ),
                Verdict::Keep(KeepReason::Working),
                "{event:?}"
            );
        }
    }

    #[test]
    fn a_question_a_human_owes_is_blocked_rather_than_finished() {
        assert_eq!(
            judge(&hooked(),
                reported(
                    Doing::AwaitingPermission,
                    Event::PermissionRequested,
                    NOW - IDLE
                ),
                NOW
            ),
            Verdict::Blocked { quiet_for: IDLE },
            "nothing on this box answers a job pane's question, so unlike a run pane the wait has no end of its own"
        );
    }

    #[test]
    fn a_question_asked_a_moment_ago_keeps_its_slot() {
        assert_eq!(
            judge(
                &hooked(),
                reported(
                    Doing::AwaitingPermission,
                    Event::PermissionRequested,
                    NOW - IDLE + 1
                ),
                NOW
            ),
            Verdict::Keep(KeepReason::RecentlyAsked)
        );
    }

    #[test]
    fn a_compaction_is_not_a_turn_that_ended_and_outlives_the_idle_window() {
        assert_eq!(
            judge(
                &hooked(),
                reported(Doing::Idle, Event::Compacted, NOW - SILENT + 1),
                NOW
            ),
            Verdict::Keep(KeepReason::Compacting),
            "a mid-turn compaction reads as idle while the agent may still be working behind it"
        );
    }

    #[test]
    fn a_pane_silent_since_it_compacted_is_concluded_on_the_longer_window() {
        assert_eq!(
            judge(
                &hooked(),
                reported(Doing::Idle, Event::Compacted, NOW - SILENT),
                NOW
            ),
            Verdict::Silent { quiet_for: SILENT }
        );
    }

    #[test]
    fn a_session_that_has_reported_nothing_is_never_concluded_here() {
        assert_eq!(
            judge(&hooked(), None, NOW),
            Verdict::Keep(KeepReason::Unreported)
        );
    }

    #[test]
    fn a_session_that_reported_without_submitting_belongs_to_the_other_reading() {
        let no_turn = Some(Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: NOW - SILENT * 10,
            prompts: 0,
        });
        assert_eq!(
            judge(&hooked(), no_turn, NOW),
            Verdict::Keep(KeepReason::NoTurnYet),
            "whether a turn ever began is turn_evidence's question, and only it may conclude a pane on that"
        );
    }

    #[test]
    fn a_boundary_reported_in_the_future_concludes_no_pane() {
        for r in [
            ended(NOW + IDLE),
            reported(
                Doing::AwaitingPermission,
                Event::PermissionRequested,
                NOW + IDLE,
            ),
            reported(Doing::Idle, Event::Compacted, NOW + SILENT),
        ] {
            assert!(
                matches!(judge(&hooked(), r, NOW), Verdict::Keep(_)),
                "a clock that ran ahead must not conclude a pane: {r:?}"
            );
        }
    }

    #[test]
    fn a_time_no_clock_could_have_produced_does_not_panic_the_sweep() {
        // A record this box wrote is still a file on a disk somebody else can
        // reach, and `now - i64::MIN` is an overflow panic in a debug build —
        // inside the supervision task, which would take every other job pane's
        // accounting down with it.
        assert!(matches!(
            judge(&hooked(), ended(i64::MIN), NOW),
            Verdict::Finished { .. }
        ));
        assert!(matches!(
            judge(&hooked(), ended(i64::MAX), NOW),
            Verdict::Keep(KeepReason::RecentlyEnded)
        ));
    }

    #[test]
    fn the_five_conclusions_say_five_different_things() {
        let reasons: Vec<String> = [
            Verdict::Finished { quiet_for: 60_000 },
            Verdict::Blocked { quiet_for: 60_000 },
            Verdict::Silent { quiet_for: 60_000 },
            Verdict::ChildrenSilent { quiet_for: 60_000 },
            Verdict::LeadSilent { quiet_for: 60_000 },
        ]
        .into_iter()
        .map(|v| {
            v.reason("forge-job-abc")
                .expect("a conclusion names itself")
        })
        .collect();
        for r in &reasons {
            assert!(r.contains("forge-job-abc"), "{r}");
            assert!(r.contains("1m"), "the unit the at-bound line states: {r}");
        }
        assert!(reasons[0].contains("ended a turn"), "{}", reasons[0]);
        assert!(
            reasons[1].contains("only a human can answer"),
            "{}",
            reasons[1]
        );
        assert!(reasons[2].contains("compacted"), "{}", reasons[2]);
        assert!(
            reasons[3].contains("child") && reasons[3].contains("never reported an end"),
            "{}",
            reasons[3]
        );
        assert!(
            reasons[4].contains("never reported it ending")
                && reasons[4].contains("a hook that can be lost"),
            "{}",
            reasons[4]
        );
        let distinct: std::collections::BTreeSet<&String> = reasons.iter().collect();
        assert_eq!(
            distinct.len(),
            5,
            "an operator meeting one of these has no second source to ask what the pane was doing"
        );
    }

    #[test]
    fn a_keep_tells_core_nothing() {
        assert_eq!(Verdict::Keep(KeepReason::Working).reason("p"), None);
    }

    #[test]
    fn a_snapshot_survives_the_round_trip_a_restart_puts_it_through() {
        let r = Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: NOW,
            prompts: 3,
        };
        assert_eq!(Reported::from_json(&r.to_json()), Some(r));
    }

    #[test]
    fn a_snapshot_missing_any_field_is_a_session_this_box_knows_nothing_about() {
        let whole = Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: NOW,
            prompts: 3,
        }
        .to_json();
        for key in ["doing", "lastEvent", "at", "prompts"] {
            let mut v = whole.clone();
            v.as_object_mut().expect("json object").remove(key);
            assert_eq!(
                Reported::from_json(&v),
                None,
                "a half-read snapshot must not read as a finished pane: {key} removed"
            );
        }
        let mut wrong = whole.clone();
        wrong["doing"] = serde_json::json!("dreaming");
        assert_eq!(Reported::from_json(&wrong), None);
    }

    #[test]
    fn an_adopted_pane_that_ended_a_turn_is_finished_though_this_daemons_counter_reads_zero() {
        let after_a_restart = Some(Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: NOW - IDLE,
            prompts: 0,
        });
        assert_eq!(
            judge(
                &Watch::Adopted {
                    session_id: "sess-1".into()
                },
                after_a_restart,
                NOW
            ),
            Verdict::Finished { quiet_for: IDLE },
            "the submission was counted by the daemon that briefed this pane, so a zero here says nothing about whether a turn ran"
        );
    }

    #[test]
    fn only_a_pane_this_daemon_briefed_has_its_zero_believed() {
        let no_turn = Some(Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: NOW,
            prompts: 0,
        });
        assert_eq!(
            judge(&hooked(), no_turn, NOW),
            Verdict::Keep(KeepReason::NoTurnYet),
            "whether a turn ever began is turn_evidence's question, and it can only answer it for a pane this daemon delivered to"
        );
        assert_eq!(
            judge(&Watch::Unhooked, no_turn, NOW),
            Verdict::Keep(KeepReason::RecentlyEnded),
            "a pane this daemon did not brief is judged on the boundary it reported"
        );
    }

    #[test]
    fn an_adopted_pane_still_mid_turn_is_kept_whatever_the_counter_reads() {
        assert_eq!(
            verdict(
                &Watch::Adopted {
                    session_id: "sess-1".into()
                },
                Some(Reported {
                    doing: Doing::Working,
                    last_event: Event::SubagentStarted,
                    at: NOW - SILENT * 10,
                    prompts: 0,
                }),
                Some(NOW),
                NOW
            ),
            Verdict::Keep(KeepReason::Working)
        );
    }

    #[test]
    fn what_holds_a_slot_reads_differently_in_every_state() {
        let phrases = [
            phrase(&hooked(), None, NOW),
            phrase(&hooked(), ended(NOW), NOW),
            phrase(&hooked(), ended(NOW - IDLE), NOW),
            phrase(
                &hooked(),
                reported(Doing::Working, Event::PromptSubmitted, NOW),
                NOW,
            ),
        ];
        let distinct: std::collections::BTreeSet<&&str> = phrases.iter().collect();
        assert_eq!(distinct.len(), 4, "{phrases:?}");
    }

    fn awaiting(at: i64) -> Option<Reported> {
        reported(Doing::AwaitingChildren, Event::Stopped, at)
    }

    #[test]
    fn a_lead_that_ended_over_an_unreported_child_keeps_its_slot_inside_the_longer_window() {
        assert_eq!(
            judge(&hooked(), awaiting(NOW - SILENT + 1), NOW),
            Verdict::Keep(KeepReason::AwaitingChildren),
            "a background child may still be working behind a lead that stopped"
        );
        assert_eq!(
            judge(&hooked(), awaiting(NOW - IDLE), NOW),
            Verdict::Keep(KeepReason::AwaitingChildren),
            "the idle window is for a turn with nothing behind it, not this"
        );
    }

    #[test]
    fn a_lead_that_ended_over_an_unreported_child_is_concluded_at_the_longer_window() {
        assert_eq!(
            judge(&hooked(), awaiting(NOW - SILENT), NOW),
            Verdict::ChildrenSilent { quiet_for: SILENT },
            "a child's end that never arrived must not hold a job slot for the life of the pane (ISS-1232)"
        );
        assert_eq!(
            judge(&hooked(), awaiting(NOW - SILENT * 72), NOW),
            Verdict::ChildrenSilent {
                quiet_for: SILENT * 72
            },
            "three days on it is still concluded, never kept as working"
        );
    }

    #[test]
    fn an_adopted_pane_awaiting_a_child_is_judged_on_the_same_window() {
        let adopted = Watch::Adopted {
            session_id: "sess-1".into(),
        };
        let r = Some(Reported {
            doing: Doing::AwaitingChildren,
            last_event: Event::Stopped,
            at: NOW - SILENT,
            prompts: 0,
        });
        assert_eq!(
            judge(&adopted, r, NOW),
            Verdict::ChildrenSilent { quiet_for: SILENT }
        );
    }

    #[test]
    fn a_pane_awaiting_a_child_never_reads_as_working_at_the_ceiling() {
        for at in [NOW, NOW - IDLE, NOW - SILENT, NOW - SILENT * 72] {
            let phrase = phrase(&hooked(), awaiting(at), NOW);
            assert_ne!(phrase, "working", "at {at}");
            assert!(phrase.contains("child"), "{phrase}");
        }
        assert_ne!(
            phrase(&hooked(), awaiting(NOW), NOW),
            phrase(&hooked(), awaiting(NOW - SILENT), NOW),
            "inside and past the window are two different next acts"
        );
    }

    #[test]
    fn a_snapshot_awaiting_a_child_survives_the_round_trip_a_restart_puts_it_through() {
        let r = Reported {
            doing: Doing::AwaitingChildren,
            last_event: Event::Stopped,
            at: NOW,
            prompts: 1,
        };
        assert_eq!(r.to_json()["doing"], "awaiting_children");
        assert_eq!(Reported::from_json(&r.to_json()), Some(r));
    }

    #[test]
    fn a_duration_reads_in_whole_minutes() {
        assert_eq!(minutes(0), "0m");
        assert_eq!(minutes(59_999), "0m");
        assert_eq!(minutes(6_060_000), "101m");
        assert_eq!(minutes(-5), "0m", "a clock that ran ahead reads as no time");
        assert_eq!(minutes(i64::MAX), format!("{}m", i64::MAX / 60_000));
    }
}
