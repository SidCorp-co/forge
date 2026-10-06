//! Workspace provisioning — turn a freshly-assigned (device × project) runner
//! into a ready-to-run folder.
//!
//! Triggered by the `provision.request` WS event and by a periodic sweep. For
//! each `queued` provision: resolve the target folder (server `repoPath`, else
//! `projects_root/<slug>`), bring the repo in through the box credential, then
//! seed `.claude/skills/`, a persistent `.mcp.json` and the Forge orientation, reporting each stage so web renders a live stepper.
//!
//! Git is OPTIONAL — see `classify_workspace` for the five shapes the target
//! folder can take and which one earns `needs_manual_setup`. The load-bearing
//! one is `Adopt`: `git clone` refuses a non-empty destination, and a
//! repo-less workspace that later gains a repo URL is exactly that.
//!
//! Best-effort by contract — a failure reports `failed`/`needs_manual_setup`,
//! never panics.

use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::process::Command;

use crate::git_cred;
use crate::mcp;
use crate::orientation;
use crate::skill_sync;
use crate::trust;
use runner_platform::config::Config;
use runner_platform::error::Result;
use runner_transport::provision::{self, Provision};
use runner_transport::runners;
use runner_transport::CoreClient;

/// Pull all queued provisions and process them sequentially (one device, low
/// volume). Errors are logged, never propagated, so a single bad row can't wedge
/// the sweep. A checkout another process is provisioning right now is left to it.
pub async fn run_pending(client: &CoreClient, cfg: &Config) {
    let Some(provisions) = pull(client).await else {
        return;
    };
    for p in provisions {
        process_one(client, cfg, &p, Contended::LeaveIt).await;
    }
}

/// The queued provisions core returned, with what it could not build said per project.
async fn pull(client: &CoreClient) -> Option<Vec<Provision>> {
    let pending = match provision::pull_pending(client).await {
        Ok(p) => p,
        Err(e) => {
            provision::report_pull_refusal(&e);
            return None;
        }
    };
    // What core could not build, named per project. This used to arrive as
    // `provisions failed: 500 Internal Server Error` for the whole device,
    // every ninety seconds, saying neither which project nor why (ISS-1184).
    for f in &pending.failures {
        tracing::warn!("[provision] {} {}: {}", f.slug, f.kind, f.reason);
    }
    if pending.dropped > 0 {
        tracing::warn!(
            "[provision] {} further failure(s) did not fit the response header — each one is on its runner's row in web",
            pending.dropped
        );
    }
    if pending.provisions.is_empty() {
        return None;
    }
    tracing::info!("[provision] {} pending", pending.provisions.len());
    Some(pending.provisions)
}

/// Queue `runner_id`'s provision and run that one alone, waiting for a checkout another process
/// holds. Every other queued project on the device is the daemon's sweep's, never this caller's: a
/// `bind` that took them cloned other projects inside the CLI, racing the sweep for the same folder.
/// Whether core returned this runner's provision to run.
pub async fn reprovision(client: &CoreClient, cfg: &Config, runner_id: &str) -> bool {
    report(client, runner_id, "queued", None).await;
    let Some(own) = pull(client)
        .await
        .and_then(|all| all.into_iter().find(|p| p.runner_id == runner_id))
    else {
        return false;
    };
    process_one(client, cfg, &own, Contended::WaitForIt).await;
    true
}

/// Best-effort status report (logs on failure).
async fn report(client: &CoreClient, runner_id: &str, status: &str, detail: Option<&str>) {
    if let Err(e) = provision::report_status(client, runner_id, status, detail).await {
        tracing::warn!("[provision] report {status} failed: {e}");
    }
}

