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
    /// A prompt was accepted and a turn began.
    PromptSubmitted,
    /// The turn ended.
    Stopped,
    /// The turn ended on an API or model error.
    // cm:guard Claude Code emits this INSTEAD of `Stop` after a model error, so a reader that knows only `Stop` leaves the turn spinning forever. It is a turn END like any other and must not be a third state.
    StoppedFailed,
    /// Stopped on a question only a human can answer.
    PermissionRequested,
    /// A child agent started.
    SubagentStarted,
    /// A child agent finished.
    SubagentStopped,
    /// A turn-based teammate went idle. Alive and resumable, not gone.
    // cm:guard mapped to "no longer gating" and NOT to "gone", which is the same answer here for the only question this module asks: an idle child does not hold a pane working (Orca's #8825 idle-squat rule). Verified in claude 2.1.257: `TeammateIdle` is its own hook event beside `Stop`, and the payload names the teammate (`teammate_name`) rather than carrying an id — so a roster keyed on a child id is not available to build even if this needed one.
    TeammateWentIdle,
    /// A manual `/compact` finished.
    // cm:guard a manual compact ends at an idle prompt and emits NO `Stop`, so without this event a pane that was compacted by hand stays `Working` for the rest of its life.
    Compacted,
}

impl Event {
    /// The Claude Code hook event name, which is the wire name.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/hook_install.rs — these strings are what gets registered in the pane's settings; a name here that Claude Code does not emit registers a hook that never fires, and the failure is silence.
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

/// One report from a session's hook, with everything the frame carried.
// cm:guard `subject` and `conversation` are OPTIONS and a missing one may never be guessed. Measured against claude 2.1.257: a child event carries `agent_id` and a LEAD event carries none, so absence is the lead/child discriminator itself — inventing an id for an unattributable event would let a child event own the lead's turn.
#[derive(Debug, Clone, Copy)]
pub struct Report<'a> {
    pub event: Event,
    pub at: i64,
    /// `agent_id` for a child event; `teammate_name` on `TeammateIdle`. None for a lead event.
    pub subject: Option<&'a str>,
    /// Claude Code's own `session_id` — the conversation, not Forge's session.
    pub conversation: Option<&'a str>,
}

/// What a session is doing, as the session itself last reported.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Doing {
    /// A turn is running, or a child of it is.
    Working,
    /// Stopped on a question a human owes an answer to.
    AwaitingPermission,
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
    /// The children currently holding this pane working, BY ID.
    // cm:guard a set of ids and not a count, because the two failures a count cannot survive are both routine: the same `SubagentStart` seen twice would gate twice, and a `SubagentStop` for a child this process never saw would cancel a DIFFERENT child's claim. An id makes both idempotent, and it is the only way a log line can ever name which child is holding a pane.
    pub children: std::collections::BTreeSet<String>,
    /// The conversation these claims belong to (Claude Code's `session_id`).
    pub conversation: Option<String>,
    awaiting_permission: bool,
    /// Bumped by every accepted event, so a caller can prove a NEW turn began
    /// rather than reading a turn that was already running as its own.
    pub sequence: u64,
}

impl Activity {
    pub fn doing(&self) -> Doing {
        if self.awaiting_permission {
            return Doing::AwaitingPermission;
        }
        // cm:guard a lead `Stop` while a child is outstanding is NOT idle, and this is the case that cost Orca a named rule (`attachClaudeChildOnlyBoundary`): a run whose reviewer subagent is still working emits the lead's Stop first, and a reader without this term calls the pane finished and reclaims a worktree being written.
        if self.turn_started_at.is_some() || !self.children.is_empty() {
            return Doing::Working;
        }
        Doing::Idle
    }
}

