use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::auth::{cred_store, git_cred};
use forge_runner_core::config::{Binding, Config};
use forge_runner_core::transport::runners::MeRunner;
use forge_runner_core::transport::{runners, CoreClient};
use forge_runner_core::workspace::provision;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Project slug (as shown in Forge). Must already be assigned to this
    /// device on the server (bind the device in the web UI first).
    pub slug: String,
    /// Path to an EXISTING local checkout (preferred — no re-clone).
    #[arg(long)]
    pub path: Option<PathBuf>,
    /// Default branch for this binding.
    #[arg(long)]
    pub branch: Option<String>,
    /// No local checkout yet: let the server provision one (clone + skills +
    /// `.mcp.json`) under `projects_root`, then bind to it.
    #[arg(long)]
    pub clone: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let client = client_for(&ctx, &cfg)?;
    let assignment = assignment_for(&client, &args.slug).await?;
    let given = args.path.is_some();
    let path = match args.path {
        Some(p) => p.canonicalize().unwrap_or(p),
        None if args.clone => provision_checkout(&client, &assignment).await?,
        None => {
            return super::stub(
                "bind (auto-detect)",
                "for now point at an existing repo with `--path <dir>`, or pass `--clone` to have one provisioned",
            )
        }
    };

    if !path.join(".git").exists() {
        eprintln!(
            "warning: {} has no `.git` — binding will still be saved, but double-check the path.",
            path.display()
        );
    }

    // Before anything is saved: a checkout of another host's repository is refused, not bound.
    let helper_host = if given {
        checkout_credential_host(&args.slug, &path, &assignment, origin_url(&path).as_deref())?
    } else {
        None
    };

    let bound = write_binding(&client, &assignment, &args.slug, &path, args.branch).await?;
    println!(
        "bound {} -> {} (synced to server)",
        args.slug,
        bound.display()
    );
    if let Some(host) = helper_host {
        git_cred::set_repo_credential_helper(&bound, &host).map_err(|e| {
            anyhow::anyhow!(
                "bound, but the git credential helper for {host} was not installed in {}: {e}",
                bound.display()
            )
        })?;
        println!(
            "git credential helper: https://{host} -> forge-runner git-credential (repo-local)"
        );
    }
    Ok(())
}

/// `origin`'s URL in the checkout, or `None` where it has no such remote.
fn origin_url(path: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["remote", "get-url", "origin"])
        .output()
        .ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !url.is_empty()).then_some(url)
}

/// The host of a git remote in any of its forms — `https://host/…`, `ssh://user@host:port/…`,
/// `user@host:path` — lower-cased and without a port.
fn remote_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = match url.split_once("://") {
        Some((_, rest)) => rest.split('/').next()?,
        None => url.split_once(':')?.0,
    };
    let host = authority.rsplit('@').next()?;
    let host = host.split(':').next()?;
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

// cm:why `--clone` gets its helper from the provision; a checkout bound by `--path` gets the same
// one here, for the host the project document declares — and only once its origin is that host
/// The host to point this checkout's credential helper at, `None` where core mints no credential
/// for the project, or a refusal naming both hosts when the checkout's origin is another host's.
fn checkout_credential_host(
    slug: &str,
    path: &std::path::Path,
    assignment: &MeRunner,
    origin: Option<&str>,
) -> anyhow::Result<Option<String>> {
    let Some(repository) = assignment.repository.as_deref() else {
        eprintln!(
            "note: core names no source repository for {slug} (no git source declared, or a core older than this runner), so no git credential helper is installed"
        );
        return Ok(None);
    };
    let declared = repository
        .split('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match origin {
        Some(url) => {
            let found = remote_host(url);
            if found.as_deref() != Some(declared.as_str()) {
                anyhow::bail!(
                    "BIND_SOURCE_HOST_MISMATCH: {} has origin {url} (host {}), and project {slug} declares its source at {repository} (host {declared}) — bind a checkout of {repository}, or fix `origin` with `git -C {} remote set-url origin https://{repository}.git`",
                    path.display(),
                    found.as_deref().unwrap_or("unreadable"),
                    path.display()
                );
            }
            if !url.trim_start().starts_with("https://") && assignment.host_credential {
                eprintln!(
                    "note: origin {url} is not HTTPS, so git will not ask the credential helper for it until origin is https://{repository}.git"
                );
            }
        }
        None => eprintln!(
            "warning: {} has no `origin` remote, so its host could not be checked against {repository}",
            path.display()
        ),
    }
    if !assignment.host_credential {
        eprintln!(
            "note: core mints no git credential for {repository}, so no credential helper is installed — attach a source host binding that can mint one, then bind again"
        );
        return Ok(None);
    }
    Ok(Some(declared))
}

