//! `pool` / `claim` / `release` / `load` — the master agent's hands.
//!
//! A master runs as a session on this box and has no credential of its own.
//! Reading goes straight to core with the device token; CLAIMING goes to the
//! local daemon, because taking a job and running it have to happen in the one
//! process that owns the repo lock and the in-flight map.

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::control;
use forge_runner_core::transport::{pool, CoreClient};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// What work this box could take. Reads only — takes nothing.
    List(ListArgs),
    /// Take one job and start it: `prepare` then `start`, in that order.
    Claim(ClaimArgs),
    /// Take one job WITHOUT starting it — job row and job token only.
    Prepare(ClaimArgs),
    /// Start a job this session already prepared.
    Start(HeldArgs),
    /// Hand a preparation back to the pool without ever starting it.
    Discard(HeldArgs),
    /// Hand a job back, or everything a session holds.
    Release(ReleaseArgs),
    /// Raw occupancy: this box, its project, the project's fleet.
    Load(LoadArgs),
}

#[derive(ClapArgs)]
pub struct ListArgs {
    #[arg(long, default_value_t = 20)]
    pub limit: u32,
    #[arg(long)]
    pub project_id: Option<String>,
    /// Print the raw JSON core returned rather than a summary.
    #[arg(long)]
    pub json: bool,
}

#[derive(ClapArgs)]
pub struct ClaimArgs {
    pub job_id: String,
    #[arg(long)]
    pub session_id: String,
    /// Your name for the agent that will run this job. Becomes its git branch
    /// and its worktree; reuse one name to put several jobs in one checkout.
    #[arg(long)]
    pub agent: String,
}

#[derive(ClapArgs)]
pub struct HeldArgs {
    pub job_id: String,
    #[arg(long)]
    pub session_id: String,
}

#[derive(ClapArgs)]
pub struct ReleaseArgs {
    #[arg(long)]
    pub session_id: String,
    /// Omit to release everything this session holds.
    pub job_id: Option<String>,
}

#[derive(ClapArgs)]
pub struct LoadArgs {
    #[arg(long)]
    pub project_id: Option<String>,
}

