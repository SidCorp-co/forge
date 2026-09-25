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
        update::VERSION_LINE,
        update::BUILD_TARGET
    );
    let manifest = update::fetch_manifest(&url).await?;

    if !update::is_newer(&manifest.version, update::CURRENT_VERSION) {
        println!("✔ up to date (latest {})", manifest.version);
        if args.restart {
            restart_if_the_daemon_lags();
        }
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
                print_restart_hint();
            }
        }
        None => println!("✔ already up to date"),
    }
    Ok(())
}

/// `--restart` where the file on disk is already the latest.
///
/// That state is not the rare one: it is exactly where a self-update applied
/// and its drain deferred, so the file is current and the daemon is still on
/// the inode it started from. Returning at `up to date` sent the operator away
/// with the box still serving the old build — this issue's own rule (a version
/// claim is about the running process, not the file) broken inside the remedy
/// `forge-runner status` advertises. So the process is asked, not the manifest.
fn restart_if_the_daemon_lags() {
    use forge_runner_core::daemon::serving::{self, Turnover};

    let Some(dir) = forge_runner_core::daemon::control::config_dir() else {
        println!("  no config directory resolves on this box, so which build the daemon serves cannot be read — restart the service by hand if it lags");
        return;
    };
    let hedge = |unverified: bool| {
        if unverified {
            " (this platform cannot confirm that pid is still that daemon)"
        } else {
            ""
        }
    };
    match serving::turnover(
        &serving::read(&dir),
        &serving::Probe::this_box(),
        update::CURRENT_VERSION,
        update::BUILD_COMMIT,
    ) {
        Turnover::Already { pid, unverified } => {
            println!(
                "  the daemon on this box (pid {pid}) already serves this build — nothing to restart{}",
                hedge(unverified)
            )
        }
        // The daemon is already restarting itself and is waiting for the work
        // it holds. Restarting the unit now would stop exactly that work.
        Turnover::Draining {
            pid,
            cause,
            outstanding,
        } => {
            println!("  the daemon on this box (pid {pid}) is draining for {cause} and turns itself over once it is idle — not restarting it");
            if outstanding.is_empty() {
                println!("  it is waiting on nothing this command can see; `forge-runner status` says how long it has waited");
            } else {
                println!(
                    "  restarting it now would stop the {} it is waiting for:",
                    if outstanding.len() == 1 {
                        "one piece of work".to_string()
                    } else {
                        format!("{} pieces of work", outstanding.len())
                    }
                );
                for holder in &outstanding {
                    println!("    {holder}");
                }
            }
        }
        Turnover::Owed {
            pid,
            build,
            unverified,
        } => {
            println!(
                "  but the daemon on this box (pid {pid}) is serving {build}, not this build{}",
                hedge(unverified)
            );
            restart_the_unit_running(pid);
        }
        Turnover::Unknown(why) => {
            println!("  which build the daemon serves cannot be read from here: {why}");
            println!("  `forge-runner status` says which case holds; restart the service by hand if it lags");
        }
    }
}

