//! Build a temp MCP config file for a job run.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::auth::cred_store::{credential_file_path, load_device_token, load_pat};
use crate::error::{Error, Result};

/// The credential a job's `forge` MCP server and its `$FORGE_PAT` carry: the
/// box's stored personal access token, or a refusal naming what was wanted and
/// what the box holds.
///
/// The device token is refused rather than substituted. It is a PAT since
/// ISS-932, but fenced to its holder: a box paired by a person is minted one
/// that reaches no project, and nothing on the box says which kind it holds.
pub fn job_credential() -> Result<String> {
    let file = credential_file_path().ok();
    decide_job_credential(
        load_pat(),
        load_device_token(),
        file.as_deref(),
        &box_name(),
    )
}

/// What to call this box to whoever reads a refusal: the label it paired under,
/// which is what the web app's device list shows, and the hostname only where
/// nothing recorded one. A box paired as `forge-runner login --name X` is `X`
/// in that list, so naming its hostname sends a reader looking for a device
/// that is not there (ISS-1235).
fn box_name() -> String {
    crate::config::Config::load()
        .ok()
        .and_then(|cfg| cfg.device_name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(crate::auth::pairing::default_device_name)
}

/// Where a person gets the token the refusals below ask for.
const TOKEN_PAGE: &str = "Forge's web app under Settings → API Tokens";

/// The refusal reaches whoever started the job, often a person in a chat
/// rather than the operator of this box, and a project may be served by
/// several boxes, so it names the box before anything else.
fn decide_job_credential(
    pat: Result<Option<String>>,
    device_token: Result<Option<String>>,
    file: Option<&Path>,
    box_name: &str,
) -> Result<String> {
    let lead = format!(
        "the runner box `{box_name}` cannot start this job: the job's Forge tools need a personal access token"
    );
    // `load_pat` reads `$FORGE_PAT` first and swallows a keychain miss, so an
    // error here is the credential file's: its path, its read or its parse.
    let pat = pat.map_err(|e| {
        let file = file.map_or_else(
            || "its credential file".to_string(),
            |p| format!("its credential file `{}`", p.display()),
        );
        Error::Other(format!(
            "{lead}, and {file} could not be read ({e}). Whoever operates `{box_name}` repairs \
             that file (it also holds the box's pairing, so deleting it unpairs the box), or \
             sets `$FORGE_PAT` for the runner, which is read before the file."
        ))
    })?;
    if let Some(pat) = pat.map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        return Ok(pat);
    }
    let held = match device_token {
        Ok(Some(t)) if !t.trim().is_empty() => "a device token from pairing, which connects \
             the box to Forge and is never handed to a job"
            .to_string(),
        Ok(_) => "no device token either, so the box is not paired (`forge-runner login` pairs it)"
            .to_string(),
        Err(e) => format!("a device token that could not be read ({e})"),
    };
    Err(Error::Other(format!(
        "{lead}, and the box holds none (read from {}). What it holds: {held}. Whoever operates \
         `{box_name}` creates a token in {TOKEN_PAGE} and runs \
         `forge-runner login --pat <token>` on that box; jobs started after that carry it, \
         with no restart.",
        pat_sources(file)
    )))
}

/// Where `load_pat` looks, in its own order.
fn pat_sources(file: Option<&Path>) -> String {
    let file = file.map_or_else(
        || "the credential file".to_string(),
        |p| format!("`{}`", p.display()),
    );
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        format!("`$FORGE_PAT`, the OS keychain, or the `pat` key of {file}")
    } else {
        format!("`$FORGE_PAT` or the `pat` key of {file}")
    }
}

pub fn write(
    core_url: &str,
    credential: &str,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    write_in(
        &mcp_config_dir(),
        core_url,
        credential,
        project_slug,
        job_id,
        override_servers,
    )
}

