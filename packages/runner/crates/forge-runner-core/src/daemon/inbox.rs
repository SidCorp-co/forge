//! RFC 0003 — `session.send`: the one message vocabulary a live session takes.
//!
//! Five kinds, one arm. `work`, `answer` and `inject` are the same act with
//! different provenance — text becomes the session's next turn. `checkpoint`
//! asks the agent to write down where it is before anything ends it, and
//! `cancel` ends the session between turns by EOF rather than by signal.
//!
//! What the runner reports back is deliberately narrow: `delivered` or `gone`,
//! and SILENCE for anything it cannot honestly claim. Core reads silence as
//! `unknown`, the one outcome no caller may act on, so a message the runner is
//! unsure of waits instead of being replaced.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::daemon::master::Masters;
use crate::daemon::terminal;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::transport::inbox::{self, Ack};
use crate::transport::CoreClient;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendFrame {
    session_id: String,
    seq: u64,
    kind: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    deadline_ms: Option<u64>,
    #[serde(default)]
    job_id: Option<String>,
}

const DEFAULT_WRITE_MS: u64 = 8_000;

fn write_deadline(frame_ms: Option<u64>) -> std::time::Duration {
    let ms = frame_ms.map_or(DEFAULT_WRITE_MS, |d| (d * 4 / 5).max(1_000));
    std::time::Duration::from_millis(ms)
}

pub async fn handle_session_send(
    client: &CoreClient,
    runner: Arc<ClaudeCodeRunner>,
    masters: Arc<Masters>,
    data: Value,
) {
    let frame: SendFrame = match serde_json::from_value(data) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[inbox] undecodable session.send: {e}");
            return;
        }
    };
    let key = frame
        .job_id
        .clone()
        .unwrap_or_else(|| frame.session_id.clone());
    let seq = frame.seq;
    let sid = frame.session_id.clone();

    match frame.kind.as_str() {
        "cancel" => {
            if let Some(pane) = masters.pane_for_session(&sid) {
                // Said rather than swallowed. `terminal::kill` answers for the
                // session being gone (ISS-1208), and `Ack` has only
                // `delivered` and `gone` — neither of which is true of a pane
                // that is still running — so core is told `gone` and the box
                // says here that it is not. A third ack kind is core's half and
                // is not this daemon's to invent.
                if let Err(e) = terminal::kill(&pane).await {
                    tracing::error!(
                        "[inbox] cancel for session {sid}: {pane} would not end ({e}) — core is being told `gone` because the ack has no other answer, and that pane is still running whatever it was running. `forge-runner master kill` on its project is what ends it"
                    );
                }
            } else {
                runner.close(&key).await;
            }
            inbox::ack(client, &sid, seq, Ack::Gone).await;
        }
        "checkpoint" => {
            deliver(
                client,
                &runner,
                &masters,
                &frame,
                &key,
                ClaudeCodeRunner::CHECKPOINT_PROMPT,
            )
            .await;
        }
        "work" | "answer" | "inject" => {
            let Some(body) = frame.body.clone().filter(|b| !b.trim().is_empty()) else {
                tracing::error!(
                    "[inbox] {} with no body — session={sid} seq={seq}",
                    frame.kind
                );
                return;
            };
            deliver(client, &runner, &masters, &frame, &key, &body).await;
        }
        other => tracing::warn!("[inbox] unknown kind {other:?} — session={sid} seq={seq}"),
    }
}

/// What became of one message at a master pane, in the three shapes core can
/// be answered in — including the one that is no answer at all.
enum AtThePane {
    /// The pane took it.
    Took,
    /// tmux says it holds no session by that name. The only shape `gone`
    /// describes.
    Gone,
    /// Nothing was typed, and nothing here establishes that the session ended:
    /// the pane was read alive and refused the message, or tmux could not be
    /// asked. `Ack` has no word for it, and RFC 0003 already defines what the
    /// runner does with what it cannot honestly claim — it says nothing, core
    /// reads that as `unknown`, and the message waits instead of being
    /// replaced. The string is why, for the log.
    Unsaid(String),
}

async fn deliver_to_pane(
    masters: &Arc<Masters>,
    session_id: &str,
    body: &str,
) -> Option<AtThePane> {
    let pane = masters.pane_for_session(session_id)?;
    Some(match terminal::send_line(&pane, body).await {
        Ok(_) => AtThePane::Took,
        Err(terminal::NotTyped::Gone(_)) => AtThePane::Gone,
        Err(why @ (terminal::NotTyped::Refused(_) | terminal::NotTyped::Failed(_))) => {
            AtThePane::Unsaid(why.to_string())
        }
    })
}

