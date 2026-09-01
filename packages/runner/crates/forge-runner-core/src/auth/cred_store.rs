//! Credential store for this machine's Forge credentials: the device token a
//! runner pairs with, and optionally a Personal Access Token.
//!
//! Order of preference:
//!   1. OS keychain via `keyring` (macOS/Windows/Linux secret-service)
//!   2. `0600` file fallback at `~/.config/forge-runner/credentials.json`
//!      (headless Linux / servers with no secret-service)
//!
//! Force a backend with `FORGE_RUNNER_CRED_STORE=keychain|file`. `doctor`
//! reports which one is active and warns when it is the plaintext file.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

// Keychain consts — only referenced on macOS/Windows (Linux uses the file store
// to avoid a libdbus/secret-service dependency).
#[cfg(any(target_os = "macos", target_os = "windows"))]
const SERVICE: &str = "forge-runner";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const LEGACY_SERVICE: &str = "forge-beta";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const DEVICE_ACCOUNT: &str = "device-token";
#[cfg(any(target_os = "macos", target_os = "windows"))]
const PAT_ACCOUNT: &str = "pat";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    Keychain,
    File,
}

impl std::fmt::Display for Backend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Backend::Keychain => write!(f, "keychain"),
            Backend::File => write!(f, "file (0600 plaintext)"),
        }
    }
}

fn forced_backend() -> Option<Backend> {
    match std::env::var("FORGE_RUNNER_CRED_STORE").ok().as_deref() {
        Some("keychain") => Some(Backend::Keychain),
        Some("file") => Some(Backend::File),
        _ => None,
    }
}

/// Which backend a read/write would actually use right now.
pub fn active_backend() -> Backend {
    if let Some(b) = forced_backend() {
        return b;
    }
    // If a file credential already exists, that's what we're using (a prior
    // store fell back to it).
    if file_path().map(|p| p.exists()).unwrap_or(false) {
        return Backend::File;
    }
    // Probe the keychain cheaply (macOS/Windows only).
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if keyring::Entry::new(SERVICE, DEVICE_ACCOUNT)
            .and_then(|e| match e.get_password() {
                Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e),
            })
            .is_ok()
        {
            return Backend::Keychain;
        }
    }
    Backend::File
}

pub fn store_device_token(token: &str) -> Result<()> {
    if matches!(forced_backend(), Some(Backend::File)) {
        return file_store(token);
    }
    // Try the keychain (macOS/Windows); fall back to the file on ANY failure
    // (e.g. a locked secret-service collection). Linux always uses the file
    // store — no libdbus dependency.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match keyring::Entry::new(SERVICE, DEVICE_ACCOUNT).and_then(|e| e.set_password(token)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!("keychain unavailable ({e}); using 0600 file credential store")
            }
        }
    }
    file_store(token)
}

pub fn load_device_token() -> Result<Option<String>> {
    if matches!(forced_backend(), Some(Backend::File)) {
        return file_load();
    }
    // Keychain (macOS/Windows, tolerant of errors) → file → legacy keychain.
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(tok) = keychain_load(SERVICE) {
            return Ok(Some(tok));
        }
    }
    if let Some(tok) = file_load()? {
        return Ok(Some(tok));
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Some(tok) = keychain_load(LEGACY_SERVICE) {
            let _ = store_device_token(&tok); // migrate forward, best-effort
            return Ok(Some(tok));
        }
    }
    Ok(None)
}

pub fn clear_device_token() -> Result<()> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE, DEVICE_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }
    let p = file_path()?;
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

/// The Personal Access Token this machine holds, if any.
///
/// `$FORGE_PAT` wins over anything stored, so a CI job or a one-off shell can
/// speak as a different principal without touching the store.
// cm:guard the env var is read HERE and not at the call site, so every consumer of a PAT resolves it the same way. A second resolution order elsewhere is how one command honours `$FORGE_PAT` and the next quietly ignores it.
pub fn load_pat() -> Result<Option<String>> {
    if let Ok(tok) = std::env::var("FORGE_PAT") {
        let tok = tok.trim();
        if !tok.is_empty() {
            return Ok(Some(tok.to_string()));
        }
    }
    if matches!(forced_backend(), Some(Backend::File)) {
        return file_load_pat();
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Ok(tok) = keyring::Entry::new(SERVICE, PAT_ACCOUNT).and_then(|e| e.get_password()) {
            return Ok(Some(tok));
        }
    }
    file_load_pat()
}

pub fn store_pat(token: &str) -> Result<()> {
    if matches!(forced_backend(), Some(Backend::File)) {
        return file_store_pat(token);
    }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match keyring::Entry::new(SERVICE, PAT_ACCOUNT).and_then(|e| e.set_password(token)) {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!("keychain unavailable ({e}); using 0600 file credential store")
            }
        }
    }
    file_store_pat(token)
}

