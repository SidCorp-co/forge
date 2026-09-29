//! Which process a subagent runs in, and whether that process is still there.
//!
//! A subagent runs inside the Claude Code process of the conversation that
//! dispatched it, and that process is not always the one in its master's tmux
//! pane: Claude Code can run a conversation as a background session, and a
//! pane started over it exits while the conversation and its subagents work on
//! (ISS-1312, run e67c08e0, 2026-09-29). So a pane that is gone or was started
//! again says nothing on its own about a subagent. What does is the process the
//! subagent's own hooks ran under, read back by pid and start time.
//!
//! Every read here is of a `/proc`-shaped tree rooted where the caller says, so
//! a test plants one; the box's own is read only on Linux, and anywhere else
//! nothing is recorded and every read answers [`HostRead::Unreadable`].

use std::path::{Path, PathBuf};

/// A process identified so that a later process given the same pid is not
/// taken for it: its pid and its start time in clock ticks since boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Host {
    pub pid: u32,
    pub start: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRead {
    /// The pid is there and carries the recorded start time.
    Alive,
    /// The pid is not there, carries another start time, or is a zombie.
    Gone,
    /// The pid is there and what it is could not be read.
    Unreadable,
}

/// What this box's process table says, as the daemon reads it.
pub trait Hosts: Send + Sync {
    /// Whether the process recorded as `pid` started at `start` still runs.
    fn read(&self, pid: u32, start: &str) -> HostRead;
    /// The nearest Claude Code process at or above `peer`, the process on the
    /// far end of a control-socket connection.
    fn above(&self, peer: u32) -> Option<Host>;
    /// A process whose arguments name `conversation`, other than this one.
    fn running(&self, conversation: &str) -> Option<u32>;
}

/// The process table under `root`, or none at all off Linux.
pub struct ProcHosts {
    root: Option<PathBuf>,
}

impl ProcHosts {
    /// The box's own `/proc`, where this platform has one this code can read.
    pub fn system() -> Self {
        Self {
            root: cfg!(target_os = "linux").then(|| PathBuf::from("/proc")),
        }
    }

    /// A tree shaped like `/proc`, for a test.
    pub fn at(root: &Path) -> Self {
        Self {
            root: Some(root.to_path_buf()),
        }
    }

    /// The start time `pid` carries now, which is what [`Hosts::read`] is
    /// asked to match.
    pub fn start_of(&self, pid: u32) -> Option<String> {
        match stat(self.root.as_deref()?, pid) {
            StatRead::Read(s) => Some(s.start),
            _ => None,
        }
    }
}

impl Hosts for ProcHosts {
    fn read(&self, pid: u32, start: &str) -> HostRead {
        match &self.root {
            Some(root) => read_at(root, pid, start),
            None => HostRead::Unreadable,
        }
    }

    fn above(&self, peer: u32) -> Option<Host> {
        above_at(self.root.as_deref()?, peer)
    }

    fn running(&self, conversation: &str) -> Option<u32> {
        running_at(self.root.as_deref()?, conversation, std::process::id())
    }
}

/// The fields of `<root>/<pid>/stat` this module reads.
struct Stat {
    state: char,
    ppid: u32,
    start: String,
}

enum StatRead {
    Read(Stat),
    Missing,
    Unreadable,
}

fn stat(root: &Path, pid: u32) -> StatRead {
    let text = match std::fs::read_to_string(root.join(pid.to_string()).join("stat")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return StatRead::Missing,
        Err(_) => return StatRead::Unreadable,
    };
    // The command name is parenthesised and may hold spaces and parentheses of
    // its own, so the fields after it are counted from the last `)`.
    let Some(after) = text.rfind(')').map(|i| &text[i + 1..]) else {
        return StatRead::Unreadable;
    };
    let fields: Vec<&str> = after.split_whitespace().collect();
    let (Some(state), Some(ppid), Some(start)) = (
        fields.first().and_then(|s| s.chars().next()),
        fields.get(1).and_then(|s| s.parse().ok()),
        fields.get(19),
    ) else {
        return StatRead::Unreadable;
    };
    StatRead::Read(Stat {
        state,
        ppid,
        start: (*start).to_string(),
    })
}

pub fn read_at(root: &Path, pid: u32, start: &str) -> HostRead {
    match stat(root, pid) {
        StatRead::Missing => HostRead::Gone,
        StatRead::Unreadable => HostRead::Unreadable,
        StatRead::Read(s) if s.start != start || matches!(s.state, 'Z' | 'X') => HostRead::Gone,
        StatRead::Read(_) => HostRead::Alive,
    }
}

