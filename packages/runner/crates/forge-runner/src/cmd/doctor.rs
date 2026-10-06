use std::time::Duration;

use clap::Args as ClapArgs;
use runner_platform::config::Config;
use runner_platform::cred_store;
use runner_platform::error::Error;
use runner_transport::pool::{self, PoolEntry, ReadFailure};
use runner_transport::{heartbeat, mcp_servers, runners, CoreClient};
use runner_update as update;
use runner_workspace::terminal;

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

    failed |= config_rows(&ctx, &cfg);

    device_rows(&cfg);

    let credential_file = cred_store::credential_file_path().ok();
    let (row, token_failed) = access_token_row(&cred_store::load_pat(), credential_file.as_deref());
    println!("{row}");
    failed |= token_failed;

    update_row(&ctx, &cfg).await;
    failed |= pool_record_rows(&cfg);

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

/// The rows for what this box is configured with: core, pairing, bindings and each bound
/// checkout's `.mcp.json`. Returns `true` if any of them failed.
fn config_rows(ctx: &Ctx, cfg: &Config) -> bool {
    let mut failed = false;
    match ctx.resolve_core_url(cfg) {
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
    failed
}

/// The rows for which plugin a job finds installed and where credentials are kept; notes only.
fn device_rows(cfg: &Config) {
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
}

/// Best-effort update check (3s budget — never blocks doctor).
async fn update_row(ctx: &Ctx, cfg: &Config) {
    if let Some(url) = update::manifest_url(
        cfg.update.manifest_url.as_deref(),
        ctx.resolve_core_url(cfg).as_deref(),
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
}

/// What the daemon recorded about its own pool reads. Returns `true` when that record cannot be read.
fn pool_record_rows(cfg: &Config) -> bool {
    let mut failed = false;
    // What the daemon recorded about its own pool reads. History, not a check of
    // this run: the live read of each project follows in the online section. A
    // record that cannot be read fails the check — the box is reporting nothing.
    if let Some(dir) = runner_platform::config::config_dir() {
        let now = runner_core::agent_activity::now_ms();
        let recorded = runner_daemon::pool_reads::report(&dir, now);
        let mark = if recorded.is_err() { "✖" } else { "•" };
        failed |= recorded.is_err();
        for line in super::status::pool_lines(&recorded, cfg, now) {
            println!("{mark} {line}");
        }
    }
    failed
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
///
/// The unreadable row names `file` and the way out, because the job refusal a
/// person reads for the same condition names both and this row named neither —
/// an operator told only that something could not be read has nothing to open
/// (ISS-1235, routed here).
fn access_token_row(
    pat: &runner_platform::error::Result<Option<String>>,
    file: Option<&std::path::Path>,
) -> (String, bool) {
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
            format!(
                "✖ access token {} could not be read ({e}) — every job this box starts is refused until it can: repair that file, or set $FORGE_PAT for the runner",
                file.map_or_else(
                    || String::from("the credential store"),
                    |p| format!("the credential store `{}`", p.display()),
                )
            ),
            true,
        ),
    }
}

/// Run the network section. Returns `true` if any check failed. Missing
/// core_url/token is non-fatal (mirrors `cmd/runners.rs`) — we skip online
/// checks and let the local verdict stand.
async fn online_checks(ctx: &Ctx, cfg: &Config) -> bool {
    // A store this box cannot parse is not a box that never paired. Read as
    // absent, this row told an operator to re-pair while the row above it
    // correctly said the file was unreadable, and re-pairing is not what
    // repairs a file (ISS-1235, routed here).
    let stored = match cred_store::load_device_token() {
        Ok(stored) => stored,
        Err(e) => {
            println!(
                "✖ online       {} could not be read ({e}) — network checks skipped; repair that file rather than re-pairing",
                cred_store::credential_file_path().map_or_else(
                    |_| String::from("the credential store"),
                    |p| format!("the credential store `{}`", p.display()),
                )
            );
            return true;
        }
    };
    let (core_url, token) = match (ctx.resolve_core_url(cfg), stored) {
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

    failed |= heartbeat_row(&client, &core_url).await;

    // Assignment reconciliation: server view vs local bindings/paths.
    match tokio::time::timeout(ONLINE_TIMEOUT, runners::list_me(&client)).await {
        Ok(Ok(rows)) => {
            if rows.is_empty() {
                println!("• runners      not assigned to any project on the server");
            }
            let mut mcp_rows = spawn_mcp_rows(&client, &rows);
            for r in &rows {
                failed |= runner_path_row(r, cfg);

                if let Some(handle) = mcp_rows.remove(&r.project_id) {
                    failed |= print_mcp_row(&r.slug, handle.await.unwrap_or(None));
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

/// Heartbeat: 200 => token valid + core reachable; 401 => bad token/core_url. Returns `true` on failure.
async fn heartbeat_row(client: &CoreClient, core_url: &str) -> bool {
    let mut failed = false;
    match tokio::time::timeout(ONLINE_TIMEOUT, heartbeat::beat_verbose(client)).await {
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
    failed
}

/// The row for where one assigned project's checkout is. Returns `true` on failure.
fn runner_path_row(r: &runners::MeRunner, cfg: &Config) -> bool {
    let mut failed = false;
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
    failed
}

fn spawn_mcp_rows(
    client: &CoreClient,
    rows: &[runners::MeRunner],
) -> std::collections::HashMap<String, tokio::task::JoinHandle<Option<(Mark, String)>>> {
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

/// What a row's mark says about THIS BOX, which is not the same as what it says about the row.
///
/// Doctor's exit code is built from these, so a row reporting an observation nobody can act on
/// needs a third mark: folding it into the cross fails a box where nothing is wrong, and folding
/// it into the tick asserts a check that did not happen (ISS-1191).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mark {
    Ok,
    Note,
    Fail,
}

impl Mark {
    fn glyph(self) -> &'static str {
        match self {
            Mark::Ok => "✔",
            Mark::Note => "•",
            Mark::Fail => "✖",
        }
    }

    fn failed(self) -> bool {
        matches!(self, Mark::Fail)
    }
}

/// Print one project's MCP row, in the caller's order. `true` when it is a problem.
///
/// Every bound project owes a row, so `None` is no longer a project with nothing to declare — it
/// is the spawned read never handing one back, which is a cross naming itself rather than a blank
/// where a row was due (ISS-1191).
fn print_mcp_row(slug: &str, line: Option<(Mark, String)>) -> bool {
    let (mark, text) = line.unwrap_or_else(|| {
        (
            Mark::Fail,
            format!(
                "{slug}: the MCP read did not finish, so nothing here says what it would carry"
            ),
        )
    });
    println!("{} mcp          {}", mark.glyph(), text);
    mark.failed()
}

async fn mcp_servers_line(
    client: &CoreClient,
    project_id: &str,
    slug: &str,
) -> Option<(Mark, String)> {
    let found =
        match tokio::time::timeout(ONLINE_TIMEOUT, mcp_servers::fetch(client, project_id)).await {
            Ok(Ok(found)) => found,
            Ok(Err(e)) => {
                return Some((
                    Mark::Fail,
                    format!("{slug}: could not read the declared MCP servers: {e}"),
                ));
            }
            Err(_) => {
                return Some((
                    Mark::Fail,
                    format!(
                        "{slug}: timeout after {}s reading the declared MCP servers",
                        ONLINE_TIMEOUT.as_secs()
                    ),
                ));
            }
        };
    let path = runner_workspace::mcp::config::session_path(slug);
    let disk = session_file(&path, &found.mcp_servers);
    let (mark, line) = mcp_verdict(&found, &path, &disk, pane_state(slug).await);
    Some((mark, format!("{slug}: {line}")))
}

/// Whether a master pane for this project is resident on this box right now.
///
/// The precondition the file comparison below needs, and the one `report_stale_pane_config` in the
/// daemon's own sweep takes as given because it only ever runs with a pane in hand.
async fn pane_state(slug: &str) -> Pane {
    let name = terminal::session_name(terminal::MASTER_PREFIX, slug);
    if terminal::alive(&name).await {
        Pane::Resident
    } else {
        Pane::None
    }
}

/// Whether there is a pane on this box for the session file to be an answer ABOUT.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Pane {
    Resident,
    None,
}

/// What this box's session file holds against what core resolves.
///
/// `session_matches` answers one bool, and a file it cannot read answers the same as one that is
/// not there — which over an empty declaration reads as a tick nobody established. Doctor is the
/// surface making the claim, so it separates the states here rather than teaching the daemon's own
/// comparison a third one. `Unparseable` is separate from `Differs` for the same reason: a pane
/// started from a document nothing can parse carries no servers, which is not "something else".
enum SessionFile {
    Absent,
    /// A path no write can replace. `write_session` renames a temporary file onto it and
    /// `clear_session` removes it, and both fail on a directory however many panes are launched,
    /// so this is a failure with or without one — and `Unplaced::ServersUnwritable` means "no
    /// pane" can BE this condition rather than an innocent idle box.
    Obstructed(String),
    Unreadable(String),
    Unparseable,
    Matches,
    Differs,
}

/// Why a write could never place the session file at `path`, where it could not.
///
/// `write_session` creates the directory, writes a temporary file beside the target and renames it
/// over. None of that works where the target is itself a directory, or where the nearest existing
/// ancestor of it is not one — `create_dir_all` cannot make a directory under a regular file, and
/// `mcp_config_dir` ignores that failure. A box in either state starts no pane at all
/// (`Unplaced::ServersUnwritable`), so "no pane" can BE this condition, and reporting it as an
/// idle box promises a launch the servers it can never be handed (ISS-1191).
///
/// The target is read with `symlink_metadata` and the ancestors with `metadata`: a rename replaces
/// a symlink rather than what it points at, while a symlink to a directory is a perfectly good
/// parent. An ancestor that cannot be read at all is left alone rather than named, because a
/// failure nothing established is the shape this whole row was rewritten to stop printing.
fn write_obstruction(path: &std::path::Path) -> Option<String> {
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        return Some(String::from("it is a directory"));
    }
    let mut ancestor = path.parent();
    while let Some(dir) = ancestor {
        match std::fs::metadata(dir) {
            Ok(meta) if meta.is_dir() => return None,
            Ok(_) => return Some(format!("`{}` is not a directory", dir.display())),
            Err(_) => ancestor = dir.parent(),
        }
    }
    None
}

/// Classify the file at `path` — from the bytes THIS function read, never from a second read.
///
/// The master sweep rewrites that file on every pass for a live pane, so reading it here and
/// handing the path to `session_matches` to read again lets the two reads answer about two
/// different files (ISS-1191).
fn session_file(
    path: &std::path::Path,
    servers: &serde_json::Map<String, serde_json::Value>,
) -> SessionFile {
    // Asked before the read, because an obstruction reads as an error that looks like any other
    // and is the one this box cannot write its way out of.
    if let Some(why) = write_obstruction(path) {
        return SessionFile::Obstructed(why);
    }
    let bytes = match std::fs::read(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return SessionFile::Absent,
        Err(e) => return SessionFile::Unreadable(e.to_string()),
        Ok(bytes) => bytes,
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return SessionFile::Unreadable(String::from("it is not valid UTF-8"));
    };
    // A file that exists at all over a project declaring nothing is a mismatch, whatever it holds:
    // `write_session` deletes the file for an empty declaration rather than writing an empty one.
    if servers.is_empty() {
        return SessionFile::Differs;
    }
    match runner_workspace::mcp::config::session_servers(text) {
        None => SessionFile::Unparseable,
        Some(on_disk) if on_disk == *servers => SessionFile::Matches,
        Some(_) => SessionFile::Differs,
    }
}

/// One project's MCP row: what core resolves, and what this box's session file holds against it.
///
/// Every bound project gets a row. A project that declares nothing owes one too, so "declares
/// none" and "the row never ran" are not one observation (ISS-1191). The row names `path` because
/// the servers do not land in the checkout's `.mcp.json`, which is the row directly above this
/// one, and it reports what the file holds rather than asserting a write it did not perform.
///
/// `pane` is the precondition the comparison needs. `write_session` runs at exactly two points,
/// both of them inside the master sweep and both with a pane in hand: immediately before a pane
/// launches, and on the refresh for a pane already current. Nothing writes that file for a project
/// with no pane, so on a box just bound, a box with the daemon off, or a project with no claimable
/// work, the file's state is not a fact about any pane — and reading it as one turned every such
/// project into a `✖` and `exit(1)` on a box where nothing was wrong.
fn mcp_verdict(
    found: &mcp_servers::ProjectMcpServers,
    path: &std::path::Path,
    disk: &SessionFile,
    pane: Pane,
) -> (Mark, String) {
    let file = path.display();
    if let SessionFile::Obstructed(why) = disk {
        return (
            Mark::Fail,
            format!("{file} cannot be written: {why} — nothing this box does puts this project's MCP servers there, and no pane started here ever carries them"),
        );
    }
    if pane == Pane::None {
        return (Mark::Note, no_pane_line(found, path, disk));
    }
    if let SessionFile::Unreadable(why) = disk {
        return (
            Mark::Fail,
            format!("{file} cannot be read ({why}), so nothing here says what the pane resident on this box carries"),
        );
    }
    if let SessionFile::Unparseable = disk {
        return (
            Mark::Fail,
            format!("{file} is not a document this box wrote, so the pane resident on this box was handed no servers from it"),
        );
    }
    if found.is_empty() {
        return match disk {
            SessionFile::Absent => (
                Mark::Ok,
                format!("no MCP servers declared, and nothing is written at {file}"),
            ),
            _ => (
                Mark::Fail,
                format!(
                    "no MCP servers declared, but {file} still holds a config — the pane resident on this box carries servers this project no longer declares"
                ),
            ),
        };
    }
    match disk {
        SessionFile::Matches => (
            Mark::Ok,
            format!(
                "{} available, and {file} holds them",
                found.resolved_names.join(", ")
            ),
        ),
        SessionFile::Absent => (
            Mark::Fail,
            format!(
                "{} resolved by core, and nothing is written at {file} — the pane resident on this box carries none of them",
                found.resolved_names.join(", ")
            ),
        ),
        _ => (
            Mark::Fail,
            format!(
                "{} resolved by core, but {file} does not match them — the pane resident on this box carries something else",
                found.resolved_names.join(", ")
            ),
        ),
    }
}

/// The row for a project with no master pane on this box: what core resolves, where a pane started
/// here would be handed it, and what that file happens to hold — as an observation, because the
/// next launch rewrites it from core's answer at that moment and nothing here is a claim about a
/// pane (ISS-1191).
fn no_pane_line(
    found: &mcp_servers::ProjectMcpServers,
    path: &std::path::Path,
    disk: &SessionFile,
) -> String {
    let file = path.display();
    let holds = match disk {
        SessionFile::Absent => String::from("does not exist yet"),
        SessionFile::Obstructed(why) => format!("cannot be written: {why}"),
        SessionFile::Unreadable(why) => format!("cannot be read ({why})"),
        SessionFile::Unparseable => String::from("is not a document this box wrote"),
        SessionFile::Matches => String::from("already holds them"),
        SessionFile::Differs => String::from("holds something else"),
    };
    if found.is_empty() {
        return format!("no MCP servers declared, and no master pane here — {file} {holds}");
    }
    format!(
        "{} resolved by core, and no master pane here — a pane started now is handed them and {file} is rewritten from them; it {holds}",
        found.resolved_names.join(", ")
    )
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
