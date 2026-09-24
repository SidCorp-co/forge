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
        });
        if let Some(seen) = r.conversation {
            if a.conversation.as_deref().is_some_and(|had| had != seen) {
                a.turn_started_at = None;
                a.children.clear();
                a.awaiting_permission = false;
                a.lead_ended = false;
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
            }
            Event::PermissionRequested => a.awaiting_permission = true,
            Event::Stopped | Event::StoppedFailed | Event::Compacted => {
                a.turn_started_at = None;
                a.awaiting_permission = false;
                a.turn_ended_failed = event == Event::StoppedFailed;
                // A compaction ends nothing, so it leaves the lead where it stood.
                a.lead_ended |= event != Event::Compacted;
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

    pub fn forget(&self, session_id: &str) {
        self.0
            .lock()
            .expect("activities poisoned")
            .remove(session_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE: &str = include_str!("agent_activity.rs");

    fn acts() -> Activities {
        Activities::new()
    }

    /// A lead event: no subject, which is what claude actually sends.
    fn lead(event: Event, at: i64) -> Report<'static> {
        Report {
            event,
            at,
            subject: None,
            conversation: None,
            transcript: None,
        }
    }

    /// A child event, naming the child.
    fn child(event: Event, at: i64, id: &str) -> Report<'_> {
        Report {
            event,
            at,
            subject: Some(id),
            conversation: None,
            transcript: None,
        }
    }

    #[test]
    fn a_session_that_never_reported_is_not_idle_but_unknown() {
        assert!(
            acts().get("s1").is_none(),
            "an absent entry must stay absent — answering `Idle` for a pane whose hooks never fired would make an unhooked session indistinguishable from a finished one"
        );
    }

    #[test]
    fn a_submitted_prompt_starts_a_turn_and_a_stop_ends_it() {
        let a = acts();
        assert_eq!(
            a.record("s1", lead(Event::PromptSubmitted, 10)).doing(),
            Doing::Working
        );
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_model_error_ends_the_turn_as_surely_as_a_stop() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", lead(Event::StoppedFailed, 20)).doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_leads_stop_over_a_child_with_no_reported_end_awaits_it_rather_than_working() {
        for end in [Event::Stopped, Event::StoppedFailed] {
            let a = acts();
            a.record("s1", lead(Event::PromptSubmitted, 10));
            a.record("s1", child(Event::SubagentStarted, 11, "c1"));
            let after = a.record("s1", lead(end, 20));
            assert_eq!(
                after.doing(),
                Doing::AwaitingChildren,
                "{end:?}: a lead that ended its turn is not working because a child's end has not arrived — it may never, the hook that carries it can be lost (ISS-1232)"
            );
            assert_eq!(after.children.len(), 1, "the claim is kept, not dropped");
        }
    }

    #[test]
    fn a_leads_stop_over_a_live_child_ends_when_the_child_does() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::AwaitingChildren,
            "the child outlives the lead's boundary"
        );
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 30, "c1"))
                .doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_lead_mid_turn_is_working_whatever_its_children() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", child(Event::SubagentStarted, 11, "c1"))
                .doing(),
            Doing::Working
        );
        a.record("s1", lead(Event::Stopped, 20));
        a.record("s1", lead(Event::PromptSubmitted, 30));
        assert_eq!(
            a.record("s1", child(Event::SubagentStarted, 31, "c2"))
                .doing(),
            Doing::Working,
            "a new turn clears the lead's end, so its children are that turn's"
        );
    }

    #[test]
    fn children_this_daemon_never_saw_the_lead_end_over_are_still_working() {
        let a = acts();
        assert_eq!(
            a.record("s1", child(Event::SubagentStarted, 10, "c1"))
                .doing(),
            Doing::Working,
            "after a restart the lead may be mid-turn behind a child this daemon heard start"
        );
    }

    #[test]
    fn a_background_child_started_after_the_leads_stop_is_awaited() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(
            a.record("s1", child(Event::SubagentStarted, 30, "c1"))
                .doing(),
            Doing::AwaitingChildren
        );
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 40, "c1"))
                .doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_new_conversation_forgets_that_the_old_lead_ended() {
        let a = acts();
        let r = |event, subject, conversation| Report {
            event,
            at: 0,
            subject,
            conversation: Some(conversation),
            transcript: None,
        };
        a.record("s1", r(Event::PromptSubmitted, None, "conv-a"));
        a.record("s1", r(Event::Stopped, None, "conv-a"));
        assert_eq!(
            a.record("s1", r(Event::SubagentStarted, Some("c1"), "conv-b"))
                .doing(),
            Doing::Working,
            "the lead of conv-b has ended nothing this daemon saw"
        );
    }

    #[test]
    fn every_doing_wire_name_round_trips() {
        for d in [
            Doing::Working,
            Doing::AwaitingPermission,
            Doing::AwaitingChildren,
            Doing::Idle,
        ] {
            assert_eq!(Doing::from_wire(d.wire()), Some(d), "{}", d.wire());
        }
    }

    #[test]
    fn a_child_only_boundary_does_not_outlive_the_leads_next_turn() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::AwaitingChildren
        );
        // The child's `SubagentStop` never comes. The lead speaking again is
        // what proves the claim stale.
        a.record("s1", lead(Event::PromptSubmitted, 30));
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 40)).doing(),
            Doing::Idle,
            "a child claim no event ever closed must not survive the lead's next boundary"
        );
    }

    #[test]
    fn a_compact_after_a_child_only_boundary_clears_it() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(
            a.record("s1", lead(Event::Compacted, 30)).doing(),
            Doing::Idle
        );
    }

    #[test]
    fn the_boundary_holds_across_a_second_childs_start_and_stop() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        a.record("s1", child(Event::SubagentStarted, 12, "c2"));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 30, "c1"))
                .doing(),
            Doing::AwaitingChildren,
            "one child of two finishing leaves the other still awaited"
        );
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 40, "c2"))
                .doing(),
            Doing::Idle
        );
    }

    #[test]
    fn one_childs_stop_seen_twice_does_not_cancel_another_childs_claim() {
        let a = acts();
        a.record("s1", child(Event::SubagentStarted, 10, "c1"));
        a.record("s1", child(Event::SubagentStarted, 11, "c2"));
        a.record("s1", child(Event::SubagentStopped, 20, "c1"));
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 21, "c1"))
                .doing(),
            Doing::Working,
            "c2 is still working"
        );
    }

    #[test]
    fn one_childs_start_seen_twice_needs_only_one_stop() {
        let a = acts();
        a.record("s1", child(Event::SubagentStarted, 10, "c1"));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 20, "c1"))
                .doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_child_event_that_names_no_child_changes_nothing() {
        let a = acts();
        a.record("s1", child(Event::SubagentStarted, 10, "c1"));
        assert_eq!(
            a.record("s1", lead(Event::SubagentStopped, 20)).doing(),
            Doing::Working,
            "an id-less stop may not cancel a claim it cannot name"
        );
        let before = a.get("s1").unwrap().children.clone();
        a.record("s1", lead(Event::SubagentStarted, 30));
        assert_eq!(
            a.get("s1").unwrap().children,
            before,
            "an id-less start may not gate a pane nothing can ungate"
        );
    }

    #[test]
    fn a_new_conversation_voids_the_claims_of_the_old_one() {
        let a = acts();
        a.record(
            "s1",
            Report {
                event: Event::PromptSubmitted,
                at: 10,
                subject: None,
                conversation: Some("conv-a"),
                transcript: None,
            },
        );
        a.record(
            "s1",
            Report {
                event: Event::SubagentStarted,
                at: 11,
                subject: Some("c1"),
                conversation: Some("conv-a"),
                transcript: None,
            },
        );
        assert_eq!(a.get("s1").unwrap().children.len(), 1);
        let after = a.record(
            "s1",
            Report {
                event: Event::PromptSubmitted,
                at: 20,
                subject: None,
                conversation: Some("conv-b"),
                transcript: None,
            },
        );
        assert!(
            after.children.is_empty(),
            "a child of the previous conversation cannot hold this one working, got {:?}",
            after.children
        );
    }

    #[test]
    fn the_same_conversation_voids_nothing() {
        let a = acts();
        let r = |event, at| Report {
            event,
            at,
            subject: Some("c1"),
            conversation: Some("conv-a"),
            transcript: None,
        };
        a.record("s1", r(Event::SubagentStarted, 10));
        a.record("s1", r(Event::TeammateWentIdle, 11));
        a.record("s1", r(Event::SubagentStarted, 12));
        assert_eq!(a.get("s1").unwrap().doing(), Doing::Working);
    }

    #[test]
    fn a_childs_end_this_process_never_saw_the_start_of_does_not_wrap() {
        let a = acts();
        let after = a.record("s1", child(Event::SubagentStopped, 10, "c1"));
        assert!(after.children.is_empty());
        assert_eq!(after.doing(), Doing::Idle);
    }

    #[test]
    fn a_permission_question_outranks_a_running_turn_and_survives_until_the_next_boundary() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", lead(Event::PermissionRequested, 11)).doing(),
            Doing::AwaitingPermission,
            "a pane stopped on a question is not working, however recently its turn began"
        );
        assert_eq!(
            a.get("s1").unwrap().doing(),
            Doing::AwaitingPermission,
            "nothing but the agent's own next boundary may clear it"
        );
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::Idle
        );
    }

    #[test]
    fn a_hand_compacted_pane_does_not_stay_working_forever() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", lead(Event::Compacted, 20)).doing(),
            Doing::Idle
        );
    }

    #[test]
    fn every_event_moves_the_sequence_so_a_new_turn_is_provable_under_an_old_one() {
        let a = acts();
        let first = a.record("s1", lead(Event::PromptSubmitted, 10)).sequence;
        let second = a.record("s1", lead(Event::PromptSubmitted, 20)).sequence;
        assert!(second > first, "{second} must exceed {first}");
    }

    #[test]
    fn a_teammate_going_idle_stops_gating_the_pane() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(a.get("s1").unwrap().doing(), Doing::AwaitingChildren);
        assert_eq!(
            a.record("s1", child(Event::TeammateWentIdle, 30, "c1"))
                .doing(),
            Doing::Idle,
            "an idle child does not hold a pane working"
        );
    }

    #[test]
    fn a_teammate_that_resumes_gates_the_pane_again() {
        let a = acts();
        a.record("s1", child(Event::SubagentStarted, 10, "c1"));
        a.record("s1", child(Event::TeammateWentIdle, 11, "c1"));
        assert_eq!(
            a.record("s1", child(Event::SubagentStarted, 12, "c1"))
                .doing(),
            Doing::Working
        );
    }

    #[test]
    fn a_teammates_idle_does_not_strip_another_childs_claim() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        a.record("s1", child(Event::SubagentStarted, 12, "c2"));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(
            a.record("s1", child(Event::TeammateWentIdle, 30, "c1"))
                .doing(),
            Doing::AwaitingChildren,
            "one of two children going idle leaves the other gating"
        );
    }

    #[test]
    fn two_sessions_do_not_share_a_turn() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s2", lead(Event::Stopped, 11));
        assert_eq!(a.get("s1").unwrap().doing(), Doing::Working);
        assert_eq!(a.get("s2").unwrap().doing(), Doing::Idle);
    }

    #[test]
    fn every_wire_name_round_trips_and_none_is_invented() {
        for e in Event::ALL {
            assert_eq!(Event::from_wire(e.wire()), Some(e), "{}", e.wire());
        }
        assert_eq!(Event::from_wire("PreCompact"), None);
        assert_eq!(Event::from_wire(""), None);
    }

    #[test]
    fn a_prompt_is_counted_and_nothing_else_is() {
        let acts = Activities::new();
        let say = |event, subject| {
            acts.record(
                "s1",
                Report {
                    event,
                    at: 0,
                    subject,
                    conversation: Some("c1"),
                    transcript: None,
                },
            )
        };
        assert_eq!(say(Event::Stopped, None).prompts, 0);
        assert_eq!(say(Event::SubagentStarted, Some("k1")).prompts, 0);
        assert_eq!(say(Event::SubagentStopped, Some("k1")).prompts, 0);
        assert_eq!(say(Event::PromptSubmitted, None).prompts, 1);
        assert_eq!(say(Event::PermissionRequested, None).prompts, 1);
        assert_eq!(say(Event::Stopped, None).prompts, 1);
        assert_eq!(say(Event::PromptSubmitted, None).prompts, 2);
    }

    #[test]
    fn a_new_conversation_voids_the_claims_and_leaves_the_count_where_it_stands() {
        let acts = Activities::new();
        let say = |event, conversation| {
            acts.record(
                "s1",
                Report {
                    event,
                    at: 0,
                    subject: None,
                    conversation: Some(conversation),
                    transcript: None,
                },
            )
        };
        assert_eq!(say(Event::PromptSubmitted, "c1").prompts, 1);

        let after = say(Event::Stopped, "c2");
        assert_eq!(
            after.prompts, 1,
            "the tally survives the conversation it was counted in"
        );
        assert_eq!(
            after.doing(),
            Doing::Idle,
            "the claims the old conversation held are still voided"
        );
        assert_eq!(say(Event::PromptSubmitted, "c2").prompts, 2);
    }

    #[test]
    fn the_transcript_a_hook_names_is_kept_and_a_later_one_replaces_it() {
        let acts = Activities::new();
        let say = |event, transcript| {
            acts.record(
                "s1",
                Report {
                    event,
                    at: 0,
                    subject: None,
                    conversation: None,
                    transcript,
                },
            )
        };
        assert_eq!(say(Event::PromptSubmitted, None).transcript, None);
        assert_eq!(
            say(Event::PromptSubmitted, Some("/h/p/a.jsonl"))
                .transcript
                .as_deref(),
            Some("/h/p/a.jsonl")
        );
        assert_eq!(
            say(Event::Stopped, None).transcript.as_deref(),
            Some("/h/p/a.jsonl"),
            "an event that names none does not unlearn the one known"
        );
        assert_eq!(
            say(Event::PromptSubmitted, Some("/h/p/b.jsonl"))
                .transcript
                .as_deref(),
            Some("/h/p/b.jsonl")
        );
    }

    #[test]
    fn a_relative_transcript_path_is_not_taken() {
        let acts = Activities::new();
        let after = acts.record(
            "s1",
            Report {
                event: Event::PromptSubmitted,
                at: 0,
                subject: None,
                conversation: None,
                transcript: Some("conv.jsonl"),
            },
        );
        assert_eq!(
            after.transcript, None,
            "read against the daemon's own cwd, it would age some other file"
        );
    }

    #[test]
    fn precompact_is_refused_by_name_in_the_source_and_not_merely_absent() {
        assert!(
            !SOURCE.contains("\"PreCompact\" =>"),
            "an aborted compact emits PreCompact alone; accepting it as a boundary strands the pane"
        );
    }
}
