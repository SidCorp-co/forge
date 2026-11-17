//! The interrupt and the steered message as Claude Code reads them, and an interrupt ending a
//! running turn in a stand-in session that answers it as 2.1.322 does.
use super::*;

#[test]
fn the_interrupt_is_the_control_request_claude_code_answers() {
    let line = interrupt_line("interrupt-3");
    assert!(line.ends_with('\n'));
    let v: Value = serde_json::from_str(line.trim()).unwrap();
    assert_eq!(v["type"], "control_request");
    assert_eq!(v["request"]["subtype"], "interrupt");
    assert_eq!(v["request_id"], "interrupt-3");
}

#[test]
fn a_steered_message_carries_its_priority() {
    let now: Value = serde_json::from_str(steer_line("stop", Priority::Now).trim()).unwrap();
    assert_eq!(now["priority"], "now");
    assert_eq!(now["message"]["content"][0]["text"], "stop");
    let next: Value = serde_json::from_str(steer_line("then", Priority::Next).trim()).unwrap();
    assert_eq!(next["priority"], "next");
    assert!(
        Priority::parse("later").is_err(),
        "a priority this box does not send is refused"
    );
}

/// Plays Claude Code 2.1.322 over stream-json: the first turn streams text deltas until an
/// `interrupt` control request, answered `success` and ended by an `aborted_streaming` result as
/// the real CLI does; every later message is answered with a result. Logs each stdin line.
const STAND_IN: &str = r#"
import json, sys, threading, time
log = open(sys.argv[1], "a")
def out(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
streaming = threading.Event(); streaming.set()
def stream():
    out({"type": "system", "subtype": "init", "session_id": "stand-in"})
    out({"type": "user", "isReplay": True, "message": {"role": "user", "content": [{"type": "text", "text": "first"}]}})
    while streaming.is_set():
        out({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "tea "}}})
        time.sleep(0.05)
threading.Thread(target=stream, daemon=True).start()
for line in sys.stdin:
    log.write(line); log.flush()
    msg = json.loads(line)
    if msg.get("type") == "control_request" and msg["request"]["subtype"] == "interrupt":
        streaming.clear()
        out({"type": "control_response", "response": {"subtype": "success", "request_id": msg["request_id"], "response": {"still_queued": []}}})
        out({"type": "result", "subtype": "error_during_execution", "is_error": True, "terminal_reason": "aborted_streaming", "session_id": "stand-in"})
    elif msg.get("type") == "user":
        out({"type": "user", "isReplay": True, "message": msg["message"]})
        out({"type": "assistant", "message": {"content": [{"type": "text", "text": "it was tea"}]}})
        out({"type": "result", "subtype": "success", "is_error": False, "terminal_reason": "completed", "session_id": "stand-in"})
"#;

async fn next_terminal(rx: &mut mpsc::Receiver<RunnerEvent>) -> RunnerEvent {
    loop {
        match rx.recv().await {
            Some(ev @ (RunnerEvent::Done | RunnerEvent::Failed { .. })) => return ev,
            Some(_) => {}
            None => panic!("the turn's sink closed before it ended"),
        }
    }
}