fn client(ctx: &Ctx, cfg: &Config) -> anyhow::Result<CoreClient> {
    let core_url = ctx
        .resolve_core_url(cfg)
        .ok_or_else(|| anyhow::anyhow!("no core url configured; run `forge-runner login`"))?;
    let token = cred_store::load_device_token()?
        .ok_or_else(|| anyhow::anyhow!("not logged in; run `forge-runner login`"))?;
    Ok(CoreClient::new(core_url, token))
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let c = client(&ctx, &cfg)?;

    match args.cmd {
        Command::List(a) => {
            let items = pool::pool(&c, a.limit, a.project_id.as_deref()).await?;
            if a.json {
                println!("{}", serde_json::to_string_pretty(&items)?);
                return Ok(());
            }
            if items.is_empty() {
                println!("pool is empty");
                return Ok(());
            }
            for e in &items {
                let key = e.issue_key.as_deref().unwrap_or("-");
                let title = e.title.as_deref().unwrap_or("");
                println!(
                    "{}  {:<10} {:<9} {:>5.0}m  {}",
                    key,
                    e.job_type,
                    e.priority.as_deref().unwrap_or("-"),
                    e.age_minutes,
                    title
                );
                // cm:guard print the blocker's status verbatim and NEVER a "blocked"/"ready" verdict. The verdict is the master's to reach, and a CLI that reaches it first is the gate this design deleted, reappearing in the display layer.
                for r in &e.relations {
                    println!(
                        "      {} {} — status={} merged={}",
                        r.kind,
                        r.depends_on_key.as_deref().unwrap_or("?"),
                        r.blocker_status.as_deref().unwrap_or("?"),
                        r.blocker_merged_at.as_deref().unwrap_or("never")
                    );
                }
                println!("      job {}", e.job_id);
            }
        }
        // cm:guard the claim goes to the LOCAL DAEMON, never straight to core. The daemon holds the repo lock and the in-flight map in memory, so a claim made from this process would take a lock the daemon cannot see and start a job it cannot cancel, reap or salvage. If the daemon is not running, refusing here is the correct answer — there is nothing on this box that could run the job anyway.
        // cm:guard `claim` is prepare-then-start over the SAME two socket ops the primitives use, never a third daemon verb. The one irreversible op is what ISS-919 B2 removed; re-adding it here so the common case is one round trip would put it straight back, one layer up, where no test of the split can see it.
        Command::Claim(a) => {
            let sock = socket()?;
            let out = ask(
                "prepare",
                control::request_prepare(&sock, &a.job_id, &a.session_id, &a.agent).await,
                &sock,
            )?;
            if !out.ok {
                report(&out)?;
                std::process::exit(1);
            }
            let out = ask(
                "start",
                control::request_start(&sock, &a.job_id, &a.session_id).await,
                &sock,
            )?;
            report(&out)?;
            if !out.ok {
                std::process::exit(1);
            }
        }
        Command::Prepare(a) => {
            let sock = socket()?;
            let out = ask(
                "prepare",
                control::request_prepare(&sock, &a.job_id, &a.session_id, &a.agent).await,
                &sock,
            )?;
            report(&out)?;
            if !out.ok {
                std::process::exit(1);
            }
        }
        Command::Start(a) => {
            let sock = socket()?;
            let out = ask(
                "start",
                control::request_start(&sock, &a.job_id, &a.session_id).await,
                &sock,
            )?;
            report(&out)?;
            if !out.ok {
                std::process::exit(1);
            }
        }
        Command::Discard(a) => {
            let sock = socket()?;
            let out = ask(
                "discard",
                control::request_discard(&sock, &a.job_id, &a.session_id).await,
                &sock,
            )?;
            report(&out)?;
            if !out.ok {
                std::process::exit(1);
            }
        }
        Command::Release(a) => {
            let n = pool::release(&c, a.job_id.as_deref(), &a.session_id).await?;
            println!("released {n}");
        }
        Command::Load(a) => {
            let v = pool::load(&c, a.project_id.as_deref()).await?;
            println!("{}", serde_json::to_string_pretty(&v)?);
            // cm:guard print the fault flags LOUDLY as well as in the JSON — `auth` means that box's Claude session is dead, nothing in core excludes it from being claimed onto any more, and a master that misses the line hands it work that cannot start.
            warn_faults(v.get("device"), "this box");
            if let Some(fleet) = v.get("fleet").and_then(|f| f.as_array()) {
                for entry in fleet {
                    let name = entry.get("name").and_then(|x| x.as_str()).unwrap_or("?");
                    warn_faults(Some(entry), name);
                }
            }
        }
    }
    Ok(())
}

fn socket() -> anyhow::Result<std::path::PathBuf> {
    control::socket_path()
        .ok_or_else(|| anyhow::anyhow!("cannot resolve the runner control socket path"))
}

fn ask(
    op: &str,
    result: std::io::Result<control::ClaimReply>,
    sock: &std::path::Path,
) -> anyhow::Result<control::ClaimReply> {
    result.map_err(|e| {
        anyhow::anyhow!(
            "no runner daemon answered {op} at {} ({e}) — start the service before claiming",
            sock.display()
        )
    })
}

// cm:guard a refusal exits NON-ZERO so a shell-driven master can branch on it, but the refusal itself is ordinary — it means another master won the race or the box is full, never that anything is broken.
fn report(out: &control::ClaimReply) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(out)?);
    Ok(())
}

// cm:guard walk BOTH the device and every fleet entry. The fleet list is what a master reads when it spreads a batch over several boxes, so a fault printed only for the local device is invisible exactly when it decides where else the work goes.
fn warn_faults(node: Option<&serde_json::Value>, label: &str) {
    let Some(faults) = node
        .and_then(|d| d.get("runnerFaults"))
        .and_then(|f| f.as_array())
    else {
        return;
    };
    for f in faults {
        eprintln!(
            "warning: {label}: runner {} is flagged {}",
            f.get("runnerId").and_then(|x| x.as_str()).unwrap_or("?"),
            f.get("limitReason").and_then(|x| x.as_str()).unwrap_or("?")
        );
    }
}
