//! Pre-trusting a checkout, so an interactive session never meets the
//! workspace-trust dialog.
//!
//! Claude Code asks a human to trust a folder the first time it opens one, and
//! it asks in a TTY only — `-p` and the SDK skip it. Every pipeline agent this
//! box starts is `-p`; the resident master is not, it lives in a tmux pane, and
//! a pane holding an unanswered dialog is a session that ends without doing
//! anything. There is no managed-settings key for this: the record Claude Code
//! reads is `projects["<abs dir>"].hasTrustDialogAccepted` in its own config
//! JSON, so that is what this writes.

use std::path::{Path, PathBuf};

const TRUST_FIELD: &str = "hasTrustDialogAccepted";

/// Where the CLI keeps that record: `$CLAUDE_CONFIG_DIR/.claude.json` when the
/// operator set one, else `~/.claude.json`.
// cm:guard this is NOT `plugin_sync::claude_config_dir().join(...)` and the difference is a real one: with no override the config DIRECTORY is `~/.claude` while this file is `~/.claude.json` beside it, so composing the two resolvers writes a file the CLI never reads and the dialog still fires.
fn claude_json_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join(".claude.json"));
        }
    }
    dirs_next::home_dir().map(|h| h.join(".claude.json"))
}

/// Record `dir` as trusted. `Ok(true)` when the file was written, `Ok(false)`
/// when it already said so.
pub fn pre_trust(dir: &Path) -> Result<bool, String> {
    let json = claude_json_path().ok_or_else(|| "cannot resolve the home directory".to_string())?;
    trust_in(&json, dir)
}

/// Best-effort wrapper for the callers that must not fail over this: a session
/// started in an untrusted folder is worse than one started in a trusted one,
/// and both are better than a workspace that never reaches `ready`.
pub fn pre_trust_logged(dir: &Path, what: &str) {
    match pre_trust(dir) {
        Ok(true) => tracing::info!("[trust] {what}: {} marked trusted", dir.display()),
        Ok(false) => {}
        Err(e) => tracing::warn!(
            "[trust] {what}: could not pre-trust {} ({e}) — an interactive session there may stop on the workspace-trust prompt",
            dir.display()
        ),
    }
}

