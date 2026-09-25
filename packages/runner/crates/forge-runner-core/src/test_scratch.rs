//! The one way a runner test gets a directory of its own under the system temp dir.
//!
//! A [`Scratch`] removes its whole tree when it is dropped: when the test passes, when it returns
//! early, and when an assertion panics, because the test harness unwinds and drop runs on the way
//! out. A path built by hand with `temp_dir().join(..)` has nothing to hang that on, and a
//! `remove_dir_all` at the top of the next run cleans only the path the next run happens to reuse,
//! so every `cargo test` process left one tree per site behind until the box's tmpfs ran out of
//! inodes (ISS-1138).
//!
//! `temp_dir()` honours `TMPDIR`, so a run pointed at an empty directory shows by name any tree a
//! test still leaves behind.

use std::ffi::OsStr;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A directory under the system temp dir, removed with everything in it on drop.
///
/// Bind it to a name for as long as anything under it is used. `Scratch::new("x").join("y")`
/// compiles, and the temporary is removed at the end of that statement, so whatever is later
/// created at `y` recreates the root with nothing left to remove it. A helper that hands out a
/// path inside a scratch returns [`InScratch`] from [`Scratch::at`] instead.
#[derive(Debug)]
pub struct Scratch(PathBuf);

impl Scratch {
    /// Creates `<temp dir>/forge-test-<tag>-<pid>-<n>`. The tag says which test made a tree that
    /// outlives its test anyway, as one in a killed process does, since a kill never unwinds.
    pub fn new(tag: &str) -> Self {
        Self::under(&std::env::temp_dir(), tag)
    }

    /// The same, rooted at `/tmp` wherever the box has one, for a test that binds a unix socket
    /// inside it. `sockaddr_un.sun_path` holds 104 bytes on macOS, whose `TMPDIR` is long enough
    /// on its own to leave a socket under it no room; keep the tag short for the same reason.
    pub fn short(tag: &str) -> Self {
        let tmp = Path::new("/tmp");
        if tmp.is_dir() {
            Self::under(tmp, tag)
        } else {
            Self::new(tag)
        }
    }

