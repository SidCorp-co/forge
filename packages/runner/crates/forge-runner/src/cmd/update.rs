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
            unverified,
        } => {
            println!(
                "  the daemon on this box (pid {pid}) is draining for {cause} and turns itself over once it is idle — not restarting it{}",
                hedge(unverified)
            );
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
            restart_the_unit_running(pid, unverified);
        }
        Turnover::Unknown(why) => {
            println!("  which build the daemon serves cannot be read from here: {why}");
            println!("  `forge-runner status` says which case holds; restart the service by hand if it lags");
        }
    }
}

/// What restarting a lagging daemon comes to, once this box's units are read.
///
/// It is separated from the acting so it can be tested: the pid↔unit match is
/// the whole of F3's fix, and a fix that cannot be shown going red is a guess
/// with a commit message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Restart {
    /// This unit's main process is that daemon.
    Unit(String),
    /// No forge-runner unit runs on this box at all.
    NoUnits,
    /// Units run, and none of them answers for that pid.
    NotOurs(Vec<(String, Option<u32>)>),
    /// More than one unit claims that pid, which cannot be.
    Ambiguous(Vec<String>),
    /// The pid's identity was never confirmed, so no unit is restarted on it.
    Unverified(Vec<(String, Option<u32>)>),
}

/// Which unit, if any, a restart for `pid` may touch.
///
/// **An unconfirmed identity restarts nothing.** `status` refuses to assert
/// that an unverifiable pid is still the daemon that recorded it; acting on it
/// here would be that same assertion made with a `systemctl restart` behind it,
/// and where the recorded daemon has died and its pid has been reused by
/// another unit's main process, the restart stops a healthy daemon mid-job and
/// leaves the lagging one lagging — the exact harm this whole check exists to
/// prevent, reached through the one identity the reporting half declines to
/// claim.
pub(crate) fn choose_restart(
    pid: u32,
    unverified: bool,
    units: &[String],
    main_pid: impl Fn(&str) -> Option<u32>,
) -> Restart {
    let read: Vec<(String, Option<u32>)> = units.iter().map(|u| (u.clone(), main_pid(u))).collect();
    if units.is_empty() {
        return Restart::NoUnits;
    }
    if unverified {
        return Restart::Unverified(read);
    }
    let mine: Vec<String> = read
        .iter()
        .filter(|(_, p)| *p == Some(pid))
        .map(|(u, _)| u.clone())
        .collect();
    match mine.len() {
        1 => Restart::Unit(mine.into_iter().next().expect("one")),
        0 => Restart::NotOurs(read),
        _ => Restart::Ambiguous(mine),
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
/// was fine, mid-job. So the unit is required to answer for that pid, and
/// anything short of that is refused by name rather than restarted anyway.
#[cfg(target_os = "linux")]
fn restart_the_unit_running(pid: u32, unverified: bool) {
    let units = match list_forge_runner_units() {
        Ok(u) => u,
        Err(e) => {
            println!(
                "  could not list forge-runner units ({e}) — restart the one running pid {pid} by name: systemctl --user restart <unit>"
            );
            return;
        }
    };
    let say_units = |read: &[(String, Option<u32>)]| {
        for (unit, main) in read {
            match main {
                Some(p) => println!("    {unit} (main process pid {p})"),
                None => println!("    {unit} (its main process could not be read)"),
            }
        }
    };
    match choose_restart(pid, unverified, &units, |u| unit_main_pid(u)) {
        Restart::Unit(unit) => {
            let mut cmd = systemctl();
            cmd.args(["restart", &unit]);
            match cmd.status() {
                Ok(s) if s.success() => {
                    println!("  ✔ restarted {unit}, whose main process was pid {pid}")
                }
                _ => println!("  ⚠ could not restart {unit} — run: systemctl --user restart {unit}"),
            }
        }
        Restart::NoUnits => println!(
            "  no forge-runner*.service unit runs on this box, so pid {pid} was started some other way — stop and start it however it was started"
        ),
        Restart::Unverified(read) => {
            println!(
                "  refusing to restart: this platform cannot confirm pid {pid} is still the daemon that recorded it, and restarting a unit on an identity that was never confirmed can stop a healthy daemon mid-job. The units here are:"
            );
            say_units(&read);
            println!("  check which one is serving this configuration, and restart it yourself.");
        }
        Restart::NotOurs(read) => {
            println!(
                "  refusing to restart: pid {pid} is the main process of none of this box's forge-runner units, so restarting one would leave that daemon lagging and stop another mid-job. The units here are:"
            );
            say_units(&read);
            println!("  stop and start pid {pid} however it was started.");
        }
        Restart::Ambiguous(many) => {
            println!(
                "  ⚠ {} units claim pid {pid} as their main process, which cannot be — refusing to guess:",
                many.len()
            );
            for unit in many {
                println!("    {unit}");
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn restart_the_unit_running(pid: u32, _unverified: bool) {
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
    use super::{choose_restart, parse_unit_names, Restart};

    const UNITS: [&str; 2] = ["forge-runner.service", "forge-runner-qa.service"];

    fn units() -> Vec<String> {
        UNITS.iter().map(|u| u.to_string()).collect()
    }

    /// The whole of F3: a pid is restarted through the unit that runs IT, and
    /// through no other. On a box with a second daemon, the single unit is not
    /// the process that lagged.
    #[test]
    fn a_restart_takes_the_unit_whose_main_process_is_that_pid() {
        assert_eq!(
            choose_restart(4242, false, &units(), |u| match u {
                "forge-runner.service" => Some(4242),
                _ => Some(99),
            }),
            Restart::Unit("forge-runner.service".into())
        );
        assert_eq!(
            choose_restart(4242, false, &units(), |u| match u {
                "forge-runner-qa.service" => Some(4242),
                _ => Some(99),
            }),
            Restart::Unit("forge-runner-qa.service".into()),
            "the second unit is taken where the pid is its main process, not the first"
        );
    }

    /// The measured case: the lagging daemon was started by hand under its own
    /// XDG_CONFIG_HOME, so no unit answers for it. Restarting the box's unit
    /// would stop a daemon that was fine and leave the one that lagged lagging.
    #[test]
    fn a_pid_no_unit_runs_restarts_nothing_and_says_what_each_unit_is_running() {
        let out = choose_restart(1082784, false, &units(), |u| match u {
            "forge-runner.service" => Some(2027223),
            _ => None,
        });
        assert_eq!(
            out,
            Restart::NotOurs(vec![
                ("forge-runner.service".into(), Some(2027223)),
                ("forge-runner-qa.service".into(), None),
            ])
        );
    }

    /// systemd answers `MainPID=0` for a unit that is not running, and
    /// `unit_main_pid` maps that to `None`. A stopped unit must never match,
    /// least of all a pid that happens to be 0.
    #[test]
    fn a_stopped_unit_matches_nothing() {
        assert!(matches!(
            choose_restart(0, false, &units(), |_| None),
            Restart::NotOurs(_)
        ));
    }

    /// A unit whose MainPID could not be read does not promote another unit
    /// into the match: the one that answers is still the one taken.
    #[test]
    fn a_unit_that_cannot_be_read_does_not_shift_the_match() {
        assert_eq!(
            choose_restart(7, false, &units(), |u| match u {
                "forge-runner-qa.service" => Some(7),
                _ => None,
            }),
            Restart::Unit("forge-runner-qa.service".into())
        );
    }

    #[test]
    fn no_units_at_all_is_said_as_that_and_not_as_a_refusal() {
        assert_eq!(
            choose_restart(4242, false, &[], |_| Some(4242)),
            Restart::NoUnits
        );
    }

    #[test]
    fn two_units_claiming_one_pid_are_refused_rather_than_guessed_between() {
        assert_eq!(
            choose_restart(4242, false, &units(), |_| Some(4242)),
            Restart::Ambiguous(vec![
                "forge-runner.service".into(),
                "forge-runner-qa.service".into()
            ])
        );
    }

    /// Review finding N4: `status` refuses to assert that an unverifiable pid
    /// is still the daemon that recorded it, so the remedy may not assert it
    /// with a `systemctl restart` behind it. Where that daemon has died and
    /// its pid has been reused by another unit's main process, restarting on
    /// the match stops a healthy daemon mid-job — the harm this check exists
    /// to prevent, reached through the one identity the report declines.
    #[test]
    fn an_unconfirmed_identity_restarts_nothing_even_where_a_unit_matches() {
        let out = choose_restart(4242, true, &units(), |u| match u {
            "forge-runner.service" => Some(4242),
            _ => Some(99),
        });
        assert_eq!(
            out,
            Restart::Unverified(vec![
                ("forge-runner.service".into(), Some(4242)),
                ("forge-runner-qa.service".into(), Some(99)),
            ]),
            "a unit matching an unconfirmed pid is not evidence that it is that daemon"
        );
        assert!(
            !matches!(out, Restart::Unit(_)),
            "and nothing is restarted on it"
        );
    }

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
