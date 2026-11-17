//! Which processes a box started, and reaping every one of them on close.
//!
//! Every process a box starts carries `FORGE_BOX=<box id>` in its environment, and everything it
//! starts inherits it: agent-browser's daemon after it detaches, Chrome's helpers, the emulator's
//! qemu, the desktop's D-Bus and AT-SPI daemons. A box's processes are those that carry its mark,
//! every descendant of one (a process that cleared its environment, or one whose environment is
//! not readable), and every member of a session one of them leads. Close signals the whole set at
//! once, so a child cannot be re-parented away between two passes, then kills what is left.
//!
//! The adb server is shared by every android box and is started without a mark, so no box's close
//! takes another box's device away.

use std::collections::{BTreeSet, HashMap};
use std::time::Duration;

/// The variable that marks a box's processes.
pub const MARK: &str = "FORGE_BOX";

/// What [`reap`] left: the pids still alive after the kill, which is a defect said by name.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Reaped {
    pub signalled: Vec<i32>,
    pub left: Vec<i32>,
}

/// One process as `/proc` shows it to this user.
#[derive(Debug, Clone)]
struct Proc {
    pid: i32,
    ppid: i32,
    session: i32,
    mark: Option<String>,
}

/// Every process of `box_id` on this host.
pub fn pids_of(box_id: &str) -> Vec<i32> {
    owned_by(&table(), box_id).into_iter().collect()
}

/// Every box id a running process of this user carries a mark of.
pub fn marked_boxes() -> BTreeSet<String> {
    table().into_iter().filter_map(|p| p.mark).collect()
}

/// Stop every process of `box_id`: TERM, then KILL after `grace`, then wait for them to go.
pub async fn reap(box_id: &str, grace: Duration) -> Reaped {
    let first = owned_by(&table(), box_id);
    let signalled: Vec<i32> = first.iter().copied().collect();
    signal(&first, false);
    if !gone_within(box_id, &first, grace).await {
        let now: BTreeSet<i32> = owned_by(&table(), box_id)
            .union(&alive(&first))
            .copied()
            .collect();
        signal(&now, true);
        gone_within(box_id, &now, Duration::from_secs(3)).await;
    }
    let mut left: BTreeSet<i32> = owned_by(&table(), box_id);
    left.extend(alive(&first));
    Reaped {
        signalled,
        left: left.into_iter().collect(),
    }
}

async fn gone_within(box_id: &str, pids: &BTreeSet<i32>, within: Duration) -> bool {
    let until = tokio::time::Instant::now() + within;
    loop {
        if alive(pids).is_empty() && owned_by(&table(), box_id).is_empty() {
            return true;
        }
        if tokio::time::Instant::now() >= until {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The pids among `pids` still running (a zombie is not running).
fn alive(pids: &BTreeSet<i32>) -> BTreeSet<i32> {
    pids.iter().copied().filter(|p| running(*p)).collect()
}

/// The box's processes in `table`: marked, the sessions they lead, and their descendants.
fn owned_by(table: &[Proc], box_id: &str) -> BTreeSet<i32> {
    let mut owned: BTreeSet<i32> = table
        .iter()
        .filter(|p| p.mark.as_deref() == Some(box_id))
        .map(|p| p.pid)
        .collect();
    let leads: BTreeSet<i32> = owned.clone();
    owned.extend(
        table
            .iter()
            .filter(|p| leads.contains(&p.session))
            .map(|p| p.pid),
    );
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for p in table {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut stack: Vec<i32> = owned.iter().copied().collect();
    while let Some(pid) = stack.pop() {
        for c in children.get(&pid).into_iter().flatten() {
            if owned.insert(*c) {
                stack.push(*c);
            }
        }
    }
    owned.remove(&(std::process::id() as i32));
    owned
}

#[cfg(target_os = "linux")]
fn table() -> Vec<Proc> {
    let me = nix::unistd::getuid().as_raw();
    let Ok(dir) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse::<i32>().ok())
        .filter_map(|pid| read_proc(pid, me))
        .collect()
}

#[cfg(target_os = "linux")]
fn read_proc(pid: i32, me: u32) -> Option<Proc> {
    use std::os::unix::fs::MetadataExt;
    let base = format!("/proc/{pid}");
    if std::fs::metadata(&base).ok()?.uid() != me {
        return None;
    }
    let stat = std::fs::read_to_string(format!("{base}/stat")).ok()?;
    // `pid (comm) state ppid pgrp session ...`: comm may hold spaces and parentheses.
    let rest = &stat[stat.rfind(')')? + 2..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    if f.first() == Some(&"Z") {
        return None;
    }
    let ppid = f.get(1)?.parse().ok()?;
    let session = f.get(3)?.parse().ok()?;
    let mark = std::fs::read(format!("{base}/environ"))
        .ok()
        .and_then(|env| {
            env.split(|b| *b == 0).find_map(|kv| {
                let kv = std::str::from_utf8(kv).ok()?;
                kv.strip_prefix(MARK)?.strip_prefix('=').map(String::from)
            })
        });
    Some(Proc {
        pid,
        ppid,
        session,
        mark,
    })
}

#[cfg(not(target_os = "linux"))]
fn table() -> Vec<Proc> {
    Vec::new()
}

#[cfg(unix)]
fn running(pid: i32) -> bool {
    #[cfg(target_os = "linux")]
    if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        return !stat
            .rfind(')')
            .is_some_and(|i| stat[i + 2..].starts_with('Z'));
    }
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

#[cfg(not(unix))]
fn running(_pid: i32) -> bool {
    false
}

#[cfg(unix)]
fn signal(pids: &BTreeSet<i32>, kill: bool) {
    use nix::sys::signal::Signal;
    let sig = if kill {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    for pid in pids {
        let _ = nix::sys::signal::kill(nix::unistd::Pid::from_raw(*pid), sig);
    }
}

#[cfg(not(unix))]
fn signal(_pids: &BTreeSet<i32>, _kill: bool) {}

/// The resident memory of `pids`, in MB.
pub fn rss_mb(pids: &[i32]) -> u64 {
    #[cfg(target_os = "linux")]
    {
        let page = nix::unistd::sysconf(nix::unistd::SysconfVar::PAGE_SIZE)
            .ok()
            .flatten()
            .unwrap_or(4096) as u64;
        let pages: u64 = pids
            .iter()
            .filter_map(|p| std::fs::read_to_string(format!("/proc/{p}/statm")).ok())
            .filter_map(|s| s.split_whitespace().nth(1)?.parse::<u64>().ok())
            .sum();
        pages * page / (1024 * 1024)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pids;
        0
    }
}

/// A command that runs as part of `box_id`: marked, its own process group, and never waited on by
/// a shell between us and it. `kill_on_drop` stops a leader whose handle is lost; [`reap`] does
/// the rest.
pub fn command(program: impl AsRef<std::ffi::OsStr>, box_id: &str) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.env(MARK, box_id)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    cmd
}

#[cfg(test)]
mod tests;
