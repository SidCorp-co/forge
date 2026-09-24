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

/// Install the OS service for this platform, the same way `service install`
/// does. `setup` calls it rather than telling the operator to run a second
/// command, and rather than growing a second unit writer beside this one.
/// The path a service unit may name as the program to start.
///
/// Not `current_exe()` raw: that is a `/proc` link on Linux and reads
/// `<path> (deleted)` once the file behind it is gone, and a unit carrying that
/// string fails at every boot with nothing but `not found` to say why. Returned
/// as text rather than a path, because `display()` replaces bytes it cannot
/// render and a unit built from that names a different file — the same refusal
/// `hook_install::install` already makes (ISS-1200).
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn own_exe_text() -> anyhow::Result<String> {
    let exe = forge_runner_core::exe::own()?.path;
    exe.to_str().map(str::to_string).ok_or_else(|| {
        anyhow::anyhow!(
            "the runner's own path is not valid UTF-8 ({}), so a service naming it would name a different file — install no service rather than one that cannot start",
            exe.display()
        )
    })
}

/// One `ExecStart` word, written the way systemd reads one.
///
/// systemd splits the line on whitespace, takes `\` as an escape inside quotes,
/// `%` as a specifier and `$` as a variable. A runner at
/// `/opt/Forge Runner/forge-runner` written bare parses as `/opt/Forge`, and the
/// unit is accepted, enabled, and never starts (consult 7bbe98 F2).
#[cfg(target_os = "linux")]
fn systemd_exec_word(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' | '"' => {
                out.push('\\');
                out.push(c);
            }
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The unit body for a runner at `exe`, separate from writing it so the one
/// thing that has to be right about it can be read back.
#[cfg(target_os = "linux")]
fn systemd_unit(exe: &str) -> String {
    format!(
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
        systemd_exec_word(exe)
    )
}

pub fn install_now() -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        install_systemd(false)
    }
    #[cfg(target_os = "macos")]
    {
        install_launchd()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        anyhow::bail!("no OS service is supported on this platform yet — run `forge-runner start`")
    }
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
    let exe = own_exe_text()?;
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
        exe = xml_escape(&exe),
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
    let unit = systemd_unit(&own_exe_text()?);
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

/// What a service unit may name as the program to start (ISS-1200).
#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn exec_start(unit: &str) -> &str {
        unit.lines()
            .find_map(|l| l.strip_prefix("ExecStart="))
            .expect("the unit names no program to start")
    }

    #[test]
    fn a_runner_under_a_path_with_a_space_is_one_word_to_systemd() {
        let line = systemd_unit("/opt/Forge Runner/forge-runner");
        assert_eq!(
            exec_start(&line),
            "\"/opt/Forge Runner/forge-runner\" start",
            "systemd splits an ExecStart line on whitespace, so a bare path here is two words and the unit starts /opt/Forge"
        );
    }

    #[test]
    fn the_three_characters_systemd_reads_as_syntax_are_written_back() {
        // A quote and a backslash are escaped inside the quoting; `%` is a
        // specifier and `$` a variable, and both are doubled to mean themselves.
        assert_eq!(
            systemd_exec_word(r#"/opt/a"b\c%d$e/forge-runner"#),
            r#""/opt/a\"b\\c%%d$$e/forge-runner""#
        );
    }

    #[test]
    fn an_ordinary_path_still_names_itself() {
        assert_eq!(
            exec_start(&systemd_unit("/home/dev/.local/bin/forge-runner")),
            "\"/home/dev/.local/bin/forge-runner\" start"
        );
    }

    #[test]
    fn the_unit_still_carries_what_makes_it_a_service() {
        let unit = systemd_unit("/bin/forge-runner");
        for line in [
            "Type=simple",
            "Restart=always",
            "RestartSec=5",
            "Environment=RUST_LOG=info",
            "WantedBy=default.target",
        ] {
            assert!(unit.contains(line), "the unit lost {line}:\n{unit}");
        }
    }
}
