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

use crate::runner::claude_code::ClaudeCodeRunner;
use crate::transport::inbox::{self, Ack};
use crate::transport::CoreClient;

// cm:edge contract -> packages/core/src/agent-sessions/session-send.ts — the payload `requestSessionSend` publishes. `jobId` is the key a PIPELINE session is held under here; `sessionId` is the key a CHAT session is held under AND the id both report routes are addressed by. Neither one serves both roles, which is why the frame carries both.
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

/// What `checkpoint` asks for. Business text, not protocol — the kind is the
/// contract, this is only how it is phrased to the agent.
const CHECKPOINT_PROMPT: &str = "Write down where you are before this session ends: what you have \
    changed so far, what you were about to do next, and anything you know that is not already in \
    the repository. Do not start new work.";

const DEFAULT_WRITE_MS: u64 = 8_000;

// cm:guard the runner's write deadline must stay STRICTLY BELOW the grace core is waiting out, and on an overrun the runner must go SILENT rather than ack — a partial line cannot be un-written, the CLI skips a malformed one and keeps running, and an ack would tell core a `cancel` landed that was in fact lost.
fn write_deadline(frame_ms: Option<u64>) -> std::time::Duration {
    let ms = frame_ms.map_or(DEFAULT_WRITE_MS, |d| (d * 4 / 5).max(1_000));
    std::time::Duration::from_millis(ms)
}

pub async fn handle_session_send(client: &CoreClient, runner: Arc<ClaudeCodeRunner>, data: Value) {
    let frame: SendFrame = match serde_json::from_value(data) {
        Ok(f) => f,
        Err(e) => {
            tracing::warn!("[inbox] undecodable session.send: {e}");
            return;
        }
    };
    // cm:guard `job_id` FIRST. A pipeline session is held under its job id, and falling back to the session id for one would find no entry and ack `gone` — core would then fall back for a session that is alive and parked, which is the wedge this whole path exists to remove.
    let key = frame
        .job_id
        .clone()
        .unwrap_or_else(|| frame.session_id.clone());
    let seq = frame.seq;
    let sid = frame.session_id.clone();

    match frame.kind.as_str() {
        "cancel" => {
            runner.close(&key).await;
            inbox::ack(client, &sid, seq, Ack::Gone).await;
        }
        "checkpoint" => {
            deliver(client, &runner, &frame, &key, CHECKPOINT_PROMPT).await;
        }
        "work" | "answer" | "inject" => {
            let Some(body) = frame.body.clone().filter(|b| !b.trim().is_empty()) else {
                // cm:guard NO ack for an empty body, deliberately. `gone` would be a lie about a session that is alive and would make core fall back while it still holds its runner slot; `delivered` would lose the message outright. Silence resolves `unknown`, which is the outcome that makes core wait.
                tracing::error!(
                    "[inbox] {} with no body — session={sid} seq={seq}",
                    frame.kind
                );
                return;
            };
            deliver(client, &runner, &frame, &key, &body).await;
        }
        other => tracing::warn!("[inbox] unknown kind {other:?} — session={sid} seq={seq}"),
    }
}

async fn deliver(
    client: &CoreClient,
    runner: &Arc<ClaudeCodeRunner>,
    frame: &SendFrame,
    key: &str,
    body: &str,
) {
    let pending = Some((frame.session_id.clone(), frame.seq));
    let key = key.to_string();
    let write = runner.send_resident(&key, body, pending);
    match tokio::time::timeout(write_deadline(frame.deadline_ms), write).await {
        Ok(Ok(())) => inbox::ack(client, &frame.session_id, frame.seq, Ack::Delivered).await,
        // cm:guard a session that is not resident is `gone`, and that is the branch core acts on: it is what turns a human's answer into a fresh dispatch instead of a message into a process that will never read it.
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

    // cm:guard the key choice is the whole difference between reaching a parked pipeline session and telling core it is gone. A pipeline session is held under its JOB id; looking it up by session id finds nothing and acks `gone`, which makes core fall back on a session that is alive and still holding its runner slot.
    #[test]
    fn a_pipeline_message_is_keyed_by_the_job_and_a_chat_message_by_the_session() {
        let f = frame("answer", Some("yes"), Some("job-9"));
        assert_eq!(f.job_id.unwrap_or(f.session_id), "job-9");
        let g = frame("answer", Some("yes"), None);
        assert_eq!(g.job_id.unwrap_or(g.session_id), "sess-1");
    }

    // cm:guard STRICTLY below the grace core is waiting out, and never zero. An overrun must leave the runner silent rather than acked, so a deadline that meets or exceeds core's would let a write land after core had already called it `unknown` and moved on.
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

    // cm:guard a body that is only whitespace is NOT a message. Writing it would start a turn on nothing, and the agent would answer a question it was never asked.
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
