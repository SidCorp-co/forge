//! Runner assignment discovery + self-service repo-path update (ISS-271).
//!
//! - `list_me` — `GET /api/devices/me/runners`: which projects this device is
//!   bound to, with the server-side repo path/branch.
//! - `patch_runner` — `PATCH /api/devices/me/runners/:runnerId`: push this
//!   device's repo path/branch back to the server so web and CLI write the
//!   same source-of-truth field.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::Deserialize;

/// One `(device × project)` assignment as returned by `/me/runners`. Field
/// casing mirrors the core JSON (camelCase) — keep in lockstep with the
/// `MeRunnerAssignment` contract DTO in `packages/contracts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeRunner {
    pub project_id: String,
    pub runner_id: String,
    pub slug: String,
    pub base_branch: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub status: String,
}

/// List the projects this device is assigned to. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
pub async fn list_me(client: &CoreClient) -> Result<Vec<MeRunner>> {
    let url = client.url("/api/devices/me/runners");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("me/runners request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Other("UNAUTHORIZED".into()));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("me/runners failed: {status}: {text}")));
    }
    resp.json::<Vec<MeRunner>>()
        .await
        .map_err(|e| Error::Other(format!("me/runners decode: {e}")))
}

/// Push this device's repo path/branch for one runner row up to the server.
/// `repo_path`/`branch` of `None` are omitted (left unchanged server-side).
pub async fn patch_runner(
    client: &CoreClient,
    runner_id: &str,
    repo_path: Option<&str>,
    branch: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!("/api/devices/me/runners/{runner_id}"));
    let mut body = serde_json::Map::new();
    if let Some(p) = repo_path {
        body.insert("repoPath".into(), serde_json::Value::String(p.to_string()));
    }
    if let Some(b) = branch {
        body.insert("branch".into(), serde_json::Value::String(b.to_string()));
    }
    let resp = client
        .http()
        .patch(&url)
        .bearer_auth(client.device_token())
        .json(&serde_json::Value::Object(body))
        .send()
        .await
        .map_err(|e| Error::Other(format!("patch runner request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Other("UNAUTHORIZED".into()));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!(
            "patch runner failed: {status}: {text}"
        )));
    }
    Ok(())
}
