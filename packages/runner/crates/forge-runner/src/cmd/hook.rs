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
fn drain_and_ack() {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    println!("{{}}");
}

/// Report one event. Never fails, by construction.
// cm:guard returns `()` and not a `Result`, so no caller can turn a lost report into a non-zero exit. The value of this channel is that a pane keeps working when the daemon is down; a hook that failed loudly would trade every agent on the box for a diagnostic nobody reads.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/agent_activity.rs — the event NAMES are that module's closed set, and the daemon refuses an unknown one. This side must not translate, normalise or guess: a name Claude Code emits and that module does not know is a gap to close there, not to paper over here.
pub async fn run(args: Args) {
    drain_and_ack();
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
    let _ = control::request_agent_event(&sock, &token, &args.event).await;
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
            body.trim_start().starts_with("drain_and_ack();"),
            "stdin must be drained before ANY early return, or the agent takes a broken pipe"
        );
    }
}
