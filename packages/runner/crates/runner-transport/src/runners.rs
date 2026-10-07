//! Runner assignment discovery + self-service repo-path update (ISS-271).
//!
//! - `list_me` — `GET /api/devices/me/runners`: which projects this device is
//!   bound to, with the server-side repo path/branch.
//! - `patch_runner` — `PATCH /api/devices/me/runners/:runnerId`: push this
//!   device's repo path/branch back to the server so web and CLI write the
//!   same source-of-truth field.

use std::time::Duration;

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;
use serde::{Deserialize, Deserializer};

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
    pub master_policy: Option<String>,
    /// The project document's `source.git.repository` (`host/owner/name`). `None` on a project
    /// that declares no git source.
    #[serde(default)]
    pub repository: Option<String>,
    /// Core mints a git credential for that repository, so `bind --path` points the checkout's
    /// credential helper at its host the way a provision does (ISS-50).
    #[serde(default)]
    pub host_credential: bool,
    #[serde(default, deserialize_with = "lenient_seconds")]
    pub rate_limited_for_seconds: Option<u64>,
    /// Why core limited this runner (`usage_limit`, `auth`, …). Reported in the
    /// pass log so an operator can tell a 5-hour window from a dead credential.
    #[serde(default)]
    pub limit_reason: Option<String>,
    /// The orientation a checkout of this project carries, served by core so the
    /// daemon's start writes what a provision would. `None` from an older core.
    #[serde(default)]
    pub orientation: Option<String>,
}

impl MeRunner {
    /// Where this project's checkout is on this box: the server's `repo_path` (the source
    /// of truth that the web UI and the CLI both write through `PATCH /me/runners`) when it
    /// names one, else this box's own binding. `None` where neither does.
    pub fn checkout_in(&self, cfg: &runner_platform::config::Config) -> Option<std::path::PathBuf> {
        self.repo_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .map(std::path::PathBuf::from)
            .or_else(|| {
                cfg.bindings
                    .iter()
                    .find(|(_, b)| b.project_id.as_deref() == Some(self.project_id.as_str()))
                    .map(|(_, b)| b.repo_path.clone())
            })
    }
}

/// List the projects this device is assigned to. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
///
/// This is the first call the master sweep makes, so a peer that accepts the
/// connection and never answers stopped the sweep for every project behind it
/// — no pool read, no registration, nothing recorded (ISS-1233).
pub async fn list_me(client: &CoreClient) -> Result<Vec<MeRunner>> {
    list_me_within(client, CALL_DEADLINE).await
}

/// [`list_me`], with the deadline a test can shorten.
pub async fn list_me_within(client: &CoreClient, deadline: Duration) -> Result<Vec<MeRunner>> {
    status::fetch_within(
        client.get("/api/devices/me/runners"),
        "me/runners",
        deadline,
    )
    .await
}

/// Push this device's repo path/branch for one runner row up to the server.
/// `repo_path`/`branch` of `None` are omitted (left unchanged server-side).
pub async fn patch_runner(
    client: &CoreClient,
    runner_id: &str,
    repo_path: Option<&str>,
    branch: Option<&str>,
) -> Result<()> {
    let path = format!("/api/devices/me/runners/{runner_id}");
    let mut body = serde_json::Map::new();
    if let Some(p) = repo_path {
        body.insert("repoPath".into(), serde_json::Value::String(p.to_string()));
    }
    if let Some(b) = branch {
        body.insert("branch".into(), serde_json::Value::String(b.to_string()));
    }
    let req = client.patch(&path).json(&serde_json::Value::Object(body));
    status::send_within(req, "patch runner", CALL_DEADLINE).await?;
    Ok(())
}

fn lenient_seconds<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    let raw = serde_json::Value::deserialize(d)?;
    Ok(match raw {
        serde_json::Value::Number(n) => {
            n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))
        }
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_platform::config::{Binding, Config};

    fn row(repo_path: Option<&str>) -> MeRunner {
        serde_json::from_value(serde_json::json!({
            "projectId": "p1", "runnerId": "r1", "slug": "s", "baseBranch": null,
            "repoPath": repo_path, "branch": null, "status": "idle", "masterPolicy": null,
        }))
        .unwrap()
    }

    fn cfg_binding(path: &str) -> Config {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            "s".into(),
            Binding {
                repo_path: path.into(),
                branch: None,
                project_id: Some("p1".into()),
            },
        );
        cfg
    }

    #[test]
    fn the_servers_path_wins_and_a_blank_one_falls_back_to_the_binding() {
        let cfg = cfg_binding("/local");
        assert_eq!(
            row(Some("/server")).checkout_in(&cfg).unwrap().to_str(),
            Some("/server")
        );
        assert_eq!(
            row(Some("  ")).checkout_in(&cfg).unwrap().to_str(),
            Some("/local")
        );
        assert_eq!(
            row(None).checkout_in(&cfg).unwrap().to_str(),
            Some("/local")
        );
        assert!(row(None).checkout_in(&Config::default()).is_none());
    }
}
