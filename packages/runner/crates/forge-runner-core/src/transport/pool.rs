//! The pool half of master orchestration: what work exists, taking it,
//! handing it back, and how loaded this box is.
//!
//! Core answers all four; this box is the only thing holding a device token,
//! so a master asks through here rather than talking to core itself.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolRelation {
    pub kind: String,
    #[serde(default)]
    pub depends_on_key: Option<String>,
    // cm:guard these three stay RAW and are never folded into a boolean on the way through. The master decides what a blocker means; a `dropped` blocker and one that merged then went `reopen` need different answers, and both collapse to the same `false`.
    #[serde(default)]
    pub blocker_status: Option<String>,
    #[serde(default)]
    pub blocker_merged_at: Option<String>,
    #[serde(default)]
    pub edge_valid_until: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolEntry {
    pub job_id: String,
    #[serde(rename = "type")]
    pub job_type: String,
    #[serde(default)]
    pub issue_id: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub age_minutes: f64,
    #[serde(default)]
    pub attempts: i64,
    #[serde(default)]
    pub relations: Vec<PoolRelation>,
}

#[derive(Debug, Deserialize)]
struct PoolResponse {
    items: Vec<PoolEntry>,
}

pub async fn pool(
    client: &CoreClient,
    limit: u32,
    project_id: Option<&str>,
) -> Result<Vec<PoolEntry>> {
    let mut url = client.url(&format!("/api/devices/me/pool?limit={limit}"));
    if let Some(p) = project_id {
        url.push_str(&format!("&projectId={p}"));
    }
    let resp = get(client, &url).await?;
    let parsed: PoolResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("pool decode: {e}")))?;
    Ok(parsed.items)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOutcome {
    pub ok: bool,
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub job_token: Option<String>,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Take one job for `session_id`.
// cm:guard a refusal comes back as `ok:false` on a 200 and MUST NOT be retried in a loop. A full box and a lost race are ordinary; retrying either changes nothing and burns the master's turn budget on a condition only another master finishing can clear.
pub async fn claim(client: &CoreClient, job_id: &str, session_id: &str) -> Result<ClaimOutcome> {
    let url = client.url("/api/devices/me/pool/claim");
    let body = serde_json::json!({ "jobId": job_id, "sessionId": session_id });
    let resp = post(client, &url, body).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("claim decode: {e}")))
}

/// Hand back one job, or everything this session holds when `job_id` is None.
pub async fn release(client: &CoreClient, job_id: Option<&str>, session_id: &str) -> Result<u32> {
    let url = client.url("/api/devices/me/pool/release");
    let mut body = serde_json::json!({ "sessionId": session_id });
    if let Some(id) = job_id {
        body["jobId"] = serde_json::Value::String(id.to_string());
    }
    let resp = post(client, &url, body).await?;
    let parsed: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("release decode: {e}")))?;
    Ok(parsed.get("released").and_then(|v| v.as_u64()).unwrap_or(0) as u32)
}

/// Raw occupancy for this box, its project and the project's fleet.
// cm:guard pass this through verbatim — no derived "you may take N more" field, here or in the CLI that prints it. That number is the ceiling this design removed, and a master reading it stops weighing the facts that produced it.
pub async fn load(client: &CoreClient, project_id: Option<&str>) -> Result<serde_json::Value> {
    let mut url = client.url("/api/devices/me/load");
    if let Some(p) = project_id {
        url.push_str(&format!("?projectId={p}"));
    }
    let resp = get(client, &url).await?;
    resp.json()
        .await
        .map_err(|e| Error::Other(format!("load decode: {e}")))
}

async fn get(client: &CoreClient, url: &str) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .get(url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool request: {e}")))?;
    check(resp).await
}

async fn post(
    client: &CoreClient,
    url: &str,
    body: serde_json::Value,
) -> Result<reqwest::Response> {
    let resp = client
        .http()
        .post(url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("pool request: {e}")))?;
    check(resp).await
}

async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("pool {status}: {text}")));
    }
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relation_keeps_the_blocker_status_it_was_given() {
        let raw = serde_json::json!({
            "kind": "blocks",
            "dependsOnKey": "ISS-900",
            "blockerStatus": "dropped",
            "blockerMergedAt": null,
            "edgeValidUntil": null
        });
        let rel: PoolRelation = serde_json::from_value(raw).unwrap();
        assert_eq!(rel.blocker_status.as_deref(), Some("dropped"));
        assert!(rel.blocker_merged_at.is_none());
    }

    // cm:guard core may add fields to a pool entry at any time and a runner that predates them must still parse. Deserialisation here is permissive on purpose; making it strict turns a core deploy into a fleet-wide parse failure.
    #[test]
    fn an_entry_with_unknown_fields_still_parses() {
        let raw = serde_json::json!({
            "jobId": "j1", "type": "code", "issueKey": "ISS-1",
            "somethingCoreAddedLater": 42
        });
        let entry: PoolEntry = serde_json::from_value(raw).unwrap();
        assert_eq!(entry.job_id, "j1");
        assert_eq!(entry.job_type, "code");
        assert!(entry.relations.is_empty());
    }

    #[test]
    fn a_refusal_parses_as_a_reason_not_an_error() {
        let raw = serde_json::json!({ "ok": false, "reason": "already_held" });
        let out: ClaimOutcome = serde_json::from_value(raw).unwrap();
        assert!(!out.ok);
        assert_eq!(out.reason.as_deref(), Some("already_held"));
        assert!(out.job_token.is_none());
    }
}
