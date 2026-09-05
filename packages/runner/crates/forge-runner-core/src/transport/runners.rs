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
    /// `standard` (code repo) or `website` (Epodsystem storefront, no git repo
    /// by design). `None` when talking to a core that predates the field.
    // cm:guard `Option` + `#[serde(default)]` is what keeps an older core from breaking a runner update, and the ABSENT case must stay the CAUTIOUS one — `requires_preflight` reads `None` as "assume git-backed", so a standard project can never lose its git checks because the field failed to arrive
    #[serde(default)]
    pub kind: Option<String>,
    /// Prose from `projects.workspace_setup`: how to bring this repo's workspace
    /// to a state a stage can build, test and commit in. `None` on an older core
    /// or an undeclared project — the setup agent then derives it from the repo,
    /// which is the expensive path this field exists to retire.
    #[serde(default)]
    pub workspace_setup: Option<String>,
    /// Seconds core says remain on this runner's rate limit: `None` when it is
    /// not limited (and on a core that predates the field), `0` once expired.
    ///
    /// Advisory pacing only — see `daemon::master`.
    // cm:guard the ABSENT case must stay PERMISSIVE here, the opposite of `kind` above and deliberately so. This field may only ever slow a sweep down; if it is ever allowed to STOP one, the fleet cannot self-heal, because core clears the limit only when a job SUCCEEDS and no job can succeed while the master sits idle. Measured 2026-09-05: forge-vm cleared its own `usage_limit` by running two jobs to completion while the stamp still stood.
    // cm:edge contract -> packages/core/src/devices/routes.ts — core computes this against ITS clock so the runner needs neither a datetime parser nor a skew correction; a change to a raw instant here puts both back.
    #[serde(default)]
    pub rate_limited_for_seconds: Option<u64>,
    /// Why core limited this runner (`usage_limit`, `auth`, …). Reported in the
    /// pass log so an operator can tell a 5-hour window from a dead credential.
    #[serde(default)]
    pub limit_reason: Option<String>,
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
        return Err(Error::Unauthorized);
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
        return Err(Error::Unauthorized);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A core that predates the field must still deserialize — and land on the
    /// cautious side, since `None` makes `requires_preflight` demand the git
    /// checks.
    #[test]
    fn kind_absent_deserializes_to_none() {
        let json = r#"{"projectId":"p1","runnerId":"r1","slug":"app","baseBranch":"main",
                       "repoPath":"/srv/app","branch":null,"status":"online"}"#;
        let parsed: MeRunner = serde_json::from_str(json).expect("older core payload must parse");
        assert_eq!(parsed.kind, None);
    }

    #[test]
    fn kind_is_read_when_core_sends_it() {
        let json = r#"{"projectId":"p1","runnerId":"r1","slug":"store","baseBranch":null,
                       "repoPath":"/srv/store","branch":null,"status":"online","kind":"website"}"#;
        let parsed: MeRunner = serde_json::from_str(json).expect("payload must parse");
        assert_eq!(parsed.kind.as_deref(), Some("website"));
    }
}
