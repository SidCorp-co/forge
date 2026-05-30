use std::time::Duration;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::error::Error;
use forge_runner_core::transport::{heartbeat, runners, CoreClient};
use forge_runner_core::update;

use super::Ctx;

/// Budget for each online call so doctor never hangs when core is unreachable
/// (reqwest has no default timeout). Mirrors the update-check posture above.
const ONLINE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(ClapArgs)]
pub struct Args {
    /// Skip network checks (heartbeat + /me/runners); run local checks only.
    #[arg(long)]
    pub offline: bool,
}

pub async fn run(ctx: Ctx, args: Args) -> anyhow::Result<()> {
    println!("Forge Runner — doctor\n");
    println!(
        "✔ version      {} ({})",
        update::CURRENT_VERSION,
        update::BUILD_TARGET
    );

    let mut failed = false;

    failed |= !check_bin("claude", "Claude Code CLI");
    failed |= !check_bin("git", "git");

    let cfg_path = Config::path()?;
    if cfg_path.exists() {
        println!("✔ config       {}", cfg_path.display());
    } else {
        println!(
            "• config       not found ({}) — run `forge-runner login`",
            cfg_path.display()
        );
    }

    let cfg = Config::load().unwrap_or_default();

    match ctx.resolve_core_url(&cfg) {
        Some(url) => println!("✔ core_url     {url}"),
        None => {
            println!("✖ core_url     not configured (run `forge-runner login` or pass --core-url)");
            failed = true;
        }
    }

    match &cfg.device_id {
        Some(id) => println!("✔ paired       device {id}"),
        None => println!("• paired       not yet — run `forge-runner login`"),
    }

    if cfg.bindings.is_empty() {
        println!("• bindings     none — `forge-runner bind <slug> --path <dir>`");
    } else {
        for (slug, b) in &cfg.bindings {
            let is_repo = b.repo_path.join(".git").exists();
            if !is_repo {
                failed = true;
            }
            println!(
                "{} bind        {slug} → {}",
                if is_repo { "✔" } else { "✖" },
                b.repo_path.display()
            );
        }
    }

    // Implemented in M1.
    println!("• cred store   keychain + file fallback (M1)");

    // Best-effort update check (3s budget — never blocks doctor).
    if let Some(url) = update::manifest_url(
        cfg.update.manifest_url.as_deref(),
        ctx.resolve_core_url(&cfg).as_deref(),
    ) {
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            update::fetch_manifest(&url),
        )
        .await
        {
            Ok(Ok(m)) if update::is_newer(&m.version, update::CURRENT_VERSION) => println!(
                "⬆ update       {} available (run `forge-runner update`)",
                m.version
            ),
            Ok(Ok(_)) => println!("✔ update       on the latest version"),
            _ => println!("• update       could not check (manifest missing/unreachable)"),
        }
    }

    // End-to-end online checks: heartbeat (token + reachability) and the
    // server-side assignment reconciliation. Gated behind `--offline`.
    if args.offline {
        println!("• online       skipped (--offline)");
    } else {
        failed |= online_checks(&ctx, &cfg).await;
    }

    if failed {
        println!("\n✖ VERDICT      FAIL — fix the ✖ items above");
        // Exit non-zero (not an anyhow::Err) so the checklist prints cleanly
        // without an `Error:` trace while CI/install scripts see the failure.
        std::process::exit(1);
    }
    println!("\n✔ VERDICT      PASS");
    Ok(())
}

/// Run the network section. Returns `true` if any check failed. Missing
/// core_url/token is non-fatal (mirrors `cmd/runners.rs`) — we skip online
/// checks and let the local verdict stand.
async fn online_checks(ctx: &Ctx, cfg: &Config) -> bool {
    let (core_url, token) = match (
        ctx.resolve_core_url(cfg),
        cred_store::load_device_token().unwrap_or_default(),
    ) {
        (Some(url), Some(tok)) => (url, tok),
        _ => {
            println!("• online       not logged in — skipping network checks (run `forge-runner login`)");
            return false;
        }
    };

    let client = CoreClient::new(core_url.clone(), token);
    let mut failed = false;

    // Heartbeat: 200 => token valid + core reachable; 401 => bad token/core_url.
    match tokio::time::timeout(ONLINE_TIMEOUT, heartbeat::beat_verbose(&client)).await {
        Ok(Ok(server_time)) => {
            if server_time.is_empty() {
                println!("✔ heartbeat    core reachable, token valid");
            } else {
                println!("✔ heartbeat    core reachable, token valid (serverTime {server_time})");
            }
        }
        Ok(Err(Error::Unauthorized)) => {
            println!("✖ heartbeat    401 — bad token/core_url, run `forge-runner login`");
            failed = true;
        }
        Ok(Err(e)) => {
            println!("✖ heartbeat    core unreachable — check core_url ({core_url}): {e}");
            failed = true;
        }
        Err(_) => {
            println!("✖ heartbeat    timeout after {}s — check core_url ({core_url})", ONLINE_TIMEOUT.as_secs());
            failed = true;
        }
    }

    // Assignment reconciliation: server view vs local bindings/paths.
    match tokio::time::timeout(ONLINE_TIMEOUT, runners::list_me(&client)).await {
        Ok(Ok(rows)) => {
            if rows.is_empty() {
                println!("• runners      not assigned to any project on the server");
            }
            for r in &rows {
                let local_path = cfg
                    .bindings
                    .iter()
                    .find(|(_, b)| b.project_id.as_deref() == Some(r.project_id.as_str()))
                    .map(|(_, b)| b.repo_path.clone());
                let server_path = r
                    .repo_path
                    .as_deref()
                    .filter(|p| !p.trim().is_empty())
                    .map(std::path::PathBuf::from);

                // Prefer the server's repo_path (the source of truth web + CLI
                // both write via PATCH /me/runners) over the local binding;
                // matches the precedence in `cmd/runners.rs`.
                match server_path.or(local_path) {
                    None => {
                        println!(
                            "✖ runner       {} assigned on the server but missing local repo_path (run `forge-runner bind {} --path <dir>`)",
                            r.slug, r.slug
                        );
                        failed = true;
                    }
                    Some(p) => {
                        let has_git = p.join(".git").exists();
                        if has_git {
                            println!("✔ runner       {} → {}", r.slug, p.display());
                        } else {
                            let why = if p.exists() { "no .git" } else { "directory does not exist" };
                            println!("✖ runner       {} → {} ({why})", r.slug, p.display());
                            failed = true;
                        }
                    }
                }
            }
        }
        Ok(Err(Error::Unauthorized)) => {
            println!("✖ runners      401 — bad token/core_url, run `forge-runner login`");
            failed = true;
        }
        Ok(Err(e)) => {
            println!("✖ runners      could not fetch assignments from server: {e}");
            failed = true;
        }
        Err(_) => {
            println!("✖ runners      timeout after {}s", ONLINE_TIMEOUT.as_secs());
            failed = true;
        }
    }

    failed
}

/// Returns `true` when the binary is on PATH.
fn check_bin(bin: &str, label: &str) -> bool {
    match which::which(bin) {
        Ok(p) => {
            println!("✔ {label:<12} {}", p.display());
            true
        }
        Err(_) => {
            println!("✖ {label:<12} `{bin}` not found on PATH");
            false
        }
    }
}
