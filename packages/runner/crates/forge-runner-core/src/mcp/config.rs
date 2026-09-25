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
        &crate::auth::pairing::default_device_name(),
    )
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

/// Dedicated folder for the runner's per-job MCP configs:
/// `~/.config/forge-runner/mcp/`. Falls back to `<tmp>/forge-runner/mcp/` only
/// when no config dir is resolvable. Created on demand; best-effort `0700`.
/// Where the session configs live, for a message that names the path an
/// operator has to make writable.
pub fn session_dir() -> PathBuf {
    mcp_config_dir()
}

/// The file this box writes one project's session MCP servers to.
///
/// What an operator asks after being told an integration is delivered is *where*, and the answer
/// is not the checkout's `.mcp.json` — that holds the `forge` server and nothing else, which is
/// the reading that cost ISS-1191's reporter three wrong conclusions. The surface that says
/// delivered names this path.
pub fn session_path(slug: &str) -> PathBuf {
    session_path_in(&mcp_config_dir(), slug)
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
    let doc = serde_json::json!({ "mcpServers": Value::Object(servers.clone()) });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, &path)?;
    Ok(Some(path))
}

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

/// The MCP server every `forge_*` tool is served by, including `forge_github`.
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
is ABSENT from this pane — `forge_github`, which is the only route to a pull request, along with \
`forge_issues`, `forge_comments` and the rest.\n\nAbsent is not refused. A tool you cannot see has \
told you nothing about whether its route is open, so do not report a route as shut on the strength \
of not seeing it, and do not reach for `gh` instead: it runs as whoever configured this box, which \
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::cred_store::ScopedVar;

    fn tmp_repo(tag: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("mcp-persist-{tag}"))
    }

    fn tmp_mcp_dir(tag: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("mcp-cfg-{tag}"))
    }

    fn read_doc(repo: &Path) -> Value {
        let s = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

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
            "forge_pat_dev_boxcred",
            slug,
            "job-a",
            None,
        )
        .unwrap();
        let p2 = write_in(
            &dir,
            "https://core.example",
            "forge_pat_dev_boxcred",
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

    #[test]
    fn the_directory_isolates_runs_and_the_file_name_stays_stable() {
        let one = tmp_mcp_dir("iso-one");
        let two = tmp_mcp_dir("iso-two").at("second");
        std::fs::create_dir_all(&two).unwrap();

        let a = write_in(
            &one,
            "https://core.example",
            "forge_pat_dev_boxcred",
            "iso",
            "job-a",
            None,
        )
        .unwrap();
        let b = write_in(
            &two,
            "https://core.example",
            "forge_pat_dev_boxcred",
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
            "forge_pat_dev_boxcred",
            slug,
            "job-a",
            None,
        )
        .unwrap();
        let b = write_in(
            &dir,
            "https://core.example",
            "forge_pat_dev_boxcred",
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
        let scratch = tmp_mcp_dir("skip-non-object");
        let path = write_in(
            &scratch,
            "https://core.example",
            "forge_pat_dev_boxcred",
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

    const DEVICE: &str = "forge_pat_dev_devicetoken";
    const BOX: &str = "sid-xeon-1";

    fn refusal(pat: Result<Option<String>>, device: Result<Option<String>>) -> String {
        let file = Path::new("/box/forge-runner/credentials.json");
        match decide_job_credential(pat, device, Some(file), BOX) {
            Ok(tok) => panic!(
                "expected a refusal, got a credential of {} chars",
                tok.len()
            ),
            Err(e) => e.to_string(),
        }
    }

    #[test]
    fn a_stored_pat_is_the_job_credential_whatever_else_the_box_holds() {
        let got = decide_job_credential(
            Ok(Some(" forge_pat_dev_op ".into())),
            Ok(Some(DEVICE.into())),
            None,
            BOX,
        );
        assert_eq!(got.unwrap(), "forge_pat_dev_op");
    }

    #[test]
    fn a_device_token_alone_is_refused_naming_what_was_wanted_and_what_was_found() {
        let err = refusal(Ok(None), Ok(Some(DEVICE.into())));
        assert!(err.contains("need a personal access token"), "{err}");
        assert!(
            err.contains("What it holds: a device token from pairing"),
            "{err}"
        );
        assert!(
            err.contains("`/box/forge-runner/credentials.json`"),
            "names the file: {err}"
        );
        assert!(err.contains("forge-runner login --pat <token>"), "{err}");
        assert!(
            err.starts_with("the runner box `sid-xeon-1` cannot start this job"),
            "a person in a chat on a project several boxes serve can tell which box needs the token: {err}"
        );
        assert!(
            err.contains("Settings → API Tokens"),
            "the reader is told where a token comes from: {err}"
        );
        assert!(!err.contains("to pair the box"), "the box is paired: {err}");
        assert!(
            !err.contains(DEVICE),
            "the refusal carries no credential: {err}"
        );
    }

    #[test]
    fn a_blank_pat_is_no_pat() {
        let err = refusal(Ok(Some("   ".into())), Ok(Some(DEVICE.into())));
        assert!(err.contains("What it holds: a device token"), "{err}");
    }

    #[test]
    fn a_box_holding_neither_credential_says_it_is_not_paired_either() {
        let err = refusal(Ok(None), Ok(None));
        assert!(err.contains("no device token either"), "{err}");
        assert!(err.contains("forge-runner login --pat <token>"), "{err}");
        let blank = refusal(Ok(None), Ok(Some(" ".into())));
        assert!(blank.contains("no device token either"), "{blank}");
    }

    #[test]
    fn an_unreadable_store_is_refused_naming_the_read_error_not_read_as_no_pat() {
        let err = refusal(
            Err(Error::Other("expected value at line 1 column 1".into())),
            Ok(None),
        );
        assert!(
            err.contains("could not be read (expected value at line 1 column 1)"),
            "{err}"
        );
        assert!(
            !err.contains("holds none"),
            "a read error is not an absence: {err}"
        );
        assert!(
            err.contains(
                "its credential file `/box/forge-runner/credentials.json` could not be read"
            ),
            "the whole file failed to parse, and the refusal says which file: {err}"
        );
        assert!(
            !err.contains("$FORGE_PAT` or the `pat` key"),
            "`$FORGE_PAT` is read first, so this path runs only when it is unset, and the fault is the file rather than one key: {err}"
        );
        assert!(
            err.contains("deleting it unpairs the box") && err.contains("`sid-xeon-1`"),
            "{err}"
        );
        let device = refusal(Ok(None), Err(Error::Other("keychain locked".into())));
        assert!(
            device.contains("a device token that could not be read (keychain locked)"),
            "{device}"
        );
    }

    #[test]
    fn a_pat_writes_the_forge_entry_it_always_wrote_and_overrides_merge_on_top() {
        let overrides = serde_json::json!({ "playwright": { "type": "stdio", "command": "npx" } });
        let scratch = tmp_mcp_dir("same-entry");
        let path = write_in(
            &scratch,
            "https://core.example/",
            "forge_pat_dev_op",
            "proj",
            "job-same",
            Some(&overrides),
        )
        .unwrap();
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"],
            serde_json::json!({
                "type": "http",
                "url": "https://core.example/mcp",
                "headers": {
                    "Authorization": "Bearer forge_pat_dev_op",
                    "X-Forge-Project-Slug": "proj"
                }
            })
        );
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn with_no_pat_the_provisioned_file_is_not_written_and_the_skip_is_returned() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let cleared = ScopedVar::set("FORGE_PAT", "");
        // Narrower than HOME: the file store resolves through the config dir,
        // and HOME is read by tests that do not take this lock.
        let xdg = ScopedVar::set("XDG_CONFIG_HOME", "/nonexistent-forge-config");
        let repo = tmp_repo("no-pat");
        assert_eq!(
            write_persistent(&repo, "https://core.example", "proj", None).unwrap(),
            PersistentMcp::SkippedNoPat
        );
        assert!(
            !repo.join(".mcp.json").exists(),
            "no credential to write, so no file claiming a `forge` server"
        );
        let _ = std::fs::remove_dir_all(&repo);
        drop((cleared, xdg));
    }

    #[test]
    fn the_credential_core_sent_is_written_and_beats_whatever_is_stored() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stored = ScopedVar::set("FORGE_PAT", "forge_pat_dev_pastedbyhand");
        let repo = tmp_repo("from-server");
        assert_eq!(
            write_persistent(
                &repo,
                "https://core.example",
                "proj",
                Some("forge_pat_dev_fromtheserver")
            )
            .unwrap(),
            PersistentMcp::Written
        );
        assert_eq!(
            read_doc(&repo)["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_fromtheserver",
            "the fenced credential core minted for this checkout, not the box-wide one"
        );
        let _ = std::fs::remove_dir_all(&repo);
        drop(stored);
    }

    #[test]
    fn an_empty_credential_from_an_older_core_falls_back_to_the_stored_pat() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let stored = ScopedVar::set("FORGE_PAT", "forge_pat_dev_pastedbyhand");
        let repo = tmp_repo("blank-server-cred");
        write_persistent(&repo, "https://core.example", "proj", Some("   ")).unwrap();
        assert_eq!(
            read_doc(&repo)["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer forge_pat_dev_pastedbyhand"
        );
        let _ = std::fs::remove_dir_all(&repo);
        drop(stored);
    }

    #[test]
    fn credential_store_paths() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let pat = ScopedVar::set("FORGE_PAT", "forge_pat_dev_operator");

        // -- the provisioned folder is authed by the operator's PAT --
        let repo = tmp_repo("fresh");
        write_persistent(&repo, "https://core.example/", "proj", None).unwrap();
        let forge = read_doc(&repo)["mcpServers"]["forge"].clone();
        assert_eq!(forge["type"], "http");
        assert_eq!(forge["url"], "https://core.example/mcp");
        assert_eq!(
            forge["headers"]["Authorization"],
            "Bearer forge_pat_dev_operator"
        );
        assert_eq!(forge["headers"]["X-Forge-Project-Slug"], "proj");
        let _ = std::fs::remove_dir_all(&repo);

        let scratch = tmp_mcp_dir("box-cred");

        let path = write_in(
            &scratch,
            "https://core.example",
            "forge_pat_dev_boxcred",
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
        write_persistent(&repo, "https://core.example", "proj", None).unwrap();
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
        write_persistent(&repo, "https://fresh.example", "proj2", None).unwrap();
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
        let err = write_persistent(&repo, "https://core.example", "proj", None).unwrap_err();
        assert!(format!("{err}").contains("not valid JSON"));
        assert_eq!(
            std::fs::read_to_string(repo.join(".mcp.json")).unwrap(),
            "{ not json"
        );
        let _ = std::fs::remove_dir_all(&repo);

        // -- with no PAT the provisioned folder keeps whatever was there --
        pat.move_to("");
        let _store = ScopedVar::set("FORGE_RUNNER_CRED_STORE", "file");
        let empty = crate::test_scratch::Scratch::new("mcp-nocred");
        let _xdg = ScopedVar::set("XDG_CONFIG_HOME", &empty);

        let repo = tmp_repo("no-pat");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://hand-written/mcp"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "proj", None).unwrap();
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
        assert_eq!(path.parent().unwrap(), dir.path());

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

    // ---- ISS-1114: what a pane will actually be able to see --------------

    fn reach_dir(tag: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("reach-{tag}"))
    }

    /// A `.mcp.json` shaped exactly as [`write_persistent`] writes one, bearer
    /// header and all, so a test can prove the report carries none of it.
    fn provisioned_repo(dir: &Path, token: &str) -> PathBuf {
        let body = serde_json::json!({
            "mcpServers": {
                "forge": {
                    "type": "http",
                    "url": "https://core.example/mcp",
                    "headers": { "Authorization": format!("Bearer {token}") }
                }
            }
        });
        let path = dir.join(".mcp.json");
        std::fs::write(&path, serde_json::to_string_pretty(&body).unwrap()).unwrap();
        path
    }

    fn session_file(dir: &Path, names: &[&str]) -> PathBuf {
        let map: serde_json::Map<String, Value> = names
            .iter()
            .map(|n| ((*n).to_string(), serde_json::json!({ "type": "stdio" })))
            .collect();
        let path = dir.join("session.json");
        std::fs::write(
            &path,
            serde_json::to_string(&serde_json::json!({ "mcpServers": map })).unwrap(),
        )
        .unwrap();
        path
    }

    /// The reach is the UNION, which is the whole correction: a pane is started
    /// without `--strict-mcp-config`, so neither file on its own is its reach.
    #[test]
    fn the_reach_is_the_union_of_the_checkout_and_the_session_config() {
        let dir = reach_dir("union");
        provisioned_repo(&dir, "pat-value-that-must-not-travel");
        let session = session_file(&dir, &["playwright"]);
        let reach = pane_reach_in(&dir, Some(&session), true);
        assert_eq!(reach.names(), vec!["forge", "playwright"]);
        assert_eq!(reach.forge(), ForgeReach::Declared);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The measured box: no stored PAT, so `write_persistent` returned at its
    /// first branch and the checkout half never got a `forge` entry.
    #[test]
    fn no_stored_pat_leaves_forge_absent_and_names_that_cause() {
        let dir = reach_dir("no-pat");
        let session = session_file(&dir, &["playwright"]);
        let reach = pane_reach_in(&dir, Some(&session), false);
        assert_eq!(reach.names(), vec!["playwright"]);
        assert_eq!(
            reach.forge(),
            ForgeReach::Absent(ForgeAbsentBecause::AndNoCredentialHere)
        );
        assert!(reach.verdict().contains("forge-runner login --pat"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stored_pat_and_no_entry_is_an_unprovisioned_checkout_instead() {
        let dir = reach_dir("unprovisioned");
        let session = session_file(&dir, &["playwright"]);
        let reach = pane_reach_in(&dir, Some(&session), true);
        assert_eq!(
            reach.forge(),
            ForgeReach::Absent(ForgeAbsentBecause::WhileACredentialIsHere)
        );
        assert!(!reach.verdict().contains("forge-runner login"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file that will not parse declares nothing KNOWABLE, which is not the
    /// same as declaring nothing — and a cause chosen over it would be a guess.
    #[test]
    fn a_half_that_will_not_parse_is_undetermined_under_either_pat_state() {
        let dir = reach_dir("unreadable");
        std::fs::write(dir.join(".mcp.json"), "{ not json at all").unwrap();
        let session = session_file(&dir, &["playwright"]);
        for has_pat in [false, true] {
            let reach = pane_reach_in(&dir, Some(&session), has_pat);
            assert_eq!(reach.forge(), ForgeReach::Undetermined);
            let brief = reach.brief();
            assert!(brief.contains("could NOT be determined"), "{brief}");
            assert!(!brief.contains("NEITHER half"), "{brief}");
            assert!(
                brief.contains("known to hold AT LEAST") && !brief.contains("So this pane holds:"),
                "an inventory read off an unreadable file is a floor, not a total: {brief}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A session config that is not there is a half that knowably declares
    /// nothing, so the verdict still lands rather than going undetermined.
    #[test]
    fn a_pane_with_no_session_config_reaches_the_checkout_alone() {
        let dir = reach_dir("no-session");
        provisioned_repo(&dir, "another-value-that-must-not-travel");
        let reach = pane_reach_in(&dir, None, true);
        assert_eq!(reach.names(), vec!["forge"]);
        assert_eq!(reach.forge(), ForgeReach::Declared);
        assert!(reach
            .brief()
            .contains("no session config was written for this pane"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The report is names only. These two files hold live bearer tokens, and
    /// reading one whole into a pane's brief is how a token leaves the box.
    #[test]
    fn the_report_carries_no_value_from_either_file() {
        let dir = reach_dir("no-secrets");
        let secret = "sk-forge-THIS-MUST-NEVER-TRAVEL";
        provisioned_repo(&dir, secret);
        let session = dir.join("session.json");
        std::fs::write(
            &session,
            serde_json::to_string(&serde_json::json!({
                "mcpServers": {
                    "playwright": { "type": "http", "headers": { "Authorization": secret } }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let reach = pane_reach_in(&dir, Some(&session), true);
        for text in [reach.brief(), reach.verdict()] {
            assert!(
                !text.contains(secret),
                "a credential reached the report: {text}"
            );
            assert!(
                !text.contains("Bearer"),
                "a header reached the report: {text}"
            );
            assert!(
                !text.contains("Authorization"),
                "a header name reached the report: {text}"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ISS-1114 grants the pane nothing: the session writer still writes
    /// exactly what core declared, and `forge` is not core's to declare.
    #[test]
    fn the_session_writer_still_adds_no_forge_entry_of_its_own() {
        let dir = tmp_mcp_dir("session-no-forge");
        let path = write_session_in(&dir, "mowment", &servers(&[("playwright", "npx")]))
            .unwrap()
            .expect("servers were declared, so a path is owed");
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let written: Vec<&String> = doc["mcpServers"].as_object().unwrap().keys().collect();
        assert_eq!(
            written,
            vec!["playwright"],
            "the pane's route to `forge` is the checkout's .mcp.json, and a second copy of the \
             operator PAT in a file with another lifetime buys no reach"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file that is there and empty is a file that was truncated mid-write as
    /// readily as one somebody meant to leave blank, and neither is a checkout
    /// that knowably declares nothing.
    #[test]
    fn an_empty_or_blank_half_is_undetermined_rather_than_knowably_empty() {
        for (tag, body) in [("empty", ""), ("blank", "  \n\t\n")] {
            let dir = reach_dir(&format!("blank-{tag}"));
            std::fs::write(dir.join(".mcp.json"), body).unwrap();
            let session = session_file(&dir, &["playwright"]);
            for has_pat in [false, true] {
                let reach = pane_reach_in(&dir, Some(&session), has_pat);
                assert_eq!(
                    reach.forge(),
                    ForgeReach::Undetermined,
                    "a {tag} .mcp.json declares nothing KNOWABLE"
                );
                let brief = reach.brief();
                assert!(brief.contains("could NOT be determined"), "{brief}");
                assert!(!brief.contains("What is observed"), "{brief}");
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// `write_persistent` prefers the credential core minted for the checkout
    /// over anything stored here, so a box with no operator PAT is NOT a box
    /// whose checkout was never written. The brief may say what it sees and
    /// what to do; it may not say what happened.
    #[test]
    fn an_entry_removed_from_a_server_provisioned_checkout_earns_no_history() {
        let repo = tmp_repo("reach-server-provisioned");
        write_persistent(
            &repo,
            "https://core.example",
            "mowment",
            Some("minted-for-this-checkout"),
        )
        .unwrap();
        let mut doc = read_doc(&repo);
        doc["mcpServers"]
            .as_object_mut()
            .unwrap()
            .remove(FORGE_SERVER);
        std::fs::write(
            repo.join(".mcp.json"),
            serde_json::to_string_pretty(&doc).unwrap(),
        )
        .unwrap();

        // The box itself holds no operator PAT, which is the state that used to
        // be read as "nothing ever wrote it".
        let reach = pane_reach_in(&repo, None, false);
        assert_eq!(
            reach.forge(),
            ForgeReach::Absent(ForgeAbsentBecause::AndNoCredentialHere)
        );
        let brief = reach.brief();
        assert!(
            brief.contains("it may never have been written, or it may have been removed since"),
            "the brief asserts a history it cannot establish: {brief}"
        );
        assert!(
            brief.contains("re-provision this checkout")
                && brief.contains("forge-runner login --pat"),
            "both routes to the entry have to be offered, since either may be the one: {brief}"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