    fn under(base: &Path, tag: &str) -> Self {
        // The tag becomes one path component; a separator or `..` in it would put the
        // directory, and what the drop removes, somewhere other than under `base`.
        assert!(
            !tag.is_empty() && !tag.contains(['/', '\\']) && tag != "." && tag != "..",
            "Scratch tag {tag:?} is not a single path component: give a plain name"
        );
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let dir = base.join(format!("forge-test-{tag}-{}-{n}", std::process::id()));
        // Only a dead process that had this pid can have left this name, and nothing live owns it.
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)
            .unwrap_or_else(|e| panic!("scratch dir {}: {e}", dir.display()));
        Self(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// One path inside this scratch, for a helper whose callers want a file or a subdirectory
    /// rather than the root. The root lives exactly as long as the returned value.
    ///
    /// `rel` must stay inside the scratch: an absolute path or a `..` would hand out a place the
    /// drop does not remove, so either is refused by name.
    pub fn at(self, rel: impl AsRef<Path>) -> InScratch {
        let rel = rel.as_ref();
        assert!(
            rel.components()
                .all(|c| matches!(c, std::path::Component::Normal(_))),
            "Scratch::at({}) leaves the scratch dir, and the drop would not remove what is made \
             there: give a relative path with no `..`",
            rel.display()
        );
        let path = self.0.join(rel);
        InScratch { path, root: self }
    }
}

impl Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<OsStr> for Scratch {
    fn as_ref(&self) -> &OsStr {
        self.0.as_os_str()
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A path inside a [`Scratch`] that owns it: dropping this removes the whole root.
#[derive(Debug)]
pub struct InScratch {
    path: PathBuf,
    root: Scratch,
}

impl InScratch {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn root(&self) -> &Path {
        self.root.path()
    }
}

impl Deref for InScratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<Path> for InScratch {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

impl AsRef<OsStr> for InScratch {
    fn as_ref(&self) -> &OsStr {
        self.path.as_os_str()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn populated(tag: &str) -> Scratch {
        let s = Scratch::new(tag);
        std::fs::create_dir_all(s.join("a/b")).unwrap();
        std::fs::write(s.join("a/b/f.txt"), "x").unwrap();
        s
    }

    #[test]
    fn a_dropped_scratch_takes_its_whole_tree_with_it() {
        let s = populated("drop");
        let root = s.to_path_buf();
        assert!(root.join("a/b/f.txt").is_file());
        drop(s);
        assert!(!root.exists(), "{} outlived its Scratch", root.display());
    }

    #[test]
    fn a_test_that_panics_still_removes_its_scratch() {
        let seen = std::sync::Mutex::new(None::<PathBuf>);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let s = populated("panic");
            *seen.lock().unwrap() = Some(s.to_path_buf());
            panic!("an assertion failing mid-test");
        }));
        assert!(outcome.is_err(), "the closure must actually have panicked");
        let root = seen.lock().unwrap().clone().expect("the scratch was made");
        assert!(!root.exists(), "{} survived the unwind", root.display());
    }

    #[test]
    fn a_path_handed_out_of_a_scratch_keeps_the_root_until_it_drops() {
        let file = populated("at").at("a/b/f.txt");
        let root = file.root().to_path_buf();
        assert!(file.is_file());
        drop(file);
        assert!(
            !root.exists(),
            "{} outlived the path holding it",
            root.display()
        );
    }

    #[test]
    fn a_path_that_leaves_the_scratch_is_refused_by_name() {
        for escaping in ["../outside", "/etc", "a/../../b"] {
            let refused = std::panic::catch_unwind(|| Scratch::new("escape").at(escaping));
            let why = refused.expect_err(escaping);
            let msg = why.downcast_ref::<String>().cloned().unwrap_or_default();
            assert!(msg.contains("leaves the scratch dir"), "{escaping}: {msg}");
        }
    }

    #[test]
    fn a_tag_that_is_not_one_path_component_is_refused_by_name() {
        for bad in ["x/../../outside", "a/b", "..", ""] {
            let refused = std::panic::catch_unwind(|| Scratch::new(bad));
            let msg = refused
                .expect_err(bad)
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_default();
            assert!(
                msg.contains("not a single path component"),
                "{bad:?}: {msg}"
            );
        }
    }

    #[test]
    fn two_scratches_in_one_process_never_share_a_directory() {
        let (a, b) = (Scratch::new("same"), Scratch::new("same"));
        assert_ne!(a.path(), b.path());
    }

    /// Files allowed to name `temp_dir()`, and how many times: production scratch the issue puts
    /// out of scope, and one fixture path nothing creates. A test site has no row here.
    const ALLOWED: &[(&str, usize, &str)] = &[
        (
            "forge-runner-core/src/daemon/chat.rs",
            1,
            "runtime: attachment downloads",
        ),
        (
            "forge-runner-core/src/mcp/config.rs",
            1,
            "runtime: the config dir's fallback",
        ),
        (
            "forge-runner-core/src/daemon/transcript_age.rs",
            1,
            "names an absolute path for a fixture nothing creates",
        ),
    ];

    /// Every `temp_dir()` in either crate is a counted, named exception or a leak waiting to
    /// happen. The count is per file rather than per test region on purpose: telling test code
    /// from production by position misses a test-gated item outside the tests module.
    #[test]
    fn no_file_builds_a_temp_path_by_hand_beyond_its_allowance() {
        let crates = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        for root in [
            "forge-runner-core/src",
            "forge-runner/src",
            "forge-runner/tests",
        ] {
            collect(&crates.join(root), &mut files);
        }
        assert!(
            files.len() > 50,
            "the sweep found {} file(s) under {} — it is reading the wrong tree",
            files.len(),
            crates.display()
        );

        let mut found = Vec::new();
        let mut seen = std::collections::BTreeMap::new();
        for path in &files {
            let rel = path
                .strip_prefix(&crates)
                .expect("under the crates dir")
                .to_string_lossy()
                .replace('\\', "/");
            if rel == "forge-runner-core/src/test_scratch.rs" {
                continue;
            }
            let text = std::fs::read_to_string(path).expect("a file the sweep listed");
            let hits: Vec<usize> = text
                .lines()
                .enumerate()
                .filter(|(_, l)| l.contains("temp_dir()"))
                .map(|(i, _)| i + 1)
                .collect();
            if hits.is_empty() {
                continue;
            }
            let allowed = ALLOWED
                .iter()
                .find(|(f, _, _)| *f == rel)
                .map_or(0, |(_, n, _)| *n);
            if hits.len() > allowed {
                for line in &hits {
                    found.push(format!("{rel}:{line}"));
                }
            }
            seen.insert(rel, hits.len());
        }

        let stale: Vec<String> = ALLOWED
            .iter()
            .filter(|(f, n, _)| seen.get(*f).copied().unwrap_or(0) < *n)
            .map(|(f, n, why)| {
                format!(
                    "{f} ({why}): allowed {n}, holds {}",
                    seen.get(*f).copied().unwrap_or(0)
                )
            })
            .collect();

        assert!(
            found.is_empty(),
            "these lines build a path under the system temp dir by hand, and nothing removes \
             what they create, so every test process leaves one tree per site behind:\n  {}\n\n\
             Hold a `crate::test_scratch::Scratch` (in the forge-runner crate, \
             `forge_runner_core::test_scratch::Scratch`) for the life of the test instead. A \
             production path that genuinely needs the temp dir goes in `ALLOWED` with its reason.",
            found.join("\n  ")
        );
        assert!(
            stale.is_empty(),
            "these files hold fewer `temp_dir()` sites than `ALLOWED` gives them — lower the \
             count, or drop the row once it reaches zero:\n  {}",
            stale.join("\n  ")
        );
    }

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
}
