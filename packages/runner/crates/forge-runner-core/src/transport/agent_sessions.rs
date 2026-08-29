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

/// Report the PROCESS state for a session with no other patch riding along.
/// Used when the session ends with nobody consuming its event stream — the
/// idle ceiling closing an abandoned resident session.
// cm:guard best-effort by design: a failed report must not take down the close. The row is left claiming `awaiting_input` on a session whose status is already terminal, which the heartbeat hop does not look at — a lost PATCH here costs a stale field, while a close that unwound on it would leak the process this call exists to record the death of.
pub async fn report_runtime_state(client: &CoreClient, session_id: &str, state: &str) {
    let patch = SessionPatch {
        runtime_state: Some(state.to_string()),
        ..Default::default()
    };
    if let Err(e) = patch_session(client, session_id, &patch).await {
        tracing::debug!("[chat {session_id}] runtime-state report ({state}): {e}");
    }
}

/// Fields the runner writes back while streaming / finishing a chat turn.
/// `None` fields are omitted so a heartbeat-only PATCH doesn't clobber state.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPatch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    // cm:edge contract -> packages/core/src/agent-sessions/routes.ts — `runtimeState` on patchSchema there is a `.strict()` enum accepted from the DEVICE principal only, and `awaiting_input` is the one value that exempts a session from the heartbeat hop. A value this side does not have there is a 400 the runner logs and drops, leaving the park invisible and the session reaped at 3 minutes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<Value>>,
    // `null` is meaningful (clear), so serialize Some(None) as null but omit None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    // cm:guard OMIT rather than send 0 when the count is unknown — core reads absent as "this runner cannot report" and a reported 0 as "this run called nothing", and only the second one fails a schedule session. Send 0 from a path that never counted and every run on that path is recorded blind.
    // cm:edge contract -> packages/core/src/agent-sessions/routes.ts — `toolCallCount` on patchSchema there; the transcript carries no tool frames (parse_assistant_message keeps assistant text only), so this counter is core's ONLY evidence that a scheduled run read anything
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_count: Option<u32>,
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
