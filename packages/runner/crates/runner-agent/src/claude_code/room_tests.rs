use super::*;

#[test]
fn only_a_resident_confined_turn_on_a_box_that_turned_rooms_on_takes_a_room() {
    assert!(room_for(false, true, true, false, Some("p")).is_none());
    assert!(room_for(true, false, true, false, Some("p")).is_none());
    assert!(room_for(true, true, false, false, Some("p")).is_none());
    assert_eq!(
        room_for(true, true, true, false, Some("p")),
        Some(Ok("p".into()))
    );
    let off = room_for(true, true, true, true, Some("p"))
        .unwrap()
        .unwrap_err();
    assert!(off.starts_with("[CHAT_ROOM_HOOKS_OFF]"), "{off}");
    let unnamed = room_for(true, true, true, false, None)
        .unwrap()
        .unwrap_err();
    assert!(unnamed.starts_with("[CHAT_ROOM_NO_PROJECT]"), "{unnamed}");
}

#[test]
fn a_stop_for_another_session_is_not_this_room_s() {
    let w = Watch {
        rooms: Arc::default(),
        id: "a".into(),
        sid: "s1".into(),
        host: None,
        events: PathBuf::new(),
        transcript: PathBuf::new(),
        transcript_from: 0,
        cost_base: None,
        core: runner_transport::CoreClient::new("http://127.0.0.1:9", "t"),
    };
    assert!(w.ours(&serde_json::json!({"session_id":"s1"})));
    assert!(!w.ours(&serde_json::json!({"session_id":"s2"})));
}

/// Whether `rx` yields `Done` within `within`, the lines before it dropped.
async fn done_within(rx: &mut mpsc::Receiver<RunnerEvent>, within: Duration) -> bool {
    tokio::time::timeout(within, async {
        while let Some(ev) = rx.recv().await {
            if matches!(ev, RunnerEvent::Done) {
                return true;
            }
        }
        false
    })
    .await
    .unwrap_or(false)
}

/// Measured on 2.1.319: a message given while the model writes its last text is queued, the
/// turn's Stop fires, and the message runs as a turn of its own straight after with a second
/// Stop. The turn core handed ends with the second.
#[tokio::test]
async fn a_stop_while_a_message_is_still_queued_does_not_end_the_turn() {
    let dir = std::env::temp_dir().join(format!("room-queued-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (events, transcript) = (dir.join("events.jsonl"), dir.join("t.jsonl"));
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 1);
    let (tx, mut rx) = mpsc::channel(64);
    test_turn(&runner, "q", "s1", events.clone(), transcript.clone(), tx).await;
    let line = |v: serde_json::Value| format!("{v}\n");
    let mut t = line(serde_json::json!({"type":"user","message":{"content":"story"}}));
    t += &line(
        serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"HOTEL"}),
    );
    std::fs::write(&transcript, &t).unwrap();
    let now = runner_core::agent_activity::now_ms();
    chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, now).unwrap();
    chat_pane_events::append(
        &events,
        STATUS_LINE,
        br#"{"cost":{"total_cost_usd":0.01}}"#,
        now + 1,
    )
    .unwrap();
    assert!(
        !done_within(&mut rx, Duration::from_millis(1500)).await,
        "the turn ended on a Stop with a message still queued"
    );
    t += &line(serde_json::json!({"type":"queue-operation","operation":"dequeue"}));
    t += &line(serde_json::json!({"type":"user","message":{"content":"HOTEL"}}));
    std::fs::write(&transcript, &t).unwrap();
    let now = runner_core::agent_activity::now_ms();
    chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, now).unwrap();
    chat_pane_events::append(
        &events,
        STATUS_LINE,
        br#"{"cost":{"total_cost_usd":0.02}}"#,
        now + 1,
    )
    .unwrap();
    let ended = done_within(&mut rx, Duration::from_secs(5)).await;
    let _ = std::fs::remove_dir_all(&dir);
    assert!(
        ended,
        "the second Stop, with nothing queued, did not end the turn"
    );
}

