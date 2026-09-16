//! Build a temp MCP config file for a job run.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::auth::cred_store::load_pat;
use crate::error::{Error, Result};

/// Write `{ mcpServers: { forge: <http>, ...override } }` to a temp file and
/// return its path. The Forge server points at `<core>/mcp` and authenticates
/// with the BOX'S OWN agent credential + project slug header.
///
/// Core mints no per-job credential since ISS-932 wave 4, so there is exactly
/// one credential on the box and `load_pat` is the only source.
///
/// When the box holds none the `forge` entry is OMITTED and a warning names why.
/// The device token is deliberately NOT a fallback: `/mcp` refuses it (ISS-931),
/// so writing it would buy a 401 at the first tool call instead of an absent
/// server at startup, and the 401 arrives with no line naming the writer.
// cm:edge contract -> packages/core/src/middleware/require-pat.ts — `requirePat` accepts `forge_pat_*` and refuses every other bearer BY NAME; the refusal text tells a box reading it to install a newer forge-runner, and this function is what makes that upgrade the fix
// cm:guard NEVER fall back to `device_token` here. It authenticates `/ws` and the `requireDevice` REST routes and nothing on `/mcp`, and a config carrying it is indistinguishable at startup from a working one — `claude` connects, `tools/list` 401s, and the session reads it as a core outage.
// cm:guard the credential is resolved HERE and only here, through `cred_store::load_pat` — the same rule `write_persistent` carries below and for the same reason: that helper is the one place `$FORGE_PAT` and the stored credential are ordered, and a second resolution is how one path on a box starts honouring a different credential from another.
pub fn write(
    core_url: &str,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    write_in(
        &mcp_config_dir(),
        core_url,
        load_pat().ok().flatten().as_deref(),
        project_slug,
        job_id,
        override_servers,
    )
}

/// [`write`] with the directory named rather than resolved.
///
/// The seam exists for the tests. The file NAME is the property two of them
/// assert — it is stable, derived from slug and job id, never a uuid — so it
/// cannot be randomised to make a run independent of every other run on the
/// box. Isolation has to come from the directory instead: with a single shared
/// one, two `cargo test --workspace` runs write the same path and the loser
/// panics on a file the winner already unlinked, which reads as a defect in the
/// config writer rather than as two runs colliding (ISS-939).
// cm:guard tests pass a directory of their own; production passes `mcp_config_dir()` and nothing else. A test that reaches this through `write` is back on the shared path and will fail somebody else's run instead of its own.
// cm:guard `token` is a TEST SEAM and `write` is its only production caller, which passes what `load_pat` returned. Resolving it inside this function instead makes every test here depend on whether the machine happens to hold a credential — measured 2026-09-08: the suite passed on a dev box with a cred store and failed on CI without one, so the green said nothing about the code.
fn write_in(
    dir: &Path,
    core_url: &str,
    token: Option<&str>,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let token = token.map(str::to_string).filter(|t| !t.trim().is_empty());
    let mut servers = match token.as_deref() {
        Some(t) => serde_json::json!({
            "forge": {
                "type": "http",
                "url": mcp_url,
                "headers": {
                    "Authorization": format!("Bearer {t}"),
                    "X-Forge-Project-Slug": project_slug
                }
            }
        }),
        None => {
            tracing::warn!(
                job_id,
                "mcp config: this box holds no agent credential — omitting the `forge` MCP \
                 server. Tools that only exist there (forge_uploads, forge_step_start) will be \
                 absent for this job; run `forge-runner login` to pair the box."
            );
            serde_json::json!({})
        }
    };

    if let Some(extra) = override_servers {
        if let (Some(base), Some(extra)) = (servers.as_object_mut(), extra.as_object()) {
            for (name, cfg) in extra {
                // ISS-683 belt-and-suspenders: a non-object entry (e.g. a
                // catalog-shorthand `true` that failed to expand upstream)
                // is not a valid MCP server spec — writing it verbatim would
                // silently break that server's `claude --mcp-config` parse.
                // Skip and warn rather than propagate an invalid entry.
                if !cfg.is_object() {
                    tracing::warn!(
                        "mcp config: skipping non-object override entry for server={name} (expected an object spec)"
                    );
                    continue;
                }
                let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                if enabled {
                    base.insert(name.clone(), cfg.clone());
                }
            }
        }
    }

    let doc = serde_json::json!({ "mcpServers": servers });

    // The runner keeps all its state under `~/.config/forge-runner/` (credentials,
    // config, skills-cache); the per-job MCP config lives beside them in `mcp/`,
    // never as a UUID in the shared `/tmp` root.
    // cm:guard one file per JOB, not per slug, and the unlink at completion is why. A shared per-slug path was safe only while the repo-root lock serialised same-project spawns through `runner.start`; ISS-920 released that lock earlier on purpose, so a sibling's completion would unlink the path this job is about to hand `claude` — read back as `agent_startup_failed: MCP config file not found`.
    sweep_stale(dir);
    let path = dir.join(format!(
        "forge-mcp-{}-{}.json",
        sanitize_slug(project_slug),
        sanitize_slug(job_id)
    ));
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    // cm:guard write-then-rename, never a bare `fs::write`: that truncates first, so a reader opening the path mid-write gets a partial document and `claude` reports an invalid MCP config with nothing naming the writer. UNTESTED and untestable in this suite — the difference is only visible to a concurrent reader, and a test that races is a test that lies either way. It is here on the argument, not on a green.
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(path)
}

/// Age past which a PER-JOB MCP config left behind by a crashed daemon is removed.
const MCP_CONFIG_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

/// The `forge-master-mcp-` prefix, which is what tells a per-PROJECT session
/// config apart from a per-job one in the shared directory.
const SESSION_PREFIX: &str = "forge-master-mcp-";