fn write_in(
    dir: &Path,
    core_url: &str,
    credential: &str,
    project_slug: &str,
    job_id: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let mut servers = serde_json::json!({
        "forge": {
            "type": "http",
            "url": mcp_url,
            "headers": {
                "Authorization": format!("Bearer {credential}"),
                "X-Forge-Project-Slug": project_slug
            }
        }
    });

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

    sweep_stale(dir);
    let path = dir.join(format!(
        "forge-mcp-{}-{}.json",
        sanitize_slug(project_slug),
        sanitize_slug(job_id)
    ));
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
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

fn sweep_stale(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
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

/// Where the session configs live, for a message that names the path an
/// operator has to make writable.
pub fn session_dir() -> PathBuf {
    mcp_read_dir()
}

/// The file this box writes one project's session MCP servers to.
///
/// What an operator asks after being told an integration is delivered is *where*, and the answer
/// is not the checkout's `.mcp.json` — that holds the `forge` server and nothing else, which is
/// the reading that cost ISS-1191's reporter three wrong conclusions. The surface that says
/// delivered names this path.
pub fn session_path(slug: &str) -> PathBuf {
    session_path_in(&mcp_read_dir(), slug)
}

/// `~/.config/forge-runner/mcp/`, for a reader: resolved as [`crate::config::Config::path`]
/// resolves, and created by nobody.
fn mcp_read_dir() -> PathBuf {
    crate::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(unresolved_base)
        .join("mcp")
}

/// Where the configs go when no config dir resolves at all.
fn unresolved_base() -> PathBuf {
    std::env::temp_dir().join("forge-runner")
}

/// Dedicated folder for the runner's per-job MCP configs, for a writer:
/// `~/.config/forge-runner/mcp/`, created on demand, best-effort `0700`.
fn mcp_config_dir() -> PathBuf {
    let base = match crate::config::base_dir() {
        Ok(base) => base,
        // A test build's refusal is the test's to answer, never a shared
        // `<tmp>/forge-runner` every test process writes into (ISS-1344).
        Err(_) => unresolved_base(),
    };
    let dir = base.join("mcp");
    let _ = std::fs::create_dir_all(&dir);
    restrict_dir_perms(&dir);
    dir
}

pub fn write_session(
    slug: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    write_session_in(&mcp_config_dir(), slug, servers)
}

fn write_session_in(
    dir: &Path,
    slug: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    let path = session_path_in(dir, slug);
    if servers.is_empty() {
        clear_session_in(dir, slug)?;
        return Ok(None);
    }
    write_servers_at(&path, servers)?;
    Ok(Some(path))
}

/// The document a session config holds, put at `path` owner-only and whole or not at all. The
/// one writer behind a master pane's config and a job pane's, so the two cannot differ in what a
/// pane is handed or in who can read the credentials inside it.
fn write_servers_at(path: &Path, servers: &serde_json::Map<String, Value>) -> Result<()> {
    let doc = serde_json::json!({ "mcpServers": Value::Object(servers.clone()) });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// A pool job pane's own copy of its project's declared servers, beside the master's.
///
/// Its own file because a master pane's is the record [`session_matches`] reads to say whether
/// that LIVE pane still carries what core resolves: a job rewriting it with a newer declaration
/// would make a master started on an older one read as current (ISS-1347). An empty declaration
/// writes nothing, so the pane is started with no `--mcp-config` at all.
pub fn write_job_session(
    pane: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    write_job_session_in(&mcp_config_dir(), pane, servers)
}

pub(crate) fn write_job_session_in(
    dir: &Path,
    pane: &str,
    servers: &serde_json::Map<String, Value>,
) -> Result<Option<PathBuf>> {
    if servers.is_empty() {
        return Ok(None);
    }
    sweep_stale(dir);
    let path = job_session_path_in(dir, pane);
    write_servers_at(&path, servers)?;
    Ok(Some(path))
}

/// Remove what [`write_job_session`] wrote for this pane; a pane it wrote nothing for is not an
/// error.
pub fn clear_job_session(pane: &str) -> Result<()> {
    clear_job_session_in(&mcp_config_dir(), pane)
}

pub(crate) fn clear_job_session_in(dir: &Path, pane: &str) -> Result<()> {
    let path = job_session_path_in(dir, pane);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(Error::Other(format!("{}: {e}", path.display()))),
    }
}

/// Where a job pane's config lives, off the pane name alone, which the job's record carries
/// across a restart.
pub(crate) fn job_session_path_in(dir: &Path, pane: &str) -> PathBuf {
    dir.join(format!("{JOB_SESSION_PREFIX}{}.json", sanitize_slug(pane)))
}

/// A job pane's config, which the 24-hour age sweep removes where a crashed daemon left one: it
/// is read once, when the pane's agent starts.
const JOB_SESSION_PREFIX: &str = "forge-job-mcp-";

pub fn sweep_orphaned_sessions(active_slugs: &[String]) -> Result<Vec<(PathBuf, String)>> {
    sweep_orphaned_sessions_in(&mcp_config_dir(), active_slugs)
}

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

pub fn clear_session(slug: &str) -> Result<()> {
    clear_session_in(&mcp_config_dir(), slug)
}

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
    session_matches_in(&mcp_read_dir(), slug, servers)
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
        (Some(text), false) => session_servers(&text).as_ref() == Some(servers),
    }
}

