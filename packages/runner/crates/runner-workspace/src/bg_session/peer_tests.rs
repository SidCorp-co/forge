use super::*;

#[test]
fn a_record_on_another_peer_protocol_is_refused_by_name() {
    let raw = serde_json::json!({
        "pid": 1, "sessionId": "s", "messagingSocketPath": "/x.sock", "peerProtocol": 2,
        "version": "2.9.0"
    });
    let e = check_record(&raw).unwrap_err();
    assert!(e.to_string().starts_with("[PEER_PROTOCOL_UNKNOWN]"), "{e}");
    assert!(e.to_string().contains("2.9.0"), "{e}");
    let no_socket = serde_json::json!({"pid": 1, "sessionId": "s", "peerProtocol": 1});
    let e = check_record(&no_socket).unwrap_err();
    assert!(e.to_string().contains("messagingSocketPath"), "{e}");
}

#[test]
fn only_a_line_carrying_the_message_as_its_origin_is_a_receipt() {
    let id = "m-1";
    let quoted = r#"{"type":"assistant","message":{"content":"I saw m-1 in a log"}}"#;
    assert_eq!(seen_in(quoted, id), Seen::NotYet);
    let taken = r#"{"type":"user","origin":{"kind":"peer","msg_id":"m-1"}}"#;
    assert_eq!(seen_in(&format!("{quoted}\n{taken}\n"), id), Seen::Taken);
    let dropped = r#"{"type":"system","content":"Dropped a peer message from pid 9: exceeded the peer message rate limit"}"#;
    assert!(matches!(seen_in(dropped, id), Seen::Dropped(_)));
    // taken mid-turn, 2.1.322 writes only the queued command, its origin inside the attachment
    let mid_turn = r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"x","origin":{"kind":"peer","from":"unknown","msg_id":"m-1"},"isMeta":true},"rendered":[{"content":"x"}]}"#;
    assert_eq!(seen_in(mid_turn, id), Seen::Taken);
    let rendered_only =
        r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"m-1"}}"#;
    assert_eq!(seen_in(rendered_only, id), Seen::NotYet);
}

#[test]
fn a_body_sent_to_a_session_is_not_sent_there_again_and_sends_are_paced() {
    let sid = format!("pace-{}", uuid::Uuid::new_v4());
    assert_eq!(take_turn(&sid, "a").unwrap(), Duration::ZERO);
    let e = take_turn(&sid, "a").unwrap_err();
    assert!(e.to_string().starts_with("[PEER_SAME_BODY]"), "{e}");
    let wait = take_turn(&sid, "b").unwrap();
    assert!(wait > PACE - Duration::from_millis(200), "{wait:?}");
    let other = format!("pace-{}", uuid::Uuid::new_v4());
    assert_eq!(take_turn(&other, "a").unwrap(), Duration::ZERO);
}

/// A fake session: its record and key under `<dir>/sessions`, a socket that checks the token and
/// writes each message it takes to its own transcript as 2.1.322 does, or takes it and writes
/// nothing where `silent`.
#[cfg(target_os = "linux")]
mod fake {
    use super::*;
    use tokio::io::AsyncReadExt as _;

    pub fn start_of(pid: u32) -> String {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap();
        let (_, rest) = stat.rsplit_once(')').unwrap();
        rest.split_whitespace().nth(19).unwrap().to_string()
    }

