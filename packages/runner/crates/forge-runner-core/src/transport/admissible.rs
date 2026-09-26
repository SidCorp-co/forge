//! Whether a project has anything worth waking a master for.
//!
//! This is what is left of the pool. A box used to ask core for JOBS it could
//! claim, hold and start; a run is a subagent inside the master's own session
//! now and core hands this box no work at all. The one question that survived
//! is the one that was never about jobs: which issues this project's master
//! could open a wave over, which is how the daemon knows a resident session is
//! worth carrying and when there is something new to say to it.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

pub const DISPATCH_GATING_KIND: &str = "blocks";

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relation {
    pub kind: String,
    #[serde(default)]
    pub depends_on_key: Option<String>,
    #[serde(default)]
    pub blocker_status: Option<String>,
    #[serde(default)]
    pub blocker_merged_at: Option<String>,
    #[serde(default)]
    pub edge_valid_until: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissibleIssue {
    pub issue_id: String,
    #[serde(default)]
    pub issue_key: Option<String>,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub priority: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub age_minutes: f64,
    #[serde(default)]
    pub relations: Vec<Relation>,
}

#[derive(Debug, Deserialize)]
struct AdmissibleResponse {
    #[serde(default)]
    items: Vec<AdmissibleIssue>,
}

pub async fn admissible(
    client: &CoreClient,
    project_id: Option<&str>,
) -> Result<Vec<AdmissibleIssue>> {
    let mut url = client.url("/api/devices/me/issues/admissible");
    if let Some(p) = project_id {
        url.push_str(&format!("?projectId={p}"));
    }
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("admissible request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "admissible",
            code,
            &text,
        )));
    }
    let parsed: AdmissibleResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("admissible decode: {e}")))?;
    Ok(parsed.items)
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
        let rel: Relation = serde_json::from_value(raw).unwrap();
        assert_eq!(rel.blocker_status.as_deref(), Some("dropped"));
        assert!(rel.blocker_merged_at.is_none());
    }

    #[test]
    fn an_issue_with_unknown_fields_still_parses() {
        let raw = serde_json::json!({
            "issueId": "i1", "issueKey": "ISS-1", "status": "open",
            "somethingCoreAddedLater": 42
        });
        let issue: AdmissibleIssue = serde_json::from_value(raw).unwrap();
        assert_eq!(issue.issue_id, "i1");
        assert_eq!(issue.issue_key.as_deref(), Some("ISS-1"));
    }

    #[test]
    fn a_response_with_no_items_reads_as_no_work() {
        let parsed: AdmissibleResponse = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(parsed.items.is_empty());
    }
}
