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

/// The `.claude.json` a session started on this box reads its folder trust
/// from, by the same resolution the write uses: `CLAUDE_CONFIG_DIR` first,
/// the home directory otherwise.
pub fn config_path() -> Option<PathBuf> {
    claude_json_path()
}

/// What `.claude.json` says about one folder, read and never written
/// (ISS-1382): `forge-runner doctor` reports it for every bound checkout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrustState {
    /// Every spelling the pre-trust write stamps reads `true`.
    Trusted,
    /// These spellings do not: the entry is absent, the key is, or it is not `true`.
    Untrusted { keys: Vec<String> },
    /// There is no `.claude.json` at all yet.
    NoFile,
    /// The file is there and cannot be read, parsed or stamped: why, and the
    /// edit that makes it one the pre-trust write can stamp.
    Unreadable { why: String, fix: String },
}

impl TrustState {
    fn unreadable(why: impl Into<String>, fix: impl Into<String>) -> Self {
        Self::Unreadable {
            why: why.into(),
            fix: fix.into(),
        }
    }
}

/// What `json_path` says about `dir`, under every spelling [`pre_trust`] stamps.
pub fn state_in(json_path: &Path, dir: &Path) -> TrustState {
    let root = match std::fs::read(json_path) {
        Ok(bytes) => match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(v) => v,
            Err(e) => {
                return TrustState::unreadable(
                    format!("it is not valid JSON: {e}"),
                    "correct the JSON, or move the file aside so it is written afresh",
                )
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TrustState::NoFile,
        Err(e) => {
            return TrustState::unreadable(
                format!("it could not be read: {e}"),
                "make it a file this user can read and write",
            )
        }
    };
    if let Some(r) = refusal(&root, &keys_for(dir)) {
        return TrustState::unreadable(r.why, r.fix);
    }
    let keys: Vec<String> = keys_for(dir)
        .into_iter()
        .filter(|k| {
            root.get("projects")
                .and_then(|p| p.get(k))
                .and_then(|e| e.get(TRUST_FIELD))
                .and_then(serde_json::Value::as_bool)
                != Some(true)
        })
        .collect();
    if keys.is_empty() {
        TrustState::Trusted
    } else {
        TrustState::Untrusted { keys }
    }
}

/// The key a folder's trust is kept under, for a reader to be told.
pub const KEY: &str = TRUST_FIELD;

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
    let keys = keys_for(dir);
    if let Some(r) = refusal(&root, &keys) {
        return Err(format!("{}: {} — to fix it, {}", json_path.display(), r.why, r.fix));
    }

    let mut wrote = false;
    for key in keys {
        let projects = root
            .as_object_mut()
            .expect("refusal() took a root that is no object")
            .entry("projects")
            .or_insert_with(|| serde_json::json!({}));
        let entry = projects
            .as_object_mut()
            .expect("refusal() took a `projects` that is no object")
            .entry(key)
            .or_insert_with(|| serde_json::json!({}));
        let obj = entry
            .as_object_mut()
            .expect("refusal() took an entry that is no object");
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

/// Why the pre-trust write refuses `root` for `keys`, and the edit that lets it
/// stamp them; `None` where it can. One answer for the write and for
/// [`state_in`], so doctor never says the daemon's write will land in a file
/// that write refuses (ISS-1344, from ISS-1382's judge).
fn refusal(root: &serde_json::Value, keys: &[String]) -> Option<Refusal> {
    if !root.is_object() {
        return Some(Refusal {
            why: "it is not a JSON object",
            fix: "make the file's top level a JSON object, such as {}".into(),
        });
    }
    let projects = root.get("projects")?;
    if !projects.is_object() {
        return Some(Refusal {
            why: "`projects` is not an object",
            fix: r#"make `projects` an object keyed by checkout path, such as "projects": {}"#.into(),
        });
    }
    let key = keys
        .iter()
        .find(|k| projects.get(k.as_str()).is_some_and(|e| !e.is_object()))?;
    Some(Refusal {
        why: "a project entry is not an object",
        fix: format!(r#"make projects["{key}"] an object, such as {{}}, or remove it"#),
    })
}

struct Refusal {
    why: &'static str,
    fix: String,
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

    fn temp(name: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("trust-{name}"))
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

    #[test]
    fn the_read_names_each_state_and_never_writes() {
        let dir = temp("state");
        let json = dir.join(".claude.json");
        assert_eq!(state_in(&json, Path::new("/srv/x")), TrustState::NoFile);
        assert!(!json.exists(), "a read creates nothing");

        let seeded = br#"{"projects":{"/srv/x":{"hasTrustDialogAccepted":true},"/srv/f":{"hasTrustDialogAccepted":false},"/srv/k":{}}}"#;
        std::fs::write(&json, seeded).expect("seed");
        assert_eq!(state_in(&json, Path::new("/srv/x")), TrustState::Trusted);
        for untrusted in ["/srv/f", "/srv/k", "/srv/absent"] {
            assert_eq!(
                state_in(&json, Path::new(untrusted)),
                TrustState::Untrusted {
                    keys: vec![untrusted.to_string()]
                }
            );
        }
        assert_eq!(
            std::fs::read(&json).expect("read"),
            seeded.to_vec(),
            "byte-identical"
        );

        std::fs::write(&json, b"not json").expect("seed");
        assert!(
            matches!(state_in(&json, Path::new("/srv/x")), TrustState::Unreadable { why, .. } if why.contains("not valid JSON"))
        );
        std::fs::write(&json, b"[]").expect("seed");
        assert!(
            matches!(state_in(&json, Path::new("/srv/x")), TrustState::Unreadable { why, .. } if why.contains("not a JSON object"))
        );
        std::fs::remove_file(&json).expect("rm");
        std::fs::create_dir(&json).expect("a directory where the file goes");
        assert!(
            matches!(state_in(&json, Path::new("/srv/x")), TrustState::Unreadable { why, .. } if why.contains("could not be read"))
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_checkout_is_trusted_only_under_both_spellings() {
        let dir = temp("state-link");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).expect("real dir");
        let link = dir.join("link");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");
        let json = dir.join(".claude.json");
        let literal = link.to_string_lossy().into_owned();
        std::fs::write(
            &json,
            serde_json::json!({"projects": {literal.clone(): {"hasTrustDialogAccepted": true}}})
                .to_string(),
        )
        .expect("seed");
        let canonical = std::fs::canonicalize(&real)
            .expect("canonical")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            state_in(&json, &link),
            TrustState::Untrusted {
                keys: vec![canonical]
            },
            "the spelling the write also stamps is missing"
        );
        assert!(trust_in(&json, &link).expect("stamp"));
        assert_eq!(state_in(&json, &link), TrustState::Trusted);
        std::fs::remove_dir_all(&dir).ok();
    }
}
