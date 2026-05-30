use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// (planned M4) live view.
    #[arg(long)]
    pub watch: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    if args.watch {
        println!("⏳ --watch (live TUI) not implemented yet (M4) — printing static status:\n");
    }
    let cfg = Config::load()?;
    println!(
        "version    {} ({})",
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_TARGET
    );
    println!(
        "core_url   {}",
        ctx.resolve_core_url(&cfg).unwrap_or_else(|| "—".into())
    );
    println!(
        "paired     {}",
        cfg.device_id
            .as_deref()
            .unwrap_or("not yet (forge-runner login)")
    );
    println!("token      {}", cred_store::active_backend());
    println!(
        "register   {}",
        if cfg.runner.register_enabled {
            "on"
        } else {
            "off (device-room)"
        }
    );
    if cfg.bindings.is_empty() {
        println!("bindings   —");
    } else {
        println!("bindings");
        for (slug, b) in &cfg.bindings {
            println!(
                "  {slug}  →  {}  [project_id: {}]",
                b.repo_path.display(),
                b.project_id.as_deref().unwrap_or("UNSET")
            );
        }
    }
    Ok(())
}
