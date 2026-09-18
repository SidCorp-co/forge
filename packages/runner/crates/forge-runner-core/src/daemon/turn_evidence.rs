/*
 * Whether a job's agent was ever asked anything.
 *
 * `terminal::send_line` pastes a prompt and sends `Enter` as a separate call.
 * tmux reports success for a keystroke it ACCEPTED, and a pane emits no turn
 * boundary, so "delivered" has never been able to mean "a turn ran" — and the
 * beat in `pool_jobs::supervise` asserted `running` off nothing but that
 * delivery. Measured sid-desk 2026-09-18: a `release_batch` read `running` for
 * thirty-one minutes at $0.00 spend with the whole release prompt sitting
 * unsubmitted in the pane's composer, its heartbeat refreshing every fifty
 * seconds, four issues at `releasing`, and no reader anywhere able to tell it
 * from a batch that was deploying. One `Enter` and it began working.
 *
 * So the box stops asserting what it cannot see. The agent's own
 * `UserPromptSubmit` is the only evidence a turn began — `agent_activity`
 * exists for exactly that — and this is the reading of it: what the box did
 * (delivered) and what the agent did (submitted) stay two facts, and the beat
 * carries whichever one is true.
 */

use std::time::Duration;

/// How long a job may be silent before this box says its agent never started.
// cm:guard a fifth of the ten minutes `packages/core/src/devices/run-session-reaper.ts` allows a silent run, and it is bounded on BOTH sides. Below one `POOL_SUPERVISE_INTERVAL` the verdict is decided by scheduling jitter rather than by the agent; above core's own three-minute heartbeat hop (`jobs/loop-monitor.ts`) core would infer something vaguer first and this box's named reason would never be the one on the record. Thirty-one minutes of a dead release is the failure being fixed, not the budget.
pub const FIRST_TURN_WINDOW: Duration = Duration::from_secs(120);

/// What this box did to make one job pane's turns reportable.
// cm:guard the two arms are NOT "hooked" and "not yet hooked" — they are "silence means something" and "silence means nothing", and every caller reads them that way. A pane this box could not hook reports nothing for the same reason a pane whose agent is hard at work reports nothing, and the two are indistinguishable from outside. `run_exit::StayReason::NeverReported` refuses the same collapse for the run lane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Watch {
    /// Hooks registered in the pane's cwd and a capability minted for this
    /// session, so silence from it is evidence.
    Hooked {
        /// The session the pane's hooks report under.
        session_id: String,
        /// When this box delivered the prompt, in wall-clock ms.
        delivered_at: i64,
    },
    /// No channel to this pane, so nothing may be concluded from its silence.
    Unhooked,
}

impl Watch {
    /// The session whose reports answer for this job, if any do.
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Hooked { session_id, .. } => Some(session_id),
            Self::Unhooked => None,
        }
    }
}

/// What one session has told this box about itself, narrowed to what decides
/// this question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    /// How many prompts it has reported submitting.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/agent_activity.rs — this is `Activity::prompts` and carries its name on purpose: the word is `UserPromptSubmit`'s own, a submitted prompt is EVIDENCE a turn began rather than a count of turns, and ISS-1096 built this same field as `turns` in the same week as ISS-1100 before dropping the name.
    pub prompts: u64,
}

/// What the box knows about one job's turns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Evidence {
    /// The agent reported a submitted prompt: a turn ran.
    Running,
    /// The prompt was delivered and no turn has been reported.
    Delivered,
    /// The prompt was delivered, the window has run out, and the session has
    /// reported nothing whatever.
    NeverStarted {
        /// How long this box has had nothing at all from it, in ms.
        silent_for: i64,
    },
    /// This box has no evidence channel to that pane, so it knows nothing.
    Unproven,
}

