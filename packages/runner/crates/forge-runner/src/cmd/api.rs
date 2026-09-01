use std::io::Read;

use clap::Args as ClapArgs;
use forge_runner_core::api::{
    build, run as run_api, usage_failure, RequestSpec, SlugSources, EXIT_TAXONOMY,
};
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::transport::CoreClient;

use super::Ctx;

/// `forge-runner api <PATH>` — call any Forge REST endpoint with this
/// device's credentials. Shaped after `gh api`.
#[derive(ClapArgs)]
#[command(after_help = EXIT_TAXONOMY)]
pub struct Args {
    /// Endpoint path. `issues`, `/issues` and `/api/issues` are the same.
    pub path: String,

    /// HTTP method (default GET, or POST when --data is given).
    #[arg(short = 'X', long)]
    pub method: Option<String>,

    /// JSON request body. `-` reads stdin.
    #[arg(short = 'd', long)]
    pub data: Option<String>,

    /// Project slug for the `X-Forge-Project-Slug` header. Defaults to
    /// `$FORGE_PROJECT_SLUG`, then the sole bound project when there is one.
    #[arg(long)]
    pub project: Option<String>,

    /// Extra header, `Name: value`. Repeatable.
    #[arg(short = 'H', long = "header")]
    pub headers: Vec<String>,

    /// Print the status line and response headers to stderr.
    #[arg(short = 'i', long)]
    pub include: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let cfg = Config::load()?;
    let Some(core_url) = ctx.resolve_core_url(&cfg) else {
        return usage("no core URL — pass --core-url or run `forge-runner login`");
    };
    // cm:guard a PAT and NOT the device token, because `requireAuth` on core rejects a device token outright: a device credential names a machine, and REST fences a caller by the projects its credential may speak for, which a machine credential cannot answer. Measured on forge-beta 2026-09-01, before this: one PAT to /mcp answered 200 and the same PAT to /api/issues answered 401, and the device token answered 401 on both.
    let Some(token) = cred_store::load_pat()? else {
        return usage(
            "no personal access token — the REST API is reached with a PAT, not the device token. \
             Mint one in the web UI under Settings → Access tokens, then either \
             `forge-runner login --pat <token>` to store it or export FORGE_PAT=<token>.",
        );
    };

    let stdin_body = match args.data.as_deref() {
        Some("-") => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            Some(s)
        }
        _ => None,
    };
    let data = match (&stdin_body, args.data.as_deref()) {
        (Some(s), _) => Some(s.as_str()),
        (None, d) => d,
    };

    let env_slug = std::env::var("FORGE_PROJECT_SLUG").ok();
    let bindings: Vec<String> = cfg.bindings.keys().cloned().collect();
    let spec = RequestSpec {
        path: &args.path,
        method: args.method.as_deref(),
        data,
        project: args.project.as_deref(),
        headers: &args.headers,
        include: args.include,
    };
    let sources = SlugSources {
        env: env_slug.as_deref(),
        bindings: &bindings,
    };
    let req = match build(&spec, &sources) {
        Ok(r) => r,
        Err(message) => return usage(&message),
    };

    let client = CoreClient::new(core_url, token);
    let resp = run_api(&client, &req).await;
    if !resp.stdout.is_empty() {
        println!("{}", resp.stdout);
    }
    if !resp.stderr.is_empty() {
        eprintln!("{}", resp.stderr);
    }
    // cm:guard `std::process::exit` and NOT an `Err` return — the taxonomy is the product here, and anyhow's bubbling would collapse every row onto 1. Nothing above this line holds a buffer that needs flushing: both streams were written with the line macros.
    std::process::exit(resp.outcome.exit_code);
}

fn usage(message: &str) -> anyhow::Result<()> {
    let (outcome, line) = usage_failure(message);
    eprintln!("{line}");
    std::process::exit(outcome.exit_code);
}
