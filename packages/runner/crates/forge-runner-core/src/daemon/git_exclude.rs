//! Making a checkout's git ignore `.claude/` before this daemon writes there.
//!
//! The forge-master skill and the hook settings both land under `.claude/`.
//! In a checkout whose git does not ignore that directory, either write is
//! untracked work in somebody's repository. The owner's rule (ISS-1357,
//! 2026-09-30) is to add `.claude/` to the checkout's `info/exclude` first:
//! that file is local to this box and never committed, so no `.gitignore`
//! changes and no checkout is refused for being merely not ignored. Where the
//! line cannot be added, nothing is written under `.claude/` unignored.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// The line this adds, and the one whose presence means nothing is added.
pub const LINE: &str = ".claude/";

/// Where a checkout stands once the step has run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ignored {
    /// Not a git work tree, so nothing can commit what is written there.
    NoGit,
    /// Git ignores the path. `added` names the exclude file this call
    /// appended the line to, and is `None` where git ignored it already.
    Yes { added: Option<PathBuf> },
}

/// Why the path is not ignored and cannot be made so.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refused {
    /// Git tracks the path, which no ignore rule undoes.
    Tracked,
    /// The exclude file holds `.claude/` and git still does not ignore the
    /// path, so a rule of the checkout's own (a `!` pattern) un-ignores it.
    StillNotIgnored { exclude: PathBuf },
    /// The exclude file could not be read or written.
    Exclude { exclude: PathBuf, error: String },
    /// Git could not be asked, or its answer could not be read.
    Git(String),
}

impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Refused::Tracked => write!(f, "the checkout's git tracks it"),
            Refused::StillNotIgnored { exclude } => write!(
                f,
                "{} holds `{LINE}` and the checkout's git still does not ignore it, so a rule of its own (a `!` pattern in a .gitignore) un-ignores it",
                exclude.display()
            ),
            Refused::Exclude { exclude, error } => write!(
                f,
                "`{LINE}` could not be added to {} ({error}), so nothing is written under .claude/ unignored",
                exclude.display()
            ),
            Refused::Git(detail) => f.write_str(detail),
        }
    }
}

/// Make `repo`'s git ignore `target` (a `/`-separated path under `.claude/`),
/// appending [`LINE`] to its exclude file where that is what it takes.
pub fn ensure_ignored(repo: &Path, target: &str) -> Result<Ignored, Refused> {
    ensure_ignored_as(repo, target, target)
}

/// The same, where what is asked about tracking and what is asked about
/// ignoring differ: a whole directory about to be written is ignored only
/// where its directory form (`dir/`) is, while it is the one file in it that
/// counts as the checkout's own when tracked.
pub fn ensure_ignored_as(repo: &Path, tracked: &str, target: &str) -> Result<Ignored, Refused> {
    let inside = git(repo, &["rev-parse", "--is-inside-work-tree"])?;
    if !inside.status.success() {
        let err = String::from_utf8_lossy(&inside.stderr);
        if err.contains("not a git repository") {
            return Ok(Ignored::NoGit);
        }
        return Err(Refused::Git(format!(
            "whether {} ignores {target} cannot be read: git rev-parse exited {}: {}",
            repo.display(),
            inside.status,
            err.trim()
        )));
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Err(Refused::Git(format!(
            "{} is inside a git directory rather than a work tree",
            repo.display()
        )));
    }
    if git(repo, &["ls-files", "--error-unmatch", "--", tracked])?
        .status
        .success()
    {
        return Err(Refused::Tracked);
    }
    if check_ignore(repo, target)? {
        return Ok(Ignored::Yes { added: None });
    }
    let exclude = exclude_file(repo)?;
    let added = append_line(&exclude)?;
    if check_ignore(repo, target)? {
        return Ok(Ignored::Yes {
            added: added.then_some(exclude),
        });
    }
    Err(Refused::StillNotIgnored { exclude })
}

