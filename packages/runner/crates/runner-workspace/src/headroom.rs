//! What the box has left, on the filesystems its runs write their scratch into.
//!
//! On sid-xeon-1 on 2026-09-25 `/tmp` (a 61G tmpfs, so RAM) ran out of inodes
//! and an agent lost its shell entirely: every call died before running, with
//! `ENOSPC ... open '/proc/self/fd/11/<id>.output'`, and nothing anywhere named
//! the disk (ISS-1260). Over the hours around it bytes fell from 43G used to
//! 27G while inodes rose from 89% used to 96%, so a reading carries both axes.
//!
//! The box reads and reports; it does not judge. Every reading rides the next
//! heartbeat to core, which holds the thresholds and says what they mean on the
//! device's page (`devices/disk-report.ts`, ADR 0009). This module reclaims
//! nothing: [`crate::worktree_reap`] removes only checkouts under a repository
//! and older than its `MIN_AGE`, and [`crate::scratch_reap`] sweeps the
//! daemon's own scratch root.

use runner_proto::disk::{Reading, Root};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often the reading is taken.
///
/// The box ISS-1260 was raised from consumed ~93,000 inodes in four hours,
/// about 9% of what that filesystem holds; a reading on the worktree sweep's
/// six-hour period could cross every threshold core holds between two ticks.
pub const TICK: Duration = Duration::from_secs(5 * 60);

/// Every distinct filesystem a run on this box writes its scratch into.
///
/// The process temp directory is where this process's own tooling writes, and
/// it is not the only place scratch lands: a daemon started with `TMPDIR`
/// pointing at one filesystem still shares the box with every tool that ignores
/// `TMPDIR` and writes under `/tmp`. Measured 2026-09-26 on the box that raised
/// ISS-1260, whose daemon runs with `TMPDIR=/home/dev/.cache/forge-tmp`: that
/// path stood at 88% of its inodes free while `/tmp` stood at 40%, so reading
/// the first alone reports a box whose other half is the one filling.
///
/// Creates nothing, on any root.
#[cfg(unix)]
pub fn scratch_roots() -> Vec<PathBuf> {
    roots_for(std::env::temp_dir(), Path::new("/tmp"), |at| {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(at).ok().map(|m| m.dev())
    })
}

#[cfg(not(unix))]
pub fn scratch_roots() -> Vec<PathBuf> {
    vec![std::env::temp_dir()]
}

/// The configured root, plus `shared` when that is a filesystem of its own.
///
/// The configured root is kept whatever `device` says about it: a `TMPDIR` that
/// cannot be stat'd is news, and [`read`] refuses it by name. `shared` is added
/// whenever it can be read and is not the configured root's own filesystem; an
/// unknown configured device is not equality, because dropping `/tmp` there is
/// how a box loses the reading of the one filesystem that is filling.
#[cfg(unix)]
fn roots_for(
    configured: PathBuf,
    shared: &Path,
    device: impl Fn(&Path) -> Option<u64>,
) -> Vec<PathBuf> {
    let mut roots = vec![configured.clone()];
    if let Some(there) = device(shared) {
        if device(&configured) != Some(there) {
            roots.push(shared.to_path_buf());
        }
    }
    roots
}

/// Every root's reading, in the shape the heartbeat carries.
pub fn survey(roots: &[PathBuf]) -> Vec<Root> {
    roots
        .iter()
        .map(|at| Root::new(&at.display().to_string(), read(at)))
        .collect()
}

/// Ask the filesystem holding `at` what it has left.
///
/// `fsblkcnt_t` and `fsfilcnt_t` are 64 bits on Linux and 32 on macOS, so the
/// widening is real on one of the two platforms this ships to.
///
/// **Priced, and not taken: this call cannot be killed.** `statvfs` blocks for
/// as long as an unresponsive network or FUSE mount does. The caller runs it on
/// the blocking pool and awaits it plainly, so no async worker stalls and at
/// most one such call is ever out; what is left is that one blocking-pool
/// thread, which the runtime's shutdown waits on. Killing it needs the probe in
/// a process of its own every five minutes on every box, to bound a case that
/// needs the scratch root to be a hung remote mount. Ends the day a box is
/// measured running this against one (consult 825bfe F1).
#[cfg(unix)]
#[expect(
    clippy::useless_conversion,
    reason = "statvfs field widths differ by platform (u32 blocks on macOS, u64 on Linux); the conversion is useless on some and needed on others"
)]
pub fn read(at: &Path) -> Reading {
    match nix::sys::statvfs::statvfs(at) {
        Ok(fs) => {
            let block = u64::from(fs.fragment_size());
            Reading::Took {
                bytes_free: u64::from(fs.blocks_available()).saturating_mul(block),
                bytes_total: u64::from(fs.blocks()).saturating_mul(block),
                inodes_free: u64::from(fs.files_available()),
                inodes_total: u64::from(fs.files()),
            }
        }
        Err(e) => Reading::Refused {
            refused: format!("statvfs on {} answered {e}", at.display()),
        },
    }
}

/// Ask the filesystem holding `at` what it has left.
#[cfg(not(unix))]
pub fn read(at: &Path) -> Reading {
    Reading::Refused {
        refused: format!(
            "this platform has no filesystem reading the daemon can take, so nothing is known about {}",
            at.display()
        ),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn tmp_is_read_beside_the_configured_root_unless_it_is_the_same_filesystem() {
        let here = PathBuf::from("/conf");
        let apart = roots_for(here.clone(), Path::new("/tmp"), |p| {
            Some(if p == Path::new("/tmp") { 2 } else { 1 })
        });
        assert_eq!(apart, vec![here.clone(), PathBuf::from("/tmp")]);
        let same = roots_for(here.clone(), Path::new("/tmp"), |_| Some(1));
        assert_eq!(same, vec![here.clone()]);
        let unknown = roots_for(here.clone(), Path::new("/tmp"), |p| {
            (p == Path::new("/tmp")).then_some(2)
        });
        assert_eq!(
            unknown,
            vec![here, PathBuf::from("/tmp")],
            "a configured root that cannot be stat'd must not drop /tmp"
        );
    }

    #[test]
    fn a_root_that_cannot_be_read_is_reported_as_refused_never_as_zero() {
        let missing = Path::new("/no/such/forge/scratch/root");
        assert!(matches!(read(missing), Reading::Refused { .. }));
        let took = survey(&[std::env::temp_dir()]);
        assert!(matches!(took[0].reading, Reading::Took { .. }), "{took:?}");
    }
}
