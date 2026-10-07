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

use std::ffi::OsStr;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use forge_runner_core::daemon::dispatch_gate::REFUSAL;
use forge_runner_core::daemon::hook_install;

const DISPATCH_PAYLOAD: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","transcript_path":"/x.jsonl","cwd":"/tmp/x","prompt_id":"5f063c37","permission_mode":"bypassPermissions","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Agent","tool_input":{"description":"Take ISS-12","prompt":"work it","subagent_type":"forge:runner","run_in_background":false},"tool_use_id":"toolu_01WFynvjwEmYFcgyKTMn4J91"}"#;

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

/// A process started with HOME, the data dir and the config dir inside `root`, which is how every
/// process this file starts is made (ISS-1344): `forge-runner status` resolves the ledger, and
/// started with the test's own environment it read the invoking user's live one. On macOS the
/// config dir follows HOME, so `XDG_CONFIG_HOME` is removed there rather than pointed anywhere.
fn scoped(program: impl AsRef<OsStr>, root: &Path) -> Command {
    let mut cmd = Command::new(program);
    cmd.env_remove("XDG_CONFIG_HOME")
        .env("HOME", root)
        .env("XDG_DATA_HOME", root.join("data"))
        .env(config_home_at(root).0, root);
    cmd
}

fn run_gate(command: &str, config_home: &Path, payload: &str) -> String {
    let mut child = scoped("sh", config_home)
        .arg("-c")
        .arg(command)
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
    assert_eq!(sent["subagentType"], "forge:runner");
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

    let out = scoped(env!("CARGO_BIN_EXE_forge-runner"), scratch.path())
        .arg("status")
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
        !printed.contains("/day"),
        "forty marks written in one instant carry no rate, and extrapolating one from them is \
         how two marks in five minutes read as 494 a day (ISS-1324): {printed}"
    );
    assert!(
        printed.contains("under the 1h a rate needs"),
        "a window too short for a rate says so and names the minimum: {printed}"
    );
    assert!(
        !printed.contains("epoch+"),
        "a window stated in epoch seconds is one nobody reads: {printed}"
    );
}

