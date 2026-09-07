//! Workspace provisioning — turn a freshly-assigned (device × project) runner
//! into a ready-to-run folder.
//!
//! Triggered by the `provision.request` WS event and by a periodic sweep. For
//! each `queued` provision: resolve the target folder (server `repoPath`, else
//! `projects_root/<slug>`), write the project git SSH key and pin git to it,
//! bring the repo in, then seed `.claude/skills/`, a persistent `.mcp.json` and
//! the Forge orientation, reporting each stage so web renders a live stepper.
//!
//! Git is OPTIONAL — see `classify_workspace` for the five shapes the target
//! folder can take and which one earns `needs_manual_setup`. The load-bearing
//! one is `Adopt`: `git clone` refuses a non-empty destination, and a
//! repo-less workspace that later gains a repo URL is exactly that.
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
use crate::workspace::trust;

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

/// Re-run provisioning for one runner NOW, from a lane that found the workspace
/// unusable. Returns once the pull has been drained; the caller re-checks the
/// workspace itself rather than trusting a status.
///
/// Flips the server row back to `queued` because that is what `/me/provisions`
/// filters on — the pull is the mechanism, not a detail of it.
// cm:guard go through the SERVER row; never call clone_repo/adopt_repo from another module. This path is the only one that receives the decrypted deploy key (`/me/provisions` delivers it once, per ISS-305's side-channel) and the only one that also writes `.mcp.json`, skills and `orientation.md`. A caller that shortcuts to the clone gets a checkout no agent can work in.
// cm:guard `queued` makes this runner ineligible for SELECTION (the server requires provision_status ready), which is correct for a box whose workspace is broken but only safe because the job that triggered this is ALREADY claimed. Never call this before a claim.
pub async fn reprovision(client: &CoreClient, cfg: &Config, runner_id: &str) {
    report(client, runner_id, "queued", None).await;
    run_pending(client, cfg).await;
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
        WorkspaceMode::Occupied(extra) => {
            // cm:guard name the files and the folder, and say what to do with them — the message this replaced forwarded raw git stderr ("destination path '/home/forge/projects/anhome' already exists and is not an empty directory"), which states a fact and asks for nothing. An operator read it 8 times over 8 hours without a next step.
            let listed = extra.iter().take(5).cloned().collect::<Vec<_>>().join(", ");
            let more = if extra.len() > 5 {
                format!(" (+{} more)", extra.len() - 5)
            } else {
                String::new()
            };
            report(
                client,
                &p.runner_id,
                "needs_manual_setup",
                Some(&format!(
                    "{} already holds files this runner did not create ({listed}{more}), so the repo cannot be cloned or adopted into it. Either clone the project there by hand and re-assign, or move/empty the folder and re-provision.",
                    repo_path.display()
                )),
            )
            .await;
            return;
        }
        WorkspaceMode::Adopt => {
            tracing::info!(
                "[provision] project={} adopting repo into existing workspace {}",
                p.slug,
                repo_path.display()
            );
            let repo_url = p
                .repo_url
                .as_deref()
                .map(str::trim)
                .expect("WorkspaceMode::Adopt implies a non-empty repo url");
            report(client, &p.runner_id, "cloning", None).await;
            if let Err(detail) = adopt_repo(
                repo_url,
                &repo_path,
                ssh_cmd.as_deref(),
                p.branch.as_deref(),
            ) {
                report(client, &p.runner_id, "needs_manual_setup", Some(&detail)).await;
                return;
            }
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
    if let Err(e) = mcp::config::write_persistent(repo_path, client.base(), &p.slug) {
        tracing::warn!("[provision] write .mcp.json failed: {e}");
    }
    if let Err(e) = orientation::write_orientation(repo_path, &p.project_id, &p.slug) {
        tracing::warn!("[provision] write orientation failed: {e}");
    }
    // cm:guard the workspace is pre-trusted HERE, where the box first owns the path, and not only in `daemon::master`. A master pane is started every sweep and this runs once per provision, so the source fix is the cheap one and the master's is the retrofit for every box provisioned before this shipped.
    trust::pre_trust_logged(repo_path, &p.slug);

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

/// Turn an existing non-empty folder into a checkout of `repo_url` WITHOUT
/// moving it: `git init`, add the remote, fetch, then force the base branch out
/// over whatever provisioning had already written there.
///
/// This is the documented recipe for the one thing `git clone` refuses. It is
/// only ever reached from `WorkspaceMode::Adopt`, which has already established
/// that every file present is one this provisioner wrote.
// cm:guard `checkout -f` is safe ONLY under that precondition — `PROVISIONED_ENTRIES` is what establishes it, and the two must be read together. Calling this on an arbitrary folder discards uncommitted work with no prompt.
fn adopt_repo(
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    branch: Option<&str>,
) -> std::result::Result<(), String> {
    let git = |args: &[&str]| -> std::result::Result<String, String> {
        let mut cmd = Command::new("git");
        cmd.arg("-C").arg(repo_path).args(args);
        if let Some(ssh) = ssh_cmd {
            cmd.env("GIT_SSH_COMMAND", ssh);
        }
        let out = cmd
            .output()
            .map_err(|e| format!("spawn git {}: {e}", args.join(" ")))?;
        if !out.status.success() {
            return Err(format!(
                "git {} failed: {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };

    git(&["init"])?;
    // An adopt may re-run (a fetch that failed on a network blip), so the remote
    // may already be there. Set it either way rather than branching on `git
    // remote get-url`, which is one more process for the same outcome.
    if git(&["remote", "add", "origin", repo_url]).is_err() {
        git(&["remote", "set-url", "origin", repo_url])?;
    }
    git(&["fetch", "--prune", "origin"])?;

    let target = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            // cm:why derive the default from the REMOTE, never assume `main` — a repo whose default is `master`/`develop` would otherwise land on a branch that does not exist and fail the checkout after a successful fetch
            let _ = git(&["remote", "set-head", "origin", "--auto"]);
            let head = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?;
            head.strip_prefix("origin/").unwrap_or(&head).to_string()
        }
    };
    let remote_ref = format!("origin/{target}");
    git(&["checkout", "-f", "-B", &target, &remote_ref])?;
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
    /// Missing or empty folder, repo URL present: clone into it.
    Clone,
    /// Folder holds only this provisioner's own output: adopt the repo in place.
    Adopt,
    /// Occupied by content this runner did not write; the names that are in the way.
    Occupied(Vec<String>),
    /// Nothing to work with — no folder and nothing to clone from.
    ManualSetup,
}

/// Everything this provisioner writes into a workspace itself.
// cm:guard keep this in lockstep with what `finish_workspace` writes — it is the entire basis for calling an adopt non-destructive. A name that belongs to the repo but is missing here turns `Adopt` into `Occupied` (harmless, just a manual step); a name this runner writes but is NOT here means a real file gets force-checked-out over, which is data loss.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/orientation.rs — writes `.forge/orientation.md` and `CLAUDE.md`
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/mcp/config.rs — writes `.mcp.json`
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/skill_sync.rs — writes `.claude/skills/`
const PROVISIONED_ENTRIES: &[&str] = &[".claude", ".mcp.json", ".forge", "CLAUDE.md"];

/// Entries in `dir` that this provisioner did not write. `Err` on an unreadable
/// directory, which the caller must treat as occupied rather than as empty.
fn foreign_entries(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut extra = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if !PROVISIONED_ENTRIES.contains(&name.as_str()) {
            extra.push(name);
        }
    }
    extra.sort();
    Ok(extra)
}

// cm:guard an existing folder + a repo URL is NOT automatically `Clone` — `git clone` refuses a non-empty destination ("destination path '...' already exists and is not an empty directory"), and provisioning is what put files there: a repo-less workspace gets `.mcp.json`/`.forge`/`CLAUDE.md`, so the day someone sets the repo URL every re-provision fails identically, forever, with a raw git error and no way forward (ubuntu1/anhome, 2026-08-14).
// cm:guard an existing folder without a URL is an MCP-driven project that has no codebase by design — it must stay `RepoLess`. Refusing it is what forced a fake `git init` before any such store could be provisioned at all.
fn classify_workspace(repo_path: &Path, repo_url: Option<&str>) -> WorkspaceMode {
    if repo_path.join(".git").exists() {
        return WorkspaceMode::AlreadyRepo;
    }
    let has_url = repo_url.map(str::trim).is_some_and(|u| !u.is_empty());
    if !repo_path.is_dir() {
        return if has_url {
            WorkspaceMode::Clone
        } else {
            WorkspaceMode::ManualSetup
        };
    }
    if !has_url {
        return WorkspaceMode::RepoLess;
    }
    match foreign_entries(repo_path) {
        Ok(extra) if !extra.is_empty() => WorkspaceMode::Occupied(extra),
        Ok(_) => {
            // cm:why an empty folder still takes the plain clone — it is the cheaper, better-understood path, and adopt exists only for the case clone cannot do
            if std::fs::read_dir(repo_path)
                .map(|d| d.count() == 0)
                .unwrap_or(false)
            {
                WorkspaceMode::Clone
            } else {
                WorkspaceMode::Adopt
            }
        }
        Err(e) => WorkspaceMode::Occupied(vec![format!("<unreadable: {e}>")]),
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

    // cm:guard this is the whole state the Adopt mode exists for — a repo-less workspace that LATER gained a repo URL. Before it, every re-provision reported the raw git refusal and nothing an operator could act on (ubuntu1/anhome, 8 hours, 2026-08-14). If this test ever expects Clone again, the loop is back.
    #[test]
    fn a_folder_holding_only_our_own_output_is_adopted_not_cloned() {
        let dir = tmp("adopt");
        fs::create_dir_all(dir.join(".claude/skills")).unwrap();
        fs::create_dir_all(dir.join(".forge")).unwrap();
        fs::write(dir.join(".mcp.json"), "{}").unwrap();
        fs::write(dir.join("CLAUDE.md"), "pointer").unwrap();
        assert_eq!(
            classify_workspace(&dir, Some("git@example.com:a/b.git")),
            WorkspaceMode::Adopt
        );
        let _ = fs::remove_dir_all(&dir);
    }

    // cm:guard a folder with anything else in it must NEVER be adopted — adopt ends in `checkout -f`, so the only thing separating a recovery from silent data loss is this branch
    #[test]
    fn a_folder_with_foreign_files_is_occupied_and_names_them() {
        let dir = tmp("occupied");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".mcp.json"), "{}").unwrap();
        fs::write(dir.join("notes.txt"), "mine").unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        assert_eq!(
            classify_workspace(&dir, Some("git@example.com:a/b.git")),
            WorkspaceMode::Occupied(vec!["notes.txt".into(), "src".into()])
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_repo_less_workspace_stays_repo_less_even_when_we_wrote_into_it() {
        let dir = tmp("repo-less-provisioned");
        fs::create_dir_all(dir.join(".forge")).unwrap();
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::RepoLess);
        let _ = fs::remove_dir_all(&dir);
    }
}
