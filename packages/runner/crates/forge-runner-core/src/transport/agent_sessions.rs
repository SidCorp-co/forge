//! Interactive-chat session transport: `GET` + `PATCH /api/agent-sessions/:id`.
//!
//! This is the SAME contract the desktop app uses to stream a chat reply back
//! to core (see `packages/dev/src/lib/api/agent-sessions.ts`). A `PATCH` with a
//! `messages` array mirrors the turns into `agent_session_turns` and emits a
//! tail-debounced `agent-session.turn.appended` broadcast, and any worker write
//! bumps `lastHeartbeatAt`. A terminal `status` (`completed`/`failed`) closes
//! the one-shot `pipeline_run kind='interactive'` via `closeRunIfOneShot`
//! (ISS-321). Chat never touches the `jobs` table.

use serde::Serialize;
use serde_json::Value;

use super::CoreClient;
use crate::error::{Error, Result};

/// Fetch the current `messages` array for a session. Used as the baseline a
/// chat turn appends its assistant message(s) onto, so the runner never
/// fabricates the user turn (core already seeded/append it on `/start`,
/// `/send`) and a `PATCH` (which replaces the whole array) can't drop history.
pub async fn get_messages(client: &CoreClient, session_id: &str) -> Result<Vec<Value>> {
    let url = client.url(&format!("/api/agent-sessions/{session_id}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("get agent session: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("get agent session {status}: {text}")));
    }
    let row: Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("decode agent session: {e}")))?;
    Ok(row
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// Fields the runner writes back while streaming / finishing a chat turn.
/// `None` fields are omitted so a heartbeat-only PATCH doesn't clobber state.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<Value>>,
    // `null` is meaningful (clear), so serialize Some(None) as null but omit None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
}

const MAX_ATTEMPTS: u32 = 4;

/// `POST /api/agent-sessions/:id/ack` (ISS-584 C). Tells core "this runner
/// received the turn and is about to spawn claude" — a positive liveness signal
/// distinct from the first PATCH (which only lands once claude has emitted
/// output). Core uses it to fast-fail a session that ACKed but never produced a
/// claudeSessionId (claude died on startup) instead of waiting the full
/// heartbeat timeout. Best-effort: a small retry budget, and callers ignore the
/// error (the heartbeat reaper is the backstop if the ack never lands).
pub async fn ack_session(client: &CoreClient, session_id: &str) -> Result<()> {
    let url = client.url(&format!("/api/agent-sessions/{session_id}/ack"));
    let mut delay_ms: u64 = 500;
    for attempt in 1..=2u32 {
        match client
            .http()
            .post(&url)
            .bearer_auth(client.device_token())
            .send()
            .await
        {
            Ok(r) => {
                if r.status().is_success() {
                    return Ok(());
                }
                // 4xx (terminal/forbidden/not-found) is not worth retrying.
                if r.status().is_client_error() {
                    let status = r.status();
                    return Err(Error::Other(format!("ack session {status}")));
                }
            }
            Err(e) => {
                if attempt == 2 {
                    return Err(Error::Other(format!("ack_session transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(Error::Other("ack_session: exhausted retries".into()))
}

/// `PATCH /api/agent-sessions/:id` with the same exponential backoff as
/// `post_job_events`. A 409 means the session is terminal (e.g. user cancelled)
/// — surfaced as a distinct error so the caller can stop streaming.
pub async fn patch_session(
    client: &CoreClient,
    session_id: &str,
    patch: &SessionPatch,
) -> Result<()> {
    let url = client.url(&format!("/api/agent-sessions/{session_id}"));
    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client
            .http()
            .patch(&url)
            .bearer_auth(client.device_token())
            .json(patch)
            .send()
            .await;
        match resp {
            Ok(r) => {
                let status = r.status();
                if status.is_success() {
                    return Ok(());
                }
                if status.as_u16() == 409 {
                    return Err(Error::Other("SESSION_TERMINATED".into()));
                }
                if status.is_client_error() {
                    let text = r.text().await.unwrap_or_default();
                    return Err(Error::Other(format!("patch session {status}: {text}")));
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!(
                        "patch_session failed after {attempt} attempts: {status}"
                    )));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!("patch_session transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(Error::Other("patch_session: exhausted retries".into()))
}
