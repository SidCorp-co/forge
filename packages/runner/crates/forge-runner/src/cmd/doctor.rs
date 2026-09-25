use std::time::Duration;

use clap::Args as ClapArgs;
use forge_runner_core::auth::cred_store;
use forge_runner_core::config::Config;
use forge_runner_core::daemon::terminal;
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

    let credential_file = cred_store::credential_file_path().ok();
    let (row, token_failed) = access_token_row(&cred_store::load_pat(), credential_file.as_deref());
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
///
/// The unreadable row names `file` and the way out, because the job refusal a
/// person reads for the same condition names both and this row named neither —
/// an operator told only that something could not be read has nothing to open
/// (ISS-1235, routed here).
fn access_token_row(
    pat: &forge_runner_core::error::Result<Option<String>>,
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
    let path = forge_runner_core::mcp::config::session_path(slug);
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

/// Classify the file at `path` — from the bytes THIS function read, never from a second read.
///
/// The master sweep rewrites that file on every pass for a live pane, so reading it here and
/// handing the path to `session_matches` to read again lets the two reads answer about two
/// different files (ISS-1191).
fn session_file(
    path: &std::path::Path,
    servers: &serde_json::Map<String, serde_json::Value>,
) -> SessionFile {
    // Asked before the read, because a directory reads as an error that looks like any other and
    // is the one this box cannot write its way out of.
    if std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir()) {
        return SessionFile::Obstructed(String::from("it is a directory"));
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
    match forge_runner_core::mcp::config::session_servers(text) {
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
    // Core's own answer, which nothing on this box moves: a name this project declares and this
    // deployment cannot supply is a problem with or without a pane, so it is read before the
    // file is.
    if !found.dropped_names.is_empty() {
        return (
            Mark::Fail,
            format!(
                "declared but NOT available here: {} — a run on this project gets none of their tools{} (this box's copy: {file})",
                found.dropped_names.join(", "),
                if found.resolved_names.is_empty() {
                    String::new()
                } else {
                    format!(" (available: {})", found.resolved_names.join(", "))
                }
            ),
        );
    }
    if let SessionFile::Obstructed(why) = disk {
        return (
            Mark::Fail,
            format!("{file} cannot be written ({why}), so nothing this box does puts this project's MCP servers there — and no pane started here ever carries them"),
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
        SessionFile::Obstructed(why) => format!("cannot be written ({why})"),
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A box with no personal access token refuses every job it starts, so
    /// doctor fails on it, and says where a token comes from.
    #[test]
    fn a_box_with_no_access_token_fails_doctor_and_is_told_where_to_get_one() {
        let (row, failed) = access_token_row(&Ok(None), None);
        assert!(failed, "{row}");
        assert!(row.starts_with("✖ access token none"), "{row}");
        assert!(
            row.contains("every job this box starts is refused"),
            "{row}"
        );
        assert!(row.contains("Settings → API Tokens"), "{row}");
        assert!(row.contains("forge-runner login --pat <token>"), "{row}");
        assert!(
            access_token_row(&Ok(Some("  ".into())), None).1,
            "a blank token is none"
        );

        let (held, held_failed) = access_token_row(&Ok(Some("forge_pat_dev_op".into())), None);
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
        let (row, failed) = access_token_row(
            &Err(Error::Other("expected ident at line 1 column 2".into())),
            None,
        );
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

    /// ISS-1235, routed onto ISS-1191: the row named neither the file nor a way out, while the
    /// job refusal for the same condition names both. An operator told only that something could
    /// not be read has nothing to open and nothing to try.
    #[test]
    fn the_unreadable_store_row_names_the_file_and_the_way_out() {
        let (row, _) = access_token_row(
            &Err(Error::Other("expected ident at line 1 column 2".into())),
            Some(std::path::Path::new(
                "/home/o/.config/forge-runner/credentials.json",
            )),
        );
        assert!(
            row.contains("/home/o/.config/forge-runner/credentials.json"),
            "{row}"
        );
        assert!(row.contains("$FORGE_PAT"), "{row}");
        assert!(
            !row.contains("forge-runner login"),
            "re-pairing does not repair a file this box cannot parse: {row}"
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
        // ISS-1191: a project that declares nothing owes a row saying so, named after itself, so
        // an absent row cannot be read as an empty one.
        let quiet = slow_core(1, std::time::Duration::ZERO).await;
        let (mark, line) = mcp_servers_line(
            &CoreClient::new(quiet, String::from("tok")),
            "p-1",
            "slug-1",
        )
        .await
        .expect("a project that declares nothing still owes a row");
        // Which mark that row carries turns on this box's own session file and whether a master
        // pane is resident, which mcp_verdict's own tests settle deterministically; what is
        // asserted here is that a row came back at all, named after its project.
        let _ = mark;
        assert!(line.starts_with("slug-1:"), "{line}");
        assert!(line.contains("no MCP servers declared"), "{line}");

        // A project that owes one gets it BACK, with its own name inside the
        // text — the print loop places a line it cannot otherwise attribute.
        let noisy = slow_core_body(
            1,
            std::time::Duration::ZERO,
            r#"{"mcpServers":{},"resolvedNames":[],"droppedNames":["epodsystem"]}"#,
        )
        .await;
        let (mark, line) = mcp_servers_line(
            &CoreClient::new(noisy, String::from("tok")),
            "p-2",
            "butlocs",
        )
        .await
        .expect("a dropped server owes a row");
        assert!(
            mark.failed(),
            "a server this box cannot supply is not a pass: {line}"
        );
        assert!(
            line.starts_with("butlocs:"),
            "the row must name its own project, because the loop prints it verbatim: {line}"
        );
        assert!(line.contains("epodsystem"), "{line}");
        assert!(print_mcp_row("butlocs", Some((mark, line))));
    }

    /// ISS-1191 — a file this box cannot read is not evidence that it holds nothing. Over an empty
    /// declaration `session_matches` answers the same as an absent file, so doctor separates them
    /// rather than printing a tick nobody established.
    #[test]
    fn a_session_file_that_cannot_be_read_is_a_cross_even_where_nothing_is_declared() {
        let (mark, line) = mcp_verdict(
            &mcp_servers::ProjectMcpServers::default(),
            &a_path(),
            &SessionFile::Unreadable(String::from("it is not valid UTF-8")),
            Pane::Resident,
        );
        assert!(mark.failed(), "an unreadable file is not a pass: {line}");
        assert!(line.contains("cannot be read"), "{line}");
        assert!(line.contains("not valid UTF-8"), "{line}");
    }

    /// ISS-1191 — and a resolved set with no file at all is a cross saying so, rather than the
    /// mismatch sentence, because nothing there is not something else.
    #[test]
    fn a_resolved_set_with_no_session_file_says_nothing_is_written() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Absent,
            Pane::Resident,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("nothing is written"), "{line}");
    }

    /// ISS-1191 F1 — the same resolved set with no pane on this box is NOT a failure. Nothing
    /// writes that file for a project with no pane: `write_session` runs immediately before a
    /// launch, so a box just bound, a box with the daemon off, and a project with no claimable
    /// work all read FAIL over a pane that does not exist and a sentence that is false about the
    /// one that starts next.
    #[test]
    fn a_resolved_set_with_no_session_file_and_no_pane_is_an_observation_not_a_failure() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Absent,
            Pane::None,
        );
        assert!(
            !mark.failed(),
            "a box with no pane is not a box with a problem: {line}"
        );
        assert_eq!(mark, Mark::Note, "{line}");
        assert!(line.contains("no master pane here"), "{line}");
        assert!(line.contains("playwright"), "{line}");
    }

    /// ISS-1191, the second boundary: a session path this box cannot WRITE is a cross with no
    /// pane too, and the note would have promised the next pane the servers. `write_session`
    /// renames onto that path, a rename onto a directory fails every time, and the daemon counts
    /// an unwritable session file as a reason not to start a pane — so "no pane" can be this
    /// condition rather than an idle box.
    #[test]
    fn a_session_path_this_box_cannot_write_is_a_cross_with_no_pane_too() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Obstructed(String::from("it is a directory")),
            Pane::None,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("cannot be written"), "{line}");
        assert!(
            !line.contains("is rewritten from them"),
            "nothing rewrites a path the write cannot replace: {line}"
        );
    }

    /// ISS-1191 — and a directory at the session path is classified as that rather than as one
    /// more file this box could not read.
    #[test]
    fn a_directory_at_the_session_path_is_an_obstruction_and_not_a_read_error() {
        let dir = forge_runner_core::test_scratch::Scratch::new("doctor-session-dir");
        let path = dir.path().join("forge-master-mcp-mowment.json");
        std::fs::create_dir(&path).expect("a directory where the file belongs");
        let declared: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"playwright":{"type":"stdio"}}"#).expect("a server map");
        assert!(matches!(
            session_file(&path, &declared),
            SessionFile::Obstructed(_)
        ));
    }

    /// ISS-1191 F1, the boundary the fix must not swallow: what core could not supply is core's
    /// answer, and stays a cross with no pane on this box.
    #[test]
    fn a_declared_server_this_box_cannot_supply_is_a_cross_with_no_pane_too() {
        let (mark, line) = mcp_verdict(
            &found(&[], &["epodsystem"]),
            &a_path(),
            &SessionFile::Absent,
            Pane::None,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("epodsystem"), "{line}");
    }

    /// ISS-1191 F1 — and criterion 15 holds on that row: it still names the file, because naming
    /// where the servers land is the whole of what the row was widened for.
    #[test]
    fn the_no_pane_row_names_the_file_this_box_would_write() {
        let (_, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Absent,
            Pane::None,
        );
        assert!(line.contains("forge-master-mcp-mowment.json"), "{line}");
    }

    /// ISS-1191 criterion 14 holds with no pane too: a project declaring nothing still gets a row.
    #[test]
    fn a_project_that_declares_nothing_and_has_no_pane_still_gets_a_row_saying_so() {
        let (mark, line) = mcp_verdict(
            &mcp_servers::ProjectMcpServers::default(),
            &a_path(),
            &SessionFile::Absent,
            Pane::None,
        );
        assert!(!mark.failed(), "{line}");
        assert!(line.contains("no MCP servers declared"), "{line}");
    }

    /// ISS-1191 F3 — a file that parses as nothing is not a file holding something else. A pane
    /// started from it carries no servers at all, and the mismatch sentence says the opposite.
    #[test]
    fn a_session_file_that_parses_as_nothing_is_not_the_mismatch_sentence() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Unparseable,
            Pane::Resident,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("no servers from it"), "{line}");
        assert!(
            !line.contains("something else"),
            "an unparseable file holds nothing, not something else: {line}"
        );
    }

    /// ISS-1191 F3 — and the classification is made from the bytes the caller read, so a file
    /// rewritten between two reads cannot be judged by the one the caller never saw.
    #[test]
    fn the_session_file_is_classified_from_the_bytes_that_were_read() {
        let dir = forge_runner_core::test_scratch::Scratch::new("doctor-session-file");
        let path = dir.path().join("forge-master-mcp-mowment.json");
        let declared: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"playwright":{"type":"stdio"}}"#).expect("a server map");

        assert!(matches!(
            session_file(&path, &declared),
            SessionFile::Absent
        ));

        std::fs::write(&path, r#"{"mcpServers":{"playwright":{"type":"stdio"}}}"#)
            .expect("write the matching document");
        assert!(matches!(
            session_file(&path, &declared),
            SessionFile::Matches
        ));

        std::fs::write(&path, "not json at all").expect("write an unparseable document");
        assert!(matches!(
            session_file(&path, &declared),
            SessionFile::Unparseable
        ));

        std::fs::write(&path, r#"{"mcpServers":{"epodsystem":{"type":"http"}}}"#)
            .expect("write a different document");
        assert!(matches!(
            session_file(&path, &declared),
            SessionFile::Differs
        ));

        // A file at all, over a project that declares nothing: `write_session` deletes rather
        // than writing an empty document, so its presence is the mismatch.
        assert!(matches!(
            session_file(&path, &serde_json::Map::new()),
            SessionFile::Differs
        ));
    }

    /// ISS-1191 criterion 15 — the dropped-name branch is the diagnostic case, and it named no file
    /// at all while the rest of the row did.
    #[test]
    fn the_dropped_name_row_names_the_file_too() {
        let (_, line) = mcp_verdict(
            &found(&["playwright"], &["epodsystem"]),
            &a_path(),
            &SessionFile::Differs,
            Pane::Resident,
        );
        assert!(
            line.contains("forge-master-mcp-mowment.json"),
            "the diagnostic row must name the file as well: {line}"
        );
    }

    /// ISS-1191 — a read that never handed a row back is a cross naming the project, not a gap in
    /// the report where a row was due.
    #[test]
    fn a_row_that_never_arrived_is_a_cross_naming_its_project() {
        assert!(print_mcp_row("butlocs", None));
    }

    /// ISS-1235: a 404 is a read that did not happen, so the project owes a
    /// failing row rather than the silence of one that declares nothing.
    #[tokio::test]
    async fn a_404_from_the_declared_servers_route_is_a_failed_read_row() {
        let missing = core_answering(1, std::time::Duration::ZERO, "404 Not Found", "").await;
        let (mark, line) = mcp_servers_line(
            &CoreClient::new(missing, String::from("tok")),
            "p-3",
            "gone",
        )
        .await
        .expect("a 404 owes a row");
        assert!(mark.failed(), "{line}");
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

    /// The path the row names, for a test that asserts on its text.
    fn a_path() -> std::path::PathBuf {
        std::path::PathBuf::from("/home/o/.config/forge-runner/mcp/forge-master-mcp-mowment.json")
    }

    #[test]
    fn a_declared_server_this_box_cannot_supply_is_a_problem_and_is_named() {
        let (mark, line) = mcp_verdict(
            &found(&[], &["epodsystem"]),
            &a_path(),
            &SessionFile::Matches,
            Pane::Resident,
        );
        assert!(
            mark.failed(),
            "a server that cannot be supplied is not a pass: {line}"
        );
        assert!(line.contains("epodsystem"), "{line}");
        assert!(line.contains("NOT available"), "{line}");
    }

    /// Partly-supplied is still a problem, and the row says both halves so the
    /// operator can tell which work is possible here.
    #[test]
    fn a_project_with_one_server_supplied_and_one_not_reports_the_problem_and_both_names() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &["epodsystem"]),
            &a_path(),
            &SessionFile::Matches,
            Pane::Resident,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("epodsystem"), "{line}");
        assert!(line.contains("playwright"), "{line}");
    }

    #[test]
    fn a_project_whose_declarations_all_resolved_reads_as_a_pass_naming_them() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Matches,
            Pane::Resident,
        );
        assert!(mark == Mark::Ok, "{line}");
        assert!(line.contains("playwright"), "{line}");
    }

    /// ISS-1191 — the row reports the file rather than asserting a write it never performed: a
    /// resolved set the session file does not hold is a cross, not a tick naming a path.
    #[test]
    fn a_resolved_set_the_session_file_does_not_hold_is_a_cross() {
        let (mark, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Differs,
            Pane::Resident,
        );
        assert!(
            mark.failed(),
            "a file that does not match is not a pass: {line}"
        );
        assert!(line.contains("does not match"), "{line}");
    }

    /// ISS-1191 — and a project that declares nothing over a file that still holds a config is a
    /// cross too, because a pane started from it carries servers nobody declares any more.
    #[test]
    fn declaring_nothing_over_a_file_that_still_holds_a_config_is_a_cross() {
        let (mark, line) = mcp_verdict(
            &mcp_servers::ProjectMcpServers::default(),
            &a_path(),
            &SessionFile::Differs,
            Pane::Resident,
        );
        assert!(mark.failed(), "{line}");
        assert!(line.contains("still holds a config"), "{line}");
    }

    /// ISS-1191 criterion 15 — the row says where the servers land, because the `.mcp.json` row
    /// above it names a different file and reads as the whole answer.
    #[test]
    fn the_row_names_the_file_this_box_writes_those_servers_to() {
        let (_, line) = mcp_verdict(
            &found(&["playwright"], &[]),
            &a_path(),
            &SessionFile::Matches,
            Pane::Resident,
        );
        assert!(
            line.contains("forge-master-mcp-mowment.json"),
            "the row must name the file it is talking about: {line}"
        );
    }

    /// ISS-1191 criterion 14 — a project that declares nothing still reports, so an absent row
    /// cannot be read as an empty one.
    #[test]
    fn a_project_that_declares_nothing_still_gets_a_row_saying_so() {
        let (mark, line) = mcp_verdict(
            &mcp_servers::ProjectMcpServers::default(),
            &a_path(),
            &SessionFile::Absent,
            Pane::Resident,
        );
        assert!(mark == Mark::Ok, "{line}");
        assert!(line.contains("no MCP servers declared"), "{line}");
    }
}
