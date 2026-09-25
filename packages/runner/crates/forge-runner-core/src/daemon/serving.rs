//! Which build the running daemon is serving, as that daemon recorded it.
//!
//! `forge-runner status` and `--version` are separate processes that exec the
//! file on disk, so their own compiled version says what the file is and
//! nothing about the daemon. After a self-update the two part: the daemon keeps
//! the old inode, with no name left on the filesystem, until it restarts
//! (ISS-1223). The daemon writes this record at start and at every change of
//! its drain, and the commands read it back — checking that the process holding
//! the recorded pid is still the one that wrote it, since a pid names a process
//! only until it is reused.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE: &str = "serving.json";

/// The drain the record carries, where one is under way or has given up.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum DrainState {
    /// Admission is closed while this box waits for its holders.
    #[serde(rename_all = "camelCase")]
    Draining {
        cause: String,
        since_ms: i64,
        bound_secs: u64,
        outstanding: Vec<String>,
    },
    /// The bound passed with work outstanding; admission is open again.
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
            boot_id: crate::runner::inflight::boot_identity(),
            start_ticks: start_ticks(pid),
            version: crate::update::CURRENT_VERSION.to_string(),
            commit: crate::update::BUILD_COMMIT.to_string(),
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

#[cfg(target_os = "linux")]
pub fn start_ticks(pid: u32) -> Option<String> {
    crate::runner::doorbell::incarnation(i32::try_from(pid).ok()?)
}

#[cfg(not(target_os = "linux"))]
pub fn start_ticks(_pid: u32) -> Option<String> {
    None
}

#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    use nix::errno::Errno;
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    let Ok(raw) = i32::try_from(pid) else {
        return false;
    };
    !matches!(kill(Pid::from_raw(raw), None), Err(Errno::ESRCH))
}

#[cfg(not(unix))]
pub fn pid_alive(_pid: u32) -> bool {
    false
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
/// One case parts from `dirs_next` deliberately: with neither variable set it
/// falls back to the passwd entry, and this answers `None`. A caller cannot
/// read another process's passwd lookup, and answering `None` makes the scan
/// say it cannot attribute that process rather than attribute it wrongly.
#[cfg(target_os = "linux")]
fn config_dir_in(var: impl Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let base = match var("XDG_CONFIG_HOME") {
        Some(x) if Path::new(&x).is_absolute() => PathBuf::from(x),
        _ => PathBuf::from(var("HOME")?).join(".config"),
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
    let pairs: Vec<String> = raw
        .split(|b| *b == 0)
        .filter(|a| !a.is_empty())
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect();
    let var = |key: &str| {
        pairs
            .iter()
            .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('=').map(str::to_string))
    };
    match config_dir_in(var) {
        Some(dir) if dir == ours => Serves::This,
        Some(dir) => Serves::Other(dir),
        None => Serves::Unknown(
            "its environment names neither XDG_CONFIG_HOME nor HOME, so it resolves no configuration directory".into(),
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
                let replaced = text.ends_with(crate::exe::DELETED_SUFFIX);
                (text, Some(replaced))
            }
            Err(e) => (format!("unreadable ({e})"), None),
        };
        let serves = serves(&entry.path(), ours);
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
    let ours = crate::daemon::control::config_dir();
    scan(Path::new("/proc"), std::process::id(), ours.as_deref())
}

#[cfg(not(target_os = "linux"))]
pub fn running_daemons() -> Option<Vec<Running>> {
    None
}

/// What this box can see of a pid, so the reading can be asserted against
/// every case rather than against the one process a test happens to be.
pub struct Probe {
    pub alive: fn(u32) -> bool,
    pub start_ticks: fn(u32) -> Option<String>,
    pub boot_id: Option<String>,
    /// The daemons running without a record, where this platform can look.
    pub daemons: fn() -> Option<Vec<Running>>,
}

impl Probe {
    pub fn this_box() -> Self {
        Self {
            alive: pid_alive,
            start_ticks,
            boot_id: crate::runner::inflight::boot_identity(),
            daemons: running_daemons,
        }
    }
}

fn file_clause(r: &Running) -> String {
    match r.replaced {
        Some(true) => format!(
            "the file it started from, {}, has been replaced on disk, so it is NOT serving this binary — restarting the service turns it over",
            r.exe
        ),
        Some(false) => format!("the file it started from, {}, is still in place", r.exe),
        None => format!(
            "whether the file it started from has been replaced cannot be told: its exe link is {}",
            r.exe
        ),
    }
}

/// What the `forge-runner start` processes on this box say about the
/// configuration being read, where its own record names no serving daemon.
enum Unrecorded {
    /// This platform has no way to look at all.
    Blind,
    /// Processes that answer for this configuration, or that might.
    Answering(Vec<String>),
    /// None of them answers for this configuration; the others are named by the
    /// configuration each serves instead.
    NoneHere(Vec<PathBuf>),
}

/// A process is this configuration's daemon only where its own environment
/// resolves to this configuration. One that serves another is not evidence
/// about this one, and saying otherwise tells the operator of a box whose
/// daemon is down that a daemon is up — which is the state ISS-1223 exists to
/// end, arriving from the other side. One whose environment cannot be read is
/// named as unattributed rather than claimed either way.
fn unrecorded(probe: &Probe) -> Unrecorded {
    let Some(found) = (probe.daemons)() else {
        return Unrecorded::Blind;
    };
    let mut bodies = Vec::new();
    for r in &found {
        match &r.serves {
            Serves::This => bodies.push(format!(
                "pid {} (`forge-runner start`) serves this configuration and wrote no serving record, so which build it is serving cannot be read from here; {}",
                r.pid,
                file_clause(r)
            )),
            Serves::Unknown(why) => bodies.push(format!(
                "pid {} (`forge-runner start`) is running, and whether it serves this configuration cannot be told — {why}; {}",
                r.pid,
                file_clause(r)
            )),
            Serves::Other(_) => {}
        }
    }
    if bodies.is_empty() {
        return Unrecorded::NoneHere(
            found
                .into_iter()
                .filter_map(|r| match r.serves {
                    Serves::Other(dir) => Some(dir),
                    _ => None,
                })
                .collect(),
        );
    }
    Unrecorded::Answering(bodies)
}

fn elsewhere_clause(dirs: &[PathBuf]) -> String {
    if dirs.is_empty() {
        return String::new();
    }
    let mut named: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
    named.sort();
    named.dedup();
    format!(
        ". {} `forge-runner start` process(es) are running here for other configurations: {}",
        dirs.len(),
        named.join("; ")
    )
}

fn unrecorded_lines(probe: &Probe) -> Vec<String> {
    match unrecorded(probe) {
        Unrecorded::Blind => vec![
            "daemon     no record — and this platform gives no way to look for a daemon that predates the record, so whether one is running, and on which build, cannot be said from here"
                .to_string(),
        ],
        Unrecorded::NoneHere(elsewhere) => vec![format!(
            "daemon     no record, and no `forge-runner start` process on this box serves this configuration — no daemon is serving it{}",
            elsewhere_clause(&elsewhere)
        )],
        Unrecorded::Answering(bodies) => bodies
            .into_iter()
            .map(|b| format!("daemon     no record — {b}"))
            .collect(),
    }
}

/// Whether the recorded daemon is the process holding its pid now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Same,
    /// Alive, and nothing on this platform can say it is the same process.
    Unverified,
    Gone,
    /// The pid is held by a different process than the one that wrote it.
    Reused,
}

