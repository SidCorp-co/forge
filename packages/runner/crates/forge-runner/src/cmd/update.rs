use clap::Args as ClapArgs;
use forge_runner_core::config::Config;
use forge_runner_core::update;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Only report whether an update exists; don't download/replace.
    #[arg(long)]
    pub check: bool,
    /// After updating, restart the systemd service.
    #[arg(long)]
    pub restart: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let core = ctx.resolve_core_url(&cfg);
    let url = update::manifest_url(cfg.update.manifest_url.as_deref(), core.as_deref())
        .ok_or_else(|| anyhow::anyhow!("no manifest URL — set update.manifest_url or core-url"))?;

    println!(
        "current  {} ({})",
        update::CURRENT_VERSION,
        update::BUILD_TARGET
    );
    let manifest = update::fetch_manifest(&url).await?;

    if !update::is_newer(&manifest.version, update::CURRENT_VERSION) {
        println!("✔ up to date (latest {})", manifest.version);
        return Ok(());
    }
    println!(
        "⬆ update available: {} → {}",
        update::CURRENT_VERSION,
        manifest.version
    );
    if let Some(n) = &manifest.notes {
        println!("  {n}");
    }
    if args.check {
        println!("  run `forge-runner update` to install");
        return Ok(());
    }

    match update::apply(&manifest).await? {
        Some(o) => {
            println!("✔ updated {} → {}", o.from, o.to);
            if args.restart {
                restart_service();
            } else {
                println!("  restart to run it: systemctl --user restart forge-runner");
            }
        }
        None => println!("✔ already up to date"),
    }
    Ok(())
}

fn restart_service() {
    #[cfg(target_os = "linux")]
    {
        let mut cmd = std::process::Command::new("systemctl");
        cmd.args(["--user", "restart", "forge-runner"]);
        if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
            let uid = unsafe { getuid() };
            cmd.env("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
        }
        match cmd.status() {
            Ok(s) if s.success() => println!("✔ service restarted"),
            _ => {
                println!("⚠ could not restart service — run: systemctl --user restart forge-runner")
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    println!("  restart the service manually to run the new binary.");
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "getuid"]
    fn getuid() -> u32;
}
