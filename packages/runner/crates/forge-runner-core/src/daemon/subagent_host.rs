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

/// Whether a process on this box names a conversation in its arguments.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Running {
    /// This process does.
    Found(u32),
    /// The whole table was read and no process does.
    Absent,
    /// The table, or a process in it, could not be read, so neither can be
    /// said. Off Linux this is every answer.
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
    fn running(&self, conversation: &str) -> Running;
    /// Whether the process recorded as `pid` started at `start` still runs,
    /// beneath `ancestor`: `Alive` where it does and walking up from it
    /// reaches `ancestor`, `Gone` where it has exited, `pid` now names a
    /// process that started at another time, or the walk ends without
    /// reaching `ancestor`, and `Unreadable` where a step could not be read.
    /// Its identity and its parent come from one read, so a pid reused after
    /// that process exited is never walked as though it were the one recorded.
    fn beneath(&self, pid: u32, start: &str, ancestor: u32) -> HostRead;
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

    fn running(&self, conversation: &str) -> Running {
        match &self.root {
            Some(root) => running_at(root, conversation, std::process::id()),
            None => Running::Unreadable,
        }
    }

    fn beneath(&self, pid: u32, start: &str, ancestor: u32) -> HostRead {
        match &self.root {
            Some(root) => beneath_at(root, pid, start, ancestor),
            None => HostRead::Unreadable,
        }
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
        // A stat not found says the pid is gone only where the pid's own entry
        // is gone too. An entry that is there with no stat to read is no
        // evidence either way, and Windows answers a path through a file as
        // not found where Linux answers that it is not a directory.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return match std::fs::symlink_metadata(root.join(pid.to_string())) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => StatRead::Missing,
                _ => StatRead::Unreadable,
            };
        }
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
    read_cmdline(root, pid).unwrap_or_default()
}

fn read_cmdline(root: &Path, pid: u32) -> std::io::Result<Vec<String>> {
    std::fs::read(root.join(pid.to_string()).join("cmdline")).map(|raw| {
        raw.split(|b| *b == 0)
            .filter(|a| !a.is_empty())
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect()
    })
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

/// Whether `pid`, started at `start`, still runs and walking up from it
/// reaches `ancestor`, within [`MAX_DEPTH`].
pub fn beneath_at(root: &Path, pid: u32, start: &str, ancestor: u32) -> HostRead {
    let mut at = match stat(root, pid) {
        StatRead::Missing => return HostRead::Gone,
        StatRead::Unreadable => return HostRead::Unreadable,
        StatRead::Read(s) if s.start != start || matches!(s.state, 'Z' | 'X') => {
            return HostRead::Gone;
        }
        StatRead::Read(_) if pid == ancestor => return HostRead::Alive,
        StatRead::Read(s) if s.ppid > 1 => s.ppid,
        StatRead::Read(_) => return HostRead::Gone,
    };
    for _ in 1..MAX_DEPTH {
        if at == ancestor {
            return HostRead::Alive;
        }
        match stat(root, at) {
            StatRead::Read(s) if s.ppid > 1 => at = s.ppid,
            StatRead::Read(_) | StatRead::Missing => return HostRead::Gone,
            StatRead::Unreadable => return HostRead::Unreadable,
        }
    }
    HostRead::Unreadable
}

/// A process that exits while the table is read was never going to be the
/// answer and is passed over; any other read that fails leaves the answer
/// unknown unless a process that could be read names the conversation.
pub fn running_at(root: &Path, conversation: &str, own: u32) -> Running {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Running::Unreadable;
    };
    let mut pids: Vec<u32> = Vec::new();
    let mut unread = false;
    for entry in entries {
        match entry {
            Ok(e) => pids.extend(e.file_name().to_str().and_then(|n| n.parse::<u32>().ok())),
            Err(_) => unread = true,
        }
    }
    pids.retain(|pid| *pid != own);
    pids.sort_unstable();
    for pid in pids {
        match read_cmdline(root, pid) {
            Ok(args) if args.iter().any(|a| a == conversation) => return Running::Found(pid),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => unread = true,
        }
    }
    if unread {
        Running::Unreadable
    } else {
        Running::Absent
    }
}
