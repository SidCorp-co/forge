use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::transport::{runners, CoreClient};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {}

pub async fn run(ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;

    // Pull the server's view so we can flag drift between the two planes:
    // what the server assigns to this device vs. what config.toml knows.
    let server = match (ctx.resolve_core_url(&cfg), cred_store::load_device_token()?) {
        (Some(core_url), Some(token)) => {
            let client = CoreClient::new(core_url, token);
            match runners::list_me(&client).await {
                Ok(rows) => Some(rows),
                Err(e) => {
                    eprintln!("warning: could not fetch server assignments ({e}); showing local config only");
                    None
                }
            }
        }
        _ => {
            eprintln!("note: not logged in; showing local config only (run `forge-runner login`)");
            None
        }
    };

    println!("Runners (1 per assigned project, type=claude-code):");

    let server = server.unwrap_or_default();
    let mut shown = false;

    // Server assignments → ready / bound-on-server-no-local-path.
    for r in &server {
        shown = true;
        let local_path = cfg
            .bindings
            .iter()
            .find(|(_, b)| b.project_id.as_deref() == Some(r.project_id.as_str()))
            .map(|(_, b)| b.repo_path.clone());
        let server_path = r
            .repo_path
            .as_deref()
            .filter(|p| !p.trim().is_empty())
            .map(std::path::PathBuf::from);
        let path = server_path.or(local_path);

        match path {
            Some(p) => println!("  {:<24} ready  ({})", r.slug, p.display()),
            None => println!(
                "  {:<24} bound-on-server-no-local-path  (run `forge-runner bind {} --path <dir>`)",
                r.slug, r.slug
            ),
        }
    }

    // Config bindings not present on the server → local-only-not-on-server.
    for (slug, b) in &cfg.bindings {
        let on_server = match &b.project_id {
            Some(pid) => server.iter().any(|r| &r.project_id == pid),
            None => false,
        };
        if !on_server {
            shown = true;
            println!(
                "  {slug:<24} local-only-not-on-server  ({})",
                b.repo_path.display()
            );
        }
    }

    if !shown {
        println!(
            "  (none — bind a device in the web UI, then `forge-runner bind <slug> --path <dir>`)"
        );
    }

    if !cfg.runner.register_enabled {
        println!(
            "\nNote: register_enabled=off → using the device-room (runnerFramework not enabled)."
        );
    }
    Ok(())
}
