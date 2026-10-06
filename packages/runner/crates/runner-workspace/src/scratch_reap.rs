//! The reaper for scratch that lies outside every repository.
//!
//! [`crate::worktree_reap`] reaches only `.claude/worktrees` and `.worktrees`
//! under a bound repo, and refuses anything younger than a fortnight. Every tree
//! that filled `sid-xeon-1`'s `/tmp` on 2026-09-25 was outside one and a day old
//! (ISS-1260, ISS-136), so this sweeps the daemon's own scratch root on a short
//! age of its own.
//!
//! What it removes is decided in the order a wrong answer costs most, and the
//! first refusal wins; nothing here guesses:
//!
//! 1. Only a real directory directly under the root. A symlink, a file or a
//!    socket is never touched.
//! 2. Only an entry the box can ATTRIBUTE to a run: named `forge-run-<id>` (the
//!    scratch record the forge CLI mints), or holding a git checkout within
//!    [`CHECKOUT_DEPTH`] levels, which is what the judge and run trees were. The
//!    root also holds tmux's socket directory and every tool's private state,
//!    and a name-matching sweep over those deletes what nobody can get back.
//!    Entries that are neither are counted and left, never named one by one.
//! 3. Never one a held run's `worktree_path` is, lies in, or contains.
//! 4. Never one younger than `min_age` by its NEWEST file: a directory's own
//!    mtime says nothing about the tree under it.
//! 5. Never one a process is living in.
//! 6. Never one holding a checkout with unsaved changes or unpushed commits, or
//!    one git cannot be asked about. Named and kept.
//!
//! **Priced amnesty: non-Linux boxes are not swept.** Rule 5 needs a process
//! table the portable reading of which this repository's CI cannot exercise
//! (`worktree_processes::Reading::NoTable`); the sweep reports that it cannot
//! look and removes nothing. Ends when a non-Linux box has a scratch root whose
//! growth is measured.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::worktree_processes::{residents_of, Reading};
use crate::worktree_reap::{holds_work, HeldTrees};

/// How old, by its newest file, a scratch tree is before it is removable. A
/// scratch tree holds neither unpushed commits nor unsaved edits (rule 6 keeps
/// any that does) and what matters from a run is attached to its issue, so this
/// is far shorter than `worktree_reap::MIN_AGE`.
pub const MIN_AGE: Duration = Duration::from_secs(48 * 3600);

/// How often the sweep runs.
pub const SWEEP_PERIOD: Duration = Duration::from_secs(3600);

/// How far below an entry a `.git` is looked for.
const CHECKOUT_DEPTH: usize = 3;

/// The name the forge CLI gives a run's scratch directory.
const RECORD_PREFIX: &str = "forge-run-";

#[derive(Debug, Default)]
pub struct Swept {
    pub removed: Vec<PathBuf>,
    /// Each attributable entry left alone, and why.
    pub kept: Vec<(PathBuf, String)>,
    /// Entries nothing attributes to a run, left untouched.
    pub unattributed: usize,
    /// Set where the sweep could not look at all.
    pub refused: Option<String>,
}

pub async fn reap_scratch(root: &Path, min_age: Duration, held: &HeldTrees) -> Swept {
    reap_scratch_in(
        root,
        min_age,
        held,
        Path::new(crate::worktree_processes::PROC),
    )
    .await
}