pub fn liveness(record: &Record, probe: &Probe) -> Liveness {
    if !(probe.alive)(record.pid) {
        return Liveness::Gone;
    }
    if let (Some(then), Some(now)) = (&record.boot_id, &probe.boot_id) {
        if then != now {
            return Liveness::Gone;
        }
    }
    match (&record.start_ticks, (probe.start_ticks)(record.pid)) {
        (Some(then), Some(now)) if *then == now => Liveness::Same,
        (Some(_), Some(_)) => Liveness::Reused,
        _ => Liveness::Unverified,
    }
}

/// A duration a person reads without arithmetic.
pub fn span_secs(secs: u64) -> String {
    if secs < 60 {
        return format!("{secs}s");
    }
    let mins = secs / 60;
    if mins < 60 {
        return format!("{mins}m");
    }
    let (hours, rest) = (mins / 60, mins % 60);
    if rest == 0 {
        format!("{hours}h")
    } else {
        format!("{hours}h {rest}m")
    }
}

fn ago(now_ms: i64, then_ms: i64) -> String {
    span_secs(((now_ms - then_ms).max(0) / 1000) as u64)
}

const INDENT: &str = "           ";

fn drain_lines(drain: &DrainState, now_ms: i64) -> Vec<String> {
    match drain {
        DrainState::Draining {
            cause,
            since_ms,
            bound_secs,
            outstanding,
        } => vec![format!(
            "{INDENT}draining for {cause} for {} of at most {}: {} outstanding{}. No run, pool job or master is admitted meanwhile",
            ago(now_ms, *since_ms),
            span_secs(*bound_secs),
            outstanding.len(),
            listed(outstanding)
        )],
        DrainState::Deferred {
            cause,
            gave_up_at_ms,
            outstanding,
            next_attempt,
            next_attempt_at_ms,
        } => {
            let due = if *next_attempt_at_ms >= now_ms {
                format!("due in {}", ago(*next_attempt_at_ms, now_ms))
            } else {
                format!("due {} ago", ago(now_ms, *next_attempt_at_ms))
            };
            vec![format!(
                "{INDENT}the drain for {cause} gave up {} ago with {} outstanding{}; admission is open, and the next attempt is {next_attempt}, {due}",
                ago(now_ms, *gave_up_at_ms),
                outstanding.len(),
                listed(outstanding)
            )]
        }
    }
}

