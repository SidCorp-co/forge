//! Server-designated plugins: `GET /api/devices/me/plugins`.
//!
//! The server resolves the UNION of the plugin designations of every project this device is bound
//! to (`projects.agent_config.plugins`), because a Claude Code plugin installs at device scope —
//! one install serves every job. The local `[plugins]` block in
//! config.toml stays authoritative for whether the sweep runs at all, so an operator keeps a kill
//! switch that no server-side change can flip.

use serde::Deserialize;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignatedPlugin {
    pub marketplace: String,
    pub name: String,
    #[serde(default)]
    pub pinned_ref: Option<String>,
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Slugs of the bound projects that asked for it — logged, so an operator can see why a
    /// plugin appeared on this device without reading the server's DB.
    #[serde(default)]
    pub projects: Vec<String>,
    /// Present when bound projects pinned different SHAs; the server then sends no pin rather
    /// than silently picking one.
    #[serde(default)]
    pub pinned_ref_conflict: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct MePluginsResponse {
    #[serde(default)]
    plugins: Vec<DesignatedPlugin>,
}

pub async fn list_designated(client: &CoreClient) -> Result<Vec<DesignatedPlugin>> {
    let url = client.url("/api/devices/me/plugins");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("me/plugins request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    // cm:why a server too old to serve this route must degrade to local-only config, not wedge the sweep
    if resp.status().as_u16() == 404 {
        return Ok(Vec::new());
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("me/plugins failed: {status}: {text}")));
    }
    resp.json::<MePluginsResponse>()
        .await
        .map(|r| r.plugins)
        .map_err(|e| Error::Other(format!("me/plugins decode: {e}")))
}
