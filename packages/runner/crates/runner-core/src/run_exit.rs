/*
 * When a run session that has finished is allowed to be ended.
 *
 * `master_exit` answers this for a master pane. Nothing answered it for a run
 * pane, and the gap is not symmetric with it: a master is briefed again every
 * sweep, so an idle one is between passes, while a run pane is briefed ONCE
 * and has nothing left to do after its last turn. Alive is therefore evidence
 * of work for a master and evidence of nothing for a run.
 *
 * The beat cannot see the difference — it asserts "this box still holds this
 * run" and never progress — so a finished run pane is beaten forever, core's
 * reaper never fires over it, and the worktree and leases it holds are held by
 * derivation. Measured forge-vm 2026-09-12: 32 of 34 run panes idle, the
 * oldest 22 hours, every one of them beating; sidpeak held 20 slots and 19
 * checkouts against a budget of three.
 *
 * A run pane whose `Stop` was lost reports a turn that never ends, and nothing
 * this daemon registers fires during a turn to age it; its transcript does
 * (`transcript_age`), so the longer window counts from the later of the last
 * hook and the last write, the same rule `job_exit` keeps (ISS-1244).
 */

use std::time::Duration;

use crate::agent_activity::Doing;

pub const RUN_IDLE_BEFORE_EXIT: Duration = Duration::from_secs(15 * 60);

/// Nothing reported and nothing written for this long, by a turn whose end
/// never arrived or by a lead awaiting a child with no reported end.
/// `job_exit::SILENT_BEFORE_ABANDONED`'s window and its price: a single tool
/// call that writes nothing for this long is ended with the run.
pub const RUN_SILENT_BEFORE_EXIT: Duration = Duration::from_secs(60 * 60);

/// What a run's own session last reported about itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub doing: Doing,
    /// The last turn boundary this session reported, in wall-clock ms.
    pub at: i64,
    /// The newest write this box can read to the session's own transcript,
    /// `None` where it can read none.
    pub written_at: Option<i64>,
}

/// Why a run pane is being kept, or why it may be ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Stay(StayReason),
    Exit(ExitCause),
}

/// What ended a run, carried to the words the box says about it, so a run
/// ended on a silent transcript is never reported as one that went idle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExitCause {
    /// Its turn ended and nothing followed for `RUN_IDLE_BEFORE_EXIT`.
    Idle,
    /// Its lead ended over a child with no reported end, and nothing was
    /// reported or written for `RUN_SILENT_BEFORE_EXIT`.
    ChildrenSilent,
    /// Its turn never reported an end, and its transcript was written nothing
    /// for `RUN_SILENT_BEFORE_EXIT`.
    LeadSilent,
}

impl ExitCause {
    /// What core is told, and the journal says, about a run ended for this.
    pub fn reason(self) -> String {
        match self {
            Self::Idle => format!(
                "its agent ended its turn and reported nothing for {}m after — a run is briefed once, so its work is done; the box ended it",
                RUN_IDLE_BEFORE_EXIT.as_secs() / 60
            ),
            Self::ChildrenSilent => format!(
                "its agent ended its turn over a child that never reported an end, and nothing was reported or written for {}m — a child's end reaches the box by a hook that can be lost; the box ended it",
                RUN_SILENT_BEFORE_EXIT.as_secs() / 60
            ),
            Self::LeadSilent => format!(
                "its agent's turn never reported an end and its transcript was written nothing for {}m — a turn's end reaches the box by a hook that can be lost, and a running turn writes as it works; the box ended it",
                RUN_SILENT_BEFORE_EXIT.as_secs() / 60
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StayReason {
    /// A turn is running, or a child of it is.
    Working,
    /// Stopped on a question a human owes an answer to.
    AwaitingPermission,
    /// This session has never reported a boundary, so nothing is known.
    NeverReported,
    /// Idle, but not for long enough yet.
    RecentlyIdle,
    /// The lead ended its turn over a child with no reported end, and not long
    /// enough ago.
    AwaitingChildren,
}

pub fn verdict(reported: Option<Reported>, now: i64) -> Verdict {
    let Some(r) = reported else {
        return Verdict::Stay(StayReason::NeverReported);
    };
    let quiet_for = now.saturating_sub(r.at);
    let silent_for = now.saturating_sub(r.written_at.map_or(r.at, |w| w.max(r.at)));
    let past = |q: i64, w: Duration| q >= w.as_millis() as i64;
    match r.doing {
        // No transcript to read is no evidence, and never silence.
        Doing::Working if r.written_at.is_none() => Verdict::Stay(StayReason::Working),
        Doing::Working if past(silent_for, RUN_SILENT_BEFORE_EXIT) => {
            Verdict::Exit(ExitCause::LeadSilent)
        }
        Doing::Working => Verdict::Stay(StayReason::Working),
        Doing::AwaitingPermission => Verdict::Stay(StayReason::AwaitingPermission),
        Doing::AwaitingChildren if past(silent_for, RUN_SILENT_BEFORE_EXIT) => {
            Verdict::Exit(ExitCause::ChildrenSilent)
        }
        Doing::AwaitingChildren => Verdict::Stay(StayReason::AwaitingChildren),
        Doing::Idle if past(quiet_for, RUN_IDLE_BEFORE_EXIT) => Verdict::Exit(ExitCause::Idle),
        Doing::Idle => Verdict::Stay(StayReason::RecentlyIdle),
    }
}
