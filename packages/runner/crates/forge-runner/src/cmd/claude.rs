//! `claude` — the Claude Code version this box runs its masters and room agents on (ISS-1268 C1).
//!
//! A version is adopted only on a passing canary: `canary <version>` runs throwaway background
//! sessions through every rule the transport stands on; a pass moves the pin
//! (`[runner] claude_version`) and respawns this runner's sessions on it, a failure keeps the pin
//! and is said by name, `CLAUDE_CANARY_FAILED: <check>`.

use clap::{Args as ClapArgs, Subcommand};
use runner_platform::config::Config;
use runner_workspace::bg_session::{self, canary, launch};

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Install a Claude Code version (`claude install <version>`), the updater off. It does not
    /// move the pin: until a canary passes, every new session on this box is refused.
    Install { version: String },
    /// Run the canary for the installed version, which must be `version`; a pass moves the pin.
    Canary {
        version: String,
        /// The scratch directory the throwaway sessions run in.
        #[arg(long)]
        dir: Option<std::path::PathBuf>,
        /// The model the throwaway sessions run on.
        #[arg(long, default_value = "haiku")]
        model: String,
        /// Report only: neither move the pin nor respawn anything.
        #[arg(long)]
        dry_run: bool,
    },
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    match args.cmd {
        Command::Install { version } => install(&version).await,
        Command::Canary {
            version,
            dir,
            model,
            dry_run,
        } => canary_run(&version, dir, &model, dry_run).await,
    }
}

async fn install(version: &str) -> anyhow::Result<()> {
    let bin = runner_platform::process::resolve_claude_bin();
    let status = tokio::process::Command::new(bin)
        .args(["install", version])
        .env(launch::UPDATER_OFF.0, launch::UPDATER_OFF.1)
        .status()
        .await?;
    anyhow::ensure!(
        status.success(),
        "`{bin} install {version}` exited {status}"
    );
    let installed = bg_session::version::installed()
        .await
        .map_err(anyhow::Error::msg)?;
    anyhow::ensure!(
        installed == version,
        "`claude install {version}` left {installed} installed"
    );
    match bg_session::version::check(bg_session::version::pinned().as_deref(), &installed) {
        Ok(()) => println!("{installed} installed; it is the pinned version"),
        Err(why) => println!("{installed} installed. {why}"),
    }
    Ok(())
}

async fn canary_run(
    version: &str,
    dir: Option<std::path::PathBuf>,
    model: &str,
    dry_run: bool,
) -> anyhow::Result<()> {
    let scratch = match dir {
        Some(d) => d,
        None => runner_platform::config::base_dir()?
            .join("claude-canary")
            .join(format!("{version}-{}", uuid::Uuid::new_v4())),
    };
    std::fs::create_dir_all(&scratch)?;
    eprintln!("canary for Claude Code {version} in {}", scratch.display());
    let report = canary::run(version, &scratch, model).await;
    for c in &report.checks {
        println!(
            "{} {:<20} {}",
            if c.passed { "pass" } else { "FAIL" },
            c.name,
            c.detail
        );
    }
    println!(
        "sessions started and stopped: {}",
        report.sessions.join(", ")
    );
    if let Some(failed) = report.failure() {
        anyhow::bail!(
            "{failed}; the pin stays {:?}",
            bg_session::version::pinned()
        );
    }
    if dry_run {
        println!("passed; --dry-run: the pin and the sessions are left as they are");
        return Ok(());
    }
    let mut cfg = Config::load()?;
    cfg.runner.claude_version = Some(version.to_string());
    cfg.save()?;
    println!("passed; the pin is now {version}");
    for (name, said) in respawn_ours().await? {
        println!("respawned {name}: {}", said.trim());
    }
    Ok(())
}

/// Respawn every live background session this runner owns (masters and room agents) on the
/// installed version, each by its id: never `--all`, which would reach sessions that are not
/// this runner's.
async fn respawn_ours() -> anyhow::Result<Vec<(String, String)>> {
    let ours = |name: &str| {
        [bg_session::Kind::Master, bg_session::Kind::Chat]
            .iter()
            .any(|k| name.starts_with(&format!("{}-", k.prefix())))
    };
    let mut out = Vec::new();
    for s in bg_session::list().await? {
        let (Some(id), Some(name)) = (s.id.as_deref(), s.name.as_deref()) else {
            continue;
        };
        if s.is_background() && ours(name) {
            let said = launch::respawn(id).await.map_err(anyhow::Error::msg)?;
            out.push((name.to_string(), said));
        }
    }
    // a room agent's session is listed and respawned only inside its room (ISS-1268 BR)
    for host in bg_session::room::Host::all() {
        for s in host.roster().await? {
            let (Some(id), Some(name)) = (s.id.as_deref(), s.name.as_deref()) else {
                continue;
            };
            if s.is_background() && s.is_live() && ours(name) {
                let said = host.respawn(id).await.map_err(anyhow::Error::msg)?;
                out.push((name.to_string(), said));
            }
        }
    }
    Ok(out)
}
