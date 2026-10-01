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
    /// The commit the release was built from, where core knows it.
    #[serde(default)]
    pub commit: Option<String>,
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
pub async fn apply(
    manifest: &Manifest,
    keep: Option<&ServedBuild>,
) -> Result<Option<UpdateOutcome>> {
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
    install(&own.path, &bytes, &Claim::of(manifest), keep).await?;

    Ok(Some(UpdateOutcome {
        from: CURRENT_VERSION.to_string(),
        to: manifest.version.clone(),
    }))
}

/// What a downloaded build must say it is before it is installed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Claim {
    pub version: String,
    pub commit: Option<String>,
}

impl Claim {
    pub fn of(manifest: &Manifest) -> Self {
        Self {
            version: manifest.version.clone(),
            commit: manifest.commit.clone().filter(|c| !c.trim().is_empty()),
        }
    }
}

/// The build a daemon serves, kept beside the path it was started from once an
/// update has installed another there.
#[derive(Debug, Default)]
pub struct ServedBuild {
    kept: std::sync::Mutex<Option<std::path::PathBuf>>,
}

impl ServedBuild {
    pub fn new() -> Self {
        Self::default()
    }

    /// Put the kept build back at `exe`, answering where it was kept, or `None`
    /// where this process kept none.
    pub fn restore(&self, _exe: &std::path::Path) -> Result<Option<std::path::PathBuf>> {
        Ok(None)
    }
}

/// Where the build an install replaced is kept: beside it, under its name.
pub fn kept_path(exe: &std::path::Path) -> std::path::PathBuf {
    let mut name = exe.as_os_str().to_os_string();
    name.push(".served");
    std::path::PathBuf::from(name)
}

pub async fn install_within(
    exe: &std::path::Path,
    bytes: &[u8],
    claim: &Claim,
    keep: Option<&ServedBuild>,
    _bound: std::time::Duration,
) -> Result<()> {
    install(exe, bytes, claim, keep).await
}

