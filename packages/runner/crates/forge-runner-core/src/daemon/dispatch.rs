//! Where one assigned project's checkout is on this box, and keeping its
//! skills in step with what core holds.
//!
//! It used to run jobs too: a claimed pool row became a process here, with the
//! event drain, the salvage and the lifecycle calls that a job needed. ISS-933
//! took all of that out, because a run is a subagent inside the master's own
//! session and never reaches this process. What is left is the two things every
//! other part of the daemon still asks this module for.
//!
//! The four kinds with no issue to rank came back in ISS-1080, and they came
//! back somewhere else: `daemon/pool_jobs.rs` opens a pane per job and watches
//! it, with no job token, no event drain and no salvage. Nothing of the machinery
//! this module lost is wanted there, and a caller looking for the pool reader
//! here would find this header instead.
// cm:edge contract -> packages/runner/crates/forge-runner-core/src/daemon/pool_jobs.rs — the pool reader core's `devices/pool-routes.ts`, `ws/master-wake.ts` and `jobs/prepare-claimed-job.ts` all point at. Until 2026-09-17 those three annotations named THIS file and no box read a pool at all.

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
pub(crate) struct Resolved {
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
/// Returns `Ok(None)` when the project is assigned but has no usable path on
/// either side (caller emits a `bind` hint), and `Err` only never (kept simple).
pub(crate) fn resolve_repo(
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
        Err(e) => {
            tracing::warn!("[skill.sync] project={project_id} sync failed: {e}");
            skill_sync::report_sync_failure(client, &project_id, &e).await;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Binding;

    fn me(project_id: &str, slug: &str, repo_path: Option<&str>) -> MeRunner {
        MeRunner {
            project_id: project_id.into(),
            runner_id: "run-1".into(),
            slug: slug.into(),
            base_branch: Some("main".into()),
            repo_path: repo_path.map(str::to_string),
            branch: None,
            status: "online".into(),
            workspace_setup: None,
            master_policy: None,
            rate_limited_for_seconds: None,
            limit_reason: None,
        }
    }

    fn cfg_with_binding(slug: &str, project_id: Option<&str>, repo_path: &str) -> Config {
        let mut cfg = Config::default();
        cfg.bindings.insert(
            slug.into(),
            Binding {
                repo_path: PathBuf::from(repo_path),
                branch: None,
                project_id: project_id.map(str::to_string),
            },
        );
        cfg
    }

    #[test]
    fn prefers_server_path_over_config() {
        let server = vec![me("p-1", "app", Some("/srv/app"))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/srv/app"));
        assert_eq!(r.slug, "app");
    }

    #[test]
    fn falls_back_to_config_when_server_path_empty() {
        let server = vec![me("p-1", "app", Some("   "))];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    #[test]
    fn falls_back_to_config_when_not_on_server() {
        let server = vec![];
        let cfg = cfg_with_binding("app", Some("p-1"), "/local/app");
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.repo_path, PathBuf::from("/local/app"));
    }

    // cm:guard whitespace must resolve to `None`, not to `Some("   ")`. An owner who clears the fact by blanking it in the editor is asking for the skill's defaults back, and a brief that then carries an empty policy heading tells the master the owner said nothing in particular — which is a different instruction from having set none.
    #[test]
    fn a_blank_master_policy_is_no_policy() {
        let mut server = vec![me("p-1", "app", Some("/srv/app"))];
        server[0].master_policy = Some("  \n ".into());
        let cfg = Config::default();
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.master_policy, None);
    }

    #[test]
    fn master_policy_is_carried_from_the_server() {
        let mut server = vec![me("p-1", "app", Some("/srv/app"))];
        server[0].master_policy = Some(" Budget: 5 sessions. ".into());
        let cfg = Config::default();
        let r = resolve_repo(&server, &cfg, "p-1").expect("resolves");
        assert_eq!(r.master_policy.as_deref(), Some("Budget: 5 sessions."));
    }

    #[test]
    fn errs_with_slug_when_no_path_anywhere() {
        let server = vec![me("p-1", "app", None)];
        let cfg = Config::default();
        let err = resolve_repo(&server, &cfg, "p-1").unwrap_err();
        assert_eq!(err, "app");
    }
}