/// By the rules alone (`--no-index`): tracking is asked separately and first,
/// and a directory holding a tracked file is otherwise never called ignored,
/// which would read a checkout's own README as a rule that un-ignores the rest.
fn check_ignore(repo: &Path, target: &str) -> Result<bool, Refused> {
    let asked = git(repo, &["check-ignore", "--no-index", "-q", "--", target])?;
    match asked.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(Refused::Git(format!(
            "whether {} ignores {target} cannot be read: git check-ignore exited {}: {}",
            repo.display(),
            asked.status,
            String::from_utf8_lossy(&asked.stderr).trim()
        ))),
    }
}

/// `<common git dir>/info/exclude`: a worktree reads the exclude file of the
/// repository it belongs to, not one under its own `.git` file's target.
fn exclude_file(repo: &Path) -> Result<PathBuf, Refused> {
    let out = git(repo, &["rev-parse", "--git-common-dir"])?;
    if !out.status.success() {
        return Err(Refused::Git(format!(
            "the git directory of {} cannot be read: git rev-parse --git-common-dir exited {}: {}",
            repo.display(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    let named = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let common = if named.is_absolute() {
        named
    } else {
        repo.join(named)
    };
    Ok(common.join("info").join("exclude"))
}

/// Append [`LINE`] unless a line already reads it, keeping every byte the
/// file held. Opened for append rather than replaced through a rename, so a
/// file its owner made read-only is refused rather than swapped out, and read
/// again under [`ExcludeLock`] through the same handle, so two installs at
/// once — a `bind` and the daemon's start sweep — add one line between them.
/// Whether this call added the line.
fn append_line(exclude: &Path) -> Result<bool, Refused> {
    let refused = |error: std::io::Error| Refused::Exclude {
        exclude: exclude.to_path_buf(),
        error: error.to_string(),
    };
    match std::fs::read(exclude) {
        Ok(held) if holds_line(&held) => return Ok(false),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(refused(e)),
    }
    if let Some(dir) = exclude.parent() {
        std::fs::create_dir_all(dir).map_err(refused)?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(exclude)
        .map_err(refused)?;
    let _lock = ExcludeLock::take(&file).map_err(refused)?;
    let mut held = Vec::new();
    (&file).read_to_end(&mut held).map_err(refused)?;
    if holds_line(&held) {
        return Ok(false);
    }
    let mut body = String::new();
    if !held.is_empty() && !held.ends_with(b"\n") {
        body.push('\n');
    }
    body.push_str(LINE);
    body.push('\n');
    (&file).write_all(body.as_bytes()).map_err(refused)?;
    tracing::info!(
        "[git] added `{LINE}` to {}, so what this daemon writes under .claude/ is ignored there",
        exclude.display()
    );
    Ok(true)
}

/// The byte two installs lock to exclude each other, far past any end an
/// exclude file reaches. A Windows lock is mandatory, and `File::lock` takes
/// the whole file there, which fails every other reader while it is held:
/// a peer install's read (os error 33, CI run 36822688357) and git's own,
/// for check-ignore and status. It lies inside that whole-file range, so an
/// older build's lock and this one still exclude each other.
#[cfg(windows)]
const LOCK_AT: u64 = 0x7FFF_FFFF_FFFF_FFFE;

/// An exclusive lock on an open exclude file, released when dropped.
struct ExcludeLock<'a>(&'a std::fs::File);

impl<'a> ExcludeLock<'a> {
    /// Wait for the lock.
    fn take(file: &'a std::fs::File) -> std::io::Result<Self> {
        Self::lock(file, true)
    }

    /// Take it only where nobody holds it.
    #[cfg(test)]
    fn try_take(file: &'a std::fs::File) -> std::io::Result<Self> {
        Self::lock(file, false)
    }

    #[cfg(not(windows))]
    fn lock(file: &'a std::fs::File, wait: bool) -> std::io::Result<Self> {
        if wait {
            file.lock()?;
        } else {
            file.try_lock()?;
        }
        Ok(Self(file))
    }

    #[cfg(windows)]
    fn lock(file: &'a std::fs::File, wait: bool) -> std::io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
        };
        let flags = if wait {
            LOCKFILE_EXCLUSIVE_LOCK
        } else {
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
        };
        let mut at = overlapped_at(LOCK_AT);
        // SAFETY: the handle stays open for the life of `file`, and `at` outlives the call.
        let ok = unsafe { LockFileEx(file.as_raw_handle(), flags, 0, 1, 0, &mut at) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self(file))
    }
}

impl Drop for ExcludeLock<'_> {
    #[cfg(not(windows))]
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }

    #[cfg(windows)]
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
        let mut at = overlapped_at(LOCK_AT);
        // SAFETY: as in `take`; closing the handle releases the lock should this fail.
        unsafe { UnlockFileEx(self.0.as_raw_handle(), 0, 1, 0, &mut at) };
    }
}

#[cfg(windows)]
fn overlapped_at(offset: u64) -> windows_sys::Win32::System::IO::OVERLAPPED {
    use windows_sys::Win32::System::IO::{OVERLAPPED, OVERLAPPED_0, OVERLAPPED_0_0};
    OVERLAPPED {
        Anonymous: OVERLAPPED_0 {
            Anonymous: OVERLAPPED_0_0 {
                Offset: offset as u32,
                OffsetHigh: (offset >> 32) as u32,
            },
        },
        ..Default::default()
    }
}

fn holds_line(held: &[u8]) -> bool {
    String::from_utf8_lossy(held)
        .lines()
        .any(|l| l.trim_end_matches('\r') == LINE)
}

fn git(repo: &Path, args: &[&str]) -> Result<std::process::Output, Refused> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| Refused::Git(format!("git could not be run in {}: {e}", repo.display())))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    pub(crate) fn run_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    fn repo(root: &Path, name: &str) -> PathBuf {
        let r = root.join(name);
        std::fs::create_dir_all(&r).unwrap();
        run_git(&r, &["init", "-q"]);
        r
    }

    pub(crate) fn exclude_of(repo: &Path) -> PathBuf {
        repo.join(".git").join("info").join("exclude")
    }

    /// Make `file` read-only, or `false` where this user writes through that
    /// anyway (root), which leaves nothing for a refusal test to show.
    pub(crate) fn make_read_only(file: &Path) -> bool {
        let mut ro = std::fs::metadata(file).unwrap().permissions();
        ro.set_readonly(true);
        std::fs::set_permissions(file, ro).unwrap();
        if std::fs::OpenOptions::new().append(true).open(file).is_ok() {
            make_writable(file);
            eprintln!("skipped: this user writes through a read-only file (root)");
            return false;
        }
        true
    }

    pub(crate) fn make_writable(file: &Path) {
        let mut rw = std::fs::metadata(file).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        rw.set_readonly(false);
        std::fs::set_permissions(file, rw).unwrap();
    }

    const T: &str = ".claude/skills/forge-master/SKILL.md";

    #[test]
    fn a_checkout_that_does_not_ignore_it_gets_the_line_and_every_other_byte_stays() {
        let s = Scratch::new("gx-add");
        let r = repo(s.path(), "r");
        let ex = exclude_of(&r);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        let before = "# a comment of the owner's\n*.swp\n/build";
        std::fs::write(&ex, before).unwrap();

        let Ok(Ignored::Yes { added: Some(at) }) = ensure_ignored(&r, T) else {
            panic!("the checkout was not made to ignore the path")
        };
        assert_eq!(
            std::fs::canonicalize(at).unwrap(),
            std::fs::canonicalize(&ex).unwrap()
        );
        assert_eq!(
            std::fs::read_to_string(&ex).unwrap(),
            format!("{before}\n.claude/\n")
        );
    }

    #[test]
    fn a_line_already_there_is_not_added_twice() {
        let s = Scratch::new("gx-there");
        let r = repo(s.path(), "r");
        assert!(matches!(
            ensure_ignored(&r, T),
            Ok(Ignored::Yes { added: Some(_) })
        ));
        let once = std::fs::read(exclude_of(&r)).unwrap();
        assert_eq!(ensure_ignored(&r, T), Ok(Ignored::Yes { added: None }));
        assert_eq!(std::fs::read(exclude_of(&r)).unwrap(), once);
    }

    /// Review F1 of the repair's plan: two installs into one checkout at once,
    /// as a `bind` and the daemon's start sweep can be, add one line.
    #[test]
    fn two_installs_at_once_add_one_line() {
        let s = Scratch::new("gx-race");
        for n in 0..10 {
            let r = repo(s.path(), &format!("r{n}"));
            let ex = exclude_of(&r);
            std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
            std::fs::write(&ex, "*.swp\n").unwrap();
            let gate = std::sync::Arc::new(std::sync::Barrier::new(2));
            let both: Vec<_> = (0..2)
                .map(|_| {
                    let (r, gate) = (r.clone(), gate.clone());
                    std::thread::spawn(move || {
                        gate.wait();
                        append_line(&exclude_of(&r))
                    })
                })
                .collect();
            let added: Vec<bool> = both
                .into_iter()
                .map(|h| h.join().unwrap().expect("appended"))
                .collect();
            assert_eq!(added.iter().filter(|a| **a).count(), 1, "{added:?}");
            assert_eq!(std::fs::read_to_string(&ex).unwrap(), "*.swp\n.claude/\n");
        }
    }

    fn locked_on(ex: &Path) -> std::fs::File {
        std::fs::OpenOptions::new()
            .read(true)
            .append(true)
            .open(ex)
            .unwrap()
    }

    /// Criterion 25: while an install holds its lock, the file stays readable
    /// whole, by a plain read and by git, which on Windows a whole-file lock
    /// refuses.
    #[test]
    fn a_held_lock_leaves_the_exclude_readable_by_git_and_by_a_plain_read() {
        let s = Scratch::new("gx-readable");
        let r = repo(s.path(), "r");
        let ex = exclude_of(&r);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        std::fs::write(&ex, "*.swp\n.claude/\n").unwrap();
        let file = locked_on(&ex);
        let lock = ExcludeLock::take(&file).unwrap();

        assert_eq!(std::fs::read_to_string(&ex).unwrap(), "*.swp\n.claude/\n");
        assert_eq!(check_ignore(&r, T), Ok(true));
        drop(lock);
    }

    /// Criterion 20 with the lock held before the second install starts: it
    /// waits, then finds the line the holder added and adds none. Where the
    /// worker is scheduled only after the release, its fast path passes this
    /// on its own; the exclusion is asserted apart, by
    /// `a_held_lock_keeps_a_second_one_out_until_it_is_released`.
    #[test]
    fn an_install_arriving_while_another_holds_the_lock_waits_and_adds_nothing() {
        let s = Scratch::new("gx-waits");
        let r = repo(s.path(), "r");
        let ex = exclude_of(&r);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        std::fs::write(&ex, "*.swp\n").unwrap();
        let file = locked_on(&ex);
        let lock = ExcludeLock::take(&file).unwrap();

        let late = {
            let ex = ex.clone();
            std::thread::spawn(move || append_line(&ex))
        };
        std::thread::sleep(std::time::Duration::from_millis(300));
        (&file).write_all(b".claude/\n").unwrap();
        drop(lock);

        assert_eq!(late.join().unwrap(), Ok(false));
        assert_eq!(std::fs::read_to_string(&ex).unwrap(), "*.swp\n.claude/\n");
    }

    /// The exclusion itself, apart from what an install does with it and
    /// from when a thread is scheduled: while one lock is held, a second
    /// asked through another handle is refused at once, and is had once the
    /// first is released.
    #[test]
    fn a_held_lock_keeps_a_second_one_out_until_it_is_released() {
        let s = Scratch::new("gx-excludes");
        let r = repo(s.path(), "r");
        let ex = exclude_of(&r);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        std::fs::write(&ex, "*.swp\n").unwrap();
        let (first, second) = (locked_on(&ex), locked_on(&ex));
        let lock = ExcludeLock::take(&first).unwrap();

        assert!(
            ExcludeLock::try_take(&second).is_err(),
            "a second lock was had while the first was held"
        );
        drop(lock);
        ExcludeLock::try_take(&second).expect("the second lock is had once the first is released");
    }

    #[test]
    fn a_checkout_its_gitignore_already_covers_gets_no_line() {
        let s = Scratch::new("gx-ignored");
        let r = repo(s.path(), "r");
        std::fs::write(r.join(".gitignore"), ".claude/\n").unwrap();
        let before = std::fs::read(exclude_of(&r)).ok();
        assert_eq!(ensure_ignored(&r, T), Ok(Ignored::Yes { added: None }));
        assert_eq!(std::fs::read(exclude_of(&r)).ok(), before);
    }

    #[test]
    fn a_worktree_gets_the_line_in_the_exclude_file_of_its_common_git_dir() {
        let s = Scratch::new("gx-worktree");
        let main = repo(s.path(), "main");
        std::fs::write(main.join("a"), "a").unwrap();
        run_git(&main, &["add", "a"]);
        run_git(&main, &["commit", "-q", "-m", "a"]);
        let wt = s.path().join("wt");
        run_git(
            &main,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "w"],
        );

        let Ok(Ignored::Yes { added: Some(at) }) = ensure_ignored(&wt, T) else {
            panic!("the worktree was not made to ignore the path")
        };
        assert_eq!(
            std::fs::canonicalize(&at).unwrap(),
            std::fs::canonicalize(exclude_of(&main)).unwrap(),
            "the line went somewhere git does not read for this worktree"
        );
        assert!(std::fs::read_to_string(exclude_of(&main))
            .unwrap()
            .lines()
            .any(|l| l == LINE));
    }

    #[test]
    fn a_read_only_exclude_is_refused_naming_its_path_and_left_as_it_was() {
        let s = Scratch::new("gx-readonly");
        let r = repo(s.path(), "r");
        let ex = exclude_of(&r);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        std::fs::write(&ex, "*.swp\n").unwrap();
        if !make_read_only(&ex) {
            return;
        }

        let got = ensure_ignored(&r, T);
        make_writable(&ex);

        let Err(refused @ Refused::Exclude { .. }) = got else {
            panic!("a read-only exclude was not refused: {got:?}")
        };
        let said = refused.to_string();
        assert!(said.contains(&ex.display().to_string()), "{said}");
        assert!(said.contains("unignored"), "{said}");
        assert_eq!(std::fs::read_to_string(&ex).unwrap(), "*.swp\n");
    }

    #[test]
    fn a_rule_of_the_checkouts_own_that_un_ignores_it_is_refused_after_the_line() {
        let s = Scratch::new("gx-negated");
        let r = repo(s.path(), "r");
        std::fs::write(r.join(".gitignore"), "!.claude/\n!.claude/**\n").unwrap();
        let got = ensure_ignored(&r, T);
        assert!(
            matches!(got, Err(Refused::StillNotIgnored { .. })),
            "{got:?}"
        );
    }

    #[test]
    fn a_tracked_path_is_refused_before_the_exclude_is_touched() {
        let s = Scratch::new("gx-tracked");
        let r = repo(s.path(), "r");
        let p = r.join(".claude").join("skills").join("forge-master");
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("SKILL.md"), "x").unwrap();
        run_git(&r, &["add", "-f", T]);
        let before = std::fs::read(exclude_of(&r)).ok();
        assert_eq!(ensure_ignored(&r, T), Err(Refused::Tracked));
        assert_eq!(std::fs::read(exclude_of(&r)).ok(), before);
    }

    #[test]
    fn a_directory_with_no_git_is_left_alone() {
        let s = Scratch::new("gx-nogit");
        let d = s.path().join("plain");
        std::fs::create_dir_all(&d).unwrap();
        assert_eq!(ensure_ignored(&d, T), Ok(Ignored::NoGit));
        assert!(!d.join(".git").exists());
    }
}
