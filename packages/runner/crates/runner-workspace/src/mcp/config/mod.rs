//! Build a temp MCP config file for a job run.

mod session;
pub use session::*;
mod reach;
pub use reach::*;

use std::path::{Path, PathBuf};

use serde_json::Value;

use runner_platform::cred_store::{credential_file_path, load_device_token, load_pat};
use runner_platform::error::{Error, Result};

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
    runner_platform::config::Config::load()
        .ok()
        .and_then(|cfg| cfg.device_name)
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(crate::pairing::default_device_name)
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
    Ok(runner_platform::config::master_dir(slug)?.join("forge-cli.json"))
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
