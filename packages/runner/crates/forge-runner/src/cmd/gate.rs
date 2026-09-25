//! `gate` — the pane's own `PreToolUse` hook, asking whether the work its
//! master is about to hand out has been declared.
//!
//! Sibling of `hook`, and deliberately not part of it. That verb reports and
//! must never answer anything, so it prints `{}` the moment stdin is drained;
//! this one has to read the payload, ask the daemon and then print a decision.
//! Folding them together would put a decision path inside the one verb whose
//! whole contract is that it has none.
//!
//! What it shares with `hook` is the rule that matters: no path through it may
//! fail the agent that ran it. A deliberate deny is not a failure — it is the
//! answer — but a panic, a timeout or a daemon that is down must leave the
//! agent exactly as it found it. Every uncertain outcome therefore ALLOWS, and
//! leaves a mark that says the gate was not operating (`daemon::degraded`),
//! because a gate that silently stopped gating is the defect this issue exists
//! to end, arriving from inside the fix.

use std::path::{Path, PathBuf};

use clap::Args as ClapArgs;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::degraded::{mark, Kind, Mark, Run, Source};
use forge_runner_core::daemon::dispatch_gate::Dispatch;
use forge_runner_core::daemon::{control, session_tokens};

const ANSWER_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(ClapArgs)]
pub struct Args {
    /// The Claude Code hook event name. `PreToolUse` is the only one served.
    #[arg(long)]
    pub event: String,
}

fn drain() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    sink
}

pub enum Payload {
    /// An ordinary tool call. Almost all of them; this hook runs in front of every tool.
    NotADispatch,
    /// This box could not read the payload at all.
    Malformed,
    /// A subagent is about to be dispatched.
    Dispatch(Dispatch),
}

pub fn dispatch_in(payload: &[u8]) -> Payload {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Payload::Malformed;
    };
    if !v.is_object() {
        return Payload::Malformed;
    }
    let field = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let subagent_type = match v.get("tool_input") {
        None => return Payload::NotADispatch,
        Some(t) if !t.is_object() => return Payload::Malformed,
        Some(t) => match t.get("subagent_type") {
            None => return Payload::NotADispatch,
            Some(r) => match r.as_str() {
                None => return Payload::Malformed,
                Some(r) => r.to_string(),
            },
        },
    };
    Payload::Dispatch(Dispatch {
        agent_id: field("agent_id"),
        subagent_type: Some(subagent_type),
        tool_use_id: field("tool_use_id"),
    })
}

fn deny(reason: &str) -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }
    })
    .to_string()
}

const ALLOW: &str = "{}";