async fn process_one(client: &CoreClient, cfg: &Config, p: &Provision, contended: Contended) {
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
    // 2. One provisioner per checkout across every process on this box: two `git clone`s into one
    // folder leave the provision on whichever report came last.
    let Some(_held) = hold_checkout(client, p, &repo_path, contended).await else {
        return;
    };

    let cred_host = credential_host(p);
    let git_cfg = cred_host
        .as_deref()
        .map(git_cred::credential_helper_git_args)
        .unwrap_or_default();

    // 3. Clone, or recognise a deliberately repo-less workspace.
    match classify_workspace(&repo_path, p.repo_url.as_deref()) {
        WorkspaceMode::AlreadyRepo => {}
        WorkspaceMode::RepoLess => {
            if let Err(detail) = ensure_repo_less_dir(&repo_path) {
                report(client, &p.runner_id, "needs_manual_setup", Some(&detail)).await;
                return;
            }
            tracing::info!(
                "[provision] project={} has no repo URL and no git work tree — treating {} as a repo-less workspace",
                p.slug,
                repo_path.display()
            );
            finish_workspace(client, cfg, p, &repo_path).await;
            return;
        }
        WorkspaceMode::Occupied(extra) => {
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
            if let Err(detail) =
                adopt_repo(repo_url, &repo_path, &git_cfg, p.branch.as_deref()).await
            {
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
            if let Err(detail) =
                clone_repo(repo_url, &repo_path, &git_cfg, p.branch.as_deref()).await
            {
                report(client, &p.runner_id, "needs_manual_setup", Some(&detail)).await;
                return;
            }
        }
    }

    if let Some(host) = cred_host.as_deref() {
        if let Err(e) = git_cred::set_repo_credential_helper(&repo_path, host) {
            tracing::error!("[provision] {e}");
        }
    }

    finish_workspace(client, cfg, p, &repo_path).await;
}

/// The held provision lock on `repo_path`, or `None` once what stopped it is reported or logged.
async fn hold_checkout(
    client: &CoreClient,
    p: &Provision,
    repo_path: &Path,
    contended: Contended,
) -> Option<std::fs::File> {
    let lock_dir = match runner_platform::config::base_dir() {
        Ok(base) => base.join("locks"),
        Err(e) => {
            let detail = format!(
                "the provision lock for {} has no directory: {e}",
                repo_path.display()
            );
            report(client, &p.runner_id, "failed", Some(&detail)).await;
            return None;
        }
    };
    match checkout_lock(&lock_dir, repo_path, contended).await {
        Ok(Some(held)) => Some(held),
        Ok(None) => {
            tracing::info!(
                "[provision] {}: another process on this box is provisioning {} — it reports this provision",
                p.slug,
                repo_path.display()
            );
            None
        }
        Err(detail) => {
            report(client, &p.runner_id, "failed", Some(&detail)).await;
            None
        }
    }
}

/// What a provisioner does when another process on this box holds the checkout.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Contended {
    /// The daemon's sweep: the holder reports this provision, and the next sweep sees the outcome.
    LeaveIt,
    /// `bind`: the person asked for this checkout, so the call waits for the holder and then runs
    /// over what it left, which every step here takes as it finds it.
    WaitForIt,
}

/// The lock file serialising provisions of `repo_path`: one per checkout, under `lock_dir`.
fn checkout_lock_path(lock_dir: &Path, repo_path: &Path) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(repo_path.to_string_lossy().as_bytes());
    lock_dir.join(format!("provision-{}.lock", &hex::encode(digest)[..16]))
}

/// The held lock on `repo_path`'s provision, released when dropped; `None` where another process
/// holds it and `contended` says to leave it; or why the lock could not be taken at all.
async fn checkout_lock(
    lock_dir: &Path,
    repo_path: &Path,
    contended: Contended,
) -> std::result::Result<Option<std::fs::File>, String> {
    let path = checkout_lock_path(lock_dir, repo_path);
    let said = |e: std::io::Error| {
        format!(
            "the provision lock {} for {} could not be taken: {e}",
            path.display(),
            repo_path.display()
        )
    };
    std::fs::create_dir_all(lock_dir).map_err(said)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(said)?;
    match contended {
        Contended::LeaveIt => match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(std::fs::TryLockError::WouldBlock) => Ok(None),
            Err(std::fs::TryLockError::Error(e)) => Err(said(e)),
        },
        Contended::WaitForIt => tokio::task::spawn_blocking(move || file.lock().map(|()| file))
            .await
            .map_err(|e| said(std::io::Error::other(e)))?
            .map(Some)
            .map_err(said),
    }
}

