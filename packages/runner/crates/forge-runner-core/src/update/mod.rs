//! Self version-check + auto-update.
//!
//! Checks a release **manifest** (JSON) for a newer version, downloads the
//! asset for this build's target triple, verifies its sha256, and atomically
//! replaces the running executable. The manifest is served by core
//! (`{core}/install/latest.json`, track C2) or any URL set in config.

pub mod probation;

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

/// What an update check came to.
pub enum Applied {
    /// The release is not newer than this build.
    UpToDate,
    /// The release was installed.
    Installed(UpdateOutcome),
    /// The release is the build an earlier probation put back, so it was not
    /// downloaded (ISS-1378).
    HeldBack {
        rejected: probation::Rejected,
        /// The install path the record stands beside.
        exe: std::path::PathBuf,
    },
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
/// running executable, unless the release is not newer or is the build a
/// probation put back.
///
/// Every update route comes through here, the daemon's check and a hand
/// `forge-runner update` alike, so the record a put-back leaves is read in one
/// place, before anything is downloaded.
pub async fn apply(manifest: &Manifest, keep: Option<&ServedBuild>) -> Result<Applied> {
    if !is_newer(&manifest.version, CURRENT_VERSION) {
        return Ok(Applied::UpToDate);
    }
    // Resolved rather than taken raw, because this is the second update in a
    // process that never restarted after the first: `/proc/self/exe` then reads
    // `<path> (deleted)`, and renaming over THAT writes a file called
    // `forge-runner (deleted)` while the binary everything invokes stays at the
    // build it was (ISS-1200).
    let own = crate::exe::own()?;
    let claim = Claim::of(manifest);
    if let Some(rejected) = held_back(&own.path, &claim)? {
        return Ok(Applied::HeldBack {
            rejected,
            exe: own.path,
        });
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

    if let Some(was) = &own.replaced_from {
        tracing::warn!(
            "[update] this process started on {} which was replaced while it ran — installing over {}, the build standing there now",
            was.display(),
            own.path.display()
        );
    }
    install(&own.path, &bytes, &claim, keep).await?;

    Ok(Applied::Installed(UpdateOutcome {
        from: CURRENT_VERSION.to_string(),
        to: manifest.version.clone(),
    }))
}

/// The build an earlier probation put back from `exe`, where it is the one
/// `claim` names. A record that cannot be read refuses the update rather than
/// letting the build it may name through.
pub fn held_back(exe: &std::path::Path, claim: &Claim) -> Result<Option<probation::Rejected>> {
    match probation::rejected(exe) {
        Ok(Some(r)) if r.names(claim) => Ok(Some(r)),
        Ok(_) => Ok(None),
        Err(why) => Err(Error::Other(format!(
            "not installed: the record of a build an earlier probation put back is unreadable, and read as absent it would let that build be installed again — {why}"
        ))),
    }
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

/// The build a daemon serves, kept beside its install path once an update has
/// installed another build there, so a handover that cannot start the new one
/// can put it back (ISS-1379 criterion 12).
///
/// Before it, the old inode lived on only as this process's own text: a
/// handover whose exec failed left the daemon serving while every hook, every
/// master's `forge-runner run declare` and every command a person typed ran the
/// file that had just failed, and the box declared and bound nothing until
/// somebody reinstalled a build by hand.
///
/// Kept once per process: the first install links what stands at the path,
/// which is the build this process serves, and every later install in the same
/// process leaves that link alone, the path then holding a build it installed
/// itself. The file outlives a handover that succeeds, and the next update's
/// install replaces it.
#[derive(Debug, Default)]
pub struct ServedBuild {
    kept: std::sync::Mutex<Option<Kept>>,
}

/// Where the served build was kept, and the install path it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kept {
    pub exe: std::path::PathBuf,
    pub at: std::path::PathBuf,
}

impl ServedBuild {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Kept>> {
        self.kept.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Keep what stands at `exe` beside it, unless this process already keeps
    /// the build it serves there. Unix only: elsewhere a handover is an exit
    /// for the service manager, and no failure branch is left to restore from.
    #[cfg_attr(not(unix), allow(dead_code))]
    fn keep(&self, exe: &std::path::Path) -> std::io::Result<()> {
        let mut kept = self.lock();
        if kept
            .as_ref()
            .is_some_and(|k| k.exe == exe && k.at.is_file())
        {
            return Ok(());
        }
        let at = kept_path(exe);
        // A build still on probation is no fallback: it has not stayed up.
        // Where one stands at `exe` and a kept build stands beside it, that
        // kept build is the one a failure goes back to, so it stays — a hand
        // update run from a build the daemon installed and has not yet
        // confirmed would otherwise replace the build the box last served
        // with one nothing has shown to start.
        if probation::path(exe).is_file() && at.is_file() {
            *kept = Some(Kept {
                exe: exe.to_path_buf(),
                at,
            });
            return Ok(());
        }
        let mut beside = at.as_os_str().to_os_string();
        beside.push(".tmp");
        let beside = std::path::PathBuf::from(beside);
        let _ = std::fs::remove_file(&beside);
        if std::fs::hard_link(exe, &beside).is_err() {
            std::fs::copy(exe, &beside)?;
        }
        std::fs::rename(&beside, &at)?;
        *kept = Some(Kept {
            exe: exe.to_path_buf(),
            at,
        });
        Ok(())
    }

    /// Put the kept build back at the path it was kept from, answering where
    /// that was, or `None` where this process kept none.
    pub fn restore(&self) -> Result<Option<Kept>> {
        let mut kept = self.lock();
        let Some(k) = kept.take() else {
            return Ok(None);
        };
        if let Err(e) = std::fs::rename(&k.at, &k.exe) {
            let why = format!(
                "the build this process serves, kept at {}, could not be put back at {}: {e}",
                k.at.display(),
                k.exe.display()
            );
            *kept = Some(k);
            return Err(Error::Other(why));
        }
        Ok(Some(k))
    }
}

/// Where the build an install replaced is kept: beside it, under its name.
pub fn kept_path(exe: &std::path::Path) -> std::path::PathBuf {
    let mut name = exe.as_os_str().to_os_string();
    name.push(".served");
    std::path::PathBuf::from(name)
}

/// How long the downloaded build's `--version` may take to answer.
pub const PREFLIGHT_BOUND: std::time::Duration = std::time::Duration::from_secs(10);

/// Install `bytes` at `exe` once they have proved to be the build `claim`
/// names, keeping what stood there where `keep` is given.
pub async fn install(
    exe: &std::path::Path,
    bytes: &[u8],
    claim: &Claim,
    keep: Option<&ServedBuild>,
) -> Result<()> {
    install_within(exe, bytes, claim, keep, PREFLIGHT_BOUND).await
}

/// [`install`], with the pre-flight's bound handed in.
///
/// The file is written beside `exe` and run before anything is renamed: on
/// unix a path can be replaced under a running binary, so the rename is the
/// moment every later caller of that path is committed to the new file, and a
/// file the kernel will not run, or one that exits before it can say what it
/// is, is refused while the build that runs is still the one standing there.
pub async fn install_within(
    exe: &std::path::Path,
    bytes: &[u8],
    claim: &Claim,
    keep: Option<&ServedBuild>,
    bound: std::time::Duration,
) -> Result<()> {
    let tmp = exe.with_extension("new");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
        if let Err(why) = preflight(&tmp, claim, bound).await {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Other(format!(
                "refused the downloaded build before installing it: {why}. {} is untouched and is still the build every caller runs; the next update check downloads the release again and refuses it again until it is one this box can run",
                exe.display()
            )));
        }
        if let Some(served) = keep {
            if let Err(e) = served.keep(exe) {
                let _ = std::fs::remove_file(&tmp);
                return Err(Error::Other(format!(
                    "refused to install over {}: the build standing there could not be kept at {} ({e}), and without it a handover that cannot start the new build would leave every caller on this box with nothing to run",
                    exe.display(),
                    kept_path(exe).display()
                )));
            }
        }
        // The kept build is what a build that will not stay up is put back to,
        // so the probation is written only where one is kept (ISS-1378).
        if keep.is_some() {
            if let Err(e) = probation::begin(exe, &claim.version) {
                let _ = std::fs::remove_file(&tmp);
                return Err(Error::Other(format!(
                    "refused to install over {}: the probation the new build would serve on could not be written at {} ({e}), and without it a build that dies at start is restarted into for ever",
                    exe.display(),
                    probation::path(exe).display()
                )));
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (keep, bound);
    std::fs::rename(&tmp, exe)?;
    // Another release stands at the install path now, so a build an earlier
    // probation put back holds nothing back any more.
    if let Ok(Some(r)) = probation::rejected(exe) {
        if !r.names(claim) {
            if let Err(e) = probation::clear_rejected(exe) {
                tracing::warn!(
                    "[update] {} is installed and the record holding {} back could not be removed from {} ({e})",
                    claim.version,
                    r.version,
                    probation::rejected_path(exe).display()
                );
            }
        }
    }
    Ok(())
}

/// Run `file --version` and require the version, and the commit where one is
/// claimed, that the release names.
#[cfg(unix)]
async fn preflight(
    file: &std::path::Path,
    claim: &Claim,
    bound: std::time::Duration,
) -> std::result::Result<(), String> {
    let shown = format!("`{} --version`", file.display());
    let run = || {
        let mut cmd = tokio::process::Command::new(file);
        cmd.arg("--version")
            .env_remove(crate::daemon::handover::LISTENER_ENV)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        cmd
    };
    // A file just written can be busy for an instant where another thread of
    // this process forked while it was open, which is not the file's fault.
    let mut tries = 0;
    let out = loop {
        tries += 1;
        match tokio::time::timeout(bound, run().output()).await {
            Err(_) => {
                return Err(format!(
                    "{shown} did not answer within {}s",
                    bound.as_secs_f32()
                ))
            }
            Ok(Err(e)) if e.raw_os_error() == Some(nix::libc::ETXTBSY) && tries < 3 => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Ok(Err(e)) => return Err(format!("{shown} could not be run: {e}")),
            Ok(Ok(out)) => break out,
        }
    };
    let said = String::from_utf8_lossy(&out.stdout);
    let line = said.lines().next().unwrap_or("").trim();
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let words = [line, err.trim()]
            .iter()
            .filter(|w| !w.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" / ");
        return Err(format!(
            "{shown} exited {} saying \u{ab}{}\u{bb}",
            out.status,
            excerpt(&words)
        ));
    }
    let bare = |v: &str| v.trim().trim_start_matches('v').to_string();
    let version = line.split_whitespace().nth(1).map(bare);
    if version.as_deref() != Some(bare(&claim.version).as_str()) {
        return Err(format!(
            "{shown} answered \u{ab}{}\u{bb}, which is not version {} the release names",
            excerpt(line),
            claim.version
        ));
    }
    if let Some(commit) = claim.commit.as_deref() {
        if !line.contains(commit.trim()) {
            return Err(format!(
                "{shown} answered \u{ab}{}\u{bb}, which is not commit {commit} the release names",
                excerpt(line)
            ));
        }
    }
    Ok(())
}

#[cfg(unix)]
fn excerpt(text: &str) -> String {
    const MOST: usize = 200;
    match text.char_indices().nth(MOST) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
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

        async fn refused(tag: &str, asset: &str) -> (String, String, PathBuf, Scratch) {
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
            (why, left, exe, dir)
        }

        #[tokio::test]
        async fn a_file_the_kernel_will_not_run_is_refused_and_the_served_build_stays() {
            let (why, left, exe, _dir) =
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
                !probation::path(&exe).exists(),
                "a refused build is put on no probation"
            );
            assert!(
                !exe.with_extension("new").exists(),
                "the refused download is not left beside it"
            );
        }

        #[tokio::test]
        async fn a_build_that_starts_and_exits_at_once_is_refused_and_the_served_build_stays() {
            let (why, left, _, _dir) = refused(
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
            let (why, left, _, _dir) = refused(
                "pre-version",
                "#!/bin/sh\necho 'forge-runner 0.1.5 (good000)'\n",
            )
            .await;
            assert!(why.contains("0.1.5") && why.contains("0.2.0"), "{why}");
            assert_eq!(left, "rc=0 forge-runner 0.1.0 (served0)", "{why}");
        }

        #[tokio::test]
        async fn a_build_naming_another_commit_is_refused() {
            let (why, left, _, _dir) = refused(
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
            assert_eq!(
                probation::enter(&exe, &claim().version),
                probation::Entered::Counted { starts: 1 },
                "ISS-1378 criterion 14: the build installed serves on probation"
            );
            let back = served.restore().expect("restored");
            assert_eq!(
                back,
                Some(Kept {
                    exe: exe.clone(),
                    at: kept_path(&exe)
                })
            );
            assert_eq!(
                runs_as(&exe),
                "rc=0 forge-runner 0.1.0 (served0)",
                "criterion 12: the failure branch puts the served build back"
            );
            assert!(!kept_path(&exe).exists());
            assert_eq!(served.restore().unwrap(), None, "nothing kept twice");
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
            served.restore().unwrap();
            assert_eq!(
                runs_as(&exe),
                "rc=0 forge-runner 0.1.0 (served0)",
                "the build this process serves, not 0.2.0"
            );
            drop(dir);
        }

        /// ISS-1378 criterion 15: the record a put-back leaves holds back the
        /// release it names, and an install of another release lifts it.
        #[tokio::test]
        async fn a_put_back_build_is_held_back_until_another_release_is_installed() {
            let (dir, exe) = a_box("pre-held");
            let rejected = probation::Rejected {
                version: "0.2.0".into(),
                commit: Some("bad0000".into()),
                starts: probation::LIMIT,
                at_ms: 1,
            };
            probation::reject(&exe, &rejected).unwrap();
            let held = Claim {
                version: "0.2.0".into(),
                commit: Some("bad0000".into()),
            };
            assert_eq!(held_back(&exe, &held).unwrap(), Some(rejected));
            assert_eq!(
                held_back(&exe, &claim()).unwrap(),
                None,
                "a re-cut 0.2.0 is another"
            );
            install(&exe, GOOD.as_bytes(), &claim(), Some(&ServedBuild::new()))
                .await
                .expect("installed");
            assert_eq!(probation::rejected(&exe), Ok(None), "lifted by the install");
            std::fs::write(probation::rejected_path(&exe), "{").unwrap();
            let why = held_back(&exe, &held)
                .expect_err("unreadable refuses")
                .to_string();
            assert!(why.contains("not installed"), "{why}");
            drop(dir);
        }

        /// A build installed and not yet confirmed is no fallback: a later
        /// install in another process keeps the build kept before it.
        #[tokio::test]
        async fn an_install_over_a_build_still_on_probation_keeps_the_build_before_it() {
            let (dir, exe) = a_box("pre-unconfirmed");
            install(&exe, GOOD.as_bytes(), &claim(), Some(&ServedBuild::new()))
                .await
                .expect("first, by the daemon");
            let later = Claim {
                version: "0.3.0".into(),
                commit: None,
            };
            let by_hand = ServedBuild::new();
            install(
                &exe,
                b"#!/bin/sh\necho 'forge-runner 0.3.0 (later00)'\n",
                &later,
                Some(&by_hand),
            )
            .await
            .expect("second, by hand, while 0.2.0 is on probation");
            assert_eq!(
                runs_as(&kept_path(&exe)),
                "rc=0 forge-runner 0.1.0 (served0)",
                "the build the box last served stays kept, not the unconfirmed 0.2.0"
            );
            assert_eq!(
                probation::enter(&exe, "0.3.0"),
                probation::Entered::Counted { starts: 1 }
            );
            by_hand.restore().unwrap();
            assert_eq!(runs_as(&exe), "rc=0 forge-runner 0.1.0 (served0)");
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
