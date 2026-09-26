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
                let replaced = text.ends_with(crate::exe::DELETED_SUFFIX);
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

/// What the caller already knows about the record. It decides what a process
/// line may say about the build that process serves: where the record is
/// unreadable, "wrote no serving record" is a claim the command cannot make —
/// the file it cannot parse may be that very process's.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Premise {
    /// No record stands here at all.
    NoRecord,
    /// A record stands, and the daemon it names is gone.
    GoneRecord,
    /// A record stands and cannot be read.
    UnreadableRecord,
}

impl Premise {
    fn why_no_build(self) -> &'static str {
        match self {
            Self::NoRecord | Self::GoneRecord => {
                "and wrote no serving record, so which build it is serving cannot be read from here"
            }
            Self::UnreadableRecord => {
                "and the record here cannot be read, so which build it is serving cannot be read from here"
            }
        }
    }
}

/// What the `forge-runner start` processes on this box say about the
/// configuration being read, where its own record names no serving daemon.
enum Unrecorded {
    /// This platform has no way to look at all.
    Blind,
    /// Processes that answer for this configuration, or that might, and the
    /// configurations the rest of them serve.
    Answering(Vec<String>, Vec<PathBuf>),
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
fn unrecorded(probe: &Probe, premise: Premise) -> Unrecorded {
    let Some(found) = (probe.daemons)() else {
        return Unrecorded::Blind;
    };
    let mut bodies = Vec::new();
    for r in &found {
        match &r.serves {
            Serves::This => bodies.push(format!(
                "pid {} (`forge-runner start`) serves this configuration {}; {}",
                r.pid,
                premise.why_no_build(),
                file_clause(r)
            )),
            Serves::Unknown(why) => bodies.push(format!(
                "pid {} (`forge-runner start`) was running when this box was read, and whether it serves this configuration cannot be told — {why}; {}",
                r.pid,
                file_clause(r)
            )),
            Serves::Other(_) => {}
        }
    }
    let elsewhere: Vec<PathBuf> = found
        .into_iter()
        .filter_map(|r| match r.serves {
            Serves::Other(dir) => Some(dir),
            _ => None,
        })
        .collect();
    if bodies.is_empty() {
        return Unrecorded::NoneHere(elsewhere);
    }
    Unrecorded::Answering(bodies, elsewhere)
}

/// The sentence naming the `forge-runner start` processes that serve OTHER
/// configurations, where any do. It is the same sentence wherever it appears,
/// and each caller puts it in the column that caller is writing in — built
/// once here rather than un-prefixed back out of a formatted line.
fn elsewhere_sentence(dirs: &[PathBuf]) -> Option<String> {
    if dirs.is_empty() {
        return None;
    }
    let mut named: Vec<String> = dirs.iter().map(|d| d.display().to_string()).collect();
    named.sort();
    named.dedup();
    Some(format!(
        "{} `forge-runner start` process(es) are running here for other configurations: {}",
        dirs.len(),
        named.join("; ")
    ))
}

/// The `daemon` lines where no record stands at all.
fn unrecorded_lines(probe: &Probe) -> Vec<String> {
    match unrecorded(probe, Premise::NoRecord) {
        Unrecorded::Blind => vec![
            "daemon     no record — and this platform gives no way to look for a daemon that predates the record, so whether one is running, and on which build, cannot be said from here"
                .to_string(),
        ],
        Unrecorded::NoneHere(elsewhere) => vec![format!(
            "daemon     no record, and no `forge-runner start` process on this box serves this configuration — no daemon is serving it{}",
            elsewhere_sentence(&elsewhere)
                .map(|s| format!(". {s}"))
                .unwrap_or_default()
        )],
        Unrecorded::Answering(bodies, elsewhere) => {
            let mut out: Vec<String> = bodies
                .into_iter()
                .map(|b| format!("daemon     no record — {b}"))
                .collect();
            out.extend(elsewhere_sentence(&elsewhere).map(|s| format!("{INDENT}and {s}")));
            out
        }
    }
}

/// The `daemon` lines under a record that cannot be read. The record was the
/// only thing naming a build and it is unreadable, so these processes are the
/// only evidence left that anything is serving — which is why this case needs
/// them most, and why none of their lines may say the record is absent.
fn beside_an_unreadable_record(probe: &Probe) -> Vec<String> {
    match unrecorded(probe, Premise::UnreadableRecord) {
        Unrecorded::Blind => vec![format!(
            "{INDENT}and this platform gives no way to look at the `forge-runner start` processes here, so whether one is serving cannot be said from here"
        )],
        Unrecorded::NoneHere(elsewhere) => vec![format!(
            "{INDENT}and no `forge-runner start` process on this box serves this configuration{}",
            elsewhere_sentence(&elsewhere)
                .map(|s| format!(" — {s}"))
                .unwrap_or_default()
        )],
        Unrecorded::Answering(bodies, elsewhere) => {
            let mut out = vec![format!(
                "{INDENT}what is running here is the only evidence left:"
            )];
            out.extend(bodies.into_iter().map(|b| format!("{INDENT}{b}")));
            out.extend(elsewhere_sentence(&elsewhere).map(|s| format!("{INDENT}and {s}")));
            out
        }
    }
}

/// A record whose daemon is gone is not a box with no daemon: after a rollback
/// an older daemon that writes no record can be serving beside a newer record
/// it never wrote. So the processes are read here too.
fn beside_a_gone_record(gone: String, probe: &Probe) -> Vec<String> {
    match unrecorded(probe, Premise::GoneRecord) {
        Unrecorded::Answering(bodies, elsewhere) => {
            let mut out = vec![format!(
                "daemon     the record is stale — {gone}; what else is running on this box:"
            )];
            out.extend(bodies.into_iter().map(|b| format!("{INDENT}{b}")));
            out.extend(elsewhere_sentence(&elsewhere).map(|s| format!("{INDENT}and {s}")));
            out
        }
        Unrecorded::NoneHere(elsewhere) => vec![format!(
            "daemon     not running — {gone}, and no `forge-runner start` process on this box serves this configuration{}",
            elsewhere_sentence(&elsewhere)
                .map(|s| format!(". {s}"))
                .unwrap_or_default()
        )],
        // Nothing was looked at, so "not running" would be a claim about a box
        // this command never read. A daemon that predates the record is exactly
        // what would be running here, and it is the state ISS-1223 is about.
        Unrecorded::Blind => vec![format!(
            "daemon     the record is stale — {gone}, and this platform gives no way to look for a daemon that predates the record, so whether one is serving cannot be said from here"
        )],
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
        // The record HAS ticks, so the platform that wrote them could read
        // them, and `Unverified` — "nothing here can say" — is refuted by the
        // record itself. What it means is that the pid answers a signal and
        // has no start time, which is a zombie, or a process that exited
        // between the two reads. Both are a daemon that is gone, and saying so
        // is what lets `--restart` act: an operator whose daemon has zombied
        // is exactly the one who needs the restart to fire, and `Unverified`
        // now refuses it while blaming a platform limit that is not there.
        (Some(_), None) => Liveness::Gone,
        (None, _) => Liveness::Unverified,
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
            let mut out = vec![format!(
                "daemon     UNREADABLE — {}: {}. Which build the daemon serves cannot be said from here; it rewrites the file at its next start or drain",
                u.path.display(),
                u.reason
            )];
            out.extend(beside_an_unreadable_record(probe));
            return out;
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
    Owed {
        pid: u32,
        build: String,
        /// This platform cannot confirm the pid is still that daemon.
        unverified: bool,
    },
    /// A live daemon of this configuration already serves this one.
    Already { pid: u32, unverified: bool },
    /// It is turning itself over already, and a restart now would stop the
    /// very work it is waiting for.
    Draining {
        pid: u32,
        cause: String,
        outstanding: Vec<String>,
        /// This platform cannot confirm the pid is still that daemon, so the
        /// drain read here may be a dead daemon's last word.
        unverified: bool,
    },
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
                    "no daemon record stands for this configuration, and pid {pid}, which serves it, is running from a file that has since been replaced"
                ),
                Some((pid, false)) => format!(
                    "no daemon record stands for this configuration, and pid {pid} is running from a file that has since been replaced — whether it serves this configuration could not be told"
                ),
                None => "no daemon record stands for this configuration".to_string(),
            })
        }
        Ok(Some(r)) => r,
    };
    let unverified = match liveness(record, probe) {
        Liveness::Gone => {
            return Turnover::Unknown(format!("the daemon recorded, pid {}, is gone", record.pid))
        }
        Liveness::Reused => {
            return Turnover::Unknown(format!(
                "pid {} is now a different process from the daemon recorded there",
                record.pid
            ))
        }
        Liveness::Unverified => true,
        Liveness::Same => false,
    };
    // A drain under way is the daemon restarting ITSELF, holding admission shut
    // until the runs it waits on end. Restarting the unit here would stop
    // exactly those runs — the one thing the drain exists to prevent — so the
    // build comparison is not even reached. A drain that GAVE UP is the
    // opposite case: nothing will turn the box over now but a restart.
    if let Some(DrainState::Draining {
        cause, outstanding, ..
    }) = &record.drain
    {
        return Turnover::Draining {
            pid: record.pid,
            cause: cause.clone(),
            outstanding: outstanding.clone(),
            unverified,
        };
    }
    if record.version == this_version && record.commit == this_commit {
        Turnover::Already {
            pid: record.pid,
            unverified,
        }
    } else {
        Turnover::Owed {
            pid: record.pid,
            build: record.build(),
            unverified,
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

    /// Review findings F5, F6 and F9: the three places a line said more, or
    /// less, than what was looked at.
    #[test]
    fn what_is_running_is_said_in_every_case_that_looked_and_in_none_that_did_not() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![
                Running {
                    pid: 111,
                    exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                    replaced: Some(true),
                    serves: Serves::This,
                },
                Running {
                    pid: 222,
                    exe: "/home/dev/.local/bin/forge-runner".into(),
                    replaced: Some(false),
                    serves: Serves::Other("/srv/other/forge-runner".into()),
                },
            ])
        };

        // F5: an unreadable record is the one case where the processes are the
        // only evidence left, and the README says status looks at them.
        let unreadable = joined(
            Err(Unreadable {
                path: "/x/serving.json".into(),
                reason: "does not parse: EOF".into(),
            }),
            &p,
        );
        assert!(unreadable.contains("UNREADABLE"), "{unreadable}");
        assert!(
            unreadable.contains("pid 111") && unreadable.contains("serves this configuration"),
            "{unreadable}"
        );

        // F9: the other configuration is named whether or not one of ours
        // answered, so a two-runner box reads the same both ways.
        let answered = joined(Ok(None), &p);
        assert!(answered.contains("pid 111"), "{answered}");
        assert!(answered.contains("/srv/other/forge-runner"), "{answered}");

        // F6: nothing was looked at, so nothing is claimed about the box.
        let mut blind = probe(|_| false, |_| None);
        blind.daemons = || None;
        let out = joined(Ok(Some(rec("0.17.9", None))), &blind);
        assert!(
            out.contains("gives no way to look"),
            "a platform that cannot look does not report an empty box: {out}"
        );
        assert!(!out.contains("not running —"), "{out}");
    }

    /// Review finding N1: under an unreadable record, a process line may not
    /// say the record is absent — the file that will not parse may be that
    /// very process's — and it may not say the process "wrote no serving
    /// record", which is the same claim in other words. N2: every line under
    /// the header sits in one column, built rather than un-prefixed.
    #[test]
    fn an_unreadable_record_does_not_say_the_record_is_absent() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![
                Running {
                    pid: 111,
                    exe: "/home/dev/.local/bin/forge-runner".into(),
                    replaced: Some(false),
                    serves: Serves::This,
                },
                Running {
                    pid: 222,
                    exe: "/home/dev/.local/bin/forge-runner".into(),
                    replaced: Some(false),
                    serves: Serves::Other("/srv/other/forge-runner".into()),
                },
            ])
        };
        let out = lines(
            &Err(Unreadable {
                path: "/x/serving.json".into(),
                reason: "does not parse: EOF".into(),
            }),
            &p,
            "0.17.9",
            "abc1234",
            NOW,
        );
        let body = out.join("\n");
        assert!(body.contains("UNREADABLE"), "{body}");
        assert!(body.contains("pid 111"), "{body}");
        assert!(
            body.contains("the record here cannot be read"),
            "the reason a build cannot be read is the record, not an absence: {body}"
        );
        assert!(
            !body.contains("no record"),
            "nothing may say the record is absent: {body}"
        );
        assert!(
            !body.contains("wrote no serving record"),
            "nor that this process wrote none: {body}"
        );
        assert!(
            out[1..]
                .iter()
                .all(|l| l.starts_with(INDENT) && !l[INDENT.len()..].starts_with(' ')),
            "every line under the header sits in one column: {out:#?}"
        );
        assert!(
            body.contains("/srv/other/forge-runner"),
            "and the other configurations are named here too: {body}"
        );
    }

    /// Review finding N5: a drain read off a record whose pid cannot be
    /// confirmed may be a dead daemon's last word, so declining the restart on
    /// it is said with the same hedge `status` uses rather than as fact.
    #[test]
    fn a_drain_read_at_an_unconfirmable_identity_is_hedged_like_the_rest() {
        let mut r = rec("0.17.8", None);
        r.start_ticks = None;
        r.drain = Some(DrainState::Draining {
            cause: "a new device token".into(),
            since_ms: NOW - 60_000,
            bound_secs: 7200,
            outstanding: vec!["run r-1 (ISS-7)".into()],
        });
        assert_eq!(
            turnover(
                &Ok(Some(r)),
                &probe(|_| true, |_| None),
                "0.17.9",
                "abc1234"
            ),
            Turnover::Draining {
                pid: 4242,
                cause: "a new device token".into(),
                outstanding: vec!["run r-1 (ISS-7)".into()],
                unverified: true,
            }
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
    /// It takes `ENV_TEST_LOCK`, which every env-moving test in this crate
    /// takes, because sibling tests move `XDG_CONFIG_HOME` process-wide and
    /// `dirs_next` reads it afresh on every call. Without the lock the two
    /// reads below can straddle a sibling's set-and-drop and disagree about an
    /// environment that never moved for either of them — a red that says
    /// nothing. `var_os`, not `var`: a value that is not UTF-8 is one
    /// `dirs_next` uses and `var` would drop.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_environment_rule_lands_where_this_process_own_config_path_does() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let ours = crate::config::Config::path().unwrap();
        let dir = config_dir_in(|k| std::env::var_os(k)).expect("this process has a HOME");
        assert_eq!(Some(dir.as_path()), ours.parent());
    }

    /// Every case where this rule answers, and every case where it refuses.
    /// The refusals are the load-bearing half: each of them is an environment
    /// `dirs_next` resolves by asking passwd, which no caller can do for
    /// another process, so naming a directory here would be a claim with
    /// nothing behind it.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_rule_answers_only_where_it_can_and_refuses_the_rest() {
        use std::ffi::OsString;
        let env = |xdg: Option<&str>, home: Option<&str>| {
            let xdg = xdg.map(OsString::from);
            let home = home.map(OsString::from);
            move |k: &str| match k {
                "XDG_CONFIG_HOME" => xdg.clone(),
                "HOME" => home.clone(),
                _ => None,
            }
        };
        assert_eq!(
            config_dir_in(env(Some("/srv/cfg"), Some("/home/ada"))),
            Some(PathBuf::from("/srv/cfg/forge-runner"))
        );
        assert_eq!(
            config_dir_in(env(Some("cfg"), Some("/home/ada"))),
            Some(PathBuf::from("/home/ada/.config/forge-runner")),
            "a relative XDG_CONFIG_HOME is not a base, the same way dirs_next reads it"
        );
        assert_eq!(
            config_dir_in(env(None, Some("/home/ada"))),
            Some(PathBuf::from("/home/ada/.config/forge-runner"))
        );
        assert_eq!(
            config_dir_in(env(None, None)),
            None,
            "no HOME is a passwd lookup this command cannot make for another process"
        );
        assert_eq!(
            config_dir_in(env(None, Some(""))),
            None,
            "an empty HOME is unset to dirs_next; joining it would name the relative path .config/forge-runner, which is no configuration at all"
        );
        assert_eq!(
            config_dir_in(env(Some("cfg"), Some(""))),
            None,
            "a relative XDG_CONFIG_HOME falls back to HOME, and an empty HOME refuses there too"
        );
    }

    /// An environment is bytes. Read lossily, a `HOME` that is not UTF-8
    /// becomes a path with U+FFFD in it, which equals no real directory — so
    /// this configuration's own daemon would read as another's, and `status`
    /// would say no daemon is serving while one is. That is ISS-1223's failure
    /// inverted, so the bytes are carried through rather than repaired.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_home_that_is_not_utf8_resolves_to_the_directory_it_really_names() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let home = OsString::from_vec(b"/home/d\xffev".to_vec());
        let want = PathBuf::from(OsString::from_vec(
            b"/home/d\xffev/.config/forge-runner".to_vec(),
        ));
        let got = config_dir_in(|k| match k {
            "HOME" => Some(home.clone()),
            _ => None,
        });
        assert_eq!(got, Some(want));
        assert!(
            !format!("{:?}", got).contains('\u{fffd}'),
            "no replacement character reached the path: {got:?}"
        );
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

        // Review finding F1: `replaced_daemon` drops every process whose file
        // still stands BEFORE it reads `Serves`, so a `replaced: Some(false)`
        // fixture asserts nothing about the attribution — the assertion holds
        // with the filter removed. The replaced case is the one that pins it,
        // and it is also the shape this issue was opened about: a daemon on a
        // deleted inode, here belonging to somebody else's configuration.
        let mut deleted = probe(|_| false, |_| None);
        deleted.daemons = || {
            Some(vec![Running {
                pid: 4126309,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::Other("/srv/other/forge-runner".into()),
            }])
        };
        assert_eq!(
            version_note(&Ok(None), &deleted, "0.17.9", "abc1234"),
            None,
            "--version says nothing about another configuration's daemon, even on a replaced binary"
        );
        assert_eq!(
            version_note(
                &Ok(Some(rec("0.17.9", None))),
                &deleted,
                "0.17.9",
                "abc1234"
            ),
            None,
            "nor beside a record whose own daemon is gone"
        );
        assert!(
            !joined(Ok(None), &deleted).contains("4126309"),
            "and status does not name it either"
        );

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
                build: "0.17.8 (abc1234)".into(),
                unverified: false
            }
        );
        assert_eq!(
            turnover(
                &Ok(Some(rec("0.17.9", None))),
                &live_same(),
                "0.17.9",
                "abc1234"
            ),
            Turnover::Already {
                pid: 4242,
                unverified: false
            }
        );
        let gone = turnover(
            &Ok(Some(rec("0.17.8", None))),
            &probe(|_| false, |_| None),
            "0.17.9",
            "abc1234",
        );
        assert!(matches!(gone, Turnover::Unknown(w) if w.contains("is gone")));
        let nothing = turnover(&Ok(None), &live_same(), "0.17.9", "abc1234");
        assert!(matches!(nothing, Turnover::Unknown(w) if w.contains("no daemon record")));
    }

    /// Review finding F2: a drain under way is the daemon restarting ITSELF,
    /// waiting for the runs it holds. `update --restart` reaching for systemctl
    /// there would stop exactly those runs — the one thing the drain exists to
    /// prevent — so the build comparison is never reached. A drain that GAVE UP
    /// is the opposite: nothing will turn the box over now but a restart.
    #[test]
    fn a_restart_does_not_cut_into_a_drain_that_is_under_way() {
        let draining = DrainState::Draining {
            cause: "update 0.17.8 → 0.17.9".into(),
            since_ms: NOW - 7 * 60_000,
            bound_secs: 7200,
            outstanding: vec!["run r-1 (ISS-7)".into(), "run r-2 (ISS-8)".into()],
        };
        assert_eq!(
            turnover(
                &Ok(Some(rec("0.17.8", Some(draining)))),
                &live_same(),
                "0.17.9",
                "abc1234"
            ),
            Turnover::Draining {
                pid: 4242,
                cause: "update 0.17.8 → 0.17.9".into(),
                outstanding: vec!["run r-1 (ISS-7)".into(), "run r-2 (ISS-8)".into()],
                unverified: false,
            },
            "a restart here would kill the runs the drain is waiting for"
        );

        let deferred = DrainState::Deferred {
            cause: "update 0.17.8 → 0.17.9".into(),
            gave_up_at_ms: NOW - 30 * 60_000,
            outstanding: vec!["run r-1 (ISS-7)".into()],
            next_attempt: "the next update check".into(),
            next_attempt_at_ms: NOW + 3_600_000,
        };
        assert!(
            matches!(
                turnover(
                    &Ok(Some(rec("0.17.8", Some(deferred)))),
                    &live_same(),
                    "0.17.9",
                    "abc1234"
                ),
                Turnover::Owed { .. }
            ),
            "a drain that gave up leaves the restart to a person"
        );
    }

    /// Review finding F7: where the identity cannot be confirmed, `status`
    /// hedges and the remedy must hedge with it rather than state it and act.
    #[test]
    fn an_unconfirmable_identity_is_carried_into_what_the_remedy_says() {
        let mut r = rec("0.17.8", None);
        r.start_ticks = None;
        let p = probe(|_| true, |_| None);
        assert_eq!(
            turnover(&Ok(Some(r.clone())), &p, "0.17.9", "abc1234"),
            Turnover::Owed {
                pid: 4242,
                build: "0.17.8 (abc1234)".into(),
                unverified: true
            }
        );
        let mut same = r.clone();
        same.version = "0.17.9".into();
        assert_eq!(
            turnover(&Ok(Some(same)), &p, "0.17.9", "abc1234"),
            Turnover::Already {
                pid: 4242,
                unverified: true
            }
        );
    }

    /// Review finding F7 again: the remedy names the replaced-binary process
    /// `--version` names, including the one it could not attribute.
    #[test]
    fn the_remedy_names_a_replaced_binary_process_it_could_not_attribute() {
        let mut p = live_same();
        p.daemons = || {
            Some(vec![Running {
                pid: 5150,
                exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                replaced: Some(true),
                serves: Serves::Unknown("its environment cannot be read".into()),
            }])
        };
        let out = turnover(&Ok(None), &p, "0.17.9", "abc1234");
        assert!(
            matches!(&out, Turnover::Unknown(w) if w.contains("pid 5150") && w.contains("could not be told")),
            "{out:?}"
        );
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

    /// A `/proc/<pid>` entry is three reads, not one: the cmdline says it is a
    /// daemon, the exe link says which build, the environ says whose
    /// configuration. A pid that exits between them and is handed to another
    /// process makes ONE reading out of TWO processes — and where the
    /// replacement is the box's other runner, the reading names that daemon as
    /// this configuration's, which is the misattribution this issue exists to
    /// end, arrived at from the other side. The identity is read before the
    /// sequence and again after it; an entry whose identity moved is not
    /// reported at all.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_pid_handed_to_another_process_mid_read_is_not_reported_as_one_daemon() {
        let root = crate::test_scratch::Scratch::new("serving-proc-race");
        let d = root.join("300");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("cmdline"), "forge-runner\0start\0").unwrap();
        std::os::unix::fs::symlink("/x/forge-runner", d.join("exe")).unwrap();
        std::fs::write(d.join("environ"), "HOME=/home/dev\0").unwrap();
        let ours = PathBuf::from("/home/dev/.config/forge-runner");

        // Held still, the entry is this configuration's daemon.
        let steady = scan_with(&root, 1, Some(&ours), |_| Some("777".to_string()))
            .expect("the planted root lists");
        assert_eq!(steady.len(), 1, "{steady:?}");
        assert_eq!(steady[0].serves, Serves::This);

        // Moved under the reader, it is nobody's daemon and is not reported.
        let reads = std::cell::Cell::new(0);
        let moved = scan_with(&root, 1, Some(&ours), |_| {
            reads.set(reads.get() + 1);
            Some(format!("tick-{}", reads.get()))
        })
        .expect("the planted root lists");
        assert!(
            moved.is_empty(),
            "a pid whose identity moved mid-read is not one process: {moved:?}"
        );
        assert_eq!(reads.get(), 2, "the identity is read on both sides of it");

        // A process that has exited answers no identity at the second read.
        let gone = std::cell::Cell::new(false);
        let exited = scan_with(&root, 1, Some(&ours), |_| {
            if gone.replace(true) {
                None
            } else {
                Some("777".to_string())
            }
        })
        .expect("the planted root lists");
        assert!(exited.is_empty(), "{exited:?}");

        // A platform that answers nothing at all is unchanged: the two reads
        // agree, and `liveness` is where that is declared.
        let blind = scan_with(&root, 1, Some(&ours), |_| None).expect("the planted root lists");
        assert_eq!(blind.len(), 1, "{blind:?}");
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

    /// The scan reads the environment as bytes, not as a lossy string: a
    /// daemon whose own `HOME` is not UTF-8 serves THIS configuration, and read
    /// lossily its path picks up a U+FFFD, matches nothing, and reads as
    /// another configuration's — so `status` would say no daemon is serving
    /// while this configuration's daemon runs. That is ISS-1223's failure
    /// inverted, which is why it is pinned here and not only on the rule.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_daemon_whose_environment_is_not_utf8_is_still_attributed_to_it() {
        use std::ffi::OsString;
        use std::os::unix::ffi::OsStringExt;
        let root = crate::test_scratch::Scratch::new("serving-proc-bytes");
        let d = root.join("300");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("cmdline"), "forge-runner\0start\0").unwrap();
        std::os::unix::fs::symlink("/x/forge-runner", d.join("exe")).unwrap();
        let mut environ = b"LANG=C\0HOME=/home/d".to_vec();
        environ.push(0xff);
        environ.extend_from_slice(b"ev\0");
        std::fs::write(d.join("environ"), environ).unwrap();

        let ours = PathBuf::from(OsString::from_vec(
            b"/home/d\xffev/.config/forge-runner".to_vec(),
        ));
        let found = scan(&root, 1, Some(&ours)).expect("the planted root lists");
        assert_eq!(
            found[0].serves,
            Serves::This,
            "read as bytes it is this configuration's daemon; read lossily it is nobody's"
        );

        let elsewhere = PathBuf::from("/srv/other/forge-runner");
        let found = scan(&root, 1, Some(&elsewhere)).expect("the planted root lists");
        assert_eq!(
            found[0].serves,
            Serves::Other(ours),
            "and against another configuration it names the directory it really serves"
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
    /// A record that HAS start ticks was written by a platform that could read
    /// them, so "this platform cannot confirm it" is refuted by the record
    /// itself. What a pid that answers a signal and has no start time really
    /// is, on Linux, is a zombie — or a process that exited between the two
    /// reads. Both are gone, and saying `Unverified` there is not a hedge but
    /// a wrong answer with a hedge's wording: `update --restart` refuses to
    /// act on an unconfirmed identity, so a zombied daemon — exactly the one
    /// an operator needs turned over — would be left standing, blamed on a
    /// platform limit that is not there.
    #[test]
    fn a_recorded_identity_that_has_vanished_is_gone_and_not_merely_unconfirmable() {
        let r = rec("0.17.9", None);
        assert_eq!(
            liveness(&r, &probe(|_| true, |_| None)),
            Liveness::Gone,
            "a record with ticks and no ticks to read now is a daemon that has gone"
        );
        let mut without = rec("0.17.9", None);
        without.start_ticks = None;
        assert_eq!(
            liveness(&without, &probe(|_| true, |_| None)),
            Liveness::Unverified,
            "a record with no ticks at all is the one case nothing here can confirm"
        );
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
