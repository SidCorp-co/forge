//! Self version-check + auto-update.
//!
//! Checks a release **manifest** (JSON) for a newer version, downloads the
//! asset for this build's target triple, verifies its sha256, and atomically
//! replaces the running executable. The manifest is served by core
//! (`{core}/install/latest.json`, track C2) or any URL set in config.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use crate::error::{Error, Result};

/// This build's version (from Cargo) and target triple (from build.rs).
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const BUILD_TARGET: &str = env!("FORGE_RUNNER_TARGET");

#[derive(Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    /// target-triple -> downloadable asset.
    #[serde(default)]
    pub assets: HashMap<String, Asset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub url: String,
    #[serde(default)]
    pub sha256: Option<String>,
}

pub struct UpdateOutcome {
    pub from: String,
    pub to: String,
}

/// Resolve the manifest URL: an explicit config value wins, else derive it from
/// the core URL. Returns None when neither is available.
pub fn manifest_url(configured: Option<&str>, core_url: Option<&str>) -> Option<String> {
    if let Some(u) = configured.filter(|s| !s.is_empty()) {
        return Some(u.to_string());
    }
    core_url.map(|c| format!("{}/install/latest.json", c.trim_end_matches('/')))
}

pub async fn fetch_manifest(url: &str) -> Result<Manifest> {
    let resp = reqwest::Client::new()
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| Error::Other(format!("fetch manifest: {e}")))?;
    if !resp.status().is_success() {
        return Err(Error::Other(format!("manifest {}", resp.status())));
    }
    resp.json::<Manifest>()
        .await
        .map_err(|e| Error::Other(format!("parse manifest: {e}")))
}

/// `latest` is a higher X.Y.Z than `current` (pre-release suffix ignored).
pub fn is_newer(latest: &str, current: &str) -> bool {
    parse(latest) > parse(current)
}

fn parse(v: &str) -> (u64, u64, u64) {
    let core = v
        .trim()
        .trim_start_matches('v')
        .split('-')
        .next()
        .unwrap_or("");
    let mut it = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    )
}

/// Download the matching asset, verify its sha256, and atomically replace the
/// running executable. Returns Ok(None) when already up to date.
pub async fn apply(manifest: &Manifest) -> Result<Option<UpdateOutcome>> {
    if !is_newer(&manifest.version, CURRENT_VERSION) {
        return Ok(None);
    }
    let asset = manifest
        .assets
        .get(BUILD_TARGET)
        .ok_or_else(|| Error::Other(format!("no release asset for target {BUILD_TARGET}")))?;

    let bytes = reqwest::Client::new()
        .get(&asset.url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| Error::Other(format!("download: {e}")))?
        .bytes()
        .await
        .map_err(|e| Error::Other(format!("download body: {e}")))?;

    if let Some(want) = &asset.sha256 {
        use sha2::{Digest, Sha256};
        let got = hex::encode(Sha256::digest(&bytes));
        if !got.eq_ignore_ascii_case(want) {
            return Err(Error::Other(format!(
                "sha256 mismatch (got {got}, want {want})"
            )));
        }
    }

    // Write next to the current exe, chmod, then rename over it. On Unix you can
    // replace a running binary's path — the live process keeps the old inode,
    // and the next start picks up the new file.
    let exe = std::env::current_exe().map_err(|e| Error::Other(format!("current_exe: {e}")))?;
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, &bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &exe)?;

    Ok(Some(UpdateOutcome {
        from: CURRENT_VERSION.to_string(),
        to: manifest.version.clone(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_compare() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.9.9"));
        assert!(is_newer("0.1.10", "0.1.2"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.1.0", "0.2.0"));
        assert!(is_newer("v0.2.0-rc.1", "0.1.0"));
    }

    #[test]
    fn manifest_url_prefers_config() {
        assert_eq!(
            manifest_url(Some("https://x/m.json"), Some("https://core")),
            Some("https://x/m.json".into())
        );
        assert_eq!(
            manifest_url(None, Some("https://core/")),
            Some("https://core/install/latest.json".into())
        );
        assert_eq!(manifest_url(None, None), None);
    }
}
