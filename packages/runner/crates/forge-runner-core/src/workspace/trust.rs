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
