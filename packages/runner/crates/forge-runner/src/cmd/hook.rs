//! `hook` — what a pane's own Claude Code hooks call to say what it is doing.
//!
//! This is the reporting half of the channel `daemon::agent_activity` opens:
//! the daemon learns a turn boundary from the agent rather than inferring one
//! from a screen it can only write to.
//!
//! One event is also ANSWERED here: `PermissionRequest` in a pane this box
//! placed is denied with how to rephrase (`runner_core::dialog_answer`), since
//! nobody watches that pane to answer it. Answered, it is recorded and not
//! reported as a question standing; a pane this box did not place, or one it
//! cannot tell, is left to its person and reported as today.
//!
//! One more is answered since ISS-297: `SubagentStop` for a subagent this box
//! bound to a declared run goes through the stop gate (`hook/stop.rs`,
//! deciding in `runner_core::stop_gate`), and is refused while the run holds an
//! issue with nothing written since the take, leaves its worktree dirty, or
//! leaves a process it started standing in it. A refused stop did not happen,
//! so it is not reported to the daemon as one.
//!
//! Everything here is subordinate to one rule: a hook must never be able to
//! break the agent that runs it. So there is no failure path — no socket, no
//! token, an unknown event, a daemon that refuses: every one of them exits 0
//! having printed `{}` (or the deny, or the refusal), and the report is simply
//! lost. A refusal is the hook's answer, not a failure of it.

use clap::Args as ClapArgs;
use runner_core::agent_activity::Event;
use runner_core::dialog_answer;
use runner_daemon::{control, session_tokens};
use runner_platform::config::{config_dir, Config};

use super::gate::{tokenless_here, Tokenless};
use super::Ctx;

mod stop;

#[derive(ClapArgs)]
pub struct Args {
    /// The Claude Code hook event name, e.g. `Stop` or `UserPromptSubmit`.
    #[arg(long)]
    pub event: String,
}

fn drain() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
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

/// Whether the pane this hook runs in is one this box placed, and so one no
/// person is watching.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Placed {
    /// Placed by this box, serving `project` where that can be read.
    Yes { project: Option<String> },
    /// Not this box's pane, or nothing could say: its person answers.
    No,
}

/// A pane holding a capability was placed by this box; one without is placed
/// when it stands on the runner's own tmux server.
pub fn placed(
    has_token: bool,
    project_env: Option<String>,
    tokenless: impl FnOnce() -> Tokenless,
) -> Placed {
    if has_token {
        return Placed::Yes {
            project: project_env,
        };
    }
    match tokenless() {
        Tokenless::LostMint { project, .. } => Placed::Yes {
            project: project_env.or(Some(project)),
        },
        Tokenless::Unrecorded { .. } => Placed::Yes {
            project: project_env,
        },
        Tokenless::NotOurs | Tokenless::Unknown(_) => Placed::No,
    }
}

/// What this hook prints for `event`, or `None` where it only reports.
pub fn answer(
    event: &str,
    payload: &[u8],
    placed: &Placed,
) -> Option<(String, dialog_answer::Asked)> {
    if event != Event::PermissionRequested.wire() || *placed == Placed::No {
        return None;
    }
    Some((
        dialog_answer::deny_output(),
        dialog_answer::asked_in(payload),
    ))
}

/// What the hook prints for an event the stop gate answered with `refusal`,
/// and whether the event is then reported to the daemon: a refused stop did
/// not happen, so the daemon is not told the run stopped.
pub fn said_for(refusal: Option<&str>) -> (String, bool) {
    match refusal {
        Some(reason) => (stop::block(reason), false),
        None => ("{}".to_string(), true),
    }
}

