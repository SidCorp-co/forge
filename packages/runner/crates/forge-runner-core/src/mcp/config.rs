//! Build a temp MCP config file for a job run.

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::error::{Error, Result};

/// Write `{ mcpServers: { forge: <http>, ...override } }` to a temp file and
/// return its path. The Forge server points at `<core>/mcp` and authenticates
/// with the device token + project slug header.
pub fn write(
    core_url: &str,
    device_token: &str,
    project_slug: &str,
    override_servers: Option<&Value>,
) -> Result<PathBuf> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let mut servers = serde_json::json!({
        "forge": {
            "type": "http",
            "url": mcp_url,
            "headers": {
                "Authorization": format!("Bearer {device_token}"),
                "X-Forge-Project-Slug": project_slug
            }
        }
    });

    if let Some(extra) = override_servers {
        if let (Some(base), Some(extra)) = (servers.as_object_mut(), extra.as_object()) {
            for (name, cfg) in extra {
                let enabled = cfg.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                if enabled {
                    base.insert(name.clone(), cfg.clone());
                }
            }
        }
    }

    let doc = serde_json::json!({ "mcpServers": servers });

    // Stable, reused path inside a dedicated Forge folder — NOT a per-run UUID in
    // the shared `/tmp` root. The runner keeps all its state under
    // `~/.config/forge-runner/` (credentials, config, skills-cache); the per-job
    // MCP config lives beside them in `mcp/`, one file per project slug, simply
    // overwritten by the next same-slug run. So the runner neither scatters
    // `/tmp/forge-mcp-*.json` files nor accumulates one per run. For a given slug
    // the content is deterministic (same core_url + device token + per-project
    // overrides), so a rare concurrent same-slug writer produces identical bytes.
    let path = mcp_config_dir().join(format!("forge-mcp-{}.json", sanitize_slug(project_slug)));
    let body = serde_json::to_string_pretty(&doc).map_err(|e| Error::Other(e.to_string()))?;
    std::fs::write(&path, body)?;
    restrict_perms(&path); // the file carries a device token — 0600 it
    Ok(path)
}

/// Dedicated folder for the runner's per-job MCP configs:
/// `~/.config/forge-runner/mcp/`. Falls back to `<tmp>/forge-runner/mcp/` only
/// when no config dir is resolvable. Created on demand; best-effort `0700`.
fn mcp_config_dir() -> PathBuf {
    let base = dirs_next::config_dir()
        .map(|d| d.join("forge-runner"))
        .unwrap_or_else(|| std::env::temp_dir().join("forge-runner"));
    let dir = base.join("mcp");
    let _ = std::fs::create_dir_all(&dir);
    restrict_dir_perms(&dir);
    dir
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

/// Restrict the config file to owner-only (`0600`) — it carries a device token.
/// Best-effort; no-op on non-unix.
#[cfg(unix)]
fn restrict_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &Path) {}

/// Write a persistent `<repo>/.mcp.json` wiring the project's Forge MCP server
/// (device-token authed) so a human running `claude` in the provisioned folder
/// can talk to Forge out of the box. Distinct from [`write`], which is the
/// per-job temp config (it also merges integration overrides with fresh tokens).
///
/// READ-MERGE, not overwrite: any servers a human (or another tool) added to an
/// existing `.mcp.json` are preserved; only the `forge` entry is upserted
/// (overridden on key collision). A missing/empty file is created fresh; a file
/// that exists but isn't valid JSON / isn't an object is left untouched and an
/// error is returned, so we never clobber a user's hand-written config.
///
/// The file carries the device token, so we add it to `.git/info/exclude` (NOT
/// the tracked `.gitignore`) to guarantee it's never committed. Idempotent.
pub fn write_persistent(
    repo_path: &Path,
    core_url: &str,
    device_token: &str,
    project_slug: &str,
) -> Result<()> {
    let mcp_url = format!("{}/mcp", core_url.trim_end_matches('/'));
    let forge_server = serde_json::json!({
        "type": "http",
        "url": mcp_url,
        "headers": {
            "Authorization": format!("Bearer {device_token}"),
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

    fn tmp_repo(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("forge-mcp-persist-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_doc(repo: &Path) -> Value {
        let s = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
        serde_json::from_str(&s).unwrap()
    }

    #[test]
    fn creates_fresh_when_missing() {
        let repo = tmp_repo("fresh");
        write_persistent(&repo, "https://core.example/", "tok", "proj").unwrap();
        let doc = read_doc(&repo);
        let forge = &doc["mcpServers"]["forge"];
        assert_eq!(forge["type"], "http");
        assert_eq!(forge["url"], "https://core.example/mcp");
        assert_eq!(forge["headers"]["Authorization"], "Bearer tok");
        assert_eq!(forge["headers"]["X-Forge-Project-Slug"], "proj");
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn preserves_other_servers_and_upserts_forge() {
        let repo = tmp_repo("merge");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"playwright":{"type":"stdio","command":"npx"}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://core.example", "tok", "proj").unwrap();
        let doc = read_doc(&repo);
        // user's server survives untouched
        assert_eq!(doc["mcpServers"]["playwright"]["command"], "npx");
        // forge added
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[test]
    fn overrides_existing_forge() {
        let repo = tmp_repo("override");
        std::fs::write(
            repo.join(".mcp.json"),
            r#"{"mcpServers":{"forge":{"type":"http","url":"https://stale/mcp"},"other":{"x":1}}}"#,
        )
        .unwrap();
        write_persistent(&repo, "https://fresh.example", "tok2", "proj2").unwrap();
        let doc = read_doc(&repo);
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://fresh.example/mcp"
        );
        assert_eq!(
            doc["mcpServers"]["forge"]["headers"]["Authorization"],
            "Bearer tok2"
        );
        assert_eq!(doc["mcpServers"]["other"]["x"], 1);
        let _ = std::fs::remove_dir_all(&repo);
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
    fn write_uses_stable_slug_path_not_uuid() {
        let slug = "forge-test-stable-slug-xyz";
        let p1 = write("https://core.example", "tok", slug, None).unwrap();
        let p2 = write("https://core.example", "tok", slug, None).unwrap();
        assert_eq!(p1, p2, "same slug must resolve to the same reused path");
        assert_eq!(
            p1.file_name().unwrap().to_str().unwrap(),
            "forge-mcp-forge-test-stable-slug-xyz.json"
        );
        let doc: Value = serde_json::from_str(&std::fs::read_to_string(&p1).unwrap()).unwrap();
        assert_eq!(
            doc["mcpServers"]["forge"]["url"],
            "https://core.example/mcp"
        );
        let _ = std::fs::remove_file(&p1);
    }

    #[test]
    fn refuses_to_clobber_malformed_file() {
        let repo = tmp_repo("malformed");
        std::fs::write(repo.join(".mcp.json"), "{ not json").unwrap();
        let err = write_persistent(&repo, "https://core.example", "tok", "proj").unwrap_err();
        assert!(format!("{err}").contains("not valid JSON"));
        // original content left intact
        assert_eq!(
            std::fs::read_to_string(repo.join(".mcp.json")).unwrap(),
            "{ not json"
        );
        let _ = std::fs::remove_dir_all(&repo);
    }
}
