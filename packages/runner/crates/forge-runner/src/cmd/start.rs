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
    // First, before anything a build that will not stay up could die on: a
    // build an update installed counts this start on its probation, and one
    // that has never stayed up is replaced here by the build it replaced.
    #[cfg(unix)]
    if let Some(kept) = forge_runner_core::update::probation::at_start() {
        use forge_runner_core::daemon::handover::{replace_image, LISTENER_ENV};
        let rest: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
        let listener = std::env::var(LISTENER_ENV)
            .ok()
            .and_then(|v| v.parse::<i64>().ok());
        let err = replace_image(&kept, &rest, listener);
        anyhow::bail!(
            "the build put back at {} could not be run in this one's place ({err}); the service manager's next start runs it",
            kept.display()
        );
    }
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
