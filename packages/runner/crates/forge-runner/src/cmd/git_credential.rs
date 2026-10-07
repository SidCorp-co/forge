//! `forge-runner git-credential <get|store|erase>` — a git credential helper.
//!
//! Git speaks this over stdin/stdout: `key=value` lines, a blank line, and for
//! `get` the same shape back. It is invoked as a subprocess of every fetch and
//! push, which is exactly why the credential is fetched per call instead of
//! written to disk — an installation token expires in an hour, and a job can
//! run longer than one.
//!
//! `store` and `erase` must succeed doing nothing. Git calls them after every
//! `get`, and a helper that errors there turns a working clone into a failing
//! one for no reason.

use std::io::{BufRead, Write};

use clap::Args as ClapArgs;
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_transport::{git_credential, CoreClient};

use super::Ctx;
use runner_platform::clock::rfc3339_ms;

#[derive(ClapArgs)]
pub struct Args {
    /// The git credential operation: `get`, `store` or `erase`.
    pub operation: String,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let input = read_request()?;
    if args.operation != "get" {
        return Ok(());
    }
    let host = input
        .iter()
        .find(|(k, _)| k == "host")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let path = input
        .iter()
        .find(|(k, _)| k == "path")
        .map(|(_, v)| v.clone())
        .unwrap_or_default();

    if path.is_empty() {
        eprintln!(
            "forge-runner git-credential: git sent no repository path for {host}; \
             set credential.https://{host}.useHttpPath=true so this helper can tell repositories apart"
        );
        return Ok(());
    }

    let cfg = Config::load()?;
    let Some(core_url) = ctx.resolve_core_url(&cfg) else {
        eprintln!("forge-runner git-credential: no core URL configured; run `forge-runner login`");
        return Ok(());
    };
    let Some(token) = cred_store::load_device_token()? else {
        eprintln!(
            "forge-runner git-credential: this box holds no device token; run `forge-runner login`"
        );
        return Ok(());
    };

    let client = CoreClient::new(core_url, token);
    match git_credential::ask(&client, &host, &path).await {
        Ok(grant) => {
            let mut out = std::io::stdout().lock();
            writeln!(out, "protocol=https")?;
            writeln!(out, "host={host}")?;
            writeln!(out, "username={}", grant.username)?;
            writeln!(out, "password={}", grant.password)?;
            if let Some(unix) = grant.expires_at.as_deref().and_then(parse_rfc3339_unix) {
                writeln!(out, "password_expiry_utc={unix}")?;
            }
            out.flush()?;
            Ok(())
        }
        Err(e) => {
            eprintln!("forge-runner git-credential: {e}");
            Ok(())
        }
    }
}

/// Read git's `key=value` request until the terminating blank line or EOF.
fn read_request() -> anyhow::Result<Vec<(String, String)>> {
    let mut pairs = Vec::new();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once('=') {
            pairs.push((k.trim().to_string(), v.trim().to_string()));
        }
    }
    Ok(pairs)
}

/// `2026-09-08T16:04:05Z` → unix seconds.
fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    rfc3339_ms(s).map(|ms| ms.div_euclid(1000))
}