/// ISS-1268 A3: Stop writes the interrupt into the running turn, the turn ends as asked within 2 s,
/// and the same process answers the next message.
#[tokio::test]
async fn an_interrupt_ends_the_running_turn_and_the_session_answers_the_next_message() {
    let dir = std::env::temp_dir().join(format!("iss1268-stand-in-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("stdin.log");
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 4);
    let mut cmd = tokio::process::Command::new("python3");
    cmd.arg("-c")
        .arg(STAND_IN)
        .arg(&log)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    own_session(&mut cmd);
    let mut child = cmd.spawn().expect("python3 runs the stand-in");
    let pid = child.id();
    let stdin = child.stdin.take().unwrap();
    let (tx, mut rx) = mpsc::channel::<RunnerEvent>(256);
    runner
        .adopt(
            Spawned {
                job_id: "k".into(),
                child,
                stdin,
                egress: None,
                mcp_path: dir.join("absent.json"),
                bearer_dir: None,
                invoked_with_resume: false,
                permit: None,
                keep_resident: false,
                model: None,
                project_slug: None,
                checkout: crate::CheckoutView::Write,
                siblings: Vec::new(),
                repo_path: std::env::temp_dir(),
            },
            tx,
        )
        .await
        .unwrap();
    // the first turn streams; a turn with no reply yet is the one Stop reaches
    loop {
        if let Some(RunnerEvent::Stdout(l)) = rx.recv().await {
            if l["type"] == "stream_event" {
                break;
            }
        }
    }
    let asked = std::time::Instant::now();
    runner
        .interrupt(&"k".to_string())
        .await
        .expect("the interrupt is written");
    let ended = tokio::time::timeout(Duration::from_secs(2), next_terminal(&mut rx))
        .await
        .expect("the turn did not end within 2 s of Stop");
    assert!(
        matches!(ended, RunnerEvent::Done),
        "a stopped turn ended in failure: {ended:?}"
    );
    let took = asked.elapsed();
    let written = std::fs::read_to_string(&log).unwrap();
    let first: Value = serde_json::from_str(written.lines().next().unwrap()).unwrap();
    assert_eq!(first["type"], "control_request");
    assert_eq!(first["request"]["subtype"], "interrupt");
    // the next message continues the same process
    let (tx2, mut rx2) = mpsc::channel::<RunnerEvent>(64);
    Runner::send(&runner, &"k".to_string(), "what was it about?".into(), tx2)
        .await
        .expect("the stopped session takes the next message");
    let next = tokio::time::timeout(Duration::from_secs(5), next_terminal(&mut rx2))
        .await
        .expect("the next message was not answered");
    assert!(matches!(next, RunnerEvent::Done), "{next:?}");
    let held = runner
        .sessions
        .lock()
        .await
        .get("k")
        .and_then(|s| s.child.as_ref())
        .and_then(|c| c.id());
    assert_eq!(
        held, pid,
        "the next message was answered by another process"
    );
    eprintln!("[ISS-1268 A3] stand-in: Stop to the turn's end took {took:?}");
    runner.close(&"k".to_string()).await;
    std::fs::remove_dir_all(&dir).ok();
}

/// ISS-1268 A3 on a real Claude Code: a throwaway `claude -p` stream-json session adopted as this
/// runner adopts one, Stop written mid-reply, and the same session answering the next message.
/// Spends a few cents of a model; run by hand: `cargo test -p runner-agent real_claude -- --ignored --nocapture`.
#[tokio::test]
#[ignore = "runs a real claude process"]
async fn real_claude_stops_within_two_seconds_and_continues_the_session() {
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 4);
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--include-partial-messages",
        "--input-format",
        "stream-json",
        "--replay-user-messages",
        "--model",
        "haiku",
        "--permission-mode",
        "bypassPermissions",
        "--strict-mcp-config",
        "--mcp-config",
        r#"{"mcpServers":{}}"#,
    ])
    .current_dir(std::env::temp_dir())
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::piped());
    own_session(&mut cmd);
    let mut child = cmd.spawn().expect("claude is on PATH");
    let mut stdin = child.stdin.take().unwrap();
    stdin
        .write_all(
            user_message_line("Write a 1500-word essay on the history of tea. Use no tools.")
                .as_bytes(),
        )
        .await
        .unwrap();
    let (tx, mut rx) = mpsc::channel::<RunnerEvent>(4096);
    let spawned = Spawned {
        job_id: "real".into(),
        child,
        stdin,
        egress: None,
        mcp_path: std::env::temp_dir().join("absent-real.json"),
        bearer_dir: None,
        invoked_with_resume: false,
        permit: None,
        keep_resident: false,
        model: None,
        project_slug: None,
        checkout: crate::CheckoutView::Write,
        siblings: Vec::new(),
        repo_path: std::env::temp_dir(),
    };
    runner.adopt(spawned, tx).await.unwrap();
    let mut sid = None;
    loop {
        match rx.recv().await {
            Some(RunnerEvent::ClaudeSessionId(s)) => sid = Some(s),
            Some(RunnerEvent::Stdout(l))
                if l.pointer("/event/delta/type") == Some(&Value::from("text_delta")) =>
            {
                break
            }
            Some(_) => {}
            None => panic!("claude ended before it replied"),
        }
    }
    let asked = std::time::Instant::now();
    runner
        .interrupt(&"real".to_string())
        .await
        .expect("the interrupt is written");
    let ended = tokio::time::timeout(Duration::from_secs(2), next_terminal(&mut rx))
        .await
        .expect("the real turn did not end within 2 s of Stop");
    let took = asked.elapsed();
    assert!(matches!(ended, RunnerEvent::Done), "{ended:?}");
    let (tx2, mut rx2) = mpsc::channel::<RunnerEvent>(4096);
    Runner::send(
        &runner,
        &"real".to_string(),
        "In five words: what were you writing about?".into(),
        tx2,
    )
    .await
    .unwrap();
    let mut answer = String::new();
    let mut same_session = None;
    loop {
        match tokio::time::timeout(Duration::from_secs(60), rx2.recv())
            .await
            .expect("no answer in 60 s")
        {
            Some(RunnerEvent::Stdout(l)) if l["type"] == "result" => {
                same_session = l["session_id"].as_str().map(str::to_string);
                answer = l["result"].as_str().unwrap_or_default().to_string();
            }
            Some(RunnerEvent::Done) => break,
            Some(RunnerEvent::Failed { error }) => panic!("{error}"),
            Some(_) => {}
            None => panic!("the session ended"),
        }
    }
    assert_eq!(same_session, sid, "the next message ran in another session");
    eprintln!("[ISS-1268 A3 real claude] Stop to the turn's end: {took:?}; session {sid:?} answered next: {answer:?}");
    runner.close(&"real".to_string()).await;
}