fn config_dir() -> Option<PathBuf> {
    forge_runner_core::daemon::control::config_dir()
}

/// The master skill is written at bind, so a bound project carries it whether
/// or not a master is ever placed for it (ISS-1357). The line printed, and
/// whether it was installed.
fn install_skill(
    slug: &str,
    repo: &std::path::Path,
    dir: Option<&std::path::Path>,
) -> (String, bool) {
    use forge_runner_core::daemon::master_skill::{install_and_record, Point};
    let outcome = install_and_record(slug, repo, Point::Bind, dir);
    let build = format!(
        "{} ({})",
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT
    );
    (
        format!("skill {slug}: {}", outcome.says(Some(repo), &build)),
        outcome.installed(),
    )
}

/// A device-token client for the configured core, or the reason there is none.
pub fn client_for(ctx: &Ctx, cfg: &Config) -> anyhow::Result<CoreClient> {
    let core_url = ctx
        .resolve_core_url(cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — run `forge-runner login` first"))?;
    let token = cred_store::load_device_token()?
        .ok_or_else(|| anyhow::anyhow!("no device token — run `forge-runner login` first"))?;
    Ok(CoreClient::new(core_url, token))
}

/// Resolve the project from the slug via the server's assignment list. The
/// device must already be bound to the project on the server (web UI) — we
/// refuse to bind an unassigned slug so a typo can't silently dead-route.
pub async fn assignment_for(client: &CoreClient, slug: &str) -> anyhow::Result<MeRunner> {
    let assignments = runners::list_me(client)
        .await
        .map_err(|e| anyhow::anyhow!("could not fetch device assignments from server: {e}"))?;

    assignments
        .into_iter()
        .find(|r| r.slug == slug)
        .ok_or_else(|| {
            anyhow::anyhow!(
                "slug '{slug}' is not assigned to this device on the server; assign it in the web UI first"
            )
        })
}

/// Write the binding locally and push the path back to the server, so web and
/// CLI read the same field. Returns the path it bound.
pub async fn write_binding(
    client: &CoreClient,
    assignment: &MeRunner,
    slug: &str,
    path: &std::path::Path,
    branch: Option<String>,
) -> anyhow::Result<PathBuf> {
    let mut cfg = Config::load()?;
    let branch = branch.or_else(|| assignment.branch.clone());
    cfg.bindings.insert(
        slug.to_string(),
        Binding {
            repo_path: path.to_path_buf(),
            branch: branch.clone(),
            project_id: Some(assignment.project_id.clone()),
        },
    );
    cfg.save()?;

    // Before the server is asked: the binding is saved from here on, and a
    // refused PATCH must not leave it without the skill.
    let (line, installed) = install_skill(slug, path, config_dir().as_deref());
    if installed {
        println!("{line}");
    } else {
        eprintln!("{line}");
    }

    runners::patch_runner(
        client,
        &assignment.runner_id,
        Some(&path.to_string_lossy()),
        branch.as_deref(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("saved locally, but failed to push path to server: {e}"))?;
    Ok(path.to_path_buf())
}

/// Ask the server to provision this project's workspace and run what it queues.
/// This is the SAME path the daemon takes on a `provision.request`, so a box
/// that ran `bind --clone` and one that was assigned from the web UI end up
/// with the same folder — there is no second clone implementation to drift.
pub async fn provision_checkout(
    client: &CoreClient,
    assignment: &MeRunner,
) -> anyhow::Result<PathBuf> {
    let cfg = Config::load()?;
    let target = assignment
        .repo_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| cfg.projects_root.as_ref().map(|r| r.join(&assignment.slug)))
        .ok_or_else(|| {
            anyhow::anyhow!(
                "nowhere to put the checkout: this runner has no repo path on the server and no \
                 `projects_root` is configured. `forge-runner config set projects-root <dir>`, or \
                 pass `--path <dir>` to bind a checkout you already have."
            )
        })?;

    println!("provisioning {} → {}", assignment.slug, target.display());
    provision::reprovision(client, &cfg, &assignment.runner_id).await;

    if !target.join(".git").exists() && !target.exists() {
        anyhow::bail!(
            "provisioning did not leave a workspace at {} — check `forge-runner logs`, or clone it \
             yourself and re-run with `--path`",
            target.display()
        );
    }
    Ok(target)
}