pub async fn run(ctx: Ctx, args: Args) {
    let payload = drain();
    let token = session_tokens::token_from_env().ok();
    if args.event == Event::PermissionRequested.wire() {
        let project = std::env::var("FORGE_PROJECT_ID")
            .ok()
            .filter(|p| !p.is_empty());
        let dir = config_dir();
        let tokenless = if token.is_none() {
            Some(tokenless_here(dir.as_deref()).await)
        } else {
            None
        };
        let placed = placed(token.is_some(), project, || {
            tokenless.unwrap_or(Tokenless::NotOurs)
        });
        if let Some((out, asked)) = answer(&args.event, &payload, &placed) {
            println!("{out}");
            if let (Some(dir), Placed::Yes { project }) = (dir.as_deref(), &placed) {
                dialog_answer::record(
                    dir,
                    runner_core::agent_activity::now_ms(),
                    project.as_deref(),
                    &asked,
                    dialog_answer::Via::Hook,
                );
            }
            return;
        }
    }
    let names = named_in(&payload);
    let refusal = if args.event == Event::SubagentStopped.wire() {
        stop::gate(&ctx, names.agent_id.as_deref()).await
    } else {
        None
    };
    let (out, report) = said_for(refusal.as_deref());
    println!("{out}");
    if !report {
        return;
    }
    let Some(token) = token else {
        return;
    };
    let Ok(cfg_path) = Config::path() else {
        return;
    };
    let sock = cfg_path.with_file_name("control.sock");
    if !sock.exists() {
        return;
    }
    let _ = control::request_agent_event(&sock, &token, &args.event, &names).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASKED: &[u8] = br#"{"session_id":"s","hook_event_name":"PermissionRequest","tool_name":"Bash",
        "tool_input":{"command":"cd gotest; rm -rf nodes/*"},"agent_id":"a1","agent_type":"forge:runner"}"#;

    #[test]
    fn a_placed_pane_s_permission_request_is_denied_with_how_to_rephrase() {
        let here = Placed::Yes {
            project: Some("p".into()),
        };
        let (out, asked) = answer("PermissionRequest", ASKED, &here).expect("answered");
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(
            v["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(asked.agent.as_deref(), Some("a1"));
        assert_eq!(
            dialog_answer::reason(&asked),
            "denied Bash: cd gotest; rm -rf nodes/*"
        );
    }

    #[test]
    fn a_pane_this_box_did_not_place_is_left_to_its_person() {
        assert!(answer("PermissionRequest", ASKED, &Placed::No).is_none());
        let here = Placed::Yes { project: None };
        assert!(
            answer("Stop", b"{}", &here).is_none(),
            "only a dialog is answered"
        );
    }

    #[test]
    fn a_refused_stop_is_printed_as_a_block_and_never_reported_as_a_stop() {
        let (out, report) = said_for(Some("STOP_WORKTREE_DIRTY: x"));
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["decision"], "block");
        assert_eq!(v["reason"], "STOP_WORKTREE_DIRTY: x");
        assert!(
            !report,
            "a refused stop was reported to the daemon as a stop"
        );
        assert_eq!(said_for(None), ("{}".to_string(), true));
    }

    #[test]
    fn a_pane_is_placed_by_its_capability_or_by_standing_on_the_runner_s_server() {
        let never = || -> Tokenless { panic!("a token settles it") };
        assert_eq!(
            placed(true, Some("p".into()), never),
            Placed::Yes {
                project: Some("p".into())
            }
        );
        assert_eq!(placed(false, None, || Tokenless::NotOurs), Placed::No);
        assert_eq!(
            placed(false, None, || Tokenless::Unknown("x".into())),
            Placed::No
        );
        assert_eq!(
            placed(false, None, || Tokenless::Unrecorded {
                pane: "forge-master-x".into()
            }),
            Placed::Yes { project: None }
        );
        assert_eq!(
            placed(false, None, || Tokenless::LostMint {
                pane: "forge-master-x".into(),
                project: "p2".into(),
                slug: None,
                socket: "/tmp/s".into(),
            }),
            Placed::Yes {
                project: Some("p2".into())
            }
        );
    }
}