/// Where this box's config, socket and marks live.
fn config_dir() -> Option<PathBuf> {
    Config::path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Why a mark this process writes never names a run: the registry of declared
/// runs is the daemon's, and every path through here is one where the daemon
/// was not reached or did not decide.
const NO_RUN_HERE: &str = "the hook holds no registry of declared runs, so none was resolved here";

async fn answer(dir: Option<&Path>, token: Option<&str>, d: &Dispatch) -> String {
    let open_because = |why: &str| -> String {
        if let Some(dir) = dir {
            mark(
                dir,
                &Mark::new(Kind::Degraded, Source::Hook, why, Run::Unknown(NO_RUN_HERE)).about(d),
            );
        }
        ALLOW.to_string()
    };
    let Some(token) = token else {
        // Said of the process this hook ran in, which is the only thing it can
        // see. Worded as a claim about "this pane" it was read on ISS-1192 as a
        // statement about the master, from a master whose own token was set.
        return open_because(
            "the process this hook ran in carries no control capability (FORGE_CONTROL_TOKEN is \
             unset), so nothing could be asked",
        );
    };
    let Some(sock) = dir.map(|d| d.join("control.sock")) else {
        return open_because("the control socket path could not be resolved");
    };
    if !sock.exists() {
        return open_because("the daemon's control socket is not there");
    }
    let asked = tokio::time::timeout(
        ANSWER_WITHIN,
        control::request_dispatch_gate(&sock, &token, d),
    )
    .await;
    match asked {
        Err(_) => open_because("the daemon did not answer within the bound"),
        Ok(Err(e)) => open_because(&format!("the daemon could not be reached: {e}")),
        Ok(Ok(reply)) if reply.ok => ALLOW.to_string(),
        Ok(Ok(reply)) => match reply.reason.as_deref() {
            Some(r) if r == forge_runner_core::daemon::dispatch_gate::REFUSAL => deny(r),
            Some(other) => {
                open_because(&format!("the daemon refused the question itself: {other}"))
            }
            None => open_because("the daemon refused the question itself and said nothing"),
        },
    }
}

pub async fn run(args: Args) {
    let payload = drain();
    if args.event != "PreToolUse" {
        println!("{ALLOW}");
        return;
    }
    let d = match dispatch_in(&payload) {
        Payload::Dispatch(d) => d,
        Payload::NotADispatch => {
            println!("{ALLOW}");
            return;
        }
        Payload::Malformed => {
            if let Some(dir) = config_dir().as_deref() {
                mark(
                    dir,
                    &Mark::new(
                        Kind::Degraded,
                        Source::Hook,
                        "a PreToolUse payload this box could not read at all",
                        Run::Unknown(
                            "the payload named no dispatch this box could read, so nothing was \
                             resolved",
                        ),
                    ),
                );
            }
            println!("{ALLOW}");
            return;
        }
    };
    let token = session_tokens::token_from_env().ok();
    println!(
        "{}",
        answer(config_dir().as_deref(), token.as_deref(), &d).await
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, by the idiom this crate already uses
    /// (`daemon/held_report.rs`): keyed on pid and thread so two `cargo test`
    /// runs on one box cannot take each other's, and removed on the way out.
    struct Scratch(forge_runner_core::test_scratch::Scratch);

    /// The `sockaddr_un.sun_path` budget: 104 bytes on macOS against 108 on Linux.
    const SUN_LEN: usize = 104;

    impl Scratch {
        /// `name` is for the reader of the test: the shared counter is what keeps two apart.
        fn new(_name: &str) -> Self {
            let p = forge_runner_core::test_scratch::Scratch::short("gg");
            assert!(
                p.join("control.sock").as_os_str().len() < SUN_LEN,
                "a socket under this scratch would not fit in sun_path ({SUN_LEN}): {}",
                p.display()
            );
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            self.0.path()
        }
    }

    const SOURCE: &str = include_str!("gate.rs");

    /// Criteria 11-16, at the source, because a behavioural test would have to
    /// reproduce four different outages separately and still would not catch
    /// the next early return somebody adds.
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
            body.trim_start().starts_with("let payload = drain();"),
            "stdin must be drained before ANY early return, or the agent takes a broken pipe"
        );
    }

    const DISPATCH: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","cwd":"/tmp/x","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Run echo command","prompt":"Run exactly this shell command","subagent_type":"general-purpose","run_in_background":false},"tool_use_id":"toolu_01WFynvjwEmYFcgyKTMn4J91"}"#;
    const INSIDE_A_CHILD: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","agent_id":"acf9b1721de184fa7","agent_type":"general-purpose","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo hi"},"tool_use_id":"toolu_02"}"#;
    const AN_ORDINARY_TOOL_CALL: &str = r#"{"session_id":"d5953edb","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/x"},"tool_use_id":"toolu_03"}"#;

    fn as_dispatch(payload: &str) -> Dispatch {
        match dispatch_in(payload.as_bytes()) {
            Payload::Dispatch(d) => d,
            _ => panic!("expected a dispatch"),
        }
    }

    #[test]
    fn a_dispatch_is_recognised_by_its_input_and_not_by_the_tools_name() {
        let d = as_dispatch(DISPATCH);
        assert_eq!(d.subagent_type.as_deref(), Some("general-purpose"));
        assert_eq!(
            d.tool_use_id.as_deref(),
            Some("toolu_01WFynvjwEmYFcgyKTMn4J91")
        );
        assert_eq!(
            d.agent_id, None,
            "the master's own dispatch carries no agent_id; that absence is the discriminator"
        );
    }

    #[test]
    fn a_tool_call_that_is_not_a_dispatch_never_reaches_the_socket() {
        assert!(matches!(
            dispatch_in(AN_ORDINARY_TOOL_CALL.as_bytes()),
            Payload::NotADispatch
        ));
    }

    #[test]
    fn a_tool_call_raised_inside_a_child_carries_the_childs_id() {
        // It is not a dispatch either, so it stops one step earlier — but when a
        // child DOES dispatch, the id is what tells the gate whose call it is.
        assert!(matches!(
            dispatch_in(INSIDE_A_CHILD.as_bytes()),
            Payload::NotADispatch
        ));
        let v: serde_json::Value = serde_json::from_str(INSIDE_A_CHILD).expect("json");
        assert!(v.get("agent_id").is_some());
    }

    #[test]
    fn a_payload_that_will_not_parse_is_malformed_and_not_merely_not_a_dispatch() {
        assert!(matches!(
            dispatch_in(b"not json at all"),
            Payload::Malformed
        ));
        assert!(matches!(dispatch_in(b""), Payload::Malformed));
        assert!(
            matches!(
                dispatch_in(AN_ORDINARY_TOOL_CALL.as_bytes()),
                Payload::NotADispatch
            ),
            "an ordinary tool call is not a failure and must leave no mark"
        );
    }

    #[test]
    fn a_payload_that_parses_but_whose_role_cannot_be_read_is_malformed_too() {
        // The shapes a harness change actually produces. Each one parses as JSON, so the
        // serde check alone lets all four through as "ordinary" and the gate goes quiet across
        // the fleet with the degraded count at zero.
        for p in [
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"prompt":"go","subagent_type":null},"tool_use_id":"toolu_1"}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"subagent_type":{"name":"runner"}},"tool_use_id":"toolu_1"}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":"{\"subagent_type\":\"runner\"}"}"#,
            "null",
            "[]",
        ] {
            assert!(
                matches!(dispatch_in(p.as_bytes()), Payload::Malformed),
                "a payload this box cannot read the role out of is not an ordinary tool call: {p}"
            );
        }
    }

    #[test]
    fn the_ordinary_shapes_stay_silent_so_the_marks_keep_meaning_something() {
        // The other side of the same rule. If these ever start marking, `degraded` counts every
        // tool call on the box and the number stops being evidence of anything.
        for p in [
            AN_ORDINARY_TOOL_CALL,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"ls"}}"#,
            r#"{"hook_event_name":"PreToolUse","tool_name":"Bash"}"#,
        ] {
            assert!(
                matches!(dispatch_in(p.as_bytes()), Payload::NotADispatch),
                "an understood, ordinary tool call must leave no mark: {p}"
            );
        }
    }

    /// Criterion 2. The deny that reaches the model carries the way forward.
    #[test]
    fn the_deny_shape_is_the_one_claude_reads_and_carries_the_refusal() {
        let out = deny(forge_runner_core::daemon::dispatch_gate::REFUSAL);
        let v: serde_json::Value = serde_json::from_str(&out).expect("json");
        assert_eq!(
            v["hookSpecificOutput"]["permissionDecision"]
                .as_str()
                .unwrap_or_default(),
            "deny"
        );
        assert!(v["hookSpecificOutput"]["permissionDecisionReason"]
            .as_str()
            .unwrap_or_default()
            .contains("forge-runner run declare"));
    }

    /// The capability a pane the daemon spawned carries. Passed explicitly by
    /// every test that means to reach the socket, because taking it from the
    /// environment made these tests assert one thing locally and another on CI.
    const TOKEN: &str = "a-token-the-daemon-minted";

    /// Criteria 13, 17, 18. No socket on the box: the dispatch goes through and
    /// the mark that says so lands anyway.
    #[tokio::test]
    async fn no_control_socket_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-1");
        let d = as_dispatch(DISPATCH);
        assert_eq!(answer(Some(dir.path()), Some(TOKEN), &d).await, ALLOW);
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 1,
            "a gate that opened without deciding must say so: {degraded:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_that_never_answers_opens_the_gate_within_the_bound() {
        let dir = Scratch::new("gateverb-2");
        let sock = dir.path().join("control.sock");
        let listener = tokio::net::UnixListener::bind(&sock).expect("listener");
        // Accept and then say nothing at all, for as long as the test lives.
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                std::mem::forget(stream);
            }
        });
        let d = as_dispatch(DISPATCH);
        let began = std::time::Instant::now();
        assert_eq!(answer(Some(dir.path()), Some(TOKEN), &d).await, ALLOW);
        assert!(
            began.elapsed() < ANSWER_WITHIN * 3,
            "a silent daemon must not hold the master longer than the bound: {:?}",
            began.elapsed()
        );
        assert_eq!(
            forge_runner_core::daemon::degraded::tally(dir.path())
                .0
                .count,
            1
        );
    }

    /// Criterion 13, where nothing at all is resolvable. (This carried the label
    /// `Criterion 12` until ISS-1094's re-judge: it exercises an absent config
    /// directory, never an absent token, and C12 is the test directly below.)
    #[tokio::test]
    async fn a_pane_with_no_config_directory_still_opens_the_gate() {
        let d = as_dispatch(DISPATCH);
        assert_eq!(answer(None, Some(TOKEN), &d).await, ALLOW);
    }
    #[tokio::test]
    async fn a_pane_with_no_control_token_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-3");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), None, &d).await,
            ALLOW,
            "a pane that cannot authenticate to its own daemon still hands out work"
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(degraded.count, 1, "the box says the gate was not operating");
        let said = degraded.last.clone().unwrap_or_default();
        assert!(
            said.detail.contains("no control capability"),
            "the mark must name the CAPABILITY as what was missing, or it cannot be told from \
             the socket simply not being there: {said:?}"
        );
        assert_eq!(
            said.source.as_deref(),
            Some("hook"),
            "the message is about the process that wrote it, and a mark that does not say which \
             process that was gets read as a statement about the master pane (ISS-1192): {said:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_daemon_that_refuses_the_question_itself_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-4");
        let sock = dir.path().join("control.sock");
        let listener = tokio::net::UnixListener::bind(&sock).expect("listener");
        tokio::spawn(async move {
            use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
            while let Ok((stream, _)) = listener.accept().await {
                let mut reader = BufReader::new(stream);
                let mut line = String::new();
                let _ = reader.read_line(&mut line).await;
                let reply = serde_json::json!({
                    "ok": false,
                    "reason": "unknown session token"
                })
                .to_string();
                let _ = reader
                    .get_mut()
                    .write_all(format!("{reply}\n").as_bytes())
                    .await;
            }
        });
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), Some(TOKEN), &d).await,
            ALLOW,
            "only the declaration's own refusal denies; every other ok:false is uncertainty"
        );
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 1,
            "an allowance the gate did not decide leaves a mark"
        );
        let why = degraded.last.clone().unwrap_or_default().detail;
        assert!(
            why.contains("refused the question itself"),
            "the daemon ANSWERED and its answer was a refusal of the question; a mark that does \
             not say so cannot be told from one the daemon never received: {why:?}"
        );
        assert!(
            why.contains("unknown session token"),
            "and the daemon's own words are carried through, so an operator learns WHY it \
             refused rather than only that it did: {why:?}"
        );
    }
}
