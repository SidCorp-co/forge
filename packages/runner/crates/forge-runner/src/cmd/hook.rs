//! `hook` — what a pane's own Claude Code hooks call to say what it is doing.
//!
//! This is the reporting half of the channel `daemon::agent_activity` opens:
//! the daemon learns a turn boundary from the agent rather than inferring one
//! from a screen it can only write to.
//!
//! Everything here is subordinate to one rule: a hook must never be able to
//! break the agent that runs it. So there is no failure path — no socket, no
//! token, an unknown event, a daemon that refuses: every one of them exits 0
//! having printed `{}`, and the report is simply lost.

use clap::Args as ClapArgs;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::{control, session_tokens};

#[derive(ClapArgs)]
pub struct Args {
    /// The Claude Code hook event name, e.g. `Stop` or `UserPromptSubmit`.
    #[arg(long)]
    pub event: String,
}

/// Drain the hook payload and answer the agent, whatever else happens.
// cm:guard stdin is drained BEFORE anything can return, and this is not politeness: Claude Code writes the event payload to this process's stdin, so a hook that exits without reading it hands the agent a broken pipe mid-write — measured by Orca as their #8110, an exit 127 and a truncated write in the agent's own critical path. Every early return below has already been through here.
fn drain_and_ack() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    println!("{{}}");
    sink
}

/// The child and the conversation this payload names, if it names them.
// cm:guard a payload that will not parse yields NOTHING rather than a guess, and the daemon then records a lead event. Reporting the boundary without a subject is the safe direction: an unattributable child event must void nothing.
// cm:guard `teammate_name` is an ALTERNATIVE subject and not a fallback for a missing `agent_id`: measured against claude 2.1.257, `TeammateIdle` names its subject there while `SubagentStart`/`SubagentStop` carry `agent_id`, and a LEAD event carries neither — which is what makes absence the discriminator rather than a gap.
fn named_in(payload: &[u8]) -> (Option<String>, Option<String>) {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return (None, None);
    };
    let field = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    (
        field("agent_id").or_else(|| field("teammate_name")),
        field("session_id"),
    )
}

/// Report one event. Never fails, by construction.
// cm:guard returns `()` and not a `Result`, so no caller can turn a lost report into a non-zero exit. The value of this channel is that a pane keeps working when the daemon is down; a hook that failed loudly would trade every agent on the box for a diagnostic nobody reads.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/agent_activity.rs — the event NAMES are that module's closed set, and the daemon refuses an unknown one. This side must not translate, normalise or guess: a name Claude Code emits and that module does not know is a gap to close there, not to paper over here.
pub async fn run(args: Args) {
    let payload = drain_and_ack();
    let Ok(token) = session_tokens::token_from_env() else {
        return;
    };
    let Ok(cfg_path) = Config::path() else {
        return;
    };
    let sock = cfg_path.with_file_name("control.sock");
    if !sock.exists() {
        return;
    }
    let (subject, conversation) = named_in(&payload);
    let _ = control::request_agent_event(
        &sock,
        &token,
        &args.event,
        subject.as_deref(),
        conversation.as_deref(),
    )
    .await;
}

#[cfg(test)]
mod tests {
    const SOURCE: &str = include_str!("hook.rs");

    // cm:guard the assertion is on the SOURCE because what is under test is that no path can fail: a behavioural test would have to reproduce a broken daemon, a missing token and an unknown event separately, and would still not catch the next early return somebody adds above the drain.
    #[test]
    fn no_path_through_this_verb_can_fail_the_agent_that_ran_it() {
        let body = SOURCE
            .split("pub async fn run(args: Args) {")
            .nth(1)
            .expect("the verb's body")
            .split("\n}")
            .next()
            .expect("its closing brace");
        assert!(
            !body.contains('?'),
            "a `?` here propagates a failure into the agent's hook exit code"
        );
        assert!(
            !body.contains("unwrap()") && !body.contains("expect("),
            "a panic in a hook is a non-zero exit in the agent's critical path"
        );
        assert!(
            body.trim_start()
                .starts_with("let payload = drain_and_ack();"),
            "stdin must be drained before ANY early return, or the agent takes a broken pipe"
        );
    }

    use super::named_in;

    /// Real payloads, observed from claude 2.1.257 on 2026-09-11 by registering
    /// these hooks and running one session that spawned one subagent. Trimmed to
    /// the fields this verb reads.
    // cm:guard these are OBSERVED and not composed, and that is the whole reason they are here: two commits before this one shipped a wrong model of this payload, once from a peer's read of another tool's consuming side and once from strings in a stripped binary. A fixture somebody wrote to match the code proves only that the code matches itself.
    const SUBAGENT_START: &str = r#"{"agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"SubagentStart","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5"}"#;
    const SUBAGENT_STOP: &str = r#"{"agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"SubagentStop","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5","stop_hook_active":false}"#;
    const LEAD_STOP: &str = r#"{"hook_event_name":"Stop","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5","stop_hook_active":false}"#;

    #[test]
    fn a_childs_events_name_the_same_child_on_both_sides_of_its_life() {
        let (start, conv) = named_in(SUBAGENT_START.as_bytes());
        let (stop, _) = named_in(SUBAGENT_STOP.as_bytes());
        assert_eq!(start.as_deref(), Some("acf9b1721de184fa7"));
        assert_eq!(
            start, stop,
            "a start and a stop that named different children would gate a pane forever"
        );
        assert_eq!(
            conv.as_deref(),
            Some("f3115c20-8b4b-4fcd-b27d-fefd1ac163f5")
        );
    }

    // cm:guard THE observed contract: a lead event carries no `agent_id`, so absence is the lead/child discriminator. A build that filled it in — from the session, from the transcript path, from anything — would let every lead `Stop` cancel a live child's claim.
    #[test]
    fn a_lead_event_names_no_child() {
        let (subject, conv) = named_in(LEAD_STOP.as_bytes());
        assert!(subject.is_none(), "got {subject:?}");
        assert!(conv.is_some(), "the conversation is still named");
    }

    #[test]
    fn a_teammates_name_stands_in_as_the_subject() {
        let (subject, _) = named_in(
            br#"{"hook_event_name":"TeammateIdle","teammate_name":"reviewer","session_id":"s1"}"#,
        );
        assert_eq!(subject.as_deref(), Some("reviewer"));
    }

    #[test]
    fn an_unparseable_payload_names_nothing_rather_than_guessing() {
        assert_eq!(named_in(b"not json at all"), (None, None));
        assert_eq!(named_in(b""), (None, None));
    }

    // cm:guard a non-string field is not a subject: `serde_json`'s `as_str` answers None for a number or an object, and coercing one would put a rendered `{}` into a roster key.
    #[test]
    fn a_subject_that_is_not_a_string_is_not_a_subject() {
        assert_eq!(
            named_in(br#"{"agent_id":42,"session_id":null}"#),
            (None, None)
        );
    }
}
