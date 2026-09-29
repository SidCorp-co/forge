//! When anything under a run's worktree was last written.
//!
//! This is the only liveness reading the view gives a run. A pane's status
//! line is the last frame it rendered, not the present (measured 2026-09-30:
//! `← 1 agent` over a subagent whose last write was 1h42m old), a process
//! count cannot see a subagent at all because it lives in its master's
//! process, and a directory's own mtime moves only when an entry is added to
//! that directory itself. The newest file anywhere under the tree is what moves
//! while work happens.
//!
//! Symlinks are not followed — a pnpm `node_modules` is mostly links, and
//! following them would age files outside the tree or loop — and the walk
//! stays on the tree's own filesystem. It stops at a cap and says it stopped,
//! so a partial reading is never passed off as the newest file.

use std::path::{Path, PathBuf};

use super::source::mtime_ms;

/// How many entries one walk reads before it stops and says so.
pub const ENTRY_CAP: usize = 400_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TreeAge {
    /// Nothing stands at the path.
    Gone,
    /// The walk read `entries` entries and found no regular file among them.
    NoFiles {
        entries: usize,
        unread: usize,
        /// The walk stopped at the cap, so a file may stand unvisited.
        capped: bool,
    },
    Newest {
        at_ms: i64,
        /// Relative to the tree's root.
        path: PathBuf,
        entries: usize,
        /// The walk stopped at the cap, so a newer file may exist unread.
        capped: bool,
        /// Entries inside the tree that could not be read — a directory that
        /// would not list, or an entry whose metadata would not come — so a
        /// newer file may stand among them.
        unread: usize,
    },
    /// The root itself could not be read.
    Unreadable(String),
}

pub fn newest(root: &Path, cap: usize) -> TreeAge {
    let meta = match std::fs::symlink_metadata(root) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return TreeAge::Gone,
        Err(e) => return TreeAge::Unreadable(e.to_string()),
    };
    if !meta.is_dir() {
        return TreeAge::Unreadable("the path is not a directory".into());
    }
    if let Err(e) = std::fs::read_dir(root) {
        return TreeAge::Unreadable(e.to_string());
    }
    let device = device_of(&meta);
    let mut stack = vec![root.to_path_buf()];
    let (mut entries, mut unread) = (0usize, 0usize);
    let mut best: Option<(i64, PathBuf)> = None;
    let mut capped = false;
    'walk: while let Some(dir) = stack.pop() {
        let Ok(listing) = std::fs::read_dir(&dir) else {
            unread += 1;
            continue;
        };
        for entry in listing {
            let Ok(entry) = entry else {
                unread += 1;
                continue;
            };
            if entries >= cap {
                capped = true;
                break 'walk;
            }
            entries += 1;
            // `DirEntry::metadata` does not traverse a symlink on unix.
            let Ok(m) = entry.metadata() else {
                unread += 1;
                continue;
            };
            let kind = m.file_type();
            if kind.is_dir() {
                if device_of(&m) == device {
                    stack.push(entry.path());
                }
            } else if kind.is_file() {
                match mtime_ms(&m) {
                    Some(at) => {
                        if best.as_ref().is_none_or(|(b, _)| at > *b) {
                            best = Some((at, entry.path()));
                        }
                    }
                    None => unread += 1,
                }
            }
        }
    }
    match best {
        Some((at_ms, path)) => TreeAge::Newest {
            at_ms,
            path: path
                .strip_prefix(root)
                .map(Path::to_path_buf)
                .unwrap_or(path),
            entries,
            capped,
            unread,
        },
        None => TreeAge::NoFiles {
            entries,
            unread,
            capped,
        },
    }
}

#[cfg(unix)]
fn device_of(m: &std::fs::Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt;
    m.dev()
}

