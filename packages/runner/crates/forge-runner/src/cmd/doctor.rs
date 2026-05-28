use clap::Args as ClapArgs;
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {}

pub async fn run(ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    println!("Forge Runner — doctor\n");

    check_bin("claude", "Claude Code CLI");
    check_bin("git", "git");

    let cfg_path = Config::path()?;
    if cfg_path.exists() {
        println!("✔ config       {}", cfg_path.display());
    } else {
        println!(
            "• config       chưa có ({}) — chạy `forge-runner login`",
            cfg_path.display()
        );
    }

    let cfg = Config::load().unwrap_or_default();

    match ctx.resolve_core_url(&cfg) {
        Some(url) => println!("✔ core_url     {url}"),
        None => println!("✖ core_url     chưa cấu hình (login hoặc --core-url)"),
    }

    match &cfg.device_id {
        Some(id) => println!("✔ paired       device {id}"),
        None => println!("• paired       chưa — chạy `forge-runner login`"),
    }

    if cfg.bindings.is_empty() {
        println!("• bindings     chưa có — `forge-runner bind <slug> --path <dir>`");
    } else {
        for (slug, b) in &cfg.bindings {
            let is_repo = b.repo_path.join(".git").exists();
            println!(
                "{} bind        {slug} → {}",
                if is_repo { "✔" } else { "✖" },
                b.repo_path.display()
            );
        }
    }

    // Implemented in M1.
    println!("• cred store   keychain + file fallback (M1)");

    Ok(())
}

fn check_bin(bin: &str, label: &str) {
    match which::which(bin) {
        Ok(p) => println!("✔ {label:<12} {}", p.display()),
        Err(_) => println!("✖ {label:<12} không tìm thấy `{bin}` trên PATH"),
    }
}
