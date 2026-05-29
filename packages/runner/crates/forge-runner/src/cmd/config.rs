use clap::{Args as ClapArgs, Subcommand};
use forge_runner_core::config::Config;

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    #[command(subcommand)]
    pub action: Option<Action>,
}

#[derive(Subcommand)]
pub enum Action {
    /// Print the full config (default).
    Show,
    /// Print the config file path.
    Path,
    /// Set a config value: `core-url` or `projects-root`.
    Set { key: String, value: String },
}

pub async fn run(_ctx: Ctx, args: Args) -> anyhow::Result<()> {
    match args.action.unwrap_or(Action::Show) {
        Action::Show => {
            let cfg = Config::load()?;
            print!("{}", toml::to_string_pretty(&cfg)?);
        }
        Action::Path => println!("{}", Config::path()?.display()),
        Action::Set { key, value } => {
            let mut cfg = Config::load()?;
            match key.as_str() {
                "core-url" | "core_url" => cfg.core_url = Some(value),
                "projects-root" | "projects_root" => cfg.projects_root = Some(value.into()),
                other => anyhow::bail!("unknown key `{other}` (try: core-url | projects-root)"),
            }
            cfg.save()?;
            println!("✔ saved {}", Config::path()?.display());
        }
    }
    Ok(())
}
