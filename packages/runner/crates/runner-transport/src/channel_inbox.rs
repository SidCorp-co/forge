//! What a project's ecosystem channel owes a reply to (ISS-38).
//!
//! A `master.wake` with `source: "channel"` says only that the channel moved;
//! core's room has no buffer, so the sweep reads this state on every pass and
//! a document is work for the master whether or not its wake was heard. Core
//! answers it from `ecosystem/device-channel-inbox-routes.ts`.

use crate::CoreClient;
use runner_platform::error::Result;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnansweredDocument {
    pub id: String,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub overdue: bool,
}

/// The type an open builder run is carried under beside the channel's documents (ISS-39).
pub const BUILDER_RUN_TYPE: &str = "builder-run";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenBuilderRun {
    id: String,
    ecosystem: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnansweredResponse {
    items: Vec<UnansweredDocument>,
    /// Priced amnesty: a core before ISS-39 sends no `builderRuns`, read as none
    /// open; it ends once every paired core serves it.
    #[serde(default)]
    builder_runs: Vec<OpenBuilderRun>,
}

impl UnansweredResponse {
    /// The channel's documents, then each open builder run as one more piece of master work.
    fn into_work(self) -> Vec<UnansweredDocument> {
        let runs = self.builder_runs.into_iter().map(|r| UnansweredDocument {
            id: r.id,
            number: None,
            r#type: Some(BUILDER_RUN_TYPE.into()),
            from: Some(r.ecosystem),
            overdue: false,
        });
        self.items.into_iter().chain(runs).collect()
    }
}

pub async fn unanswered(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let path = format!("/api/devices/me/channel/unanswered?projectId={project_id}");
    let parsed: UnansweredResponse =
        crate::status::fetch(client.get(&path), "channel inbox").await?;
    Ok(parsed.into_work())
}