/// Write the checkout's orientation, answering what its provision result records.
fn orient(repo_path: &Path, p: &Provision) -> Option<String> {
    match orientation::write_orientation(repo_path, &p.project_id, &p.slug) {
        Ok(None) => None,
        Ok(Some(note)) => {
            tracing::info!("[provision] {}: orientation: {note}", p.slug);
            Some(format!("orientation: {note}"))
        }
        Err(e) => {
            tracing::warn!("[provision] {}: orientation: {e}", p.slug);
            Some(format!("orientation: {e}"))
        }
    }
}

/// Steps 4-6: skills, persistent MCP config, orientation, then `ready`. Shared
/// by the cloned and the repo-less paths — the workspace contents an agent needs
/// do not depend on whether git is involved.
async fn finish_workspace(client: &CoreClient, _cfg: &Config, p: &Provision, repo_path: &Path) {
    report(client, &p.runner_id, "syncing_skills", None).await;
    match skill_sync::sync_skills(client, &p.project_id, repo_path).await {
        Ok(n) => tracing::info!("[provision] project={} synced {n} skill(s)", p.slug),
        Err(e) => tracing::warn!("[provision] skill sync failed: {e}"),
    }

    report(client, &p.runner_id, "writing_mcp", None).await;
    let mut ready_detail: Option<String> = None;
    match mcp::config::write_persistent(
        repo_path,
        client.base(),
        &p.slug,
        p.mcp_credential.as_deref(),
    ) {
        Ok(mcp::config::PersistentMcp::Written) => {}
        // Jobs reach Forge through the credential the daemon writes per run, so
        // this does not hold the workspace back — but a human opening `claude`
        // here would find no `forge` server and no reason why. The reason rides
        // the `ready` report instead of living only in this box's log.
        Ok(mcp::config::PersistentMcp::SkippedNoPat) => {
            ready_detail = Some(
                "no credential for this checkout — core sent none with the provision and this box \
                 has no stored PAT, so .mcp.json has no `forge` entry and `claude` run by hand in \
                 this folder cannot reach Forge. An older core does not send one: \
                 `forge-runner login --pat <token>` covers it until it is upgraded."
                    .into(),
            );
        }
        Err(e) => {
            tracing::warn!("[provision] write .mcp.json failed: {e}");
            ready_detail = Some(format!(".mcp.json was not written: {e}"));
        }
    }
    match mcp::config::write_cli_borrow(&p.slug, client.base(), p.mcp_credential.as_deref()) {
        Ok(mcp::config::CliBorrow::Written(path)) => tracing::info!(
            "[provision] {}: the master pane's forge CLI borrows this checkout's credential from {}",
            p.slug,
            path.display()
        ),
        Ok(mcp::config::CliBorrow::Absent) => tracing::warn!(
            "[provision] {}: core sent no credential for this checkout, so its master pane's forge CLI reads the box's own account",
            p.slug
        ),
        Err(e) => {
            tracing::warn!("[provision] {}: the pane CLI's credential was not written: {e}", p.slug);
            let said = format!("the master pane's forge CLI credential was not written: {e}");
            ready_detail = Some(match ready_detail {
                Some(d) => format!("{d}; {said}"),
                None => said,
            });
        }
    }
    let oriented = orient(repo_path, p);
    if let Some(said) = oriented {
        ready_detail = Some(match ready_detail {
            Some(d) => format!("{d}; {said}"),
            None => said,
        });
    }
    trust::pre_trust_logged(repo_path, &p.slug);
    record_binding(p, repo_path);
    if let Some(path) = binding_to_report(p, repo_path) {
        if let Err(e) = runners::patch_runner(client, &p.runner_id, Some(&path), None).await {
            tracing::warn!(
                "[provision] {}: the device binding was not told its checkout {path}: {e}",
                p.slug
            );
            let said = format!(
                "the device binding names no checkout: this box provisioned {path} but could not \
                 record it on the binding ({e}), so core refuses this project's jobs here \
                 (checkout_unbound) until `forge-runner bind {} --path {path}` succeeds",
                p.slug
            );
            ready_detail = Some(match ready_detail {
                Some(d) => format!("{d}; {said}"),
                None => said,
            });
        }
    }
    let skill = install_master_skill(
        &p.slug,
        repo_path,
        runner_platform::config::config_dir().as_deref(),
    );
    if !skill.installed() {
        let said = format!(
            "the forge-master skill: {}",
            skill.says(Some(repo_path), runner_update::CURRENT_VERSION)
        );
        ready_detail = Some(match ready_detail {
            Some(d) => format!("{d}; {said}"),
            None => said,
        });
    }

    report(client, &p.runner_id, "ready", ready_detail.as_deref()).await;
    tracing::info!(
        "[provision] project={} ready at {}",
        p.slug,
        repo_path.display()
    );
}

