//! Whether a project has anything worth waking a master for.
//!
//! This is what is left of the pool. A box used to ask core for JOBS it could
//! claim, hold and start; a run is a subagent inside the master's own session
//! now and core hands this box no work at all. The one question that survived
//! is the one that was never about jobs: which issues this project's master
//! could open a wave over, which is how the daemon knows a resident session is
//! worth carrying and when there is something new to say to it.

use crate::CoreClient;
use runner_platform::error::Result;
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
    let mut path = "/api/devices/me/issues/admissible".to_string();
    if let Some(p) = project_id {
        path.push_str(&format!("?projectId={p}"));
    }
    let parsed: AdmissibleResponse = crate::status::fetch(client.get(&path), "admissible").await?;
    Ok(parsed.items)
}