impl Evidence {
    /// The `runtimeState` this reading beats as, or `None` where the box has
    /// nothing to report about the process at all.
    // cm:edge contract -> packages/core/src/db/schema.ts — `sessionRuntimeStates` is the closed set `jobs/events-routes.ts:runtimeStateOf` matches against, and a word outside it is DROPPED in silence rather than refused. `starting` was a member no runner had ever sent; `working` is what the dispatch lane sends for the same fact.
    // cm:guard `Unproven` reports NO state, and the absence is the answer rather than a gap: `schema.ts` states that a NULL `runtime_state` means "this runner never reported, infer nothing", which is exactly what a box that could not hook the pane knows. Sending `starting` there would assert an absence of work this box cannot see, and sending `working` is the lie this module exists to end.
    pub fn runtime_state(self) -> Option<&'static str> {
        match self {
            Self::Running => Some("working"),
            Self::Delivered | Self::NeverStarted { .. } => Some("starting"),
            Self::Unproven => None,
        }
    }
}

/// Read one job's turn evidence from what its session reported and the clock.
///
/// `reported` is `None` where the session has never reported anything at all.
// cm:guard an `Unhooked` job is `Unproven` BEFORE the clock is consulted, and that order is the whole safety of this function. Every pool job on every box was unhooked until this change, so a reading that reached the window first would fail every healthy release on the fleet at the two-minute mark — inert in the dangerous direction, and green, because no test that only drives the hooked path can see it.
// cm:guard `NeverStarted` needs TOTAL silence and not merely `prompts == 0`, and the gap between the two is a real false positive rather than pedantry: `cmd/hook.rs` discards a report it could not deliver and never retries, by design, so one lost `UserPromptSubmit` frame would otherwise kill a release that was working. None of the eight events `agent_activity` knows can be emitted by a pane holding an unsubmitted prompt, so ANY report is proof the channel carries frames and the agent is past its composer — which is not proof a turn ran, and so is not `Running` either.
// cm:guard a `delivered_at` in the FUTURE reads as just-delivered rather than as an elapsed age, the same skew rule `run_exit::verdict` states: the stamp is this box's own clock, but a clock stepped backwards between the delivery and the tick would otherwise subtract to a huge silence and fail a release that had just started.
pub fn read(watch: &Watch, reported: Option<Reported>, now: i64) -> Evidence {
    let Watch::Hooked { delivered_at, .. } = watch else {
        return Evidence::Unproven;
    };
    match reported {
        Some(r) if r.prompts > 0 => Evidence::Running,
        Some(_) => Evidence::Delivered,
        None => {
            let silent_for = now.saturating_sub(*delivered_at);
            if silent_for >= FIRST_TURN_WINDOW.as_millis() as i64 {
                Evidence::NeverStarted { silent_for }
            } else {
                Evidence::Delivered
            }
        }
    }
}