/// The master skill follows the binding, not a pane (ISS-1357), so the
/// workspace carries it from the moment it is bound. `dir` is where the
/// outcome is recorded for `forge-runner status`.
fn install_master_skill(
    slug: &str,
    repo_path: &Path,
    dir: Option<&Path>,
) -> crate::master_skill::Outcome {
    use crate::master_skill::{install_and_record, Point};
    install_and_record(slug, repo_path, Point::Provision, dir)
}

/// Write the local binding for a workspace this box just provisioned.
///
/// The server row and `config.toml` used to disagree after an assignment made
/// in the web UI: the runner row said `ready` with its path while `[bindings]`
/// stayed empty, so `doctor` reported none, `sync` had no project to pull for,
/// and `forge-runner api` could not resolve a slug — the operator had to go to
/// the box and run `bind` by hand for work the server had already arranged.
/// Best-effort like every other step here: a failure is logged, and the
/// workspace is still ready.
fn record_binding(p: &Provision, repo_path: &Path) {
    let mut cfg = match Config::load() {
        Ok(cfg) => cfg,
        Err(e) => {
            tracing::warn!(
                "[provision] {}: cannot read config to record the binding: {e}",
                p.slug
            );
            return;
        }
    };
    let existing = cfg.bindings.get(&p.slug);
    let branch = p
        .branch
        .clone()
        .or_else(|| existing.and_then(|b| b.branch.clone()));
    if existing.is_some_and(|b| {
        b.repo_path == repo_path
            && b.branch == branch
            && b.project_id.as_deref() == Some(p.project_id.as_str())
    }) {
        return;
    }
    cfg.bindings.insert(
        p.slug.clone(),
        runner_platform::config::Binding {
            repo_path: repo_path.to_path_buf(),
            branch,
            project_id: Some(p.project_id.clone()),
        },
    );
    match cfg.save() {
        Ok(()) => tracing::info!(
            "[provision] {}: bound locally to {}",
            p.slug,
            repo_path.display()
        ),
        Err(e) => tracing::warn!("[provision] {}: binding not saved: {e}", p.slug),
    }
}

/// The host git's credential helper is pointed at for this checkout, or none: only where core says
/// it mints a credential for the repository (any source host since ISS-50) and the URL is HTTPS.
fn credential_host(p: &runner_transport::provision::Provision) -> Option<String> {
    if p.host_credential || p.github_app_credential {
        p.repo_url.as_deref().and_then(git_cred::https_host)
    } else {
        None
    }
}

/// The checkout this box chose for a binding that named none, which the binding must now hold:
/// a job takes its checkout from the device binding alone, so a path known only to this box's
/// `config.toml` is a path no job can be given.
fn binding_to_report(p: &Provision, repo_path: &Path) -> Option<String> {
    let named = p.repo_path.as_deref().is_some_and(|s| !s.trim().is_empty());
    (!named).then(|| repo_path.to_string_lossy().into_owned())
}

/// Server `repoPath` wins; else fall back to `projects_root/<slug>`.
fn resolve_path(cfg: &Config, p: &Provision) -> Option<PathBuf> {
    if let Some(rp) = p.repo_path.as_deref().filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(rp));
    }
    cfg.projects_root.as_ref().map(|root| root.join(&p.slug))
}

/// How long one provisioning git call may run. A clone of a large repository
/// over a slow link takes minutes; one that has not finished in this long is
/// waiting on something it will not get, and the checkout is handed to a person.
const GIT_BUDGET: Duration = Duration::from_secs(30 * 60);

