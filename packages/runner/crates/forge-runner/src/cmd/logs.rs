use clap::Args as ClapArgs;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// Follow the log.
    #[arg(short, long)]
    pub follow: bool,
}

pub async fn run(_ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    // The daemon currently logs to stderr (RUST_LOG controls verbosity).
    // A dedicated log file + `logs -f` lands in M4.
    println!("Daemon logs to stderr. When running as a service:");
    println!("  journalctl --user -u forge-runner -f      # Linux/systemd");
    println!("Set RUST_LOG=debug for more detail.");
    Ok(())
}
