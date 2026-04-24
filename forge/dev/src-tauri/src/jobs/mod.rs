//! JobEvent batch POST to `forge/core`.
//!
//! Scaffolded per ISS-214 §4. Current implementation ships a direct per-call
//! POST that the Rust claude_cli parser can invoke. The accumulator + 500 ms
//! cadence + exponential-backoff retry is noted for a follow-up pass once
//! `forge/dev` has a job-id to feed events against (end-to-end pair →
//! dispatch → stream lands in ISS-218).

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct JobEventInput {
    pub kind: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ts: Option<String>,
}

#[derive(Debug, Serialize)]
struct Batch<'a> {
    events: &'a [JobEventInput],
}

const MAX_BATCH: usize = 100;
const MAX_ATTEMPTS: u32 = 4;

pub async fn post_job_events(
    core_url: &str,
    device_token: &str,
    job_id: &str,
    events: Vec<JobEventInput>,
) -> Result<usize, String> {
    let mut accepted = 0usize;
    for chunk in events.chunks(MAX_BATCH) {
        accepted += post_batch(core_url, device_token, job_id, chunk).await?;
    }
    Ok(accepted)
}

async fn post_batch(
    core_url: &str,
    device_token: &str,
    job_id: &str,
    events: &[JobEventInput],
) -> Result<usize, String> {
    let url = format!(
        "{}/api/jobs/{}/events",
        core_url.trim_end_matches('/'),
        job_id
    );
    let client = reqwest::Client::new();
    let body = Batch { events };

    let mut delay_ms: u64 = 1000;
    for attempt in 1..=MAX_ATTEMPTS {
        let resp = client
            .post(&url)
            .bearer_auth(device_token)
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
                    return Err("JOB_TERMINATED".into());
                }
                if status.is_client_error() {
                    return Err(format!("client error: {status}"));
                }
                if !status.is_server_error() || attempt == MAX_ATTEMPTS {
                    return Err(format!("post_job_events failed after {attempt} attempts: {status}"));
                }
            }
            Err(e) => {
                if attempt == MAX_ATTEMPTS {
                    return Err(format!("post_job_events transport: {e}"));
                }
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
        delay_ms = delay_ms.saturating_mul(2);
    }
    Err("post_job_events: exhausted retries".into())
}