fn listed(names: &[String]) -> String {
    if names.is_empty() {
        String::new()
    } else {
        format!(" — {}", names.join("; "))
    }
}

/// A record whose daemon is gone is not a box with no daemon: after a rollback
/// an older daemon that writes no record can be serving beside a newer record
/// it never wrote. So the processes are read here too.
fn beside_a_gone_record(gone: String, probe: &Probe) -> Vec<String> {
    match unrecorded(probe) {
        Unrecorded::Answering(bodies) => {
            let mut out = vec![format!(
                "daemon     the record is stale — {gone}; what else is running on this box:"
            )];
            out.extend(bodies.into_iter().map(|b| format!("{INDENT}{b}")));
            out
        }
        Unrecorded::NoneHere(elsewhere) => vec![format!(
            "daemon     not running — {gone}, and no `forge-runner start` process on this box serves this configuration{}",
            elsewhere_clause(&elsewhere)
        )],
        Unrecorded::Blind => vec![format!("daemon     not running — {gone}")],
    }
}

/// The `daemon` lines of `forge-runner status`.
pub fn lines(
    read: &Result<Option<Record>, Unreadable>,
    probe: &Probe,
    this_version: &str,
    this_commit: &str,
    now_ms: i64,
) -> Vec<String> {
    let record = match read {
        Err(u) => {
            return vec![format!(
                "daemon     UNREADABLE — {}: {}. Which build the daemon serves cannot be said from here; it rewrites the file at its next start or drain",
                u.path.display(),
                u.reason
            )]
        }
        Ok(None) => return unrecorded_lines(probe),
        Ok(Some(r)) => r,
    };
    let unverified = match liveness(record, probe) {
        Liveness::Gone => {
            return beside_a_gone_record(
                format!(
                    "the last daemon recorded, pid {} serving {}, is gone",
                    record.pid,
                    record.build()
                ),
                probe,
            )
        }
        Liveness::Reused => {
            return beside_a_gone_record(
                format!(
                    "pid {} is now a different process from the daemon recorded there (serving {}), so that daemon is gone",
                    record.pid,
                    record.build()
                ),
                probe,
            )
        }
        Liveness::Unverified => format!(
            " (this platform cannot confirm pid {} is still that daemon)",
            record.pid
        ),
        Liveness::Same => String::new(),
    };
    let same = record.version == this_version && record.commit == this_commit;
    let mut out = vec![if same {
        format!(
            "daemon     pid {} serving {}, the build of this binary{unverified}",
            record.pid,
            record.build()
        )
    } else {
        format!(
            "daemon     pid {} serving {} — NOT the build of this binary, {this_version} ({this_commit}); it has not restarted onto the file on disk{unverified}",
            record.pid,
            record.build()
        )
    }];
    match &record.drain {
        Some(d) => out.extend(drain_lines(d, now_ms)),
        None if !same => out.push(format!(
            "{INDENT}no restart is under way — `forge-runner update --restart`, or restarting the service, turns it over"
        )),
        None => {}
    }
    out
}

/// Whether restarting this box would change the build it serves.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Turnover {
    /// A live daemon of this configuration serves another build.
    Owed { pid: u32, build: String },
    /// A live daemon of this configuration already serves this one.
    Already { pid: u32 },
    /// It cannot be said from here, and why.
    Unknown(String),
}

/// The question `forge-runner update --restart` has to answer, which the update
/// manifest cannot: the file on disk being the latest says nothing about the
/// process serving, and after a deferred drain those two differ by definition.
/// This issue's own rule — a version claim is about the running process, not
/// the file — reaches the remedy as well as the report.
pub fn turnover(
    read: &Result<Option<Record>, Unreadable>,
    probe: &Probe,
    this_version: &str,
    this_commit: &str,
) -> Turnover {
    let record = match read {
        Err(u) => {
            return Turnover::Unknown(format!(
                "the daemon record at {} {}",
                u.path.display(),
                u.reason
            ))
        }
        Ok(None) => {
            return Turnover::Unknown(match replaced_daemon(probe) {
                Some((pid, true)) => format!(
                    "no daemon record stands for this configuration, and pid {pid} is running from a file that has since been replaced"
                ),
                _ => "no daemon record stands for this configuration".to_string(),
            })
        }
        Ok(Some(r)) => r,
    };
    match liveness(record, probe) {
        Liveness::Gone => {
            Turnover::Unknown(format!("the daemon recorded, pid {}, is gone", record.pid))
        }
        Liveness::Reused => Turnover::Unknown(format!(
            "pid {} is now a different process from the daemon recorded there",
            record.pid
        )),
        Liveness::Same | Liveness::Unverified => {
            if record.version == this_version && record.commit == this_commit {
                Turnover::Already { pid: record.pid }
            } else {
                Turnover::Owed {
                    pid: record.pid,
                    build: record.build(),
                }
            }
        }
    }
}

