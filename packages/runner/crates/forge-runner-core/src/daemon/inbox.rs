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
                let _ = terminal::kill(&pane).await;
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

/// Type a message into a master's pane, and say whether it landed (ISS-919 B6).
async fn deliver_to_pane(masters: &Arc<Masters>, session_id: &str, body: &str) -> Option<bool> {
    let pane = masters.pane_for_session(session_id)?;
    match terminal::send_line(&pane, body).await {
        Ok(()) => Some(true),
        Err(e) => {
            tracing::info!("[inbox] master pane {pane} did not take the message: {e}");
            Some(false)
        }
    }
}

async fn deliver(
    client: &CoreClient,
    runner: &Arc<ClaudeCodeRunner>,
    masters: &Arc<Masters>,
    frame: &SendFrame,
    key: &str,
    body: &str,
) {
    if let Some(landed) = deliver_to_pane(masters, &frame.session_id, body).await {
        let ack = if landed { Ack::Delivered } else { Ack::Gone };
        inbox::ack(client, &frame.session_id, frame.seq, ack).await;
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
