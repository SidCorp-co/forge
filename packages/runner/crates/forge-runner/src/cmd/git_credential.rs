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
    /// Ask as the owner-mode channel agent session this runs inside (ISS-765): under its own turn
    /// token, for its own project's repository, never with this box's device token.
    #[arg(long)]
    pub session: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    let input = read_request()?;
    if args.operation != "get" {
        return Ok(());
    }
    if args.session {
        let host = field(&input, "host");
        let path = field(&input, "path");
        let protocol = Some(field(&input, "protocol"))
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| "https".into());
        return match session_grant(&ctx, &host, &path).await {
            Ok(grant) => print_grant(&protocol, &host, &grant),
            Err(e) => {
                eprintln!("forge-runner git-credential --session: {e}");
                Ok(())
            }
        };
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

fn field(input: &[(String, String)], key: &str) -> String {
    input
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.clone())
        .unwrap_or_default()
}

/// The grant in git's helper shape, for the protocol and host git asked about.
fn print_grant(
    protocol: &str,
    host: &str,
    grant: &git_credential::GitCredentialGrant,
) -> anyhow::Result<()> {
    let mut out = std::io::stdout().lock();
    writeln!(out, "protocol={protocol}")?;
    writeln!(out, "host={host}")?;
    writeln!(out, "username={}", grant.username)?;
    writeln!(out, "password={}", grant.password)?;
    if let Some(unix) = grant.expires_at.as_deref().and_then(parse_rfc3339_unix) {
        writeln!(out, "password_expiry_utc={unix}")?;
    }
    out.flush()?;
    Ok(())
}

/// The session's turn token: `$FORGE_PAT`, or a resident session's bearer file, which holds it as
/// the `Authorization` header its MCP server sends.
fn session_token() -> anyhow::Result<String> {
    if let Some(pat) = std::env::var("FORGE_PAT").ok().filter(|v| !v.is_empty()) {
        return Ok(pat);
    }
    let file = std::env::var("FORGE_SESSION_BEARER_FILE")
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "this session holds no turn token ($FORGE_PAT or $FORGE_SESSION_BEARER_FILE); --session runs only inside an owner-mode channel agent's session"
            )
        })?;
    let body = std::fs::read_to_string(&file)
        .map_err(|e| anyhow::anyhow!("the session's bearer file {file} cannot be read: {e}"))?;
    let header: serde_json::Value = serde_json::from_str(&body)
        .map_err(|e| anyhow::anyhow!("the session's bearer file {file} is not JSON: {e}"))?;
    header
        .get("Authorization")
        .and_then(|v| v.as_str())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("the session's bearer file {file} names no Bearer token"))
}

/// A credential for `host`/`path`, asked of core as this session (ISS-765).
pub async fn session_grant(
    ctx: &Ctx,
    host: &str,
    path: &str,
) -> anyhow::Result<git_credential::GitCredentialGrant> {
    if path.is_empty() {
        anyhow::bail!(
            "git sent no repository path for {host}; credential.useHttpPath=true is how this helper tells repositories apart"
        );
    }
    let project = std::env::var("FORGE_PROJECT_ID")
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| anyhow::anyhow!("this session names no project ($FORGE_PROJECT_ID)"))?;
    let cfg = Config::load()?;
    let core_url = ctx
        .resolve_core_url(&cfg)
        .ok_or_else(|| anyhow::anyhow!("no core URL configured for this session"))?;
    let client = CoreClient::new(core_url, session_token()?);
    Ok(git_credential::ask_session(&client, &project, host, path).await?)
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
