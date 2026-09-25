use std::time::Duration;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::error::Error;
use forge_runner_core::transport::pool::{self, PoolEntry, ReadFailure};
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
        update::VERSION_LINE,
        update::BUILD_TARGET
    );

    let mut failed = false;

    failed |= !check_bin("claude", "Claude Code CLI");
    failed |= !check_bin("git", "git");
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

    // The `forge` entry in each bound checkout's `.mcp.json` — what a human
    // running `claude` in that folder gets. Provisioning skips it silently when
    // no PAT is stored, and the folder looks finished either way.
    for (slug, b) in &cfg.bindings {
        match repo_mcp_state(&b.repo_path) {
            RepoMcp::HasForge => println!("✔ repo mcp     {slug}: .mcp.json has the forge server"),
            RepoMcp::NoForgeEntry => println!(
                "• repo mcp     {slug}: .mcp.json has no `forge` server — `forge-runner login --pat <token>`, then re-provision"
            ),
            RepoMcp::Missing => println!(
                "• repo mcp     {slug}: no .mcp.json in {} — `claude` run there reaches no Forge tools",
                b.repo_path.display()
            ),
            RepoMcp::Unreadable(why) => {
                println!("✖ repo mcp     {slug}: {why}");
                failed = true;
            }
        }
    }

    // Which plugin a job spawned here would find installed. `enabled = false`
    // is a legitimate device state, not a failure, so it reports as a note.
    if cfg.plugins.enabled {
        match cfg.plugins.marketplace_repo.as_deref() {
            Some(repo) if !cfg.plugins.plugin_names.is_empty() => println!(
                "✔ plugins      {} @ {repo}",
                cfg.plugins.plugin_names.join(", ")
            ),
            _ => println!(
                "• plugins      enabled but none designated — `forge-runner config set plugins.plugin-names forge`"
            ),
        }
    } else {
        println!("• plugins      disabled — `forge-runner config set plugins.enabled true`");
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

    let (row, token_failed) = access_token_row(&cred_store::load_pat());
    println!("{row}");
    failed |= token_failed;

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

    // What the daemon recorded about its own pool reads. History, not a check of
    // this run: the live read of each project follows in the online section. A
    // record that cannot be read fails the check — the box is reporting nothing.
    if let Some(dir) = forge_runner_core::daemon::control::config_dir() {
        let now = forge_runner_core::daemon::agent_activity::now_ms();
        let recorded = forge_runner_core::daemon::pool_reads::report(&dir, now);
        let mark = if recorded.is_err() { "✖" } else { "•" };
        failed |= recorded.is_err();
        for line in super::status::pool_lines(&recorded, &cfg, now) {
            println!("{mark} {line}");
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

/// What a human opening `claude` in a bound checkout would find.
enum RepoMcp {
    HasForge,
    NoForgeEntry,
    Missing,
    Unreadable(String),
}

fn repo_mcp_state(repo_path: &std::path::Path) -> RepoMcp {
    let path = repo_path.join(".mcp.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return RepoMcp::Missing,
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(doc) if doc.pointer("/mcpServers/forge").is_some() => RepoMcp::HasForge,
        Ok(_) => RepoMcp::NoForgeEntry,
        Err(e) => RepoMcp::Unreadable(format!("{} is not valid JSON ({e})", path.display())),
    }
}

/// The personal access token row, and whether it fails the run. Every job this
/// box starts is refused without one (ISS-1218), so its absence is a failure,
/// and a store that could not be read is not reported as holding nothing.
fn access_token_row(pat: &forge_runner_core::error::Result<Option<String>>) -> (String, bool) {
    match pat {
        Ok(Some(t)) if !t.trim().is_empty() => (
            "✔ access token personal access token present — jobs' Forge tools and `forge-runner api` use it".to_string(),
            false,
        ),
        Ok(_) => (
            "✖ access token none — every job this box starts is refused until one is stored: create one in Forge's web app under Settings → API Tokens, then `forge-runner login --pat <token>` (or set $FORGE_PAT for the runner)".to_string(),
            true,
        ),
        Err(e) => (
            format!("✖ access token the credential store could not be read ({e}) — every job this box starts is refused until it can"),
            true,
        ),
    }
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
            let mut mcp_rows = spawn_mcp_rows(&client, &rows);
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

                if let Some(handle) = mcp_rows.remove(&r.project_id) {
                    failed |= print_mcp_row(handle.await.unwrap_or(None));
                }

                let read = tokio::time::timeout(
                    ONLINE_TIMEOUT,
                    pool::list(&client, Some(&r.project_id), 20),
                )
                .await
                .ok();
                let (ok, line) = pool_row(&r.slug, read);
                println!("{} pool         {line}", if ok { "✔" } else { "✖" });
                failed |= !ok;
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

fn spawn_mcp_rows(
    client: &CoreClient,
    rows: &[runners::MeRunner],
) -> std::collections::HashMap<String, tokio::task::JoinHandle<Option<(bool, String)>>> {
    rows.iter()
        .map(|r| {
            let client = client.clone();
            let project_id = r.project_id.clone();
            let slug = r.slug.clone();
            (
                r.project_id.clone(),
                tokio::spawn(async move { mcp_servers_line(&client, &project_id, &slug).await }),
            )
        })
        .collect()
}

/// One project's pool, read live now. A failed read is ✖ and names what the
/// endpoint answered — never an empty pool (ISS-1234). `None` is no answer
/// inside the budget.
fn pool_row(
    slug: &str,
    read: Option<std::result::Result<Vec<PoolEntry>, ReadFailure>>,
) -> (bool, String) {
    match read {
        Some(Ok(items)) => (true, format!("{slug}: read, {} row(s) listed", items.len())),
        Some(Err(f)) => (
            false,
            format!("{slug}: cannot read the pool — {}", f.reason),
        ),
        None => (
            false,
            format!(
                "{slug}: cannot read the pool — no answer within {}s",
                ONLINE_TIMEOUT.as_secs()
            ),
        ),
    }
}

/// Print one project's MCP row, in the caller's order. `true` when it is a
/// problem.
fn print_mcp_row(line: Option<(bool, String)>) -> bool {
    match line {
        None => false,
        Some((ok, text)) => {
            println!("{} mcp          {text}", if ok { "✔" } else { "✖" });
            !ok
        }
    }
}

async fn mcp_servers_line(
    client: &CoreClient,
    project_id: &str,
    slug: &str,
) -> Option<(bool, String)> {
    let found =
        match tokio::time::timeout(ONLINE_TIMEOUT, mcp_servers::fetch(client, project_id)).await {
            Ok(Ok(found)) => found,
            Ok(Err(e)) => {
                return Some((
                    false,
                    format!("{slug}: could not read the declared MCP servers: {e}"),
                ));
            }
            Err(_) => {
                return Some((
                    false,
                    format!(
                        "{slug}: timeout after {}s reading the declared MCP servers",
                        ONLINE_TIMEOUT.as_secs()
                    ),
                ));
            }
        };
    mcp_verdict(&found).map(|(ok, line)| (ok, format!("{slug}: {line}")))
}

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
    Some((
        true,
        format!("{} available", found.resolved_names.join(", ")),
    ))
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A box with no personal access token refuses every job it starts, so
    /// doctor fails on it, and says where a token comes from.
    #[test]
    fn a_box_with_no_access_token_fails_doctor_and_is_told_where_to_get_one() {
        let (row, failed) = access_token_row(&Ok(None));
        assert!(failed, "{row}");
        assert!(row.starts_with("✖ access token none"), "{row}");
        assert!(
            row.contains("every job this box starts is refused"),
            "{row}"
        );
        assert!(row.contains("Settings → API Tokens"), "{row}");
        assert!(row.contains("forge-runner login --pat <token>"), "{row}");
        assert!(
            access_token_row(&Ok(Some("  ".into()))).1,
            "a blank token is none"
        );

        let (held, held_failed) = access_token_row(&Ok(Some("forge_pat_dev_op".into())));
        assert!(!held_failed, "{held}");
        assert!(held.starts_with("✔ access token"), "{held}");
        assert!(
            !held.contains("forge_pat_dev_op"),
            "the row prints no credential"
        );
    }

    /// An unreadable store used to print the same `none` as an empty one.
    #[test]
    fn an_unreadable_credential_store_is_its_own_failure_rather_than_none() {
        let (row, failed) = access_token_row(&Err(Error::Other(
            "expected ident at line 1 column 2".into(),
        )));
        assert!(failed, "{row}");
        assert!(
            row.contains("could not be read (expected ident at line 1 column 2)"),
            "{row}"
        );
        assert!(
            !row.contains(" none "),
            "a read error is not an absence: {row}"
        );
    }

    /// ISS-1234 criterion 12.
    #[test]
    fn a_failed_pool_read_is_a_cross_naming_what_the_endpoint_answered() {
        let (ok, line) = pool_row(
            "sid-desk",
            Some(Err(ReadFailure {
                status: Some(520),
                reason: "pool 520 (gateway: the origin returned an unknown error)".into(),
            })),
        );
        assert!(!ok);
        assert_eq!(
            line,
            "sid-desk: cannot read the pool — pool 520 (gateway: the origin returned an unknown error)"
        );
    }

    #[test]
    fn a_pool_read_with_no_status_says_the_transports_reason() {
        let (ok, line) = pool_row(
            "sid-desk",
            Some(Err(ReadFailure {
                status: None,
                reason: "pool request: connection refused".into(),
            })),
        );
        assert!(!ok);
        assert!(line.ends_with("pool request: connection refused"), "{line}");
    }

    #[test]
    fn a_pool_that_answered_nothing_in_time_is_a_cross_too() {
        let (ok, line) = pool_row("sid-desk", None);
        assert!(!ok);
        assert!(line.contains("no answer within 5s"), "{line}");
    }

    #[test]
    fn an_empty_pool_that_was_read_is_a_tick() {
        let (ok, line) = pool_row("sid-desk", Some(Ok(Vec::new())));
        assert!(ok);
        assert_eq!(line, "sid-desk: read, 0 row(s) listed");
    }

    /// A core that answers every MCP request after `delay`, for `n` requests.
    async fn slow_core(n: usize, delay: std::time::Duration) -> String {
        slow_core_body(
            n,
            delay,
            r#"{"mcpServers":{},"resolvedNames":[],"droppedNames":[]}"#,
        )
        .await
    }

    /// A core that answers `body` after `delay`, for `n` requests.
    async fn slow_core_body(n: usize, delay: std::time::Duration, body: &'static str) -> String {
        core_answering(n, delay, "200 OK", body).await
    }

    /// A core that answers `status` with `body` after `delay`, for `n` requests.
    async fn core_answering(
        n: usize,
        delay: std::time::Duration,
        status: &'static str,
        body: &'static str,
    ) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for _ in 0..n {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buf = [0u8; 2048];
                    let _ = sock.read(&mut buf).await;
                    tokio::time::sleep(delay).await;
                    let resp = format!(
                        "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        format!("http://{addr}")
    }

    fn row(n: u32) -> runners::MeRunner {
        runners::MeRunner {
            project_id: format!("p-{n}"),
            runner_id: format!("r-{n}"),
            slug: format!("slug-{n}"),
            base_branch: None,
            repo_path: None,
            branch: None,
            status: "assigned".into(),
            workspace_setup: None,
            master_policy: None,
            limit_reason: None,
            rate_limited_for_seconds: None,
        }
    }

    #[tokio::test]
    async fn every_project_mcp_row_shares_one_wait_and_none_is_dropped() {
        let delay = std::time::Duration::from_millis(300);
        let rows: Vec<runners::MeRunner> = (0..3u32).map(row).collect();
        let url = slow_core(rows.len(), delay).await;
        let client = CoreClient::new(url, String::from("tok"));

        let started = std::time::Instant::now();
        let mut handles = spawn_mcp_rows(&client, &rows);
        assert_eq!(handles.len(), rows.len(), "one handle per project");
        for r in &rows {
            let handle = handles
                .remove(&r.project_id)
                .unwrap_or_else(|| panic!("{} has no row", r.project_id));
            handle.await.unwrap();
        }
        let elapsed = started.elapsed();
        assert!(
            elapsed < delay * 2,
            "three {delay:?} answers took {elapsed:?} — they were fetched in series"
        );
    }

    #[tokio::test]
    async fn a_projects_mcp_row_is_handed_back_carrying_its_own_name_not_printed() {
        // A project that declares nothing owes no line at all.
        let quiet = slow_core(1, std::time::Duration::ZERO).await;
        assert!(mcp_servers_line(
            &CoreClient::new(quiet, String::from("tok")),
            "p-1",
            "slug-1"
        )
        .await
        .is_none());
        assert!(!print_mcp_row(None), "and no line is not a problem");

        // A project that owes one gets it BACK, with its own name inside the
        // text — the print loop places a line it cannot otherwise attribute.
        let noisy = slow_core_body(
            1,
            std::time::Duration::ZERO,
            r#"{"mcpServers":{},"resolvedNames":[],"droppedNames":["epodsystem"]}"#,
        )
        .await;
        let (ok, line) = mcp_servers_line(
            &CoreClient::new(noisy, String::from("tok")),
            "p-2",
            "butlocs",
        )
        .await
        .expect("a dropped server owes a row");
        assert!(!ok, "a server this box cannot supply is not a pass: {line}");
        assert!(
            line.starts_with("butlocs:"),
            "the row must name its own project, because the loop prints it verbatim: {line}"
        );
        assert!(line.contains("epodsystem"), "{line}");
        assert!(print_mcp_row(Some((ok, line))));
    }

    /// ISS-1235: a 404 is a read that did not happen, so the project owes a
    /// failing row rather than the silence of one that declares nothing.
    #[tokio::test]
    async fn a_404_from_the_declared_servers_route_is_a_failed_read_row() {
        let missing = core_answering(1, std::time::Duration::ZERO, "404 Not Found", "").await;
        let (ok, line) = mcp_servers_line(
            &CoreClient::new(missing, String::from("tok")),
            "p-3",
            "gone",
        )
        .await
        .expect("a 404 owes a row");
        assert!(!ok, "{line}");
        assert_eq!(
            line,
            "gone: could not read the declared MCP servers: me/mcp-servers 404 Not Found"
        );
    }

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

    #[test]
    fn a_declared_server_this_box_cannot_supply_is_a_problem_and_is_named() {
        let (ok, line) = mcp_verdict(&found(&[], &["epodsystem"])).expect("a row is owed");
        assert!(
            !ok,
            "a server that cannot be supplied is not a pass: {line}"
        );
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

    #[test]
    fn a_project_that_declares_nothing_gets_no_row_at_all() {
        assert!(mcp_verdict(&mcp_servers::ProjectMcpServers::default()).is_none());
    }
}