#[cfg(not(unix))]
fn device_of(_m: &std::fs::Metadata) -> u64 {
    0
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::test_scratch::Scratch;
    use std::time::{Duration, SystemTime};

    fn age(path: &Path, secs_ago: u64) {
        let f = std::fs::File::options().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs_ago))
            .unwrap();
    }

    /// Criterion 5. The newest file anywhere below, deep or not, with its path.
    #[test]
    fn the_newest_file_is_found_however_deep_it_is() {
        let s = Scratch::new("tree-age");
        let root = s.path().join("wt");
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::write(root.join("top.txt"), "x").unwrap();
        std::fs::write(root.join("a/b/c/deep.rs"), "x").unwrap();
        age(&root.join("top.txt"), 7200);
        age(&root.join("a/b/c/deep.rs"), 60);
        match newest(&root, ENTRY_CAP) {
            TreeAge::Newest {
                path,
                capped,
                entries,
                ..
            } => {
                assert_eq!(path, PathBuf::from("a/b/c/deep.rs"));
                assert!(!capped);
                assert_eq!(entries, 5);
            }
            other => panic!("{other:?}"),
        }
    }

    /// Criterion 6.
    #[test]
    fn a_tree_that_is_not_there_is_gone_and_has_no_age() {
        let s = Scratch::new("tree-gone");
        assert_eq!(newest(&s.path().join("nothing"), ENTRY_CAP), TreeAge::Gone);
    }

    /// Criterion 7.
    #[test]
    fn a_walk_stopped_at_its_cap_says_it_is_partial() {
        let s = Scratch::new("tree-cap");
        for i in 0..10 {
            std::fs::write(s.path().join(format!("f{i}")), "x").unwrap();
        }
        match newest(s.path(), 4) {
            TreeAge::Newest {
                capped, entries, ..
            } => {
                assert!(capped);
                assert_eq!(entries, 4);
            }
            other => panic!("{other:?}"),
        }
    }

    /// Criterion 8's premise: a link out of the tree is not the tree's age.
    #[cfg(unix)]
    #[test]
    fn a_symlink_is_not_followed_out_of_the_tree() {
        let s = Scratch::new("tree-link");
        let root = s.path().join("wt");
        let outside = s.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("old.txt"), "x").unwrap();
        age(&root.join("old.txt"), 3600);
        std::fs::write(outside.join("fresh.txt"), "x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("node_modules")).unwrap();
        match newest(&root, ENTRY_CAP) {
            TreeAge::Newest { path, .. } => assert_eq!(path, PathBuf::from("old.txt")),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_tree_of_directories_alone_has_no_file_to_age() {
        let s = Scratch::new("tree-empty");
        std::fs::create_dir_all(s.path().join("a/b")).unwrap();
        assert_eq!(
            newest(s.path(), ENTRY_CAP),
            TreeAge::NoFiles {
                entries: 2,
                unread: 0,
                capped: false
            }
        );
    }

    /// Consult 009e48 F4: a directory the walk cannot list may hold the
    /// newest write, so it is counted aloud, never skipped in silence.
    #[cfg(unix)]
    #[test]
    fn a_directory_that_will_not_list_is_counted_as_unread() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("tree-unread");
        std::fs::write(s.path().join("old.txt"), "x").unwrap();
        let shut = s.path().join("shut");
        std::fs::create_dir_all(&shut).unwrap();
        std::fs::write(shut.join("fresh.txt"), "x").unwrap();
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
        let got = newest(s.path(), ENTRY_CAP);
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        match got {
            TreeAge::Newest { path, unread, .. } => {
                assert_eq!(path, PathBuf::from("old.txt"));
                assert_eq!(unread, 1, "the shut directory is one unread entry");
            }
            other => panic!("{other:?}"),
        }
        let only = Scratch::new("tree-unread-only");
        let shut = only.path().join("shut");
        std::fs::create_dir_all(&shut).unwrap();
        std::fs::write(shut.join("fresh.txt"), "x").unwrap();
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o000)).unwrap();
        let got = newest(only.path(), ENTRY_CAP);
        std::fs::set_permissions(&shut, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            got,
            TreeAge::NoFiles {
                entries: 1,
                unread: 1,
                capped: false
            }
        );
    }

    /// Whole-set consult at 912de89, F2: a cap reached before any file is
    /// met leaves the rest unvisited, which is not a tree with no file in it.
    #[test]
    fn a_cap_reached_before_any_file_is_partial_not_empty() {
        let s = Scratch::new("tree-cap-nofile");
        std::fs::create_dir_all(s.path().join("a")).unwrap();
        std::fs::write(s.path().join("a/deep.txt"), "x").unwrap();
        assert_eq!(
            newest(s.path(), 1),
            TreeAge::NoFiles {
                entries: 1,
                unread: 0,
                capped: true
            }
        );
    }

    #[test]
    fn a_file_where_a_tree_should_be_is_unreadable() {
        let s = Scratch::new("tree-file");
        let f = s.path().join("f");
        std::fs::write(&f, "x").unwrap();
        assert!(matches!(newest(&f, ENTRY_CAP), TreeAge::Unreadable(_)));
    }
}
