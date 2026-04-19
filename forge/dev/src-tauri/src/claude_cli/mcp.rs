use super::log;
use serde_json::Value;
use uuid::Uuid;

/// Write a temporary MCP config JSON and return its path.
/// Uses the remote Strapi MCP endpoint instead of a local stdio server.
/// Merges the built-in Forge server with any extra MCP servers from project config.
pub(crate) fn write_mcp_config(
    forge_url: &str,
    forge_token: &str,
    project_slug: &str,
    extra_servers: Option<&Value>,
) -> Result<std::path::PathBuf, String> {
    let mcp_url = format!("{}/mcp", forge_url.trim_end_matches('/'));

    let mut servers = serde_json::json!({
        "forge": {
            "type": "http",
            "url": mcp_url,
            "headers": {
                "X-Forge-API-Key": forge_token,
                "X-Forge-Project-Slug": project_slug
            }
        }
    });

    if let Some(extra) = extra_servers {
        if let (Some(base_obj), Some(extra_obj)) = (servers.as_object_mut(), extra.as_object()) {
            for (name, server_cfg) in extra_obj {
                let enabled = server_cfg.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
                if enabled {
                    base_obj.insert(name.clone(), server_cfg.clone());
                }
            }
        }
    }

    let config = serde_json::json!({ "mcpServers": servers });

    let path = std::env::temp_dir().join(format!("forge-mcp-{}.json", Uuid::new_v4()));
    let json_str = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize MCP config: {e}"))?;
    std::fs::write(&path, json_str)
        .map_err(|e| format!("Failed to write MCP config: {e}"))?;
    log(&format!("[mcp] Config written to {}", path.display()));
    Ok(path)
}
