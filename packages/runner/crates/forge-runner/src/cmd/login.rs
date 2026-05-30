use clap::Args as ClapArgs;
use forge_runner_core::auth::{cred_store, pairing};
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Pairing code minted from the web UI (paste-code flow).
    #[arg(long)]
    pub code: Option<String>,
    /// Device name shown in the dashboard (default: hostname).
    #[arg(long)]
    pub name: Option<String>,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let mut cfg = Config::load()?;
    let core_url = ctx
        .resolve_core_url(&cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL — pass --core-url <url>"))?;

    let Some(code) = args.code else {
        anyhow::bail!(
            "browser approval is not available yet (C1). For now, mint a code on the web, then run: \
             forge-runner login --code <CODE>"
        );
    };
    let name = args.name.unwrap_or_else(pairing::default_device_name);

    let resp = pairing::pair(&core_url, &code, &name).await?;
    cred_store::store_device_token(&resp.device_token)?;

    cfg.core_url = Some(core_url);
    cfg.device_id = Some(resp.device_id.clone());
    cfg.save()?;

    println!(
        "✔ paired device {} (token store: {})",
        resp.device_id,
        cred_store::active_backend()
    );
    if let Some(pid) = resp.project_id {
        println!("  project hint: {pid}");
        println!("  next: forge-runner bind <slug> --path <dir> --project-id {pid}");
    }
    Ok(())
}
