//! The one way a runner test gets a directory of its own under the system temp dir, and the one
//! way it reads a source file to scan ([`lf`]).
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
use std::sync::Mutex;

/// Whether `dir` is, or is inside, a directory a [`Scratch`] made: the only
/// place a test build lets a writer resolve its config dir (ISS-1344). A `..`
/// is refused outright, and the part of `dir` that exists is read through its
/// symlinks, so neither walks a path out of the scratch it names.
pub fn is_scratch(dir: &Path) -> bool {
    let bases = [std::env::temp_dir(), PathBuf::from("/tmp")];
    let inside = |dir: &Path, bases: &[PathBuf]| {
        bases.iter().any(|base| {
            dir.strip_prefix(base).is_ok_and(|rest| {
                let mut parts = rest.components();
                parts.next().is_some_and(|c| {
                    c.as_os_str()
                        .to_str()
                        .is_some_and(|s| s.starts_with("forge-test-"))
                }) && parts.all(|c| matches!(c, std::path::Component::Normal(_)))
            })
        })
    };
    if !inside(dir, &bases) {
        return false;
    }
    let Some(real) = resolved(dir) else {
        return false;
    };
    let real_bases: Vec<PathBuf> = bases.iter().filter_map(|b| b.canonicalize().ok()).collect();
    inside(&real, &real_bases)
}

/// `dir` with its deepest existing ancestor read through its symlinks and the
/// part not yet created appended as written.
fn resolved(dir: &Path) -> Option<PathBuf> {
    let existing = dir.ancestors().find(|a| a.exists())?;
    let rest = dir.strip_prefix(existing).ok()?;
    Some(existing.canonicalize().ok()?.join(rest))
}

/// `src`, an `include_str!` of a source file, with the line endings the repository holds.
///
/// `include_str!` embeds what the checkout wrote, and a Windows checkout under
/// `core.autocrlf=true` writes `\r\n`. A needle with a newline inside it — a call split across
/// lines — is then absent from a file that plainly holds it, and the scan goes red on Windows
/// alone (#336, ISS-1343, ISS-1357). Every source a test reads comes through here, which
/// `every_source_a_test_scans_is_read_through_lf` holds.
pub fn lf(src: &'static str) -> &'static str {
    if !src.contains('\r') {
        return src;
    }
    static READ: Mutex<Vec<(usize, &'static str)>> = Mutex::new(Vec::new());
    let mut read = READ.lock().unwrap_or_else(|e| e.into_inner());
    let key = src.as_ptr() as usize;
    if let Some((_, lf)) = read.iter().find(|(k, _)| *k == key) {
        return lf;
    }
    let lf: &'static str = Box::leak(src.replace("\r\n", "\n").into_boxed_str());
    read.push((key, lf));
    lf
}

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
        if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
            return;
        }
        // A test that took write permission away from a directory and then panicked before
        // giving it back leaves a tree nothing can unlink; give it back and try once more.
        writable(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn writable(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                writable(&entry.path());
            }
        }
    }
}

