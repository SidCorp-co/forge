//! Server-designated plugins: `GET /api/devices/me/plugins`.
//!
//! The server resolves the UNION of the plugin designations of every project this device is bound
//! to (`projects.agent_config.plugins`), because a Claude Code plugin installs at device scope —
//! one install serves every job. The local `[plugins]` block in
//! config.toml stays authoritative for whether the sweep runs at all, so an operator keeps a kill
//! switch that no server-side change can flip.

use serde::Deserialize;

use crate::CoreClient;
use runner_platform::error::Result;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignatedPlugin {
    pub marketplace: String,
    pub name: String,
    #[serde(default)]
    pub pinned_ref: Option<String>,
    /// Slugs of the bound projects that asked for it — logged, so an operator can see why a
    /// plugin appeared on this device without reading the server's DB.
    #[serde(default)]
    pub projects: Vec<String>,
    /// Present when bound projects pinned different SHAs; the server then sends no pin rather
    /// than silently picking one.
    #[serde(default)]
    pub pinned_ref_conflict: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MePluginsResponse {
    #[serde(default)]
    plugins: Vec<DesignatedPlugin>,
}

pub async fn list_designated(client: &CoreClient) -> Result<Vec<DesignatedPlugin>> {
    let parsed: MePluginsResponse = crate::status::fetch(
        client
            .get("/api/devices/me/plugins")
            .timeout(crate::LONG_DEADLINE),
        "me/plugins",
    )
    .await?;
    Ok(parsed.plugins)
}