/// Drop MCP configs no live job can own.
// cm:guard the per-job path costs this sweep, and the sweep is the whole reason a per-job path is affordable: every spawn unlinks its own file at completion and on a spawn failure, so anything left is a daemon that died between the two, and without this the folder grows one token-bearing 0600 file per crash forever. Since ISS-931 the token in there is the JOB's, revoked when the job ends, so a leaked file ages out of usefulness as well as off disk — the sweep is still what keeps the disk bounded. 24h is NOT slack over the longest live job — `timeoutSeconds` reaches exactly 86_400 and a parked duplex session adds its residency on top. It is safe because `claude` reads `--mcp-config` at startup only, so unlinking under a running session costs nothing; a future that re-reads it makes this number wrong.
fn sweep_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        // cm:guard an AGE is the wrong question to ask a session file and this sweep must never ask it. A per-job file's age answers whether its job can still be alive; a master's answers nothing, because a live master stops rewriting its file for as long as core is unreachable. Sweeping one on any age — a day, a week — deletes a live pane's record, after which `session_matches` reads a correctly configured master as stale and prints `tmux kill-session` at an operator. The price is that a project unbound from this box leaves one 0600 file behind: `write_session` removes it the moment that project resolves no servers, and nothing else here can know the project is gone.
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(SESSION_PREFIX)
        {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().is_ok_and(|age| age > MCP_CONFIG_MAX_AGE))
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Dedicated folder for the runner's per-job MCP configs:
/// `~/.config/forge-runner/mcp/`. Falls back to `<tmp>/forge-runner/mcp/` only
/// when no config dir is resolvable. Created on demand; best-effort `0700`.
/// Where the session configs live, for a message that names the path an
/// operator has to make writable.
pub fn session_dir() -> PathBuf {
    mcp_config_dir()
}

fn mcp_config_dir() -> PathBuf {
    let base = dirs_next::config_dir()
        .map(|d| d.join("forge-runner"))
        .unwrap_or_else(|| std::env::temp_dir().join("forge-runner"));
    let dir = base.join("mcp");
    let _ = std::fs::create_dir_all(&dir);
    restrict_dir_perms(&dir);
    dir
}

/// The MCP config a resident master's pane is started with: the servers its
/// project declares, resolved by core, for the whole life of that session.
///
/// Returns the path to hand `claude --mcp-config`, or `None` when the project
/// resolved no servers — in which case any file left from a previous session is
/// REMOVED rather than left to configure a project that no longer declares it.
///
/// Distinct from [`write`], which is one job's temp config, and from
/// [`write_persistent`], which writes only `forge` into the checkout. This one
/// carries rendered integration credentials, so it never goes near the checkout.
// cm:guard one file per PROJECT, and the prefix is what keeps it off the per-job path: `forge-mcp-<slug>-<job>.json` and `forge-master-mcp-<slug>.json` share a folder, and a project slugged `session` would otherwise collide with a job of another project. One per project is safe because one master per project is the bound `daemon::master` already enforces.
// cm:guard the write is UNCONDITIONAL even when the bytes are unchanged, because the mtime is what keeps this file out of `sweep_stale`. A master runs for days and the sweep drops anything older than 24h; a version that skipped an identical write would delete a live master's config out from under the next comparison and report every project on the box as mis-configured.
pub fn write_session(
    slug: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    write_session_in(&mcp_config_dir(), slug, servers)
}

/// [`write_session`] with the directory named rather than resolved — the same
/// test seam, and for the same reason, as [`write_in`].
// cm:guard tests pass a directory of their own; production passes `mcp_config_dir()` and nothing else.
fn write_session_in(
    dir: &Path,
    slug: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    let path = session_path_in(dir, slug);
    if servers.is_empty() {
        // cm:guard `Ok(None)` means "this pane was given nothing AND nothing on
        // disk says otherwise". A discarded removal makes it mean only the
        // first, and the caller cannot tell the difference.
        clear_session_in(dir, slug)?;
        return Ok(None);
    }
    let doc = serde_json::json!({ "mcpServers": Value::Object(servers.clone()) });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    // cm:guard write-then-rename, never a bare `fs::write` — the same reason `write_in` carries: a truncating write is a partial document to anything reading the path mid-write.
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(Some(path))
}

/// Remove every session config belonging to a project this box no longer
/// serves, whatever its age.
///
/// `active_slugs` must be the AUTHORITATIVE set — the assignment listing core
/// answered with. `sweep_stale` deliberately never touches these files, because
/// a live master stops rewriting its own for as long as core is unreachable and
/// an mtime therefore says nothing about whether a pane is using it. Which
/// projects this box serves does say so, and it is the only thing that does.
// cm:guard NEVER call this with a guessed, partial or defaulted set. Every name missing from it is read as a project this box has stopped serving, so one empty listing accepted as authoritative deletes the config of every live master on the box at once — and a pane cannot be told a new one, so each would run without its servers until an operator ended it.
/// `Ok` carries the orphans it could NOT remove, as `(path, why)`. `Err` means
/// the directory could not be read at all, so nothing was even attempted.
pub fn sweep_orphaned_sessions(active_slugs: &[String]) -> Result<Vec<(PathBuf, String)>> {
    sweep_orphaned_sessions_in(&mcp_config_dir(), active_slugs)
}

// cm:guard a removal that failed is RETURNED, not discarded. These files hold rendered integration credentials for a project this box has stopped serving; a sweep that cannot delete one and says nothing is a deprovisioning that reports itself complete, and there is no second reader — nothing else ever looks at this namespace again once the project is gone from the listing.
// cm:guard a directory that could not be READ is an `Err`, never an empty `Ok`. This is the only sweep that ever visits the session namespace, so "I found no orphans" and "I could not look" have the same consequence on disk and opposite meanings to an operator deprovisioning a project — and the first one is what a discarded `read_dir` reports.
fn sweep_orphaned_sessions_in(
    dir: &Path,
    active_slugs: &[String],
) -> Result<Vec<(PathBuf, String)>> {
    let keep: std::collections::HashSet<String> =
        active_slugs.iter().map(|s| sanitize_slug(s)).collect();
    let mut left = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        // A directory that is not there holds no orphans, which is the state a
        // box that has never written one is in.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(left),
        Err(e) => return Err(Error::Io(e)),
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(SESSION_PREFIX) else {
            continue;
        };
        let Some(slug) = rest.strip_suffix(".json") else {
            continue;
        };
        if keep.contains(slug) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(entry.path()) {
            left.push((entry.path(), e.to_string()));
        }
    }
    Ok(left)
}