/// Run `git <args>` (in `dir` where given) with no prompt and within
/// [`GIT_BUDGET`]; its trimmed stdout, or why it failed in one sentence.
async fn provision_git(
    dir: Option<&Path>,
    git_cfg: &[String],
    args: &[&std::ffi::OsStr],
) -> std::result::Result<String, String> {
    let shown = args
        .iter()
        .map(|a| a.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ");
    let mut cmd = Command::new("git");
    if let Some(d) = dir {
        cmd.arg("-C").arg(d);
    }
    runner_platform::git::non_interactive(cmd.args(git_cfg).args(args));
    let out = match tokio::time::timeout(GIT_BUDGET, cmd.output()).await {
        Err(_) => {
            return Err(format!(
                "git {shown} did not finish within {} minutes and was stopped — the remote is unreachable or asked for a credential this box cannot give without a prompt",
                GIT_BUDGET.as_secs() / 60
            ))
        }
        Ok(Err(e)) => return Err(format!("spawn git {shown}: {e}")),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        return Err(format!(
            "git {shown} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// `git clone <url> <path>`.
/// Returns the trimmed git stderr on failure. When `branch` is set (the
/// project's base branch), check it out after cloning so the main worktree
/// lands on the base branch rather than the repo's default HEAD — the job
/// dispatcher assumes the base branch is already checked out here.
async fn clone_repo(
    repo_url: &str,
    repo_path: &Path,
    git_cfg: &[String],
    branch: Option<&str>,
) -> std::result::Result<(), String> {
    if let Some(parent) = repo_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {e}"))?;
    }
    provision_git(
        None,
        git_cfg,
        &["clone".as_ref(), repo_url.as_ref(), repo_path.as_os_str()],
    )
    .await?;

    // A full clone already fetched every remote branch, so a local `git checkout
    // <branch>` creates a tracking branch off origin/<branch> with no network.
    // Best-effort: if the base branch doesn't exist upstream (or equals the
    // default already checked out), stay put and let provisioning continue —
    // a missing base branch shouldn't turn a good clone into needs_manual_setup.
    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        if let Err(e) = provision_git(
            Some(repo_path),
            &[],
            &["checkout".as_ref(), branch.as_ref()],
        )
        .await
        {
            tracing::warn!(
                "[provision] base-branch checkout '{branch}' failed (staying on default): {e}"
            );
        }
    }
    Ok(())
}

async fn in_repo(
    repo_path: &Path,
    git_cfg: &[String],
    args: Vec<&str>,
) -> std::result::Result<String, String> {
    let args: Vec<&std::ffi::OsStr> = args.iter().map(|a| a.as_ref()).collect();
    provision_git(Some(repo_path), git_cfg, &args).await
}

async fn adopt_repo(
    repo_url: &str,
    repo_path: &Path,
    git_cfg: &[String],
    branch: Option<&str>,
) -> std::result::Result<(), String> {
    let git = |args: &'static [&'static str]| in_repo(repo_path, git_cfg, args.to_vec());

    git(&["init"]).await?;
    // An adopt may re-run (a fetch that failed on a network blip), so the remote
    // may already be there. Set it either way rather than branching on `git
    // remote get-url`, which is one more process for the same outcome.
    if in_repo(
        repo_path,
        git_cfg,
        vec!["remote", "add", "origin", repo_url],
    )
    .await
    .is_err()
    {
        in_repo(
            repo_path,
            git_cfg,
            vec!["remote", "set-url", "origin", repo_url],
        )
        .await?;
    }
    git(&["fetch", "--prune", "origin"]).await?;

    let target = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            if let Err(e) = git(&["remote", "set-head", "origin", "--auto"]).await {
                tracing::warn!("[provision] {e}; reading origin/HEAD as it stands");
            }
            let head = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await?;
            head.strip_prefix("origin/").unwrap_or(&head).to_string()
        }
    };
    let remote_ref = format!("origin/{target}");
    in_repo(
        repo_path,
        git_cfg,
        vec!["checkout", "-f", "-B", &target, &remote_ref],
    )
    .await?;
    Ok(())
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
}

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

