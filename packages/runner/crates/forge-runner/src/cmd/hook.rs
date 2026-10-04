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
use runner_daemon::{control, session_tokens};
use runner_platform::config::Config;

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