/// A `forge-runner start` process running from a replaced file, and whether it
/// is certainly this configuration's. One serving another configuration is
/// never returned: `--version` speaks about the daemon behind THIS
/// configuration, and a second daemon on the box is not it.
fn replaced_daemon(probe: &Probe) -> Option<(u32, bool)> {
    let mut unattributed = None;
    for r in (probe.daemons)()? {
        if r.replaced != Some(true) {
            continue;
        }
        match r.serves {
            Serves::This => return Some((r.pid, true)),
            Serves::Unknown(_) if unattributed.is_none() => unattributed = Some((r.pid, false)),
            _ => {}
        }
    }
    unattributed
}

fn a_daemon(ours: bool) -> &'static str {
    if ours {
        "the daemon on this box"
    } else {
        "a `forge-runner start` process on this box, which may or may not serve this configuration,"
    }
}

/// The sentence `--version` writes to stderr, where a live daemon serves a
/// build other than this binary's. `None` says nothing, and stdout is never
/// touched: something may be parsing it.
pub fn version_note(
    read: &Result<Option<Record>, Unreadable>,
    probe: &Probe,
    this_version: &str,
    this_commit: &str,
) -> Option<String> {
    let record = match read.as_ref().ok()? {
        Some(r) => r,
        None => {
            let (pid, ours) = replaced_daemon(probe)?;
            return Some(format!(
                "forge-runner: {} (pid {pid}) is running from a file that has since been replaced, so it is not serving this build; `forge-runner status` says more",
                a_daemon(ours)
            ));
        }
    };
    if matches!(liveness(record, probe), Liveness::Gone | Liveness::Reused) {
        let (pid, ours) = replaced_daemon(probe)?;
        return Some(format!(
            "forge-runner: {} (pid {pid}) wrote no record and is running from a file that has since been replaced, so it is not serving this build; `forge-runner status` says more",
            a_daemon(ours)
        ));
    }
    if record.version == this_version && record.commit == this_commit {
        return None;
    }
    Some(format!(
        "forge-runner: the daemon on this box (pid {}) is serving {}, not this build — it has not restarted onto the file on disk; `forge-runner status` says why",
        record.pid,
        record.build()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_236_800_000;

    fn rec(version: &str, drain: Option<DrainState>) -> Record {
        Record {
            pid: 4242,
            boot_id: Some("boot-a".into()),
            start_ticks: Some("777".into()),
            version: version.into(),
            commit: "abc1234".into(),
            started_at_ms: NOW - 3_600_000,
            drain,
        }
    }

    fn probe(alive: fn(u32) -> bool, ticks: fn(u32) -> Option<String>) -> Probe {
        Probe {
            alive,
            start_ticks: ticks,
            boot_id: Some("boot-a".into()),
            daemons: || Some(Vec::new()),
        }
    }

    fn live_same() -> Probe {
        probe(|_| true, |_| Some("777".into()))
    }

    fn joined(r: Result<Option<Record>, Unreadable>, p: &Probe) -> String {
        lines(&r, p, "0.17.9", "abc1234", NOW).join("\n")
    }

    /// Criterion 14.
    #[test]
    fn a_live_daemon_on_this_build_is_named_with_its_pid_and_build() {
        let out = joined(Ok(Some(rec("0.17.9", None))), &live_same());
        assert_eq!(
            out,
            "daemon     pid 4242 serving 0.17.9 (abc1234), the build of this binary"
        );
    }

    /// Criteria 14, 15: the measured case — the file on disk is newer than the
    /// process serving, and no drain is under way.
    #[test]
    fn a_daemon_on_an_older_build_says_so_and_that_nothing_is_turning_it_over() {
        let out = joined(Ok(Some(rec("0.17.8", None))), &live_same());
        assert!(
            out.contains("serving 0.17.8 (abc1234) — NOT the build of this binary, 0.17.9"),
            "{out}"
        );
        assert!(
            out.contains("has not restarted onto the file on disk"),
            "{out}"
        );
        assert!(out.contains("no restart is under way"), "{out}");
    }

    /// Criterion 15, a drain under way.
    #[test]
    fn a_draining_daemon_names_its_cause_its_holders_and_the_closed_admission() {
        let drain = DrainState::Draining {
            cause: "update 0.17.8 → 0.17.9".into(),
            since_ms: NOW - 7 * 60_000,
            bound_secs: 7200,
            outstanding: vec!["run r-1 (ISS-7)".into(), "run r-2 (ISS-8)".into()],
        };
        let out = joined(Ok(Some(rec("0.17.8", Some(drain)))), &live_same());
        assert!(
            out.contains("draining for update 0.17.8 → 0.17.9 for 7m of at most 2h"),
            "{out}"
        );
        assert!(
            out.contains("2 outstanding — run r-1 (ISS-7); run r-2 (ISS-8)"),
            "{out}"
        );
        assert!(
            out.contains("No run, pool job or master is admitted"),
            "{out}"
        );
        assert!(!out.contains("no restart is under way"), "{out}");
    }

    /// Criterion 15, a drain that gave up.
    #[test]
    fn a_drain_that_gave_up_names_its_holders_and_when_it_tries_again() {
        let drain = DrainState::Deferred {
            cause: "update 0.17.8 → 0.17.9".into(),
            gave_up_at_ms: NOW - 30 * 60_000,
            outstanding: vec!["run r-1 (ISS-7)".into()],
            next_attempt: "the next update check".into(),
            next_attempt_at_ms: NOW + 3 * 3_600_000 + 30 * 60_000,
        };
        let out = joined(Ok(Some(rec("0.17.8", Some(drain)))), &live_same());
        assert!(
            out.contains("gave up 30m ago with 1 outstanding — run r-1 (ISS-7)"),
            "{out}"
        );
        assert!(out.contains("admission is open"), "{out}");
        assert!(
            out.contains("the next update check, due in 3h 30m"),
            "{out}"
        );
    }

    /// Criterion 18, all four cases, and none of them names a serving build as
    /// though it were serving.
    #[test]
    fn a_build_that_cannot_be_named_says_which_case_holds() {
        let none = joined(Ok(None), &live_same());
        assert!(
            none.starts_with("daemon     no record, and no `forge-runner start` process"),
            "{none}"
        );

        let gone = joined(Ok(Some(rec("0.17.8", None))), &probe(|_| false, |_| None));
        assert!(
            gone.contains("not running") && gone.contains("is gone"),
            "{gone}"
        );
        assert!(!gone.contains("NOT the build"), "{gone}");

        let reused = joined(
            Ok(Some(rec("0.17.8", None))),
            &probe(|_| true, |_| Some("999".into())),
        );
        assert!(reused.contains("now a different process"), "{reused}");
        assert!(!reused.contains("NOT the build"), "{reused}");

        let unreadable = joined(
            Err(Unreadable {
                path: "/x/serving.json".into(),
                reason: "does not parse: EOF".into(),
            }),
            &live_same(),
        );
        assert!(
            unreadable.contains("UNREADABLE — /x/serving.json: does not parse: EOF"),
            "{unreadable}"
        );
    }

    /// Review finding 2: with no record, an older daemon serving a replaced
    /// binary is told apart from no daemon, and from one whose file stands.
    #[test]
    fn no_record_tells_an_older_daemon_on_a_replaced_binary_from_no_daemon() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![Running {
                pid: 2946187,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::This,
            }])
        };
        let stale = joined(Ok(None), &p);
        assert!(
            stale.contains(
                "pid 2946187 (`forge-runner start`) serves this configuration and wrote no serving record"
            ),
            "{stale}"
        );
        assert!(
            stale.contains("has been replaced on disk, so it is NOT serving this binary"),
            "{stale}"
        );
        let note = version_note(&Ok(None), &p, "0.17.9", "abc1234").expect("--version says it too");
        assert!(note.contains("pid 2946187"), "{note}");

        p.daemons = || {
            Some(vec![Running {
                pid: 7,
                exe: "/home/dev/.local/bin/forge-runner".into(),
                replaced: Some(false),
                serves: Serves::This,
            }])
        };
        let standing = joined(Ok(None), &p);
        assert!(standing.contains("is still in place"), "{standing}");
        assert!(!standing.contains("NOT serving"), "{standing}");
        assert_eq!(version_note(&Ok(None), &p, "0.17.9", "abc1234"), None);

        p.daemons = || None;
        let blind = joined(Ok(None), &p);
        assert!(blind.contains("gives no way to look"), "{blind}");

        // Delta review (a): an exe link that cannot be read says nothing either way.
        p.daemons = || {
            Some(vec![Running {
                pid: 8,
                exe: "unreadable (Permission denied (os error 13))".into(),
                replaced: None,
                serves: Serves::This,
            }])
        };
        let unknown = joined(Ok(None), &p);
        assert!(unknown.contains("cannot be told"), "{unknown}");
        assert!(
            !unknown.contains("still in place") && !unknown.contains("NOT serving"),
            "{unknown}"
        );
    }

    /// The rule that reads another process's environment has to be the rule
    /// this process's own config path follows, or attributing a daemon to a
    /// configuration is a second convention that agrees until it does not.
    /// `config.rs` is held by another run, so nothing there was changed and
    /// this test is the whole of the agreement.
    ///
    /// Sibling tests in this binary move `XDG_CONFIG_HOME` process-wide through
    /// `ScopedVar`, and `dirs_next` reads it afresh on every call, so the two
    /// reads below can straddle such a move. That is the environment changing
    /// and not the rule disagreeing, so the read is bracketed and retried; a
    /// window that never settles fails loudly rather than passing unmeasured.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_environment_rule_lands_where_this_process_own_config_path_does() {
        let snapshot = || {
            (
                std::env::var_os("XDG_CONFIG_HOME"),
                std::env::var_os("HOME"),
            )
        };
        for _ in 0..64 {
            let before = snapshot();
            let ours = crate::config::Config::path().unwrap();
            let dir = config_dir_in(|k| std::env::var(k).ok()).expect("this process has a HOME");
            if before != snapshot() {
                continue;
            }
            assert_eq!(Some(dir.as_path()), ours.parent());
            return;
        }
        panic!("the environment moved under every one of 64 reads, so nothing was measured");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_absolute_xdg_config_home_wins_and_a_relative_one_is_ignored() {
        let env = |xdg: Option<&str>| {
            let xdg = xdg.map(str::to_string);
            move |k: &str| match k {
                "XDG_CONFIG_HOME" => xdg.clone(),
                "HOME" => Some("/home/ada".to_string()),
                _ => None,
            }
        };
        assert_eq!(
            config_dir_in(env(Some("/srv/cfg"))),
            Some(PathBuf::from("/srv/cfg/forge-runner"))
        );
        assert_eq!(
            config_dir_in(env(Some("cfg"))),
            Some(PathBuf::from("/home/ada/.config/forge-runner")),
            "a relative XDG_CONFIG_HOME is not a base, the same way dirs_next reads it"
        );
        assert_eq!(
            config_dir_in(env(None)),
            Some(PathBuf::from("/home/ada/.config/forge-runner"))
        );
        assert_eq!(config_dir_in(|_| None), None, "no HOME resolves nothing");
    }

    /// Criterion 18, the failure this repair answers: a second daemon serving
    /// another configuration answered for this one, so a box whose daemon was
    /// down was told one was running, on a build the code never read.
    #[test]
    fn a_daemon_of_another_configuration_is_never_named_as_this_one() {
        let mut p = probe(|_| false, |_| None);
        p.daemons = || {
            Some(vec![Running {
                pid: 4126309,
                exe: "/home/dev/.local/bin/forge-runner".into(),
                replaced: Some(false),
                serves: Serves::Other("/srv/other/forge-runner".into()),
            }])
        };

        let gone = joined(Ok(Some(rec("0.17.9", None))), &p);
        assert!(
            gone.contains("not running") && gone.contains("is gone"),
            "{gone}"
        );
        assert!(
            !gone.contains("4126309"),
            "the other daemon is not this one: {gone}"
        );
        assert!(!gone.contains("the record is stale"), "{gone}");
        assert!(
            gone.contains("no `forge-runner start` process on this box serves this configuration"),
            "{gone}"
        );
        assert!(
            gone.contains("/srv/other/forge-runner"),
            "what else runs here is still said, as what it is: {gone}"
        );

        let mut reused = probe(|_| true, |_| Some("999".into()));
        reused.daemons = p.daemons;
        let out = joined(Ok(Some(rec("0.17.9", None))), &reused);
        assert!(!out.contains("4126309"), "{out}");
        assert!(out.contains("not running"), "{out}");

        let none = joined(Ok(None), &p);
        assert!(!none.contains("4126309"), "{none}");
        assert!(none.contains("no daemon is serving it"), "{none}");

        assert_eq!(
            version_note(&Ok(None), &p, "0.17.9", "abc1234"),
            None,
            "--version says nothing about another configuration's daemon"
        );
        assert_eq!(
            version_note(&Ok(Some(rec("0.17.9", None))), &p, "0.17.9", "abc1234"),
            None
        );
    }

    /// Criterion 18: a process that cannot be attributed is named as that,
    /// never as this configuration's daemon and never passed over in silence.
    #[test]
    fn a_process_that_cannot_be_attributed_is_named_as_unattributed() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![Running {
                pid: 5150,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::Unknown("its environment cannot be read (os error 13)".into()),
            }])
        };
        let out = joined(Ok(None), &p);
        assert!(
            out.contains("whether it serves this configuration cannot be told"),
            "{out}"
        );
        assert!(out.contains("pid 5150"), "{out}");
        assert!(
            !out.contains("serves this configuration and wrote no serving record"),
            "it is not claimed as ours: {out}"
        );
        let note = version_note(&Ok(None), &p, "0.17.9", "abc1234").expect("it is still said");
        assert!(
            note.contains("may or may not serve this configuration"),
            "{note}"
        );
    }

    /// No line says a process is running from a build older than the record:
    /// nothing reads either build, and on the box that failed this criterion
    /// the process named was running the NEWER one.
    #[test]
    fn no_line_infers_an_ordering_between_builds_it_never_read() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![Running {
                pid: 4126309,
                exe: "/home/dev/.local/bin/forge-runner".into(),
                replaced: Some(false),
                serves: Serves::This,
            }])
        };
        let out = joined(Ok(None), &p);
        assert!(!out.contains("older than the record"), "{out}");
        assert!(
            out.contains("wrote no serving record, so which build it is serving cannot be read"),
            "{out}"
        );
    }

    /// The list under a stale record's line is indented under it, so three
    /// findings is not what one finding with two entries looks like.
    #[test]
    fn the_processes_under_a_stale_record_are_indented_under_its_line() {
        let mut p = probe(|_| false, |_| None);
        p.daemons = || {
            Some(vec![Running {
                pid: 2946187,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::This,
            }])
        };
        let out = lines(&Ok(Some(rec("0.17.9", None))), &p, "0.17.9", "abc1234", NOW);
        assert_eq!(out.len(), 2, "{out:?}");
        assert!(
            out[0].starts_with("daemon     the record is stale"),
            "{out:?}"
        );
        assert!(out[1].starts_with(INDENT), "{out:?}");
        assert!(!out[1].starts_with("daemon"), "{out:?}");
    }

    /// What `update --restart` has to ask, which the manifest cannot answer.
    #[test]
    fn turnover_answers_from_the_process_and_not_from_the_file() {
        assert_eq!(
            turnover(
                &Ok(Some(rec("0.17.8", None))),
                &live_same(),
                "0.17.9",
                "abc1234"
            ),
            Turnover::Owed {
                pid: 4242,
                build: "0.17.8 (abc1234)".into()
            }
        );
        assert_eq!(
            turnover(
                &Ok(Some(rec("0.17.9", None))),
                &live_same(),
                "0.17.9",
                "abc1234"
            ),
            Turnover::Already { pid: 4242 }
        );
        let gone = turnover(
            &Ok(Some(rec("0.17.8", None))),
            &probe(|_| false, |_| None),
            "0.17.9",
            "abc1234",
        );
        assert!(matches!(gone, Turnover::Unknown(w) if w.contains("is gone")),);
        let nothing = turnover(&Ok(None), &live_same(), "0.17.9", "abc1234");
        assert!(matches!(nothing, Turnover::Unknown(w) if w.contains("no daemon record")));
    }

    /// Delta review (b): after a rollback, a newer record whose daemon is gone
    /// sits beside an older daemon that writes none. That is not "not running".
    #[test]
    fn a_gone_record_beside_a_running_unrecorded_daemon_names_that_daemon() {
        let mut p = probe(|_| false, |_| None);
        p.daemons = || {
            Some(vec![Running {
                pid: 2946187,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::This,
            }])
        };
        let out = joined(Ok(Some(rec("0.17.9", None))), &p);
        assert!(out.contains("the record is stale"), "{out}");
        assert!(
            out.contains(
                "pid 2946187 (`forge-runner start`) serves this configuration and wrote no serving record"
            ),
            "{out}"
        );
        assert!(!out.contains("daemon     not running"), "{out}");
        let note = version_note(&Ok(Some(rec("0.17.9", None))), &p, "0.17.9", "abc1234")
            .expect("--version says it too");
        assert!(note.contains("pid 2946187"), "{note}");

        let mut reused = probe(|_| true, |_| Some("999".into()));
        reused.daemons = p.daemons;
        assert!(joined(Ok(Some(rec("0.17.9", None))), &reused).contains("the record is stale"));

        p.daemons = || Some(Vec::new());
        let none = joined(Ok(Some(rec("0.17.9", None))), &p);
        assert!(
            none.contains("not running") && none.contains("no `forge-runner start` process"),
            "{none}"
        );
    }

    /// The scan over a planted `/proc`: a `forge-runner start` whose exe link
    /// carries the deleted suffix, one whose file stands, a `forge-runner
    /// status` and an unrelated process, and this process itself. Each daemon
    /// is attributed to the configuration its own environment resolves to.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_scan_finds_the_daemons_and_reads_which_run_a_replaced_file() {
        let root = crate::test_scratch::Scratch::new("serving-proc");
        let plant = |pid: u32, argv: &[&str], exe: &str, env: &[&str]| {
            let d = root.join(pid.to_string());
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("cmdline"), argv.join("\0") + "\0").unwrap();
            std::os::unix::fs::symlink(exe, d.join("exe")).unwrap();
            if !env.is_empty() {
                std::fs::write(d.join("environ"), env.join("\0") + "\0").unwrap();
            }
        };
        let ours = PathBuf::from("/home/dev/.config/forge-runner");
        plant(
            100,
            &["/home/dev/.local/bin/forge-runner", "start"],
            "/home/dev/.local/bin/forge-runner (deleted)",
            &["HOME=/home/dev", "LANG=C"],
        );
        plant(
            101,
            &["forge-runner", "--core-url", "x", "start"],
            "/home/dev/.local/bin/forge-runner",
            &["HOME=/home/dev", "XDG_CONFIG_HOME=/srv/other"],
        );
        plant(
            102,
            &["/home/dev/.local/bin/forge-runner", "status"],
            "/home/dev/.local/bin/forge-runner",
            &["HOME=/home/dev"],
        );
        plant(103, &["/usr/bin/sleep", "start"], "/usr/bin/sleep", &[]);
        plant(
            104,
            &["/home/dev/.local/bin/forge-runner", "start"],
            "/home/dev/.local/bin/forge-runner",
            &["HOME=/home/dev"],
        );
        std::fs::create_dir_all(root.join("self")).unwrap();
        let found = scan(&root, 104, Some(&ours)).expect("the planted root lists");
        assert_eq!(
            found,
            vec![
                Running {
                    pid: 100,
                    exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                    replaced: Some(true),
                    serves: Serves::This,
                },
                Running {
                    pid: 101,
                    exe: "/home/dev/.local/bin/forge-runner".into(),
                    replaced: Some(false),
                    serves: Serves::Other("/srv/other/forge-runner".into()),
                },
            ]
        );
        assert_eq!(scan(&root.join("absent"), 1, Some(&ours)), None);

        // Criterion 18: a process whose environment cannot be read is named as
        // unattributed, never as this configuration's daemon.
        let blind = crate::test_scratch::Scratch::new("serving-proc-blind");
        let d = blind.join("200");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("cmdline"), "forge-runner\0start\0").unwrap();
        std::os::unix::fs::symlink("/x/forge-runner", d.join("exe")).unwrap();
        let unattributed = scan(&blind, 1, Some(&ours)).expect("the planted root lists");
        assert!(
            matches!(unattributed[0].serves, Serves::Unknown(_)),
            "{:?}",
            unattributed[0].serves
        );
        assert!(
            matches!(
                scan(&blind, 1, None).expect("lists")[0].serves,
                Serves::Unknown(_)
            ),
            "a command with no configuration of its own attributes nothing to it"
        );
    }

    /// A record from before a reboot is gone, whatever process holds its pid.
    #[test]
    fn a_record_from_another_boot_is_gone() {
        let mut p = live_same();
        p.boot_id = Some("boot-b".into());
        assert_eq!(liveness(&rec("0.17.8", None), &p), Liveness::Gone);
    }

    #[test]
    fn a_platform_with_no_start_time_says_the_identity_is_unverified() {
        let mut r = rec("0.17.9", None);
        r.start_ticks = None;
        let out = joined(Ok(Some(r)), &probe(|_| true, |_| None));
        assert!(out.contains("cannot confirm pid 4242"), "{out}");
    }

    /// Criterion 17, and its silences.
    #[test]
    fn the_version_note_speaks_only_for_a_live_daemon_on_another_build() {
        let note = version_note(
            &Ok(Some(rec("0.17.8", None))),
            &live_same(),
            "0.17.9",
            "abc1234",
        )
        .expect("a live daemon on another build is said");
        assert!(
            note.contains("pid 4242") && note.contains("0.17.8"),
            "{note}"
        );
        assert_eq!(
            version_note(
                &Ok(Some(rec("0.17.9", None))),
                &live_same(),
                "0.17.9",
                "abc1234"
            ),
            None
        );
        assert_eq!(
            version_note(
                &Ok(Some(rec("0.17.8", None))),
                &probe(|_| true, |_| Some("999".into())),
                "0.17.9",
                "abc1234"
            ),
            None,
            "a reused pid is not a daemon on another build"
        );
        assert_eq!(
            version_note(&Ok(None), &live_same(), "0.17.9", "abc1234"),
            None
        );
    }

    #[test]
    fn a_record_round_trips_through_the_file() {
        let dir = crate::test_scratch::Scratch::new("serving-rt");
        let r = rec(
            "0.17.8",
            Some(DrainState::Draining {
                cause: "c".into(),
                since_ms: NOW,
                bound_secs: 7200,
                outstanding: vec!["x".into()],
            }),
        );
        write(&dir, &r).unwrap();
        assert_eq!(read(&dir).unwrap(), Some(r));
    }

    #[test]
    fn a_file_that_is_not_there_is_no_record_and_one_that_does_not_parse_is_unreadable() {
        let dir = crate::test_scratch::Scratch::new("serving-bad");
        assert_eq!(read(&dir).unwrap(), None);
        std::fs::write(path(&dir), "{").unwrap();
        let e = read(&dir).unwrap_err();
        assert!(e.reason.starts_with("does not parse"), "{e:?}");
    }

    /// This process, recorded and read back through the real probe, is itself.
    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_reads_as_the_same_process() {
        let r = Record::this_process(NOW);
        assert_eq!(liveness(&r, &Probe::this_box()), Liveness::Same);
    }
}
