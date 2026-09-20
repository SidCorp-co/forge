//! Device workspace-provisioning transport.
//!
//! - `pull_pending`  — `GET /api/devices/me/provisions`: the device's `queued`
//!   provisions (clone target + the project's git SSH private key, decrypted +
//!   delivered once over TLS — mirrors the ISS-305 credential side-channel).
//! - `report_status` — `POST /api/devices/me/runners/:runnerId/provision-status`:
//!   advance the live stepper (`cloning` → `syncing_skills` → `writing_mcp` →
//!   `ready` | `needs_manual_setup` | `failed`).
//!
//! Field casing mirrors core JSON (camelCase). Pull model: an offline device
//! just picks rows up on its next poll, so bind never blocks on presence.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

/// One queued provision for this device. `ssh_private_key` is present only when
/// the project has a git credential AND the server could decrypt it;
/// `mcp_credential` only when the server could resolve the identity this box
/// acts as. Both are secrets — see the hand-written `Debug` below, which
/// redacts them so a `{:?}` in a log line cannot leak one.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provision {
    pub runner_id: String,
    pub project_id: String,
    pub slug: String,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub repo_url: Option<String>,
    pub ssh_key_source: Option<String>,
    pub ssh_public_key: Option<String>,
    pub ssh_private_key: Option<String>,
    #[serde(default)]
    pub github_app_credential: bool,
    /// The token to write into this checkout's `.mcp.json`, minted by core for
    /// (this device × this project) so a person running `claude` in the folder
    /// reaches Forge without pasting one in by hand.
    #[serde(default)]
    pub mcp_credential: Option<String>,
}

impl std::fmt::Debug for Provision {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let held = |v: &Option<String>| if v.is_some() { "<redacted>" } else { "none" };
        f.debug_struct("Provision")
            .field("runner_id", &self.runner_id)
            .field("project_id", &self.project_id)
            .field("slug", &self.slug)
            .field("repo_path", &self.repo_path)
            .field("branch", &self.branch)
            .field("repo_url", &self.repo_url)
            .field("ssh_key_source", &self.ssh_key_source)
            .field("ssh_public_key", &self.ssh_public_key)
            .field("ssh_private_key", &held(&self.ssh_private_key))
            .field("github_app_credential", &self.github_app_credential)
            .field("mcp_credential", &held(&self.mcp_credential))
            .finish()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReportBody<'a> {
    status: &'a str,
    detail: Option<&'a str>,
}

/// Fetch the device's queued provisions. Empty when nothing is queued.
pub async fn pull_pending(client: &CoreClient) -> Result<Vec<Provision>> {
    let url = client.url("/api/devices/me/provisions");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("provisions request: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!(
            "provisions failed: {}",
            resp.status()
        )));
    }
    resp.json::<Vec<Provision>>()
        .await
        .map_err(|e| Error::Other(format!("provisions decode: {e}")))
}

/// Report provision progress for one runner. Best-effort: callers log on `Err`.
pub async fn report_status(
    client: &CoreClient,
    runner_id: &str,
    status: &str,
    detail: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/runners/{runner_id}/provision-status"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&ReportBody { status, detail })
        .send()
        .await
        .map_err(|e| Error::Other(format!("provision-status request: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!(
            "provision-status failed: {}",
            resp.status()
        )));
    }
    Ok(())
}
