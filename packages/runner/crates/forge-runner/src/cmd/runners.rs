use clap::Args as ClapArgs;
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {}

pub async fn run(_ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    if cfg.bindings.is_empty() {
        println!("Chưa có runner nào (chưa bind project).");
        return Ok(());
    }
    println!("Runners (1 per bound project, type=claude-code):");
    for (slug, b) in &cfg.bindings {
        let status = if b.project_id.is_some() {
            "ready"
        } else {
            "no project_id"
        };
        println!("  {slug:<24} {status}");
    }
    if !cfg.runner.register_enabled {
        println!(
            "\nLưu ý: register_enabled=off → đang dùng device-room (runnerFramework chưa bật)."
        );
    }
    Ok(())
}
