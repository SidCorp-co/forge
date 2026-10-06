//! What a session's OWN hooks say it is doing.
//!
//! Everything else this daemon knows about a pane it learned by writing into
//! it. That is the whole defect: `tmux send-keys` reports that tmux accepted a
//! keystroke, and a pane emits no turn boundary, so "delivered" has never been
//! able to mean "a turn ran". Measured forge-vm 2026-09-10: 16 run panes held
//! an instruction sitting unsubmitted in the composer and every one of them was
//! `delivered`; one more had been stopped on a permission question for hours
//! and read as healthy.
//!
//! So the agent reports instead of being watched. Claude Code hooks call
//! `forge-runner hook` inside the pane, the frame carries the pane's own
//! capability, and this is where the answer lands. A screen read cannot replace
//! it: the same window renders an idle prompt and a finished turn identically.

use std::collections::HashMap;
use std::sync::Mutex;

/// Wall-clock milliseconds, for an event whose reporter sent no timestamp.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// One hook event, narrowed to the boundaries a caller can act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Event {
    /// A prompt was submitted and a turn began.
    PromptSubmitted,
    /// The turn ended.
    Stopped,
    StoppedFailed,
    /// Stopped on a question only a human can answer.
    PermissionRequested,
    /// A child agent started.
    SubagentStarted,
    /// A child agent finished.
    SubagentStopped,
    TeammateWentIdle,
    Compacted,
}

impl Event {
    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "UserPromptSubmit" => Self::PromptSubmitted,
            "Stop" => Self::Stopped,
            "StopFailure" => Self::StoppedFailed,
            "PermissionRequest" => Self::PermissionRequested,
            "SubagentStart" => Self::SubagentStarted,
            "SubagentStop" => Self::SubagentStopped,
            "TeammateIdle" => Self::TeammateWentIdle,
            "PostCompact" => Self::Compacted,
            _ => return None,
        })
    }

    pub fn wire(self) -> &'static str {
        match self {
            Self::PromptSubmitted => "UserPromptSubmit",
            Self::Stopped => "Stop",
            Self::StoppedFailed => "StopFailure",
            Self::PermissionRequested => "PermissionRequest",
            Self::SubagentStarted => "SubagentStart",
            Self::SubagentStopped => "SubagentStop",
            Self::TeammateWentIdle => "TeammateIdle",
            Self::Compacted => "PostCompact",
        }
    }

    /// Every event this daemon registers, in the order it registers them.
    pub const ALL: [Event; 8] = [
        Event::PromptSubmitted,
        Event::Stopped,
        Event::StoppedFailed,
        Event::PermissionRequested,
        Event::SubagentStarted,
        Event::SubagentStopped,
        Event::TeammateWentIdle,
        Event::Compacted,
    ];
}

#[derive(Debug, Clone, Copy)]
pub struct Report<'a> {
    pub event: Event,
    pub at: i64,
    /// `agent_id` for a child event; `teammate_name` on `TeammateIdle`. None for a lead event.
    pub subject: Option<&'a str>,
    /// Claude Code's own `session_id` — the conversation, not Forge's session.
    pub conversation: Option<&'a str>,
    /// Claude Code's own `transcript_path`: where this conversation is written
    /// as it runs, which `transcript_age` reads the last write of.
    pub transcript: Option<&'a str>,
}

/// What a session is doing, as the session itself last reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Doing {
    /// A turn is running, or a child of it is.
    Working,
    /// Stopped on a question a human owes an answer to.
    AwaitingPermission,
    /// The lead ended its turn, and a child it started has reported no end.
    ///
    /// Not `Working`: a child's end reaches this box by a hook that can be
    /// lost, and nothing this daemon registers fires while a child works, so a
    /// background child still running and one whose `SubagentStop` never
    /// arrived read identically here. Only silence tells them apart, and how
    /// long a reader waits on it is the reader's policy (ISS-1232).
    AwaitingChildren,
    /// Nothing running, nothing asked.
    Idle,
}

