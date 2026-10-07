//! Which processes stand in a tree: their working directory is inside it, and
//! they started at or after a given moment.
//!
//! The stop gate asks this of a run's worktree (`runner_core::stop_gate`). A
//! subagent runs inside its master's Claude Code process, so the process tree
//! cannot say which run started what; the worktree can, because it is that one
//! run's own. Descent from the host is not asked: a process backgrounded with
//! `&` or `nohup` is re-parented to init the moment its shell exits, and is
//! exactly the one left standing.
//!
//! Every read is of a `/proc`-shaped tree rooted where the caller says, so a
//! test plants one. Off Linux there is no such tree and every reading answers
//! [`Reading::Unreadable`].

use std::path::{Path, PathBuf};

use crate::subagent_host::{read_cmdline, stat, StatRead};

/// `USER_HZ`: `/proc/<pid>/stat` gives a process's start in these ticks since
/// boot, and the kernel fixes it at 100 on every ABI this runner ships for
/// (x86_64, aarch64), whatever the scheduler's own tick rate.
const TICKS_PER_SEC: i64 = 100;

/// How much of a command line a reader is shown.
const COMMAND_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    pub pid: u32,
    /// Its command line, clipped to [`COMMAND_CHARS`].
    pub command: String,
    /// When it started, in seconds since the epoch.
    pub started_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reading {
    /// The whole table was read; these stand in the tree, none where empty.
    Read(Vec<Standing>),
    /// The table could not be read, and why. Not the same as nothing standing.
    Unreadable(String),
}

/// The box's own process table, where this platform has one.
pub fn system_root() -> Option<PathBuf> {
    cfg!(target_os = "linux").then(|| PathBuf::from("/proc"))
}

/// `pid` and every process above it up to init, as the table under `root`
/// reads it: the process asking, which must never be counted as standing.
pub fn chain_at(root: &Path, pid: u32) -> Vec<u32> {
    let mut chain = vec![pid];
    let mut at = pid;
    while let StatRead::Read(s) = stat(root, at) {
        if s.ppid <= 1 || chain.contains(&s.ppid) {
            break;
        }
        chain.push(s.ppid);
        at = s.ppid;
    }
    chain
}

fn boot_secs(root: &Path) -> Option<i64> {
    std::fs::read_to_string(root.join("stat"))
        .ok()?
        .lines()
        .find_map(|l| l.strip_prefix("btime ")?.trim().parse().ok())
}

fn command_of(root: &Path, pid: u32) -> String {
    let line = read_cmdline(root, pid).unwrap_or_default().join(" ");
    let line = if line.is_empty() {
        std::fs::read_to_string(root.join(pid.to_string()).join("comm"))
            .unwrap_or_default()
            .trim()
            .to_string()
    } else {
        line
    };
    if line.chars().count() > COMMAND_CHARS {
        format!("{}…", line.chars().take(COMMAND_CHARS).collect::<String>())
    } else {
        line
    }
}

