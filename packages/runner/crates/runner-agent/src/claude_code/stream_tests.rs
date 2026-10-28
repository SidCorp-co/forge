//! A message written into a resident session while its turn runs (REQ-75 BC-11). Claude Code
//! 2.1.310 takes it into the running turn when a tool call is still to come, or answers it as a
//! turn of its own straight after the running turn's `result`. The two streams below are what it
//! printed in each case, cut down to the fields the reader reads; the caller's turn ends at the
//! `result` after which nothing written is still queued.

use super::*;

/// A tool call was in flight when the second message was written: Claude Code replayed it after
/// the tool result and answered both in one turn, with one `result`.
const JOINED: &str = r#"{"type":"system","subtype":"init","session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"text"}]},"isReplay":true,"session_id":"s-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use"}]},"session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"tool_result"}]},"session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"text"}]},"isReplay":true,"session_id":"s-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text"}]},"session_id":"s-1"}
{"type":"result","subtype":"success","is_error":false,"num_turns":2,"session_id":"s-1"}"#;

/// The model was writing text with no tool call left when the second message was written: Claude
/// Code ended the turn, then replayed the message and answered it in a second turn.
const QUEUED: &str = r#"{"type":"system","subtype":"init","session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"text"}]},"isReplay":true,"session_id":"s-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text"}]},"session_id":"s-1"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"s-1"}
{"type":"system","subtype":"init","session_id":"s-1"}
{"type":"user","message":{"role":"user","content":[{"type":"text"}]},"isReplay":true,"session_id":"s-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text"}]},"session_id":"s-1"}
{"type":"result","subtype":"success","is_error":false,"num_turns":1,"session_id":"s-1"}"#;

fn session(unreplayed: u32) -> Session {
    let (tx, _rx) = mpsc::channel(1);
    Session {
        child: None,
        claude_session_id: None,
        stdin: None,
        turn_tx: Arc::new(Mutex::new(tx)),
        turn_started: Arc::new(tokio::sync::Notify::new()),
        pending_inbox: Vec::new(),
        unreplayed,
        in_turn: true,
        keep_resident: true,
        bearer_dir: None,
        turns: 0,
        turn_done: Arc::new(tokio::sync::Notify::new()),
        model: None,
        head_sha: None,
        checkout: crate::CheckoutView::Write,
        permit: None,
        project_slug: None,
        ended: tokio::sync::watch::channel(false).1,
    }
}

/// Feed `stream` to the reader for a session `written` messages were written into, and count the
/// turn ends it signals, with how many lines it had read at each.
async fn turn_ends(stream: &str, written: u32) -> Vec<usize> {
    let dir = std::env::temp_dir().join(format!("stream-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("stream.jsonl");
    std::fs::write(&file, stream).unwrap();
    let mut child = tokio::process::Command::new("cat")
        .arg(&file)
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    sessions.lock().await.insert("s".into(), session(written));
    let (tx, mut rx) = mpsc::channel::<RunnerEvent>(64);
    let turn_tx: TurnTx = Arc::new(Mutex::new(tx));
    let notify = Arc::new(tokio::sync::Notify::new());
    let lines = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = lines.clone();
    let drain = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            if matches!(ev, RunnerEvent::Stdout(_)) {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
    });
    let ends = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (waiter_notify, waiter_ends, waiter_lines) = (notify.clone(), ends.clone(), lines.clone());
    let waiter = tokio::spawn(async move {
        loop {
            waiter_notify.notified().await;
            waiter_ends
                .lock()
                .unwrap()
                .push(waiter_lines.load(std::sync::atomic::Ordering::SeqCst));
        }
    });
    let reader = stream::spawn_reader(
        stdout,
        turn_tx,
        sessions,
        Arc::new(Mutex::new(Outcome::default())),
        notify,
        "s".into(),
    );
    reader.await.unwrap();
    let _ = child.wait().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    waiter.abort();
    drain.abort();
    std::fs::remove_dir_all(dir).unwrap();
    let got = ends.lock().unwrap().clone();
    got
}

#[tokio::test]
async fn a_message_queued_behind_a_turn_ends_it_at_the_second_result_not_the_first() {
    // the first message and the one written mid-turn
    let ends = turn_ends(QUEUED, 2).await;
    assert_eq!(
        ends.len(),
        1,
        "the turn ended {} times; the queued message's own result was not waited for: {ends:?}",
        ends.len()
    );
}

#[tokio::test]
async fn a_message_taken_into_the_running_turn_ends_it_at_its_one_result() {
    let ends = turn_ends(JOINED, 2).await;
    assert_eq!(ends.len(), 1, "{ends:?}");
}

#[tokio::test]
async fn a_turn_with_nothing_written_mid_turn_ends_at_each_result() {
    // two turns written between results: each result ends one
    let first = QUEUED.lines().take(4).collect::<Vec<_>>().join("\n") + "\n";
    assert_eq!(turn_ends(&first, 1).await.len(), 1);
}

#[test]
fn a_tool_result_is_no_replayed_message() {
    let tool_result: Value = serde_json::from_str(JOINED.lines().nth(3).unwrap()).unwrap();
    assert_eq!(tool_result["message"]["content"][0]["type"], "tool_result");
    assert!(!stream::is_replayed_user_message(&tool_result));
    let replay: Value = serde_json::from_str(JOINED.lines().nth(4).unwrap()).unwrap();
    assert!(stream::is_replayed_user_message(&replay));
}
