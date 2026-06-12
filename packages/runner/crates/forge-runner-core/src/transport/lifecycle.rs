//! Job lifecycle: `POST /api/jobs/:id/ack`, `/complete` and `/fail`.

use super::CoreClient;
use crate::error::{Error, Result};

/// Acknowledge a claimed job (ISS-449, Decision B). Sent right after preflight
/// passes and before the runner starts. Best-effort on the caller side — the
/// server falls back to treating the first job_event as the ack.
pub async fn ack(client: &CoreClient, job_id: &str) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/ack"));
    send(client, &url, serde_json::json!({})).await
}

/// Complete a job. `exit_code` 0 = done, -1 = cancelled, else failed (core maps).
pub async fn complete(
    client: &CoreClient,
    job_id: &str,
    exit_code: i32,
    error: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/complete"));
    let body = serde_json::json!({ "exitCode": exit_code, "error": error });
    send(client, &url, body).await
}

/// Force-fail a job with an error message.
pub async fn fail(client: &CoreClient, job_id: &str, error: &str) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/fail"));
    let body = serde_json::json!({ "error": error });
    send(client, &url, body).await
}

async fn send(client: &CoreClient, url: &str, body: serde_json::Value) -> Result<()> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("lifecycle request: {e}")))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("lifecycle {status}: {text}")));
    }
    Ok(())
}
