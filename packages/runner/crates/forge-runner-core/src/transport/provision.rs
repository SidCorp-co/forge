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
/// the project has a git credential AND the server could decrypt it.
#[derive(Debug, Clone, Deserialize)]
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
    /// Core says this project's HTTPS remote authenticates through its GitHub
    /// App, so git must ask `forge-runner git-credential` per invocation.
    // cm:guard the ABSENT case must stay FALSE — this field only ever turns an extra credential source ON. Reading a missing field as `true` would attach the helper to every https remote on an older core, including repositories no App is bound to.
    // cm:edge contract -> packages/core/src/devices/routes.ts — core derives it from the repo URL transport AND an active binding with an installation; nothing type-checks the name across the two languages.
    #[serde(default)]
    pub github_app_credential: bool,
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
