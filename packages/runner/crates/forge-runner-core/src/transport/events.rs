//! Batch POST of job events to `POST /api/jobs/:id/events`.

use serde::Serialize;

use super::CoreClient;
use crate::error::{Error, Result};

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

/// Post events for a job, chunked to <=100 per request with exponential-backoff
/// retry on 5xx / transport errors. 409 means the job is already terminal.
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
    let url = client.url(&format!("/api/jobs/{job_id}/events"));
    let body = Batch { events };

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
                    return Ok(events.len());
                }
                if status.as_u16() == 409 {
                    return Err(Error::Other("JOB_TERMINATED".into()));
                }
                if status.is_client_error() {
                    return Err(Error::Other(format!("events client error: {status}")));
                }
                if attempt == MAX_ATTEMPTS {
                    return Err(Error::Other(format!(
                        "post_job_events failed after {attempt} attempts: {status}"
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
