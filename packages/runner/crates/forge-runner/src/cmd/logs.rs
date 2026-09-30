use clap::Args as ClapArgs;

use super::Ctx;

/// No flags: this command reads no log. It says where this box's daemon log is
/// read, which is what a held report points a person at (ISS-1250). A `-f`
/// accepted and ignored would be a follow nobody gets, so none is taken.
#[derive(ClapArgs)]
pub struct Args {}

pub async fn run(_ctx: Ctx, _args: Args) -> anyhow::Result<()> {
    // The daemon logs to stderr (RUST_LOG controls verbosity), which the
    // service manager keeps.
    println!("Daemon logs to stderr. When running as a service:");
    println!("  journalctl --user -u forge-runner -f      # Linux/systemd");
    println!("Set RUST_LOG=debug for more detail.");
    Ok(())
}
