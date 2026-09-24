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

/// This build's identity, all three fixed by build.rs.
///
/// `CURRENT_VERSION` is the RELEASED version — the one the release tag carried,
/// stamped in at build time — and not Cargo's, because the released patch is the
/// tag's. `BUILD_COMMIT` is the commit that release was built from, or `unknown`
/// for a build nobody released. Core compares a box against both.
pub const CURRENT_VERSION: &str = env!("FORGE_RUNNER_VERSION");
pub const BUILD_COMMIT: &str = env!("FORGE_RUNNER_COMMIT");
pub const BUILD_TARGET: &str = env!("FORGE_RUNNER_TARGET");

/// What `--version` prints, and what a person reads back off a box.
pub const VERSION_LINE: &str = concat!(
    env!("FORGE_RUNNER_VERSION"),
    " (",
    env!("FORGE_RUNNER_COMMIT"),
    ")"
);

/// The commit this build came from, or None where it was never stamped.
///
/// A build with no commit is not a published one, and saying so is the point:
/// core cannot compare it against `main` and must not call it current.
pub fn build_commit() -> Option<&'static str> {
    commit_or_none(BUILD_COMMIT)
}

/// The reading itself, separate from the constant so it can be asserted against
/// every shape a stamp arrives in rather than against whatever this build got.
fn commit_or_none(raw: &str) -> Option<&str> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "unknown" {
        None
    } else {
        Some(trimmed)
    }
}

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
    // The install routes are reachable under `/api` so the manifest rides the
    // same proxied channel as every other transport call (ISS-392): the hosted
    // edge forwards only `/api/*` to core, and a root `/install/latest.json`
    // 404s into the web app. Self-hosters who expose core directly also serve
    // `/api/install/latest.json` (core dual-mounts the routes).
    core_url.map(|c| format!("{}/api/install/latest.json", c.trim_end_matches('/')))
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
    //
    // Resolved rather than taken raw, because this is the second update in a
    // process that never restarted after the first: `/proc/self/exe` then reads
    // `<path> (deleted)`, and renaming over THAT writes a file called
    // `forge-runner (deleted)` while the binary everything invokes stays at the
    // build it was (ISS-1200).
    let own = crate::exe::own()?;
    if let Some(was) = &own.replaced_from {
        tracing::warn!(
            "[update] this process started on {} which was replaced while it ran — installing over {}, the build standing there now",
            was.display(),
            own.path.display()
        );
    }
    let exe = own.path;
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
    fn an_unstamped_build_has_no_commit_to_report() {
        assert_eq!(commit_or_none("unknown"), None);
        assert_eq!(commit_or_none(""), None);
        assert_eq!(commit_or_none("   "), None);
        assert_eq!(commit_or_none("\n unknown \n"), None);
    }

    #[test]
    fn a_stamped_build_reports_the_commit_it_carries() {
        assert_eq!(
            commit_or_none("fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8"),
            Some("fbe6468ddf0a1b2c3d4e5f60718293a4b5c6d7e8")
        );
        assert_eq!(commit_or_none(" fbe6468 \n"), Some("fbe6468"));
    }

    #[test]
    fn a_commit_that_merely_contains_unknown_is_still_a_commit() {
        assert_eq!(commit_or_none("unknown0"), Some("unknown0"));
    }

    #[test]
    fn the_version_line_carries_both_halves_of_the_identity() {
        assert!(VERSION_LINE.starts_with(CURRENT_VERSION));
        assert!(VERSION_LINE.contains(BUILD_COMMIT));
        assert!(VERSION_LINE.ends_with(')'));
    }

    /// `apply` downloads before it renames, so its rename target cannot be
    /// exercised here without a release server. What CAN be asserted is that it
    /// no longer takes the raw link: a second update in a process that never
    /// restarted would otherwise write a file called `forge-runner (deleted)`
    /// and leave the real binary at the build it was (ISS-1200).
    #[test]
    fn the_install_target_is_resolved_rather_than_read_off_proc_self_exe() {
        const SOURCE: &str = include_str!("mod.rs");
        let body = SOURCE
            .split("pub async fn apply(")
            .nth(1)
            .and_then(|s| s.split("\n#[cfg(test)]").next())
            .expect("apply's body");
        assert!(
            !body.contains("current_exe()"),
            "apply renames over whatever /proc/self/exe says, annotation and all"
        );
        assert!(
            body.contains("crate::exe::own()"),
            "apply must resolve the path it installs over"
        );
    }

    #[test]
    fn manifest_url_prefers_config() {
        assert_eq!(
            manifest_url(Some("https://x/m.json"), Some("https://core")),
            Some("https://x/m.json".into())
        );
        assert_eq!(
            manifest_url(None, Some("https://core/")),
            Some("https://core/api/install/latest.json".into())
        );
        assert_eq!(manifest_url(None, None), None);
    }
}