/// One session's reported activity.
#[derive(Debug, Clone)]
pub struct Activity {
    pub last_event: Event,
    pub last_event_at: i64,
    /// When the running turn began. `None` once it has ended.
    pub turn_started_at: Option<i64>,
    pub children: std::collections::BTreeSet<String>,
    /// The conversation these claims belong to (Claude Code's `session_id`).
    pub conversation: Option<String>,
    /// Where that conversation is written, as its hooks last named it. The one
    /// thing here a reader can age while a turn runs, since nothing this
    /// daemon registers fires between a turn's start and its end (ISS-1244).
    pub transcript: Option<String>,
    awaiting_permission: bool,
    /// That the lead's last boundary this daemon saw ENDED its turn. Children
    /// this daemon holds without having seen that are still `Working`: after a
    /// restart the lead may be mid-turn behind them.
    lead_ended: bool,
    /// Bumped by every accepted event, so a caller can prove a NEW turn began
    /// rather than reading a turn that was already running as its own.
    pub sequence: u64,
    pub turn_ended_failed: bool,
    pub prompts: u64,
    /// Turns the lead began, prompted or not. A turn Claude Code starts on its
    /// own — taking up a task notification when a background agent or shell
    /// finishes — fires no `UserPromptSubmit`, so `prompts` never counts it;
    /// it is counted here from the first boundary only a running turn
    /// reports, met after the lead's previous turn ended.
    pub turns: u64,
    /// When the newest turn began, kept after it ends so a reader arriving
    /// after a short turn can still date it: its prompt, or for a turn no
    /// prompt began, the end of the turn before it — the latest instant this
    /// box can prove it began after.
    pub turn_began_at: Option<i64>,
    /// When the lead's last turn ended.
    lead_ended_at: Option<i64>,
}

impl Doing {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::AwaitingPermission => "awaiting_permission",
            Self::AwaitingChildren => "awaiting_children",
            Self::Idle => "idle",
        }
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        Some(match s {
            "working" => Self::Working,
            "awaiting_permission" => Self::AwaitingPermission,
            "awaiting_children" => Self::AwaitingChildren,
            "idle" => Self::Idle,
            _ => return None,
        })
    }
}

impl Activity {
    pub fn doing(&self) -> Doing {
        if self.awaiting_permission {
            return Doing::AwaitingPermission;
        }
        if self.turn_started_at.is_some() {
            return Doing::Working;
        }
        match (self.children.is_empty(), self.lead_ended) {
            (true, _) => Doing::Idle,
            (false, true) => Doing::AwaitingChildren,
            (false, false) => Doing::Working,
        }
    }
}

/// Whether `r` is the first word of a lead turn no prompt began: the lead had
/// ended its last turn, and what arrived is a boundary only a running lead
/// turn reports — its own end, a question it stopped on, or a child it
/// started. A child's question while the lead waits on it is the child's, and
/// a compaction or a child's end begins nothing.
fn began_unprompted(a: &Activity, r: Report<'_>) -> bool {
    if !a.lead_ended || a.turn_started_at.is_some() {
        return false;
    }
    match r.event {
        Event::Stopped | Event::StoppedFailed => r.subject.is_none(),
        Event::PermissionRequested => r.subject.is_none() && a.children.is_empty(),
        Event::SubagentStarted => true,
        Event::PromptSubmitted
        | Event::SubagentStopped
        | Event::TeammateWentIdle
        | Event::Compacted => false,
    }
}

#[derive(Default)]
pub struct Activities(Mutex<HashMap<String, Activity>>);

impl Activities {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record what a session reported, and return its state after it.
    pub fn record(&self, session_id: &str, r: Report<'_>) -> Activity {
        let (event, at) = (r.event, r.at);
        let mut map = self.0.lock().expect("activities poisoned");
        let a = map.entry(session_id.to_string()).or_insert(Activity {
            last_event: event,
            last_event_at: at,
            turn_started_at: None,
            children: std::collections::BTreeSet::new(),
            conversation: None,
            transcript: None,
            awaiting_permission: false,
            lead_ended: false,
            sequence: 0,
            turn_ended_failed: false,
            prompts: 0,
            turns: 0,
            turn_began_at: None,
            lead_ended_at: None,
        });
        if let Some(seen) = r.conversation {
            if a.conversation.as_deref().is_some_and(|had| had != seen) {
                a.turn_started_at = None;
                a.children.clear();
                a.awaiting_permission = false;
                a.lead_ended = false;
                // The old conversation's file ages nothing about this one.
                a.transcript = None;
            }
            a.conversation = Some(seen.to_string());
        }
        // Absolute or not at all: a relative path would be read against the
        // daemon's own cwd, which is nothing to do with the pane.
        if let Some(path) = r
            .transcript
            .filter(|p| std::path::Path::new(p).is_absolute())
        {
            a.transcript = Some(path.to_string());
        }
        a.last_event = event;
        a.last_event_at = at;
        a.sequence += 1;
        if began_unprompted(a, r) {
            a.turns += 1;
            a.turn_began_at = Some(a.lead_ended_at.unwrap_or(at));
            a.lead_ended = false;
        }
        let child_only = a.turn_started_at.is_none() && !a.children.is_empty();
        if child_only
            && !matches!(
                event,
                Event::SubagentStarted | Event::SubagentStopped | Event::TeammateWentIdle
            )
        {
            a.children.clear();
        }
        match event {
            Event::PromptSubmitted => {
                a.turn_started_at = Some(at);
                a.awaiting_permission = false;
                a.lead_ended = false;
                a.prompts += 1;
                a.turns += 1;
                a.turn_began_at = Some(at);
            }
            Event::PermissionRequested => a.awaiting_permission = true,
            Event::Stopped | Event::StoppedFailed | Event::Compacted => {
                a.turn_started_at = None;
                a.awaiting_permission = false;
                a.turn_ended_failed = event == Event::StoppedFailed;
                // A compaction ends nothing, so it leaves the lead where it stood.
                if event != Event::Compacted {
                    a.lead_ended = true;
                    a.lead_ended_at = Some(at);
                }
            }
            Event::SubagentStarted => {
                if let Some(id) = r.subject {
                    a.children.insert(id.to_string());
                }
            }
            Event::SubagentStopped | Event::TeammateWentIdle => {
                if let Some(id) = r.subject {
                    a.children.remove(id);
                }
            }
        }
        a.clone()
    }