async fn deliver(
    client: &CoreClient,
    runner: &Arc<ClaudeCodeRunner>,
    masters: &Arc<Masters>,
    frame: &SendFrame,
    key: &str,
    body: &str,
) {
    if let Some(outcome) = deliver_to_pane(masters, &frame.session_id, body).await {
        match outcome {
            AtThePane::Took => {
                inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await
            }
            AtThePane::Gone => {
                tracing::info!(
                    "[inbox] session={} seq={}: tmux holds no such session — acking `gone`",
                    frame.session_id,
                    frame.seq
                );
                inbox::ack(client, &frame.session_id, frame.seq, Ack::Gone).await
            }
            // Said at the level the `cancel` arm uses, and for the same reason:
            // the ack vocabulary has no answer that is true here, and the half
            // of that which used to be quiet was the half that lied.
            AtThePane::Unsaid(why) => tracing::error!(
                "[inbox] session={} seq={}: {why} — NO ack is being sent, because the pane was read and `gone` would say this session ended when this box has not established that. Core reads the silence as `unknown` and waits",
                frame.session_id,
                frame.seq
            ),
        }
        return;
    }
    let pending = Some((frame.session_id.clone(), frame.seq));
    let key = key.to_string();
    let write = runner.send_resident(&key, body, pending);
    match tokio::time::timeout(write_deadline(frame.deadline_ms), write).await {
        Ok(Ok(())) => inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await,
        Ok(Err(e)) => {
            tracing::info!("[inbox] session={} not resident: {e}", frame.session_id);
            inbox::ack(client, &frame.session_id, frame.seq, Ack::Gone).await;
        }
        Err(_) => tracing::error!(
            "[inbox] write overran its deadline — session={} seq={}",
            frame.session_id,
            frame.seq
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::cred_store::ENV_TEST_LOCK;
    use crate::daemon::terminal::testing::{Asked, ShimTmux, ONE_AT_A_TIME};
    use std::sync::Mutex;

    const RULE: &str = "\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}";

    /// A pane drawn the way Claude Code draws its composer, holding `body`.
    fn composer(body: &str) -> String {
        format!("\u{25cf} earlier output\n{RULE}\n\u{276f}\u{a0}{body}\n{RULE}\n  footer\n")
    }

    /// A pane showing a choice list, where Enter decides rather than sends.
    fn menu() -> String {
        " Do you want to proceed?\n   1. Yes\n \u{276f} 2. No\n\n Esc to cancel".to_string()
    }

    /// Captures what this thread logs while the delivery runs.
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl std::io::Write for Capture {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("the log buffer").extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn capture_log() -> (Arc<Mutex<Vec<u8>>>, tracing::subscriber::DefaultGuard) {
        crate::daemon::keep_tracing_capturable();
        let buf = Arc::new(Mutex::new(Vec::new()));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || Capture(made.clone()))
            .with_ansi(false)
            .finish();
        (buf, tracing::subscriber::set_default(sub))
    }

    /// A core that records every request rather than answering one way.
    ///
    /// `transport::fake_core` serves a fixed answer and keeps nothing, and what
    /// every test below asserts is what reached the wire — including, four
    /// times over, that nothing did.
    async fn recording_core() -> (String, Arc<Mutex<Vec<(String, String)>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("a port of this test's own");
        let addr = listener.local_addr().expect("its address");
        let seen: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
        let writes = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let writes = writes.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let whole = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let path = whole.split_whitespace().nth(1).unwrap_or("").to_string();
                    let body = whole.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
                    writes
                        .lock()
                        .expect("the request journal")
                        .push((path, body));
                    let _ = sock
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        (format!("http://{addr}"), seen)
    }

    const PANE: &str = "forge-master-shim";

    struct Sent {
        acks: Vec<(String, String)>,
        verbs: Vec<String>,
        log: String,
    }

    impl Sent {
        fn outcomes(&self) -> Vec<String> {
            self.acks.iter().map(|(_, body)| body.clone()).collect()
        }
    }

    /// One `session.send` frame, routed to a master pane, through whatever
    /// tmux the caller has already installed.
    async fn send_frame() -> (Vec<(String, String)>, String) {
        let (url, acks) = recording_core().await;
        let (buf, _logs) = capture_log();
        let masters = Arc::new(Masters::new());
        masters.remember_for_test("proj-1", "sess-1", PANE);
        let runner = Arc::new(ClaudeCodeRunner::new(&url, "device-token", 1));
        let client = CoreClient::new(&url, "device-token");
        handle_session_send(
            &client,
            runner,
            masters,
            serde_json::json!({
                "sessionId": "sess-1",
                "seq": 3,
                "kind": "answer",
                "body": "MY-ORCHESTRATOR-MESSAGE",
                "deadlineMs": 10_000
            }),
        )
        .await;
        let acks = acks.lock().expect("the request journal").clone();
        let log = String::from_utf8_lossy(&buf.lock().expect("the log buffer")).into_owned();
        (acks, log)
    }

    /// The same, through a shim tmux answering what this case needs.
    async fn send_one(asked: Asked, capture: &str, fail: Option<&str>) -> Sent {
        let shim = ShimTmux::installed(asked, capture, fail);
        let (acks, log) = send_frame().await;
        Sent {
            acks,
            verbs: shim.verbs(),
            log,
        }
    }

    /// The issue's own reproduction: a live master, a draft at its prompt, and
    /// the ack read off the wire.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_message_refused_at_a_dirty_composer_is_never_acked_gone() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(
            Asked::Present,
            &composer("LEFTOVER-FROM-SOMEWHERE-ELSE"),
            None,
        )
        .await;
        assert!(
            sent.acks.is_empty(),
            "the pane was read alive, so nothing may be said about it: {:?}",
            sent.acks
        );
        assert!(
            !sent
                .verbs
                .iter()
                .any(|v| v == "paste-buffer" || v == "send-keys"),
            "nothing may be typed after the capture refused the message: {:?}",
            sent.verbs
        );
        let said = sent.log.to_lowercase();
        assert!(
            sent.log.contains("ERROR") && said.contains(PANE) && said.contains("no ack"),
            "the silence must be said at the level the cancel arm uses, naming the pane and the ack that did not go: {}",
            sent.log
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_message_refused_at_a_choice_list_is_never_acked_gone() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(Asked::Present, &menu(), None).await;
        assert!(
            sent.acks.is_empty(),
            "a pane showing a choice list is running, and Enter there decides rather than sends: {:?}",
            sent.acks
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_tmux_call_that_fails_while_typing_is_never_acked_gone() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        for verb in ["load-buffer", "paste-buffer", "send-keys"] {
            let sent = send_one(Asked::Present, &composer(""), Some(verb)).await;
            assert!(
                sent.acks.is_empty(),
                "tmux broke at {verb} after the pane answered alive, which says nothing about the session having ended: {:?}",
                sent.acks
            );
        }
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_session_tmux_says_it_does_not_hold_is_still_acked_gone() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(Asked::Absent, &composer(""), None).await;
        assert_eq!(
            sent.outcomes(),
            vec![r#"{"outcome":"gone"}"#.to_string()],
            "tmux answered in its own words that it holds no such session, which is the one thing `gone` may be minted from"
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_tmux_that_cannot_be_asked_is_never_acked_gone() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(Asked::NoServer, &composer(""), None).await;
        assert!(
            sent.acks.is_empty(),
            "no server answered, so nobody established that the session ended: {:?}",
            sent.acks
        );
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_message_the_pane_takes_is_acked_delivered() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(Asked::Present, &composer(""), None).await;
        assert_eq!(
            sent.outcomes(),
            vec![r#"{"outcome":"delivered"}"#.to_string()],
            "an empty composer takes the message"
        );
        assert!(
            sent.verbs.iter().any(|v| v == "send-keys"),
            "and it is typed and submitted: {:?}",
            sent.verbs
        );
    }

    /// ISS-1224 settled that a pane whose composer cannot be read is typed into
    /// anyway, as it always was before a pane could be read. This change does
    /// not reopen it.
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_pane_whose_composer_cannot_be_read_still_takes_the_message() {
        let _serialised = ONE_AT_A_TIME.lock().await;
        let _env = ENV_TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let sent = send_one(Asked::Present, "$ \n$ echo hi\nhi\n$ ", None).await;
        assert_eq!(
            sent.outcomes(),
            vec![r#"{"outcome":"delivered"}"#.to_string()],
            "an unreadable prompt is typed into and reported honestly, unchanged by this issue"
        );
    }

    fn frame(kind: &str, body: Option<&str>, job: Option<&str>) -> SendFrame {
        SendFrame {
            session_id: "sess-1".into(),
            seq: 3,
            kind: kind.into(),
            body: body.map(str::to_string),
            deadline_ms: Some(10_000),
            job_id: job.map(str::to_string),
        }
    }

    #[test]
    fn a_pipeline_message_is_keyed_by_the_job_and_a_chat_message_by_the_session() {
        let f = frame("answer", Some("yes"), Some("job-9"));
        assert_eq!(f.job_id.unwrap_or(f.session_id), "job-9");
        let g = frame("answer", Some("yes"), None);
        assert_eq!(g.job_id.unwrap_or(g.session_id), "sess-1");
    }

    #[test]
    fn the_write_deadline_stays_under_the_grace_core_is_waiting_out() {
        assert!(write_deadline(Some(10_000)) < std::time::Duration::from_millis(10_000));
        assert_eq!(write_deadline(Some(10_000)).as_millis(), 8_000);
        assert!(write_deadline(Some(10)) >= std::time::Duration::from_millis(1_000));
        assert_eq!(
            write_deadline(None),
            std::time::Duration::from_millis(DEFAULT_WRITE_MS)
        );
    }

    #[test]
    fn a_frame_from_core_decodes_with_camel_case_keys() {
        let v = serde_json::json!({
            "sessionId": "s", "seq": 7, "kind": "answer", "body": "ok",
            "deadlineMs": 10_000, "jobId": "j"
        });
        let f: SendFrame = serde_json::from_value(v).expect("core's payload must decode");
        assert_eq!(
            (f.seq, f.kind.as_str(), f.job_id.as_deref()),
            (7, "answer", Some("j"))
        );
    }

    #[test]
    fn a_blank_body_is_not_a_body() {
        assert!(frame("answer", Some("   \n"), None)
            .body
            .filter(|b| !b.trim().is_empty())
            .is_none());
        assert!(frame("answer", Some("yes"), None)
            .body
            .filter(|b| !b.trim().is_empty())
            .is_some());
    }
}
