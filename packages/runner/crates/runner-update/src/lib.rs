//! Self version-check + auto-update.
//!
//! Checks a release **manifest** (JSON) for a newer version, downloads the
//! asset for this build's target triple, verifies its sha256, and atomically
//! replaces the running executable. The manifest is served by core
//! (`{core}/install/latest.json`, track C2) or any URL set in config.

use std::collections::HashMap;
use std::time::Duration;

use serde::Deserialize;

use runner_platform::error::{Error, Result};

pub mod probation;

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
    /// Required: a manifest naming an asset without one is refused whole by
    /// serde, and an empty one is refused by [`apply`], so nothing is ever
    /// installed unverified. Core's `/install/latest.json` always sends it.
    pub sha256: String,
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
    resp.json::<Manifest>().await.map_err(|e| {
        Error::Other(format!(
            "parse manifest {url}: {e} — a manifest is refused whole where any asset lacks its sha256, so no build is installed unverified"
        ))
    })
}

/// `latest` sorts above `current` by semver precedence: X.Y.Z compared as
/// numbers, then a version with a pre-release (`-rc.1`, `-dev.3`) below the
/// same X.Y.Z without one, pre-release identifiers compared one by one, numeric
/// ones as numbers and below any alphanumeric one. Build metadata (`+…`) is
/// ignored. So a box on `0.9.10-rc.1` takes `0.9.10`, and `-dev.10` is newer
/// than `-dev.9`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    precedence(latest) > precedence(current)
}

/// One pre-release identifier: numeric sorts below alphanumeric.
#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Ident {
    Num(u64),
    Alpha(String),
}

/// The ordering key of a version. The trailing flag puts a release (`true`)
/// above any pre-release of the same X.Y.Z (`false`), which then compares by
/// its identifiers.
fn precedence(v: &str) -> ((u64, u64, u64), bool, Vec<Ident>) {
    let v = v.trim().trim_start_matches('v');
    let v = v.split('+').next().unwrap_or("");
    let (core, pre) = match v.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (v, None),
    };
    let mut it = core.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
    let xyz = (
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
        it.next().unwrap_or(0),
    );
    let idents = pre
        .unwrap_or("")
        .split('.')
        .filter(|p| !p.is_empty())
        .map(|p| match p.parse::<u64>() {
            Ok(n) => Ident::Num(n),
            Err(_) => Ident::Alpha(p.to_string()),
        })
        .collect();
    (xyz, pre.is_none(), idents)
}

/// How long the asset download may take, body included. A connection that
/// stalls mid-body would otherwise hold the update actor in this await for
/// good, and the box would never check for or apply another release.
pub const DOWNLOAD_BOUND: Duration = Duration::from_secs(10 * 60);

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
    let own = runner_platform::exe::own()?;
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

    if cfg!(windows) {
        return Err(Error::Other(format!(
            "{} is available, and self-update is refused on Windows: this build cannot replace its own running executable there, and no service manager is installed to start the new one. Stop forge-runner, install {} from the release by hand, and start it again",
            manifest.version, manifest.version
        )));
    }
    let want = asset.sha256.trim();
    if want.is_empty() {
        return Err(Error::Other(format!(
            "refused the {BUILD_TARGET} asset of {}: its sha256 is empty, so it cannot be verified and is not downloaded",
            manifest.version
        )));
    }
    let bytes = download(&asset.url).await?;
    {
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

/// The asset's bytes, within [`DOWNLOAD_BOUND`]; a stall past it is an error
/// naming the bound, which the caller warns of and the next check retries.
async fn download(url: &str) -> Result<Vec<u8>> {
    let timed_out = |e: &reqwest::Error| {
        Error::Other(format!(
            "download {url} did not finish within {}s ({e}); the next update check retries it",
            DOWNLOAD_BOUND.as_secs()
        ))
    };
    let resp = reqwest::Client::new()
        .get(url)
        .timeout(DOWNLOAD_BOUND)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| {
            if e.is_timeout() {
                timed_out(&e)
            } else {
                Error::Other(format!("download: {e}"))
            }
        })?;
    let bytes = resp.bytes().await.map_err(|e| {
        if e.is_timeout() {
            timed_out(&e)
        } else {
            Error::Other(format!("download body: {e}"))
        }
    })?;
    Ok(bytes.to_vec())
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
        // with one nothing has shown to start (ISS-1378).
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
    }
    // The kept build is what a build that will not stay up is put back to, so
    // the probation is written only where one is kept (ISS-1378).
    #[cfg(unix)]
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
            .env_remove(runner_platform::exe::HANDOVER_LISTENER_ENV)
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