/// Forget what this project's master was given: no file, so the next
/// comparison reads a pane that carries nothing, which is the truth whenever
/// the pane was started without `--mcp-config`.
///
/// Called where [`write_session`] FAILED and the pane started anyway.
// cm:guard the file and the flag are one fact and must never disagree. The file is read back by `session_matches` as "what this pane was given"; leaving a file the pane never received makes a later identical declaration read as a MATCH, and the stale-pane report that criterion 5 exists for goes silent for the whole life of that pane.
pub fn clear_session(slug: &str) -> Result<()> {
    clear_session_in(&mcp_config_dir(), slug)
}

/// [`clear_session`] with the directory named rather than resolved — the same
/// test seam, and for the same reason, as [`write_session_in`].
// cm:guard a removal that FAILED is an error and not a discarded `let _`. The caller starts the pane either way — refusing to start a master over its config directory would take out every project on a box that went read-only, including the ones declaring no servers — but it is the only party that can say the record is now untrustworthy, and it cannot say what it was not told. A file left behind here makes the next identical declaration read as a match and silences criterion 5's report for the life of that pane.
fn clear_session_in(dir: &Path, slug: &str) -> Result<()> {
    match std::fs::remove_file(session_path_in(dir, slug)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Io(e)),
    }
}

/// What [`write_session`] would write for these servers, as the bytes on disk.
///
/// The comparison a sweep makes against a LIVE pane: a pane carries the MCP
/// configuration it was started with and cannot be told a new one, so the only
/// question worth asking is whether the file it was given still says what core
/// says now.
pub fn session_matches(slug: &str, servers: &serde_json::Map<String, Value>) -> bool {
    session_matches_in(&mcp_config_dir(), slug, servers)
}

fn session_matches_in(dir: &Path, slug: &str, servers: &serde_json::Map<String, Value>) -> bool {
    let path = session_path_in(dir, slug);
    let on_disk = std::fs::read_to_string(&path).ok();
    match (on_disk, servers.is_empty()) {
        // No file and nothing to declare: a pane started with no `--mcp-config`
        // is exactly what this project asks for.
        (None, true) => true,
        (None, false) => false,
        (Some(_), true) => false,
        (Some(text), false) => {
            serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|doc| doc.get("mcpServers").cloned())
                == Some(Value::Object(servers.clone()))
        }
    }
}

fn session_path_in(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("forge-master-mcp-{}.json", sanitize_slug(slug)))
}

/// Sanitize a project slug into a filesystem-safe token. Non `[A-Za-z0-9_-]`
/// chars become `-`; an empty / all-stripped slug falls back to `default`, so
/// the runner still resolves to a single stable path.
fn sanitize_slug(slug: &str) -> String {
    let cleaned: String = slug
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Restrict the MCP folder to owner-only (`0700`). Best-effort; no-op on non-unix.
#[cfg(unix)]
fn restrict_dir_perms(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_dir_perms(_dir: &Path) {}

/// Write `body` to `path` as a file that is owner-only (`0600`) from the moment
/// it exists, and refuse rather than publish one that is not.
///
/// Every file this module writes carries a bearer token or a rendered
/// integration credential.
// cm:guard the mode goes on at OPEN, not after the bytes. `fs::write` creates at `0666 & !umask` and fills it, so a tightening afterwards leaves a window in which the credential is on disk world-readable — and a `set_permissions` that simply failed left it that way for good, silently, because the result was discarded.
// cm:guard a mode that cannot be established is an ERROR and the file is removed. This is a behaviour change on the per-job path too: a filesystem that does not honour modes used to get a spawn carrying a readable token, and now gets a refusal naming the path. That is the intended direction — the alternative is a live credential readable by every account on the box, reported by nothing.
#[cfg(unix)]
fn write_owner_only(path: &Path, body: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    write_owner_only_checked(path, body, |f| {
        Ok(f.metadata()?.permissions().mode() & 0o777)
    })
}

/// [`write_owner_only`] with the mode reading named rather than performed.
///
/// The seam exists because on every filesystem this repo's tests can create,
/// `create_new` + `mode(0o600)` always yields `0600` — so the branch that
/// refuses a file whose mode did not take is unreachable from a real write, and
/// an unreachable branch is one nothing has ever proved.
#[cfg(unix)]
fn write_owner_only_checked(
    path: &Path,
    body: &str,
    mode_of: impl Fn(&std::fs::File) -> Result<u32>,
) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    // cm:guard `create_new`, never `create(true)`. `mode()` applies only to a file this call CREATES, so a `.tmp.<pid>` left at 0644 by a crash whose pid was reused would be truncated, filled with a live credential and only then checked — which is the readable-credential window this function exists to close. Removing first and refusing a racing creator is what makes the mode an assertion rather than a wish.
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    // cm:guard check the mode BEFORE the first credential byte. A filesystem
    // that accepts the open and emulates permissions gives a file that is not
    // 0600; writing first and checking after puts the secret on disk readable
    // for the width of the write, which is the window this function exists to
    // close — and removing it afterwards does not unread it.
    let mode = mode_of(&f)?;
    if mode != 0o600 {
        drop(f);
        let _ = std::fs::remove_file(path);
        return Err(Error::Other(format!(
            "{}: could not be made owner-only (mode {mode:o}) and it is about to carry a credential — not written",
            path.display()
        )));
    }
    if let Err(e) = f.write_all(body.as_bytes()).and_then(|()| f.sync_all()) {
        drop(f);
        let _ = std::fs::remove_file(path);
        return Err(Error::Io(e));
    }
    Ok(())
}
#[cfg(not(unix))]
fn write_owner_only(path: &Path, body: &str) -> Result<()> {
    std::fs::write(path, body)?;
    Ok(())
}

/// Write a persistent `<repo>/.mcp.json` wiring the project's Forge MCP server
/// so a human running `claude` in the provisioned folder can talk to Forge out
/// of the box. Distinct from [`write`], which is the per-job temp config (it
/// also merges integration overrides with fresh tokens).
///
/// Authed by the OPERATOR'S PAT — the credential a human can actually hold —
/// and never by the box's device token, which `/mcp` refuses (ISS-931), nor by
/// a machine-minted job token, which belongs to one job and is revoked when it
/// ends. With no stored PAT the `forge` entry is left ALONE rather than written
/// with something that cannot work: whatever is already in the file (possibly a
/// working hand-written entry) survives, and the warning names the fix.
///
/// READ-MERGE, not overwrite: any servers a human (or another tool) added to an
/// existing `.mcp.json` are preserved; only the `forge` entry is upserted
/// (overridden on key collision). A missing/empty file is created fresh; a file
/// that exists but isn't valid JSON / isn't an object is left untouched and an
/// error is returned, so we never clobber a user's hand-written config.
///
/// The file carries a bearer token, so we add it to `.git/info/exclude` (NOT
/// the tracked `.gitignore`) to guarantee it's never committed. Idempotent.
// cm:guard read the PAT through `cred_store::load_pat`, never take a token as a parameter. That helper is the ONE place `$FORGE_PAT` and the stored credential are resolved in one order (see its own guard), and a parameter here is how the provisioned folder would start honouring a different credential from `forge-runner api` on the same box.
pub fn write_persistent(repo_path: &Path, core_url: &str, project_slug: &str) -> Result<()> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let Some(pat) = load_pat().ok().flatten() else {
        tracing::warn!(
            project_slug,
            "mcp config: no stored PAT — leaving the `forge` entry in the provisioned \
             .mcp.json alone. Run `forge-runner login --pat <token>` so a human running \
             `claude` in this folder reaches Forge."
        );
        return Ok(());
    };
    let forge_server = serde_json::json!({
        "type": "http",
        "url": mcp_url,
        "headers": {
            "Authorization": format!("Bearer {pat}"),
            "X-Forge-Project-Slug": project_slug
        }
    });

    let path = repo_path.join(".mcp.json");

    // Start from the existing doc when present so other servers survive. A
    // malformed existing file is a refuse-to-clobber situation, not a reset.
    let mut doc = match std::fs::read_to_string(&path) {
        Ok(existing) if !existing.trim().is_empty() => {
            serde_json::from_str::<Value>(&existing).map_err(|e| {
                Error::Other(format!(
                    ".mcp.json exists but is not valid JSON ({e}); refusing to overwrite — fix or remove it, then re-provision"
                ))
            })?
        }
        _ => serde_json::json!({}),
    };
    let root = doc.as_object_mut().ok_or_else(|| {
        Error::Other(".mcp.json top-level value is not an object; refusing to overwrite".into())
    })?;

    // Ensure `mcpServers` is an object, then upsert `forge` (override on collision).
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers
        .as_object_mut()
        .expect("mcpServers coerced to object above")
        .insert("forge".to_string(), forge_server);

    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    std::fs::write(&path, body)?;
    ensure_git_excluded(repo_path, ".mcp.json");
    Ok(())
}

