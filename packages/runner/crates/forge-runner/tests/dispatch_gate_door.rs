//! The door, exercised as a door: the command `hook_install` itself generates,
//! run as a process, fed a `PreToolUse` payload observed from claude, answering
//! on stdout.
//!
//! This exists because every other test in this change can be green while no
//! dispatch on the fleet ever reaches the gate. `dispatch_gate::decide` proves
//! the decision, `hook_install` proves the registration, and neither proves
//! that the registered string names a verb that exists, takes that event, parses
//! that payload, speaks the frame the daemon deserialises, or prints something
//! Claude Code reads as a refusal. A run on ISS-1075 found exactly that shape —
//! a criterion about reaching code through a door that stayed green when the
//! door was removed.
//!
//! What is stubbed here is the daemon's ANSWER and nothing else. The stub
//! asserts the frame it received is the one the daemon's own `Request` names,
//! so a gate that spoke a shape the daemon cannot read fails here rather than
//! at three in the morning on a box.
//!
//! # The one platform this file cannot speak for
//!
//! The door IS a unix socket, so this file stands the daemon up on one and
//! cannot run where there is none. That is a named limitation, not a narrowing
//! to reach green: what Windows does is covered, ungated, in `cmd::gate`'s own
//! tests. `control::request_dispatch_gate` has a `#[cfg(not(unix))]` arm
//! returning `Err(no_socket())`, so on Windows EVERY dispatch takes the
//! no-socket path, and `no_control_socket_opens_the_gate_and_leaves_a_mark`
//! asserts that path allows the tool call and writes a degraded mark on every
//! platform this crate builds for.

#![cfg(unix)]

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use forge_runner_core::daemon::dispatch_gate::REFUSAL;
use forge_runner_core::daemon::hook_install;

const DISPATCH_PAYLOAD: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","transcript_path":"/x.jsonl","cwd":"/tmp/x","prompt_id":"5f063c37","permission_mode":"bypassPermissions","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Take ISS-12","prompt":"work it","subagent_type":"runner","run_in_background":false},"tool_use_id":"toolu_01WFynvjwEmYFcgyKTMn4J91"}"#;

struct Scratch(forge_runner_core::test_scratch::Scratch);

/// The `sockaddr_un.sun_path` budget. macOS gives 104 bytes where Linux gives 108, and a unix
/// socket whose path does not fit fails at `bind` with `InvalidInput`, before a single assertion in
/// this file runs.
const SUN_LEN: usize = 104;

impl Scratch {
    /// `name` is for the reader of the test: the shared counter is what keeps two apart.
    fn new(_name: &str) -> Self {
        // The budget is asserted in `config_dir_at`, against the path a socket is ACTUALLY bound
        // at — this root plus whatever the platform's config layout adds to it. Checking it here,
        // against the root alone, would pass while the real path was 28 bytes longer on macos.
        Self(forge_runner_core::test_scratch::Scratch::short("gd"))
    }
    fn path(&self) -> &Path {
        self.0.path()
    }
}

/// The `PreToolUse` command the installer writes into a pane's settings.
///
/// Read back out of the generated document rather than rebuilt here, so a
/// change to how it is registered reaches this test instead of going around it.
fn registered_gate_command(exe: &str) -> String {
    let doc: serde_json::Value =
        serde_json::from_str(&hook_install::merged(None, exe).expect("settings")).expect("json");
    doc["hooks"][hook_install::GATE_EVENT]
        .as_array()
        .expect("the gate event has entries")
        .iter()
        .filter_map(|e| e["hooks"][0]["command"].as_str())
        .find(|c| c.contains(" gate "))
        .expect("a gate command among the registered PreToolUse hooks")
        .to_string()
}

/// A socket that answers one gate frame the way a daemon with nothing declared
/// would, and reports the frame it was actually sent.
fn daemon_that_refuses(dir: &Path) -> std::sync::mpsc::Receiver<String> {
    let listener = UnixListener::bind(dir.join("control.sock")).expect("bind");
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line);
        let reply = serde_json::json!({ "ok": false, "reason": REFUSAL }).to_string();
        let _ = writeln!(reader.get_mut(), "{reply}");
    });
    rx
}

fn config_home_at(root: &Path) -> (&'static str, PathBuf) {
    if cfg!(target_os = "macos") {
        (
            "HOME",
            root.join("Library/Application Support/forge-runner"),
        )
    } else {
        ("XDG_CONFIG_HOME", root.join("forge-runner"))
    }
}

/// The config directory a child spawned with `config_home_at(root)` will use, created and checked
/// against the socket budget.
fn config_dir_at(root: &Path) -> PathBuf {
    let (_, dir) = config_home_at(root);
    std::fs::create_dir_all(&dir).expect("config dir");
    let sock = dir.join("control.sock");
    assert!(
        sock.as_os_str().len() < SUN_LEN,
        "this test's socket path is {} bytes and must be under {SUN_LEN}, or `bind` refuses it \
         with InvalidInput before any assertion here runs: {}",
        sock.as_os_str().len(),
        sock.display()
    );
    dir
}

