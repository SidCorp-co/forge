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

pub const FIRST_TURN_WINDOW: Duration = Duration::from_secs(120);

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
    /// A pane this daemon adopted rather than opened. Its hooks still report
    /// under `session_id` — the token map is on disk for exactly this — but
    /// the delivery whose silence this module measures belongs to a daemon
    /// that is gone, so nothing here may be concluded from its silence.
    Adopted { session_id: String },
    /// No channel to this pane, so nothing may be concluded from its silence.
    Unhooked,
}

impl Watch {
    /// The session whose reports answer for this job, if any do.
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Hooked { session_id, .. } | Self::Adopted { session_id } => Some(session_id),
            Self::Unhooked => None,
        }
    }
}

/// What one session has told this box about itself, narrowed to what decides
/// this question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
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
    pub fn runtime_state(self) -> Option<&'static str> {
        match self {
            Self::Running => Some("working"),
            Self::Delivered | Self::NeverStarted { .. } => Some("starting"),
            Self::Unproven => None,
        }
    }
}

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

    #[test]
    fn a_turn_that_ended_is_still_evidence_a_turn_ran() {
        assert_eq!(
            read(&hooked(NOW - WINDOW * 10), prompts(3), NOW),
            Evidence::Running
        );
    }

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

    #[test]
    fn an_unhooked_pane_silent_for_a_day_is_unproven_and_not_never_started() {
        let a_day = 24 * 60 * 60 * 1000;
        assert_eq!(
            read(&Watch::Unhooked, None, NOW + a_day),
            Evidence::Unproven
        );
    }

    #[test]
    fn an_adopted_pane_is_unproven_here_however_long_it_has_been_quiet() {
        let a_day = 24 * 60 * 60 * 1000;
        assert_eq!(
            read(
                &Watch::Adopted {
                    session_id: "sess-1".into()
                },
                None,
                NOW + a_day
            ),
            Evidence::Unproven,
            "the delivery whose silence this measures was a previous daemon's, so this reading has nothing to measure from"
        );
    }

    #[test]
    fn an_adopted_pane_names_the_session_its_hooks_report_under() {
        assert_eq!(
            Watch::Adopted {
                session_id: "sess-1".into()
            }
            .session_id(),
            Some("sess-1"),
            "job_exit reads that session, which is the whole point of keeping it across a restart"
        );
    }

    #[test]
    fn a_clock_stepped_backwards_does_not_fail_a_fresh_delivery() {
        assert_eq!(read(&hooked(NOW + WINDOW), None, NOW), Evidence::Delivered);
    }

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