/// The live processes under `root` whose working directory is `tree` or below
/// it and which started at or after `since` (seconds since the epoch), leaving
/// out every pid in `exclude`. A process that exits while the table is read,
/// or whose directory this user may not read, is passed over: it is not one
/// this user's run can have left.
pub fn standing_in(root: &Path, tree: &Path, since: i64, exclude: &[u32]) -> Reading {
    let Some(boot) = boot_secs(root) else {
        return Reading::Unreadable(format!(
            "{} names no boot time, so no process's start can be placed",
            root.join("stat").display()
        ));
    };
    let entries = match std::fs::read_dir(root) {
        Ok(e) => e,
        Err(e) => {
            return Reading::Unreadable(format!(
                "the process table at {} could not be listed: {e}",
                root.display()
            ))
        }
    };
    let tree = std::fs::canonicalize(tree).unwrap_or_else(|_| tree.to_path_buf());
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if exclude.contains(&pid) {
            continue;
        }
        let Ok(cwd) = std::fs::read_link(entry.path().join("cwd")) else {
            continue;
        };
        let cwd = cwd.to_string_lossy();
        let cwd = Path::new(cwd.strip_suffix(" (deleted)").unwrap_or(&cwd));
        if !cwd.starts_with(&tree) {
            continue;
        }
        let StatRead::Read(s) = stat(root, pid) else {
            continue;
        };
        if matches!(s.state, 'Z' | 'X') {
            continue;
        }
        let Ok(ticks) = s.start.parse::<i64>() else {
            continue;
        };
        let started_at = boot + ticks / TICKS_PER_SEC;
        if started_at < since {
            continue;
        }
        found.push(Standing {
            pid,
            command: command_of(root, pid),
            started_at,
        });
    }
    found.sort_by_key(|s| s.pid);
    Reading::Read(found)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    const BOOT: i64 = 1_791_000_000;

    struct Table {
        root: PathBuf,
    }

    impl Table {
        fn new(name: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "standing-{name}-{}-{}",
                std::process::id(),
                runner_seq()
            ));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            std::fs::write(root.join("stat"), format!("cpu 1 2 3\nbtime {BOOT}\n")).unwrap();
            Self { root }
        }

        /// One process: its state, parent, start (seconds after boot), cwd and command.
        fn proc(&self, pid: u32, state: char, ppid: u32, after_boot: i64, cwd: &Path, cmd: &str) {
            let dir = self.root.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            let ticks = after_boot * TICKS_PER_SEC;
            let mut fields = vec![state.to_string(), ppid.to_string()];
            fields.extend((0..17).map(|_| "0".to_string()));
            fields.push(ticks.to_string());
            std::fs::write(
                dir.join("stat"),
                format!("{pid} (x) {}\n", fields.join(" ")),
            )
            .unwrap();
            std::os::unix::fs::symlink(cwd, dir.join("cwd")).unwrap();
            std::fs::write(dir.join("cmdline"), cmd.replace(' ', "\0")).unwrap();
        }
    }

    impl Drop for Table {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn runner_seq() -> u64 {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        N.fetch_add(1, Ordering::Relaxed)
    }

    fn tree(t: &Table) -> PathBuf {
        let tree = t.root.join("work").join("ISS-1");
        std::fs::create_dir_all(tree.join("sub")).unwrap();
        std::fs::canonicalize(tree).unwrap()
    }

    #[test]
    fn a_process_started_since_and_standing_in_the_tree_is_found_and_nothing_else_is() {
        let t = Table::new("found");
        let tree = tree(&t);
        let sibling = t.root.join("work").join("ISS-10");
        std::fs::create_dir_all(&sibling).unwrap();
        let since = BOOT + 500;
        t.proc(100, 'S', 1, 600, &tree, "cargo watch -x test");
        t.proc(101, 'R', 100, 601, &tree.join("sub"), "node server.js");
        t.proc(102, 'S', 1, 600, &t.root, "vim elsewhere");
        t.proc(
            103,
            'S',
            1,
            400,
            &tree,
            "bash -- a person's shell, older than the run",
        );
        t.proc(104, 'Z', 1, 600, &tree, "defunct");
        t.proc(105, 'S', 1, 600, &tree, "the hook itself");
        t.proc(
            106,
            'S',
            1,
            600,
            &sibling,
            "a sibling tree sharing the prefix",
        );
        let Reading::Read(found) = standing_in(&t.root, &tree, since, &[105]) else {
            panic!("the planted table was read as unreadable");
        };
        let pids: Vec<u32> = found.iter().map(|s| s.pid).collect();
        assert_eq!(pids, vec![100, 101], "{found:?}");
        assert_eq!(found[0].command, "cargo watch -x test");
        assert_eq!(found[0].started_at, BOOT + 600);
    }

    #[test]
    fn a_table_with_no_boot_time_or_no_listing_is_unreadable_not_empty() {
        let t = Table::new("unreadable");
        let tree = tree(&t);
        std::fs::write(t.root.join("stat"), "cpu 1 2 3\n").unwrap();
        assert!(matches!(
            standing_in(&t.root, &tree, 0, &[]),
            Reading::Unreadable(why) if why.contains("boot time")
        ));
        let gone = t.root.join("no-such-proc");
        assert!(matches!(
            standing_in(&gone, &tree, 0, &[]),
            Reading::Unreadable(_)
        ));
    }

    #[test]
    fn the_chain_walks_up_to_init_and_stops_at_a_loop() {
        let t = Table::new("chain");
        let tree = tree(&t);
        t.proc(300, 'S', 200, 1, &tree, "hook");
        t.proc(200, 'S', 100, 1, &tree, "sh");
        t.proc(100, 'S', 1, 1, &tree, "claude");
        assert_eq!(chain_at(&t.root, 300), vec![300, 200, 100]);
        t.proc(400, 'S', 401, 1, &tree, "a");
        t.proc(401, 'S', 400, 1, &tree, "b");
        assert_eq!(chain_at(&t.root, 400), vec![400, 401]);
    }
}
