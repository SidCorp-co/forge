use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
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
    /// Deprecated — the project id is now resolved from the slug via
    /// `/me/runners`. Accepted but ignored to avoid breaking older scripts.
    #[arg(long, hide = true)]
    pub project_id: Option<String>,
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

    if args.project_id.is_some() {
        eprintln!(
            "note: --project-id is deprecated and ignored; the project is resolved from the slug via the server."
        );
    }
    if !path.join(".git").exists() {
        eprintln!(
            "warning: {} has no `.git` — binding will still be saved, but double-check the path.",
            path.display()
        );
    }

    let bound = write_binding(&client, &assignment, &args.slug, &path, args.branch).await?;
    println!(
        "bound {} -> {} (synced to server)",
        args.slug,
        bound.display()
    );
    Ok(())
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