#[cfg(all(test, unix))]
mod probation_install_tests {
    use super::*;
    use std::path::{Path, PathBuf};

    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn script(version: &str, commit: &str) -> Vec<u8> {
        format!("#!/bin/sh\necho 'forge-runner {version} ({commit})'\n").into_bytes()
    }

    /// An install path holding a build that runs and says it is 0.1.0.
    fn a_box(tag: &str) -> (Scratch, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "forge-update-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("forge-runner");
        std::fs::write(&exe, script("0.1.0", "served0")).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        (Scratch(dir), exe)
    }

    fn claim(version: &str) -> Claim {
        Claim {
            version: version.into(),
            commit: None,
        }
    }

    fn says(exe: &Path) -> String {
        let out = std::process::Command::new(exe)
            .arg("--version")
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// ISS-1378: a build an update installed serves on probation, beside the
    /// build it replaced, so one that never stays up can be put back.
    #[tokio::test]
    async fn an_installed_build_serves_on_probation_beside_the_build_it_replaced() {
        let (_dir, exe) = a_box("begin");
        install(
            &exe,
            &script("0.2.0", "new0000"),
            &claim("0.2.0"),
            Some(&ServedBuild::new()),
        )
        .await
        .unwrap();
        assert_eq!(says(&exe), "forge-runner 0.2.0 (new0000)");
        let mut name = exe.as_os_str().to_os_string();
        name.push(".probation");
        assert!(
            PathBuf::from(name).is_file(),
            "the installed build serves on no probation, so one that dies at start is restarted into for ever"
        );
        for n in 1..=probation::LIMIT {
            assert_eq!(
                probation::enter(&exe, "0.2.0"),
                probation::Entered::Counted { starts: n }
            );
        }
        assert_eq!(
            probation::enter(&exe, "0.2.0"),
            probation::Entered::PutBack {
                starts: probation::LIMIT
            },
            "a build that never stayed up is put back past the limit"
        );
        probation::put_back(&exe).unwrap();
        assert_eq!(says(&exe), "forge-runner 0.1.0 (served0)");
    }

    /// A build installed and not yet confirmed is no fallback: a later
    /// install in another process keeps the build kept before it.
    #[tokio::test]
    async fn an_install_over_a_build_still_on_probation_keeps_the_build_before_it() {
        let (_dir, exe) = a_box("unconfirmed");
        install(
            &exe,
            &script("0.2.0", "new0000"),
            &claim("0.2.0"),
            Some(&ServedBuild::new()),
        )
        .await
        .unwrap();
        let by_hand = ServedBuild::new();
        install(
            &exe,
            &script("0.3.0", "later00"),
            &claim("0.3.0"),
            Some(&by_hand),
        )
        .await
        .unwrap();
        assert_eq!(
            says(&kept_path(&exe)),
            "forge-runner 0.1.0 (served0)",
            "the build the box last served stays kept, not the unconfirmed 0.2.0"
        );
        assert_eq!(
            probation::enter(&exe, "0.3.0"),
            probation::Entered::Counted { starts: 1 }
        );
        by_hand.restore().unwrap();
        assert_eq!(says(&exe), "forge-runner 0.1.0 (served0)");
    }

    /// A release a probation put back is held back until another release is
    /// installed, and a record nobody can read refuses rather than lets it by.
    #[tokio::test]
    async fn a_put_back_build_is_held_back_until_another_release_is_installed() {
        let (_dir, exe) = a_box("held");
        let rejected = probation::Rejected {
            version: "0.2.0".into(),
            commit: None,
            starts: probation::LIMIT,
            at_ms: 1,
        };
        probation::reject(&exe, &rejected).unwrap();
        assert_eq!(held_back(&exe, &claim("0.2.0")).unwrap(), Some(rejected));
        assert_eq!(held_back(&exe, &claim("0.3.0")).unwrap(), None);
        install(
            &exe,
            &script("0.3.0", "later00"),
            &claim("0.3.0"),
            Some(&ServedBuild::new()),
        )
        .await
        .unwrap();
        assert_eq!(probation::rejected(&exe), Ok(None), "lifted by the install");
        std::fs::write(probation::rejected_path(&exe), "{").unwrap();
        let why = held_back(&exe, &claim("0.2.0"))
            .expect_err("an unreadable hold is never read as none")
            .to_string();
        assert!(why.contains("unreadable"), "{why}");
    }
}
