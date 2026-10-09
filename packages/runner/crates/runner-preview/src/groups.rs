//! The dev servers' process groups, written down beside the ledger so the image that follows this
//! one stops what this one left. A handover execs in place (ISS-1379): the process, its children
//! and the ports they hold survive, and every `Child` handle does not, so without this record a
//! preview's server keeps its port until the service restarts and a fixed-port preview started
//! again answers `PORT_IN_USE`. A crash leaves the same.
//!
//! Each group is recorded with its leader's start time, read again before any signal: a pid the
//! kernel has since given to something else never matches, so it is never signalled.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Group {
    pgid: i32,
    started: String,
}

/// The groups this image started, persisted at `path` on every change.
pub struct Groups {
    path: Option<PathBuf>,
    held: Mutex<HashMap<String, Group>>,
}

impl Groups {
    /// Record at `path`; `None` records nothing (a box with no data dir).
    pub fn at(path: Option<PathBuf>) -> Self {
        Self {
            path,
            held: Mutex::new(HashMap::new()),
        }
    }

    /// The dev server of `preview` leads process group `pid`.
    pub fn note(&self, preview: &str, pid: Option<u32>) {
        let Some(pid) = pid else { return };
        let Some(started) = started_at(pid as i32) else {
            return;
        };
        self.change(|held| {
            held.insert(
                preview.to_string(),
                Group {
                    pgid: pid as i32,
                    started,
                },
            );
        });
    }

    /// `preview`'s server was stopped or exited.
    pub fn forget(&self, preview: &str) {
        self.change(|held| {
            held.remove(preview);
        });
    }

    fn change(&self, edit: impl FnOnce(&mut HashMap<String, Group>)) {
        let mut held = self.held.lock().unwrap_or_else(|p| p.into_inner());
        edit(&mut held);
        let Some(path) = &self.path else { return };
        let body = serde_json::to_vec(&*held).unwrap_or_default();
        if let Err(e) = write(path, &body) {
            tracing::warn!(
                "[preview] could not record the dev servers at {}: {e}",
                path.display()
            );
        }
    }
}

fn write(path: &Path, body: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

/// Stop every group an earlier image recorded at `path` whose leader is still the process it
/// recorded, and clear the record. Answers the groups asked to end; each is killed after `grace`.
pub fn reap_left(path: &Path, grace: std::time::Duration) -> Vec<i32> {
    let Ok(body) = std::fs::read(path) else {
        return Vec::new();
    };
    let _ = std::fs::remove_file(path);
    let left: HashMap<String, Group> = match serde_json::from_slice(&body) {
        Ok(left) => left,
        Err(e) => {
            tracing::warn!(
                "[preview] {} is not a record of dev servers ({e}); none stopped",
                path.display()
            );
            return Vec::new();
        }
    };
    let alive: Vec<Group> = left
        .into_values()
        .filter(|g| started_at(g.pgid).as_deref() == Some(g.started.as_str()))
        .collect();
    for g in &alive {
        signal(g.pgid, false);
        tracing::info!(
            "[preview] stopping dev server group {} left by an earlier image",
            g.pgid
        );
    }
    if !alive.is_empty() {
        let later = alive.clone();
        std::thread::spawn(move || {
            std::thread::sleep(grace);
            for g in later {
                if started_at(g.pgid).as_deref() == Some(g.started.as_str()) {
                    signal(g.pgid, true);
                }
            }
        });
    }
    alive.into_iter().map(|g| g.pgid).collect()
}

#[cfg(unix)]
fn signal(pgid: i32, kill: bool) {
    use nix::sys::signal::{killpg, Signal};
    let sig = if kill {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    let _ = killpg(nix::unistd::Pid::from_raw(pgid), sig);
}

#[cfg(not(unix))]
fn signal(_pgid: i32, _kill: bool) {}

/// When process `pid` started, as the kernel says: `/proc/<pid>/stat` field 22 on Linux, `ps`
/// elsewhere. `None` for a process that is gone, or a platform with neither.
fn started_at(pid: i32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // the command name may hold spaces and parentheses; the fields after its last ')' do not
        let rest = &stat[stat.rfind(')')? + 1..];
        rest.split_whitespace().nth(19).map(str::to_string)
    }
    #[cfg(all(unix, not(target_os = "linux")))]
    {
        let out = std::process::Command::new("ps")
            .args(["-o", "lstart=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
        (!text.is_empty()).then_some(text)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

#[cfg(all(test, unix))]
mod tests;
