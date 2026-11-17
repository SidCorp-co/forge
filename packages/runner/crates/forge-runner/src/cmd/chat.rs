//! `chat` — open a channel's room agent, which runs as a Claude Code background session named
//! `forge-chat-<slug>` (ISS-1268).

use clap::{Args as ClapArgs, Subcommand};
use runner_workspace::bg_session::Kind;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Open the room agent's session live in this terminal (`claude attach`).
    Attach {
        /// Project slug.
        slug: String,
    },
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    match args.cmd {
        Command::Attach { slug } => super::master::attach(Kind::Chat, &slug).await,
    }
}
