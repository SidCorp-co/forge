/*
 * Whether a job's agent was ever asked anything.
 *
 * A job's brief is its agent's launch prompt, and a master's is pasted by
 * `terminal::send_line` with `Enter` sent as a separate call. Neither
 * is a turn: tmux reports success for a keystroke it ACCEPTED, a started
 * process says nothing about a prompt it read, and a pane emits no turn
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
        "the job's pane `{pane}` was opened and its prompt delivered, but the agent never reported submitting it, or anything else, in {} — tmux accepted the keystroke and no turn ever began, so this box never had work in flight to report",
        crate::job_exit::minutes(silent_for)
    )
}
