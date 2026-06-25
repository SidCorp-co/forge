//! Workspace provisioning — turn a freshly-assigned (device × project) runner
//! into a ready-to-run folder.
//!
//! Triggered by the `provision.request` WS event and by a periodic sweep (so an
//! offline device catches up on reconnect). For each `queued` provision the
//! runner pulls from core it:
//!   1. resolves the target folder (server `repoPath`, else `projects_root/<slug>`),
//!   2. writes the project's git SSH key (if delivered) and pins git to it,
//!   3. clones the repo if the folder is missing (degrades to `needs_manual_setup`
//!      when there's no repo URL / the clone can't authenticate),
//!   4. seeds `.claude/skills/`,
//!   5. writes a persistent `.mcp.json` (Forge MCP) + Forge orientation
//!      (`.forge/orientation.md` + a fixed `CLAUDE.md` pointer),
//! reporting each stage back so web renders a live stepper. Best-effort by
//! contract — a failure reports `failed`/`needs_manual_setup`, never panics.

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

    // 3. Clone if the folder isn't already a git work tree.
    let is_repo = repo_path.join(".git").exists();
    if !is_repo {
        let Some(repo_url) = p.repo_url.as_deref().filter(|u| !u.trim().is_empty()) else {
            report(
                client,
                &p.runner_id,
                "needs_manual_setup",
                Some("folder missing — set the project repo URL (and a deploy key) or create the folder manually, then re-assign"),
            )
            .await;
            return;
        };
        report(client, &p.runner_id, "cloning", None).await;
        if let Err(detail) = clone_repo(repo_url, &repo_path, ssh_cmd.as_deref()) {
            // A clone we can't complete is a manual-setup situation, not a hard
            // failure: the user can clone it themselves and re-assign.
            report(client, &p.runner_id, "needs_manual_setup", Some(&detail)).await;
            return;
        }
    }

    // Pin future pushes to the deploy key (repo-local, so we never touch global
    // git config). Applies whether we just cloned or the folder pre-existed.
    if let Some(cmd) = ssh_cmd.as_deref() {
        set_repo_ssh_command(&repo_path, cmd);
    }

    // 4. Skills.
    report(client, &p.runner_id, "syncing_skills", None).await;
    match skill_sync::sync_skills(client, &p.project_id, &repo_path).await {
        Ok(n) => tracing::info!("[provision] project={} synced {n} skill(s)", p.slug),
        Err(e) => tracing::warn!("[provision] skill sync failed: {e}"),
    }

    // 5. Persistent MCP config + Forge orientation (.forge/orientation.md +
    // CLAUDE.md pointer). Both folded under the `writing_mcp` step — neither is a
    // hard failure, so we log and press on to `ready`.
    report(client, &p.runner_id, "writing_mcp", None).await;
    if let Err(e) =
        mcp::config::write_persistent(&repo_path, client.base(), client.device_token(), &p.slug)
    {
        tracing::warn!("[provision] write .mcp.json failed: {e}");
    }
    if let Err(e) = orientation::write_orientation(&repo_path, &p.project_id, &p.slug) {
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
/// Returns the trimmed git stderr on failure. Clones the default branch — the
/// per-job dispatch resolves/checks out the working branch later.
fn clone_repo(
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
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
    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ))
    }
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
