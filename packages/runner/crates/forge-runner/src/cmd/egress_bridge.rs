use std::ffi::OsString;
use std::path::PathBuf;

use clap::Args as ClapArgs;

/// Run inside a confined chat session's sandbox, as the parent of the program it runs: carries
/// the sandbox's proxy port on loopback to the egress socket the runner bound in. Writes nothing
/// to stdout, which belongs to the program.
#[derive(ClapArgs)]
pub struct Args {
    /// The runner's egress proxy socket, as bound into the sandbox.
    #[arg(long)]
    socket: PathBuf,
    /// The program and its arguments.
    #[arg(last = true, required = true, value_parser = clap::value_parser!(OsString))]
    command: Vec<OsString>,
}

pub async fn run(args: Args) -> anyhow::Result<()> {
    #[cfg(target_os = "linux")]
    {
        let (program, rest) = args
            .command
            .split_first()
            .ok_or_else(|| anyhow::anyhow!("egress-bridge was given no program to run"))?;
        let code = runner_platform::confine::egress::bridge(&args.socket, program, rest)
            .await
            .map_err(|e| anyhow::anyhow!("egress-bridge could not run {program:?}: {e}"))?;
        std::process::exit(code);
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (args.socket, args.command);
        anyhow::bail!("egress-bridge runs only inside a Linux chat sandbox")
    }
}
