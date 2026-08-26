//! Job lifecycle: `POST /api/jobs/:id/ack`, `/complete` and `/fail`.

use super::CoreClient;
use crate::error::{Error, Result};

/// Acknowledge a claimed job (ISS-449, Decision B). Sent right after preflight
/// passes and before the runner starts. Best-effort on the caller side — the
/// server falls back to treating the first job_event as the ack.
///
/// ISS-798: `skills_ran_with` carries the on-disk `.hash` marker values for
/// each seeded skill (keyed by skill name), read right before the job starts.
/// `None` when no skills were seeded or the runner cannot determine them.
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

/// Force-fail a job, carrying what the runner preserved of its working copy.
// cm:edge contract -> packages/core/src/jobs/lifecycle-routes.ts — `failBodySchema` there is `.strict()`, so an unknown key in `salvage` rejects the WHOLE request with a 400 and the failure itself is never recorded. `workspace::salvage::Salvage::to_json` is the only thing that should build this value.
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
/// positive confirmation the job is safe to fail-and-retry (no process ever
/// existed to kill) — without it, every ordinary reap on an online runner
/// would park at `waiting` forever.
pub async fn kill_ack(client: &CoreClient, job_id: &str, outcome: &str) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/kill-ack"));
    let body = serde_json::json!({ "outcome": outcome });
    send(client, &url, body).await
}

/// Record the reviewer's structured result on the job's run. The row lands
/// `source='runner'` because THIS credential posted it — there is no
/// user-authenticated twin of this endpoint, by design.
// cm:edge contract -> packages/core/src/pipeline/verdict-routes.ts — field names and the decision vocabulary are that route's zod schema; a mismatch is a 400 the runner logs and drops, not a compile error
pub async fn verdict(
    client: &CoreClient,
    job_id: &str,
    v: &crate::workspace::verdict::Verdict,
) -> Result<()> {
    let url = client.url(&format!("/api/jobs/{job_id}/verdict"));
    let mut body = serde_json::json!({ "decision": v.decision });
    if let Some(phase) = &v.phase {
        body["phase"] = serde_json::Value::String(phase.clone());
    }
    if let Some(attempt) = v.attempt {
        body["attempt"] = serde_json::Value::from(attempt);
    }
    if let Some(findings) = &v.findings {
        body["findings"] = findings.clone();
    }
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
