use std::path::PathBuf;

use clap::Args as ClapArgs;

/// Run as a channel agent's pane command (ISS-946): read the launch the box wrote, remove it,
/// take the sandbox's resource ceilings and exec the confined command with exactly its
/// environment. The launch holds the session's environment, its login variables included, so it
/// travels in a file only this user reads rather than on a command line every process can see.
#[derive(ClapArgs)]
pub struct Args {
    /// The launch file the box wrote for this pane.
    launch: PathBuf,
}

pub fn run(args: Args) -> anyhow::Result<()> {
    let launch = runner_core::chat_pane_launch::read_and_remove(&args.launch)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt as _;
        runner_platform::confine::LIMITS
            .apply()
            .map_err(|e| anyhow::anyhow!("chat-pane-exec: the sandbox's ceilings: {e}"))?;
        let mut cmd = std::process::Command::new(&launch.program);
        cmd.args(&launch.args)
            .env_clear()
            .envs(launch.env.iter().map(|(k, v)| (k, v)))
            .envs(pane_terminal(&launch.env))
            .current_dir(&launch.cwd);
        let err = cmd.exec();
        anyhow::bail!(
            "chat-pane-exec: could not start {}: {err}",
            launch.program.display()
        )
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = launch;
        anyhow::bail!("chat-pane-exec runs only on Linux, where a chat session is confined")
    }
}

#[cfg(target_os = "linux")]
/// The terminal the pane's tmux gave this process, where the launch names none: the daemon that
/// built the launch runs under no terminal, and an interactive session cannot draw without one.
fn pane_terminal(env: &[(std::ffi::OsString, std::ffi::OsString)]) -> Vec<(String, String)> {
    ["TERM", "COLORTERM"]
        .into_iter()
        .filter(|k| !env.iter().any(|(name, _)| name == k))
        .filter_map(|k| std::env::var(k).ok().map(|v| (k.to_string(), v)))
        .collect()
}
