//! `forge-runner sync` — on-demand skill pull (ISS-740).
//!
//! Independent one-shot: runs the exact pull path behind the ISS-736
//! background poller (`sync_bound_projects`), reads the same config dir the
//! daemon uses (via `XDG_CONFIG_HOME`), and never reads/writes `auto_pull` —
//! it can run alongside a running `forge-runner start` with no coordination.

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::skill_pull;
use forge_runner_core::transport::CoreClient;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Sync only this bound project (slug); default = every bound project
    /// with a local repo path.
    #[arg(long)]
    project: Option<String>,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;

    let (core_url, token) = match (ctx.resolve_core_url(&cfg), cred_store::load_device_token()?) {
        (Some(u), Some(t)) => (u, t),
        _ => anyhow::bail!("not logged in — run `forge-runner login` first"),
    };
    let client = CoreClient::new(core_url, token);
    let results = skill_pull::sync_bound_projects(&client, &cfg, args.project.as_deref()).await?;

    if results.is_empty() {
        println!("No bound projects with a local repo path to sync.");
        return Ok(());
    }

    let mut had_error = false;
    for r in &results {
        match &r.outcome {
            Ok(n) => println!(
                "  {:<24} synced {n} skill(s) into {}",
                r.slug,
                r.repo_path.join(".claude/skills").display()
            ),
            Err(msg) => {
                had_error = true;
                eprintln!("  {:<24} ERROR: {msg}", r.slug);
            }
        }
    }

    if had_error {
        std::process::exit(1);
    }
    Ok(())
}
