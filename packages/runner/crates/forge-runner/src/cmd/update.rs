use clap::Args as ClapArgs;
use runner_daemon::serving::Turnover;
use runner_platform::config::Config;
use runner_update as update;

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
            restart_this_configurations_daemon(Applied::No);
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

    // The build standing at the install path is kept beside it and the one
    // installed starts on probation, as the daemon's own update does: a build
    // installed by hand that dies at start is put back too (ISS-1378). Before
    // it, this route kept nothing, and the build the service manager restarted
    // into was the one it could not start.
    let served = update::ServedBuild::new();
    match update::apply(&manifest, Some(&served)).await? {
        update::Applied::Installed(o) => {
            println!("✔ updated {} → {}", o.from, o.to);
            if cfg!(unix) {
                println!(
                    "  {} serves on probation: if it starts {} times without staying up {}s, it is put back to {}",
                    o.to,
                    update::probation::LIMIT,
                    update::probation::PERIOD.as_secs(),
                    o.from
                );
            }
            if args.restart {
                restart_this_configurations_daemon(Applied::Yes);
            } else {
                print_restart_hint();
            }
        }
        update::Applied::HeldBack { rejected, exe } => {
            println!(
                "✖ {} is held back, not installed: {}",
                rejected.version,
                rejected.why(&exe)
            );
            if args.restart {
                restart_this_configurations_daemon(Applied::No);
            }
        }
        update::Applied::UpToDate => println!("✔ already up to date"),
    }
    Ok(())
}

/// Whether this command has just replaced the file on disk in this same run.
///
/// It decides ONE thing: whether the build the daemon serves is worth
/// comparing. After an apply it is not — the constants compiled into this
/// process are the OLD binary's, so a daemon agreeing with them agrees with
/// the build that was just superseded, and `Already` means "restart it", not
/// "nothing to do".
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Applied {
    Yes,
    No,
}

/// `--restart`, on both of its branches.
///
/// Where the file on disk is already the latest, that state is not the rare
/// one: it is exactly where a self-update applied and its handover deferred, so
/// the file is current and the daemon is still on the inode it started from.
/// Returning at `up to date` sent the operator away with the box still serving
/// the old build — this issue's own rule (a version claim is about the running
/// process, not the file) broken inside the remedy `forge-runner status`
/// advertises. So the process is asked, not the manifest.
///
/// The other branch — an update this command just applied — used to call
/// `restart_service`, which restarts whatever single `forge-runner*.service`
/// the box has, with no pid↔unit match and no drain check. That is this
/// issue's own defect reached from the other side: on the box this change
/// exists for, one systemd unit and one daemon started by hand under its own
/// `XDG_CONFIG_HOME` share `~/.local/bin/forge-runner`, and running this from
/// the hand-started daemon's environment stopped a healthy daemon mid-job and
/// left the lagging one lagging. Both branches now ask the same question of
/// the same daemon, and a restart reaches only the unit answering for it.
fn restart_this_configurations_daemon(applied: Applied) {
    use runner_daemon::serving;

    let Some(dir) = runner_platform::config::config_dir() else {
        println!("  no config directory resolves on this box, so which build the daemon serves cannot be read — restart the service by hand if it lags");
        return;
    };
    let read = serving::read(&dir);
    // The identity the record was written with. A restart is only ever taken
    // on a pid this still matches, so it is captured here, before the box's
    // units are read, and compared again at the moment of acting.
    let recorded = read
        .as_ref()
        .ok()
        .and_then(|r| r.as_ref())
        .and_then(|r| r.start_ticks.clone());
    let still_the_same = move |pid: u32| match &recorded {
        Some(then) => runner_platform::proc::start_ticks(pid).as_ref() == Some(then),
        // No recorded identity is `unverified`, which never acts.
        None => false,
    };
    let turnover = serving::turnover(
        &read,
        &serving::Probe::this_box(),
        update::CURRENT_VERSION,
        update::BUILD_COMMIT,
    );
    say_and_act(decide(turnover, applied), still_the_same);
}

/// Why a daemon is being turned over, in the words the operator gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Because {
    /// It serves this build, named, and this command's file is newer.
    Lags(String),
    /// The file it runs was replaced by this command a moment ago.
    FileReplaced,
}

