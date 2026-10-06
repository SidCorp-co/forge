//! Batch POST of job events to `POST /api/jobs/:id/events`.

use serde::Serialize;

use crate::CoreClient;
use runner_platform::error::{Error, Result};

#[derive(Debug, Clone, Serialize)]
pub struct JobEventInput {
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ts: Option<String>,
}

impl JobEventInput {
    pub fn new(kind: impl Into<String>, data: serde_json::Value) -> Self {
        Self {
            kind: kind.into(),
            data,
            ts: None,
        }
    }
}

#[derive(Serialize)]
struct Batch<'a> {
    events: &'a [JobEventInput],
}

const MAX_BATCH: usize = 100;
const MAX_ATTEMPTS: u32 = 4;

pub const DISOWNED: &str = "JOB_DISOWNED";

/// The refusal core answers a live job's events with once a person asked to cancel it.
pub const CANCEL_REQUESTED: &str = "JOB_CANCEL_REQUESTED";

/// True when core has answered that this runner no longer owns the job.
pub fn is_disowned(e: &Error) -> bool {
    e.to_string().contains(DISOWNED)
}

/// True when the refusal was a cancel: the job is still out on this box, and the box is asked to
/// end its process and say so with a kill-ack, rather than only to stop.
pub fn is_cancel_requested(e: &Error) -> bool {
    e.to_string()
        .contains(&format!("{DISOWNED} ({CANCEL_REQUESTED})"))
}

/// A refused batch, naming the code core refused it by where the body carries one.
fn disowned(status: u16, text: &str) -> Error {
    let said = crate::status::refused("events", status, text);
    let code = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|b| b.pointer("/error/code")?.as_str().map(str::to_string));
    match code {
        Some(code) => Error::Other(format!("{DISOWNED} ({code}): {said}")),
        None => Error::Other(format!("{DISOWNED}: {said}")),
    }
}

/// Post events for a job, chunked to <=100 per request with exponential-backoff
/// retry on 5xx / transport errors.
pub async fn post_job_events(
    client: &CoreClient,
    job_id: &str,
    events: &[JobEventInput],
) -> Result<usize> {
    let mut accepted = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        accepted += post_batch(client, job_id, chunk).await?;
    }
    Ok(accepted)
}

async fn post_batch(client: &CoreClient, job_id: &str, events: &[JobEventInput]) -> Result<usize> {
    let path = format!("/api/jobs/{job_id}/events");
    let body = Batch { events };

    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client.post(&path).json(&body).send().await;

        match resp {
            Ok(r) => {
                let status = r.status();
                if status.is_success() {
                    return Ok(events.len());
                }
                if matches!(status.as_u16(), 403 | 409 | 422) {
                    let text = r.text().await.unwrap_or_default();
                    return Err(disowned(status.as_u16(), &text));
                }
                let said = crate::status::named(status.as_u16());
                if status.is_client_error() {
                    return Err(Error::Other(format!("events client error: {said}")));
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!(
                        "post_job_events failed after {attempt} attempts: {said}"
                    )));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!("post_job_events transport: {e}")));
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err(Error::Other("post_job_events: exhausted retries".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_keeps_the_code_core_named_and_only_a_cancel_reads_as_one() {
        let cancel = disowned(
            422,
            r#"{"code":"JOB_CANCEL_REQUESTED","error":{"code":"JOB_CANCEL_REQUESTED","message":"m"}}"#,
        );
        assert!(is_disowned(&cancel), "{cancel}");
        assert!(is_cancel_requested(&cancel), "{cancel}");

        let over = disowned(422, r#"{"error":{"code":"JOB_TERMINATED","message":"m"}}"#);
        assert!(is_disowned(&over), "{over}");
        assert!(!is_cancel_requested(&over), "{over}");

        let bare = disowned(403, "forbidden");
        assert!(is_disowned(&bare), "{bare}");
        assert!(!is_cancel_requested(&bare), "{bare}");
    }
}
