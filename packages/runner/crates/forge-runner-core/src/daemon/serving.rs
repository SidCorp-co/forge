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

use crate::proc::{pid_alive, start_ticks};
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
    let ours = crate::config::config_dir();
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
enum RecordPremise {
    /// No record stands here at all.
    Absent,
    /// A record stands, and the daemon it names is gone.
    Gone,
    /// A record stands and cannot be read.
    Unreadable,
}

impl RecordPremise {
    fn why_no_build(self) -> &'static str {
        match self {
            Self::Absent | Self::Gone => {
                "and wrote no serving record, so which build it is serving cannot be read from here"
            }
            Self::Unreadable => {
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
fn unrecorded(probe: &Probe, premise: RecordPremise) -> Unrecorded {
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
    match unrecorded(probe, RecordPremise::Absent) {
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
    match unrecorded(probe, RecordPremise::Unreadable) {
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
    match unrecorded(probe, RecordPremise::Gone) {
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
