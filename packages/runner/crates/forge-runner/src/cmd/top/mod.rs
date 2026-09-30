//! `forge-runner top` — a live, read-only view of this box (ISS-1341).
//!
//! Every project bound here or served to this box; each project's master pane,
//! the skill that pane stands on and the CLI slug its checkout resolves; every
//! run holding a lease, aged by the newest file under its worktree; what waits
//! on a person; and the gate and pool health `status` prints — each row
//! naming the read it came from.
//!
//! What it never does: dispatch, claim, kill, release, answer, attach to a pane
//! or type into one, write the ledger, or send core anything but a GET. The
//! verbs that act stay the verbs they are.

mod binary;
mod cli_slug;
mod gather;
mod ledger_ro;
mod panes;
mod people;
mod render;
mod skill;
mod source;
mod tree_age;

use std::io::{IsTerminal, Write};
use std::time::Duration;

use clap::Args as ClapArgs;

use super::Ctx;

#[derive(ClapArgs, Debug, Clone)]
pub struct Args {
    /// Print one frame and exit, as happens anyway when stdout is not a terminal.
    #[arg(long)]
    pub once: bool,

    /// Seconds between redraws on a terminal.
    #[arg(long, default_value_t = 5, value_parser = clap::value_parser!(u64).range(1..=3600))]
    pub interval: u64,
}

impl Default for Args {
    fn default() -> Self {
        Self {
            once: false,
            interval: 5,
        }
    }
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let mut carry = gather::Carry::default();
    let live = !args.once && std::io::stdout().is_terminal();
    if !live {
        let snapshot = gather::frame(&ctx, &mut carry).await;
        println!("{}", render::frame(&snapshot, None).join("\n"));
        return Ok(());
    }
    loop {
        let snapshot = gather::frame(&ctx, &mut carry).await;
        let lines = render::frame(&snapshot, Some(args.interval));
        let mut out = std::io::stdout().lock();
        // Home, clear: the frame replaces the last one rather than scrolling.
        writeln!(out, "\x1b[H\x1b[2J{}", lines.join("\n"))?;
        out.flush()?;
        drop(out);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(args.interval)) => {}
            _ = tokio::signal::ctrl_c() => {
                println!();
                return Ok(());
            }
        }
    }
}
