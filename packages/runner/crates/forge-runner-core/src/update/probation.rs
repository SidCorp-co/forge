//! A build an update installs serves on probation until it has stayed up.
//!
//! The pre-flight runs the downloaded file's `--version` before anything is
//! renamed, and that proves the file runs and says what the release names. It
//! does not prove the daemon starts: a build that answers `--version` and dies
//! at daemon start was installed, the handover's exec into it "succeeded", and
//! the service manager then restarted the box into the same file for ever,
//! with the build it replaced kept beside it and never put back (ISS-1379,
//! judge 3's plant A6, carried here as ISS-1378's declared extra fix).
//!
//! So the install writes `<exe>.probation` naming the build it installed. Each
//! `start` of that build counts itself on it first, before anything else the
//! daemon does can fail; one that has started [`LIMIT`] times without being
//! confirmed puts the kept build back at the install path and runs it. The
//! daemon confirms its probation once it has served for [`PERIOD`], which
//! removes the file. A build that dies before its own `start` reaches the count
//! cannot be helped from inside, and that is the reach this has.

use std::path::{Path, PathBuf};

/// How many starts a build on probation may make without being confirmed.
pub const LIMIT: u32 = 3;

/// How long a daemon serves before its probation is confirmed.
pub const PERIOD: std::time::Duration = std::time::Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Probation {
    version: String,
    starts: u32,
}

/// Where the probation of the build at `exe` is kept: beside it, under its name.
pub fn path(exe: &Path) -> PathBuf {
    let mut name = exe.as_os_str().to_os_string();
    name.push(".probation");
    PathBuf::from(name)
}

fn write(exe: &Path, p: &Probation) -> std::io::Result<()> {
    let at = path(exe);
    let mut beside = at.as_os_str().to_os_string();
    beside.push(".tmp");
    let beside = PathBuf::from(beside);
    let body = serde_json::to_vec(p).map_err(std::io::Error::other)?;
    std::fs::write(&beside, body)?;
    std::fs::rename(&beside, &at)
}

/// Put the build `version` about to be installed at `exe` on probation.
pub fn begin(exe: &Path, version: &str) -> std::io::Result<()> {
    write(
        exe,
        &Probation {
            version: version.to_string(),
            starts: 0,
        },
    )
}

/// What a `start` found when it counted itself.
#[derive(Debug, PartialEq, Eq)]
pub enum Entered {
    /// No probation names this build: it was not installed by an update, or
    /// it was confirmed.
    Free,
    /// This is start number `starts` of the build on probation.
    Counted { starts: u32 },
    /// A probation was found naming another build, or one that could not be
    /// read, and it was removed: the build it was about is not this one.
    Cleared(String),
    /// This build has started `starts` times and was never confirmed, and the
    /// kept build is there to put back.
    PutBack { starts: u32 },
    /// It has, and nothing is kept to put back, so it serves on.
    NothingKept { starts: u32 },
}

/// Count this start of the build `version` at `exe` on its probation.
pub fn enter(exe: &Path, version: &str) -> Entered {
    let at = path(exe);
    let text = match std::fs::read(&at) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Entered::Free,
        Err(e) => {
            let _ = std::fs::remove_file(&at);
            return Entered::Cleared(format!("{} could not be read ({e})", at.display()));
        }
    };
    let p: Probation = match serde_json::from_slice(&text) {
        Ok(p) => p,
        Err(e) => {
            let _ = std::fs::remove_file(&at);
            return Entered::Cleared(format!("{} is not a probation ({e})", at.display()));
        }
    };
    if p.version != version {
        let _ = std::fs::remove_file(&at);
        return Entered::Cleared(format!(
            "{} named build {}, and this is {version}",
            at.display(),
            p.version
        ));
    }
    let starts = p.starts.saturating_add(1);
    if starts > LIMIT {
        if super::kept_path(exe).is_file() {
            return Entered::PutBack { starts: p.starts };
        }
        let _ = std::fs::remove_file(&at);
        return Entered::NothingKept { starts: p.starts };
    }
    if let Err(e) = write(
        exe,
        &Probation {
            version: p.version,
            starts,
        },
    ) {
        tracing::warn!(
            "[update] start {starts} of this build on probation could not be counted at {} ({e}); a build that keeps dying at start is not put back while it cannot be",
            at.display()
        );
    }
    Entered::Counted { starts }
}

/// Put the kept build back at `exe` and end the probation of the one that
/// would not stay up.
pub fn put_back(exe: &Path) -> std::io::Result<()> {
    std::fs::rename(super::kept_path(exe), exe)?;
    let _ = std::fs::remove_file(path(exe));
    Ok(())
}