/// ISS-1324. A file holding at least what a trim keeps prints its count as a
/// floor, over a window long enough to carry a rate, and never claims the file
/// is at its cap when it is not.
#[test]
fn status_prints_a_count_that_may_be_a_floor_as_one() {
    let scratch = Scratch::new("floor");
    let config_dir = config_dir_at(scratch.path());
    let now = forge_runner_core::daemon::agent_activity::now_ms();
    let lines: Vec<String> = (0..260)
        .map(|i| {
            serde_json::json!({
                "at": now - 2 * 3_600_000 + i * 20_000,
                "kind": "degraded",
                "source": "hook",
                "detail": "the daemon did not answer within the bound",
                "run_unknown": "the hook holds no registry of declared runs",
            })
            .to_string()
        })
        .collect();
    std::fs::write(
        forge_runner_core::daemon::degraded::marks_path(&config_dir),
        lines.join("\n") + "\n",
    )
    .expect("plant the marks");

    let out = scoped(env!("CARGO_BIN_EXE_forge-runner"), scratch.path())
        .arg("status")
        .output()
        .expect("status runs");
    let printed = String::from_utf8_lossy(&out.stdout);
    assert!(
        printed.contains("degraded   at least 260 dispatch(es)"),
        "a count that may have lost its oldest marks is a floor and says so where it is \
         stated: {printed}"
    );
    assert!(printed.contains("/day over"), "{printed}");
    assert!(
        printed.contains("at least the 250 lines a trim keeps"),
        "{printed}"
    );
    assert!(
        !printed.contains("at its cap"),
        "260 lines of a 500-line file is not its cap: {printed}"
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

/// The registered command run with no capability and no tmux around it: a
/// Claude Code session the daemon never placed, standing in a Forge checkout.
fn run_gate_tokenless(command: &str, config_home: &Path, payload: &str) -> String {
    run_gate_tokenless_in(command, config_home, payload, &[])
}

/// As [`run_gate_tokenless`], with `tmux` set in the child's environment.
fn run_gate_tokenless_in(
    command: &str,
    config_home: &Path,
    payload: &str,
    tmux: &[(&str, &str)],
) -> String {
    let mut cmd = scoped("sh", config_home);
    cmd.arg("-c")
        .arg(command)
        .env_remove("FORGE_CONTROL_TOKEN")
        .env_remove("TMUX")
        .env_remove("TMUX_PANE");
    for (k, v) in tmux {
        cmd.env(k, v);
    }
    let mut child = cmd
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
    assert!(out.status.success(), "{:?}", out.status);
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// ISS-1316 criterion 17, through the door: a session the daemon never placed
/// is let through and leaves no mark saying the gate stopped gating.
#[test]
fn a_session_the_daemon_never_placed_is_let_through_unmarked() {
    let scratch = Scratch::new("notours");
    let config_dir = config_dir_at(scratch.path());
    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let printed = run_gate_tokenless(&command, scratch.path(), DISPATCH_PAYLOAD);
    assert_eq!(printed, "{}");
    assert!(
        !config_dir.join("gate-marks.jsonl").exists(),
        "a session that was never the gate's subject is not counted as one it failed to decide"
    );
}

/// The dispatch that wrote 120 of the 128 tokenless marks on sid-xeon-1
/// (ISS-1324): a `forge:qa` hand-off from a dispatcher session an operator
/// opened by hand, inside a tmux of their own rather than the runner's. It is
/// let through, and it leaves no mark saying the gate failed to decide.
#[test]
fn a_dispatcher_in_an_operators_own_tmux_is_let_through_unmarked() {
    let scratch = Scratch::new("own-tmux");
    let config_dir = config_dir_at(scratch.path());
    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let operators = scratch.path().join("operator-tmux.sock");
    let tmux = format!("{},4242,0", operators.display());
    let payload = DISPATCH_PAYLOAD
        .replace("forge:runner", "forge:qa")
        .replace(
            "toolu_01WFynvjwEmYFcgyKTMn4J91",
            "toolu_019jNBi5r24A5qSegdsbABYP",
        );
    let printed = run_gate_tokenless_in(
        &command,
        scratch.path(),
        &payload,
        &[("TMUX", &tmux), ("TMUX_PANE", "%3")],
    );
    assert_eq!(printed, "{}");
    assert!(
        !config_dir.join("gate-marks.jsonl").exists(),
        "an operator's own session was never the gate's subject, and counting it as a gate that \
         could not decide is what put 409 marks on a box whose gate was deciding"
    );
}

/// A tmux server of this test's own, at the socket the gate resolves as the
/// runner's for `config_home`, running the gate inside a session named `pane`.
///
/// `None` where this box cannot host one, after failing the test instead
/// wherever the run promised tmux (`FORGE_TEST_REQUIRE_TMUX` set and not
/// empty, as CI sets it on Linux; on the other runners CI sets it empty).
fn gate_in_a_runner_pane(config_home: &Path, pane: &str, payload: &str) -> Option<String> {
    let skip = |why: &str| {
        #[expect(
            clippy::disallowed_methods,
            reason = "FORGE_TEST_REQUIRE_TMUX, whether this test run promised a tmux"
        )]
        let promised = std::env::var_os("FORGE_TEST_REQUIRE_TMUX").is_some_and(|v| !v.is_empty());
        assert!(
            !promised,
            "{why}, and FORGE_TEST_REQUIRE_TMUX promised this run a tmux to drive"
        );
        eprintln!("skipped: {why}");
        None
    };
    if cfg!(target_os = "macos") {
        return skip("macOS resolves the tmux socket outside the config home a test can set");
    }
    if scoped("tmux", config_home).arg("-V").output().is_err() {
        return skip("tmux is not installed here");
    }
    let dir = config_dir_at(config_home);
    let sock = dir.join("tmux.sock");
    let input = config_home.join("payload.json");
    let output = config_home.join("printed.json");
    std::fs::write(&input, payload).expect("payload");
    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let script = format!(
        "env -u FORGE_CONTROL_TOKEN {}='{}' sh -c '{}' < '{}' > '{}.part' && mv '{}.part' '{}'",
        config_home_at(config_home).0,
        config_home.display(),
        command.replace('\'', r"'\''"),
        input.display(),
        output.display(),
        output.display(),
        output.display(),
    );
    let started = scoped("tmux", config_home)
        .arg("-S")
        .arg(&sock)
        .args(["new-session", "-d", "-s", pane, "sh", "-c", &script])
        .env_remove("TMUX")
        .env_remove("FORGE_CONTROL_TOKEN")
        .status()
        .expect("tmux runs");
    assert!(
        started.success(),
        "the runner-shaped tmux server must start"
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let printed = loop {
        if let Ok(text) = std::fs::read_to_string(&output) {
            break text;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the gate inside the pane printed nothing within the bound"
        );
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    let _ = scoped("tmux", config_home)
        .arg("-S")
        .arg(&sock)
        .arg("kill-server")
        .stderr(Stdio::null())
        .status();
    Some(printed.trim().to_string())
}

fn record_for(config_home: &Path, pane: &str, project: &str) {
    record_with_slug(config_home, pane, project, None);
}

/// A capability record as the daemon writes it at placement; `slug: None` is
/// the shape 0.17.72 wrote, before records carried one.
fn record_with_slug(config_home: &Path, pane: &str, project: &str, slug: Option<&str>) {
    let mut record = serde_json::json!({ "session": "sess-e2e", "project": project, "pane": pane });
    if let Some(slug) = slug {
        record["slug"] = serde_json::json!(slug);
    }
    let map = serde_json::json!({ "tok-that-never-arrived": record });
    std::fs::write(
        config_dir_at(config_home).join("control-tokens.json"),
        map.to_string(),
    )
    .expect("the capability map");
}

/// ISS-1316 criterion 16, through the door and a real tmux server: a pane
/// the daemon placed, whose capability never reached its environment.
#[test]
fn a_runner_pane_whose_capability_never_arrived_is_refused_by_name() {
    let scratch = Scratch::new("lostmint");
    record_with_slug(scratch.path(), "forge-master-e2e", "proj-e2e", Some("e2e"));
    let Some(printed) = gate_in_a_runner_pane(scratch.path(), "forge-master-e2e", DISPATCH_PAYLOAD)
    else {
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&printed).expect("the gate printed json");
    let out = &v["hookSpecificOutput"];
    assert_eq!(out["permissionDecision"], "deny", "{printed}");
    let why = out["permissionDecisionReason"].as_str().unwrap_or("");
    assert!(
        why.contains("forge-master-e2e") && why.contains("project e2e"),
        "the refusal names the pane, and its project by the slug an operator types (criterion 16): {why}"
    );
    assert!(
        why.contains("`forge-runner master kill e2e`") && !why.contains("<slug>"),
        "and the command that ends it, with the slug filled in (criterion 21): {why}"
    );
}

/// ISS-1316 criterion 22, through the door: a job pane is told the command
/// that ends it on the runner's own tmux server, every value filled in.
#[test]
fn a_job_pane_whose_capability_never_arrived_is_told_the_command_that_ends_it() {
    let scratch = Scratch::new("lostjob");
    record_with_slug(scratch.path(), "forge-job-j42", "proj-e2e", Some("e2e"));
    let Some(printed) = gate_in_a_runner_pane(scratch.path(), "forge-job-j42", DISPATCH_PAYLOAD)
    else {
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&printed).expect("the gate printed json");
    let out = &v["hookSpecificOutput"];
    assert_eq!(out["permissionDecision"], "deny", "{printed}");
    let why = out["permissionDecisionReason"].as_str().unwrap_or("");
    let sock = config_dir_at(scratch.path()).join("tmux.sock");
    assert!(
        why.contains(&format!(
            "`tmux -S '{}' kill-session -t '=forge-job-j42'`",
            sock.display()
        )),
        "a job pane has no `master kill`, so it is told the command that reaches the runner's own server: {why}"
    );
    assert!(
        !why.contains('<') && why.contains("project e2e"),
        "with nothing left for the operator to fill in: {why}"
    );
}

/// ISS-1316 criterion 23, through the door: a record 0.17.72 wrote carries no
/// slug, so the project is named by its id and the command ends the pane itself.
#[test]
fn a_pane_whose_record_carries_no_slug_is_still_told_a_command_it_can_run() {
    let scratch = Scratch::new("lostnoslug");
    record_for(scratch.path(), "forge-master-e2e", "proj-e2e");
    let Some(printed) = gate_in_a_runner_pane(scratch.path(), "forge-master-e2e", DISPATCH_PAYLOAD)
    else {
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&printed).expect("the gate printed json");
    let out = &v["hookSpecificOutput"];
    assert_eq!(out["permissionDecision"], "deny", "{printed}");
    let why = out["permissionDecisionReason"].as_str().unwrap_or("");
    let sock = config_dir_at(scratch.path()).join("tmux.sock");
    assert!(
        why.contains("proj-e2e")
            && why.contains(&format!(
                "`tmux -S '{}' kill-session -t '=forge-master-e2e'`",
                sock.display()
            ))
            && !why.contains('<'),
        "no slug to name, so the project by its id and a command needing none: {why}"
    );
}

/// ISS-1316 criterion 19, through the door: a session on the runner's server
/// that no record names is let through and named in the mark it leaves.
#[test]
fn a_runner_pane_no_record_names_is_let_through_and_named() {
    let scratch = Scratch::new("unrecorded");
    record_for(scratch.path(), "forge-master-someone-else", "proj-e2e");
    let Some(printed) =
        gate_in_a_runner_pane(scratch.path(), "forge-master-unrecorded", DISPATCH_PAYLOAD)
    else {
        return;
    };
    assert_eq!(printed, "{}");
    let marks = std::fs::read_to_string(config_dir_at(scratch.path()).join("gate-marks.jsonl"))
        .expect("a degraded admission leaves a mark");
    assert!(
        marks.contains("forge-master-unrecorded") && marks.contains("\"degraded\""),
        "{marks}"
    );
}

const DIALOG_PAYLOAD: &str = r#"{"session_id":"d5953edb-97bc-42b8-891d-206e105903d7","transcript_path":"/x.jsonl","cwd":"/tmp/x","permission_mode":"bypassPermissions","hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_input":{"questions":[{"question":"Merge PR #836 now?","header":"PR #836","options":[{"label":"Merge","description":"land it"},{"label":"Hold","description":"wait"}],"multiSelect":false}]},"tool_use_id":"toolu_01Dialog"}"#;

/// ISS-1385 criterion 15: a dialog planted in a master pane on a runner-shaped
/// tmux server is refused by the registered command, naming the route.
#[test]
fn a_dialog_opened_in_a_master_pane_is_refused_naming_the_route() {
    use forge_runner_core::daemon::master_question::{ROUTE_LATER, ROUTE_OPEN};
    let scratch = Scratch::new("dialog");
    let Some(printed) = gate_in_a_runner_pane(scratch.path(), "forge-master-e2e", DIALOG_PAYLOAD)
    else {
        return;
    };
    let v: serde_json::Value = serde_json::from_str(&printed).expect("the gate printed json");
    let out = &v["hookSpecificOutput"];
    assert_eq!(out["permissionDecision"], "deny", "{printed}");
    let why = out["permissionDecisionReason"].as_str().unwrap_or("");
    assert!(
        why.contains("never waits in a dialog")
            && why.contains(ROUTE_OPEN)
            && why.contains(ROUTE_LATER),
        "the refusal names the rule and the route: {why}"
    );
}

/// ISS-1385 criterion 7: a job pane's dialog is not this rule's subject.
#[test]
fn a_dialog_opened_in_a_job_pane_is_let_through_unmarked() {
    let scratch = Scratch::new("dialogjob");
    let Some(printed) = gate_in_a_runner_pane(scratch.path(), "forge-job-j42", DIALOG_PAYLOAD)
    else {
        return;
    };
    assert_eq!(printed, "{}");
    assert!(!config_dir_at(scratch.path())
        .join("gate-marks.jsonl")
        .exists());
}

/// ISS-1385 criterion 6: a person's own session is never this rule's subject.
#[test]
fn a_dialog_opened_off_the_runners_server_is_let_through_unmarked() {
    let scratch = Scratch::new("dialogoff");
    let config_dir = config_dir_at(scratch.path());
    let command = registered_gate_command(env!("CARGO_BIN_EXE_forge-runner"));
    let printed = run_gate_tokenless(&command, scratch.path(), DIALOG_PAYLOAD);
    assert_eq!(printed, "{}");
    assert!(!config_dir.join("gate-marks.jsonl").exists());
}

/// ISS-1344 criterion 16. Every process this file starts is made by `scoped`, and `scoped` puts
/// HOME and the data dir inside the scratch and the config dir inside it or nowhere. A process
/// started any other way inherits the test's own environment, and a `status` child then reads
/// the invoking user's ledger, which no other assertion in this file would notice.
#[test]
fn every_process_this_file_starts_is_scoped_to_its_scratch() {
    let src = forge_runner_core::test_scratch::lf(include_str!("dispatch_gate_door.rs"));
    let new = concat!("Command::", "new(");
    let helper = src
        .split("fn scoped(")
        .nth(1)
        .and_then(|r| r.split("\n}").next())
        .expect("scoped is in this file");
    assert!(
        helper.contains(new) && src.matches(new).count() == 1,
        "a process this file starts outside `scoped` takes the test's own HOME, config and data \
         dirs: start it through `scoped`"
    );

    let scratch = Scratch::new("scoped");
    let cmd = scoped("true", scratch.path());
    let set: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
    let value = |name: &str| set.iter().find(|(k, _)| *k == name).map(|(_, v)| *v);
    let inside = |v: Option<Option<&OsStr>>| {
        v.flatten()
            .is_some_and(|v| Path::new(v).starts_with(scratch.path()))
    };
    for name in ["HOME", "XDG_DATA_HOME"] {
        assert!(
            inside(value(name)),
            "{name} is not inside the scratch: {set:?}"
        );
    }
    let config = value("XDG_CONFIG_HOME");
    assert!(
        inside(config) || config == Some(None),
        "XDG_CONFIG_HOME is neither inside the scratch nor removed: {set:?}"
    );
}
