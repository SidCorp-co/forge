//! RFC 0003 — the runner's two reports about one inbox message.
//!
//! `ack` says what happened to the WRITE; `applied` says a completed turn
//! consumed it. Core keeps them apart because a message written to a session
//! that dies before the turn finishes was never read by the model.

use super::CoreClient;

/// What the runner did with one message. `unknown` is core's word for "the
/// runner never answered" and is deliberately not expressible here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ack {
    Delivered,
    Gone,
}

impl Ack {
    fn as_str(self) -> &'static str {
        match self {
            Ack::Delivered => "delivered",
            Ack::Gone => "gone",
        }
    }
}

// cm:edge contract -> packages/core/src/agent-sessions/inbox-routes.ts — the route accepts `delivered` and `gone` only, from the device that owns the session. A third value here is a 400 the runner logs and drops, which core then resolves as `unknown` — the outcome no caller may act on, so the human's answer waits for the episode to lapse instead.
// cm:guard best-effort on purpose, and the silence is SAFE: an ack core never receives resolves `unknown`, and `unknown` is the outcome that makes core wait rather than act. A throw here would only turn a recoverable silence into a failed turn.
pub async fn ack(client: &CoreClient, session_id: &str, seq: u64, outcome: Ack) {
    post(
        client,
        &format!("/api/agent-sessions/{session_id}/inbox/{seq}/ack"),
        &serde_json::json!({ "outcome": outcome.as_str() }),
    )
    .await;
}

/// The commit point: report the turn that consumed this message.
pub async fn applied(client: &CoreClient, session_id: &str, seq: u64, turn: u64) {
    post(
        client,
        &format!("/api/agent-sessions/{session_id}/inbox/{seq}/applied"),
        &serde_json::json!({ "turn": turn }),
    )
    .await;
}

async fn post(client: &CoreClient, path: &str, body: &serde_json::Value) {
    let res = client
        .http()
        .post(client.url(path))
        .bearer_auth(client.device_token())
        .json(body)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => tracing::warn!("[inbox] {path}: http {}", r.status()),
        Err(e) => tracing::warn!("[inbox] {path}: {e}"),
    }
}
