//! Which build the running daemon is serving, as that daemon recorded it.
//!
//! `forge-runner status` and `--version` are separate processes that exec the
//! file on disk, so their own compiled version says what the file is and
//! nothing about the daemon. After a self-update the two part: the daemon keeps
//! the old inode, with no name left on the filesystem, until it restarts
//! (ISS-1223). The daemon writes this record at start and at every change of
//! its handover, and the commands read it back — checking that the process holding
//! the recorded pid is still the one that wrote it, since a pid names a process
//! only until it is reused.

mod report;
pub use report::*;
mod turnover;
pub use turnover::*;

use runner_platform::proc::{pid_alive, start_ticks};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE: &str = "serving.json";

/// The handover the record carries, where one is under way or has given up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DrainState {
    /// A new build is installed and this process waits for its in-process
    /// work to end before handing over to it. Admission is open.
    #[serde(rename_all = "camelCase")]
    Waiting {
        cause: String,
        since_ms: i64,
        bound_secs: u64,
        outstanding: Vec<String>,
    },
    /// The closing window of a handover: admission is refused for the seconds
    /// it takes the requests in flight to be answered.
    #[serde(rename_all = "camelCase")]
    Draining {
        cause: String,
        since_ms: i64,
        bound_secs: u64,
        outstanding: Vec<String>,
    },
    /// The bound passed with work outstanding, or the new build could not be
    /// started; admission is open.
    #[serde(rename_all = "camelCase")]
    Deferred {
        cause: String,
        gave_up_at_ms: i64,
        outstanding: Vec<String>,
        next_attempt: String,
        next_attempt_at_ms: i64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub pid: u32,
    /// The boot the process started in, so a record from before a reboot is
    /// never read as the process now holding its pid.
    pub boot_id: Option<String>,
    /// The kernel's start time for the process, which a reused pid does not
    /// share. `None` where the platform has none to give.
    pub start_ticks: Option<String>,
    pub version: String,
    pub commit: String,
    pub started_at_ms: i64,
    #[serde(default)]
    pub drain: Option<DrainState>,
}

impl Record {
    pub fn this_process(now_ms: i64) -> Self {
        let pid = std::process::id();
        Self {
            pid,
            boot_id: runner_core::inflight::boot_identity(),
            start_ticks: start_ticks(pid),
            version: runner_update::CURRENT_VERSION.to_string(),
            commit: runner_update::BUILD_COMMIT.to_string(),
            started_at_ms: now_ms,
            drain: None,
        }
    }

    fn build(&self) -> String {
        format!("{} ({})", self.version, self.commit)
    }
}

pub fn path(dir: &Path) -> PathBuf {
    dir.join(FILE)
}

/// Written beside and renamed over, so a reader never meets half a record.
pub fn write(dir: &Path, record: &Record) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let body = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    let tmp = dir.join(format!("{FILE}.{}.tmp", std::process::id()));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path(dir))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable {
    pub path: PathBuf,
    pub reason: String,
}

/// `Ok(None)` is a file that is not there, and nothing else is.
pub fn read(dir: &Path) -> Result<Option<Record>, Unreadable> {
    let p = path(dir);
    let text = match std::fs::read_to_string(&p) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(Unreadable {
                path: p,
                reason: format!("cannot be read: {e}"),
            })
        }
    };
    serde_json::from_str(&text)
        .map(Some)
        .map_err(|e| Unreadable {
            path: p,
            reason: format!("does not parse: {e}"),
        })
}

/// Which configuration a running process serves, as far as this box can tell.
///
/// A box runs more than one daemon whenever somebody starts a second by hand to
/// see whether theirs is up, and the `forge-runner-<id>` units are built for it.
/// Without this, every one of them answered for every configuration.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Serves {
    /// Its environment resolves to the configuration being read.
    This,
    /// Its environment resolves to another configuration, named.
    Other(PathBuf),
    /// Its environment could not be read, so which one it serves is unknown.
    Unknown(String),
}

