use std::io::Read;

use clap::Args as ClapArgs;
use forge_runner_core::api::{is_json, run as run_api, usage_failure, Request, EXIT_TAXONOMY};
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
    let Some(token) = cred_store::load_device_token()? else {
        return usage("not logged in — run `forge-runner login`");
    };

    let body = match args.data.as_deref() {
        None => None,
        Some("-") => {
            let mut s = String::new();
            std::io::stdin().read_to_string(&mut s)?;
            Some(s)
        }
        Some(d) => Some(d.to_string()),
    };
    // cm:guard --data is validated HERE, before the request. A body core would reject with a 400 costs a round trip and reports the server's parse error, not the caller's typo; and on a POST that half-succeeded elsewhere, "it was never sent" is the only cheap answer.
    if let Some(b) = &body {
        if !is_json(b) {
            return usage("--data is not valid JSON");
        }
    }

    let mut headers = Vec::new();
    for h in &args.headers {
        let Some((k, v)) = h.split_once(':') else {
            return usage(&format!("header must be `Name: value`, got `{h}`"));
        };
        headers.push((k.trim().to_string(), v.trim().to_string()));
    }

    let method = args
        .method
        .clone()
        .unwrap_or_else(|| if body.is_some() { "POST" } else { "GET" }.to_string());

    let req = Request {
        method,
        path: args.path.clone(),
        body,
        project_slug: args.project.clone().or_else(|| default_slug(&cfg)),
        headers,
        include_headers: args.include,
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

/// `$FORGE_PROJECT_SLUG`, then the sole binding — ambiguity is left to `--project`.
// cm:why guessing among several bindings would send a call to the wrong project with a token that is valid for both, which reads as a Forge bug rather than a missing flag
fn default_slug(cfg: &Config) -> Option<String> {
    if let Ok(s) = std::env::var("FORGE_PROJECT_SLUG") {
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    match cfg.bindings.len() {
        1 => cfg.bindings.keys().next().cloned(),
        _ => None,
    }
}

fn usage(message: &str) -> anyhow::Result<()> {
    let (outcome, line) = usage_failure(message);
    eprintln!("{line}");
    std::process::exit(outcome.exit_code);
}
