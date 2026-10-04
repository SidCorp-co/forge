use super::*;

/// Age past which a PER-JOB MCP config left behind by a crashed daemon is removed.
pub(crate) const MCP_CONFIG_MAX_AGE: std::time::Duration =
    std::time::Duration::from_secs(24 * 60 * 60);

/// The `forge-master-mcp-` prefix, which is what tells a per-PROJECT session
/// config apart from a per-job one in the shared directory.
pub(crate) const SESSION_PREFIX: &str = "forge-master-mcp-";

pub(crate) fn sweep_stale(dir: &Path) {
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

/// `~/.config/forge-runner/mcp/`, for a reader: resolved as [`runner_platform::config::Config::path`]
/// resolves, and created by nobody.
pub(crate) fn mcp_read_dir() -> PathBuf {
    runner_platform::config::Config::path()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(unresolved_base)
        .join("mcp")
}

/// Where the configs go when no config dir resolves at all.
pub(crate) fn unresolved_base() -> PathBuf {
    std::env::temp_dir().join("forge-runner")
}

/// Dedicated folder for the runner's per-job MCP configs, for a writer:
/// `~/.config/forge-runner/mcp/`, created on demand, best-effort `0700`.
pub(crate) fn mcp_config_dir() -> PathBuf {
    let base = match runner_platform::config::base_dir() {
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

pub(crate) fn write_session_in(
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
pub(crate) fn write_servers_at(
    path: &Path,
    servers: &serde_json::Map<String, Value>,
) -> Result<()> {
    let doc = serde_json::json!({ "mcpServers": Value::Object(servers.clone()) });
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    write_owner_only(&tmp, &body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn write_job_session_in(
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
pub(crate) const JOB_SESSION_PREFIX: &str = "forge-job-mcp-";

pub fn sweep_orphaned_sessions(active_slugs: &[String]) -> Result<Vec<(PathBuf, String)>> {
    sweep_orphaned_sessions_in(&mcp_config_dir(), active_slugs)
}

pub(crate) fn sweep_orphaned_sessions_in(
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

pub(crate) fn clear_session_in(dir: &Path, slug: &str) -> Result<()> {
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

pub(crate) fn session_matches_in(
    dir: &Path,
    slug: &str,
    servers: &serde_json::Map<String, Value>,
) -> bool {
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

pub(crate) fn session_path_in(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("forge-master-mcp-{}.json", sanitize_slug(slug)))
}

/// Sanitize a project slug into a filesystem-safe token. Non `[A-Za-z0-9_-]`
/// chars become `-`; an empty / all-stripped slug falls back to `default`, so
/// the runner still resolves to a single stable path.
pub(crate) fn sanitize_slug(slug: &str) -> String {
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