/// What this box tells core about a job whose agent was never asked anything.
// cm:guard the failure names the CONDITION and not a timeout, because the two call for opposite actions: a timeout invites a longer window, and this invites somebody to look at why the `Enter` did not submit. It is also why nothing here re-sends — a prompt that DID arrive would then arrive twice, and a second release prompt in a pane already releasing is worse than the silence.
pub fn never_started_reason(pane: &str, silent_for: i64) -> String {
    format!(
        "the job's pane `{pane}` was opened and its prompt delivered, but the agent never reported submitting it, or anything else, in {}s — tmux accepted the keystroke and no turn ever began, so this box never had work in flight to report",
        silent_for / 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const WINDOW: i64 = FIRST_TURN_WINDOW.as_millis() as i64;

    fn hooked(delivered_at: i64) -> Watch {
        Watch::Hooked {
            session_id: "sess-1".into(),
            delivered_at,
        }
    }

    fn prompts(n: u64) -> Option<Reported> {
        Some(Reported { prompts: n })
    }

    // cm:guard THE case: the prompt is in the composer, tmux accepted the keystroke, and the session
    // has reported nothing. This is the thirty-one minutes ISS-1096 measured, and it must not read
    // as a running turn at any point past the window.
    #[test]
    fn a_delivered_prompt_no_agent_ever_submitted_is_never_started() {
        assert_eq!(
            read(&hooked(NOW - WINDOW), None, NOW),
            Evidence::NeverStarted { silent_for: WINDOW }
        );
    }

    #[test]
    fn one_submitted_prompt_is_a_turn_however_long_ago_it_was() {
        assert_eq!(
            read(&hooked(NOW - WINDOW * 100), prompts(1), NOW),
            Evidence::Running
        );
    }

    // cm:guard the reading that keeps a long release alive: the turn ENDED, so `turn_started_at` is
    // None and `doing()` is `Idle` — and a reader that asked either of those would fail a job whose
    // agent is between turns. The count is what survives the boundary.
    #[test]
    fn a_turn_that_ended_is_still_evidence_a_turn_ran() {
        assert_eq!(
            read(&hooked(NOW - WINDOW * 10), prompts(3), NOW),
            Evidence::Running
        );
    }

    // cm:guard the false positive `cmd/hook.rs` makes possible, and the reason `NeverStarted` asks
    // for total silence: a working agent whose first `UserPromptSubmit` frame was dropped has
    // `prompts == 0` and is still reporting. Killing it would be this module doing the very thing it
    // exists to prevent, in the other direction.
    #[test]
    fn a_session_reporting_with_no_counted_submission_is_never_killed() {
        assert_eq!(
            read(&hooked(NOW - WINDOW * 100), prompts(0), NOW),
            Evidence::Delivered
        );
    }

    #[test]
    fn inside_the_window_a_silent_pane_is_only_delivered() {
        assert_eq!(
            read(&hooked(NOW - WINDOW + 1), None, NOW),
            Evidence::Delivered
        );
    }

    #[test]
    fn the_boundary_itself_is_never_started() {
        assert!(matches!(
            read(&hooked(NOW - WINDOW), None, NOW),
            Evidence::NeverStarted { .. }
        ));
    }

    // cm:guard the direction that would have broken the fleet. Every pool job on every box was
    // unhooked before this change, and a reading that reached the clock first would fail all of
    // them — so an unhooked job silent for a day is still `Unproven` and nothing acts on it.
    #[test]
    fn an_unhooked_pane_silent_for_a_day_is_unproven_and_not_never_started() {
        let a_day = 24 * 60 * 60 * 1000;
        assert_eq!(read(&Watch::Unhooked, None, NOW + a_day), Evidence::Unproven);
    }

    #[test]
    fn a_clock_stepped_backwards_does_not_fail_a_fresh_delivery() {
        assert_eq!(read(&hooked(NOW + WINDOW), None, NOW), Evidence::Delivered);
    }

    // cm:guard `working` is reachable from exactly ONE of the four readings, and `Unproven` reports
    // nothing at all. This is the assertion that goes red if anybody widens a reading back onto the
    // word the beat used to carry unconditionally.
    #[test]
    fn only_a_reported_turn_beats_as_working() {
        let states = [
            read(&hooked(NOW), prompts(1), NOW).runtime_state(),
            read(&hooked(NOW), None, NOW).runtime_state(),
            read(&hooked(NOW - WINDOW), None, NOW).runtime_state(),
            read(&Watch::Unhooked, None, NOW).runtime_state(),
        ];
        assert_eq!(
            states,
            [Some("working"), Some("starting"), Some("starting"), None]
        );
    }

    // cm:guard the window is bounded on BOTH sides, and the test is the bound rather than the
    // sentence on the constant: shorter than a supervision tick and the verdict is decided by
    // scheduling jitter, longer than a fifth of core's ten-minute run-session reaper and the box is
    // slower to name this than core is to infer something else.
    #[test]
    fn the_window_sits_between_one_tick_and_a_fifth_of_cores_reaper() {
        let core_run_session_timeout = Duration::from_secs(10 * 60);
        assert!(FIRST_TURN_WINDOW >= crate::daemon::POOL_SUPERVISE_INTERVAL);
        assert!(FIRST_TURN_WINDOW * 5 <= core_run_session_timeout);
    }

    #[test]
    fn the_reason_names_the_unsubmitted_prompt_and_the_pane() {
        let reason = never_started_reason("forge-job-abc", 125_000);
        assert!(reason.contains("forge-job-abc"), "{reason}");
        assert!(reason.contains("never reported submitting"), "{reason}");
        assert!(reason.contains("125s"), "{reason}");
    }
}