pub async fn reap_scratch_in(
    root: &Path,
    min_age: Duration,
    held: &HeldTrees,
    proc_root: &Path,
) -> Swept {
    let mut out = Swept::default();
    let entries = match std::fs::read_dir(root) {
        Ok(rd) => rd,
        Err(e) => {
            out.refused = Some(format!("{} cannot be read: {e}", root.display()));
            return out;
        }
    };
    if !cfg!(target_os = "linux") {
        out.refused = Some("this platform keeps no process table to check a tree against".into());
        return out;
    }
    for entry in entries.flatten() {
        let path = entry.path();
        // `file_type` of a DirEntry does not follow a symlink.
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let named = entry
            .file_name()
            .to_str()
            .is_some_and(|n| n.starts_with(RECORD_PREFIX));
        let checkouts = checkouts_within(&path, CHECKOUT_DEPTH);
        if !named && checkouts.is_empty() {
            out.unattributed += 1;
            continue;
        }
        if let Some(run_id) = held.holder_overlapping(&path) {
            out.kept.push((path, format!("held by run {run_id}")));
            continue;
        }
        if !tree_is_older_than(&path, min_age) {
            continue;
        }
        match residents_of(proc_root, &path) {
            Reading::Read { residents, .. } if residents.is_empty() => {}
            Reading::Read { residents, .. } => {
                out.kept.push((
                    path,
                    format!(
                        "{} process(es) live in it, first {}",
                        residents.len(),
                        residents[0]
                    ),
                ));
                continue;
            }
            Reading::NoTable(why) | Reading::Unreadable(why) => {
                out.kept
                    .push((path, format!("the process table could not be read: {why}")));
                continue;
            }
        }
        let mut blocked = None;
        for checkout in &checkouts {
            if holds_work(checkout).await {
                blocked = Some(checkout.clone());
                break;
            }
        }
        if let Some(checkout) = blocked {
            out.kept.push((
                path,
                format!(
                    "{} holds unsaved changes or unpushed commits, or git cannot say it does not",
                    checkout.display()
                ),
            ));
            continue;
        }
        match std::fs::remove_dir_all(&path) {
            Ok(()) => out.removed.push(path),
            Err(e) => out
                .kept
                .push((path, format!("it could not be removed: {e}"))),
        }
    }
    out
}

/// Every directory within `depth` levels of (and including) `top` holding a `.git`.
fn checkouts_within(top: &Path, depth: usize) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut level = vec![top.to_path_buf()];
    for _ in 0..=depth {
        let mut next = Vec::new();
        for dir in level {
            if dir.join(".git").symlink_metadata().is_ok() {
                found.push(dir.clone());
            }
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    if e.file_type().is_ok_and(|t| t.is_dir()) && e.file_name() != ".git" {
                        next.push(e.path());
                    }
                }
            }
        }
        level = next;
    }
    found
}