fn cmdline(root: &Path, pid: u32) -> Vec<String> {
    std::fs::read(root.join(pid.to_string()).join("cmdline"))
        .map(|raw| {
            raw.split(|b| *b == 0)
                .filter(|a| !a.is_empty())
                .map(|a| String::from_utf8_lossy(a).into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn file_name(path: &str) -> &str {
    let path = path.strip_suffix(" (deleted)").unwrap_or(path);
    path.rsplit('/').next().unwrap_or(path)
}

/// Whether `pid` is a Claude Code process: its executable is Claude Code's
/// native build or is named `claude`, or it runs Claude Code's npm package.
fn is_claude(root: &Path, pid: u32) -> bool {
    let dir = root.join(pid.to_string());
    if let Ok(exe) = std::fs::read_link(dir.join("exe")) {
        let exe = exe.to_string_lossy();
        if exe.contains("/claude/versions/") || file_name(&exe) == "claude" {
            return true;
        }
    }
    let args = cmdline(root, pid);
    args.first()
        .is_some_and(|a| file_name(a) == "claude" || a.contains("/claude/versions/"))
        || args.iter().any(|a| a.contains("@anthropic-ai/claude-code"))
}

/// How far up from a hook's process the walk goes before it gives up: a hook
/// is a child of a shell that is a child of Claude Code.
const MAX_DEPTH: usize = 16;

pub fn above_at(root: &Path, peer: u32) -> Option<Host> {
    let mut pid = peer;
    for _ in 0..MAX_DEPTH {
        let StatRead::Read(s) = stat(root, pid) else {
            return None;
        };
        if is_claude(root, pid) {
            return Some(Host {
                pid,
                start: s.start,
            });
        }
        if s.ppid <= 1 {
            return None;
        }
        pid = s.ppid;
    }
    None
}

pub fn running_at(root: &Path, conversation: &str, own: u32) -> Option<u32> {
    let mut pids: Vec<u32> = std::fs::read_dir(root)
        .ok()?
        .filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok())
        .filter(|pid| *pid != own)
        .collect();
    pids.sort_unstable();
    pids.into_iter()
        .find(|pid| cmdline(root, *pid).iter().any(|a| a == conversation))
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// A process table a test sets by hand.
    #[derive(Default)]
    pub(crate) struct FakeHosts {
        pub(crate) reads: Mutex<HashMap<u32, HostRead>>,
        pub(crate) peers: Mutex<HashMap<u32, Host>>,
        pub(crate) conversations: Mutex<HashMap<String, u32>>,
    }

    impl FakeHosts {
        pub(crate) fn with(pid: u32, read: HostRead) -> Self {
            let f = Self::default();
            f.set(pid, read);
            f
        }

        pub(crate) fn set(&self, pid: u32, read: HostRead) {
            self.reads.lock().unwrap().insert(pid, read);
        }
    }

    impl Hosts for FakeHosts {
        fn read(&self, pid: u32, _start: &str) -> HostRead {
            self.reads
                .lock()
                .unwrap()
                .get(&pid)
                .copied()
                .unwrap_or(HostRead::Unreadable)
        }

        fn above(&self, peer: u32) -> Option<Host> {
            self.peers.lock().unwrap().get(&peer).cloned()
        }

        fn running(&self, conversation: &str) -> Option<u32> {
            self.conversations
                .lock()
                .unwrap()
                .get(conversation)
                .copied()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    /// One process in a planted `/proc`: its `stat`, its `cmdline`, and, where
    /// given, its `exe` link.
    fn plant(root: &Path, pid: u32, ppid: u32, start: &str, state: char, args: &[&str]) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        let comm = args.first().map_or("x", |a| file_name(a));
        let mut fields = vec![state.to_string(), ppid.to_string()];
        fields.extend((0..17).map(|i| i.to_string()));
        fields.push(start.to_string());
        fields.extend(["0", "0"].map(String::from));
        std::fs::write(
            dir.join("stat"),
            format!("{pid} ({comm}) {}\n", fields.join(" ")),
        )
        .unwrap();
        let mut raw = Vec::new();
        for a in args {
            raw.extend_from_slice(a.as_bytes());
            raw.push(0);
        }
        std::fs::write(dir.join("cmdline"), raw).unwrap();
    }

    /// The chain a hook runs under inside a Claude Code background session,
    /// as `ps` read it on sid-xeon-1 for conversation 19793a14: the hook, the
    /// shell Claude Code runs it through, Claude Code, its bg-pty-host.
    fn background_session(root: &Path) {
        plant(
            root,
            3850242,
            3850173,
            "900",
            'S',
            &[
                "claude",
                "bg-pty-host",
                "--bg-pty-host",
                "/tmp/cc-daemon-1000/cad15b95/pty/19793a14.sock",
            ],
        );
        plant(
            root,
            3850261,
            3850242,
            "901",
            'S',
            &[
                "/home/dev/.local/share/claude/versions/2.1.284",
                "--session-id",
                "19793a14-07b1-4970-9f51-3262792c1414",
                "--fork-session",
            ],
        );
        plant(
            root,
            3900001,
            3850261,
            "950",
            'S',
            &["/bin/sh", "-c", "forge-runner hook --event SubagentStart"],
        );
        plant(
            root,
            3900002,
            3900001,
            "951",
            'S',
            &[
                "/home/dev/.local/bin/forge-runner",
                "hook",
                "--event",
                "SubagentStart",
            ],
        );
    }

    #[test]
    fn the_host_of_a_hook_is_the_nearest_claude_code_process_above_it() {
        let root = Scratch::new("proc-above");
        background_session(&root);
        assert_eq!(
            above_at(&root, 3900002),
            Some(Host {
                pid: 3850261,
                start: "901".into()
            }),
            "the conversation's own process, not the bg-pty-host above it that is also named claude"
        );
    }

    #[test]
    fn a_hook_under_no_claude_code_process_has_no_host() {
        let root = Scratch::new("proc-none");
        plant(&root, 50, 1, "1", 'S', &["/usr/bin/zsh"]);
        plant(&root, 51, 50, "2", 'S', &["forge-runner", "run", "declare"]);
        assert_eq!(above_at(&root, 51), None);
        assert_eq!(above_at(&root, 99), None, "a peer that is not there");
    }

    #[test]
    fn the_npm_build_is_a_claude_code_process() {
        let root = Scratch::new("proc-npm");
        plant(
            &root,
            70,
            1,
            "5",
            'S',
            &[
                "node",
                "/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
            ],
        );
        plant(&root, 71, 70, "6", 'S', &["sh", "-c", "hook"]);
        assert_eq!(above_at(&root, 71).map(|h| h.pid), Some(70));
    }

    #[test]
    fn a_process_is_read_by_its_pid_and_its_start_time() {
        let root = Scratch::new("proc-read");
        background_session(&root);
        assert_eq!(read_at(&root, 3850261, "901"), HostRead::Alive);
        assert_eq!(
            read_at(&root, 3850261, "900"),
            HostRead::Gone,
            "the pid now carries another start time, so it is another process"
        );
        assert_eq!(
            read_at(&root, 4000000, "901"),
            HostRead::Gone,
            "no such pid"
        );
        plant(&root, 60, 1, "7", 'Z', &[]);
        assert_eq!(
            read_at(&root, 60, "7"),
            HostRead::Gone,
            "a zombie runs nothing"
        );
        std::fs::write(root.join("61"), "not a directory").unwrap();
        assert_eq!(
            read_at(&root, 61, "7"),
            HostRead::Unreadable,
            "a pid that is there and cannot be read is no evidence either way"
        );
    }

    #[test]
    fn a_conversation_is_found_running_by_its_id_in_a_process_s_arguments() {
        let root = Scratch::new("proc-conv");
        background_session(&root);
        let conv = "19793a14-07b1-4970-9f51-3262792c1414";
        assert_eq!(running_at(&root, conv, 1), Some(3850261));
        assert_eq!(
            running_at(&root, conv, 3850261),
            None,
            "this process is never the answer"
        );
        assert_eq!(
            running_at(&root, "19793a14", 1),
            None,
            "a prefix names no conversation"
        );
    }

    #[test]
    fn this_box_s_own_table_reads_this_process_alive_where_it_can_be_read() {
        let hosts = ProcHosts::system();
        let me = std::process::id();
        if !cfg!(target_os = "linux") {
            assert_eq!(hosts.read(me, "0"), HostRead::Unreadable);
            assert_eq!(hosts.above(me), None);
            return;
        }
        let StatRead::Read(s) = stat(Path::new("/proc"), me) else {
            panic!("this process's own stat");
        };
        assert_eq!(hosts.read(me, &s.start), HostRead::Alive);
        assert_eq!(hosts.read(me, "not-a-start-time"), HostRead::Gone);
    }
}
