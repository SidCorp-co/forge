//! Build a temp MCP config file for a job run.

use std::path::{Path, PathBuf};

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

/// Write a persistent `<repo>/.mcp.json` wiring the project's Forge MCP server
/// (device-token authed) so a human running `claude` in the provisioned folder
/// can talk to Forge out of the box. Distinct from [`write`], which is the
/// per-job temp config (it also merges integration overrides with fresh tokens).
///
/// The file carries the device token, so we add it to `.git/info/exclude` (NOT
/// the tracked `.gitignore`) to guarantee it's never committed. Idempotent.
pub fn write_persistent(
    repo_path: &Path,
    core_url: &str,
    device_token: &str,
    project_slug: &str,
) -> Result<()> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let doc = serde_json::json!({
        "mcpServers": {
            "forge": {
                "type": "http",
                "url": mcp_url,
                "headers": {
                    "Authorization": format!("Bearer {device_token}"),
                    "X-Forge-Project-Slug": project_slug
                }
            }
        }
    });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    std::fs::write(repo_path.join(".mcp.json"), body)?;
    ensure_git_excluded(repo_path, ".mcp.json");
    Ok(())
}

/// Append `entry` to `<repo>/.git/info/exclude` if not already present. Touches
/// only the local-untracked excludes, never the repo's committed `.gitignore`.
fn ensure_git_excluded(repo_path: &Path, entry: &str) {
    let info = repo_path.join(".git").join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return; // not a git repo (or no perms) — best-effort
    }
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return;
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = std::fs::write(&exclude, format!("{current}{sep}{entry}\n"));
}