/// Whether the newest thing in the tree, the tree's own directories included,
/// is at least `age` old. A tree that cannot be fully read is not old.
fn tree_is_older_than(top: &Path, age: Duration) -> bool {
    let Some(cutoff) = SystemTime::now().checked_sub(age) else {
        return false;
    };
    let mut stack = vec![top.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(meta) = dir.symlink_metadata() else {
            return false;
        };
        if meta.modified().map_or(true, |m| m > cutoff) {
            return false;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else {
            return false;
        };
        for e in rd {
            let Ok(e) = e else { return false };
            let Ok(t) = e.file_type() else { return false };
            if t.is_dir() {
                stack.push(e.path());
            } else if e
                .metadata()
                .and_then(|m| m.modified())
                .map_or(true, |m| m > cutoff)
            {
                return false;
            }
        }
    }
    true
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("forge-scratch-reap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn no_procs() -> PathBuf {
        scratch()
    }

    /// An entry whose files are all `days` old.
    fn aged(root: &Path, name: &str, days: u64) -> PathBuf {
        let p = root.join(name);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("f"), "x").unwrap();
        let when = SystemTime::now() - Duration::from_secs(days * 24 * 3600);
        for target in [p.join("f"), p.clone()] {
            std::fs::File::open(&target)
                .unwrap()
                .set_modified(when)
                .unwrap();
        }
        p
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git")
            .args(["-c", "user.email=a@b", "-c", "user.name=n"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap()
            .success();
        assert!(ok, "git {args:?}");
    }

    fn checkout_aged(root: &Path, name: &str, days: u64, dirty: bool) -> PathBuf {
        let p = root.join(name);
        std::fs::create_dir_all(&p).unwrap();
        git(&p, &["init", "-q"]);
        std::fs::write(p.join("a"), "1").unwrap();
        git(&p, &["add", "a"]);
        git(&p, &["commit", "-qm", "c"]);
        if dirty {
            std::fs::write(p.join("b"), "unsaved").unwrap();
        }
        let when = SystemTime::now() - Duration::from_secs(days * 24 * 3600);
        let mut stack = vec![p.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap().flatten() {
                if e.file_type().unwrap().is_dir() {
                    stack.push(e.path());
                } else {
                    std::fs::File::open(e.path())
                        .unwrap()
                        .set_modified(when)
                        .unwrap();
                }
            }
            std::fs::File::open(&d).unwrap().set_modified(when).unwrap();
        }
        p
    }

    #[tokio::test]
    async fn an_old_run_record_is_removed_and_a_young_one_is_not() {
        let root = scratch();
        let old = aged(&root, "forge-run-a", 5);
        let young = aged(&root, "forge-run-b", 0);
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert_eq!(swept.removed, vec![old.clone()]);
        assert!(!old.exists() && young.exists());
    }

    #[tokio::test]
    async fn an_entry_nothing_attributes_to_a_run_is_left_whatever_its_age() {
        let root = scratch();
        let tmux = aged(&root, "tmux-1000", 90);
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert!(swept.removed.is_empty() && tmux.exists());
        assert_eq!(swept.unattributed, 1);
    }

    #[tokio::test]
    async fn an_old_clean_checkout_with_no_remote_work_owed_is_judged_by_git_and_a_dirty_one_is_kept(
    ) {
        let root = scratch();
        let dirty = checkout_aged(&root, "iss9-judge-x", 5, true);
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert!(swept.removed.is_empty(), "a dirty checkout was removed");
        assert!(dirty.exists());
        assert_eq!(swept.kept.len(), 1);
        assert!(swept.kept[0].1.contains("unsaved"));
    }

    #[tokio::test]
    async fn a_checkout_with_a_commit_on_no_remote_is_kept() {
        let root = scratch();
        let p = checkout_aged(&root, "iss9-judge-y", 5, false);
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert!(
            swept.removed.is_empty() && p.exists(),
            "unpushed commits were removed"
        );
    }

    #[tokio::test]
    async fn a_symlink_is_never_followed_or_removed() {
        let root = scratch();
        let target = aged(&scratch(), "forge-run-real", 5);
        std::os::unix::fs::symlink(&target, root.join("forge-run-link")).unwrap();
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert!(swept.removed.is_empty() && target.exists());
    }

    #[tokio::test]
    async fn a_tree_a_held_run_owns_is_kept_by_name() {
        let root = scratch();
        let p = aged(&root, "forge-run-held", 5);
        let mut held = std::collections::HashMap::new();
        held.insert(p.join("sub"), "run-9".to_string());
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::for_test(held), &no_procs()).await;
        assert!(p.exists() && swept.removed.is_empty());
        assert_eq!(swept.kept[0].1, "held by run run-9");
    }

    #[tokio::test]
    async fn a_directory_whose_own_mtime_is_old_but_holds_a_new_file_is_not_old() {
        let root = scratch();
        let p = aged(&root, "forge-run-live", 5);
        std::fs::write(p.join("fresh"), "now").unwrap();
        let when = SystemTime::now() - Duration::from_secs(5 * 24 * 3600);
        std::fs::File::open(&p).unwrap().set_modified(when).unwrap();
        let swept = reap_scratch_in(&root, MIN_AGE, &HeldTrees::default(), &no_procs()).await;
        assert!(p.exists() && swept.removed.is_empty());
    }

    #[tokio::test]
    async fn an_unreadable_root_is_refused_by_name() {
        let swept = reap_scratch_in(
            Path::new("/nonexistent-scratch-root"),
            MIN_AGE,
            &HeldTrees::default(),
            &no_procs(),
        )
        .await;
        assert!(swept
            .refused
            .is_some_and(|r| r.contains("/nonexistent-scratch-root")));
    }
}