fn ensure_repo_less_dir(repo_path: &Path) -> std::result::Result<(), String> {
    std::fs::create_dir_all(repo_path).map_err(|e| {
        format!(
            "could not create the workspace folder {}: {e} — this project has no repo URL, so the folder is the whole workspace; check the path is writable by this runner",
            repo_path.display()
        )
    })
}

fn classify_workspace(repo_path: &Path, repo_url: Option<&str>) -> WorkspaceMode {
    if repo_path.join(".git").exists() {
        return WorkspaceMode::AlreadyRepo;
    }
    let has_url = repo_url.map(str::trim).is_some_and(|u| !u.is_empty());
    if !repo_path.is_dir() {
        return if has_url {
            WorkspaceMode::Clone
        } else {
            WorkspaceMode::RepoLess
        };
    }
    if !has_url {
        return WorkspaceMode::RepoLess;
    }
    match foreign_entries(repo_path) {
        Ok(extra) if !extra.is_empty() => WorkspaceMode::Occupied(extra),
        Ok(_) => {
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
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    /// A fake core whose provision pull answers `queued` (a JSON array), recording every request.
    async fn fake_core(queued: serde_json::Value) -> (CoreClient, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        let queued = queued.to_string();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                let (method, path) = loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= len || n == 0 {
                            let mut words = head.split_whitespace();
                            break (
                                words.next().unwrap_or("").to_string(),
                                words.next().unwrap_or("").to_string(),
                            );
                        }
                    }
                    if n == 0 {
                        break (String::new(), String::new());
                    }
                };
                log.lock().unwrap().push((method.clone(), path.clone()));
                let reply = if method == "GET" && path == "/api/devices/me/provisions" {
                    queued.clone()
                } else {
                    "{}".to_string()
                };
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (CoreClient::new(format!("http://{addr}"), "token"), seen)
    }

    fn queued(runner_id: &str, slug: &str) -> serde_json::Value {
        serde_json::json!({
            "runnerId": runner_id, "projectId": format!("p-{slug}"), "slug": slug,
            "repoPath": null, "branch": null, "repoUrl": null,
        })
    }

    #[tokio::test]
    async fn a_checkout_another_process_provisions_is_left_by_the_sweep_and_waited_for_by_bind() {
        let dir = std::env::temp_dir().join(format!("forge-prov-lock-{}", uuid::Uuid::new_v4()));
        let checkout = dir.join("epod");
        let other = dir.join("other");
        let held = checkout_lock(&dir, &checkout, Contended::LeaveIt)
            .await
            .unwrap()
            .expect("a free checkout is taken");
        assert!(
            checkout_lock(&dir, &checkout, Contended::LeaveIt)
                .await
                .unwrap()
                .is_none(),
            "a second provisioner of one checkout ran beside the first"
        );
        assert!(
            checkout_lock(&dir, &other, Contended::LeaveIt)
                .await
                .unwrap()
                .is_some(),
            "another checkout is not held by this one's lock"
        );
        let waiting = tokio::spawn({
            let (dir, checkout) = (dir.clone(), checkout.clone());
            async move { checkout_lock(&dir, &checkout, Contended::WaitForIt).await }
        });
        tokio::task::yield_now().await;
        assert!(
            !waiting.is_finished(),
            "bind took a checkout another process holds"
        );
        drop(held);
        let got = tokio::time::timeout(Duration::from_secs(10), waiting)
            .await
            .expect("bind waits for the holder, not for ever")
            .unwrap()
            .unwrap();
        assert!(got.is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn bind_provisions_only_its_own_runner_never_another_queued_project() {
        let (client, seen) =
            fake_core(serde_json::json!([queued("r-a", "a"), queued("r-b", "b")])).await;
        let cfg = Config::default();
        reprovision(&client, &cfg, "r-a").await;
        let seen = seen.lock().unwrap().clone();
        assert!(
            seen.iter()
                .any(|(m, p)| m == "POST" && p.contains("/runners/r-a/")),
            "its own runner is provisioned: {seen:?}"
        );
        assert!(
            !seen.iter().any(|(_, p)| p.contains("/runners/r-b/")),
            "another project's queued provision was taken by bind: {seen:?}"
        );
    }
}
