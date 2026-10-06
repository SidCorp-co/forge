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

use crate::{status, CoreClient};
use runner_platform::error::{Error, Result};

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

/// The codes by which core says a session has ended, so nothing more of the
/// turn is wanted: `events-routes.ts` answers `SESSION_TERMINATED` for a write
/// into a terminal session, and `routes.ts` answers `SESSION_CANCELLED` for a
/// late write into one the user cancelled. Every other refusal is a fault in
/// this turn's delivery and is recorded on the session as one.
const SESSION_ENDED_CODES: [&str; 2] = ["SESSION_TERMINATED", "SESSION_CANCELLED"];

/// Why a write to a session did not land, read from the code core named and
/// never from the status alone: core answers `SEQ_TAKEN_BY_CORE`,
/// `SESSION_STALE` and `SEND_ALREADY_SETTLED` with the same 409 as
/// `SESSION_CANCELLED`, and every agent-session code with no declared status
/// with 422 (`contracts/src/agent-sessions.ts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteFailure {
    /// Core has ended the session; `code` is one of [`SESSION_ENDED_CODES`].
    Ended { code: String, said: String },
    /// Core refused the write, naming `code` where its body carried one. The
    /// same bytes are refused again, so it is not retried.
    Refused { code: Option<String>, said: String },
    /// No answer, or a 5xx, after every attempt.
    Unreached(String),
}

impl WriteFailure {
    /// What happened, as a line a log or a session's `turnError` carries.
    pub fn said(&self) -> &str {
        match self {
            WriteFailure::Ended { said, .. }
            | WriteFailure::Refused { said, .. }
            | WriteFailure::Unreached(said) => said,
        }
    }

    fn prefixed(self, prefix: &str) -> Self {
        match self {
            WriteFailure::Ended { code, said } => WriteFailure::Ended {
                code,
                said: format!("{prefix}{said}"),
            },
            WriteFailure::Refused { code, said } => WriteFailure::Refused {
                code,
                said: format!("{prefix}{said}"),
            },
            WriteFailure::Unreached(said) => WriteFailure::Unreached(format!("{prefix}{said}")),
        }
    }
}

impl std::fmt::Display for WriteFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.said())
    }
}

impl From<WriteFailure> for Error {
    fn from(failure: WriteFailure) -> Self {
        Error::Other(failure.said().to_string())
    }
}

/// A 4xx answer as the failure it is, by the code its body names. `None` for
/// anything that is not a client error, which the caller retries.
fn refusal_of(name: &str, status: u16, text: &str) -> Option<WriteFailure> {
    if !(400..500).contains(&status) {
        return None;
    }
    let code = status::refusal_code(text);
    let said = status::refused(name, status, text);
    Some(match code {
        Some(code) if SESSION_ENDED_CODES.contains(&code.as_str()) => {
            WriteFailure::Ended { code, said }
        }
        code => {
            let said = match &code {
                Some(c) => format!("[{c}] {said}"),
                None => said,
            };
            WriteFailure::Refused { code, said }
        }
    })
}

async fn post_chunk(
    client: &CoreClient,
    session_id: &str,
    events: &[LineEvent],
) -> std::result::Result<(), WriteFailure> {
    let path = format!("/api/agent-sessions/{session_id}/events");
    let body = serde_json::json!({ "events": events });
    send_with_backoff("post_events", || client.post(&path).json(&body)).await
}