/// What `--restart` comes to once the daemon has answered — the whole of it,
/// with nothing printed and nothing restarted, so every branch can be asserted
/// rather than run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Decision {
    NothingToRestart {
        pid: u32,
        unverified: bool,
    },
    Restart {
        pid: u32,
        unverified: bool,
        because: Because,
    },
    /// It is turning itself over already; cutting in stops the work it waits on.
    Draining {
        pid: u32,
        cause: String,
        outstanding: Vec<String>,
        unverified: bool,
    },
    /// No daemon could be named, and this command has just replaced the file
    /// the box's one unit runs.
    OnlyUnit(String),
    /// No daemon could be named and nothing was replaced.
    ByHand(String),
}

/// **`Already` does not mean "nothing to do" after an apply.** The version and
/// commit compiled into this process are the OLD binary's — this process IS
/// the old binary, mid-run — so a daemon agreeing with them agrees with the
/// build this command has just superseded on disk. Comparing builds there
/// answers a question nobody asked; the daemon lags by construction, because
/// the file under it changed a moment ago.
pub(crate) fn decide(turnover: Turnover, applied: Applied) -> Decision {
    match turnover {
        Turnover::Already { pid, unverified } if applied == Applied::Yes => Decision::Restart {
            pid,
            unverified,
            because: Because::FileReplaced,
        },
        Turnover::Already { pid, unverified } => Decision::NothingToRestart { pid, unverified },
        Turnover::Draining {
            pid,
            cause,
            outstanding,
            unverified,
        } => Decision::Draining {
            pid,
            cause,
            outstanding,
            unverified,
        },
        Turnover::Owed {
            pid,
            build,
            unverified,
        } => Decision::Restart {
            pid,
            unverified,
            because: Because::Lags(build),
        },
        // Nothing here names a daemon to match a unit against. Where this
        // command has just replaced the binary on disk, the box's one unit
        // runs that file and does lag, and restarting it is this command's own
        // act rather than a claim about whose daemon it is — so it is taken,
        // and what could not be read is said rather than passed over.
        Turnover::Unknown(why) if applied == Applied::Yes => Decision::OnlyUnit(why),
        Turnover::Unknown(why) => Decision::ByHand(why),
    }
}

