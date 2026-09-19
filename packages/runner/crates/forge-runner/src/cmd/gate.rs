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
use forge_runner_core::daemon::degraded::{mark, Kind};
use forge_runner_core::daemon::dispatch_gate::Dispatch;
use forge_runner_core::daemon::{control, session_tokens};

/// How long the daemon gets to answer before the dispatch goes through.
// cm:guard a SHORT bound, because this sits in front of every dispatch a master makes and the agent is blocked on it. A gate that hangs is a master that hangs, which is worse than the undeclared run it was trying to prevent.
const ANSWER_WITHIN: std::time::Duration = std::time::Duration::from_secs(2);

#[derive(ClapArgs)]
pub struct Args {
    /// The Claude Code hook event name. `PreToolUse` is the only one served.
    #[arg(long)]
    pub event: String,
}

/// Drain the hook payload and answer the agent, whatever else happens.
// cm:guard stdin is drained BEFORE anything can return, for the reason `hook.rs` carries: Claude Code writes the payload to this process's stdin, and a hook that exits without reading it hands the agent a broken pipe mid-write.
fn drain() -> Vec<u8> {
    use std::io::Read;
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    sink
}

/// What a `PreToolUse` payload turned out to be.
// cm:guard `Malformed` is its OWN answer and not folded into `NotADispatch`. Both allow the tool call, but one of them is this box failing to read what the harness sent — an uncertain allowance, which criterion 17 says must leave a mark — and the other is an ordinary `Read` that must stay silent or the marks become noise (ISS-1094, review F2).
pub enum Payload {
    /// An ordinary tool call. Almost all of them; this hook runs in front of every tool.
    NotADispatch,
    /// This box could not read the payload at all.
    Malformed,
    /// A subagent is about to be dispatched.
    Dispatch(Dispatch),
}

/// The dispatch this payload describes, where it describes one.
// cm:guard the reading is `tool_input.subagent_type` and NOT `tool_name`. Measured against claude 2.1.276 the dispatch tool is called `Agent`, and it has been called other things; the input names the role whatever the tool is called, so keying on the name would be a fixture that ages into a gate that never fires.
// cm:guard the whole of this runs BEFORE any socket is touched. `PreToolUse` fires on every tool call on the box, and a round trip per call would put the daemon's latency in front of every read a master makes.
// cm:guard `NotADispatch` is reserved for the shape this box UNDERSTOOD and found ordinary: an
// object whose `tool_input` is an object carrying no `subagent_type`. Every other shape — a payload
// that is not an object, a `tool_input` that is not one, a `subagent_type` that is not a string —
// is a payload this box could not read, and it is marked. Folding those into `NotADispatch` is how
// a harness that renames or re-types the field turns the gate off across the fleet with the
// degraded count sitting at zero, which is the same silence F2 was opened on one layer further in
// (ISS-1094, review F2 recheck).
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

/// What Claude Code reads back.
// cm:guard the deny shape is the one measured against claude 2.1.276 by running a hook that returned it and reading the refusal back out of the model's own answer, verbatim. A shape guessed from documentation is a gate that prints a refusal nothing enforces.
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

/// Ask the daemon, and say what to print.
///
/// The directory is a parameter and not resolved inside, which is the seam the
/// failure-path tests need: the socket is derived from it too, so a test
/// pointing at a temporary directory cannot reach the daemon actually running
/// on the machine and report its answer as the code's.
///
/// The token is a parameter for the same reason, and it was AMBIENT until
/// ISS-1094's re-judge. `FORGE_CONTROL_TOKEN` is set in any pane the daemon
/// spawned and unset on CI, so every test here asserted one thing on a
/// developer's box — where the token is present and the socket is reached — and
/// a different thing on CI, where this function returned at the token check
/// before the socket existed. Both were green. A test whose meaning depends on
/// an environment variable nobody passed it is not asserting what it says.
// cm:guard the socket is `dir/control.sock` rather than `control::socket_path()`, which is the same path by the same derivation — that function's own guard says the config dir is what separates two daemons on one box. Calling it here would resolve the REAL one under a test that was handed a temporary directory.
async fn answer(dir: Option<&Path>, token: Option<&str>, d: &Dispatch) -> String {
    let open_because = |why: &str| -> String {
        if let Some(dir) = dir {
            mark(dir, Kind::Degraded, why);
        }
        ALLOW.to_string()
    };
    let Some(token) = token else {
        return open_because("this pane carries no control capability, so nothing could be asked");
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
        // cm:guard the ONLY refusal that denies is the declaration's own. This socket answers
        // `ok:false` for an unknown token, an op it cannot decode, a session it cannot name — every
        // one of them an uncertain state, and denying on them turns a daemon this pane could not
        // authenticate to into a master that cannot dispatch anything. Certainty about the
        // declaration is what earns a denial; nothing else does (ISS-1094, review F5).
        Ok(Ok(reply)) => match reply.reason.as_deref() {
            Some(r) if r == forge_runner_core::daemon::dispatch_gate::REFUSAL => deny(r),
            Some(other) => {
                open_because(&format!("the daemon refused the question itself: {other}"))
            }
            None => open_because("the daemon refused the question itself and said nothing"),
        },
    }
}