/// The whole edit, against an explicit config path so a test can own one.
// cm:guard read-modify-write on a file Claude Code also owns, so the write happens ONLY when the field is missing or false. That is once per checkout per box, which is what keeps the clobber window a one-off rather than a thing this daemon does every 30 seconds beside a live session rewriting the same file.
// cm:guard refuse a config whose top level is not an object rather than replacing it. Anything else there is a shape this code does not understand, and overwriting it costs an operator their MCP servers, their history and their auth — the dialog costs them one keystroke.
fn trust_in(json_path: &Path, dir: &Path) -> Result<bool, String> {
    let mut root = match std::fs::read(json_path) {
        Ok(bytes) => serde_json::from_slice::<serde_json::Value>(&bytes)
            .map_err(|e| format!("{} is not valid JSON: {e}", json_path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::json!({}),
        Err(e) => return Err(format!("read {}: {e}", json_path.display())),
    };
    if !root.is_object() {
        return Err(format!("{} is not a JSON object", json_path.display()));
    }

    let mut wrote = false;
    for key in keys_for(dir) {
        let projects = root
            .as_object_mut()
            .expect("checked above")
            .entry("projects")
            .or_insert_with(|| serde_json::json!({}));
        let Some(map) = projects.as_object_mut() else {
            return Err(format!(
                "{}: `projects` is not an object",
                json_path.display()
            ));
        };
        let entry = map.entry(key).or_insert_with(|| serde_json::json!({}));
        let Some(obj) = entry.as_object_mut() else {
            return Err(format!(
                "{}: a project entry is not an object",
                json_path.display()
            ));
        };
        if obj.get(TRUST_FIELD).and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        obj.insert(TRUST_FIELD.into(), serde_json::Value::Bool(true));
        wrote = true;
    }
    if !wrote {
        return Ok(false);
    }
    write_atomic(json_path, &root)?;
    Ok(true)
}

/// The path spellings Claude Code could key this folder under.
// cm:guard the CLI keys by the cwd it observes, which is `getcwd()` — symlinks already resolved — while tmux is handed the path as configured. Stamp both when they differ: guessing one and getting it wrong leaves the dialog exactly where it was, and the whole cost of being wrong is one extra key in a file that already holds ten.
fn keys_for(dir: &Path) -> Vec<String> {
    let literal = dir.to_string_lossy().into_owned();
    let mut keys = vec![literal.clone()];
    if let Ok(real) = std::fs::canonicalize(dir) {
        let real = real.to_string_lossy().into_owned();
        if real != literal {
            keys.push(real);
        }
    }
    keys
}

/// `.tmp` + rename, carrying the original file's mode.
// cm:guard the mode is copied from the file being replaced, and the fallback is 0600. This file holds the CLI's OAuth account and its MCP server arguments; a rename that widened it to the umask default would publish those to every user on the box, silently and permanently.
fn write_atomic(json_path: &Path, root: &serde_json::Value) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(root).map_err(|e| format!("serialize: {e}"))?;
    let tmp = json_path.with_extension("json.forge-tmp");
    if let Some(parent) = json_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&tmp, &body).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(json_path)
            .map(|m| m.permissions().mode() & 0o777)
            .unwrap_or(0o600);
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(mode));
    }
    std::fs::rename(&tmp, json_path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename onto {}: {e}", json_path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "forge-trust-{name}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    fn read(path: &Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).expect("read back")).expect("valid json")
    }

    #[test]
    fn an_untrusted_path_gains_the_field_and_the_file_keeps_everything_else() {
        let dir = temp("keeps");
        let json = dir.join(".claude.json");
        std::fs::write(
            &json,
            br#"{"numStartups":41,"projects":{"/other":{"hasTrustDialogAccepted":true,"history":[1]}}}"#,
        )
        .expect("seed");

        assert!(trust_in(&json, Path::new("/srv/checkout")).expect("stamp"));

        let v = read(&json);
        assert_eq!(
            v["numStartups"], 41,
            "an unrelated top-level key must survive"
        );
        assert_eq!(
            v["projects"]["/other"]["history"][0], 1,
            "another project's own keys must survive"
        );
        assert_eq!(v["projects"]["/srv/checkout"][TRUST_FIELD], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    // cm:guard the second call must not write. Claude Code rewrites this file constantly from its own
    // process, so a stamp that ran on every sweep would be a clobber race scheduled twice a minute.
    #[test]
    fn a_path_already_trusted_is_not_rewritten() {
        let dir = temp("idempotent");
        let json = dir.join(".claude.json");
        std::fs::write(
            &json,
            br#"{"projects":{"/srv/x":{"hasTrustDialogAccepted":true}}}"#,
        )
        .expect("seed");
        let before = std::fs::metadata(&json).expect("stat").len();

        assert!(
            !trust_in(&json, Path::new("/srv/x")).expect("stamp"),
            "an already-trusted path is not a write"
        );
        assert_eq!(std::fs::metadata(&json).expect("stat").len(), before);
        std::fs::remove_dir_all(&dir).ok();
    }

    // cm:guard `false` is the shape the dialog actually leaves behind — a dismissed prompt, not an
    // absent key — so a check that only tested for absence would skip the one box that needs this.
    #[test]
    fn an_explicit_false_is_corrected() {
        let dir = temp("false");
        let json = dir.join(".claude.json");
        std::fs::write(
            &json,
            br#"{"projects":{"/srv/x":{"hasTrustDialogAccepted":false}}}"#,
        )
        .expect("seed");
        assert!(trust_in(&json, Path::new("/srv/x")).expect("stamp"));
        assert_eq!(read(&json)["projects"]["/srv/x"][TRUST_FIELD], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_config_is_created_rather_than_refused() {
        let dir = temp("create");
        let json = dir.join(".claude.json");
        assert!(trust_in(&json, Path::new("/srv/x")).expect("stamp"));
        assert_eq!(read(&json)["projects"]["/srv/x"][TRUST_FIELD], true);
        std::fs::remove_dir_all(&dir).ok();
    }

    // cm:guard a config this code cannot parse is REFUSED, never replaced: the file holds the CLI's
    // account, its MCP servers and its history, and the dialog it would spare costs one keystroke.
    #[test]
    fn an_unparseable_config_is_refused_and_left_alone() {
        let dir = temp("refuse");
        let json = dir.join(".claude.json");
        std::fs::write(&json, b"not json at all").expect("seed");
        assert!(trust_in(&json, Path::new("/srv/x")).is_err());
        assert_eq!(
            std::fs::read(&json).expect("read"),
            b"not json at all".to_vec()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn the_files_mode_survives_the_rewrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp("mode");
        let json = dir.join(".claude.json");
        std::fs::write(&json, b"{}").expect("seed");
        std::fs::set_permissions(&json, std::fs::Permissions::from_mode(0o600)).expect("chmod");

        assert!(trust_in(&json, Path::new("/srv/x")).expect("stamp"));

        let mode = std::fs::metadata(&json).expect("stat").permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "a widened mode publishes the CLI's credentials"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    // cm:guard tmux is given the path as configured and the CLI keys by `getcwd()`, so a symlinked
    // checkout has two spellings and stamping one of them leaves the dialog where it was.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_checkout_is_stamped_under_both_spellings() {
        let dir = temp("symlink");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let json = dir.join(".claude.json");

        assert!(trust_in(&json, &link).expect("stamp"));

        let v = read(&json);
        let projects = v["projects"].as_object().expect("projects");
        assert!(projects.contains_key(&link.to_string_lossy().into_owned()));
        assert!(projects.contains_key(
            &std::fs::canonicalize(&real)
                .expect("canonical")
                .to_string_lossy()
                .into_owned()
        ));
        std::fs::remove_dir_all(&dir).ok();
    }
}
