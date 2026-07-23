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
    /// Set a config value: `core-url`, `projects-root`, `update.auto`,
    /// `update.manifest-url`, or `skills.auto_pull`.
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
                // ISS-392 — flip auto-update without hand-editing TOML.
                "update.auto" | "update-auto" => {
                    cfg.update.auto = value.parse::<bool>().map_err(|_| {
                        anyhow::anyhow!("`update.auto` expects `true` or `false`, got `{value}`")
                    })?;
                }
                "update.manifest-url" | "update.manifest_url" => {
                    cfg.update.manifest_url = Some(value);
                }
                // ISS-736 — canary gate for background skill auto-pull.
                "skills.auto_pull" | "skills.auto-pull" => {
                    cfg.skills.auto_pull = value.parse::<bool>().map_err(|_| {
                        anyhow::anyhow!(
                            "`skills.auto_pull` expects `true` or `false`, got `{value}`"
                        )
                    })?;
                }
                other => anyhow::bail!(
                    "unknown key `{other}` (try: core-url | projects-root | update.auto | update.manifest-url | skills.auto_pull)"
                ),
            }
            cfg.save()?;
            println!("✔ saved {}", Config::path()?.display());
        }
    }
    Ok(())
}