fn say_and_act(decision: Decision, still_the_same: impl Fn(u32) -> bool) {
    let hedge = |unverified: bool| {
        if unverified {
            " (this platform cannot confirm that pid is still that daemon)"
        } else {
            ""
        }
    };
    match decision {
        Decision::NothingToRestart { pid, unverified } => println!(
            "  the daemon on this box (pid {pid}) already serves this build — nothing to restart{}",
            hedge(unverified)
        ),
        Decision::Restart {
            pid,
            unverified,
            because,
        } => {
            match &because {
                Because::Lags(build) => println!(
                    "  but the daemon on this box (pid {pid}) is serving {build}, not this build{}",
                    hedge(unverified)
                ),
                Because::FileReplaced => println!(
                    "  the daemon on this box (pid {pid}) is running the file that was just replaced{}",
                    hedge(unverified)
                ),
            }
            restart_the_unit_running(pid, unverified, move || still_the_same(pid));
        }
        // The daemon is already handing itself over and is waiting for the
        // work it holds in-process. Restarting the unit now would cut exactly
        // that work.
        Decision::Draining {
            pid,
            cause,
            outstanding,
            unverified,
        } => {
            println!(
                "  the daemon on this box (pid {pid}) is handing over for {cause} and replaces itself with the build on disk once its in-process work ends — not restarting it{}",
                hedge(unverified)
            );
            if outstanding.is_empty() {
                println!("  it is waiting on nothing this command can see; `forge-runner status` says how long it has waited");
            } else {
                println!(
                    "  restarting it now would cut the {} it is waiting for:",
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
        Decision::OnlyUnit(why) => {
            println!("  which daemon serves this configuration cannot be read from here: {why}");
            println!("  so this restarts the unit running the file that was replaced, which is not necessarily the daemon of this configuration:");
            restart_the_only_unit_on_this_box();
            println!("  a daemon started some other way still runs the old build — `forge-runner status` says which.");
        }
        Decision::ByHand(why) => {
            println!("  which build the daemon serves cannot be read from here: {why}");
            println!("  `forge-runner status` says which case holds; restart the service by hand if it lags");
        }
    }
}

#[cfg(target_os = "linux")]
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
    /// A unit answered for the pid, but the pid stopped being that daemon
    /// while this box's units were being read.
    Moved(String),
}

#[cfg(target_os = "linux")]
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
/// `still_the_same` re-reads the pid's identity and is asked LAST, once a unit
/// has answered for the pid: a daemon that exits while this box's units are
/// being read hands its pid back, and the next process to take it may be
/// another unit's main process. The match would then be sound at every step
/// and still restart a healthy daemon mid-job, which is the one thing this
/// whole check exists to refuse. An identity read once and acted on later is
/// not an identity; it is a number that used to be one.
pub(crate) fn choose_restart(
    pid: u32,
    unverified: bool,
    units: &[String],
    main_pid: impl Fn(&str) -> Option<u32>,
    still_the_same: impl Fn() -> bool,
) -> Restart {
    let read: Vec<(String, Option<u32>)> = units.iter().map(|u| (u.clone(), main_pid(u))).collect();
    // Asked before the box's units are, because every sentence below this
    // point is a claim about which unit pid `pid` is — including "it was
    // started some other way", which an unconfirmable identity cannot support
    // either.
    if unverified {
        return Restart::Unverified(read);
    }
    if units.is_empty() {
        return Restart::NoUnits;
    }
    let mine: Vec<String> = read
        .iter()
        .filter(|(_, p)| *p == Some(pid))
        .map(|(u, _)| u.clone())
        .collect();
    match mine.len() {
        1 if !still_the_same() => Restart::Moved(mine.into_iter().next().expect("one")),
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
fn restart_the_unit_running(pid: u32, unverified: bool, still_the_same: impl Fn() -> bool) {
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
    match choose_restart(pid, unverified, &units, unit_main_pid, still_the_same) {
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
            let blind = read.iter().filter(|(_, p)| p.is_none()).count();
            // A unit whose main process could not be read is not a unit that
            // answered no. Refusing on it is right; saying it answered no is a
            // claim about a reading that never happened.
            if blind == 0 {
                println!(
                    "  refusing to restart: pid {pid} is the main process of none of this box's forge-runner units, so restarting one would leave that daemon lagging and stop another mid-job. The units here are:"
                );
            } else {
                println!(
                    "  refusing to restart: pid {pid} is the main process of none of the forge-runner units this box could read, and {blind} of them could not be read — so restarting one would leave that daemon lagging and might stop another mid-job. The units here are:"
                );
            }
            say_units(&read);
            println!("  stop and start pid {pid} however it was started.");
        }
        Restart::Moved(unit) => {
            println!(
                "  refusing to restart {unit}: pid {pid} stopped being the daemon that recorded it while this box's units were being read, so that pid may now belong to another process entirely."
            );
            println!("  run `forge-runner status` again, and restart what it names.");
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
fn restart_the_unit_running(pid: u32, _unverified: bool, _still_the_same: impl Fn() -> bool) {
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
    main_pid_of(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "linux")]
/// What `systemctl show -p MainPID --value` says, as a pid or nothing.
///
/// Split from the call so it can be tested: with the reader injected into
/// `choose_restart`, no test reached this mapping, and restoring `Ok(0) =>
/// Some(0)` left the whole suite green — a stopped unit would then match a
/// record carrying pid 0 and be restarted on a `0 == 0`.
fn main_pid_of(stdout: &str) -> Option<u32> {
    match stdout.trim().parse::<u32>() {
        // systemd answers 0 for a unit that is not running.
        Ok(0) | Err(_) => None,
        Ok(pid) => Some(pid),
    }
}

/// The box's one `forge-runner*.service`, restarted because the file it runs
/// was replaced by this command a moment ago — NOT because anything here says
/// it is this configuration's daemon. Its only caller says so in the same
/// breath, and names what it does not cover.
#[cfg(target_os = "linux")]
fn restart_the_only_unit_on_this_box() {
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
fn restart_the_only_unit_on_this_box() {
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
