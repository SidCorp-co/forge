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
    /// `update.manifest-url`, `skills.auto_pull`, `plugins.enabled`,
    /// `plugins.marketplace-repo` or `plugins.plugin-names`.
    Set { key: String, value: String },
}

pub async fn run(_ctx: Ctx, args: Args) -> anyhow::Result<()> {
    match args.action.unwrap_or(Action::Show) {
        Action::Show => {
            let cfg = Config::load()?;
            print!("{}", toml::to_string_pretty(&cfg)?);
        }
        #[expect(clippy::disallowed_methods, reason = "prints the config path")]
        Action::Path => println!("{}", Config::path()?.display()),
        Action::Set { key, value } => {
            let apply = change_for(&key, value)?;
            Config::update(|cfg| {
                apply(cfg);
                Ok(())
            })?;
            #[expect(
                clippy::disallowed_methods,
                reason = "prints the path Config::update wrote"
            )]
            let saved = Config::path()?;
            println!("✔ saved {}", saved.display());
        }
    }
    Ok(())
}

/// What `config set <key> <value>` does to the config, refused before the
/// config is locked or read when the key or the value is not one it takes.
type Change = Box<dyn FnOnce(&mut Config)>;

fn change_for(key: &str, value: String) -> anyhow::Result<Change> {
    let flag = |name: &str, value: &str| {
        value
            .parse::<bool>()
            .map_err(|_| anyhow::anyhow!("`{name}` expects `true` or `false`, got `{value}`"))
    };
    Ok(match key {
        "core-url" | "core_url" => Box::new(move |cfg| cfg.core_url = Some(value)),
        "projects-root" | "projects_root" => {
            Box::new(move |cfg| cfg.projects_root = Some(value.into()))
        }
        // ISS-392 — flip auto-update without hand-editing TOML.
        "update.auto" | "update-auto" => {
            let on = flag("update.auto", &value)?;
            Box::new(move |cfg| cfg.update.auto = on)
        }
        "update.manifest-url" | "update.manifest_url" => {
            Box::new(move |cfg| cfg.update.manifest_url = Some(value))
        }
        // ISS-736 — canary gate for background skill auto-pull.
        "skills.auto_pull" | "skills.auto-pull" => {
            let on = flag("skills.auto_pull", &value)?;
            Box::new(move |cfg| cfg.skills.auto_pull = on)
        }
        // The driver skill reaches a device through this plugin, so
        // the three keys that decide which one it installs are
        // settable without hand-editing TOML.
        "plugins.enabled" | "plugins-enabled" => {
            let on = flag("plugins.enabled", &value)?;
            Box::new(move |cfg| cfg.plugins.enabled = on)
        }
        "plugins.marketplace-repo" | "plugins.marketplace_repo" => {
            Box::new(move |cfg| cfg.plugins.marketplace_repo = Some(value))
        }
        "plugins.plugin-names" | "plugins.plugin_names" => {
            let names: Vec<String> = value
                .split(',')
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .map(str::to_string)
                .collect();
            Box::new(move |cfg| cfg.plugins.plugin_names = names)
        }
        other => anyhow::bail!(
            "unknown key `{other}` (try: core-url | projects-root | update.auto | update.manifest-url | skills.auto_pull | plugins.enabled | plugins.marketplace-repo | plugins.plugin-names)"
        ),
    })
}
