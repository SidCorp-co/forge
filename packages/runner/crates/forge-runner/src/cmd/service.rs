use clap::{Args as ClapArgs, Subcommand};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

#[derive(Subcommand)]
pub enum Action {
    /// Install + enable the service so the runner starts on boot.
    Install,
    /// Stop + remove the service.
    Uninstall,
}

pub async fn run(_ctx: Ctx, args: Args) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        match args.action {
            Action::Install => install_systemd(),
            Action::Uninstall => uninstall_systemd(),
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        super::stub(
            "service (launchd/Windows)",
            "M4 — hiện chỉ hỗ trợ Linux/systemd",
        )
    }
}

#[cfg(target_os = "linux")]
fn unit_path() -> anyhow::Result<std::path::PathBuf> {
    let dir = dirs_next::config_dir()
        .ok_or_else(|| anyhow::anyhow!("no config dir"))?
        .join("systemd")
        .join("user");
    Ok(dir.join("forge-runner.service"))
}

#[cfg(target_os = "linux")]
fn install_systemd() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let unit = format!(
        "[Unit]\n\
         Description=Forge Runner\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Type=simple\n\
         ExecStart={} start\n\
         Restart=on-failure\n\
         RestartSec=5\n\
         Environment=RUST_LOG=info\n\n\
         [Install]\n\
         WantedBy=default.target\n",
        exe.display()
    );
    let path = unit_path()?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, unit)?;
    println!("✔ wrote {}", path.display());

    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", "forge-runner.service"])?;
    println!("✔ enabled + started. Logs: journalctl --user -u forge-runner -f");
    println!("  Tip: `loginctl enable-linger $USER` để chạy cả khi chưa đăng nhập.");
    Ok(())
}

#[cfg(target_os = "linux")]
fn uninstall_systemd() -> anyhow::Result<()> {
    let _ = systemctl(&["disable", "--now", "forge-runner.service"]);
    let path = unit_path()?;
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    let _ = systemctl(&["daemon-reload"]);
    println!("✔ removed forge-runner.service");
    Ok(())
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> anyhow::Result<()> {
    let status = std::process::Command::new("systemctl")
        .arg("--user")
        .args(args)
        .status()
        .map_err(|e| anyhow::anyhow!("systemctl: {e} (is systemd available?)"))?;
    if !status.success() {
        anyhow::bail!("systemctl --user {} failed", args.join(" "));
    }
    Ok(())
}