    pub async fn session(dir: &Path, sid: &str, pid: u32, silent: bool) -> PathBuf {
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let cwd = dir.join(format!("cwd-{sid}"));
        let projects = dir
            .join("projects")
            .join(runner_core::claude_paths::project_dir_name(&cwd));
        std::fs::create_dir_all(&projects).unwrap();
        let transcript = projects.join(format!("{sid}.jsonl"));
        std::fs::write(&transcript, "{\"type\":\"summary\"}\n").unwrap();
        let socket = dir.join(format!("{sid}.sock"));
        let token = format!("tok-{sid}");
        let record = serde_json::json!({
            "pid": pid, "sessionId": sid, "cwd": cwd, "procStart": start_of(pid),
            "peerProtocol": 1, "messagingSocketPath": socket, "updatedAt": 1, "version": "2.1.322"
        });
        std::fs::write(sessions.join(format!("{pid}.json")), record.to_string()).unwrap();
        std::fs::write(
            sessions.join(format!("{pid}.abc.key")),
            serde_json::json!({ "peerToken": token }).to_string(),
        )
        .unwrap();
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        let path = transcript.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = String::new();
                let _ = s.read_to_string(&mut buf).await;
                let mut lines = buf.lines();
                let auth: Value = serde_json::from_str(lines.next().unwrap_or("{}")).unwrap();
                let msg: Value = serde_json::from_str(lines.next().unwrap_or("{}")).unwrap();
                if auth["token"] != token.as_str() || silent {
                    continue;
                }
                let line = serde_json::json!({
                    "type": "user",
                    "message": msg["message"],
                    "origin": { "kind": "peer", "msg_id": msg["msg_id"] },
                });
                use std::io::Write as _;
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(&path)
                    .unwrap();
                writeln!(f, "{line}").unwrap();
            }
        });
        transcript
    }
}

/// ISS-1261's plant on this transport: two sessions are written to at the same instant, and each
/// transcript holds only its own message, each with a receipt.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn two_sessions_sent_at_once_each_take_only_their_own_with_a_receipt() {
    let dir = std::env::temp_dir().join(format!("bg-peer-pair-{}", uuid::Uuid::new_v4()));
    let mut a = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let mut b = std::process::Command::new("sleep")
        .arg("30")
        .spawn()
        .unwrap();
    let ta = fake::session(&dir, "sa", a.id(), false).await;
    let tb = fake::session(&dir, "sb", b.id(), false).await;
    let (ra, rb) = tokio::join!(
        send_in(&dir, "sa", "for A only", Priority::Next),
        send_in(&dir, "sb", "for B only", Priority::Now),
    );
    let (xa, xb) = (
        std::fs::read_to_string(&ta).unwrap(),
        std::fs::read_to_string(&tb).unwrap(),
    );
    let _ = (a.kill(), b.kill(), a.wait(), b.wait());
    std::fs::remove_dir_all(&dir).ok();
    let (ra, rb) = (ra.unwrap(), rb.unwrap());
    assert!(xa.contains(&ra.msg_id) && xa.contains("for A only"), "{xa}");
    assert!(xb.contains(&rb.msg_id) && xb.contains("for B only"), "{xb}");
    assert!(!xa.contains("for B only") && !xb.contains("for A only"));
    assert!(!xa.contains(&rb.msg_id) && !xb.contains(&ra.msg_id));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_message_the_session_never_records_is_refused_unconfirmed() {
    let dir = std::env::temp_dir().join(format!("bg-peer-silent-{}", uuid::Uuid::new_v4()));
    fake::session(&dir, "quiet", std::process::id(), true).await;
    let e = send_bounded(
        &dir,
        "quiet",
        "hello",
        Priority::Next,
        Duration::from_millis(800),
    )
    .await
    .unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(
        e.to_string().starts_with("[PEER_DELIVERY_UNCONFIRMED]"),
        "{e}"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_message_is_delivered_on_its_receipt() {
    let dir = std::env::temp_dir().join(format!("bg-peer-one-{}", uuid::Uuid::new_v4()));
    let transcript = fake::session(&dir, "one", std::process::id(), false).await;
    let got = send_in(&dir, "one", "hello one", Priority::Now).await;
    let text = std::fs::read_to_string(&transcript).unwrap();
    std::fs::remove_dir_all(&dir).ok();
    let r = got.unwrap();
    assert!(
        text.contains(&r.msg_id) && text.contains("hello one"),
        "{text}"
    );
}

#[test]
fn no_live_record_is_not_the_session_ending() {
    let dir = std::env::temp_dir().join(format!("bg-peer-none-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("4000000.json"),
        r#"{"pid":4000000,"sessionId":"s","peerProtocol":1,"messagingSocketPath":"/x"}"#,
    )
    .unwrap();
    let e = resolve_in(&dir, "s").unwrap_err();
    std::fs::remove_dir_all(&dir).ok();
    assert!(e.to_string().starts_with("[PEER_NO_LIVE_PROCESS]"), "{e}");
}
