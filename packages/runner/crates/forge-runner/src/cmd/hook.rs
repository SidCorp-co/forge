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

fn drain_and_ack() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    println!("{{}}");
    sink
}

fn named_in(payload: &[u8]) -> control::HookNames {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return control::HookNames::default();
    };
    let field = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    control::HookNames {
        agent_id: field("agent_id").or_else(|| field("teammate_name")),
        conversation_id: field("session_id"),
        agent_type: field("agent_type"),
        transcript_path: field("transcript_path"),
    }
}

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
    let names = named_in(&payload);
    let _ = control::request_agent_event(&sock, &token, &args.event, &names).await;
}

#[cfg(test)]
mod tests {
    const SOURCE: &str = include_str!("hook.rs");

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
    use forge_runner_core::daemon::control;

    const SUBAGENT_START: &str = r#"{"agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"SubagentStart","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5"}"#;
    const SUBAGENT_STOP: &str = r#"{"agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"SubagentStop","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5","stop_hook_active":false}"#;
    const LEAD_STOP: &str = r#"{"hook_event_name":"Stop","prompt_id":"6a830af5-8553-45a9-9ebe-e5353e72481e","session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5","stop_hook_active":false}"#;

    #[test]
    fn a_childs_events_name_the_same_child_on_both_sides_of_its_life() {
        let started = named_in(SUBAGENT_START.as_bytes());
        let (start, conv, role) = (
            started.agent_id,
            started.conversation_id,
            started.agent_type,
        );
        let stop = named_in(SUBAGENT_STOP.as_bytes()).agent_id;
        assert_eq!(start.as_deref(), Some("acf9b1721de184fa7"));
        assert_eq!(
            start, stop,
            "a start and a stop that named different children would gate a pane forever"
        );
        assert_eq!(
            conv.as_deref(),
            Some("f3115c20-8b4b-4fcd-b27d-fefd1ac163f5")
        );
        // The role the child was dispatched through, which is what lets the
        // daemon tell a hand-off from a search helper (ISS-1094 criterion 24).
        assert_eq!(role.as_deref(), Some("general-purpose"));
    }

    #[test]
    fn a_lead_event_names_no_child() {
        let named = named_in(LEAD_STOP.as_bytes());
        assert!(named.agent_id.is_none(), "got {:?}", named.agent_id);
        assert!(
            named.conversation_id.is_some(),
            "the conversation is still named"
        );
    }

    #[test]
    fn a_teammates_name_stands_in_as_the_subject() {
        let subject = named_in(
            br#"{"hook_event_name":"TeammateIdle","teammate_name":"reviewer","session_id":"s1"}"#,
        )
        .agent_id;
        assert_eq!(subject.as_deref(), Some("reviewer"));
    }

    #[test]
    fn an_unparseable_payload_names_nothing_rather_than_guessing() {
        assert_eq!(named_in(b"not json at all"), control::HookNames::default());
        assert_eq!(named_in(b""), control::HookNames::default());
    }

    #[test]
    fn a_subject_that_is_not_a_string_is_not_a_subject() {
        assert_eq!(
            named_in(br#"{"agent_id":42,"session_id":null,"agent_type":42,"transcript_path":7}"#),
            control::HookNames::default()
        );
    }

    /// Claude Code's `Stop` payload as it arrives, with the common fields every
    /// hook event carries.
    const LEAD_STOP_WHOLE: &str = r#"{"session_id":"f3115c20-8b4b-4fcd-b27d-fefd1ac163f5","transcript_path":"/home/dev/.claude/projects/-w/f3115c20-8b4b-4fcd-b27d-fefd1ac163f5.jsonl","cwd":"/w","permission_mode":"bypassPermissions","hook_event_name":"Stop","stop_hook_active":false}"#;

    #[test]
    fn a_lead_event_names_the_transcript_its_conversation_is_written_to() {
        assert_eq!(
            named_in(LEAD_STOP_WHOLE.as_bytes())
                .transcript_path
                .as_deref(),
            Some("/home/dev/.claude/projects/-w/f3115c20-8b4b-4fcd-b27d-fefd1ac163f5.jsonl"),
            "the one thing the daemon can age while a turn runs (ISS-1244)"
        );
    }
}
