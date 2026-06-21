use clap::{Args as ClapArgs, Subcommand};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub action: Action,
}

#[derive(Subcommand)]
pub enum Action {
    /// Install + enable the service (runs in the background, restarts on
    /// failure, and starts on boot — even before you log in).
    Install(InstallArgs),
    /// Stop + remove the service.
    Uninstall,
}

#[derive(ClapArgs)]
pub struct InstallArgs {
    /// Don't enable linger — the service then only runs while you're logged in
    /// (does NOT survive logout/reboot on its own).
    #[arg(long)]
    pub no_linger: bool,
}

pub async fn run(_ctx: Ctx, args: Args) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        match args.action {
            Action::Install(a) => install_systemd(a.no_linger),
            Action::Uninstall => uninstall_systemd(),
        }
    }
    #[cfg(target_os = "macos")]
    {
        // launchd has no per-user `linger` knob — a LaunchAgent runs in the GUI
        // session, so `--no-linger` is a no-op here.
        match args.action {
            Action::Install(_) => install_launchd(),
            Action::Uninstall => uninstall_launchd(),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = args;
        // Windows (and anything else) has no equivalent here yet — be explicit
        // about the limitation instead of printing a vague stub.
        println!(
            "• `forge-runner service` supports Linux (systemd) and macOS (launchd) only.\n\
             On Windows, start the runner manually with `forge-runner start`\n\
             (or wrap it in your OS service manager, e.g. Windows Services / NSSM)."
        );
        Ok(())
    }
}

#[cfg(target_os = "macos")]
const LAUNCHD_LABEL: &str = "co.sidcorp.forge-runner";

#[cfg(target_os = "macos")]
fn plist_path() -> anyhow::Result<std::path::PathBuf> {
    let home = dirs_next::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{LAUNCHD_LABEL}.plist")))
}

#[cfg(target_os = "macos")]
fn install_launchd() -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let home = dirs_next::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let log = home.join("Library").join("Logs").join("forge-runner.log");
    let plist = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\">\n\
         <dict>\n\
         \x20 <key>Label</key><string>{label}</string>\n\
         \x20 <key>ProgramArguments</key>\n\
         \x20 <array>\n\
         \x20   <string>{exe}</string>\n\
         \x20   <string>start</string>\n\
         \x20 </array>\n\
         \x20 <key>RunAtLoad</key><true/>\n\
         \x20 <key>KeepAlive</key><true/>\n\
         \x20 <key>EnvironmentVariables</key>\n\
         \x20 <dict><key>RUST_LOG</key><string>info</string></dict>\n\
         \x20 <key>StandardOutPath</key><string>{log}</string>\n\
         \x20 <key>StandardErrorPath</key><string>{log}</string>\n\
         </dict>\n\
         </plist>\n",
        label = LAUNCHD_LABEL,
        exe = xml_escape(&exe.to_string_lossy()),
        log = xml_escape(&log.to_string_lossy()),
    );
    let path = plist_path()?;
    std::fs::create_dir_all(path.parent().unwrap())?;
    std::fs::write(&path, plist)?;
    println!("✔ wrote {}", path.display());

    let uid = unsafe { mac_getuid() };
    let domain = format!("gui/{uid}");
    let plist_str = path.to_string_lossy().to_string();
    // Replace any prior instance, then load. Prefer the modern bootstrap/
    // kickstart verbs; fall back to legacy `load -w` on older macOS.
    let _ = launchctl(&["bootout", &domain, &plist_str]);
    if launchctl(&["bootstrap", &domain, &plist_str]).is_err() {
        launchctl(&["load", "-w", &plist_str])?;
    }
    let service_target = format!("{domain}/{LAUNCHD_LABEL}");
    let _ = launchctl(&["enable", &service_target]);
    let _ = launchctl(&["kickstart", "-k", &service_target]);
    println!(
        "✔ loaded LaunchAgent {LAUNCHD_LABEL} (RunAtLoad + KeepAlive). Logs: tail -f {}",
        log.display()
    );
    println!(
        "• A LaunchAgent runs only while you're logged in (GUI session) and does NOT\n\
         \x20 survive logout/reboot on its own — that would need a root LaunchDaemon."
    );
    Ok(())
}

