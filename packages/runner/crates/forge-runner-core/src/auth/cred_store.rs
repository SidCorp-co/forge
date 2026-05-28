//! Credential store for the device token.
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

const SERVICE: &str = "forge-runner";
const LEGACY_SERVICE: &str = "forge-beta";
const DEVICE_ACCOUNT: &str = "device-token";

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
    // Probe the keychain cheaply: if constructing + reading an entry errors with
    // a storage-access problem, fall back to the file.
    match keyring::Entry::new(SERVICE, DEVICE_ACCOUNT).and_then(|e| match e.get_password() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }) {
        Ok(()) => Backend::Keychain,
        Err(_) => Backend::File,
    }
}

pub fn store_device_token(token: &str) -> Result<()> {
    match active_backend() {
        Backend::Keychain => {
            let entry = keyring::Entry::new(SERVICE, DEVICE_ACCOUNT)
                .map_err(|e| Error::Other(format!("keychain entry: {e}")))?;
            entry
                .set_password(token)
                .map_err(|e| Error::Other(format!("keychain store: {e}")))
        }
        Backend::File => file_store(token),
    }
}

pub fn load_device_token() -> Result<Option<String>> {
    // Prefer the active backend, then opportunistically migrate the legacy
    // `forge-beta` keychain entry (from the old Tauri app) into ours.
    let primary = match active_backend() {
        Backend::Keychain => keychain_load(SERVICE)?,
        Backend::File => file_load()?,
    };
    if primary.is_some() {
        return Ok(primary);
    }
    if matches!(active_backend(), Backend::Keychain) {
        if let Some(tok) = keychain_load(LEGACY_SERVICE)? {
            let _ = store_device_token(&tok); // migrate forward, best-effort
            return Ok(Some(tok));
        }
    }
    Ok(None)
}

pub fn clear_device_token() -> Result<()> {
    if matches!(active_backend(), Backend::Keychain) {
        if let Ok(entry) = keyring::Entry::new(SERVICE, DEVICE_ACCOUNT) {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(e) => return Err(Error::Other(format!("keychain clear: {e}"))),
            }
        }
    }
    let p = file_path()?;
    if p.exists() {
        std::fs::remove_file(p)?;
    }
    Ok(())
}

fn keychain_load(service: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(service, DEVICE_ACCOUNT)
        .map_err(|e| Error::Other(format!("keychain entry: {e}")))?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(Error::Other(format!("keychain load: {e}"))),
    }
}

#[derive(Serialize, Deserialize, Default)]
struct CredFile {
    device_token: Option<String>,
}

fn file_path() -> Result<PathBuf> {
    let dir = dirs_next::config_dir()
        .ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))?;
    Ok(dir.join("forge-runner").join("credentials.json"))
}

fn file_store(token: &str) -> Result<()> {
    let p = file_path()?;
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)?;
        restrict_dir(parent);
    }
    let body = serde_json::to_string(&CredFile {
        device_token: Some(token.to_string()),
    })
    .map_err(|e| Error::Other(e.to_string()))?;
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    restrict_file(&tmp);
    std::fs::rename(&tmp, &p)?;
    Ok(())
}

fn file_load() -> Result<Option<String>> {
    let p = file_path()?;
    if !p.exists() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(p)?;
    let parsed: CredFile = serde_json::from_str(&raw).map_err(|e| Error::Other(e.to_string()))?;
    Ok(parsed.device_token)
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
