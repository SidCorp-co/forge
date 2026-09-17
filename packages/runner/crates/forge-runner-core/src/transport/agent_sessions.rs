//! Interactive-chat session transport: `POST /api/agent-sessions/:id/events`
//! and `PATCH /api/agent-sessions/:id`.
//!
//! A chat turn's transcript is DELIVERED as the raw stream-json lines the CLI
//! produced, numbered by this runner, and core derives it (ISS-1030). This
//! runner does not parse that wire and holds no opinion about what a line means.
//! The PATCH carries only the turn's status, its Claude session id, the process
//! state and — on a failure — the error to record; it no longer carries a
//! transcript, because building one here is what threw every tool frame away.
//!
//! A terminal `status` (`completed`/`failed`) closes the one-shot
//! `pipeline_run kind='interactive'` via `closeRunIfOneShot` (ISS-321). Chat
//! never touches the `jobs` table, which is why its lines have a carrier of
//! their own rather than riding `job_events`.

use serde::Serialize;
use serde_json::Value;

use super::CoreClient;
use crate::error::{Error, Result};

/// One raw stream-json line on its way to core, with the number that is its
/// identity for the life of the session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LineEvent {
    pub seq: u64,
    pub kind: &'static str,
    pub data: Value,
}

impl LineEvent {
    /// A `stdout` line. The payload is the parsed JSON exactly as the CLI wrote
    /// it: this runner reads no field of it but `type`, and only to drop the
    /// one frame kind core does not store.
    pub fn stdout(seq: u64, line: Value) -> Self {
        Self {
            seq,
            kind: "stdout",
            data: serde_json::json!({ "line": line }),
        }
    }
}

/// Marks an answer that means "core cannot store what this batch carries".
// cm:guard the caller MUST stop the turn on this and say so, never retry past
// it: a 400 here names a line core cannot represent, and the same body will be
// refused for ever. A turn that kept going would deliver the rest of its lines
// on the far side of the hole, and the fold holds at a hole — so the transcript
// would end at that line looking exactly like a turn that stopped talking.
pub const REFUSED: &str = "TRANSCRIPT_REFUSED";

/// True when core has refused this batch rather than failed to take it.
pub fn is_refused(e: &Error) -> bool {
    e.to_string().contains(REFUSED)
}

/// Post one chunk of numbered lines, with the same backoff `post_job_events`
/// uses.
///
/// cm:guard the retry re-sends the IDENTICAL body, and that is safe only
/// because `seq` is assigned here and core inserts `ON CONFLICT DO NOTHING` on
/// `(agent_session_id, seq)`. A batch that committed and lost its response is
/// posted again and stores nothing the second time. Moving the numbering to the
/// server would store every line of such a batch twice.
async fn post_chunk(client: &CoreClient, session_id: &str, events: &[LineEvent]) -> Result<()> {
    let url = client.url(&format!("/api/agent-sessions/{session_id}/events"));
    let body = serde_json::json!({ "events": events });
    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client
            .http()
            .post(&url)
            .bearer_auth(client.device_token())
            .json(&body)
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
                    return Err(Error::Other(format!("{REFUSED}: {status}: {text}")));
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!(
                        "post_events failed after {attempt} attempts: {status}"
                    )));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!("post_events transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(Error::Other("post_events: exhausted retries".into()))
}

/// How many lines one request may carry; core's own schema caps the batch here.
const MAX_BATCH: usize = 100;

/// Deliver this turn's lines, chunked.
///
/// cm:guard the error says how many lines were STORED before it, because they
/// were. A batch past the first is delivered on its own request, so a failure
/// here leaves earlier chunks committed on the server — and an operator told
/// that none of the turn was stored goes looking for a transcript that is
/// partly there. The count is what the caller puts in front of a person.
pub async fn post_events(
    client: &CoreClient,
    session_id: &str,
    events: &[LineEvent],
) -> Result<()> {
    let total = events.len();
    let mut delivered = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        if let Err(e) = post_chunk(client, session_id, chunk).await {
            return Err(Error::Other(format!(
                "post_events: {delivered} of {total} line(s) were stored before this failed: {e}"
            )));
        }
        delivered += chunk.len();
    }
    Ok(())
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
    // `null` is meaningful (clear), so serialize Some(None) as null but omit None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
    // cm:guard the runner reports the error as a STRING and core writes the
    // transcript entry for it. A `messages` array used to ride this patch and a
    // failed turn appended its own `system` entry — which is what made the runner
    // a producer of transcript entries, the thing ISS-1030 removed. The
    // `toolCallCount` that sat here went with it: the transcript can answer what
    // a turn called now, so a counter beside it is a second answer to one
    // question.
    // cm:edge contract -> packages/core/src/agent-sessions/routes.ts — `turnError` on patchSchema there, device principal only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_error: Option<String>,
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Answers `first`, then `second`, then closes — two chunks, two verdicts.
    async fn serve_two(first: &'static str, second: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for status in [first, second] {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 65536];
                let _ = sock.read(&mut buf).await;
                let body = r#"{"accepted":0}"#;
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        format!("http://{addr}")
    }

    fn lines(n: usize) -> Vec<LineEvent> {
        (1..=n)
            .map(|seq| LineEvent::stdout(seq as u64, serde_json::json!({ "type": "assistant" })))
            .collect()
    }

    // cm:guard the message a person reads must not claim more was lost than was.
    // A second chunk refused leaves the first one COMMITTED on the server, and
    // "stored none of it" sends whoever is investigating to look for a
    // transcript that is partly there.
    #[tokio::test]
    async fn a_refusal_of_the_second_chunk_says_the_first_was_stored() {
        let url = serve_two("200 OK", "400 Bad Request").await;
        let client = CoreClient::new(url, String::from("tok"));
        let err = post_events(&client, "s-1", &lines(MAX_BATCH + 1))
            .await
            .expect_err("the second chunk was refused");
        let text = err.to_string();
        assert!(
            text.contains(&format!(
                "{MAX_BATCH} of {} line(s) were stored",
                MAX_BATCH + 1
            )),
            "the error must count what landed: {text}"
        );
    }

    #[tokio::test]
    async fn a_first_chunk_refused_reports_nothing_stored() {
        let url = serve_two("400 Bad Request", "400 Bad Request").await;
        let client = CoreClient::new(url, String::from("tok"));
        let err = post_events(&client, "s-1", &lines(3))
            .await
            .expect_err("the only chunk was refused");
        assert!(err.to_string().contains("0 of 3 line(s) were stored"));
    }
}
