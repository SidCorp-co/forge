//! `forge-runner` — CLI entry point. Thin: parses args and hands off to the
//! `forge-runner-core` lib.

mod cmd;

use clap::{Parser, Subcommand};

#[derive(Parser)]
// `version` is the RELEASED identity, not Cargo's: the version the release tag
// carried plus the commit it was built from. A person reading a box back, and core
// comparing one against `main`, are looking at the same two values.
#[command(
    name = "forge-runner",
    version = forge_runner_core::update::VERSION_LINE,
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
    /// Call any Forge REST endpoint with a personal access token (`gh api` shaped).
    Api(cmd::api::Args),
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
    /// git credential helper: hand git a GitHub App token for one repository.
    #[command(name = "git-credential")]
    GitCredential(cmd::git_credential::Args),
    /// Report a Claude Code hook event from inside a pane this daemon spawned.
    Hook(cmd::hook::Args),
    /// Answer a pane's `PreToolUse`: has the work it is handing out been declared?
    Gate(cmd::gate::Args),
    /// Install/uninstall the OS service (systemd/launchd).
    Service(cmd::service::Args),
    /// Take this box from installed to running work: pair, bind, service, doctor.
    Setup(cmd::setup::Args),
    /// Declare what a master is about to hand a subagent, and close it after.
    Run(cmd::run::Args),
    /// List runners registered for this device.
    Runners(cmd::runners::Args),
    /// Look at, talk to, stand down and end this box's resident masters.
    Master(cmd::master::Args),
    /// Ask a person on this box's pairing, and read the answer back.
    Question(cmd::question::Args),
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

    // `--version` answers for this file, and its stdout stays exactly what
    // clap prints because something may parse it. Where a live daemon serves
    // another build, that is said on stderr beside it (ISS-1223).
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) if e.kind() == clap::error::ErrorKind::DisplayVersion => {
            e.print()?;
            if let Some(note) = cmd::status::version_note() {
                eprintln!("{note}");
            }
            return Ok(());
        }
        Err(e) => e.exit(),
    };
    let ctx = cmd::Ctx {
        core_url_override: cli.core_url,
    };

    match cli.command {
        Command::Api(a) => cmd::api::run(ctx, a).await,
        Command::Login(a) => cmd::login::run(ctx, a).await,
        Command::Bind(a) => cmd::bind::run(ctx, a).await,
        Command::Start(a) => cmd::start::run(ctx, a).await,
        Command::Status(a) => cmd::status::run(ctx, a).await,
        Command::Logs(a) => cmd::logs::run(ctx, a).await,
        Command::Config(a) => cmd::config::run(ctx, a).await,
        Command::Doctor(a) => cmd::doctor::run(ctx, a).await,
        Command::GitCredential(a) => cmd::git_credential::run(ctx, a).await,
        Command::Hook(a) => {
            cmd::hook::run(a).await;
            Ok(())
        }
        Command::Gate(a) => {
            cmd::gate::run(a).await;
            Ok(())
        }
        Command::Service(a) => cmd::service::run(ctx, a).await,
        Command::Setup(a) => cmd::setup::run(ctx, a).await,
        Command::Run(a) => cmd::run::run(ctx, a).await,
        Command::Runners(a) => cmd::runners::run(ctx, a).await,
        Command::Master(a) => cmd::master::run(ctx, a).await,
        Command::Question(a) => cmd::question::run(ctx, a).await,
        Command::Sync(a) => cmd::sync::run(ctx, a).await,
        Command::Update(a) => cmd::update::run(ctx, a).await,
    }
}
