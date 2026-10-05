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
pub(crate) fn is_claude(root: &Path, pid: u32) -> bool {
    claude_at(root, pid).unwrap_or(false)
}

/// [`is_claude`], saying where it could not tell. The executable link is the
/// kernel's to withhold for another user's process and is no evidence either
/// way; the arguments are readable for every process, so a failure to read
/// them, other than the process having gone, leaves the answer unknown.
pub(crate) fn claude_at(root: &Path, pid: u32) -> Result<bool, String> {
    let dir = root.join(pid.to_string());
    if let Ok(exe) = std::fs::read_link(dir.join("exe")) {
        let exe = exe.to_string_lossy();
        if exe.contains("/claude/versions/") || file_name(&exe) == "claude" {
            return Ok(true);
        }
    }
    let args = match read_cmdline(root, pid) {
        Ok(args) => args,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound || e.raw_os_error() == Some(3) => {
            return Ok(false)
        }
        Err(e) => {
            return Err(format!(
                "the arguments of pid {pid} could not be read ({e})"
            ))
        }
    };
    Ok(args
        .first()
        .is_some_and(|a| file_name(a) == "claude" || a.contains("/claude/versions/"))
        || args.iter().any(|a| a.contains("@anthropic-ai/claude-code")))
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
        /// Which pid runs beneath which: `(pid, ancestor)` pairs, and every
        /// pair not set reads `Gone`.
        pub(crate) under: Mutex<std::collections::HashSet<(u32, u32)>>,
        /// Every conversation scan answers that the table could not be read.
        pub(crate) table_unreadable: std::sync::atomic::AtomicBool,
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

        /// A pid's own read answers first, as the real table's identity
        /// check does, and only a pid that reads alive is walked.
        fn beneath(&self, pid: u32, start: &str, ancestor: u32) -> HostRead {
            let own = self.read(pid, start);
            if own != HostRead::Alive {
                return own;
            }
            if self.under.lock().unwrap().contains(&(pid, ancestor)) {
                HostRead::Alive
            } else {
                HostRead::Gone
            }
        }

        fn running(&self, conversation: &str) -> Running {
            if self
                .table_unreadable
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                return Running::Unreadable;
            }
            match self.conversations.lock().unwrap().get(conversation) {
                Some(pid) => Running::Found(*pid),
                None => Running::Absent,
            }
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

    /// What ISS-1316's carry asks: does a run's recorded process run in this
    /// pane, which is whether walking up from it reaches the pane's process.
    #[test]
    fn a_process_is_beneath_the_pane_it_runs_in_and_no_other() {
        let root = Scratch::new("proc-beneath");
        plant(&root, 60, 1, "1", 'S', &["sh", "-c", "claude"]);
        plant(&root, 61, 60, "2", 'S', &["claude"]);
        plant(&root, 70, 1, "3", 'S', &["sh", "-c", "claude"]);
        plant(&root, 71, 70, "4", 'S', &["claude"]);
        assert_eq!(beneath_at(&root, 61, "2", 60), HostRead::Alive);
        assert_eq!(
            beneath_at(&root, 60, "1", 60),
            HostRead::Alive,
            "a pane is its own"
        );
        assert_eq!(
            beneath_at(&root, 71, "4", 60),
            HostRead::Gone,
            "a Claude Code process in another pane is not this pane's, alive or not"
        );
        assert_eq!(
            beneath_at(&root, 99, "9", 60),
            HostRead::Gone,
            "a pid that is not there"
        );
        std::fs::create_dir_all(root.join("80")).unwrap();
        assert_eq!(
            beneath_at(&root, 80, "8", 60),
            HostRead::Unreadable,
            "an entry with no stat to read is no evidence either way"
        );
    }

    /// Review fc87ff F1: the recorded process exits and its pid is reused by
    /// a process that runs in the pane. The reuse starts at another time, so
    /// it is not the process the run was declared from, and nothing carries.
    #[test]
    fn a_reused_pid_beneath_the_pane_is_not_the_process_recorded() {
        let root = Scratch::new("proc-reused");
        plant(&root, 60, 1, "1", 'S', &["sh", "-c", "claude"]);
        plant(&root, 61, 60, "7", 'S', &["claude"]);
        assert_eq!(
            beneath_at(&root, 61, "2", 60),
            HostRead::Gone,
            "pid 61 runs in the pane, but it started at 7 and the run recorded 2"
        );
        assert_eq!(beneath_at(&root, 61, "7", 60), HostRead::Alive);
        plant(&root, 62, 60, "3", 'Z', &[]);
        assert_eq!(
            beneath_at(&root, 62, "3", 60),
            HostRead::Gone,
            "a zombie beneath the pane has exited"
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
        std::fs::create_dir(root.join("62")).unwrap();
        assert_eq!(
            read_at(&root, 62, "7"),
            HostRead::Unreadable,
            "a pid whose entry is there and holds no stat is not a pid that is gone"
        );
    }

    #[test]
    fn a_conversation_is_found_running_by_its_id_in_a_process_s_arguments() {
        let root = Scratch::new("proc-conv");
        background_session(&root);
        let conv = "19793a14-07b1-4970-9f51-3262792c1414";
        assert_eq!(running_at(&root, conv, 1), Running::Found(3850261));
        assert_eq!(
            running_at(&root, conv, 3850261),
            Running::Absent,
            "this process is never the answer"
        );
        assert_eq!(
            running_at(&root, "19793a14", 1),
            Running::Absent,
            "a prefix names no conversation"
        );
    }

    /// Criterion 71: a table that could not be read, whole or in part, is not
    /// a table in which no process names the conversation.
    #[test]
    fn a_table_that_cannot_be_read_says_nothing_of_who_names_a_conversation() {
        let conv = "19793a14-07b1-4970-9f51-3262792c1414";
        let root = Scratch::new("proc-conv-unread");
        assert_eq!(
            running_at(&root.join("no-such-proc"), conv, 1),
            Running::Unreadable,
            "a table that cannot be listed"
        );
        background_session(&root);
        std::fs::create_dir_all(root.join("4000000").join("cmdline")).unwrap();
        assert_eq!(
            running_at(&root, "some-other-conversation", 1),
            Running::Unreadable,
            "a process whose arguments cannot be read might be the one"
        );
        assert_eq!(
            running_at(&root, conv, 1),
            Running::Found(3850261),
            "a process that could be read naming it is still found"
        );
        std::fs::remove_dir_all(root.join("4000000")).unwrap();
        assert_eq!(
            running_at(&root, "some-other-conversation", 1),
            Running::Absent,
            "the whole table read, and none names it"
        );
        assert_eq!(
            ProcHosts { root: None }.running(conv),
            Running::Unreadable,
            "a platform with no table this code reads"
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