#[cfg(target_os = "macos")]
fn uninstall_launchd() -> anyhow::Result<()> {
    let path = plist_path()?;
    let uid = unsafe { mac_getuid() };
    let domain = format!("gui/{uid}");
    let plist_str = path.to_string_lossy().to_string();
    let _ = launchctl(&["bootout", &domain, &plist_str]);
    let _ = launchctl(&["unload", "-w", &plist_str]);
    if path.exists() {
        std::fs::remove_file(&path)?;
    }
    println!("✔ removed LaunchAgent {LAUNCHD_LABEL}");
    Ok(())
}

#[cfg(target_os = "macos")]
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

#[cfg(target_os = "macos")]
fn launchctl(args: &[&str]) -> anyhow::Result<()> {
    let status = std::process::Command::new("launchctl")
        .args(args)
        .status()
        .map_err(|e| anyhow::anyhow!("launchctl: {e}"))?;
    if !status.success() {
        anyhow::bail!("launchctl {} failed", args.join(" "));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
extern "C" {
    #[link_name = "getuid"]
    fn mac_getuid() -> u32;
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
fn install_systemd(no_linger: bool) -> anyhow::Result<()> {
    let exe = std::env::current_exe()?;
    let unit = format!(
        "[Unit]\n\
         Description=Forge Runner\n\
         After=network-online.target\n\
         Wants=network-online.target\n\n\
         [Service]\n\
         Type=simple\n\
         ExecStart={} start\n\
         Restart=always\n\
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
    println!("✔ enabled + started (Restart=always). Logs: journalctl --user -u forge-runner -f");

    // Linger lets the user systemd instance — and therefore this service —
    // start at boot and keep running without an interactive login.
    if no_linger {
        println!("• linger skipped (--no-linger): service stops when you log out.");
    } else {
        match enable_linger() {
            Ok(()) => println!("✔ linger enabled: survives logout + starts on boot."),
            Err(e) => println!(
                "⚠ could not enable linger ({e}). Run manually with privileges:\n    sudo loginctl enable-linger $USER"
            ),
        }
    }
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
    // Leave linger as-is — the user may rely on it for other services.
    println!("✔ removed forge-runner.service");
    Ok(())
}

/// Ensure `XDG_RUNTIME_DIR` is set so `systemctl --user` works from any shell
/// (login shells set it; a bare `ssh host cmd` may not).
#[cfg(target_os = "linux")]
fn runtime_env() -> Option<(String, String)> {
    if std::env::var_os("XDG_RUNTIME_DIR").is_some() {
        return None;
    }
    // Safe on Unix: getuid never fails.
    let uid = unsafe { libc_getuid() };
    Some(("XDG_RUNTIME_DIR".into(), format!("/run/user/{uid}")))
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "getuid"]
    fn libc_getuid() -> u32;
}

#[cfg(target_os = "linux")]
fn systemctl(args: &[&str]) -> anyhow::Result<()> {
    let mut cmd = std::process::Command::new("systemctl");
    cmd.arg("--user").args(args);
    if let Some((k, v)) = runtime_env() {
        cmd.env(k, v);
    }
    let status = cmd
        .status()
        .map_err(|e| anyhow::anyhow!("systemctl: {e} (is systemd available?)"))?;
    if !status.success() {
        anyhow::bail!("systemctl --user {} failed", args.join(" "));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn enable_linger() -> anyhow::Result<()> {
    let status = std::process::Command::new("loginctl")
        .args(["enable-linger"])
        .status()
        .map_err(|e| anyhow::anyhow!("loginctl: {e}"))?;
    if !status.success() {
        anyhow::bail!("loginctl enable-linger failed");
    }
    Ok(())
}