/// The `mcpServers` map a session config document holds, or `None` where the
/// text is not the document [`write_session`] writes.
///
/// Takes the TEXT and not a path, so a caller that has already read the file
/// judges the bytes it read. [`session_matches`] reads by path, and the master
/// sweep rewrites that file on every pass for a live pane, so two reads of one
/// path can answer about two different files (ISS-1191). `None` and a map that
/// differs are also two answers here rather than one: a pane started from a
/// document this cannot parse carries nothing, which is not the same as
/// carrying something else.
pub fn session_servers(text: &str) -> Option<serde_json::Map<String, Value>> {
    let doc: Value = serde_json::from_str(text).ok()?;
    match doc.get("mcpServers") {
        Some(Value::Object(map)) => Some(map.clone()),
        _ => None,
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
    let _ = std::fs::remove_file(path);
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
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

/// What `write_persistent` did. The skip is a real outcome, not a success: a
/// provisioned folder with no `forge` entry looks finished and is not, and the
/// caller has to be able to say so rather than log it and report `ready`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PersistentMcp {
    Written,
    /// No PAT is stored on this box, so there is no credential to write.
    SkippedNoPat,
}

/// `credential` is the token core minted for this checkout, delivered with the
/// provision. It is preferred over anything stored on the box: it is fenced to
/// this one project, and the box's own stored PAT (when it has one at all) is
/// whatever a human happened to paste.
pub fn write_persistent(
    repo_path: &Path,
    core_url: &str,
    project_slug: &str,
    credential: Option<&str>,
) -> Result<PersistentMcp> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let from_server = credential
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(str::to_string);
    let Some(pat) = from_server.or_else(|| load_pat().ok().flatten()) else {
        tracing::warn!(
            project_slug,
            "mcp config: no stored PAT — leaving the `forge` entry in the provisioned \
             .mcp.json alone. Run `forge-runner login --pat <token>` so a human running \
             `claude` in this folder reaches Forge."
        );
        return Ok(PersistentMcp::SkippedNoPat);
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
    Ok(PersistentMcp::Written)
}

/// The variable the `forge` CLI reads a borrowed account from: a path to a
/// config file whose `url` and `token` it takes in place of its own home's.
pub const CLI_BORROW_VAR: &str = "FORGE_BORROW_FROM";

/// What [`write_cli_borrow`] left for a project's master pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliBorrow {
    /// The checkout's credential, at this path, for the pane's `forge` CLI.
    Written(PathBuf),
    /// Core minted no credential for the checkout, so no file is left and the
    /// pane's CLI reads its home's own account.
    Absent,
}

/// The file a project's master pane hands its `forge` CLI under
/// [`CLI_BORROW_VAR`], beside the pane's transcript and last exit.
pub fn cli_borrow_path(slug: &str) -> Result<PathBuf> {
    Ok(crate::daemon::pane_exit::master_dir(slug)?.join("forge-cli.json"))
}