/// Answer one `PreToolUse`. Never fails, by construction.
// cm:guard returns `()` and holds no `?`, `unwrap` or `expect`, exactly as `hook::run` does, and the source test below is what keeps it that way. A panic here is a non-zero exit in the agent's critical path.
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
                    Kind::Degraded,
                    "a PreToolUse payload this box could not read at all",
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
    struct Scratch(std::path::PathBuf);

    /// The `sockaddr_un.sun_path` budget: 104 bytes on macOS against 108 on Linux.
    const SUN_LEN: usize = 104;

    impl Scratch {
        // cm:guard the base is `/tmp` and NOT `std::env::temp_dir()`, because a socket binds under
        // this directory. On macOS that helper answers `/var/folders/<hash>/<hash>/T/`, and the
        // old form here came to 100 bytes against a limit of 104 — it was passing the macos leg by
        // four characters, and the next test name one word longer would have failed at `bind` with
        // `InvalidInput` before any assertion ran. The sibling door test crossed that line for
        // real on 2026-09-18 (ISS-1094).
        fn new(name: &str) -> Self {
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for b in name
                .as_bytes()
                .iter()
                .chain(format!("{:?}", std::thread::current().id()).as_bytes())
            {
                h ^= u64::from(*b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
            let base = if std::path::Path::new("/tmp").is_dir() {
                std::path::PathBuf::from("/tmp")
            } else {
                std::env::temp_dir()
            };
            let p = base.join(format!("fgg-{}-{h:x}", std::process::id()));
            assert!(
                p.join("control.sock").as_os_str().len() < SUN_LEN,
                "a socket under this scratch would not fit in sun_path ({SUN_LEN}): {}",
                p.display()
            );
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).expect("scratch");
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
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

    /// The real payload, observed from claude 2.1.276 on 2026-09-18 by
    /// registering this hook and running one session that dispatched a
    /// subagent. Trimmed to the fields this verb reads.
    // cm:guard OBSERVED and not composed, the same rule `hook.rs`'s fixtures carry and for the same reason: two commits once shipped a wrong model of a payload read off the consuming side.
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

    /// Criterion 11.
    // cm:guard the two are told APART here, which is the whole of review F2: both allow the tool call, and only one of them is this box failing to read what it was sent.
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

    /// Criteria 14, 15, 17. A socket that exists and answers nothing useful is
    /// the shape a wedged or half-started daemon presents, and it must cost the
    /// master the bound and nothing more.
    // cm:guard gated `unix` because it BINDS a unix socket, and for no wider reason. What Windows
    // actually does is not skipped with it: `request_dispatch_gate` has a `#[cfg(not(unix))]` arm
    // returning `Err(no_socket())`, so on Windows every dispatch takes the no-socket path — which
    // `no_control_socket_opens_the_gate_and_leaves_a_mark` asserts, ungated, on every platform.
    // A `cfg` that hid the gate's behaviour rather than one socket call would leave this issue's
    // whole deliverable untested on two of three legs while CI reported pass (ISS-1094).
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
    /// Criterion 12, at last exercised. `FORGE_CONTROL_TOKEN` is set in every
    /// pane the daemon spawned and unset on CI, so before this test the no-token
    /// arm was reached by accident on one and by nothing on the other.
    // cm:guard the token is passed as `None` rather than removed from the environment. A test that
    // mutates a process-global variable to make its point is a test the next parallel test reads,
    // and the failure that produces is a different test going red for no reason anyone can see.
    #[tokio::test]
    async fn a_pane_with_no_control_token_opens_the_gate_and_leaves_a_mark() {
        let dir = Scratch::new("gateverb-3");
        let d = as_dispatch(DISPATCH);
        assert_eq!(
            answer(Some(dir.path()), None, &d).await,
            ALLOW,
            "a pane that cannot authenticate to its own daemon still hands out work"
        );
        // cm:guard the REASON is asserted and not merely the count. This scratch has no
        // `control.sock`, so deleting the token arm drops through to the socket-missing arm, which
        // returns the same `ALLOW` and writes the same single mark: a count-only assertion holds
        // "some arm above here allowed" rather than this criterion, and stays green with the arm
        // it names deleted. Measured: `let token = token.unwrap_or("")` kept all 41 tests green
        // (ISS-1094, retrospective review of #518).
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(degraded.count, 1, "the box says the gate was not operating");
        assert!(
            degraded
                .last
                .as_deref()
                .unwrap_or_default()
                .contains("no control capability"),
            "the mark must name the CAPABILITY as what was missing, or it cannot be told from \
             the socket simply not being there: {:?}",
            degraded.last
        );
    }

    /// Criterion 14. The daemon answered, and its answer was a refusal of the
    /// QUESTION rather than of the dispatch.
    // cm:guard the reason here is deliberately NOT `REFUSAL`. An unknown token, an op the daemon
    // cannot decode, a session it cannot name: each answers `ok:false`, each is an uncertain state,
    // and denying on any of them turns a daemon this pane could not authenticate to into a master
    // that cannot dispatch anything. Only the declaration's own refusal denies (ISS-1094).
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
        // cm:guard the reason is asserted, because the count cannot tell this arm from the one
        // above it. A stub that writes an empty line instead of its body takes the
        // `Ok(Err(..))` parse-failure arm, allows, marks once, and this test passed in 0.00s
        // against it: the gate frame and the daemon's `Request` enum could drift until every
        // dispatch failed to parse and nothing here would go red (ISS-1094, retrospective review
        // of #518).
        let (degraded, _) = forge_runner_core::daemon::degraded::tally(dir.path());
        assert_eq!(
            degraded.count, 1,
            "an allowance the gate did not decide leaves a mark"
        );
        let why = degraded.last.clone().unwrap_or_default();
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