    /// What this session last reported, or `None` if it never has.
    pub fn get(&self, session_id: &str) -> Option<Activity> {
        self.0
            .lock()
            .expect("activities poisoned")
            .get(session_id)
            .cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lead(a: &Activities, event: Event, at: i64) -> Activity {
        a.record(
            "s",
            Report {
                event,
                at,
                subject: None,
                conversation: Some("c"),
                transcript: None,
            },
        )
    }

    fn child(a: &Activities, event: Event, at: i64) -> Activity {
        a.record(
            "s",
            Report {
                event,
                at,
                subject: Some("agent-1"),
                conversation: Some("c"),
                transcript: None,
            },
        )
    }

    #[test]
    fn a_turn_no_prompt_began_is_counted_at_its_end_and_dated_after_the_last() {
        let a = Activities::new();
        lead(&a, Event::PromptSubmitted, 1_000);
        lead(&a, Event::Stopped, 2_000);
        let seen = lead(&a, Event::Stopped, 9_000);
        assert_eq!(seen.prompts, 1);
        assert_eq!(seen.turns, 2, "a task-notification turn was not counted");
        assert_eq!(seen.turn_began_at, Some(2_000));
        assert_eq!(seen.doing(), Doing::Idle);
    }

    #[test]
    fn a_child_started_after_the_lead_ended_begins_a_turn_that_is_working() {
        let a = Activities::new();
        lead(&a, Event::PromptSubmitted, 1_000);
        lead(&a, Event::Stopped, 2_000);
        let seen = child(&a, Event::SubagentStarted, 5_000);
        assert_eq!(seen.turns, 2);
        assert_eq!(seen.doing(), Doing::Working);
        let ended = lead(&a, Event::Stopped, 6_000);
        assert_eq!(ended.turns, 2, "one unprompted turn was counted twice");
    }

    #[test]
    fn what_a_waiting_lead_hears_from_its_children_begins_no_turn() {
        let a = Activities::new();
        lead(&a, Event::PromptSubmitted, 1_000);
        child(&a, Event::SubagentStarted, 1_500);
        lead(&a, Event::Stopped, 2_000);
        let asked = child(&a, Event::PermissionRequested, 3_000);
        assert_eq!(asked.turns, 1);
        let gone = child(&a, Event::SubagentStopped, 4_000);
        assert_eq!(gone.turns, 1);
        assert_eq!(lead(&a, Event::Compacted, 4_500).turns, 1);
    }

    #[test]
    fn a_first_stop_heard_from_an_adopted_pane_counts_nothing() {
        let a = Activities::new();
        let seen = lead(&a, Event::Stopped, 2_000);
        assert_eq!(
            seen.turns, 0,
            "a turn begun before this daemon heard the pane was counted as its own"
        );
    }

    #[test]
    fn a_prompted_turn_counts_once_however_it_ends() {
        let a = Activities::new();
        lead(&a, Event::PromptSubmitted, 1_000);
        lead(&a, Event::Compacted, 1_200);
        let seen = lead(&a, Event::StoppedFailed, 2_000);
        assert_eq!((seen.prompts, seen.turns), (1, 1));
        assert_eq!(seen.turn_began_at, Some(1_000));
    }
}