// cm:why one credential per checkout: the token core minted for it is what `.mcp.json` carries, so the pane's CLI borrows that same token and never the box's operator PAT, which reaches the projects one person pasted it for
/// Leave the checkout's credential where its master pane's `forge` CLI borrows
/// it: `{url, token}` owner-only, or no file at all where core minted none.
pub fn write_cli_borrow(slug: &str, core_url: &str, credential: Option<&str>) -> Result<CliBorrow> {
    write_cli_borrow_at(&cli_borrow_path(slug)?, core_url, credential)
}

fn write_cli_borrow_at(path: &Path, core_url: &str, credential: Option<&str>) -> Result<CliBorrow> {
    let Some(token) = credential.map(str::trim).filter(|c| !c.is_empty()) else {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(Error::Io(e)),
        }
        return Ok(CliBorrow::Absent);
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let doc = serde_json::json!({ "url": core_url.trim_end_matches('/'), "token": token });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, path)?;
    Ok(CliBorrow::Written(path.to_path_buf()))
}

/// The MCP server every `forge_*` tool is served by, including `forge_source`.
pub const FORGE_SERVER: &str = "forge";

/// One half of a master pane's MCP reach: a config file, and what it declares.
///
/// A file that is not there declares nothing, and that is knowledge. A file
/// that is there and will not parse declares nothing KNOWABLE, which is a
/// different answer and the one no diagnosis may be built on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Half {
    /// The file parsed, and these are the server names it declares.
    Declares(Vec<String>),
    /// There is no such file.
    Missing,
    /// The file is there and could not be read, in its own words.
    Unreadable(String),
}

impl Half {
    /// Read one config file for the NAMES of the servers it declares.
    ///
    /// Only the keys of `mcpServers` are taken. These files carry bearer
    /// tokens in their values and no caller of this is ever handed one.
    fn read(path: &Path) -> Self {
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::Missing,
            Err(e) => return Self::Unreadable(e.to_string()),
        };
        let doc = match serde_json::from_str::<Value>(&text) {
            Ok(v) => v,
            // A serde_json parse error names a line and a column and quotes no
            // input, so it is safe to carry out of a file holding a token.
            Err(e) => return Self::Unreadable(e.to_string()),
        };
        match doc.get("mcpServers") {
            None => Self::Declares(Vec::new()),
            Some(Value::Object(map)) => Self::Declares(map.keys().cloned().collect()),
            Some(_) => Self::Unreadable("`mcpServers` is not an object".to_string()),
        }
    }

    fn names(&self) -> &[String] {
        match self {
            Self::Declares(names) => names,
            Self::Missing | Self::Unreadable(_) => &[],
        }
    }

    fn unreadable(&self) -> bool {
        matches!(self, Self::Unreadable(_))
    }

    /// This half as one clause of the inventory the pane is shown.
    fn clause(&self) -> String {
        match self {
            Self::Declares(names) if names.is_empty() => "declares no servers".to_string(),
            Self::Declares(names) => {
                let mut names = names.clone();
                names.sort();
                format!("declares {}", names.join(", "))
            }
            Self::Missing => "is not there, so it declares nothing".to_string(),
            Self::Unreadable(why) => {
                format!("could NOT be read ({why}), so what it declares is unknown")
            }
        }
    }
}

/// What else this box can OBSERVE when the union holds no [`FORGE_SERVER`].
///
/// Not a history. [`write_persistent`] writes that entry from the credential
/// core minted for the checkout, falling back to this box's stored PAT, so an
/// absent entry is consistent with a provision that never ran, one that ran
/// without a credential, and a file edited since. Naming one of those would be
/// the invented certainty ISS-1114 is about, a layer along.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeAbsentBecause {
    /// No operator PAT is stored here either, so this box has no credential of
    /// its own to fall back on.
    AndNoCredentialHere,
    /// An operator PAT IS stored here, so a re-provision has one to write.
    WhileACredentialIsHere,
}

/// What this box may say about [`FORGE_SERVER`] being within a pane's reach.
///
/// Three answers and never two: the third exists because a half that could not
/// be read is not a half that declares nothing, and reporting it as one would
/// be the same substitution ISS-1114 was opened about.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgeReach {
    /// One of the halves declares it.
    Declared,
    /// Both halves were read and neither declares it.
    Absent(ForgeAbsentBecause),
    /// A half could not be read, so nothing follows about it either way.
    Undetermined,
}

