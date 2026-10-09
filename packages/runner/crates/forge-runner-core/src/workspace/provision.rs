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
use std::process::{Command, Output, Stdio};
use std::time::Duration;

use crate::auth::git_cred;
use crate::config::Config;
use crate::daemon::master::{Masters, ProvisionLease, Refused};
use crate::daemon::terminal;
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
pub async fn run_pending(client: &CoreClient, cfg: &Config, masters: Option<&Masters>) {
    let pending = match provision::pull_pending(client).await {
        Ok(p) => p,
        Err(e) => {
            provision::report_pull_refusal(&e);
            return;
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
        return;
    }
    tracing::info!("[provision] {} pending", pending.provisions.len());
    for p in pending.provisions {
        process_one(client, cfg, masters, &p).await;
    }
}

/// `masters` is `None` for `forge-runner bind`, a process that serves no master; core refuses a bind
/// over a live master by name before that process asks for a provision.
pub async fn reprovision(client: &CoreClient, cfg: &Config, runner_id: &str) {
    report(client, runner_id, "queued", None).await;
    run_pending(client, cfg, None).await;
}

/// Best-effort status report (logs on failure).
async fn report(client: &CoreClient, runner_id: &str, status: &str, detail: Option<&str>) {
    if let Err(e) = provision::report_status(client, runner_id, status, detail).await {
        tracing::warn!("[provision] report {status} failed: {e}");
    }
}

async fn process_one(client: &CoreClient, cfg: &Config, masters: Option<&Masters>, p: &Provision) {
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

    // Held to the end of this provision, so no master is placed under its writes.
    let pane = terminal::session_name(terminal::MASTER_PREFIX, &p.slug);
    let pane_up = async { terminal::available() && terminal::alive(&pane).await };
    let _lease = match claim_workspace(masters, p, &repo_path, pane_up).await {
        Ok(lease) => lease,
        Err(said) => {
            tracing::warn!("[provision] {said}");
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

    let cred_host = if p.github_app_credential {
        p.repo_url.as_deref().and_then(git_cred::https_host)
    } else {
        None
    };
    let git_cfg = cred_host
        .as_deref()
        .map(git_cred::credential_helper_git_args)
        .unwrap_or_default();

    // 3. Clone, or recognise a deliberately repo-less workspace.
    match classify_workspace(&repo_path, p.repo_url.as_deref()) {
        WorkspaceMode::AlreadyRepo => {
            if p.repo_url.as_deref().is_some_and(|u| !u.trim().is_empty()) {
                if let Err(stop) = require_a_commit(&repo_path, GIT_STEP_LIMIT).await {
                    report(client, &p.runner_id, stop.status, Some(&stop.detail)).await;
                    return;
                }
            }
        }
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
            if let Err(stop) = adopt_repo(
                repo_url,
                &repo_path,
                ssh_cmd.as_deref(),
                &git_cfg,
                p.branch.as_deref(),
                GIT_STEP_LIMIT,
            )
            .await
            {
                report(client, &p.runner_id, stop.status, Some(&stop.detail)).await;
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
            if let Err(stop) = clone_repo(
                repo_url,
                &repo_path,
                ssh_cmd.as_deref(),
                &git_cfg,
                p.branch.as_deref(),
                GIT_STEP_LIMIT,
            )
            .await
            {
                report(client, &p.runner_id, stop.status, Some(&stop.detail)).await;
                return;
            }
        }
    }

    // Pin future pushes to the deploy key (repo-local, so we never touch global
    // git config). Applies whether we just cloned or the folder pre-existed.
    if let Some(cmd) = ssh_cmd.as_deref() {
        set_repo_ssh_command(&repo_path, cmd);
    }
    if let Some(host) = cred_host.as_deref() {
        git_cred::set_repo_credential_helper(&repo_path, host);
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
    if let Err(e) = orientation::write_orientation(repo_path, &p.project_id, &p.slug) {
        tracing::warn!("[provision] write orientation failed: {e}");
    }
    trust::pre_trust_logged(repo_path, &p.slug);
    record_binding(p, repo_path);
    let skill = install_master_skill(
        &p.slug,
        repo_path,
        crate::daemon::control::config_dir().as_deref(),
    );
    if !skill.installed() {
        let said = format!(
            "the forge-master skill: {}",
            skill.says(Some(repo_path), crate::update::CURRENT_VERSION)
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
) -> crate::daemon::master_skill::Outcome {
    use crate::daemon::master_skill::{install_and_record, Point};
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
        crate::config::Binding {
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

/// Server `repoPath` wins; else fall back to `projects_root/<slug>`.
fn resolve_path(cfg: &Config, p: &Provision) -> Option<PathBuf> {
    if let Some(rp) = p.repo_path.as_deref().filter(|s| !s.trim().is_empty()) {
        return Some(PathBuf::from(rp));
    }
    cfg.projects_root.as_ref().map(|root| root.join(&p.slug))
}

/// How long one git step of a clone or an adopt may run before it is killed. Core calls a provision
/// stalled after thirty minutes without a report, so a step must give up well inside that.
const GIT_STEP_LIMIT: Duration = Duration::from_secs(600);

/// Why a clone or an adopt stopped, and the status the row is to be left at. A timeout is `failed`
/// and not `needs_manual_setup`: nothing about the folder or the key is for a person to set up.
#[derive(Debug)]
struct Stop {
    status: &'static str,
    detail: String,
}

impl Stop {
    fn manual(detail: String) -> Self {
        Self {
            status: "needs_manual_setup",
            detail,
        }
    }

    fn timed_out(what: &str, limit: Duration) -> Self {
        Self {
            status: "failed",
            detail: format!(
                "{what} did not finish within {}s and was killed, so this provision stopped there and the sweep went on to the next. A slow link or a git host that does not answer does this; re-provision once it does.",
                limit.as_secs()
            ),
        }
    }
}

/// One git invocation under `limit`. On overrun the child and everything it spawned (ssh, the
/// transport helpers) are killed, so nothing is left holding the folder, and the answer is `None`.
async fn run_git(
    mut cmd: tokio::process::Command,
    limit: Duration,
) -> std::io::Result<Option<Output>> {
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let child = cmd.spawn()?;
    #[cfg(unix)]
    let group = child.id();
    match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(out) => out.map(Some),
        Err(_) => {
            #[cfg(unix)]
            if let Some(pid) = group {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(pid as i32),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
            Ok(None)
        }
    }
}

fn git_command(
    program: &Path,
    repo_path: Option<&Path>,
    git_cfg: &[String],
    ssh_cmd: Option<&str>,
) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    if let Some(dir) = repo_path {
        cmd.arg("-C").arg(dir);
    }
    cmd.args(git_cfg);
    if let Some(ssh) = ssh_cmd {
        cmd.env("GIT_SSH_COMMAND", ssh);
    }
    cmd
}

/// What a clone that timed out wrote into the folder, which was empty or missing or it would not
/// have been a clone: git killed mid-write leaves a `.git` that reads as a repository, and the next
/// provision would report that `ready`.
fn clear_partial_clone(repo_path: &Path) -> std::result::Result<(), String> {
    let entries = match std::fs::read_dir(repo_path) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("read {}: {e}", repo_path.display())),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let removed = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
        removed.map_err(|e| format!("remove {}: {e}", path.display()))?;
    }
    Ok(())
}

/// Empties what an overrun clone wrote, and says so in `stop` where it could not: a `.git` left
/// behind reads as a repository on the next provision, which would report it `ready`.
fn clear_after_overrun(stop: &mut Stop, repo_path: &Path) {
    if let Err(e) = clear_partial_clone(repo_path) {
        stop.detail.push_str(&format!(
            " What it had written to {} could not be removed ({e}); empty that folder before provisioning again.",
            repo_path.display()
        ));
    }
}

/// `git clone <url> <path>` with the deploy key (if any) via `GIT_SSH_COMMAND`.
/// Returns the trimmed git stderr on failure. When `branch` is set (the
/// project's base branch), check it out after cloning so the main worktree
/// lands on the base branch rather than the repo's default HEAD — the job
/// dispatcher assumes the base branch is already checked out here.
async fn clone_repo(
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    git_cfg: &[String],
    branch: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    clone_repo_with(
        Path::new("git"),
        repo_url,
        repo_path,
        ssh_cmd,
        git_cfg,
        branch,
        limit,
    )
    .await
}

async fn clone_repo_with(
    program: &Path,
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    git_cfg: &[String],
    branch: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    if let Some(parent) = repo_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| Stop::manual(format!("mkdir parent: {e}")))?;
    }
    let mut cmd = git_command(program, None, git_cfg, ssh_cmd);
    cmd.arg("clone").arg(repo_url).arg(repo_path);
    let out = match run_git(cmd, limit).await {
        Ok(Some(out)) => out,
        Ok(None) => {
            let mut stop = Stop::timed_out("git clone", limit);
            clear_after_overrun(&mut stop, repo_path);
            return Err(stop);
        }
        Err(e) => return Err(Stop::manual(format!("spawn git clone: {e}"))),
    };
    if !out.status.success() {
        return Err(Stop::manual(format!(
            "git clone failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    if let Some(branch) = branch.map(str::trim).filter(|b| !b.is_empty()) {
        if let Err(mut stop) = checkout_base_branch(program, repo_path, branch, limit).await {
            clear_after_overrun(&mut stop, repo_path);
            return Err(stop);
        }
    }
    Ok(())
}

/// A full clone already fetched every remote branch, so a local `git checkout <branch>` creates a
/// tracking branch off origin/<branch> with no network. A branch that is missing upstream (or is
/// the default already checked out) stays where it is: it should not turn a good clone into
/// needs_manual_setup. A checkout that overruns its limit is another matter, and is a failure by
/// name like any other step, because nothing says what state the tree was left in.
async fn checkout_base_branch(
    program: &Path,
    repo_path: &Path,
    branch: &str,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    let mut cmd = git_command(program, Some(repo_path), &[], None);
    cmd.arg("checkout").arg(branch);
    match run_git(cmd, limit).await {
        Ok(Some(o)) if o.status.success() => {}
        Ok(Some(o)) => tracing::warn!(
            "[provision] base-branch checkout '{branch}' failed (staying on default): {}",
            String::from_utf8_lossy(&o.stderr).trim()
        ),
        Ok(None) => return Err(Stop::timed_out(&format!("git checkout {branch}"), limit)),
        Err(e) => tracing::warn!("[provision] spawn git checkout '{branch}': {e}"),
    }
    Ok(())
}

async fn adopt_repo(
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    git_cfg: &[String],
    branch: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    adopt_repo_with(
        Path::new("git"),
        repo_url,
        repo_path,
        ssh_cmd,
        git_cfg,
        branch,
        limit,
    )
    .await
}

/// An adopt works inside a folder that holds only this provisioner's own output, and what it adds
/// is a `.git`. When it stops anywhere, that `.git` goes, whichever step stopped it: left behind it
/// reads as a checkout on the next provision, which reports a repository with no commit `ready`
/// (ISS-1359). A `.git` that was there before the adopt began is not the adopt's, and stays.
async fn adopt_repo_with(
    program: &Path,
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    git_cfg: &[String],
    branch: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    let had_git = repo_path.join(".git").exists();
    let mut done = adopt_steps(
        program, repo_url, repo_path, ssh_cmd, git_cfg, branch, limit,
    )
    .await;
    if let (Err(stop), false) = (&mut done, had_git) {
        if let Err(e) = clear_adopted_git(repo_path) {
            stop.detail.push_str(&format!(
                " The .git it made in {} could not be removed ({e}); delete it before provisioning again, or the next provision reads it as a checkout.",
                repo_path.display()
            ));
        }
    }
    done
}

fn clear_adopted_git(repo_path: &Path) -> std::result::Result<(), String> {
    let git = repo_path.join(".git");
    let removed = match std::fs::symlink_metadata(&git) {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(&git),
        Ok(_) => std::fs::remove_file(&git),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => Err(e),
    };
    removed.map_err(|e| format!("remove {}: {e}", git.display()))
}

async fn adopt_steps(
    program: &Path,
    repo_url: &str,
    repo_path: &Path,
    ssh_cmd: Option<&str>,
    git_cfg: &[String],
    branch: Option<&str>,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    let git = |args: &[&str]| {
        let mut cmd = git_command(program, Some(repo_path), git_cfg, ssh_cmd);
        cmd.args(args);
        let what = format!("git {}", args.join(" "));
        async move {
            match run_git(cmd, limit).await {
                Ok(Some(out)) if out.status.success() => {
                    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
                }
                Ok(Some(out)) => Err(Stop::manual(format!(
                    "{what} failed: {}",
                    String::from_utf8_lossy(&out.stderr).trim()
                ))),
                Ok(None) => Err(Stop::timed_out(&what, limit)),
                Err(e) => Err(Stop::manual(format!("spawn {what}: {e}"))),
            }
        }
    };

    git(&["init"]).await?;
    // Set the remote either way rather than branching on `git remote get-url`, which is one more
    // process for the same outcome.
    if let Err(stop) = git(&["remote", "add", "origin", repo_url]).await {
        if stop.status == "failed" {
            return Err(stop);
        }
        git(&["remote", "set-url", "origin", repo_url]).await?;
    }
    git(&["fetch", "--prune", "origin"]).await?;

    let target = match branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(b) => b.to_string(),
        None => {
            // A failure here is tolerated, because the symbolic-ref below names what is missing;
            // a step that overran is not, because nothing says what state it left the repository in.
            if let Err(stop) = git(&["remote", "set-head", "origin", "--auto"]).await {
                if stop.status == "failed" {
                    return Err(stop);
                }
            }
            let head = git(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).await?;
            head.strip_prefix("origin/").unwrap_or(&head).to_string()
        }
    };
    let remote_ref = format!("origin/{target}");
    git(&["checkout", "-f", "-B", &target, &remote_ref]).await?;
    Ok(())
}

/// An existing checkout that holds no commit cannot serve a project that names a remote, and
/// reporting it `ready` hands a master a repository with nothing in it. A failed adopt used to
/// leave exactly that (ISS-1359), so the shape is in the field already: it is refused by name,
/// and the folder is left as it is for a person to look at.
async fn require_a_commit(repo_path: &Path, limit: Duration) -> std::result::Result<(), Stop> {
    require_a_commit_with(Path::new("git"), repo_path, limit).await
}

async fn require_a_commit_with(
    program: &Path,
    repo_path: &Path,
    limit: Duration,
) -> std::result::Result<(), Stop> {
    let mut cmd = git_command(program, Some(repo_path), &[], None);
    cmd.args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    match run_git(cmd, limit).await {
        Ok(Some(out)) if out.status.success() => Ok(()),
        Ok(Some(_)) => Err(Stop::manual(format!(
            "{} is a git repository with no commit, so it cannot serve a project whose code is at a remote. A failed adopt leaves this. Delete its .git (nothing in it is lost; it holds no commit) or clone the project there by hand, then re-provision.",
            repo_path.display()
        ))),
        Ok(None) => Err(Stop::timed_out("git rev-parse HEAD", limit)),
        Err(e) => Err(Stop::manual(format!("spawn git rev-parse HEAD: {e}"))),
    }
}

/// What lets a provision write into `p`'s workspace: the lease that keeps a master from being
/// placed meanwhile, or the refusal naming who holds the workspace (ISS-1359). `None` where this
/// process keeps no registry (`forge-runner bind`), which leaves the pane check alone.
///
/// The registry knows the masters this daemon placed or adopted, and `pane_up` is tmux's own
/// answer, which covers a pane that outlived a restart and is not adopted yet. Nothing is written
/// and no status is reported on a refusal: the row keeps what it had.
async fn claim_workspace(
    masters: Option<&Masters>,
    p: &Provision,
    repo_path: &Path,
    pane_up: impl std::future::Future<Output = bool>,
) -> std::result::Result<Option<ProvisionLease>, String> {
    let refuse = |holder: String, advice: String| {
        format!(
            "{}: refused — {holder}, and provisioning writes into the checkout at {}. Nothing was written and no status was reported. {advice}",
            p.slug,
            repo_path.display(),
        )
    };
    let kill = format!(
        "`forge-runner master kill {}` ends the master, after which this provisions; until then the checkout is served as it stands.",
        p.slug
    );
    let lease = match masters.map(|m| m.begin_provisioning(&p.project_id)) {
        Some(Err(Refused::Live { session, pane })) => {
            return Err(refuse(
                format!("{pane} (session {session}) is this box's live master for the project"),
                kill,
            ))
        }
        Some(Err(Refused::Provisioning)) => return Err(refuse(
            "another provision of this workspace is already running on this box".into(),
            "That one reports its own outcome; if it ends failed, Re-provision queues it again, and one that stops reporting is offered again once it has stalled."
                .into(),
        )),
        Some(Err(Refused::Placing)) => {
            return Err(refuse(
                "this box is placing the project's master this moment".into(),
                kill,
            ))
        }
        Some(Ok(lease)) => Some(lease),
        None => None,
    };
    if pane_up.await {
        return Err(refuse(
            format!(
                "the project's master pane {} is running on this box's tmux",
                terminal::session_name(terminal::MASTER_PREFIX, &p.slug)
            ),
            kill,
        ));
    }
    Ok(lease)
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
pub async fn handle_request(
    client: &CoreClient,
    cfg: &Config,
    masters: Option<&Masters>,
) -> Result<()> {
    run_pending(client, cfg, masters).await;
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
    use std::fs;

    /// A path under a scratch dir of its own, not yet created.
    fn tmp(name: &str) -> crate::test_scratch::InScratch {
        crate::test_scratch::Scratch::new(&format!("provision-{name}")).at(name)
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
    fn a_repo_less_project_classifies_the_same_whether_or_not_its_folder_exists() {
        let absent = tmp("missing-no-url");
        let present = tmp("present-no-url");
        fs::create_dir_all(&present).unwrap();

        assert!(!absent.is_dir(), "the absent case must actually be absent");
        assert_eq!(
            classify_workspace(&absent, None),
            classify_workspace(&present, None)
        );
        assert_eq!(classify_workspace(&absent, None), WorkspaceMode::RepoLess);

        // and an empty repo URL is no URL, on the absent side too.
        assert_eq!(
            classify_workspace(&absent, Some("   ")),
            WorkspaceMode::RepoLess
        );
        let _ = fs::remove_dir_all(&present);
    }

    #[test]
    fn a_provisioned_workspace_records_its_own_binding() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let dir = crate::test_scratch::Scratch::new("bind");

        let _xdg = crate::auth::cred_store::ScopedVar::set("XDG_CONFIG_HOME", &dir);

        let mut p = provision(Some("/srv/checkouts/butlocs"));
        p.branch = Some("develop".into());
        record_binding(&p, Path::new("/srv/checkouts/butlocs"));

        let cfg = Config::load().unwrap();
        let bound = cfg
            .bindings
            .get("butlocs")
            .expect("the provision bound itself");
        assert_eq!(bound.repo_path, PathBuf::from("/srv/checkouts/butlocs"));
        assert_eq!(bound.branch.as_deref(), Some("develop"));
        assert_eq!(bound.project_id.as_deref(), Some("p-1"));

        // Re-provisioning the same workspace is not a second binding.
        record_binding(&p, Path::new("/srv/checkouts/butlocs"));
        assert_eq!(Config::load().unwrap().bindings.len(), 1);

        // A path the server moved wins over what was recorded before.
        record_binding(&p, Path::new("/srv/moved/butlocs"));
        assert_eq!(
            Config::load().unwrap().bindings["butlocs"].repo_path,
            PathBuf::from("/srv/moved/butlocs")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn provision(repo_path: Option<&str>) -> crate::transport::provision::Provision {
        crate::transport::provision::Provision {
            runner_id: "r-1".into(),
            project_id: "p-1".into(),
            slug: "butlocs".into(),
            repo_path: repo_path.map(str::to_string),
            branch: None,
            repo_url: None,
            ssh_key_source: None,
            ssh_public_key: None,
            ssh_private_key: None,
            github_app_credential: false,
            mcp_credential: None,
        }
    }

    #[test]
    fn a_device_with_no_repo_path_and_no_projects_root_still_resolves_nowhere() {
        let mut cfg = Config {
            projects_root: None,
            ..Default::default()
        };

        assert_eq!(resolve_path(&cfg, &provision(None)), None);
        assert_eq!(
            resolve_path(&cfg, &provision(Some("   "))),
            None,
            "blank is not a path"
        );

        // and the two ways there IS somewhere still answer, unchanged.
        assert_eq!(
            resolve_path(&cfg, &provision(Some("/srv/butlocs"))),
            Some(PathBuf::from("/srv/butlocs"))
        );
        cfg.projects_root = Some(PathBuf::from("/srv/projects"));
        assert_eq!(
            resolve_path(&cfg, &provision(None)),
            Some(PathBuf::from("/srv/projects/butlocs")),
            "the server's repo_path wins, and the root is the fallback"
        );
    }

    /// Criterion 2. The folder is created, and by THIS gate rather than as a
    /// side effect of something downstream.
    #[test]
    fn provisioning_a_repo_less_project_creates_the_folder_that_was_not_there() {
        let root = tmp("repo-less-mkdir");
        let dir = root.join("nested").join("butlocs");
        assert!(!dir.exists(), "the absent case must actually be absent");
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::RepoLess);

        ensure_repo_less_dir(&dir).expect("a writable path must be created");
        assert!(dir.is_dir(), "the workspace folder is owed");

        // and the second provision of the same project is not an error.
        ensure_repo_less_dir(&dir).expect("create_dir_all is idempotent");

        // the folder now exists, so it classifies exactly as it did before.
        assert_eq!(classify_workspace(&dir, None), WorkspaceMode::RepoLess);
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_folder_that_cannot_be_created_is_refused_naming_the_path_and_why() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("repo-less-unwritable");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o500)).unwrap();

        let target = root.join("butlocs");
        let detail =
            ensure_repo_less_dir(&target).expect_err("a read-only parent cannot be filled");
        assert!(
            detail.contains(&target.display().to_string()),
            "the operator is owed the path: {detail}"
        );
        assert!(
            detail.contains("could not create the workspace folder"),
            "{detail}"
        );
        assert!(
            !detail.contains("set the project repo URL"),
            "a repo-less project must not be told to invent a repository: {detail}"
        );
        assert!(!target.exists(), "nothing may be left half-created");

        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

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

    /// Criterion 5: the workspace carries the skill before it is reported
    /// `ready`, recorded where `status` reads it. The record directory is
    /// handed in rather than steered through `XDG_CONFIG_HOME`, which
    /// `dirs_next` reads on Linux only: on macOS this test wrote the record
    /// under the user's `~/Library/Application Support` and read an empty
    /// scratch (CI run 36746604361).
    #[test]
    fn a_provisioned_workspace_holds_the_skill_before_it_is_ready() {
        use crate::daemon::master_skill::{self, path_in, Outcome, Point, Read, ASSET};
        let record = crate::test_scratch::Scratch::new("provision-skill-record");
        let repo = crate::test_scratch::Scratch::new("provision-skill-repo");

        assert_eq!(
            install_master_skill("butlocs", repo.path(), Some(record.path())),
            Outcome::Written
        );
        assert_eq!(fs::read_to_string(path_in(repo.path())).unwrap(), ASSET);
        let Read::Record(r) = master_skill::read(record.path()) else {
            panic!("the provision recorded nothing where status reads")
        };
        assert_eq!(
            r.of("butlocs").map(|e| e.point).collect::<Vec<_>>(),
            [Point::Provision]
        );

        static SRC: std::sync::LazyLock<&str> =
            std::sync::LazyLock::new(|| crate::test_scratch::lf(include_str!("provision.rs")));
        let body = SRC
            .split("\nasync fn finish_workspace(")
            .nth(1)
            .expect("finish_workspace");
        let install = body
            .find("install_master_skill(\n        &p.slug,\n        repo_path,\n        crate::daemon::control::config_dir().as_deref(),")
            .expect("finish_workspace does not install the skill");
        let ready = body
            .find(r#"report(client, &p.runner_id, "ready""#)
            .expect("the ready report");
        assert!(
            install < ready,
            "the workspace is reported ready before it holds the skill"
        );
    }

    /// A remote that accepts the connection and never answers, which is what a git host that has
    /// stopped responding looks like from here. The listener must outlive the clone.
    fn hung_remote() -> (std::net::TcpListener, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!(
            "git://127.0.0.1:{}/x.git",
            listener.local_addr().unwrap().port()
        );
        (listener, url)
    }

    const ONE_SECOND: Duration = Duration::from_secs(1);

    /// ISS-1359 criterion 10: one hung clone used to hold the whole sweep, and a std `Command` held
    /// the executor thread besides. The outer timeout makes a regression a red test and not a hang.
    #[tokio::test]
    async fn a_hung_clone_is_killed_cleared_and_reported_failed_by_name() {
        let (_remote, url) = hung_remote();
        let dir = tmp("hung-clone");
        let started = std::time::Instant::now();

        let stop = tokio::time::timeout(
            Duration::from_secs(20),
            clone_repo(&url, &dir, None, &[], None, ONE_SECOND),
        )
        .await
        .expect("the clone was not bounded")
        .expect_err("a clone that never answered cannot have succeeded");

        assert!(started.elapsed() < Duration::from_secs(15));
        assert_eq!(stop.status, "failed");
        assert!(
            stop.detail.contains("git clone did not finish within 1s"),
            "{}",
            stop.detail
        );
        let left = fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0);
        assert_eq!(
            left, 0,
            "what the killed clone wrote is still in the folder"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// An adopt works inside a workspace that already holds this provisioner's own output, so a
    /// timeout there removes nothing of it.
    #[tokio::test]
    async fn an_adopt_that_times_out_removes_nothing_already_in_the_workspace() {
        let (_remote, url) = hung_remote();
        let dir = tmp("hung-adopt");
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude").join("sentinel"), "mine").unwrap();

        let stop = tokio::time::timeout(
            Duration::from_secs(20),
            adopt_repo(&url, &dir, None, &[], None, ONE_SECOND),
        )
        .await
        .expect("the adopt was not bounded")
        .expect_err("an adopt that never got an answer cannot have succeeded");

        assert_eq!(stop.status, "failed");
        assert!(stop.detail.contains("git fetch"), "{}", stop.detail);
        assert_eq!(
            fs::read_to_string(dir.join(".claude").join("sentinel")).unwrap(),
            "mine"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The child git spawns (ssh, a transport helper) is what holds the folder open, and killing
    /// only the leader orphans it.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_overrun_kills_what_the_command_spawned_and_not_only_the_command() {
        let dir = tmp("group-kill");
        fs::create_dir_all(&dir).unwrap();
        let pidfile = dir.join("child.pid");
        let mut cmd = tokio::process::Command::new("sh");
        cmd.arg("-c").arg(format!(
            "sleep 60 & echo $! > '{}'; wait",
            pidfile.display()
        ));

        let out = run_git(cmd, Duration::from_millis(500)).await.unwrap();

        assert!(out.is_none(), "the overrun was not reported as one");
        let pid: i32 = fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        let mut gone = false;
        for _ in 0..50 {
            if nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err() {
                gone = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            gone,
            "the grandchild {pid} is still running after the overrun"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_git_step_limit_ends_well_before_core_calls_the_provision_stalled() {
        assert!(GIT_STEP_LIMIT < Duration::from_secs(30 * 60));
    }

    fn provision_for(
        project: &str,
        slug: &str,
        path: Option<&Path>,
        url: Option<&str>,
    ) -> Provision {
        Provision {
            runner_id: "r1".into(),
            project_id: project.into(),
            slug: slug.into(),
            repo_path: path.map(|p| p.display().to_string()),
            branch: None,
            repo_url: url.map(String::from),
            ssh_key_source: None,
            ssh_public_key: None,
            ssh_private_key: None,
            github_app_credential: false,
            mcp_credential: None,
        }
    }

    async fn never_up() -> bool {
        false
    }

    /// ISS-1359 criterion 11: a master this box serves holds the workspace, and a provision for it
    /// writes nothing, whatever its folder holds.
    #[tokio::test]
    async fn a_provision_for_a_project_whose_master_this_box_serves_writes_nothing() {
        let dir = tmp("under-master");
        fs::create_dir_all(&dir).unwrap();
        let masters = Masters::new();
        masters.remember_for_test("proj-1", "sess-1", "forge-master-anhome");
        let p = provision_for("proj-1", "iss1359-under-master", Some(&dir), None);
        let client = CoreClient::new("http://127.0.0.1:1", "tok");

        process_one(&client, &Config::default(), Some(&masters), &p).await;

        assert_eq!(
            fs::read_dir(&dir).unwrap().count(),
            0,
            "a master's checkout was written to"
        );
        let said = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .expect_err("the refusal is named");
        assert!(said.contains("forge-master-anhome") && said.contains(&dir.display().to_string()));
        assert!(
            said.contains("sess-1")
                && said.contains("forge-runner master kill iss1359-under-master")
        );
        let other = provision_for("proj-2", "iss1359-other", Some(&dir), None);
        assert!(claim_workspace(Some(&masters), &other, &dir, never_up())
            .await
            .is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    /// Before anything is cloned the refusal comes first: a clone's first act is to make the
    /// folder's parent, and a master's box has no business growing one for a provision it refuses.
    #[tokio::test]
    async fn a_provision_refused_under_a_master_makes_no_folder_for_its_clone() {
        let parent = tmp("refused-before-clone");
        let masters = Masters::new();
        masters.remember_for_test("proj-1", "sess-1", "forge-master-anhome");
        let p = provision_for(
            "proj-1",
            "iss1359-before-clone",
            Some(&parent.join("ws")),
            Some("/nonexistent/x.git"),
        );
        let client = CoreClient::new("http://127.0.0.1:1", "tok");

        process_one(&client, &Config::default(), Some(&masters), &p).await;

        assert!(!parent.exists(), "the refusal came after the clone began");
    }

    /// A pane that outlived a daemon restart is tmux's to name and not yet the registry's, and a
    /// process with no registry at all (`forge-runner bind`) has only tmux.
    #[tokio::test]
    async fn a_pane_tmux_reports_up_refuses_with_or_without_a_registry() {
        let dir = tmp("pane-up");
        let p = provision_for("proj-1", "iss1359-pane-up", Some(&dir), None);
        let up = async { true };

        let said = claim_workspace(None, &p, &dir, up)
            .await
            .expect_err("a pane is running");
        assert!(
            said.contains("forge-master-iss1359-pane-up") && said.contains("tmux"),
            "{said}"
        );
        let masters = Masters::new();
        assert!(claim_workspace(Some(&masters), &p, &dir, async { true })
            .await
            .is_err());
        assert!(
            masters.begin_provisioning("proj-1").is_ok(),
            "a refused provision left its lease behind"
        );
    }

    /// The lease must outlive the clone and not only the check: a master placed during a clone
    /// would be placed under the writes that follow it.
    #[tokio::test]
    async fn the_lease_is_held_for_the_whole_provision_and_released_when_it_ends() {
        let (_remote, url) = hung_remote();
        let dir = tmp("lease-held");
        let masters = std::sync::Arc::new(Masters::new());
        let p = provision_for("proj-1", "iss1359-lease-held", Some(&dir), Some(&url));
        let client = CoreClient::new("http://127.0.0.1:1", "tok");
        let running = {
            let masters = masters.clone();
            tokio::spawn(async move {
                process_one(&client, &Config::default(), Some(&masters), &p).await;
            })
        };

        let mut held = false;
        for _ in 0..100 {
            if masters.is_provisioning("proj-1") {
                held = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(held, "no lease was held while the clone ran");
        assert!(masters.placement_would_wait("proj-1"));

        running.abort();
        let _ = running.await;
        assert!(
            !masters.is_provisioning("proj-1"),
            "the lease outlived the provision"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// The lease makes the check and the writes one thing: while it is held no master is placed,
    /// and while a master is being placed or serves, none is granted.
    #[tokio::test]
    async fn the_lease_and_a_master_placement_exclude_each_other() {
        let dir = tmp("lease");
        let p = provision_for("proj-1", "iss1359-lease", Some(&dir), None);
        let masters = Masters::new();

        let lease = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .unwrap();
        assert!(
            masters.placement_would_wait("proj-1"),
            "a master was placed under a provision"
        );
        assert!(!masters.placement_would_wait("proj-2"));
        drop(lease);
        assert!(
            !masters.placement_would_wait("proj-1"),
            "the lease outlived its provision"
        );

        let placing = masters.hold_placing_for_test("proj-1");
        let said = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .expect_err("a provision began while a master was being placed");
        assert!(said.contains("placing"), "{said}");
        drop(placing);
        assert!(claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .is_ok());
    }

    #[cfg(unix)]
    fn fake_git(dir: &Path, script: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(dir).unwrap();
        let git = dir.join("git");
        fs::write(&git, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&git, fs::Permissions::from_mode(0o755)).unwrap();
        git
    }

    /// The clone finished and the base-branch checkout hung: nothing says what state the tree is in,
    /// and a `.git` left behind reads as a ready repository on the next provision.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_base_branch_checkout_that_overruns_fails_the_clone_and_clears_what_it_wrote() {
        let bin = tmp("fake-git-checkout");
        let git = fake_git(
            &bin,
            r#"case "$*" in
  *clone*) mkdir -p "$3/.git";;
  *checkout*) sleep 30;;
esac"#,
        );
        let dir = tmp("checkout-overrun");

        let stop = clone_repo_with(
            &git,
            "git://127.0.0.1:1/x.git",
            &dir,
            None,
            &[],
            Some("main"),
            Duration::from_millis(500),
        )
        .await
        .expect_err("a checkout that overran cannot be read as done");

        assert_eq!(stop.status, "failed");
        assert!(
            stop.detail.contains("git checkout main did not finish"),
            "{}",
            stop.detail
        );
        assert_eq!(
            fs::read_dir(&dir).map(|d| d.count()).unwrap_or(0),
            0,
            "a half-made clone is left to read as ready"
        );
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A second provision of one project's workspace (the periodic sweep and a `provision.request`
    /// sweep can both pull the same row) must be refused, or dropping the first lease would admit a
    /// master under the second's writes.
    #[tokio::test]
    async fn a_second_provision_of_one_workspace_is_refused_and_placement_waits_for_the_first() {
        let dir = tmp("two-leases");
        let p = provision_for("proj-1", "iss1359-two-leases", Some(&dir), None);
        let masters = Masters::new();

        let first = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .unwrap();
        let said = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .expect_err("a second provision was granted over the first");
        assert!(said.contains("already running"), "{said}");
        assert!(
            masters.placement_would_wait("proj-1"),
            "the refused attempt released the first's hold"
        );
        let other = provision_for("proj-2", "iss1359-two-other", Some(&dir), None);
        assert!(claim_workspace(Some(&masters), &other, &dir, never_up())
            .await
            .is_ok());

        drop(first);
        assert!(!masters.placement_would_wait("proj-1"));
    }

    /// An adopt step that is tolerated when git FAILS is not tolerated when it OVERRAN: a fake `git`
    /// that answers `fetch` and hangs on `remote set-head` must fail the adopt by name.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_adopt_whose_remote_head_lookup_overruns_fails_by_name() {
        let bin = tmp("fake-git");
        let git = fake_git(
            &bin,
            r#"case "$*" in *set-head*) sleep 30;; *) exit 0;; esac"#,
        );
        let dir = tmp("adopt-sethead");
        fs::create_dir_all(&dir).unwrap();

        let stop = adopt_repo_with(
            &git,
            "git://127.0.0.1:1/x.git",
            &dir,
            None,
            &[],
            None,
            Duration::from_millis(500),
        )
        .await
        .expect_err("a lookup that overran cannot be tolerated");

        assert_eq!(stop.status, "failed");
        assert!(stop.detail.contains("remote set-head"), "{}", stop.detail);
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A failed adopt leaves the `.git` it initialised, and the next provision reads that as an
    /// existing checkout and reports it `ready` (ISS-1359 repair 1). Every exit of the adopt owes
    /// the same removal, whichever step stopped it, and none of it touches what was there before.
    #[cfg(unix)]
    async fn an_adopt_that_stops_at(
        n: usize,
        step: &str,
        how: &str,
    ) -> (crate::test_scratch::InScratch, Stop) {
        let bin = tmp(&format!("fake-git-{n}"));
        let git = fake_git(
            &bin,
            &format!(
                r#"case " $* " in
  *" init "*) mkdir -p "$2/.git";;
  *" {step} "*) {how};;
esac"#
            ),
        );
        let dir = tmp(&format!("adopt-stops-{n}"));
        fs::create_dir_all(dir.join(".claude")).unwrap();
        fs::write(dir.join(".claude").join("sentinel"), "mine").unwrap();
        fs::write(dir.join("CLAUDE.md"), "pointer").unwrap();

        let stop = adopt_repo_with(
            &git,
            "git://127.0.0.1:1/x.git",
            &dir,
            None,
            &[],
            Some("main"),
            Duration::from_millis(500),
        )
        .await
        .expect_err("an adopt that was stopped cannot have succeeded");
        let _ = fs::remove_dir_all(&bin);
        (dir, stop)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn every_exit_of_a_failed_adopt_removes_the_git_it_made_and_nothing_else() {
        for (n, (step, how, status)) in [
            ("fetch", "sleep 30", "failed"),
            ("fetch", "echo refused >&2; exit 1", "needs_manual_setup"),
            ("remote", "echo no >&2; exit 1", "needs_manual_setup"),
            ("checkout", "echo nope >&2; exit 1", "needs_manual_setup"),
            ("checkout", "sleep 30", "failed"),
        ]
        .into_iter()
        .enumerate()
        {
            let (dir, stop) = an_adopt_that_stops_at(n, step, how).await;
            assert_eq!(stop.status, status, "{step}: {}", stop.detail);
            assert!(
                !dir.join(".git").exists(),
                "{step} ({how}): the adopt's own .git was left to read as a checkout"
            );
            assert_eq!(
                fs::read_to_string(dir.join(".claude").join("sentinel")).unwrap(),
                "mine",
                "{step}: what was in the workspace before was removed"
            );
            assert_eq!(
                fs::read_to_string(dir.join("CLAUDE.md")).unwrap(),
                "pointer"
            );
            assert_eq!(
                classify_workspace(&dir, Some("git://127.0.0.1:1/x.git")),
                WorkspaceMode::Adopt,
                "{step}: the next provision would not adopt again"
            );
        }
    }

    /// An adopt only ever runs where there is no `.git`. If one were there, it is not the adopt's.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_git_that_was_there_before_the_adopt_is_not_removed_by_its_failure() {
        let bin = tmp("fake-git-preexisting");
        let git = fake_git(&bin, "echo refused >&2; exit 1");
        let dir = tmp("adopt-preexisting");
        fs::create_dir_all(dir.join(".git")).unwrap();
        fs::write(dir.join(".git").join("HEAD"), "ref: refs/heads/main").unwrap();

        adopt_repo_with(
            &git,
            "git://127.0.0.1:1/x.git",
            &dir,
            None,
            &[],
            None,
            ONE_SECOND,
        )
        .await
        .expect_err("refused");

        assert!(dir.join(".git").join("HEAD").exists());
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&dir);
    }

    /// A repository with no commit cannot serve a project that names a remote, whoever left it so.
    /// The stranded `.git` the failed adopts above used to leave is already in the field.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_checkout_holding_no_commit_is_refused_by_name_for_a_project_with_a_remote() {
        let bin = tmp("fake-git-nocommit");
        let git = fake_git(&bin, "exit 128");
        let dir = tmp("no-commit");
        fs::create_dir_all(dir.join(".git")).unwrap();

        let stop = require_a_commit_with(&git, &dir, ONE_SECOND)
            .await
            .expect_err("a repository with no commit was read as a checkout");
        assert_eq!(stop.status, "needs_manual_setup");
        assert!(
            stop.detail.contains(&dir.display().to_string()) && stop.detail.contains("no commit"),
            "{}",
            stop.detail
        );

        let has = fake_git(&bin, "echo abc123");
        assert!(require_a_commit_with(&has, &dir, ONE_SECOND).await.is_ok());
        let hung = fake_git(&bin, "sleep 30");
        let stop = require_a_commit_with(&hung, &dir, Duration::from_millis(300))
            .await
            .expect_err("a probe that overran is not an answer");
        assert_eq!(stop.status, "failed");
        let _ = fs::remove_dir_all(&bin);
        let _ = fs::remove_dir_all(&dir);
    }

    /// What the daemon's own provision step reports, read off a core that records the bodies it was
    /// sent. Driven through `process_one`, because the helper proving a probe is not the proof that
    /// the step asks it before it says `ready`.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_provision_over_a_checkout_with_no_commit_reports_it_by_name_and_writes_nothing() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    log.lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&buf[..n]).into_owned());
                    let _ = sock
                        .write_all(
                            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                        )
                        .await;
                });
            }
        });

        let dir = tmp("no-commit-provision");
        fs::create_dir_all(&dir).unwrap();
        let init = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .arg("init")
            .output()
            .unwrap();
        assert!(init.status.success());
        let p = provision_for(
            "proj-1",
            "iss1359-no-commit",
            Some(&dir),
            Some("git://127.0.0.1:1/x.git"),
        );
        let client = CoreClient::new(&base, "tok");

        process_one(&client, &Config::default(), None, &p).await;

        let sent = seen.lock().unwrap().clone();
        assert_eq!(sent.len(), 1, "one report and nothing after it: {sent:?}");
        assert!(
            sent[0].contains("provision-status")
                && sent[0].contains("needs_manual_setup")
                && sent[0].contains("no commit"),
            "{}",
            sent[0]
        );
        assert!(
            !dir.join(".claude").exists() && !dir.join(".mcp.json").exists(),
            "a refused provision wrote into the checkout"
        );
    }

    #[tokio::test]
    async fn a_refusal_for_a_running_provision_does_not_tell_the_operator_to_kill_a_master() {
        let dir = tmp("advice");
        let p = provision_for("proj-1", "iss1359-advice", Some(&dir), None);
        let masters = Masters::new();
        let _first = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .unwrap();

        let said = claim_workspace(Some(&masters), &p, &dir, never_up())
            .await
            .expect_err("refused");

        assert!(said.contains("another provision"), "{said}");
        assert!(
            said.contains("Re-provision") && !said.contains("next sweep provisions again"),
            "{said}"
        );
        assert!(
            !said.contains("master kill") && !said.contains("served as it stands"),
            "{said}"
        );
    }
}
