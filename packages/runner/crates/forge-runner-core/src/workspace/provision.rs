//! Workspace provisioning — turn a freshly-assigned (device × project) runner
//! into a ready-to-run folder.
//!
//! Triggered by the `provision.request` WS event and by a periodic sweep (so an
//! offline device catches up on reconnect). For each `queued` provision the
//! runner pulls from core it resolves the target folder (server `repoPath`, else
//! `projects_root/<slug>`), writes the project's git SSH key when one was
//! delivered and pins git to it, clones the repo when the folder is not already a
//! work tree, then seeds `.claude/skills/`, a persistent `.mcp.json` (Forge MCP)
//! and the Forge orientation (`.forge/orientation.md` + a fixed `CLAUDE.md`
//! pointer), reporting each stage back so web renders a live stepper.
//!
//! Git is OPTIONAL: a project with no repo URL whose folder already exists is a
//! repo-less workspace (an MCP-driven storefront has no codebase) and gets every
//! non-git step. `needs_manual_setup` is reserved for the cases nothing can
//! proceed from — no resolvable path, or a missing folder with no URL to clone.
//!
//! Best-effort by contract — a failure reports `failed`/`needs_manual_setup`,
//! never panics.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::auth::git_cred;
use crate::config::Config;
use crate::error::Result;
use crate::mcp;
use crate::transport::provision::{self, Provision};
use crate::transport::CoreClient;
use crate::workspace::orientation;
use crate::workspace::skill_sync;

/// Pull all queued provisions and process them sequentially (one device, low
/// volume). Errors are logged, never propagated, so a single bad row can't wedge
/// the sweep.
pub async fn run_pending(client: &CoreClient, cfg: &Config) {
    let pending = match provision::pull_pending(client).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[provision] pull failed: {e}");
            return;
        }
    };
    if pending.is_empty() {
        return;
    }
    tracing::info!("[provision] {} pending", pending.len());
    for p in pending {
        process_one(client, cfg, &p).await;
    }
}

/// Best-effort status report (logs on failure).
async fn report(client: &CoreClient, runner_id: &str, status: &str, detail: Option<&str>) {
    if let Err(e) = provision::report_status(client, runner_id, status, detail).await {
        tracing::warn!("[provision] report {status} failed: {e}");
    }
}

async fn process_one(client: &CoreClient, cfg: &Config, p: &Provision) {
    // 1. Resolve the target folder.
    let repo_path = match resolve_path(cfg, p) {
        Some(path) => path,
        None => {
            report(
                client,
                &p.runner_id,
                "needs_manual_setup",
                Some("no repo path set for this device and no projects_root configured"),
            )
            .await;
            return;
        }
    };

    // 2. SSH key (optional). Write it + build the git ssh command.
    let ssh_cmd = match &p.ssh_private_key {
        Some(key) => match git_cred::write_project_ssh_key(&p.project_id, key) {
            Ok(path) => Some(git_cred::ssh_command(&path)),
            Err(e) => {
                tracing::warn!("[provision] write ssh key failed: {e}");
                None
            }
        },
        None => None,
    };

    // 3. Clone, or recognise a deliberately repo-less workspace.
    match classify_workspace(&repo_path, p.repo_url.as_deref()) {
        WorkspaceMode::AlreadyRepo => {}
        WorkspaceMode::RepoLess => {
            tracing::info!(
                "[provision] project={} has no repo URL and no git work tree — treating {} as a repo-less workspace",
                p.slug,
                repo_path.display()
            );
            finish_workspace(client, cfg, p, &repo_path).await;
            return;
        }
        WorkspaceMode::ManualSetup => {
            report(
                client,
                &p.runner_id,
                "needs_manual_setup",
                Some("folder missing — set the project repo URL (and a deploy key) or create the folder manually, then re-assign"),
            )
            .await;
            return;
        }
        WorkspaceMode::Clone => {
            let repo_url = p
                .repo_url
                .as_deref()
                .map(str::trim)
                .expect("WorkspaceMode::Clone implies a non-empty repo url");
            report(client, &p.runner_id, "cloning", None).await;
            // cm:guard check the base branch out BEFORE the orientation/MCP writes — the
            // dispatcher assumes the main worktree already sits on the base branch, and
            // switching afterwards collides with those now-untracked files.
            if let Err(detail) = clone_repo(
                repo_url,
                &repo_path,
                ssh_cmd.as_deref(),
                p.branch.as_deref(),
            ) {
                // cm:why an unfinishable clone is manual-setup, not `failed` — the operator can clone it by hand and re-assign, which a hard failure would not invite
                report(client, &p.runner_id, "needs_manual_setup", Some(&detail)).await;
                return;
            }
        }
    }

    // Pin future pushes to the deploy key (repo-local, so we never touch global
    // git config). Applies whether we just cloned or the folder pre-existed.
    if let Some(cmd) = ssh_cmd.as_deref() {
        set_repo_ssh_command(&repo_path, cmd);
    }

    finish_workspace(client, cfg, p, &repo_path).await;
}