/// The `result` line `rx` yields before `Done`, if it yields one within ten seconds.
async fn result_of(rx: &mut mpsc::Receiver<RunnerEvent>) -> Option<serde_json::Value> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let mut result = None;
        while let Some(ev) = rx.recv().await {
            match ev {
                RunnerEvent::Stdout(l) if l["type"] == "result" => result = Some(l),
                RunnerEvent::Done => return result,
                _ => {}
            }
        }
        None
    })
    .await
    .ok()
    .flatten()
}

/// A resumed session's first turn, its baseline taken the way `start_in_room` takes it from
/// `events` before the prompt is handed in, then the turn's Stop and the status line after it.
async fn resumed_first_turn(
    tag: &str,
    before: Option<&[u8]>,
    within: Duration,
) -> (Option<f64>, Option<serde_json::Value>) {
    let dir = std::env::temp_dir().join(format!("room-{tag}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let (events, transcript) = (dir.join("events.jsonl"), dir.join("t.jsonl"));
    std::fs::write(&events, b"").unwrap();
    let launched = runner_core::agent_activity::now_ms();
    if let Some(payload) = before {
        chat_pane_events::append(&events, STATUS_LINE, payload, launched).unwrap();
    }
    let base = first_turn_base(&SessionStart::Resume("s1".into()), &events, within).await;
    let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 1);
    let (tx, mut rx) = mpsc::channel(64);
    let paths = (events.clone(), transcript.clone());
    test_turn_from(&runner, tag, "s1", paths, base, tx).await;
    std::fs::write(
        &transcript,
        concat!(
            r#"{"type":"user","message":{"content":"hi"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text"}],"usage":{"output_tokens":3}}}"#,
            "\n",
        ),
    )
    .unwrap();
    let stop = runner_core::agent_activity::now_ms();
    chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, stop).unwrap();
    let after = br#"{"cost":{"total_cost_usd":0.53}}"#;
    chat_pane_events::append(&events, STATUS_LINE, after, stop + 1).unwrap();
    let result = result_of(&mut rx).await;
    let _ = std::fs::remove_dir_all(&dir);
    (base, result)
}

/// ISS-1172: a resumed session's status line carries its restored running cost before any
/// prompt (measured on 2.1.319), so the first turn is that figure's difference, not unread.
#[tokio::test]
async fn a_resumed_session_s_first_turn_is_measured_from_the_status_line_before_its_prompt() {
    let before = br#"{"session_id":"s1","cost":{"total_cost_usd":0.5}}"#;
    let (base, result) =
        resumed_first_turn("base-read", Some(before), Duration::from_secs(5)).await;
    assert_eq!(base, Some(0.5));
    let result = result.expect("the turn closed with no result line");
    assert_eq!(result["total_cost_usd"], 0.03, "{result}");
    assert!(result["forge_pane"]["cost"].is_string(), "{result}");
}

/// With no status line before the prompt, the first turn stays unread, saying why, after waiting
/// no longer than its bound.
#[tokio::test]
async fn a_resumed_session_with_no_status_line_before_its_prompt_says_its_cost_is_unread() {
    let started = std::time::Instant::now();
    let (base, result) = resumed_first_turn("base-none", None, Duration::from_millis(600)).await;
    assert_eq!(base, None);
    let result = result.expect("the turn closed with no result line");
    assert!(result.get("total_cost_usd").is_none(), "{result}");
    assert_eq!(
        result["forge_pane"]["cost"]["unread"],
        "no status line stood before the turn to measure from"
    );
    assert!(started.elapsed() < Duration::from_secs(5));
}

/// A session the box just started has spent nothing: it is measured from 0, with no wait.
#[tokio::test]
async fn a_new_session_is_measured_from_nothing_spent_without_waiting() {
    let started = std::time::Instant::now();
    let none = std::path::Path::new("/nonexistent/events.jsonl");
    let base = first_turn_base(&SessionStart::New, none, Duration::from_secs(30)).await;
    assert_eq!(base, Some(0.0));
    assert!(started.elapsed() < Duration::from_secs(1));
}
