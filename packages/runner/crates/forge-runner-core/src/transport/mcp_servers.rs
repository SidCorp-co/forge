//! One project's declared MCP servers, resolved: `GET /api/devices/me/mcp-servers`.
//!
//! Core owns the resolution — catalog shorthand expanded, integration sentinels
//! turned into specs with freshly rendered credentials — because the box holds
//! none of the keys that takes. What arrives here is what `claude` can be handed
//! verbatim, plus the names that were declared and could NOT be supplied.

use serde::Deserialize;
use serde_json::Value;

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
    /// Declared and NOT supplied — a sentinel with no active integration behind it.
    #[serde(default)]
    pub dropped_names: Vec<String>,
}

impl ProjectMcpServers {
    /// Nothing to write and nothing to say — the shape a project that declares
    /// no servers has, and the one an older core is read as having.
    pub fn is_empty(&self) -> bool {
        self.mcp_servers.is_empty() && self.dropped_names.is_empty()
    }
}

/// Fetch one project's resolved servers. A core that does not serve this route
/// answers nothing rather than failing, so an older deployment leaves every
/// master starting exactly as it did before this existed.
pub async fn fetch(client: &CoreClient, project_id: &str) -> Result<ProjectMcpServers> {
    let url = client.url(&format!(
        "/api/devices/me/mcp-servers?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("me/mcp-servers request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Ok(ProjectMcpServers::default());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "me/mcp-servers failed: {status}: {text}"
        )));
    }
    resp.json::<ProjectMcpServers>()
        .await
        .map_err(|e| Error::Other(format!("me/mcp-servers decode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_response_missing_every_field_is_the_empty_shape() {
        let parsed: ProjectMcpServers = serde_json::from_str("{}").unwrap();
        assert!(parsed.is_empty());
        assert!(parsed.dropped_names.is_empty());
        assert!(parsed.resolved_names.is_empty());
    }

    #[test]
    fn the_camel_case_wire_names_decode_into_the_snake_case_fields() {
        let parsed: ProjectMcpServers = serde_json::from_str(
            r#"{"mcpServers":{"playwright":{"type":"stdio","command":"npx"}},
                "resolvedNames":["playwright"],"droppedNames":["epodsystem"]}"#,
        )
        .unwrap();
        assert_eq!(parsed.mcp_servers["playwright"]["command"], "npx");
        assert_eq!(parsed.resolved_names, vec!["playwright".to_string()]);
        assert_eq!(parsed.dropped_names, vec!["epodsystem".to_string()]);
        assert!(!parsed.is_empty());
    }

    /// A project that declares a sentinel nothing can supply has no servers to
    /// write and something to say, so it is NOT the empty shape.
    #[test]
    fn a_project_whose_only_declaration_dropped_is_not_empty() {
        let parsed: ProjectMcpServers =
            serde_json::from_str(r#"{"mcpServers":{},"droppedNames":["epodsystem"]}"#).unwrap();
        assert!(!parsed.is_empty());
    }
}