fn run_gate(command: &str, config_home: &Path, payload: &str) -> String {
    let mut child = Command::new("sh")
        .arg("-c")
        .arg(command)
        .env(config_home_at(config_home).0, config_home)
        .env("FORGE_CONTROL_TOKEN", "a-token-the-daemon-minted")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("the registered command must name a verb that exists");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(payload.as_bytes())
        .expect("write payload");
    let out = child.wait_with_output().expect("wait");
    assert!(
        out.status.success(),
        "a hook that exits non-zero is read by Claude Code as the hook itself breaking, \
         never as a refusal: {:?}",
        out.status
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Criterion 21. The whole route, end to end.
#[test]
fn the_registered_command_refuses_an_undeclared_dispatch() {
    let scratch = Scratch::new("refuse");
    // The directory the gate derives its socket and its marks from, per platform.
    let config_dir = config_dir_at(scratch.path());
    let frame = daemon_that_refuses(&config_dir);

    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let printed = run_gate(&command, scratch.path(), DISPATCH_PAYLOAD);

    let sent: serde_json::Value = serde_json::from_str(
        &frame
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("the gate must speak to the socket"),
    )
    .expect("the frame must be json the daemon can read");
    assert_eq!(sent["op"], "dispatch_gate");
    assert_eq!(sent["subagentType"], "runner");
    assert_eq!(sent["toolUseId"], "toolu_01WFynvjwEmYFcgyKTMn4J91");
    assert!(
        sent["agentId"].is_null(),
        "the master's own dispatch names no child: {sent}"
    );

    let decision: serde_json::Value = serde_json::from_str(&printed).expect("the gate prints json");
    assert_eq!(
        decision["hookSpecificOutput"]["permissionDecision"], "deny",
        "the dispatch reached the gate and was not refused: {printed}"
    );
    let reason = decision["hookSpecificOutput"]["permissionDecisionReason"]
        .as_str()
        .unwrap_or_default();
    assert!(
        reason.contains("forge-runner run declare"),
        "a refusal that does not say what to do is the same silence in a louder font: {reason}"
    );
}

/// Criteria 13, 17. The same command, the same payload, no daemon: the dispatch
/// goes through, and the box records that the gate was not operating.
#[test]
fn the_registered_command_opens_the_gate_when_no_daemon_answers() {
    let scratch = Scratch::new("open");
    let config_dir = config_dir_at(scratch.path());

    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let printed = run_gate(&command, scratch.path(), DISPATCH_PAYLOAD);
    assert_eq!(printed, "{}", "a gate that cannot ask must not refuse");

    let (degraded, _) = forge_runner_core::daemon::degraded::tally(&config_dir);
    assert_eq!(
        degraded.count, 1,
        "a gate that opened without deciding must leave a mark an operator can read"
    );
}

/// An ordinary tool call is not a dispatch and must never reach the socket.
#[test]
fn an_ordinary_tool_call_costs_the_master_no_round_trip() {
    let scratch = Scratch::new("ordinary");
    let config_dir = config_dir_at(scratch.path());
    // A socket that would refuse if it were ever asked.
    let frame = daemon_that_refuses(&config_dir);

    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let printed = run_gate(
        &command,
        scratch.path(),
        r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/x"},"tool_use_id":"toolu_03"}"#,
    );
    assert_eq!(printed, "{}");
    assert!(
        frame
            .recv_timeout(std::time::Duration::from_millis(300))
            .is_err(),
        "a read is not a hand-off and must not pay for the daemon's latency"
    );
    let (degraded, _) = forge_runner_core::daemon::degraded::tally(&config_dir);
    assert_eq!(
        degraded.count, 0,
        "a tool call that is not a dispatch is not a degraded gate"
    );
}

#[test]
fn status_prints_what_the_gate_could_not_do() {
    let scratch = Scratch::new("status");
    let config_dir = config_dir_at(scratch.path());
    use forge_runner_core::daemon::degraded::{Kind, Mark, Run, Source};
    for _ in 0..40 {
        forge_runner_core::daemon::degraded::mark(
            &config_dir,
            &Mark::new(
                Kind::Undeclared,
                Source::Daemon,
                "subagent child-9 started as `runner` with nothing declared for it",
                Run::Unknown("nothing was declared for it"),
            ),
        );
        forge_runner_core::daemon::degraded::mark(
            &config_dir,
            &Mark::new(
                Kind::Degraded,
                Source::Hook,
                "the daemon did not answer within the bound",
                Run::Unknown("the hook holds no registry of declared runs"),
            ),
        );
    }

    let out = Command::new(env!("CARGO_BIN_EXE_forge-runner"))
        .arg("status")
        .env(config_home_at(scratch.path()).0, scratch.path())
        .output()
        .expect("status runs");
    let printed = String::from_utf8_lossy(&out.stdout);
    assert!(
        printed.contains("undeclared 40"),
        "a hand-off nothing declared must reach an operator: {printed}"
    );
    assert!(
        printed.contains("degraded   40"),
        "a gate that could not decide must reach an operator: {printed}"
    );
    assert!(printed.contains("child-9"), "{printed}");
    assert!(
        printed.contains("/day over"),
        "the count has to arrive as a rate over a window or it reads as history: {printed}"
    );
    assert!(
        !printed.contains("epoch+"),
        "a window stated in epoch seconds is one nobody reads: {printed}"
    );
}

/// Review F2. Malformed stdin is an uncertain allowance and is marked; an
/// ordinary tool call is not a failure and stays silent. Both run the real
/// registered command.
#[test]
fn a_payload_this_box_cannot_read_is_allowed_and_marked() {
    let scratch = Scratch::new("malformed");
    let config_dir = config_dir_at(scratch.path());

    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    assert_eq!(
        run_gate(&command, scratch.path(), "{ not json at all"),
        "{}"
    );
    let (degraded, _) = forge_runner_core::daemon::degraded::tally(&config_dir);
    assert_eq!(
        degraded.count, 1,
        "a payload this box could not read is the gate not operating, and must say so"
    );

    assert_eq!(
        run_gate(
            &command,
            scratch.path(),
            r#"{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/x"},"tool_use_id":"t"}"#
        ),
        "{}"
    );
    let (degraded, _) = forge_runner_core::daemon::degraded::tally(&config_dir);
    assert_eq!(
        degraded.count, 1,
        "an ordinary tool call is not a failure; marking it would bury the ones that are"
    );
}
