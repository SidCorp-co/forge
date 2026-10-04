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
/// again under an exclusive lock through the same handle, so two installs at
/// once — a `bind` and the daemon's start sweep — add one line between them.
/// Whether this call added the line.
fn append_line(exclude: &Path) -> Result<bool, Refused> {
    let refused = |error: std::io::Error| Refused::Exclude {
        exclude: exclude.to_path_buf(),
        error: error.to_string(),
    };
    // cm:why fast path only: a peer's mandatory Windows lock fails this read (os error 33), so any
    // failure defers to the locked read below, which refuses a real one by name
    if let Ok(held) = std::fs::read(exclude) {
        if holds_line(&held) {
            return Ok(false);
        }
    }
    if let Some(dir) = exclude.parent() {
        std::fs::create_dir_all(dir).map_err(refused)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .append(true)
        .create(true)
        .open(exclude)
        .map_err(refused)?;
    file.lock().map_err(refused)?;
    let mut held = Vec::new();
    file.read_to_end(&mut held).map_err(refused)?;
    if holds_line(&held) {
        return Ok(false);
    }
    let mut body = String::new();
    if !held.is_empty() && !held.ends_with(b"\n") {
        body.push('\n');
    }
    body.push_str(LINE);
    body.push('\n');
    file.write_all(body.as_bytes()).map_err(refused)?;
    tracing::info!(
        "[git] added `{LINE}` to {}, so what this daemon writes under .claude/ is ignored there",
        exclude.display()
    );
    Ok(true)
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
