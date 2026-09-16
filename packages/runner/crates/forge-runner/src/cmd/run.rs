//! `run` — what a master calls to declare the work it is about to hand out.
//!
//! This is not a claim and not a dispatcher. `run declare` writes a row in this
//! box's own registry saying which issues the master is about to give a
//! subagent, and answers that row's id; the master then dispatches the subagent
//! exactly as it does today, inside its own session. `run close` says the row is
//! finished, including when the subagent it was declared for never started.
//!
//! The whole of why it exists: before ISS-1050 nothing wrote that row, so a
//! master dying took its issues with it — they stayed marked as being worked on
//! with no process behind them, and nothing on disk said what to put back.
//!
//! Unlike `hook`, this verb DOES fail loudly. A hook must never break the agent
//! that runs it, so it swallows everything; a declaration that was refused and
//! reported success would let the master dispatch believing its work is
//! recorded when nothing is, which is the exact silence this issue exists to end.

use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::config::Config;
use forge_runner_core::daemon::{control, session_tokens};

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Declare the issues about to be handed to a subagent. Starts nothing.
    // cm:guard NOT called `open`: the pool verb this socket used to carry was `run_open`, it took a job from a queue and started a process, and it is still banned by name in `control.rs`. This one writes a row and starts nothing (ISS-1050).
    Declare(DeclareArgs),
    /// Say a declared run is finished, or never started.
    Close(CloseArgs),
}

#[derive(ClapArgs)]
pub struct DeclareArgs {
    /// The project this run is for. Refused unless this pane is its master.
    #[arg(long)]
    pub project: String,
    /// The issues the subagent is being given, repeated or comma-separated.
    #[arg(long, value_delimiter = ',', required = true)]
    pub issue: Vec<String>,
    /// The worktree the subagent will work in.
    #[arg(long)]
    pub worktree: String,
}

#[derive(ClapArgs)]
pub struct CloseArgs {
    /// The run id `run open` answered.
    pub run_id: String,
    /// Why it is over — kept on the row for whoever reads it next.
    #[arg(long)]
    pub reason: Option<String>,
}

fn socket() -> anyhow::Result<std::path::PathBuf> {
    let cfg = Config::path()?;
    let path = cfg.with_file_name("control.sock");
    if !path.exists() {
        anyhow::bail!(
            "no control socket at {} — this pane was not started by a running forge-runner daemon",
            path.display()
        );
    }
    Ok(path)
}

// cm:guard the refusal text the daemon sent is printed WHOLE and the exit is non-zero. Each refusal names what the master has to do next — which issue collided, which tree is held, which declared row to close, which project this pane actually serves — and a wrapper that reduced them to "failed" would take that away at the one moment it is worth having.
pub async fn run(_ctx: super::Ctx, args: Args) -> anyhow::Result<()> {
    let sock = socket()?;
    let token = session_tokens::token_from_env().map_err(|e| {
        anyhow::anyhow!("this pane carries no control capability: {e} — only a pane the daemon spawned can declare a run")
    })?;
    let reply = match &args.cmd {
        Command::Declare(o) => {
            control::request_run_declare(&sock, &token, &o.project, &o.issue, &o.worktree).await?
        }
        Command::Close(c) => {
            control::request_run_close(&sock, &token, &c.run_id, c.reason.as_deref()).await?
        }
    };
    if !reply.ok {
        anyhow::bail!(
            "{}",
            reply
                .reason
                .unwrap_or_else(|| "refused, with no reason given".into())
        );
    }
    match args.cmd {
        Command::Declare(_) => println!(
            "{}",
            reply
                .job_id
                .unwrap_or_else(|| "the daemon recorded the run but named no id".into())
        ),
        Command::Close(c) => println!("run {} closed", c.run_id),
    }
    Ok(())
}