/// What a master pane will actually be able to see.
///
/// A pane is started with `--mcp-config <session file>` and deliberately
/// WITHOUT `--strict-mcp-config`, so its reach is the union of the checkout's
/// `.mcp.json` and that session file. Neither file on its own answers the
/// question the pane has to ask, which is what it holds — and the daemon log,
/// where the runner says what it wrote, is not a thing a pane reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneReach {
    repo_path: PathBuf,
    repo: Half,
    session_path: Option<PathBuf>,
    session: Half,
    has_operator_pat: bool,
}

/// The union a pane started in `repo_path` with `session_config` will get.
pub fn pane_reach(repo_path: &Path, session_config: Option<&Path>) -> PaneReach {
    pane_reach_in(
        repo_path,
        session_config,
        load_pat()
            .ok()
            .flatten()
            .is_some_and(|t| !t.trim().is_empty()),
    )
}

pub(crate) fn pane_reach_in(
    repo_path: &Path,
    session_config: Option<&Path>,
    has_operator_pat: bool,
) -> PaneReach {
    let repo_file = repo_path.join(".mcp.json");
    PaneReach {
        repo: Half::read(&repo_file),
        repo_path: repo_file,
        session: session_config.map_or(Half::Missing, Half::read),
        session_path: session_config.map(Path::to_path_buf),
        has_operator_pat,
    }
}

impl PaneReach {
    /// Every server name the union declares, sorted and deduplicated.
    pub fn names(&self) -> Vec<String> {
        let mut all: Vec<String> = self
            .repo
            .names()
            .iter()
            .chain(self.session.names())
            .cloned()
            .collect();
        all.sort();
        all.dedup();
        all
    }

    /// What this box may say about `forge`.
    pub fn forge(&self) -> ForgeReach {
        if self.names().iter().any(|n| n == FORGE_SERVER) {
            return ForgeReach::Declared;
        }
        if self.repo.unreadable() || self.session.unreadable() {
            return ForgeReach::Undetermined;
        }
        ForgeReach::Absent(if self.has_operator_pat {
            ForgeAbsentBecause::WhileACredentialIsHere
        } else {
            ForgeAbsentBecause::AndNoCredentialHere
        })
    }

    /// One line for an operator's log, saying which of the three this is.
    pub fn verdict(&self) -> String {
        let held = self.names();
        let held = if held.is_empty() {
            "nothing".to_string()
        } else {
            held.join(", ")
        };
        match self.forge() {
            ForgeReach::Declared => format!("declares {held}, `forge` among them"),
            ForgeReach::Absent(ForgeAbsentBecause::AndNoCredentialHere) => format!(
                "declares {held} and NOT `forge`: no such entry in {}, and no operator PAT stored \
                 here to write one — re-provision the checkout, or `forge-runner login --pat \
                 <token>`",
                self.repo_path.display()
            ),
            ForgeReach::Absent(ForgeAbsentBecause::WhileACredentialIsHere) => format!(
                "declares {held} and NOT `forge`: no such entry in {}, though an operator PAT is \
                 stored here — re-provision the checkout",
                self.repo_path.display()
            ),
            ForgeReach::Undetermined => format!(
                "declares {held}, and whether `forge` is among them is UNDETERMINED: {}",
                self.unreadable_clause()
            ),
        }
    }