/// Send `request` up to [`MAX_ATTEMPTS`] times with exponential backoff. A 4xx
/// is answered at once, by the code core named ([`refusal_of`]); `name` heads
/// every failure.
async fn send_with_backoff(
    name: &str,
    request: impl Fn() -> reqwest::RequestBuilder,
) -> std::result::Result<(), WriteFailure> {
    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        match request().send().await {
            Ok(r) => {
                let status = r.status();
                if status.is_success() {
                    return Ok(());
                }
                if status.is_client_error() {
                    let text = r.text().await.unwrap_or_default();
                    if let Some(failure) = refusal_of(name, status.as_u16(), &text) {
                        return Err(failure);
                    }
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(WriteFailure::Unreached(format!(
                        "{name} failed after {attempt} attempts: {}",
                        status::named(status.as_u16())
                    )));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(WriteFailure::Unreached(format!("{name} transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(WriteFailure::Unreached(format!(
        "{name}: exhausted retries"
    )))
}

/// How many lines one request may carry; core's own schema caps the batch here.
const MAX_BATCH: usize = 100;

pub async fn post_events(
    client: &CoreClient,
    session_id: &str,
    events: &[LineEvent],
) -> std::result::Result<(), WriteFailure> {
    let total = events.len();
    let mut delivered = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        if let Err(failure) = post_chunk(client, session_id, chunk).await {
            return Err(failure.prefixed(&format!(
                "{delivered} of {total} line(s) were stored before this failed: "
            )));
        }
        delivered += chunk.len();
    }
    Ok(())
}

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<String>,
    // `null` is meaningful (clear), so serialize Some(None) as null but omit None.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub claude_session_id: Option<String>,
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
    let path = format!("/api/agent-sessions/{session_id}/ack");
    let mut delay_ms: u64 = 500;
    for attempt in 1..=2u32 {
        match client.post(&path).send().await {
            Ok(r) => {
                if r.status().is_success() {
                    return Ok(());
                }
                // 4xx (terminal/forbidden/not-found) is not worth retrying.
                if r.status().is_client_error() {
                    let said = status::named(r.status().as_u16());
                    return Err(Error::Other(format!("ack session {said}")));
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

/// `PATCH /api/agent-sessions/:id` with the same backoff as the lines, its
/// failure read by code ([`WriteFailure`]) so a caller can tell a session core
/// has ended from a write core refused.
pub async fn write_session(
    client: &CoreClient,
    session_id: &str,
    patch: &SessionPatch,
) -> std::result::Result<(), WriteFailure> {
    let path = format!("/api/agent-sessions/{session_id}");
    send_with_backoff("patch_session", || client.patch(&path).json(patch)).await
}

/// [`write_session`] for a caller that only says what went wrong.
pub async fn patch_session(
    client: &CoreClient,
    session_id: &str,
    patch: &SessionPatch,
) -> Result<()> {
    Ok(write_session(client, session_id, patch).await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_ending_codes_read_as_an_ended_session() {
        for (status, code) in [(422, "SESSION_TERMINATED"), (409, "SESSION_CANCELLED")] {
            let body = format!(r#"{{"code":"{code}","error":{{"code":"{code}"}}}}"#);
            assert!(
                matches!(refusal_of("w", status, &body), Some(WriteFailure::Ended { code: c, .. }) if c == code),
                "{status} {code} did not read as an ended session"
            );
        }
        for (status, code) in [
            (409, "SEQ_TAKEN_BY_CORE"),
            (409, "SESSION_STALE"),
            (409, "SEND_ALREADY_SETTLED"),
            (422, "TURN_NOT_USER"),
        ] {
            let body = format!(r#"{{"code":"{code}","error":{{"code":"{code}"}}}}"#);
            match refusal_of("w", status, &body) {
                Some(WriteFailure::Refused {
                    code: Some(c),
                    said,
                }) => {
                    assert_eq!(c, code);
                    assert!(said.starts_with(&format!("[{code}] w {status}")), "{said}");
                }
                other => panic!("{status} {code} read as {other:?}"),
            }
        }
    }

    #[test]
    fn the_code_is_read_under_error_alone_and_a_bare_status_is_refused_without_one() {
        let nested = r#"{"error":{"code":"SESSION_CANCELLED"}}"#;
        assert!(matches!(
            refusal_of("w", 409, nested),
            Some(WriteFailure::Ended { .. })
        ));
        assert!(matches!(
            refusal_of("w", 409, ""),
            Some(WriteFailure::Refused { code: None, .. })
        ));
        assert!(matches!(
            refusal_of("w", 422, "<html><title>Bad</title></html>"),
            Some(WriteFailure::Refused { code: None, .. })
        ));
    }

    #[test]
    fn a_server_fault_is_not_a_refusal() {
        assert_eq!(
            refusal_of("w", 503, r#"{"code":"SESSION_TERMINATED"}"#),
            None
        );
        assert_eq!(refusal_of("w", 302, ""), None);
    }
}