/// Steps 4-6: skills, persistent MCP config, orientation, then `ready`. Shared
/// by the cloned and the repo-less paths — the workspace contents an agent needs
/// do not depend on whether git is involved.
async fn finish_workspace(client: &CoreClient, _cfg: &Config, p: &Provision, repo_path: &Path) {
    report(client, &p.runner_id, "syncing_skills", None).await;
    match skill_sync::sync_skills(client, &p.project_id, repo_path).await {
        Ok(n) => tracing::info!("[provision] project={} synced {n} skill(s)", p.slug),
        Err(e) => {
            tracing::warn!("[provision] skill sync failed: {e}");
            skill_sync::report_sync_failure(client, &p.project_id, &e).await;
        }
    }

    // cm:why neither write is a hard failure — a workspace missing its orientation
    // is degraded but usable, while refusing to reach `ready` over it would leave
    // the project looking unprovisioned and block dispatch entirely.
    report(client, &p.runner_id, "writing_mcp", None).await;
    if let Err(e) =
        mcp::config::write_persistent(repo_path, client.base(), client.device_token(), &p.slug)
    {
        tracing::warn!("[provision] write .mcp.json failed: {e}");
    }
    if let Err(e) = orientation::write_orientation(repo_path, &p.project_id, &p.slug) {
        tracing::warn!("[provision] write orientation failed: {e}");
    }

    report(client, &p.runner_id, "ready", None).await;
    tracing::info!(
        "[provision] project={} ready at {}",
        p.slug,
        repo_path.display()
    );
}

/// Server `repoPath` wins; else fall back to `projects_root/<slug>`.
fn resolve_path(cfg: &Config, p: &Provision) -> Option<PathBuf> {
    if let Some(rp) = p.repo_path.as_deref().filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(rp));
    }
    cfg.projects_root.as_ref().map(|root| root.join(&p.slug))
}