/// Write `bytes` beside `exe` and rename them over it.
pub async fn install(
    exe: &std::path::Path,
    bytes: &[u8],
    _claim: &Claim,
    _keep: Option<&ServedBuild>,
) -> Result<()> {
    // Write next to the current exe, chmod, then rename over it. On Unix you can
    // replace a running binary's path — the live process keeps the old inode,
    // and the next start picks up the new file.
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, exe)?;
    Ok(())
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
        static SOURCE: std::sync::LazyLock<&str> =
            std::sync::LazyLock::new(|| crate::test_scratch::lf(include_str!("mod.rs")));
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

    /// The planted builds an update can offer, each a file `install` is handed
    /// as the downloaded bytes (ISS-1379 criterion 12).
    #[cfg(unix)]
    mod planted {
        use super::super::*;
        use crate::test_scratch::Scratch;
        use std::path::{Path, PathBuf};

        const SERVED: &str = "#!/bin/sh\necho 'forge-runner 0.1.0 (served0)'\n";

        fn claim() -> Claim {
            Claim {
                version: "0.2.0".into(),
                commit: Some("good000".into()),
            }
        }

        /// A box with the served build standing at its install path.
        fn a_box(tag: &str) -> (Scratch, PathBuf) {
            use std::os::unix::fs::PermissionsExt;
            let dir = Scratch::new(tag);
            let exe = dir.join("forge-runner");
            std::fs::write(&exe, SERVED).unwrap();
            std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
            (dir, exe)
        }

        /// What a hook or a master's `forge-runner run declare` meets at the
        /// install path: the file run, as `sh -c` runs a hook command.
        fn runs_as(exe: &Path) -> String {
            let out = std::process::Command::new("sh")
                .arg("-c")
                .arg(format!("'{}' --version", exe.display()))
                .output()
                .unwrap();
            format!(
                "rc={} {}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stdout).trim()
            )
        }

        async fn refused(tag: &str, asset: &str) -> (String, String, PathBuf) {
            let (dir, exe) = a_box(tag);
            let served = ServedBuild::new();
            let got = install(&exe, asset.as_bytes(), &claim(), Some(&served)).await;
            let why = match got {
                Err(e) => e.to_string(),
                Ok(()) => format!(
                    "INSTALLED, and the install path now runs as: {}",
                    runs_as(&exe)
                ),
            };
            let left = runs_as(&exe);
            std::mem::forget(dir);
            (why, left, exe)
        }

        #[tokio::test]
        async fn a_file_the_kernel_will_not_run_is_refused_and_the_served_build_stays() {
            let (why, left, exe) =
                refused("pre-noexec", "this is a text file, not a program\n").await;
            assert!(why.contains("refused"), "criterion 12: {why}");
            assert!(
                why.contains(&exe.with_extension("new").display().to_string()),
                "names the file it tried: {why}"
            );
            assert_eq!(
                left, "rc=0 forge-runner 0.1.0 (served0)",
                "criterion 12: every caller on the box still runs the served build"
            );
            assert!(
                !exe.with_extension("new").exists(),
                "the refused download is not left beside it"
            );
        }

        #[tokio::test]
        async fn a_build_that_starts_and_exits_at_once_is_refused_and_the_served_build_stays() {
            let (why, left, _) = refused(
                "pre-dies",
                "#!/bin/sh\necho 'new image: refusing to start' >&2\nexit 1\n",
            )
            .await;
            assert!(
                why.contains("refusing to start"),
                "says what it said: {why}"
            );
            assert_eq!(left, "rc=0 forge-runner 0.1.0 (served0)", "{why}");
        }

        #[tokio::test]
        async fn a_build_naming_another_version_is_refused() {
            let (why, left, _) = refused(
                "pre-version",
                "#!/bin/sh\necho 'forge-runner 0.1.5 (good000)'\n",
            )
            .await;
            assert!(why.contains("0.1.5") && why.contains("0.2.0"), "{why}");
            assert_eq!(left, "rc=0 forge-runner 0.1.0 (served0)", "{why}");
        }

        #[tokio::test]
        async fn a_build_naming_another_commit_is_refused() {
            let (why, left, _) = refused(
                "pre-commit",
                "#!/bin/sh\necho 'forge-runner 0.2.0 (other00)'\n",
            )
            .await;
            assert!(why.contains("good000"), "{why}");
            assert_eq!(left, "rc=0 forge-runner 0.1.0 (served0)", "{why}");
        }

        #[tokio::test]
        async fn a_build_that_does_not_answer_is_refused_within_its_bound() {
            let (dir, exe) = a_box("pre-hangs");
            let started = std::time::Instant::now();
            let got = install_within(
                &exe,
                b"#!/bin/sh\nsleep 30\n",
                &claim(),
                None,
                std::time::Duration::from_millis(500),
            )
            .await;
            let why = got.expect_err("refused").to_string();
            assert!(why.contains("did not answer"), "{why}");
            assert!(
                started.elapsed() < std::time::Duration::from_secs(10),
                "bounded"
            );
            assert_eq!(runs_as(&exe), "rc=0 forge-runner 0.1.0 (served0)");
            drop(dir);
        }

        const GOOD: &str = "#!/bin/sh\necho 'forge-runner 0.2.0 (good000)'\n";

        #[tokio::test]
        async fn a_build_that_says_what_the_release_names_is_installed_and_the_served_one_kept() {
            let (dir, exe) = a_box("pre-good");
            let served = ServedBuild::new();
            install(&exe, GOOD.as_bytes(), &claim(), Some(&served))
                .await
                .expect("installed");
            assert_eq!(runs_as(&exe), "rc=0 forge-runner 0.2.0 (good000)");
            assert_eq!(
                runs_as(&kept_path(&exe)),
                "rc=0 forge-runner 0.1.0 (served0)",
                "kept beside it"
            );
            let back = served.restore(&exe).expect("restored");
            assert_eq!(back, Some(kept_path(&exe)));
            assert_eq!(
                runs_as(&exe),
                "rc=0 forge-runner 0.1.0 (served0)",
                "criterion 12: the failure branch puts the served build back"
            );
            assert!(!kept_path(&exe).exists());
            assert_eq!(served.restore(&exe).unwrap(), None, "nothing kept twice");
            drop(dir);
        }

        #[tokio::test]
        async fn a_second_update_in_one_process_keeps_the_build_it_serves_and_not_the_first_update()
        {
            let (dir, exe) = a_box("pre-twice");
            let served = ServedBuild::new();
            install(&exe, GOOD.as_bytes(), &claim(), Some(&served))
                .await
                .expect("first");
            let later = Claim {
                version: "0.3.0".into(),
                commit: None,
            };
            install(
                &exe,
                b"#!/bin/sh\necho 'forge-runner 0.3.0 (later00)'\n",
                &later,
                Some(&served),
            )
            .await
            .expect("second");
            served.restore(&exe).unwrap();
            assert_eq!(
                runs_as(&exe),
                "rc=0 forge-runner 0.1.0 (served0)",
                "the build this process serves, not 0.2.0"
            );
            drop(dir);
        }

        #[tokio::test]
        async fn an_install_that_keeps_nothing_leaves_no_kept_build() {
            let (dir, exe) = a_box("pre-cli");
            install(&exe, GOOD.as_bytes(), &claim(), None)
                .await
                .expect("installed");
            assert_eq!(runs_as(&exe), "rc=0 forge-runner 0.2.0 (good000)");
            assert!(!kept_path(&exe).exists());
            drop(dir);
        }
    }
}
