//! The one path this process may be named by, checked before anything writes it.
//!
//! `std::env::current_exe()` is `readlink("/proc/self/exe")` on Linux, and the
//! kernel renders that link as `<path> (deleted)` once the file behind it is
//! unlinked. This daemon's own auto-update unlinks it, on this very process,
//! and then defers the restart until the box goes idle — which a box doing its
//! job never reaches. So the value is right at start and a lie from the moment
//! the binary is replaced, for as long as the process lives.
//!
//! ` (deleted)` is a kernel annotation and never a filename, so a command built
//! from it is dead at every call rather than merely stale (ISS-1200).

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

/// What Linux appends to `/proc/<pid>/exe` once the file behind it is gone.
pub const DELETED_SUFFIX: &str = " (deleted)";

/// A path this process can be invoked by, which a runnable file stands at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnExe {
    /// The path to write. A runnable file stands here.
    pub path: PathBuf,
    /// What `current_exe()` answered, where that is not `path`: the binary this
    /// process started on is gone, and `path` is what stands there instead.
    /// Every caller says so in its own words rather than substituting quietly.
    pub replaced_from: Option<PathBuf>,
}

/// The path this process may be named by, or a refusal naming the class.
pub fn own() -> Result<OwnExe> {
    let raw = std::env::current_exe()
        .map_err(|e| Error::Other(format!("this process cannot read its own path: {e}")))?;
    resolve(&raw)
}

/// The same decision over a path handed in, which is how the annotation a live
/// kernel writes is exercised without deleting the binary under the test.
pub fn resolve(raw: &Path) -> Result<OwnExe> {
    if is_runnable(raw) {
        return Ok(OwnExe {
            path: raw.to_path_buf(),
            replaced_from: None,
        });
    }
    let Some(bare) = strip_deleted(raw) else {
        return Err(Error::Other(format!(
            "this process names itself {} and no runnable file stands there, so nothing can invoke it",
            raw.display()
        )));
    };
    if is_runnable(&bare) {
        return Ok(OwnExe {
            path: bare,
            replaced_from: Some(raw.to_path_buf()),
        });
    }
    Err(Error::Other(format!(
        "the binary this process started on was replaced and nothing runnable stands at {} either, so nothing can invoke it",
        bare.display()
    )))
}

/// Whether a shell handed this path would reach a program.
pub fn is_runnable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    meta.is_file() && may_execute(path)
}

/// The first runnable `name` on `PATH`, as an absolute path.
///
/// Absolute because what this feeds is written into files other processes read
/// from other directories — a checkout's credential helper, a service unit — and
/// `PATH` may hold a relative or empty entry, which resolves against whoever is
/// running rather than against the daemon that wrote it. A path that names one
/// file here and another there is this issue over again (consult ae035c F1).
pub fn on_path(name: &str) -> Option<PathBuf> {
    on_path_in(std::env::split_paths(&std::env::var_os("PATH")?), name)
}

/// The same over directories handed in, so a relative entry can be exercised
/// without this test process rewriting its own environment.
fn on_path_in(dirs: impl Iterator<Item = PathBuf>, name: &str) -> Option<PathBuf> {
    dirs.map(|dir| dir.join(name))
        .filter(|candidate| is_runnable(candidate))
        .find_map(|candidate| std::fs::canonicalize(candidate).ok())
}

/// Whether THIS process may execute the file, which is not the same question as
/// whether any execute bit is set: a file at `0o045` owned by somebody else
/// carries one for a class this daemon is not in, and a hook naming it dies with
/// `Permission denied` exactly as the deleted path died with `not found`
/// (consult 29edf1 F1). `access` asks the kernel the question a shell is about
/// to ask it.
#[cfg(unix)]
fn may_execute(path: &Path) -> bool {
    nix::unistd::access(path, nix::unistd::AccessFlags::X_OK).is_ok()
}

#[cfg(not(unix))]
fn may_execute(_path: &Path) -> bool {
    true
}

/// The path without the kernel's annotation, for a name carrying one.
fn strip_deleted(raw: &Path) -> Option<PathBuf> {
    let bare = raw.file_name()?.to_str()?.strip_suffix(DELETED_SUFFIX)?;
    if bare.is_empty() {
        return None;
    }
    Some(raw.with_file_name(bare))
}
