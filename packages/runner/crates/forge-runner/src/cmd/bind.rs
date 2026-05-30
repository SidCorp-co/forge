use std::path::PathBuf;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::{Binding, Config};
use forge_runner_core::transport::{runners, CoreClient};

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
    /// (planned M4) auto-clone under projects_root if no local repo exists.
    #[arg(long)]
    pub clone: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let Some(path) = args.path else {
        return super::stub(
            "bind (auto-detect/clone)",
            "M4 — for now point at an existing repo with `--path <dir>`",
        );
    };

    if args.project_id.is_some() {
        eprintln!(
            "note: --project-id is deprecated and ignored; the project is resolved from the slug via the server."
        );
    }

    let path = path.canonicalize().unwrap_or(path);
    if !path.join(".git").exists() {
        eprintln!(
            "warning: {} has no `.git` — binding will still be saved, but double-check the path.",
            path.display()
        );
    }

    // Resolve the project from the slug via the server's assignment list. The
    // device must already be bound to the project on the server (web UI) — we
    // refuse to bind an unassigned slug so a typo can't silently dead-route.
    let mut cfg = Config::load()?;
    let core_url = ctx
        .resolve_core_url(&cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — run `forge-runner login` first"))?;
    let token = cred_store::load_device_token()?
        .ok_or_else(|| anyhow::anyhow!("no device token — run `forge-runner login` first"))?;
    let client = CoreClient::new(core_url, token);

    let assignments = runners::list_me(&client)
        .await
        .map_err(|e| anyhow::anyhow!("could not fetch device assignments from server: {e}"))?;

    let Some(assignment) = assignments.iter().find(|r| r.slug == args.slug) else {
        let known: Vec<&str> = assignments.iter().map(|r| r.slug.as_str()).collect();
        let hint = if known.is_empty() {
            "this device has no project assignments yet".to_string()
        } else {
            format!("assigned slugs: {}", known.join(", "))
        };
        anyhow::bail!(
            "slug '{}' is not assigned to this device on the server; assign it in the web UI first ({hint})",
            args.slug
        );
    };

    let branch = args.branch.or_else(|| assignment.branch.clone());
    let repo_path_str = path.to_string_lossy().to_string();

    // (a) Write/update the local binding with the resolved project id (cache
    // for offline starts and the WS registration), then (b) push the path to
    // the server so web + CLI share the same source-of-truth field.
    cfg.bindings.insert(
        args.slug.clone(),
        Binding {
            repo_path: path.clone(),
            branch: branch.clone(),
            project_id: Some(assignment.project_id.clone()),
        },
    );
    cfg.save()?;

    runners::patch_runner(
        &client,
        &assignment.runner_id,
        Some(&repo_path_str),
        branch.as_deref(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("saved locally, but failed to push path to server: {e}"))?;

    println!(
        "bound {} -> {} (synced to server)",
        args.slug,
        path.display()
    );
    Ok(())
}
