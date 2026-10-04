//! Job lifecycle: `POST /api/jobs/:id/ack`, `/complete` and `/fail`.

use super::CoreClient;
use crate::error::{Error, Result};

pub async fn ack(
    client: &CoreClient,
    job_id: &str,
    skills_ran_with: Option<serde_json::Value>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/ack"));
    let body = if let Some(srw) = skills_ran_with {
        serde_json::json!({ "skillsRanWith": srw })
    } else {
        serde_json::json!({})
    };
    send(client, &url, body).await
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
    fail_with_salvage(client, job_id, error, None).await
}

pub async fn fail_with_salvage(
    client: &CoreClient,
    job_id: &str,
    error: &str,
    salvage: Option<serde_json::Value>,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/fail"));
    let mut body = serde_json::json!({ "error": error });
    if let Some(s) = salvage {
        body["salvage"] = s;
    }
    send(client, &url, body).await
}

/// ISS-785 — answer a `job.cancel` frame with the real outcome (`"killed"` or
/// `"not_found"`). Core's kill-before-reap gate treats `not_found` as
/// positive confirmation the job is safe to fail-and-retry (no process exists
/// to kill) — without it, every ordinary reap on an online runner would park
/// at `waiting` forever. ISS-862 made that word earn its meaning: the caller
/// asks `runner::inflight` before saying it, so an empty session map after a
/// restart no longer passes for a dead process.
pub async fn kill_ack(client: &CoreClient, job_id: &str, outcome: &str) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/kill-ack"));
    let body = serde_json::json!({ "outcome": outcome });
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
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let said = super::status::refused("lifecycle", code, &text);
        // A rule refusal: 409 before ISS-162, 422 from it on, 403 or 409 by its code from ISS-186.
        if matches!(code, 403 | 409 | 422) {
            return Err(Error::Other(format!(
                "{}: {said}",
                crate::transport::events::DISOWNED
            )));
        }
        return Err(Error::Other(said));
    }
    Ok(())
}

pub async fn turn_is_job_end(client: &CoreClient, job_id: &str) -> bool {
    let url = client.url(&format!("/api/jobs/{job_id}/turn-verdict"));
    let resp = match client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => {
            tracing::warn!(
                "[job {job_id}] turn-verdict {}: finishing the job",
                r.status()
            );
            return true;
        }
        Err(e) => {
            tracing::warn!("[job {job_id}] turn-verdict: {e} — finishing the job");
            return true;
        }
    };
    match resp.json::<serde_json::Value>().await {
        Ok(v) => v
            .get("done")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(true),
        Err(e) => {
            tracing::warn!("[job {job_id}] turn-verdict body: {e} — finishing the job");
            true
        }
    }
}
