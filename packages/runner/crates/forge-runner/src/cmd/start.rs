use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::{config::Config, daemon};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// (planned M4) run detached in the background.
    #[arg(long)]
    pub detach: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    if args.detach {
        println!("⏳ --detach is not supported yet (M4) — use `forge-runner service install` to run in the background.");
    }
    let cfg = Config::load()?;
    let core_url = ctx
        .resolve_core_url(&cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — run `forge-runner login` first"))?;
    let device_id = cfg
        .device_id
        .clone()
        .ok_or_else(|| anyhow::anyhow!("not paired — run `forge-runner login`"))?;
    let token = cred_store::load_device_token()?
        .ok_or_else(|| anyhow::anyhow!("no device token — run `forge-runner login`"))?;

    daemon::run(cfg, core_url, device_id, token).await?;
    Ok(())
}