    fn unreadable_clause(&self) -> String {
        let mut which = Vec::new();
        if let Half::Unreadable(why) = &self.repo {
            which.push(format!(
                "{} could not be read ({why})",
                self.repo_path.display()
            ));
        }
        if let Half::Unreadable(why) = &self.session {
            let path = self
                .session_path
                .as_ref()
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "the session config".to_string());
            which.push(format!("{path} could not be read ({why})"));
        }
        which.join("; ")
    }

    /// The reach as the prose a pane is given when it starts.
    ///
    /// Server names only: no value from either file reaches this string, and
    /// the wording says the files DECLARE these servers rather than that any of
    /// them answers.
    pub fn brief(&self) -> String {
        let session_line = match self.session_path.as_ref() {
            Some(path) => format!("- `{}` {}\n", path.display(), self.session.clause()),
            None => "- no session config was written for this pane, so it declares nothing\n"
                .to_string(),
        };
        let held = self.names();
        let held = if held.is_empty() {
            "nothing at all".to_string()
        } else {
            held.join(", ")
        };
        // A half that could not be read makes the union a floor and not a
        // total, and a line that said otherwise would be this issue's own
        // defect wearing the fix's clothes.
        let holds = if self.repo.unreadable() || self.session.unreadable() {
            format!(
                "So this pane is known to hold AT LEAST: {held}. One of those two files could not \
be read, so that list may be short by whatever it declares."
            )
        } else {
            format!("So this pane holds: {held}.")
        };
        let mut out = format!(
            "\n## What this pane can actually reach\n\nThis pane was started with `--mcp-config` \
and deliberately without `--strict-mcp-config`, so its MCP reach is the UNION of two files:\n\n\
- `{}` {}\n{session_line}\n{holds} That is what those two files DECLARE. \
Nothing here has checked that any of them answers, authenticates, or serves the tools it names.\n",
            self.repo_path.display(),
            self.repo.clause(),
        );
        match self.forge() {
            ForgeReach::Declared => {}
            ForgeReach::Absent(because) => {
                out.push_str(ABSENT_FORGE);
                out.push_str(&self.cause_line(because));
            }
            ForgeReach::Undetermined => out.push_str(&format!(
                "\nWhether the `{FORGE_SERVER}` MCP server is within that union could NOT be \
determined, because {}. Conclude nothing from this either way: if no `forge_*` tool is in the \
inventory you can see, report that this box could not read its own MCP configuration — never that \
the capability is unavailable, and never that it refused.\n",
                self.unreadable_clause()
            )),
        }
        out
    }

    fn cause_line(&self, because: ForgeAbsentBecause) -> String {
        match because {
            ForgeAbsentBecause::AndNoCredentialHere => format!(
                "\nWhat is observed, which is not the same as what happened: there is no \
`{FORGE_SERVER}` entry in `{}`, and no operator PAT is stored on this box either. The runner \
writes that entry when it provisions a checkout, from a credential core mints for the project or, \
failing that, from a PAT stored here — so re-provision this checkout, or run `forge-runner login \
--pat <token>` to give this box one of its own. Why it is missing is not something this pane can \
tell you: it may never have been written, or it may have been removed since.{TAIL}",
                self.repo_path.display()
            ),
            ForgeAbsentBecause::WhileACredentialIsHere => format!(
                "\nWhat is observed, which is not the same as what happened: there is no \
`{FORGE_SERVER}` entry in `{}`, though this box DOES hold an operator PAT — so a credential is on \
hand and the entry is still missing. Re-provision this checkout on this box. Why it is missing is \
not something this pane can tell you.{TAIL}",
                self.repo_path.display()
            ),
        }
    }
}

/// What follows either observation: a pane cannot be re-configured in place.
const TAIL: &str = " A started pane cannot be handed a new MCP configuration, so the pane that \
gets it is the next one this box starts.\n";

/// What a pane is told when `forge` is in neither half of its union.
///
/// It is absence and not refusal that has to land: a pane that could not tell
/// the two apart reasoned from `gh`, the only GitHub-shaped thing it could
/// still see, and reported pull requests unreachable as established fact for
/// six passes (ISS-1114).
const ABSENT_FORGE: &str = "\nThe `forge` MCP server is in NEITHER half, so every `forge_*` tool \
is ABSENT from this pane — `forge_source`, which is the only route to a pull or merge request, \
along with `forge_uploads`, `forge_agent_report` and the rest.\n\nAbsent is not refused. A tool you cannot see has \
told you nothing about whether its route is open, so do not report a route as shut on the strength \
of not seeing it, and do not reach for `gh` or `glab` instead: it runs as whoever configured this box, which \
is neither attributable nor revocable. Say the capability is unreachable FROM THIS PANE, and name \
the cause below.\n";

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