/// Restart the unit whose main process IS the daemon that lags, and no other.
///
/// `restart_service` restarts whatever single `forge-runner*.service` the box
/// has, which is right after an update this command just applied to this
/// binary. It is wrong here: the pid came from ONE configuration's record, and
/// on a box running a second daemon under its own `XDG_CONFIG_HOME` — the box
/// this whole change exists for — the unit is not the process that lagged.
/// Restarting it would leave the lagging daemon lagging and stop a daemon that
/// was fine, mid-job. So the unit is required to answer for that pid, and an
/// unproven one is refused by name rather than restarted anyway.
#[cfg(target_os = "linux")]
fn restart_the_unit_running(pid: u32) {
    let units = match list_forge_runner_units() {
        Ok(u) => u,
        Err(e) => {
            println!(
                "  could not list forge-runner units ({e}) — restart the one running pid {pid} by name: systemctl --user restart <unit>"
            );
            return;
        }
    };
    let mine: Vec<&String> = units
        .iter()
        .filter(|u| unit_main_pid(u) == Some(pid))
        .collect();
    match mine.as_slice() {
        [unit] => {
            let mut cmd = systemctl();
            cmd.args(["restart", unit]);
            match cmd.status() {
                Ok(s) if s.success() => println!("  ✔ restarted {unit}, whose main process was pid {pid}"),
                _ => println!("  ⚠ could not restart {unit} — run: systemctl --user restart {unit}"),
            }
        }
        [] if units.is_empty() => println!(
            "  no forge-runner*.service unit runs on this box, so pid {pid} was started some other way — stop and start it however it was started"
        ),
        [] => {
            println!(
                "  refusing to restart: pid {pid} is the main process of none of this box's forge-runner units, so restarting one would leave that daemon lagging and stop another mid-job. The units here are:"
            );
            for unit in &units {
                match unit_main_pid(unit) {
                    Some(p) => println!("    {unit} (main process pid {p})"),
                    None => println!("    {unit} (its main process could not be read)"),
                }
            }
            println!("  stop and start pid {pid} however it was started.");
        }
        many => {
            println!("  ⚠ {} units claim pid {pid} as their main process, which cannot be — refusing to guess:", many.len());
            for unit in many {
                println!("    {unit}");
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn restart_the_unit_running(pid: u32) {
    println!("  restart the service running pid {pid} manually to turn it over.");
}

/// The pid systemd says is a unit's main process, or `None` where it cannot be
/// read — which is never treated as a match.
#[cfg(target_os = "linux")]
fn unit_main_pid(unit: &str) -> Option<u32> {
    let out = systemctl()
        .args(["show", "-p", "MainPID", "--value", unit])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&out.stdout).trim().parse::<u32>() {
        // systemd answers 0 for a unit that is not running.
        Ok(0) | Err(_) => None,
        Ok(pid) => Some(pid),
    }
}

#[cfg(target_os = "linux")]
fn restart_service() {
    let units = match list_forge_runner_units() {
        Ok(u) => u,
        Err(e) => {
            println!(
                "⚠ could not list forge-runner units ({e}) — restart yours by name: systemctl --user restart <unit>"
            );
            return;
        }
    };

    match units.as_slice() {
        [unit] => {
            let mut cmd = systemctl();
            cmd.args(["restart", unit]);
            match cmd.status() {
                Ok(s) if s.success() => println!("✔ restarted {unit}"),
                _ => println!("⚠ could not restart {unit} — run: systemctl --user restart {unit}"),
            }
        }
        [] => println!(
            "⚠ no forge-runner*.service unit found — restart the service manually to run the new binary."
        ),
        many => {
            println!(
                "⚠ {} forge-runner units on this box — refusing to guess which one you meant:",
                many.len()
            );
            for unit in many {
                println!("    {unit}");
            }
            println!("  restart yours: systemctl --user restart <unit>");
            println!("  never restart a unit mid-job — check `pgrep -P <pid>` for a claude child first.");
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn restart_service() {
    println!("  restart the service manually to run the new binary.");
}

#[cfg(target_os = "linux")]
fn print_restart_hint() {
    match list_forge_runner_units().as_deref() {
        Ok([unit]) => println!("  restart to run it: systemctl --user restart {unit}"),
        _ => println!("  restart to run it: systemctl --user restart <your forge-runner unit>"),
    }
}

#[cfg(not(target_os = "linux"))]
fn print_restart_hint() {
    println!("  restart the service manually to run the new binary.");
}

/// Ensure `XDG_RUNTIME_DIR` is set so `systemctl --user` works from any shell
/// (login shells set it; a bare `ssh host cmd` may not).
#[cfg(target_os = "linux")]
fn systemctl() -> std::process::Command {
    let mut cmd = std::process::Command::new("systemctl");
    cmd.arg("--user");
    if std::env::var_os("XDG_RUNTIME_DIR").is_none() {
        let uid = unsafe { getuid() };
        cmd.env("XDG_RUNTIME_DIR", format!("/run/user/{uid}"));
    }
    cmd
}

#[cfg(target_os = "linux")]
fn list_forge_runner_units() -> anyhow::Result<Vec<String>> {
    let out = systemctl()
        .args([
            "list-units",
            "--type=service",
            "--all",
            "--plain",
            "--no-legend",
            "--no-pager",
            "forge-runner*.service",
        ])
        .output()
        .map_err(|e| anyhow::anyhow!("systemctl: {e} (is systemd available?)"))?;
    if !out.status.success() {
        anyhow::bail!("systemctl --user list-units failed");
    }
    Ok(parse_unit_names(&String::from_utf8_lossy(&out.stdout)))
}

#[cfg(target_os = "linux")]
fn parse_unit_names(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter_map(|line| {
            line.split_whitespace()
                .find(|f| f.ends_with(".service"))
                .map(str::to_string)
        })
        .collect()
}

#[cfg(target_os = "linux")]
extern "C" {
    #[link_name = "getuid"]
    fn getuid() -> u32;
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::parse_unit_names;

    #[test]
    fn reads_one_default_unit() {
        let out = "forge-runner.service loaded active running Forge Runner\n";
        assert_eq!(parse_unit_names(out), vec!["forge-runner.service"]);
    }

    #[test]
    fn reads_every_machine_id_instance() {
        let out = "\
forge-runner-ai005.service loaded active running Forge Runner
forge-runner-ai006.service loaded active running Forge Runner
forge-runner-ai013.service loaded active running Forge Runner
";
        assert_eq!(
            parse_unit_names(out),
            vec![
                "forge-runner-ai005.service",
                "forge-runner-ai006.service",
                "forge-runner-ai013.service",
            ]
        );
    }

    #[test]
    fn reads_a_failed_unit_past_its_marker() {
        let out = "● forge-runner-qa.service loaded failed failed Forge Runner\n";
        assert_eq!(parse_unit_names(out), vec!["forge-runner-qa.service"]);
    }

    #[test]
    fn reads_nothing_from_empty_output() {
        assert!(parse_unit_names("").is_empty());
        assert!(parse_unit_names("\n  \n").is_empty());
    }
}
