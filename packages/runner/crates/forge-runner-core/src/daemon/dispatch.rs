use std::path::PathBuf;

use serde_json::Value;

use crate::config::Config;
use crate::error::{Error, Result};
use crate::transport::runners::{self, MeRunner};
use crate::transport::CoreClient;
use crate::workspace::skill_sync;

/// Resolved working dir for one assigned project. The server (`/me/runners`)
/// is the source of truth for `repo_path`; `config.toml` is only a local
/// fallback/cache when the server has no path set yet (ISS-271).
#[derive(Debug)]
pub struct Resolved {
    pub slug: String,
    pub repo_path: PathBuf,
    /// The project's base branch per the server, when it has one. Only the
    /// refresh reads it — the fast-forward target must be the base, not
    /// whatever the folder currently sits on.
    pub base_branch: Option<String>,
    /// The owner's standing instruction for this project's master, from the
    /// `master-policy` projectFact. Only `daemon::master` reads it — a job
    /// never sees it, because it governs what runs, not how one runs.
    pub master_policy: Option<String>,
}

/// Merge server assignments with local config bindings for one project id.
/// `Err` carries the project's slug where neither side gives it a usable path,
/// which is what a caller names in its `bind` hint.
pub fn resolve_repo(
    server: &[MeRunner],
    cfg: &Config,
    project_id: &str,
) -> std::result::Result<Resolved, String> {
    let server_match = server.iter().find(|r| r.project_id == project_id);
    let config_match = cfg
        .bindings
        .iter()
        .find(|(_, b)| b.project_id.as_deref() == Some(project_id));

    // Slug: prefer the server's authoritative slug, else the local config key.
    let slug = server_match
        .map(|r| r.slug.clone())
        .or_else(|| config_match.map(|(slug, _)| slug.clone()))
        .unwrap_or_else(|| project_id.to_string());

    // Repo path: server first (non-empty), then local config binding.
    let server_path = server_match
        .and_then(|r| r.repo_path.as_deref())
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    let repo_path = server_path.or_else(|| config_match.map(|(_, b)| b.repo_path.clone()));

    let base_branch = server_match
        .and_then(|r| r.base_branch.as_deref())
        .map(str::trim)
        .filter(|b| !b.is_empty())
        .map(str::to_string);

    let master_policy = server_match
        .and_then(|r| r.master_policy.as_deref())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    match repo_path {
        Some(repo_path) => Ok(Resolved {
            slug,
            repo_path,
            base_branch,
            master_policy,
        }),
        None => Err(slug),
    }
}

pub async fn handle_skill_sync(client: &CoreClient, cfg: &Config, data: Value) -> Result<()> {
    let project_id = data
        .get("projectId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Other("skill.sync: missing projectId".into()))?
        .to_string();

    let server = runners::list_me(client).await.unwrap_or_default();
    let resolved = match resolve_repo(&server, cfg, &project_id) {
        Ok(r) => r,
        Err(slug) => {
            tracing::warn!(
                "[skill.sync] project '{slug}' is assigned here but has no repo path — skipping"
            );
            return Ok(());
        }
    };

    match skill_sync::sync_skills(client, &project_id, &resolved.repo_path).await {
        Ok(n) => tracing::info!(
            "[skill.sync] project={project_id} synced {n} skill(s) into {}",
            resolved.repo_path.join(".claude/skills").display()
        ),
        Err(e) => tracing::warn!("[skill.sync] project={project_id} sync failed: {e}"),
    }
    Ok(())
}
