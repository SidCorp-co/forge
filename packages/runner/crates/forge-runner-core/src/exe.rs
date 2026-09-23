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
    meta.is_file() && has_exec_bit(&meta)
}

/// The first runnable `name` on `PATH`, as a shell would resolve it.
pub fn on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| is_runnable(candidate))
}

#[cfg(unix)]
fn has_exec_bit(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_exec_bit(_meta: &std::fs::Metadata) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "forge-exe-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("scratch");
            Self(dir)
        }

        /// A file at `name` that a shell could run.
        fn runnable(&self, name: &str) -> PathBuf {
            let p = self.0.join(name);
            std::fs::write(&p, "#!/bin/sh\nexit 0\n").expect("write");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod");
            }
            p
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_binary_that_is_still_there_is_named_as_it_stands() {
        let dir = Scratch::new("present");
        let exe = dir.runnable("forge-runner");
        let got = resolve(&exe).expect("a file stands there");
        assert_eq!(got.path, exe);
        assert_eq!(
            got.replaced_from, None,
            "nothing was replaced, so nothing may be reported as a fallback"
        );
    }

    #[test]
    fn a_replaced_binary_resolves_to_the_build_standing_at_its_path() {
        let dir = Scratch::new("replaced");
        let installed = dir.runnable("forge-runner");
        let annotated = dir.0.join(format!("forge-runner{DELETED_SUFFIX}"));

        let got = resolve(&annotated).expect("the updater left a build at that path");
        assert_eq!(got.path, installed);
        assert_eq!(
            got.replaced_from.as_deref(),
            Some(annotated.as_path()),
            "a fallback nobody can see in the journal is the silent substitution it replaced"
        );
    }

    #[test]
    fn a_binary_that_is_gone_rather_than_replaced_is_refused_by_name() {
        let dir = Scratch::new("gone");
        let annotated = dir.0.join(format!("forge-runner{DELETED_SUFFIX}"));
        let err = resolve(&annotated).expect_err("nothing stands at either path");
        let said = err.to_string();
        assert!(
            said.contains("nothing can invoke it"),
            "the refusal must name the class: {said}"
        );
        assert!(
            said.contains("forge-runner"),
            "the refusal must name the path it looked at: {said}"
        );
    }

    #[test]
    fn a_file_genuinely_named_deleted_is_taken_as_itself() {
        let dir = Scratch::new("literal");
        let odd = dir.runnable(&format!("forge-runner{DELETED_SUFFIX}"));
        let got = resolve(&odd).expect("a file stands at exactly that name");
        assert_eq!(
            got.path, odd,
            "the annotation is only an annotation where no file carries it as a name"
        );
        assert_eq!(got.replaced_from, None);
    }

    #[test]
    fn a_path_naming_a_directory_is_not_a_program() {
        let dir = Scratch::new("dir");
        assert!(!is_runnable(&dir.0));
        assert!(resolve(&dir.0).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_file_nothing_may_execute_is_not_a_program() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch::new("noexec");
        let plain = dir.0.join("forge-runner");
        std::fs::write(&plain, "not a program").expect("write");
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).expect("chmod");
        assert!(
            !is_runnable(&plain),
            "a hook naming this would fail at every call exactly as the deleted path did"
        );
    }

    #[test]
    fn the_process_running_this_test_can_name_itself() {
        let got = own().expect("the test binary is on disk while it runs");
        assert!(is_runnable(&got.path));
    }

    /// `PATH` is process-wide, so this reads it rather than setting it: a test
    /// that swapped it would decide the answer for every other thread's.
    #[cfg(unix)]
    #[test]
    fn a_name_on_path_resolves_to_the_file_a_shell_would_reach() {
        let found = on_path("sh").expect("no `sh` on PATH, which no unix box this runs on lacks");
        assert!(is_runnable(&found), "{}", found.display());
        assert_eq!(
            on_path("forge-runner-no-such-program-exists"),
            None,
            "a name nothing answers must not resolve, or the fallback it guards is no guard"
        );
    }
}