/// A `forge-runner start` process found on this box without a record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Running {
    pub pid: u32,
    /// Where `/proc/<pid>/exe` points, or why it could not be read.
    pub exe: String,
    /// Whether the file it started from has been replaced or removed, which
    /// Linux marks by suffixing the link with ` (deleted)`. `None` where the
    /// link could not be read, which says nothing either way.
    pub replaced: Option<bool>,
    /// The configuration it serves, read from its own environment.
    pub serves: Serves,
}

/// The directory `config::Config::path` puts `config.toml` in.
#[cfg(target_os = "linux")]
const CONFIG_DIR_NAME: &str = "forge-runner";

/// The `forge-runner` configuration directory an environment resolves to, by
/// the XDG rule `dirs_next::config_dir` follows on Linux — `XDG_CONFIG_HOME`
/// where it is set and absolute, else `$HOME/.config`.
///
/// It lives here rather than beside `config::Config::path`, which it has to
/// agree with, because that file is held by another run; the agreement is held
/// instead by `the_environment_rule_lands_where_this_process_own_config_path_does`,
/// which reads both and would go red on any drift between them.
///
/// It exists at all so one process can say which configuration ANOTHER process
/// on the box is serving, which is only answerable from that process's own
/// environment. Linux only: `/proc/<pid>/environ` is the only place that
/// environment can be read from, and elsewhere `dirs_next` follows the
/// platform's own convention rather than this one.
///
/// It takes `OsString` rather than `String` because an environment is bytes: a
/// `HOME` that is not UTF-8 read lossily becomes a path with U+FFFD in it,
/// which equals no real directory and so reads as ANOTHER configuration —
/// stated as fact. Every departure from `dirs_next` here answers `None`, which
/// the scan reads as *cannot be told*, rather than naming a directory:
///
/// - **Neither variable set.** `dirs_next` falls back to the passwd entry. A
///   caller cannot do another process's passwd lookup, so this answers `None`.
/// - **An empty `HOME`.** `dirs_next` treats it as unset and falls back the
///   same way; joining it would give the relative path `.config/forge-runner`,
///   which is not a configuration directory at all.
///
/// A relative `XDG_CONFIG_HOME` is not a departure: `dirs_next` ignores it and
/// falls back to `HOME` too, which is what the `_ =>` arm does.
#[cfg(target_os = "linux")]
fn config_dir_in(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Option<PathBuf> {
    let base = match var("XDG_CONFIG_HOME") {
        Some(x) if Path::new(&x).is_absolute() => PathBuf::from(x),
        _ => match var("HOME") {
            Some(h) if !h.is_empty() => PathBuf::from(h).join(".config"),
            _ => return None,
        },
    };
    Some(base.join(CONFIG_DIR_NAME))
}

/// The configuration a process serves, from `/proc/<pid>/environ`.
#[cfg(target_os = "linux")]
fn serves(proc_pid: &Path, ours: Option<&Path>) -> Serves {
    let Some(ours) = ours else {
        return Serves::Unknown(
            "this command resolves no configuration directory of its own to compare against".into(),
        );
    };
    let raw = match std::fs::read(proc_pid.join("environ")) {
        Ok(raw) => raw,
        Err(e) => {
            return Serves::Unknown(format!("its environment cannot be read ({e})"));
        }
    };
    // Bytes, not a lossy String: a value that is not UTF-8 read lossily is a
    // path with U+FFFD in it, which matches no directory and would read as
    // another configuration rather than as one that cannot be told.
    use std::os::unix::ffi::OsStrExt;
    let pairs: Vec<&[u8]> = raw.split(|b| *b == 0).filter(|a| !a.is_empty()).collect();
    let var = |key: &str| {
        pairs.iter().find_map(|kv| {
            let rest = kv.strip_prefix(key.as_bytes())?;
            let value = rest.strip_prefix(b"=")?;
            Some(std::ffi::OsStr::from_bytes(value).to_os_string())
        })
    };
    match config_dir_in(var) {
        Some(dir) if dir == ours => Serves::This,
        Some(dir) => Serves::Other(dir),
        None => Serves::Unknown(
            "its environment names no absolute XDG_CONFIG_HOME and no non-empty HOME, so it resolves no configuration directory this command can compare".into(),
        ),
    }
}

#[cfg(not(target_os = "linux"))]
fn serves(_proc_pid: &Path, _ours: Option<&Path>) -> Serves {
    Serves::Unknown("this platform cannot read another process's environment".into())
}

/// Every `forge-runner start` process under `root` (a `/proc`) other than
/// `self_pid`, each with the configuration directory it serves compared against
/// `ours`. `None` where `root` cannot be listed at all.
///
/// A daemon that predates the serving record writes none, and "no record" alone
/// cannot tell that daemon from no daemon — one of them is a box serving a
/// deleted binary with nothing saying so, which is the state ISS-1223 exists to
/// end. So the absent record is read against the processes themselves. Which of
/// them answers for the configuration being read is the second half of that: a
/// process serving a different `XDG_CONFIG_HOME` says nothing about this one,
/// and naming it as this one's daemon tells an operator whose daemon is down
/// that one is running.
pub fn scan(root: &Path, self_pid: u32, ours: Option<&Path>) -> Option<Vec<Running>> {
    scan_with(root, self_pid, ours, start_ticks)
}

/// `scan`, with the reading of a pid's identity supplied.
///
/// A `/proc/<pid>` entry is not one file: the cmdline says it is a daemon, the
/// exe link says which build, and the environ says whose configuration. A pid
/// that exits between those reads and is handed to another process makes one
/// `Running` out of two of them — and on a box running a second runner, the
/// replacement may be that second runner, so the mixed reading is exactly the
/// misattribution this issue exists to end, arrived at from the other side. So
/// the pid's identity is read before the sequence and again after it, and an
/// entry whose identity moved is not reported at all. It is passed in rather
/// than taken from `/proc` so a test can move it, which a planted tree cannot.
pub fn scan_with(
    root: &Path,
    self_pid: u32,
    ours: Option<&Path>,
    identity: impl Fn(u32) -> Option<String>,
) -> Option<Vec<Running>> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == self_pid {
            continue;
        }
        let before = identity(pid);
        // A pid whose cmdline cannot be read is skipped with no trace, and the
        // absolute sentence this feeds — "no process serves this
        // configuration" — survives it: this configuration's daemon reads this
        // user's config directory and so runs as this user, whose `cmdline` is
        // readable. A pid that refuses the read belongs to another user, and a
        // process of another user is a process of another configuration.
        let Ok(raw) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        let args: Vec<String> = raw
            .split(|b| *b == 0)
            .filter(|a| !a.is_empty())
            .map(|a| String::from_utf8_lossy(a).into_owned())
            .collect();
        let is_runner = args
            .first()
            .and_then(|a0| Path::new(a0).file_name())
            .is_some_and(|n| n.to_string_lossy().starts_with("forge-runner"));
        if !is_runner || !args.iter().skip(1).any(|a| a == "start") {
            continue;
        }
        let (exe, replaced) = match std::fs::read_link(entry.path().join("exe")) {
            Ok(link) => {
                let text = link.to_string_lossy().into_owned();
                let replaced = text.ends_with(runner_platform::exe::DELETED_SUFFIX);
                (text, Some(replaced))
            }
            Err(e) => (format!("unreadable ({e})"), None),
        };
        let serves = serves(&entry.path(), ours);
        // Everything above came off one pid. Only now can this box say whether
        // it came off one PROCESS. Where the platform answers nothing for
        // either read the two are still equal, which is the reading it has —
        // `liveness` is where that unconfirmable identity is declared.
        if identity(pid) != before {
            continue;
        }
        found.push(Running {
            pid,
            exe,
            replaced,
            serves,
        });
    }
    found.sort_by_key(|r| r.pid);
    Some(found)
}

#[cfg(target_os = "linux")]
pub fn running_daemons() -> Option<Vec<Running>> {
    let ours = runner_platform::config::config_dir();
    scan(Path::new("/proc"), std::process::id(), ours.as_deref())
}

#[cfg(not(target_os = "linux"))]
pub fn running_daemons() -> Option<Vec<Running>> {
    None
}