pub fn clear_pat() -> Result<()> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        if let Ok(entry) = keyring::Entry::new(SERVICE, PAT_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }
    let mut cred = read_cred_file()?;
    if cred.pat.is_some() {
        cred.pat = None;
        write_cred_file(&cred)?;
    }
    Ok(())
}

/// Load from the keychain, treating any error as "absent" so the caller falls
/// through to the file store. (macOS/Windows only.)
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn keychain_load(service: &str) -> Option<String> {
    keyring::Entry::new(service, DEVICE_ACCOUNT)
        .and_then(|e| e.get_password())
        .ok()
}

#[derive(Serialize, Deserialize, Default)]
struct CredFile {
    device_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pat: Option<String>,
}

fn file_path() -> Result<PathBuf> {
    let dir = dirs_next::config_dir()
        .ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))?;
    Ok(dir.join("forge-runner").join("credentials.json"))
}

fn read_cred_file() -> Result<CredFile> {
    let p = file_path()?;
    if !p.exists() {
        return Ok(CredFile::default());
    }
    let raw = std::fs::read_to_string(p)?;
    serde_json::from_str(&raw).map_err(|e| Error::Other(e.to_string()))
}

// cm:guard READ-MODIFY-WRITE, never a fresh CredFile — the file holds two independent credentials now, so serialising one field's value into a default struct silently deletes the other. `forge-runner login` would log the machine out of the REST API it never touched.
fn write_cred_file(cred: &CredFile) -> Result<()> {
    let p = file_path()?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
        restrict_dir(parent);
    }
    let body = serde_json::to_string(cred).map_err(|e| Error::Other(e.to_string()))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    restrict_file(&tmp);
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn file_store(token: &str) -> Result<()> {
    let mut cred = read_cred_file()?;
    cred.device_token = Some(token.to_string());
    write_cred_file(&cred)
}

fn file_load() -> Result<Option<String>> {
    Ok(read_cred_file()?.device_token)
}

fn file_store_pat(token: &str) -> Result<()> {
    let mut cred = read_cred_file()?;
    cred.pat = Some(token.to_string());
    write_cred_file(&cred)
}

fn file_load_pat() -> Result<Option<String>> {
    Ok(read_cred_file()?.pat)
}

#[cfg(unix)]
fn restrict_file(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
}
#[cfg(unix)]
fn restrict_dir(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_file(_p: &std::path::Path) {}
#[cfg(not(unix))]
fn restrict_dir(_p: &std::path::Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// One test, not four: the store reads process-wide env (`XDG_CONFIG_HOME`,
    /// `FORGE_RUNNER_CRED_STORE`) and cargo runs tests in threads, so separate
    /// cases would race each other's config dir.
    #[test]
    fn the_two_credentials_do_not_evict_each_other() {
        let dir = std::env::temp_dir().join(format!("forge-cred-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        std::env::set_var("FORGE_RUNNER_CRED_STORE", "file");
        std::env::remove_var("FORGE_PAT");
        let _ = clear_device_token();
        let _ = clear_pat();

        store_device_token("device-abc").unwrap();
        store_pat("forge_pat_xyz").unwrap();
        assert_eq!(load_device_token().unwrap().as_deref(), Some("device-abc"));
        assert_eq!(load_pat().unwrap().as_deref(), Some("forge_pat_xyz"));

        // The regression: a re-login used to serialise a fresh CredFile and
        // take the PAT with it.
        store_device_token("device-def").unwrap();
        assert_eq!(load_device_token().unwrap().as_deref(), Some("device-def"));
        assert_eq!(
            load_pat().unwrap().as_deref(),
            Some("forge_pat_xyz"),
            "re-pairing the device wiped the REST token it never touched"
        );

        store_pat("forge_pat_second").unwrap();
        assert_eq!(load_device_token().unwrap().as_deref(), Some("device-def"));

        std::env::set_var("FORGE_PAT", "forge_pat_from_env");
        assert_eq!(load_pat().unwrap().as_deref(), Some("forge_pat_from_env"));
        std::env::set_var("FORGE_PAT", "   ");
        assert_eq!(
            load_pat().unwrap().as_deref(),
            Some("forge_pat_second"),
            "a blank FORGE_PAT must fall through to the store, not authenticate as empty"
        );
        std::env::remove_var("FORGE_PAT");

        clear_pat().unwrap();
        assert_eq!(load_pat().unwrap(), None);
        assert_eq!(
            load_device_token().unwrap().as_deref(),
            Some("device-def"),
            "clearing the REST token logged the device out"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