#[cfg(not(unix))]
fn writable(dir: &Path) {
    if let Ok(meta) = std::fs::metadata(dir) {
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(dir, perms);
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                writable(&entry.path());
            }
        }
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

    /// ISS-1357. A needle split across lines is found in a CRLF read, a read with no `\r` is
    /// handed back as it came, and one source is copied once however often it is read.
    #[test]
    fn lf_finds_a_needle_split_across_crlf_lines() {
        let crlf = "install_skill(\r\n        &resolved.repo_path,\r\n)";
        assert!(!crlf.contains("install_skill(\n        &resolved.repo_path,"));
        assert!(lf(crlf).contains("install_skill(\n        &resolved.repo_path,"));
        assert!(!lf(crlf).contains('\r'));
        assert!(std::ptr::eq(lf(crlf), lf(crlf)), "one copy per source");
        let plain = "a(\n    b)";
        assert!(std::ptr::eq(lf(plain), plain), "an LF read is not copied");
    }

    /// ISS-1357. What a scan reads holds no `\r` in this checkout, whatever its line endings —
    /// on Windows the one assertion here that reads a file the checkout itself wrote.
    #[test]
    fn a_source_read_through_lf_holds_no_carriage_return() {
        let read = lf(include_str!("test_scratch.rs"));
        assert!(
            !read.contains('\r'),
            "a source read through `lf` still holds {} CR byte(s)",
            read.matches('\r').count()
        );
    }

    /// The files whose reads stay raw because another open branch holds them, each with the
    /// issue that does. A raw read there still fails its scan on Windows once a needle spans a
    /// line; the entry goes when that file's reads go through [`lf`], and one left behind by
    /// such a change is refused below as stale.
    const RAW_WHILE_HELD: [(&str, &str); 7] = [
        ("forge-runner-core/src/daemon/master.rs", "ISS-1343"),
        ("forge-runner-core/src/daemon/mod.rs", "ISS-1343"),
        ("forge-runner/src/cmd/master.rs", "ISS-1343"),
        (
            "forge-runner-core/src/daemon/terminal.rs",
            "integration/batch-2",
        ),
        (
            "forge-runner-core/src/workspace/worktree_reap.rs",
            "ISS-1250",
        ),
        ("forge-runner-core/src/daemon/held_report.rs", "ISS-1250"),
        ("forge-runner-core/src/runner/terminate.rs", "ISS-1250"),
    ];

    /// ISS-1357. Every `include_str!` of a `.rs` file under both runner crates is the argument
    /// of [`lf`], but for the files `RAW_WHILE_HELD` names.
    #[test]
    fn every_source_a_test_scans_is_read_through_lf() {
        let crates = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut files = Vec::new();
        for root in [
            "forge-runner-core/src",
            "forge-runner/src",
            "forge-runner/tests",
        ] {
            rust_files(&crates.join(root), &mut files);
        }
        assert!(
            files.len() > 50,
            "read {} file(s) under {}",
            files.len(),
            crates.display()
        );

        let open = concat!("include_str", "!(\"");
        let mut raw = Vec::new();
        let mut held_raw = std::collections::BTreeSet::new();
        for path in &files {
            let rel = path
                .strip_prefix(&crates)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let text = std::fs::read_to_string(path).unwrap();
            for (at, _) in text.match_indices(open) {
                let rest = &text[at + open.len()..];
                let Some(end) = rest.find('"') else { continue };
                if !rest[..end].ends_with(".rs") || text[..at].ends_with("lf(") {
                    continue;
                }
                if RAW_WHILE_HELD.iter().any(|(f, _)| *f == rel) {
                    held_raw.insert(rel.clone());
                    continue;
                }
                let line = text[..at].matches('\n').count() + 1;
                raw.push(format!("{rel}:{line}"));
            }
        }
        assert!(
            raw.is_empty(),
            "these read a source file raw, and on a CRLF checkout a needle with a newline inside \
             it is absent from what they read: wrap each as `lf(include_str!(..))` from \
             `test_scratch`:\n  {}",
            raw.join("\n  ")
        );
        let stale: Vec<_> = RAW_WHILE_HELD
            .iter()
            .filter(|(f, _)| !held_raw.contains(*f))
            .map(|(f, by)| format!("{f} (held by {by})"))
            .collect();
        assert!(
            stale.is_empty(),
            "RAW_WHILE_HELD names file(s) that no longer read raw; drop them:\n  {}",
            stale.join("\n  ")
        );
    }

    fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                rust_files(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }

    /// ISS-1344. Only a scratch or a path inside one is a test's own, and
    /// neither a `..` nor a symlink walks a path out of the scratch it names.
    #[test]
    fn only_a_path_inside_a_scratch_is_a_tests_own() {
        let own = Scratch::new("is-scratch");
        assert!(is_scratch(own.path()));
        assert!(is_scratch(&own.path().join("forge-runner").join("not-yet")));
        let temp = own.path().parent().unwrap().to_path_buf();
        assert!(!is_scratch(&temp), "the temp dir itself");
        assert!(!is_scratch(&temp.join("runner-user-config")));
        assert!(!is_scratch(&own.path().join("..").join("outside")));
        assert!(!is_scratch(Path::new("/iss-1344-nobody/.config")));
        #[cfg(unix)]
        {
            let away = Scratch::new("is-scratch-away");
            let link = own.path().join("link");
            std::os::unix::fs::symlink(away.path().parent().unwrap(), &link).unwrap();
            assert!(!is_scratch(&link), "a symlink out of the scratch");
            assert!(!is_scratch(&link.join("forge-runner")));
        }
    }

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

    /// The shape an MCP permission test leaves when its assertion fails mid-way: a populated
    /// directory set to `0500`, never set back.
    #[cfg(unix)]
    #[test]
    fn a_tree_left_read_only_by_a_panicking_test_is_still_removed() {
        use std::os::unix::fs::PermissionsExt;
        let seen = std::sync::Mutex::new(None::<PathBuf>);
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let s = populated("readonly");
            *seen.lock().unwrap() = Some(s.to_path_buf());
            std::fs::set_permissions(s.join("a/b"), std::fs::Permissions::from_mode(0o500))
                .unwrap();
            std::fs::set_permissions(s.join("a"), std::fs::Permissions::from_mode(0o500)).unwrap();
            panic!("the assertion before the permissions are put back");
        }));
        assert!(outcome.is_err());
        let root = seen.lock().unwrap().clone().expect("the scratch was made");
        assert!(
            !root.exists(),
            "{} survived with its permissions taken away",
            root.display()
        );
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
            "forge-runner-core/src/daemon/headroom.rs",
            2,
            "runtime: the scratch roots whose free space it reads, once under each of the unix \
             and non-unix `scratch_roots`, and creates nothing on either",
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