/// Append `entry` to `<repo>/.git/info/exclude` if not already present. Touches
/// only the local-untracked excludes, never the repo's committed `.gitignore`.
fn ensure_git_excluded(repo_path: &Path, entry: &str) {
    let info = repo_path.join(".git").join("info");
    if std::fs::create_dir_all(&info).is_err() {
        return; // not a git repo (or no perms) — best-effort
    }
    let exclude = info.join("exclude");
    let current = std::fs::read_to_string(&exclude).unwrap_or_default();
    if current.lines().any(|l| l.trim() == entry) {
        return;
    }
    let sep = if current.is_empty() || current.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    let _ = std::fs::write(&exclude, format!("{current}{sep}{entry}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::cred_store::ScopedVar;

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("forge-mcp-persist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A config directory belonging to this process alone.
    // cm:guard every test that writes a per-job config takes one of these and calls `write_in`. The path `write` resolves is `~/.config/forge-runner/mcp/`, shared by every run on the box AND by the operator's own daemon, so a test on it deletes a sibling run's file — measured 2026-09-06 as `write_uses_a_stable_named_path_not_a_uuid ... FAILED` under two concurrent `cargo test --workspace` runs, 311 passed serially (ISS-939). The pid is the isolation; the file name inside stays stable, which is the property these tests are for.
    fn tmp_mcp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-mcp-cfg-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_doc(repo: &Path) -> Value {
        let s = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    /// The provisioned folder is for a human, and the box's device token is not
    /// a credential a human holds — `/mcp` refuses it outright (ISS-931). With
    /// no operator PAT the existing entry is left alone rather than replaced by
    /// something that answers 401.

    #[test]
    fn sanitizes_slug_to_fs_safe_token() {
        assert_eq!(
            sanitize_slug("home-kieutrung-anhome"),
            "home-kieutrung-anhome"
        );
        assert_eq!(sanitize_slug("a/b c.d"), "a-b-c-d");
        assert_eq!(sanitize_slug(""), "default");
        assert_eq!(sanitize_slug("///"), "default");
    }

    #[test]
    fn write_uses_a_stable_named_path_not_a_uuid() {
        let slug = "forge-test-stable-slug-xyz";
        let dir = tmp_mcp_dir("stable");
        let p1 = write_in(
            &dir,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            slug,
            "job-a",
            None,
        )
        .unwrap();
        let p2 = write_in(
            &dir,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            slug,
            "job-a",
            None,
        )
        .unwrap();
        assert_eq!(p1, p2, "the same job must resolve to the same path");
        assert_eq!(
            p1.file_name().unwrap().to_str().unwrap(),
            "forge-mcp-forge-test-stable-slug-xyz-job-a.json"
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&p1).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_file(&p1);
    }

    /// The file name is stable and the directory is not, which is the whole of
    /// ISS-939: two `cargo test --workspace` runs on one box must not resolve to
    /// the same path, while the name inside each run stays derived from the slug
    /// and job id rather than randomised.
    // cm:guard assert BOTH halves in one test. Asserting only the stable name leaves a suite that passes while every run shares a path; asserting only that the paths differ would pass against the uuid naming this file exists to refuse.
    #[test]
    fn the_directory_isolates_runs_and_the_file_name_stays_stable() {
        let one = tmp_mcp_dir("iso-one");
        let two = tmp_mcp_dir("iso-two").join("second");
        std::fs::create_dir_all(&two).unwrap();

        let a = write_in(
            &one,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            "iso",
            "job-a",
            None,
        )
        .unwrap();
        let b = write_in(
            &two,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            "iso",
            "job-a",
            None,
        )
        .unwrap();

        assert_ne!(a, b, "two runs must not write the same path");
        assert_eq!(a.file_name(), b.file_name());
        assert_eq!(
            a.file_name().unwrap().to_str().unwrap(),
            "forge-mcp-iso-job-a.json"
        );

        std::fs::remove_file(&a).unwrap();
        assert!(
            b.exists(),
            "one run's cleanup must not unlink another run's file"
        );
        let _ = std::fs::remove_dir_all(&one);
        let _ = std::fs::remove_dir_all(&two);
    }

    /// Two jobs on one project overlap inside `runner.start` since ISS-920, and
    /// each unlinks its config when it finishes. A shared path would let the
    /// first one home delete the file the second is about to hand `claude`.
    #[test]
    fn two_jobs_on_one_project_do_not_share_a_config_file() {
        let slug = "forge-test-two-jobs";
        let dir = tmp_mcp_dir("two-jobs");
        let a = write_in(
            &dir,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            slug,
            "job-a",
            None,
        )
        .unwrap();
        let b = write_in(
            &dir,
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            slug,
            "job-b",
            None,
        )
        .unwrap();
        assert_ne!(a, b);
        let _ = std::fs::remove_file(&a);
        assert!(
            b.exists(),
            "one job's completion must not unlink another job's config"
        );
        let _ = std::fs::remove_file(&b);
    }

    #[test]
    fn skips_non_object_override_entry() {
        // ISS-683 — a boolean override entry (e.g. an unexpanded catalog
        // shorthand) must never be written verbatim; a valid sibling entry
        // still comes through.
        let overrides = serde_json::json!({
            "chrome-devtools-mcp": true,
            "playwright": { "type": "stdio", "command": "npx" },
        });
        let path = write_in(
            &tmp_mcp_dir("skip-non-object"),
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            "skip-non-object-slug",
            "job-skip",
            Some(&overrides),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(doc["mcpServers"]["chrome-devtools-mcp"].is_null());
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_file(&path);
    }

    /// ONE test for everything that reads the credential store, because the
    /// store resolves process-wide env and cargo runs tests in threads — the
    /// same reason `auth/cred_store.rs` states above its own single case. The
    /// lock is shared with that module; the cases below are ordered, not
    /// independent.
    // cm:guard hold `ENV_TEST_LOCK` for the WHOLE body and never split these into separate `#[test]`s. `load_pat` reads `$FORGE_PAT` first, so two tests setting it are two tests reading each other's value — measured as four simultaneous failures the first time they were written apart (ISS-931).
    #[test]
    fn credential_store_paths() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // cm:guard RAII, so a panic below does not hand the next test in this
        // process a config dir that is not the box's own (ISS-1044).
        let pat = ScopedVar::set("FORGE_PAT", "forge_pat_dev_operator");

        // -- the provisioned folder is authed by the operator's PAT --
        let repo = tmp_repo("fresh");
        write_persistent(&repo, "https://core.example/", "proj").unwrap();
        let forge = read_doc(&repo)["mcpServers"]["forge"].clone();
        assert_eq!(forge["type"], "http");
        assert_eq!(forge["url"], "https://core.example/mcp");
        assert_eq!(
            forge["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        assert_eq!(forge["headers"]["X-Forge-Project-Slug"], "proj");
        let _ = std::fs::remove_dir_all(&repo);

        // cm:guard assert the header VALUE, not merely that a `forge` entry exists. The entry existed before ISS-932 wave 4 too, carrying first the device token and then a per-job one; a presence-only assertion stays green against exactly the config `requirePat` refuses. That the value comes from the STORE is `write`'s own single line, covered by the provisioned-folder case above rather than here — this case owns what the per-job file carries once a credential is resolved.
        let path = write_in(
            &tmp_mcp_dir("box-cred"),
            "https://core.example",
            Some("forge_pat_dev_boxcred"),
            "box-cred-slug",
            "job-tok",
            None,
        )
        .unwrap();
        let per_job: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            per_job["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_boxcred"
        );
        let _ = std::fs::remove_file(&path);

        // -- read-merge: a human's other servers survive --
        let repo = tmp_repo("merge");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"playwright":{"type":"stdio","command":"npx"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "proj").unwrap();
        let doc = read_doc(&repo);
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_dir_all(&repo);

        // -- an existing `forge` entry is replaced, siblings are not --
        let repo = tmp_repo("override");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://stale/mcp"},"other":{"x":1}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://fresh.example", "proj2").unwrap();
        let doc = read_doc(&repo);
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://fresh.example/mcp"
        );
        assert_eq!(doc["mcpServers"]["other"]["x"], 1);
        let _ = std::fs::remove_dir_all(&repo);

        // -- a malformed file is never clobbered --
        let repo = tmp_repo("malformed");
        std::fs::write(repo.join(".mcp.json"), "{ not json").unwrap();
        let err = write_persistent(&repo, "https://core.example", "proj").unwrap_err();
        assert!(format!("{err}").contains("not valid JSON"));
        assert_eq!(
            std::fs::read_to_string(repo.join(".mcp.json")).unwrap(),
            "{ not json"
        );
        let _ = std::fs::remove_dir_all(&repo);

        // cm:guard a blank credential is the shape a malformed store yields, and it must be treated as ABSENT rather than written as `Bearer ` — there is no second source to fall back to since ISS-932 wave 4, so an empty string here would produce a config that authenticates as nobody and 401s at the first tool call.
        let path = write_in(
            &tmp_mcp_dir("blank"),
            "https://core.example",
            Some("   "),
            "blank-slug",
            "job-blank",
            None,
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(doc["mcpServers"]["forge"].is_null());
        let _ = std::fs::remove_file(&path);

        // -- with NO credential at all the `forge` server is ABSENT and the
        //    sibling overrides still come through. Writing an unusable bearer
        //    would buy a 401 at the first tool call with nothing naming the
        //    writer; the provisioned folder likewise keeps whatever was there.
        pat.move_to("");
        let _store = ScopedVar::set("FORGE_RUNNER_CRED_STORE", "file");
        let empty = std::env::temp_dir().join(format!("forge-mcp-nocred-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&empty);
        std::fs::create_dir_all(&empty).unwrap();
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &empty);

        let overrides = serde_json::json!({
            "playwright": { "type": "stdio", "command": "npx" },
        });
        let path = write_in(
            &tmp_mcp_dir("no-cred"),
            "https://core.example",
            None,
            "no-cred-slug",
            "job-nocred",
            Some(&overrides),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert!(doc["mcpServers"]["forge"].is_null());
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_file(&path);

        let repo = tmp_repo("no-pat");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://hand-written/mcp"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "proj").unwrap();
        assert_eq!(
            read_doc(&repo)["mcpServers"]["forge"]["url"],
            "https://hand-written/mcp"
        );
        let _ = std::fs::remove_dir_all(&repo);

        let _ = std::fs::remove_dir_all(&empty);
    }

    fn servers(pairs: &[(&str, &str)]) -> serde_json::Map<String, Value> {
        pairs
            .iter()
            .map(|(name, command)| {
                (
                    (*name).to_string(),
                    serde_json::json!({ "type": "stdio", "command": command }),
                )
            })
            .collect()
    }

    /// Criterion 9. The file carries rendered integration credentials, so the
    /// mode and the location are the whole of what keeps them off a shared box.
    // cm:guard assert the MODE, not just that a file exists. `write_owner_only` is what makes it 0600 and it refuses rather than publishing a file it could not tighten; without this assertion a version that went back to writing at the umask and hoping would leave a world-readable file holding a live epodsystem key, and every other assertion in this module would still pass.
    #[test]
    fn the_session_file_is_owner_only_and_lands_only_in_the_directory_it_was_given() {
        let dir = tmp_mcp_dir("session-perms");
        let path = write_session_in(&dir, "mowment", &servers(&[("playwright", "npx")]))
            .unwrap()
            .expect("servers were declared, so a path is owed");

        assert_eq!(
            path.file_name().unwrap().to_str().unwrap(),
            "forge-master-mcp-mowment.json"
        );
        assert_eq!(path.parent().unwrap(), dir.as_path());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "the file carries credentials: {mode:o}");
        }

        // and to nowhere else: the rename leaves no `.tmp.<pid>` behind either.
        let left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["forge-master-mcp-mowment.json".to_string()]);

        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Criterion 10, first half. The write is unconditional, which is what keeps
    /// the mtime ahead of `sweep_stale` for a master that runs for days.
    // cm:guard the MTIME is the assertion, because the mtime is the property: `sweep_stale` drops anything older than 24h and a master runs for weeks. Backdating the file past that window and requiring the next write to move it forward is what a skip cannot survive — a content check alone passes against any version that decides by comparing the declaration it last wrote rather than the bytes on disk, and that is the cheaper way to write the skip.
    #[test]
    fn an_unchanged_declaration_still_rewrites_the_file_at_each_start() {
        let dir = tmp_mcp_dir("session-rewrite");
        let decl = servers(&[("playwright", "npx")]);
        let path = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();

        // Older than `MCP_CONFIG_MAX_AGE`: the next sweep would delete this file
        // out from under a live master unless the start rewrote it.
        let stale = std::time::SystemTime::now()
            - (MCP_CONFIG_MAX_AGE + std::time::Duration::from_secs(3600));
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_accessed(stale)
                    .set_modified(stale),
            )
            .unwrap();
        assert!(
            std::fs::metadata(&path).unwrap().modified().unwrap()
                < std::time::SystemTime::now() - MCP_CONFIG_MAX_AGE,
            "the backdating must actually have taken, or this test asserts nothing"
        );

        let again = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        assert_eq!(again, path, "one file per project, at a stable name");
        assert!(
            std::fs::metadata(&path).unwrap().modified().unwrap()
                > std::time::SystemTime::now() - MCP_CONFIG_MAX_AGE,
            "an unchanged declaration must still move the mtime, or `sweep_stale` deletes a live master's config"
        );

        // and the bytes are the declaration, not whatever was there before.
        std::fs::write(&path, "{ not json at all").unwrap();
        write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Criterion 10, second half. A project that stops declaring servers must
    /// not keep configuring its master from a file nothing rewrites.
    // cm:guard the REMOVAL is the assertion. Returning `None` while leaving the file is the silent half: `pane_argv` would drop the flag, the next `session_matches` would read the stale file, find no match and report every such project as a mis-configured pane forever.
    #[test]
    fn a_project_that_resolves_no_servers_has_its_file_removed_and_owed_no_path() {
        let dir = tmp_mcp_dir("session-empty");
        let path = write_session_in(&dir, "mowment", &servers(&[("playwright", "npx")]))
            .unwrap()
            .unwrap();
        assert!(path.exists());

        let gone = write_session_in(&dir, "mowment", &serde_json::Map::new()).unwrap();
        assert!(gone.is_none(), "no servers means no `--mcp-config` flag");
        assert!(!path.exists(), "the file it would have named must be gone");

        // and removing one that was never there is not an error.
        assert!(write_session_in(&dir, "never", &serde_json::Map::new())
            .unwrap()
            .is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F2. The per-job age sweep must not reach a master's file at all.
    // cm:guard the JOB file in the same directory must still go at 24h, or this test passes against a sweep that was simply switched off. Both halves are the assertion, and so is the third: the master path still removes the file, so excluding it from the sweep is not a leak with no other route off disk.
    #[test]
    fn the_job_sweep_never_reaches_a_session_file_whatever_its_age() {
        let dir = tmp_mcp_dir("sweep-two-clocks");
        let session = write_session_in(&dir, "mowment", &servers(&[("playwright", "npx")]))
            .unwrap()
            .unwrap();
        let job = dir.join("forge-mcp-mowment-job7.json");
        std::fs::write(&job, "{}").unwrap();

        // Both older than the per-job age, neither older than the session age.
        let two_days = std::time::SystemTime::now()
            - (MCP_CONFIG_MAX_AGE + std::time::Duration::from_secs(24 * 60 * 60));
        for f in [&session, &job] {
            std::fs::File::options()
                .write(true)
                .open(f)
                .unwrap()
                .set_times(
                    std::fs::FileTimes::new()
                        .set_accessed(two_days)
                        .set_modified(two_days),
                )
                .unwrap();
        }

        sweep_stale(&dir);
        assert!(!job.exists(), "a two-day-old per-job config is still swept");
        assert!(
            session.exists(),
            "a live master stops rewriting its file whenever core is unreachable; sweeping it on any age prints `tmux kill-session` at a correctly configured pane"
        );

        // and no age reaches it: a master's file is removed by the master path,
        // never by a passing per-job write.
        let a_year =
            std::time::SystemTime::now() - std::time::Duration::from_secs(365 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&session)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_accessed(a_year)
                    .set_modified(a_year),
            )
            .unwrap();
        sweep_stale(&dir);
        assert!(
            session.exists(),
            "no age may reach a session file — its liveness is not a function of its mtime"
        );

        // the master path is what removes it, and does.
        assert!(write_session_in(&dir, "mowment", &serde_json::Map::new())
            .unwrap()
            .is_none());
        assert!(!session.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F3. The credential is owner-only from the moment the file exists, not
    /// from a tightening afterwards that nothing checks.
    // cm:guard write under a PERMISSIVE umask, because that is the only condition under which the old order was wrong. With the process umask at 022 a later `set_permissions` produced 0600 anyway and the window was invisible; at 000 a file created by `fs::write` is 0666 and stays so if the tightening fails.
    #[cfg(unix)]
    #[test]
    fn a_credential_file_is_owner_only_under_a_permissive_umask() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_mcp_dir("perm-umask");
        let path = dir.join("probe.json");
        write_owner_only(&path, "{\"mcpServers\":{}}").unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "created mode: {mode:o}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\"mcpServers\":{}}"
        );

        // and it overwrites an existing file rather than appending to it.
        write_owner_only(&path, "{}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F3's ordering, which no real filesystem here can produce: the mode is
    /// read BEFORE the credential is written, and a bad one writes nothing.
    // cm:guard the closure asserts the file is EMPTY at the moment it is asked. That is the whole finding — a version checking after `write_all` would also return an error and also remove the file, and every other assertion here would pass while the secret had already been on disk at the wrong mode for the width of the write.
    #[cfg(unix)]
    #[test]
    fn a_mode_that_did_not_take_refuses_before_a_single_credential_byte_is_written() {
        let dir = tmp_mcp_dir("perm-refuse");
        let path = dir.join("probe.json");
        let len_at_check = std::sync::Arc::new(std::sync::Mutex::new(None::<u64>));
        let seen = std::sync::Arc::clone(&len_at_check);

        let err = write_owner_only_checked(&path, "{\"token\":\"s3cret\"}", move |f| {
            *seen.lock().unwrap() = Some(f.metadata()?.len());
            Ok(0o644)
        })
        .expect_err("a file that is not owner-only must not carry a credential");

        assert_eq!(
            *len_at_check.lock().unwrap(),
            Some(0),
            "the mode was read after the credential had already been written"
        );
        assert!(format!("{err}").contains("owner-only"), "{err}");
        assert!(!path.exists(), "and the file it opened is gone");

        // the same seam reporting a good mode writes normally.
        write_owner_only_checked(&path, "{}", |_| Ok(0o600)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F2's other half. The age sweep never touches a session file, so the
    /// assignment listing is its only route off disk — and it must delete by
    /// ABSENCE from that listing, never by age.
    // cm:guard the oldest file belonging to a served project must SURVIVE, and that half is the whole point: a live master stops rewriting its file for as long as core is unreachable, so any version that reintroduced an age here would delete the config of the very master it cannot reach core to check.
    #[test]
    fn only_a_project_this_box_no_longer_serves_loses_its_session_file() {
        let dir = tmp_mcp_dir("orphan-sweep");
        let decl = servers(&[("playwright", "npx")]);
        let served = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        let unbound = write_session_in(&dir, "butlocs", &decl).unwrap().unwrap();
        let job = dir.join("forge-mcp-mowment-job7.json");
        std::fs::write(&job, "{}").unwrap();

        let a_year =
            std::time::SystemTime::now() - std::time::Duration::from_secs(365 * 24 * 60 * 60);
        std::fs::File::options()
            .write(true)
            .open(&served)
            .unwrap()
            .set_times(
                std::fs::FileTimes::new()
                    .set_accessed(a_year)
                    .set_modified(a_year),
            )
            .unwrap();

        assert!(sweep_orphaned_sessions_in(&dir, &["mowment".to_string()])
            .unwrap()
            .is_empty());
        assert!(
            served.exists(),
            "a served project keeps its file at any age — the mtime says nothing about a live pane"
        );
        assert!(
            !unbound.exists(),
            "a project this box no longer serves must not leave rendered credentials on disk"
        );
        assert!(job.exists(), "the per-job namespace is not this sweep's");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F2's failure half: an orphan that could not be removed is REPORTED, and
    /// a live project's file is still untouched while that is happening.
    // cm:guard the active file surviving is half the assertion. A version that answered the read-only directory by giving up early would also return no failures, and the operator would read a clean sweep over credentials still on disk.
    #[cfg(unix)]
    #[test]
    fn an_orphan_that_could_not_be_removed_comes_back_named() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_mcp_dir("orphan-stuck");
        let decl = servers(&[("playwright", "npx")]);
        let served = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        let unbound = write_session_in(&dir, "butlocs", &decl).unwrap().unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        let left = sweep_orphaned_sessions_in(&dir, &["mowment".to_string()]).unwrap();
        assert_eq!(
            left.len(),
            1,
            "the one orphan it could not remove: {left:?}"
        );
        assert_eq!(left[0].0, unbound);
        assert!(!left[0].1.is_empty(), "the reason travels with the path");

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(served.exists() && unbound.exists());

        // and a retry once the directory is writable finishes the job.
        assert!(sweep_orphaned_sessions_in(&dir, &["mowment".to_string()])
            .unwrap()
            .is_empty());
        assert!(!unbound.exists());
        assert!(served.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A directory that could not be READ is an error, and one that is simply
    /// not there is a clean sweep. The two must never answer the same.
    // cm:guard the readable-but-empty case is the control. Without it a version that returned `Err` for every directory would pass the first half and report a permanent deprovisioning failure on every box that has no orphans, which is all of them.
    #[cfg(unix)]
    #[test]
    fn a_directory_that_could_not_be_read_is_not_a_clean_sweep() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_mcp_dir("orphan-unreadable");

        // readable and empty: a clean sweep
        assert!(sweep_orphaned_sessions_in(&dir, &[]).unwrap().is_empty());

        // not there at all: also a clean sweep
        assert!(sweep_orphaned_sessions_in(&dir.join("gone"), &[])
            .unwrap()
            .is_empty());

        // there but unlistable: an error, because nothing was even attempted
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o000)).unwrap();
        assert!(
            sweep_orphaned_sessions_in(&dir, &[]).is_err(),
            "`I found no orphans` and `I could not look` are opposite facts"
        );

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F1, the branch that made the fix worth making: a removal that FAILS
    /// must not report success. Only the caller can say the record is
    /// untrustworthy, and it cannot say what it was not told.
    // cm:guard removing a file needs write on its PARENT, so a read-only directory is the real shape of this failure — the same shape that put the caller in the write-error branch to begin with. A version discarding the error leaves a file the pane never received and reports that it is gone.
    #[cfg(unix)]
    #[test]
    fn a_session_file_that_could_not_be_removed_is_an_error_not_a_silent_success() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_mcp_dir("session-unremovable");
        let path = write_session_in(&dir, "mowment", &servers(&[("playwright", "npx")]))
            .unwrap()
            .unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();

        // the same failure through the empty-map path, which used to discard it
        assert!(
            write_session_in(&dir, "mowment", &serde_json::Map::new()).is_err(),
            "`Ok(None)` would claim the pane was given nothing AND that nothing on disk says otherwise"
        );

        let err = clear_session_in(&dir, "mowment")
            .expect_err("a read-only directory cannot give up its file");
        assert!(
            format!("{err}").to_lowercase().contains("permission"),
            "the caller is owed the reason: {err}"
        );

        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(path.exists(), "and the file really is still there");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F3, the half a fresh-file test cannot reach: the temp path is
    /// predictable, so it may already exist, and `mode()` does not touch a file
    /// this call did not create.
    // cm:guard pre-create the temp path at 0644 and put a marker in it. A version using `create(true)` truncates that file, writes the credential into it and only then reads the mode — so the credential is on disk world-readable before anything checks, which is the whole window this function exists to close.
    #[cfg(unix)]
    #[test]
    fn a_temp_path_left_readable_by_a_crash_does_not_receive_the_credential() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp_mcp_dir("perm-stale-tmp");
        let path = session_path_in(&dir, "mowment");
        let tmp = path.with_extension(format!("tmp.{}", std::process::id()));

        std::fs::write(&tmp, "left by a crash").unwrap();
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644)).unwrap();

        write_session_in(&dir, "mowment", &servers(&[("epodsystem", "node")]))
            .unwrap()
            .expect("the write still succeeds");

        assert!(!tmp.exists(), "the temp file is renamed away, not left");
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "published mode: {mode:o}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// F1. The file is a record of what the pane was GIVEN, so the path that
    /// starts a pane without one must leave no file behind.
    // cm:guard `clear_session` exists for the write-error branch of `ensure_master`, where the pane starts with no `--mcp-config` and a file from the previous start may still be on disk. Leaving it makes the next identical declaration read as a match and silences the stale report for the whole life of that pane.
    #[test]
    fn clearing_a_session_leaves_a_declaring_project_reading_as_stale() {
        let dir = tmp_mcp_dir("session-cleared");
        let decl = servers(&[("playwright", "npx")]);
        let path = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        assert!(session_matches_in(&dir, "mowment", &decl));

        // clearing one project leaves another's alone.
        write_session_in(&dir, "forge-dev", &decl).unwrap().unwrap();
        clear_session_in(&dir, "mowment").expect("a present file is removable");
        assert!(
            session_matches_in(&dir, "forge-dev", &decl),
            "clear_session must name one project, not empty the folder"
        );
        assert!(
            !path.exists(),
            "the file the pane was never given must be gone"
        );
        assert!(
            !session_matches_in(&dir, "mowment", &decl),
            "a pane given nothing must not read as carrying the declaration"
        );
        clear_session_in(&dir, "never-existed").expect("an absent file is not an error");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The comparison a sweep makes against a live pane, in all four shapes.
    // cm:guard the (no file, nothing declared) corner must read as a MATCH. A pane started with no `--mcp-config` for a project that declares nothing is correctly configured; reading it as a mismatch would print the `tmux kill-session` remedy for every project on the fleet that never wanted a server.
    #[test]
    fn a_pane_matches_only_when_the_file_says_what_core_says_now() {
        let dir = tmp_mcp_dir("session-match");
        let decl = servers(&[("playwright", "npx")]);
        let none = serde_json::Map::new();

        assert!(session_matches_in(&dir, "mowment", &none));
        assert!(!session_matches_in(&dir, "mowment", &decl));

        write_session_in(&dir, "mowment", &decl).unwrap();
        assert!(session_matches_in(&dir, "mowment", &decl));
        assert!(!session_matches_in(&dir, "mowment", &none));
        assert!(!session_matches_in(
            &dir,
            "mowment",
            &servers(&[("playwright", "npx"), ("epodsystem", "node")])
        ));
        assert!(!session_matches_in(
            &dir,
            "mowment",
            &servers(&[("playwright", "bunx")])
        ));

        // a different project is a different file and is unaffected
        assert!(session_matches_in(&dir, "forge-dev", &none));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A pane whose file was swept out from under it reads as stale rather than
    /// as matching, which is what turns criterion 5's report on.
    #[test]
    fn a_file_swept_off_disk_leaves_a_declaring_project_reading_as_stale() {
        let dir = tmp_mcp_dir("session-swept");
        let decl = servers(&[("playwright", "npx")]);
        let path = write_session_in(&dir, "mowment", &decl).unwrap().unwrap();
        std::fs::remove_file(&path).unwrap();
        assert!(!session_matches_in(&dir, "mowment", &decl));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
