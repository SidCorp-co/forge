//! Device skill sync transport (Skill Studio 4, ISS-278).
//!
//! - `pull_manifest`   — `GET /api/devices/me/skills?projectId=`: lightweight
//!   manifest (hashes only) so the runner can diff against its local cache.
//! - `pull_content`    — `GET /api/devices/me/skills/:skillId/content?projectId=`:
//!   full body for one skill whose hash changed.
//! - `report_installed`— `POST /api/devices/me/skills/report?projectId=`: echo
//!   the installed hashes back so the server can mark the device synced.
//!
//! Field casing mirrors the core JSON (camelCase) — keep in lockstep with the
//! `DeviceSkill*` contract DTOs in `packages/contracts`.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};

/// One file under a skill folder. `SKILL.md` is carried separately in
/// `skill_md`; everything else (`references/`, `scripts/`, …) lives here.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    pub path: String,
    pub content: String,
    /// `"utf8"` or `"base64"`.
    pub encoding: String,
}

/// One manifest entry (hashes only — no bodies).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManifestEntry {
    pub skill_id: String,
    pub name: String,
    pub version: i64,
    pub effective_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
struct SkillManifestResponse {
    skills: Vec<SkillManifestEntry>,
}

/// Full body for one skill.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContent {
    pub skill_id: String,
    pub name: String,
    pub version: i64,
    pub effective_hash: String,
    pub skill_md: String,
    pub files: Vec<SkillFile>,
}

/// One reported install. `installed_hash` is the `effective_hash` echoed back.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillReportEntry {
    pub skill_id: String,
    pub installed_hash: String,
    pub installed_version: i64,
}

#[derive(Debug, Clone, Serialize)]
struct SkillReportBody {
    skills: Vec<SkillReportEntry>,
}

fn map_status(label: &str, status: reqwest::StatusCode) -> Error {
    if status.as_u16() == 401 {
        Error::Other("UNAUTHORIZED".into())
    } else {
        Error::Other(format!("{label} failed: {status}"))
    }
}

/// Fetch the project's effective skill manifest (hashes only).
pub async fn pull_manifest(
    client: &CoreClient,
    project_id: &str,
) -> Result<Vec<SkillManifestEntry>> {
    let url = client.url(&format!("/api/devices/me/skills?projectId={project_id}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("skills manifest request: {e}")))?;
    if !resp.status().is_success() {
        return Err(map_status("skills manifest", resp.status()));
    }
    let body = resp
        .json::<SkillManifestResponse>()
        .await
        .map_err(|e| Error::Other(format!("skills manifest decode: {e}")))?;
    Ok(body.skills)
}

/// Fetch the full body for one skill.
pub async fn pull_content(
    client: &CoreClient,
    project_id: &str,
    skill_id: &str,
) -> Result<SkillContent> {
    let url = client.url(&format!(
        "/api/devices/me/skills/{skill_id}/content?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("skill content request: {e}")))?;
    if !resp.status().is_success() {
        return Err(map_status("skill content", resp.status()));
    }
    resp.json::<SkillContent>()
        .await
        .map_err(|e| Error::Other(format!("skill content decode: {e}")))
}

/// Report the hashes the runner installed for each seeded skill. No-op when
/// `entries` is empty.
pub async fn report_installed(
    client: &CoreClient,
    project_id: &str,
    entries: &[SkillReportEntry],
) -> Result<()> {
    if entries.is_empty() {
        return Ok(());
    }
    let url = client.url(&format!(
        "/api/devices/me/skills/report?projectId={project_id}"
    ));
    let body = SkillReportBody {
        skills: entries.to_vec(),
    };
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("skills report request: {e}")))?;
    if !resp.status().is_success() {
        return Err(map_status("skills report", resp.status()));
    }
    Ok(())
}
