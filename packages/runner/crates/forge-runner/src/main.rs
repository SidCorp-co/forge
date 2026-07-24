//! `forge-runner` — CLI entry point. Thin: parses args and hands off to the
//! `forge-runner-core` lib.

mod cmd;

use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "forge-runner",
    version,
    about = "Lightweight broker between Forge core and local runners (Claude Code CLI)."
)]
struct Cli {
    /// Override the core URL (otherwise: config, then baked-in default).
    #[arg(long, global = true)]
    core_url: Option<String>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Pair this device with Forge via browser approval (OAuth device flow).
    Login(cmd::login::Args),
    /// Bind a project slug to a local repo path.
    Bind(cmd::bind::Args),
    /// Run the runner daemon (connect, register, accept jobs).
    Start(cmd::start::Args),
    /// Show connection + runner status.
    Status(cmd::status::Args),
    /// Tail the runner log.
    Logs(cmd::logs::Args),
    /// Inspect or edit local config.
    Config(cmd::config::Args),
    /// Diagnose the environment (claude CLI, git, cred store, core reachability).
    Doctor(cmd::doctor::Args),
    /// Install/uninstall the OS service (systemd/launchd).
    Service(cmd::service::Args),
    /// List runners registered for this device.
    Runners(cmd::runners::Args),
    /// Pull the latest skills for bound projects now (on-demand, one-shot).
    Sync(cmd::sync::Args),
    /// Check for a newer release and self-update.
    Update(cmd::update::Args),
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let cli = Cli::parse();
    let ctx = cmd::Ctx {
        core_url_override: cli.core_url,
    };

    match cli.command {
        Command::Login(a) => cmd::login::run(ctx, a).await,
        Command::Bind(a) => cmd::bind::run(ctx, a).await,
        Command::Start(a) => cmd::start::run(ctx, a).await,
        Command::Status(a) => cmd::status::run(ctx, a).await,
        Command::Logs(a) => cmd::logs::run(ctx, a).await,
        Command::Config(a) => cmd::config::run(ctx, a).await,
        Command::Doctor(a) => cmd::doctor::run(ctx, a).await,
        Command::Service(a) => cmd::service::run(ctx, a).await,
        Command::Runners(a) => cmd::runners::run(ctx, a).await,
        Command::Sync(a) => cmd::sync::run(ctx, a).await,
        Command::Update(a) => cmd::update::run(ctx, a).await,
    }
}
