/*
 * When a job pane this box has never heard from stops holding a slot.
 *
 * Two readings can free a job slot and each one wants evidence. `turn_evidence`
 * concludes a pane whose agent never submitted the prompt this box delivered,
 * and declines for any watch that is not `Hooked`, because the delivery whose
 * silence it measures belongs to a daemon that is gone. `job_exit` concludes a
 * pane whose agent reported a boundary, and declines where there is neither a
 * report nor a snapshot, because a session it has never heard from is one it
 * knows nothing about. Both declines are right, and between them nothing is
 * left: measured against `forge-runner-core` at `runner-v0.17.11`, a pane
 * adopted with a session and no snapshot survived two hundred supervision
 * ticks still holding its slot, and would have held it for the rest of that
 * pane's life (ISS-1230).
 *
 * So this is the reading for the pane neither of them can answer for, and it
 * measures the one thing left to measure: how long this box has been able to
 * hear from the pane and has heard nothing at all. That silence is not
 * evidence the agent failed and this does not claim it is — it is the box
 * saying it cannot account for the pane, and a pane no reading will ever
 * conclude may not spend a slot until it dies.
 */

use std::time::Duration;

use crate::daemon::job_exit;

/// Nothing whatever reported since this daemon began watching the pane.
///
/// It is the longest of the finite windows, and deliberately not shorter than
/// any of them: `turn_evidence` waits two minutes because it knows when the
/// prompt was delivered, `job_exit` fifteen because it knows a turn ended, and
/// this reading knows neither. The hour is the one `job_exit` already spends on
/// the ambiguity of exactly this shape — an agent that may still be mid-turn
/// behind a report this box cannot interpret — because that is the case this
/// window can be wrong about: a pane whose agent submitted its prompt inside
/// the sweep that the restart interrupted, and which is genuinely working.
pub const UNHEARD_BEFORE_ABANDONED: Duration = Duration::from_secs(60 * 60);

/// Whether a job pane this box knows nothing about may still hold its slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Something is known about the pane, or knowing nothing about it has not
    /// yet gone on long enough to mean anything.
    Keep,
    /// This box has been able to hear from the pane for this long, in ms, and
    /// has heard nothing whatever.
    Unheard { unheard_for: i64 },
}

/// `seen` is everything this box knows about the pane's agent: what the session
/// has reported to THIS daemon, and otherwise the snapshot a previous one's
/// sweep left. `watching_since` is when this daemon began counting the pane,
/// which for one it adopted is the adoption.
pub fn verdict(seen: Option<job_exit::Reported>, watching_since: i64, now: i64) -> Verdict {
    if seen.is_some() {
        return Verdict::Keep;
    }
    // A stamp at or before the epoch is not one `agent_activity::now_ms` could
    // have produced, so it is not a measurement of anything and no pane is
    // concluded on it. That leaves a box whose clock cannot be read holding its
    // slots, which is the honest answer: with no clock this reading cannot
    // measure silence, and guessing at the age of one is how a pane that was
    // working gets ended.
    if watching_since <= 0 {
        return Verdict::Keep;
    }
    // Saturating, so a stamp from a clock that ran ahead reads as no time
    // having passed and keeps the pane, rather than overflowing inside the
    // supervision task and taking every other job pane's accounting with it.
    let unheard_for = now.saturating_sub(watching_since);
    if unheard_for >= UNHEARD_BEFORE_ABANDONED.as_millis() as i64 {
        Verdict::Unheard { unheard_for }
    } else {
        Verdict::Keep
    }
}

impl Verdict {
    /// What core is told where this verdict ends the job. `None` is a keep.
    ///
    /// It names what was missing rather than what the agent did, because
    /// nothing here knows what the agent did. An operator meeting this has to
    /// be able to tell it from the three `job_exit` writes, each of which
    /// reports something the agent itself said.
    pub fn reason(self, pane: &str) -> Option<String> {
        let Verdict::Unheard { unheard_for } = self else {
            return None;
        };
        Some(format!(
            "the job's pane `{pane}` has told this box nothing whatever in the {} since this daemon began watching it — no turn reported, no boundary, and no snapshot from the daemon before it — so no reading this box has could ever have concluded it, and the slot it held was accounted for by nothing",
            job_exit::minutes(unheard_for)
        ))
    }
}

/// What to say about such a pane in the one line an operator reads when this
/// box can take no more work, beside `job_exit::holding_phrase`'s answers for
/// the panes something IS known about.
pub const HOLDING_PHRASE: &str = "never heard from, and this sweep has not let it go yet";
