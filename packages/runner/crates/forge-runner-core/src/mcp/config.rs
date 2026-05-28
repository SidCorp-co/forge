//! Build a temp MCP config file for a job run.

use std::path::PathBuf;

use serde_json::Value;
use uuid::Uuid;

use crate::error::{Error, Result};

/// Write `{ mcpServers: { forge: <http>, ...override } }` to a temp file and
/// return its path. The Forge server points at `<core>/mcp` and authenticates
/// with the device token + project slug header.
pub fn write(
    core_url: &str,
    device_token: &str,
    project_slug: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let mut servers = serde_json::json!({
        "forge": {
            "type": "http",
            "url": mcp_url,
            "headers": {
                "Authorization": format!("Bearer {device_token}"),
                "X-Forge-Project-Slug": project_slug
            }
        }
    });

    if let Some(extra) = override_servers {
        if let (Some(base), Some(extra)) = (servers.as_object_mut(), extra.as_object()) {
            for (name, cfg) in extra {
                let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                if enabled {
                    base.insert(name.clone(), cfg.clone());
                }
            }
        }
    }

    let doc = serde_json::json!({ "mcpServers": servers });
    let path = std::env::temp_dir().join(format!("forge-mcp-{}.json", Uuid::new_v4()));
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    std::fs::write(&path, body)?;
    Ok(path)
}