/// The build `version` at `exe` has served its period: end its probation.
/// Answers whether there was one.
pub fn confirm(exe: &Path, version: &str) -> std::io::Result<bool> {
    let at = path(exe);
    match std::fs::read(&at) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e),
        Ok(text) => match serde_json::from_slice::<Probation>(&text) {
            Ok(p) if p.version != version => return Ok(false),
            _ => {}
        },
    }
    std::fs::remove_file(&at)?;
    Ok(true)
}

/// What `start` does with its probation before anything else: `Some(path)`
/// where the kept build was put back at `path` and is to be run in this
/// process's place.
pub fn at_start() -> Option<PathBuf> {
    let exe = match crate::exe::own() {
        Ok(own) => own.path,
        Err(e) => {
            tracing::warn!("[update] this build's probation cannot be read: {e}");
            return None;
        }
    };
    match enter(&exe, super::CURRENT_VERSION) {
        Entered::Free => None,
        Entered::Counted { starts } => {
            tracing::warn!(
                "[update] {} serves on probation, start {starts} of {LIMIT}: it is confirmed once it has served {}s, and put back to the build it replaced if it starts {LIMIT} times without that",
                super::CURRENT_VERSION,
                PERIOD.as_secs()
            );
            None
        }
        Entered::Cleared(why) => {
            tracing::info!("[update] removed a probation that is not this build's: {why}");
            None
        }
        Entered::NothingKept { starts } => {
            tracing::error!(
                "[update] {} started {starts} times on probation without staying up for {}s, and no build is kept at {} to put back, so it serves on",
                super::CURRENT_VERSION,
                PERIOD.as_secs(),
                super::kept_path(&exe).display()
            );
            None
        }
        Entered::PutBack { starts } => match put_back(&exe) {
            Ok(()) => {
                tracing::error!(
                    "[update] {} started {starts} times on probation without staying up for {}s, so the build it replaced is back at {} and runs in its place",
                    super::CURRENT_VERSION,
                    PERIOD.as_secs(),
                    exe.display()
                );
                Some(exe)
            }
            Err(e) => {
                tracing::error!(
                    "[update] {} started {starts} times on probation without staying up, and the build it replaced could not be put back from {} ({e}); it serves on",
                    super::CURRENT_VERSION,
                    super::kept_path(&exe).display()
                );
                None
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    fn a_box(tag: &str) -> (Scratch, PathBuf) {
        let dir = Scratch::new(tag);
        let exe = dir.path().join("forge-runner");
        std::fs::write(&exe, "the build on probation").unwrap();
        (dir, exe)
    }

    /// ISS-1378 criterion 14.
    #[test]
    fn an_installed_build_counts_its_starts_and_is_confirmed_after_its_period() {
        let (_dir, exe) = a_box("probation-confirm");
        begin(&exe, "0.18.0").unwrap();
        assert_eq!(enter(&exe, "0.18.0"), Entered::Counted { starts: 1 });
        assert_eq!(enter(&exe, "0.18.0"), Entered::Counted { starts: 2 });
        assert!(confirm(&exe, "0.18.0").unwrap(), "there was one to confirm");
        assert!(!path(&exe).exists());
        assert_eq!(enter(&exe, "0.18.0"), Entered::Free);
    }

    /// ISS-1378 criterion 15.
    #[test]
    fn a_build_that_never_stays_up_puts_the_kept_one_back_past_the_limit() {
        let (_dir, exe) = a_box("probation-putback");
        std::fs::write(super::super::kept_path(&exe), "the build it replaced").unwrap();
        begin(&exe, "0.18.0").unwrap();
        for n in 1..=LIMIT {
            assert_eq!(enter(&exe, "0.18.0"), Entered::Counted { starts: n });
        }
        assert_eq!(enter(&exe, "0.18.0"), Entered::PutBack { starts: LIMIT });
        put_back(&exe).unwrap();
        assert_eq!(
            std::fs::read_to_string(&exe).unwrap(),
            "the build it replaced"
        );
        assert!(
            !path(&exe).exists(),
            "the probation ends with the build it was about"
        );
        assert_eq!(enter(&exe, "0.17.90"), Entered::Free);
    }

    #[test]
    fn a_probation_naming_another_build_is_not_this_ones() {
        let (_dir, exe) = a_box("probation-other");
        begin(&exe, "0.18.0").unwrap();
        assert!(matches!(enter(&exe, "0.17.90"), Entered::Cleared(_)));
        assert!(!path(&exe).exists());
        assert!(!confirm(&exe, "0.17.90").unwrap());
    }

    #[test]
    fn past_the_limit_with_nothing_kept_the_build_serves_on_and_says_so() {
        let (_dir, exe) = a_box("probation-nokeep");
        begin(&exe, "0.18.0").unwrap();
        for _ in 1..=LIMIT {
            enter(&exe, "0.18.0");
        }
        assert_eq!(
            enter(&exe, "0.18.0"),
            Entered::NothingKept { starts: LIMIT }
        );
        assert_eq!(
            std::fs::read_to_string(&exe).unwrap(),
            "the build on probation"
        );
    }
}