/// `git clone <url> <path>` with the deploy key (if any) via `GIT_SSH_COMMAND`.
/// Returns the trimmed git stderr on failure. When `branch` is set (the
/// project's base branch), check it out after cloning so the main worktree
/// lands on the base branch rather than the repo's default HEAD — the job
/// dispatcher assumes the base branch is already checked out here.
fn clone_repo(
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    branch: Option<&str>,
) -> std::result::Result<(), String> {
    if let Some(parent) = repo_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    let mut cmd = Command::new("git");
    cmd.arg("clone").arg(repo_url).arg(repo_path);
    if let Some(ssh) = ssh_cmd {
        cmd.env("GIT_SSH_COMMAND", ssh);
    }
    let out = cmd.output().map_err(|e| format!("spawn git clone: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }

    // A full clone already fetched every remote branch, so a local `git checkout
    // <branch>` creates a tracking branch off origin/<branch> with no network.
    // Best-effort: if the base branch doesn't exist upstream (or equals the
    // default already checked out), stay put and let provisioning continue —
    // a missing base branch shouldn't turn a good clone into needs_manual_setup.
    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        let checkout = Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .arg("checkout")
            .arg(branch)
            .output();
        match checkout {
            Ok(o) if o.status.success() => {}
            Ok(o) => tracing::warn!(
                "[provision] base-branch checkout '{branch}' failed (staying on default): {}",
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => tracing::warn!("[provision] spawn git checkout '{branch}': {e}"),
        }
    }
    Ok(())
}

/// Set repo-local `core.sshCommand` so pushes use the project deploy key.
fn set_repo_ssh_command(repo_path: &Path, ssh_cmd: &str) {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["config", "core.sshCommand", ssh_cmd])
        .output();
    if let Ok(o) = out {
        if !o.status.success() {
            tracing::warn!(
                "[provision] set core.sshCommand failed: {}",
                String::from_utf8_lossy(&o.stderr).trim()
            );
        }
    }
}

/// Process a single `provision.request` WS event (`{ runnerId, projectId }`).
/// We simply run the pending sweep — the server only returns `queued` rows, so
/// this naturally provisions the just-requested one (and any other backlog).
pub async fn handle_request(client: &CoreClient, cfg: &Config) -> Result<()> {
    run_pending(client, cfg).await;
    Ok(())
}

/// What provisioning should do with the resolved folder.
#[derive(Debug, PartialEq, Eq)]
enum WorkspaceMode {
    /// Already a git work tree — skip the clone, keep every later step.
    AlreadyRepo,
    /// Folder exists, no repo URL: a deliberate repo-less workspace.
    RepoLess,
    /// Folder exists or not, repo URL present: clone into it.
    Clone,
    /// Nothing to work with — no folder and nothing to clone from.
    ManualSetup,
}

// cm:guard the ONLY branch that may report `needs_manual_setup` is a MISSING folder
// with no URL. An existing folder without a URL is an MCP-driven project that has
// no codebase by design; refusing it there is what forced a fake `git init` before
// any such store could be provisioned at all.
fn classify_workspace(repo_path: &Path, repo_url: Option<&str>) -> WorkspaceMode {
    if repo_path.join(".git").exists() {
        return WorkspaceMode::AlreadyRepo;
    }
    let has_url = repo_url.map(str::trim).is_some_and(|u| !u.is_empty());
    if has_url {
        return WorkspaceMode::Clone;
    }
    if repo_path.is_dir() {
        WorkspaceMode::RepoLess
    } else {
        WorkspaceMode::ManualSetup
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-provision-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn a_git_work_tree_skips_the_clone() {
        let dir = tmp("already-repo");
        fs::create_dir_all(dir.join(".git")).unwrap();
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::AlreadyRepo);
        assert_eq!(
            classify_workspace(&dir, Some("git@example.com:a/b.git")),
            WorkspaceMode::AlreadyRepo
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_existing_folder_without_a_url_is_repo_less() {
        let dir = tmp("repo-less");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::RepoLess);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_blank_url_counts_as_no_url() {
        let dir = tmp("blank-url");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            classify_workspace(&dir, Some("   ")),
            WorkspaceMode::RepoLess
        );
        assert_eq!(classify_workspace(&dir, Some("")), WorkspaceMode::RepoLess);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_url_means_clone_even_into_an_existing_empty_folder() {
        let dir = tmp("clone-into-existing");
        fs::create_dir_all(&dir).unwrap();
        assert_eq!(
            classify_workspace(&dir, Some("git@example.com:a/b.git")),
            WorkspaceMode::Clone
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_folder_with_a_url_still_clones() {
        let dir = tmp("missing-with-url");
        assert_eq!(
            classify_workspace(&dir, Some("git@example.com:a/b.git")),
            WorkspaceMode::Clone
        );
    }

    #[test]
    fn only_a_missing_folder_with_no_url_needs_manual_setup() {
        let dir = tmp("missing-no-url");
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::ManualSetup);
    }
}