/// Every session's activity on this box, keyed by the session the token named.
// cm:guard IN MEMORY on purpose, and a daemon that restarts therefore knows nothing rather than something stale. An absent entry reads as "never reported" at every caller, which is the honest answer for a pane whose hooks predate this process; persisting it would let a restart resurrect a turn boundary no live agent stands behind.
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
            awaiting_permission: false,
            sequence: 0,
        });
        // cm:guard a DIFFERENT conversation voids every claim before the event is applied, and this is the backstop for the exits no hook reports: `/clear`, a relaunch and a resume all leave the pane alive with a new `session_id` and emit nothing terminating, so claims from the old conversation would otherwise gate the pane forever. Scoped to claims ABOUT the conversation — this module holds no evidence about OS processes, which is the thing such a void must never take with it.
        if let Some(seen) = r.conversation {
            if a.conversation.as_deref().is_some_and(|had| had != seen) {
                a.turn_started_at = None;
                a.children.clear();
                a.awaiting_permission = false;
            }
            a.conversation = Some(seen.to_string());
        }
        a.last_event = event;
        a.last_event_at = at;
        a.sequence += 1;
        // cm:guard the child-only boundary is CARRIED only while the events that follow it are the child's own, and any other event strips it. Establishing it without this exit is the same unbounded claim `PreCompact` is refused for: a child killed, crashed, or whose hook was dropped never sends `SubagentStop`, and the pane is then `Working` for the rest of its life with nothing on the box able to say why.
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
            }
            // cm:guard a permission wait is cleared by the NEXT boundary and never by a timer: the question stands until the agent moves, and a wait that expired on its own would read as progress nobody made.
            Event::PermissionRequested => a.awaiting_permission = true,
            Event::Stopped | Event::StoppedFailed | Event::Compacted => {
                a.turn_started_at = None;
                a.awaiting_permission = false;
            }
            // cm:guard a child event with NO subject changes nothing — it is unattributable, and the rule is void nothing rather than guess. Gating on an id-less child event would let one child's start hold the pane after a different child's stop, and an id-less stop would cancel a claim it cannot name.
            Event::SubagentStarted => {
                if let Some(id) = r.subject {
                    a.children.insert(id.to_string());
                }
            }
            // cm:guard a teammate going idle takes the SAME arm as a child finishing, and the difference between them is deliberately not modelled: a turn-based teammate fires this at every turn end while staying alive, so a reader that treated it as existence would keep the pane working across every boundary, and one that treats it as departure is wrong only about a fact nothing here asks. On that event the subject is `teammate_name`, not `agent_id` — the frame carries whichever the payload had.
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
        }
    }

    /// A child event, naming the child.
    fn child(event: Event, at: i64, id: &str) -> Report<'_> {
        Report {
            event,
            at,
            subject: Some(id),
            conversation: None,
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

    // cm:guard the error path is a turn END, and this is the test that fails if anyone treats `StopFailure` as a state of its own: Claude Code emits it INSTEAD of `Stop`, so a reader that only knows `Stop` leaves the pane `Working` forever after one model error.
    #[test]
    fn a_model_error_ends_the_turn_as_surely_as_a_stop() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", lead(Event::StoppedFailed, 20)).doing(),
            Doing::Idle
        );
    }

    // cm:guard the failure this exists for: a run's reviewer subagent is still writing the worktree when the lead emits `Stop`, and a reader without the child term calls that pane finished. Reclaiming on it takes a checkout out from under a live agent.
    #[test]
    fn a_leads_stop_over_a_live_child_is_still_working() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::Working,
            "the child outlives the lead's boundary"
        );
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 30, "c1"))
                .doing(),
            Doing::Idle
        );
    }

    // cm:guard the boundary needs an EXIT and this is the test for it: it is carried only while the events that follow are the child's own, so a lead that starts working again strips a child claim nothing has closed. Without this half a child that dies without its `SubagentStop` — killed, crashed, or its hook dropped — pins the pane `Working` for the rest of its life, which is exactly the failure `PreCompact` is refused for.
    #[test]
    fn a_child_only_boundary_does_not_outlive_the_leads_next_turn() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        assert_eq!(
            a.record("s1", lead(Event::Stopped, 20)).doing(),
            Doing::Working
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

    // cm:guard the same exit, on the arm that has no second turn to strip it: a hand `/compact` after the lead stopped over a child is a non-child event and must clear the claim too.
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

    // cm:guard and the boundary must still HOLD across the child's own events, or the fix above has simply deleted the term it is fixing.
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
            Doing::Working,
            "one child of two finishing leaves the other working"
        );
        assert_eq!(
            a.record("s1", child(Event::SubagentStopped, 40, "c2"))
                .doing(),
            Doing::Idle
        );
    }

    // cm:guard the failure a COUNT could not survive, and the reason this is a set: the same child's stop arriving twice — a retried hook, a duplicated delivery — would have cancelled a second child's claim and idled a pane with live work in it.
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

    // cm:guard the other half of the same property: one child's start seen twice must not need two stops.
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

    // cm:guard an unattributable child event must VOID NOTHING. A stop with no id cannot name the claim it would cancel, and a start with no id would gate a pane no event can ever ungate.
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

    // cm:guard the backstop for every exit that reports NOTHING: `/clear`, a relaunch and a resume leave the pane alive under a new conversation and emit no terminating hook, so claims from the old one would gate it forever.
    #[test]
    fn a_new_conversation_voids_the_claims_of_the_old_one() {
        let a = acts();
        // cm:guard the turn is left RUNNING on purpose, so the child-only strip
        // cannot fire and take the credit: with `turn_started_at` set, the only
        // thing that can clear this child is the conversation changing. The
        // first version of this test asserted the same outcome with the turn
        // ended, and stayed green with the whole backstop deleted.
        a.record(
            "s1",
            Report {
                event: Event::PromptSubmitted,
                at: 10,
                subject: None,
                conversation: Some("conv-a"),
            },
        );
        a.record(
            "s1",
            Report {
                event: Event::SubagentStarted,
                at: 11,
                subject: Some("c1"),
                conversation: Some("conv-a"),
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
        };
        a.record("s1", r(Event::SubagentStarted, 10));
        a.record("s1", r(Event::TeammateWentIdle, 11));
        a.record("s1", r(Event::SubagentStarted, 12));
        assert_eq!(a.get("s1").unwrap().doing(), Doing::Working);
    }

    // cm:guard a `SubagentStop` with no matching start is the normal case for every pane that predates this daemon, so the counter MUST saturate: an underflow pins the pane `Working` for the rest of its life and nothing on the box could explain why.
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

    // cm:guard a manual `/compact` ends at an idle prompt and emits no `Stop`, so this event is the only thing that can end that turn. Without it the pane stays `Working` forever and every liveness reader believes it.
    #[test]
    fn a_hand_compacted_pane_does_not_stay_working_forever() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        assert_eq!(
            a.record("s1", lead(Event::Compacted, 20)).doing(),
            Doing::Idle
        );
    }

    // cm:guard the sequence is what lets a caller prove a NEW turn started: an agent already working when a prompt is pasted cannot show a `→Working` edge, so without a counter the only proof left is a screen read.
    #[test]
    fn every_event_moves_the_sequence_so_a_new_turn_is_provable_under_an_old_one() {
        let a = acts();
        let first = a.record("s1", lead(Event::PromptSubmitted, 10)).sequence;
        let second = a.record("s1", lead(Event::PromptSubmitted, 20)).sequence;
        assert!(second > first, "{second} must exceed {first}");
    }

    // cm:guard a turn-based teammate fires `TeammateIdle` at EVERY turn end while staying alive and resumable, so this is the event that ends the gate — not `SubagentStop`, which such a child may never send at all. Without it the counter never comes down and the pane is `Working` until the lead happens to speak again.
    #[test]
    fn a_teammate_going_idle_stops_gating_the_pane() {
        let a = acts();
        a.record("s1", lead(Event::PromptSubmitted, 10));
        a.record("s1", child(Event::SubagentStarted, 11, "c1"));
        a.record("s1", lead(Event::Stopped, 20));
        assert_eq!(a.get("s1").unwrap().doing(), Doing::Working);
        assert_eq!(
            a.record("s1", child(Event::TeammateWentIdle, 30, "c1"))
                .doing(),
            Doing::Idle,
            "an idle child does not hold a pane working"
        );
    }

    // cm:guard idle is not gone: the same teammate resuming must gate again, which is why this event may not be read as a departure either.
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

    // cm:guard `TeammateIdle` is CHILD-scoped and must not strip the boundary the way a lead event does, or a teammate going idle would clear a second child that is still working.
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
            Doing::Working,
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

    // cm:guard `PreCompact` must NOT be registered or accepted: it fires before the compact is validated and an aborted compact emits it alone, so mapping it to a boundary strands the pane in exactly the state this module exists to prevent.
    #[test]
    fn precompact_is_refused_by_name_in_the_source_and_not_merely_absent() {
        assert!(
            !SOURCE.contains("\"PreCompact\" =>"),
            "an aborted compact emits PreCompact alone; accepting it as a boundary strands the pane"
        );
    }
}
