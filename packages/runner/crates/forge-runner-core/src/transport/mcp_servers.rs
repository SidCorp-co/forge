//! One project's declared MCP servers, resolved: `GET /api/devices/me/mcp-servers`.
//!
//! Core owns the resolution — catalog shorthand expanded, integration sentinels
//! turned into specs with freshly rendered credentials — because the box holds
//! none of the keys that takes. What arrives here is what `claude` can be handed
//! verbatim.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpServers {
    /// Name → full server spec, ready to write into an MCP config document.
    #[serde(default)]
    pub mcp_servers: serde_json::Map<String, Value>,
    /// The names in `mcp_servers`, as core resolved them.
    #[serde(default)]
    pub resolved_names: Vec<String>,
}

impl ProjectMcpServers {
    /// Nothing to write — the shape a project that declares no servers has.
    pub fn is_empty(&self) -> bool {
        self.mcp_servers.is_empty()
    }
}

/// The deadline every call to core carries, named here for the callers that
/// reach for this read's own. [`super::CALL_DEADLINE`] is where the value and
/// the reason for it live.
pub const CALL_DEADLINE: Duration = super::CALL_DEADLINE;

pub async fn fetch(client: &CoreClient, project_id: &str) -> Result<ProjectMcpServers> {
    fetch_within(client, project_id, CALL_DEADLINE).await
}

/// [`fetch`], with the deadline a test can shorten.
///
/// Every answer but a success is a failed read, 404 included. A 404 used to be
/// read as a project declaring nothing, for a core older than the route; a
/// master started on that reading carried none of the servers the project did
/// declare, and nothing recorded why (ISS-1235). Core answers 403 for a box
/// not bound to the project, so a 404 here is a hop that does not serve the
/// route, and that is a read which did not happen.
pub async fn fetch_within(
    client: &CoreClient,
    project_id: &str,
    deadline: Duration,
) -> Result<ProjectMcpServers> {
    let url = client.url(&format!(
        "/api/devices/me/mcp-servers?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "{ROUTE} request: {}",
                super::status::unanswered(&e, deadline)
            ))
        })?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let mut reason = super::status::refused(ROUTE, status, &text);
        if status == 401 {
            reason.push_str(" — the device token was refused; `forge-runner login`");
        }
        return Err(Error::Other(reason));
    }
    resp.json::<ProjectMcpServers>().await.map_err(|e| {
        Error::Other(format!(
            "{ROUTE} response: {}",
            super::status::unanswered(&e, deadline)
        ))
    })
}

/// The route as every failure of it is named.
const ROUTE: &str = "me/mcp-servers";
