pub mod bind;
pub mod config;
pub mod doctor;
pub mod login;
pub mod logs;
pub mod runners;
pub mod service;
pub mod start;
pub mod status;
pub mod update;

use forge_runner_core::config::Config;

/// Shared context handed to every subcommand.
pub struct Ctx {
    pub core_url_override: Option<String>,
}

impl Ctx {
    /// Effective core URL: `--core-url` flag > config > baked-in default.
    pub fn resolve_core_url(&self, cfg: &Config) -> Option<String> {
        self.core_url_override
            .clone()
            .or_else(|| cfg.core_url.clone())
            .or_else(|| option_env!("FORGE_DEFAULT_CORE_URL").map(str::to_string))
    }
}

/// Print a friendly placeholder for a not-yet-implemented command.
pub fn stub(command: &str, milestone: &str) -> anyhow::Result<()> {
    println!("⏳ `{command}` is not implemented yet — planned for {milestone}.");
    println!("   See docs/proposals/forge-runner-cli.md");
    Ok(())
}
