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
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::transport::{git_credential, CoreClient};

use super::Ctx;

#[derive(ClapArgs)]
pub struct Args {
    /// The git credential operation: `get`, `store` or `erase`.
    pub operation: String,
}

// cm:guard STDOUT carries the protocol and nothing else — every diagnostic goes to stderr. A stray line on stdout is parsed by git as a credential field, and an unknown field is ignored silently, so the failure looks like a wrong password rather than like output in the wrong stream.
pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    // cm:guard drain stdin BEFORE deciding not to answer — git writes the credential to this helper on `store`, so returning first closes the pipe mid-write and git prints a warning on every fetch that reads as a broken credential rather than as a no-op.
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

    // cm:guard refuse rather than answer when git sent no path — resolution is by repository, so a helper that guesses would hand this repository's token to whatever else lives on the host. The remedy is `credential.<url>.useHttpPath=true`, which `workspace::provision` sets; say so instead of failing anonymously.
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
            // cm:why git ≥2.34 drops a cached credential at this instant instead of retrying an expired one and reporting it as a rejected password
            if let Some(unix) = grant.expires_at.as_deref().and_then(parse_rfc3339_unix) {
                writeln!(out, "password_expiry_utc={unix}")?;
            }
            out.flush()?;
            Ok(())
        }
        // cm:guard exit 0 with NO credential on a refusal — git then tries the next helper and finally reports its own failure, whereas a non-zero exit aborts the whole fetch with this helper's name on it. The reason still has to reach the operator, so print it: an empty answer with no line on stderr is the silent substitution this path is meant to avoid.
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

/// `2026-09-08T16:04:05Z` → unix seconds, without pulling in a date crate.
fn parse_rfc3339_unix(s: &str) -> Option<i64> {
    let (date, rest) = s.split_once('T')?;
    let time = rest.trim_end_matches('Z');
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let se: i64 = t.next()?.split('.').next()?.parse().ok()?;
    Some(days_from_civil(y, mo, da) * 86_400 + h * 3600 + mi * 60 + se)
}

/// Howard Hinnant's `days_from_civil` — days between 1970-01-01 and y-m-d.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_an_rfc3339_expiry_to_unix_seconds() {
        assert_eq!(parse_rfc3339_unix("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_rfc3339_unix("2026-09-08T16:04:05Z"),
            Some(1_788_883_445)
        );
        assert_eq!(
            parse_rfc3339_unix("2026-09-08T16:04:05.123Z"),
            Some(1_788_883_445)
        );
        assert_eq!(parse_rfc3339_unix("not a date"), None);
    }
}
