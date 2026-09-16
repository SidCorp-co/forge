use std::time::Duration;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::error::Error;
use forge_runner_core::transport::{heartbeat, mcp_servers, runners, CoreClient};
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
    // cm:guard tmux is REQUIRED, not advisory. Since ISS-919 a master is a tmux session, and a box without it starts no master at all — it sits online, heartbeats, reports healthy and never runs a single job. This line is where an operator finds that out in ten seconds instead of by noticing a quiet project.
    failed |= !check_bin("tmux", "tmux (hosts the master session)");

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

    // Report the backend a read/write would actually resolve to right now
    // (ISS-467 — was a hardcoded string). The plaintext-file warning only makes
    // sense where a keychain alternative exists: on Linux the file store is the
    // only backend (keychain is cfg(macos/windows)), so flagging it there is a
    // false alarm — report it informationally instead.
    let backend = cred_store::active_backend();
    match backend {
        cred_store::Backend::File => {
            #[cfg(any(target_os = "macos", target_os = "windows"))]
            println!("⚠ cred store   {backend} — set FORGE_RUNNER_CRED_STORE=keychain for OS-managed storage");
            #[cfg(not(any(target_os = "macos", target_os = "windows")))]
            println!("• cred store   {backend} (only backend on this platform)");
        }
        _ => println!("✔ cred store   {backend}"),
    }

    // cm:guard report the PAT's ABSENCE, never its value or a prefix of it. `doctor` output is what people paste into a bug report, and a token fragment there is a token disclosed — the only fact worth printing is whether `forge-runner api` has a credential at all.
    match cred_store::load_pat() {
        Ok(Some(_)) => println!("✔ rest token   personal access token present (`forge-runner api`)"),
        _ => println!(
            "• rest token   none — `forge-runner api` needs one (`forge-runner login --pat <token>` or $FORGE_PAT)"
        ),
    }

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
            println!(
                "• online       not logged in — skipping network checks (run `forge-runner login`)"
            );
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
            println!(
                "✖ heartbeat    timeout after {}s — check core_url ({core_url})",
                ONLINE_TIMEOUT.as_secs()
            );
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
                            let why = if p.exists() {
                                "no .git"
                            } else {
                                "directory does not exist"
                            };
                            println!("✖ runner       {} → {} ({why})", r.slug, p.display());
                            failed = true;
                        }
                    }
                }

                failed |= mcp_servers_row(&client, &r.project_id, &r.slug).await;
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

/// What this box can actually give a master for one project, as a doctor row.
///
/// ISS-1043 rule 5: a declared server must not read as `ok` on the strength of
/// the declaration. Core is the only party that can say whether a sentinel has
/// an active integration behind it, so the row asks core and reports what came
/// back rather than what the project config says.
///
/// Returns `true` when the row is a problem.
// cm:edge contract -> packages/core/src/devices/mcp-servers-routes.ts — `droppedNames` is what makes this row possible; a response folding the dropped names into the map would leave this printing `ok` for exactly the project ISS-1043 was filed from.
async fn mcp_servers_row(client: &CoreClient, project_id: &str, slug: &str) -> bool {
    let found = match tokio::time::timeout(ONLINE_TIMEOUT, mcp_servers::fetch(client, project_id))
        .await
    {
        Ok(Ok(found)) => found,
        Ok(Err(e)) => {
            println!("✖ mcp          {slug}: could not read the declared MCP servers: {e}");
            return true;
        }
        Err(_) => {
            println!(
                "✖ mcp          {slug}: timeout after {}s reading the declared MCP servers",
                ONLINE_TIMEOUT.as_secs()
            );
            return true;
        }
    };
    match mcp_verdict(&found) {
        None => false,
        Some((ok, line)) => {
            println!("{} mcp          {slug}: {line}", if ok { "✔" } else { "✖" });
            !ok
        }
    }
}

/// The row's text and whether it is a pass, separated from the printing so the
/// three shapes are testable.
///
/// `None` is the SILENT case: a project that declares nothing has nothing to
/// say, and every project on the fleet but a handful is that one.
// cm:guard a project with servers this box cannot supply is `✖` even though nothing is broken on the box. The operator reading this is deciding whether work on that project can run here, and ISS-1043 exists because the answer was printed as `ok` for days while every run on `mowment` reached none of its tools.
fn mcp_verdict(found: &mcp_servers::ProjectMcpServers) -> Option<(bool, String)> {
    if found.is_empty() {
        return None;
    }
    if !found.dropped_names.is_empty() {
        return Some((
            false,
            format!(
                "declared but NOT available here: {} — a run on this project gets none of their tools{}",
                found.dropped_names.join(", "),
                if found.resolved_names.is_empty() {
                    String::new()
                } else {
                    format!(" (available: {})", found.resolved_names.join(", "))
                }
            ),
        ));
    }
    Some((true, format!("{} available", found.resolved_names.join(", "))))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn found(resolved: &[&str], dropped: &[&str]) -> mcp_servers::ProjectMcpServers {
        mcp_servers::ProjectMcpServers {
            mcp_servers: resolved
                .iter()
                .map(|n| ((*n).to_string(), serde_json::json!({ "type": "stdio" })))
                .collect(),
            resolved_names: resolved.iter().map(|n| (*n).to_string()).collect(),
            dropped_names: dropped.iter().map(|n| (*n).to_string()).collect(),
        }
    }

    // cm:guard this is criterion 12 and the whole of ISS-1043's rule 5. A version returning `Some((true, ..))` here reads as `✔ mcp` for the project the issue was filed from, which is the state that went unnoticed for days.
    #[test]
    fn a_declared_server_this_box_cannot_supply_is_a_problem_and_is_named() {
        let (ok, line) = mcp_verdict(&found(&[], &["epodsystem"])).expect("a row is owed");
        assert!(!ok, "a server that cannot be supplied is not a pass: {line}");
        assert!(line.contains("epodsystem"), "{line}");
        assert!(line.contains("NOT available"), "{line}");
    }

    /// Partly-supplied is still a problem, and the row says both halves so the
    /// operator can tell which work is possible here.
    #[test]
    fn a_project_with_one_server_supplied_and_one_not_reports_the_problem_and_both_names() {
        let (ok, line) =
            mcp_verdict(&found(&["playwright"], &["epodsystem"])).expect("a row is owed");
        assert!(!ok, "{line}");
        assert!(line.contains("epodsystem"), "{line}");
        assert!(line.contains("playwright"), "{line}");
    }

    #[test]
    fn a_project_whose_declarations_all_resolved_reads_as_a_pass_naming_them() {
        let (ok, line) = mcp_verdict(&found(&["playwright"], &[])).expect("a row is owed");
        assert!(ok, "{line}");
        assert!(line.contains("playwright"), "{line}");
    }

    // cm:guard the absent case prints NOTHING. Every project on this fleet but a handful declares no servers, and a reassuring `✔ mcp  none declared` row per project is noise an operator learns to skip past — including on the project where it later matters.
    #[test]
    fn a_project_that_declares_nothing_gets_no_row_at_all() {
        assert!(mcp_verdict(&mcp_servers::ProjectMcpServers::default()).is_none());
    }
}
