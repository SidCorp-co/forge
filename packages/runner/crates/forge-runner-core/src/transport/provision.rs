//! Device workspace-provisioning transport.
//!
//! - `pull_pending`  — `GET /api/devices/me/provisions`: the device's `queued`
//!   provisions (clone target + the project's git SSH private key, decrypted +
//!   delivered once over TLS — mirrors the ISS-305 credential side-channel),
//!   plus whatever core could not build, named in a header beside them.
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

/// One queued provision this device was NOT given, and why.
///
/// Core omits the row from the array and names it in the
/// `X-Forge-Provision-Failures` header instead, so one project's fault costs
/// this box that project rather than every other one it was waiting on
/// (ISS-1184). `kind` is `omitted` for a row that yielded no provision, and
/// `degraded` for one that was served with something core could not supply.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionFailure {
    pub slug: String,
    pub project_id: String,
    pub runner_id: String,
    pub kind: String,
    pub reason: String,
}

/// What one poll came back with. `dropped` counts failures that did not fit the
/// header's budget — those are on the runner's own row in web.
#[derive(Debug, Clone, Default)]
pub struct Pending {
    pub provisions: Vec<Provision>,
    pub failures: Vec<ProvisionFailure>,
    pub dropped: usize,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reported {
    #[serde(default)]
    pub failures: Vec<ProvisionFailure>,
    #[serde(default)]
    pub dropped: usize,
}

pub(crate) const FAILURES_HEADER: &str = "x-forge-provision-failures";

/// What core reported this poll, or nothing when it reported nothing. A header
/// this build cannot read is not a reason to discard the provisions that came
/// with it, so it degrades to no failures and says so.
pub(crate) fn parse_failures(raw: Option<&str>) -> Reported {
    let Some(raw) = raw else {
        return Reported::default();
    };
    match serde_json::from_str::<Reported>(raw) {
        Ok(parsed) => parsed,
        Err(e) => {
            tracing::warn!("[provision] could not read the failures core reported: {e}");
            Reported::default()
        }
    }
}

/// Fetch the device's queued provisions, and whatever core could not build.
/// Empty when nothing is queued.
pub async fn pull_pending(client: &CoreClient) -> Result<Pending> {
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
    let reported = parse_failures(
        resp.headers()
            .get(FAILURES_HEADER)
            .and_then(|v| v.to_str().ok()),
    );
    let provisions = resp
        .json::<Vec<Provision>>()
        .await
        .map_err(|e| Error::Other(format!("provisions decode: {e}")))?;
    Ok(Pending {
        provisions,
        failures: reported.failures,
        dropped: reported.dropped,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_failures_core_named() {
        let reported = parse_failures(Some(
            r#"{"failures":[{"slug":"epod-cli","projectId":"p1","runnerId":"r1","kind":"omitted","reason":"duplicate key value"}],"dropped":2}"#,
        ));
        assert_eq!(reported.failures.len(), 1);
        assert_eq!(reported.failures[0].slug, "epod-cli");
        assert_eq!(reported.failures[0].reason, "duplicate key value");
        assert_eq!(reported.dropped, 2);
    }

    #[test]
    fn reports_nothing_when_the_header_is_absent() {
        let reported = parse_failures(None);
        assert!(reported.failures.is_empty());
        assert_eq!(reported.dropped, 0);
    }

    #[test]
    fn keeps_the_provisions_when_the_header_cannot_be_read() {
        // A build older or newer than the server's shape must not lose the
        // provisions that came with the header it could not parse.
        let reported = parse_failures(Some("not json at all"));
        assert!(reported.failures.is_empty());
        assert_eq!(reported.dropped, 0);
    }
}
