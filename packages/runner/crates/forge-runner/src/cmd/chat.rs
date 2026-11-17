//! `chat` — open a channel's room agent, which runs as a Claude Code background session named
//! `forge-chat-<slug>` inside its room's own sandbox (ISS-1268 BR).

use clap::{Args as ClapArgs, Subcommand};
use runner_workspace::bg_session::room::{attach_target, Host};

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub cmd: Command,
}

#[derive(Subcommand)]
pub enum Command {
    /// Open the room agent's session live in this terminal (`claude attach`, inside its room).
    Attach {
        /// Project slug.
        slug: String,
    },
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    match args.cmd {
        Command::Attach { slug } => attach(&slug).await,
    }
}

/// `claude attach <id>` in this process's place, run inside the room's sandbox: the room's own
/// service is the only one that holds its session, and it is reached only in the room's
/// namespaces.
async fn attach(slug: &str) -> anyhow::Result<()> {
    let host = Host::of(slug).map_err(anyhow::Error::msg)?;
    let roster = host.roster().await?;
    let (id, session_id) = attach_target(&roster, slug).map_err(anyhow::Error::msg)?;
    eprintln!("forge-chat-{slug}: claude attach {id} (conversation {session_id}), in its room");
    let args = ["attach".to_string(), id.clone()];
    let mut cmd = host
        .command(&args, &host.dirs.root)
        .map_err(anyhow::Error::msg)?;
    let std = cmd.as_std_mut();
    std.stdin(std::process::Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        let err = std.exec();
        anyhow::bail!("could not open {id} in its room: {err}")
    }
    #[cfg(not(unix))]
    {
        let status = std.status()?;
        anyhow::ensure!(status.success(), "attach {id} exited {status}");
        Ok(())
    }
}
