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
}

/// Every `forge-runner start` process under `root` (a `/proc`) other than
/// `self_pid`. `None` where `root` cannot be listed at all.
///
/// A daemon that predates the serving record writes none, and "no record" alone
/// cannot tell that daemon from no daemon — one of them is a box serving a
/// deleted binary with nothing saying so, which is the state ISS-1223 exists to
/// end. So the absent record is read against the processes themselves.
pub fn scan(root: &Path, self_pid: u32) -> Option<Vec<Running>> {
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
        found.push(Running { pid, exe, replaced });
    }
    found.sort_by_key(|r| r.pid);
    Some(found)
}

#[cfg(target_os = "linux")]
pub fn running_daemons() -> Option<Vec<Running>> {
    scan(Path::new("/proc"), std::process::id())
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

fn unrecorded_lines(probe: &Probe) -> Vec<String> {
    let Some(found) = (probe.daemons)() else {
        return vec![
            "daemon     no record — and this platform gives no way to look for a daemon that predates the record, so whether one is running, and on which build, cannot be said from here"
                .to_string(),
        ];
    };
    if found.is_empty() {
        return vec![
            "daemon     no record, and no `forge-runner start` process is running on this box — no daemon is serving"
                .to_string(),
        ];
    }
    found
        .iter()
        .map(|r| {
            let file = match r.replaced {
                Some(true) => format!(
                    "the file it started from, {}, has been replaced on disk, so it is NOT serving this binary — restarting the service turns it over",
                    r.exe
                ),
                Some(false) => format!("the file it started from, {}, is still in place", r.exe),
                None => format!(
                    "whether the file it started from has been replaced cannot be told: its exe link is {}",
                    r.exe
                ),
            };
            format!(
                "daemon     no record — pid {} (`forge-runner start`) is running from a build older than the record, so its version cannot be read; {file}",
                r.pid
            )
        })
        .collect()
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
    match (probe.daemons)() {
        Some(found) if !found.is_empty() => {
            let mut out = vec![format!(
                "daemon     the record is stale — {gone}; a daemon that wrote no record is running instead:"
            )];
            out.extend(unrecorded_lines(probe));
            out
        }
        Some(_) => vec![format!(
            "daemon     not running — {gone}, and no `forge-runner start` process is running on this box"
        )],
        None => vec![format!("daemon     not running — {gone}")],
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
            let stale = (probe.daemons)()?
                .into_iter()
                .find(|r| r.replaced == Some(true))?;
            return Some(format!(
                "forge-runner: the daemon on this box (pid {}) is running from a file that has since been replaced, so it is not serving this build; `forge-runner status` says more",
                stale.pid
            ));
        }
    };
    if matches!(liveness(record, probe), Liveness::Gone | Liveness::Reused) {
        let stale = (probe.daemons)()?
            .into_iter()
            .find(|r| r.replaced == Some(true))?;
        return Some(format!(
            "forge-runner: the daemon on this box (pid {}) wrote no record and is running from a file that has since been replaced, so it is not serving this build; `forge-runner status` says more",
            stale.pid
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
            }])
        };
        let stale = joined(Ok(None), &p);
        assert!(
            stale.contains("pid 2946187 (`forge-runner start`) is running"),
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
            }])
        };
        let unknown = joined(Ok(None), &p);
        assert!(unknown.contains("cannot be told"), "{unknown}");
        assert!(
            !unknown.contains("still in place") && !unknown.contains("NOT serving"),
            "{unknown}"
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
            }])
        };
        let out = joined(Ok(Some(rec("0.17.9", None))), &p);
        assert!(out.contains("the record is stale"), "{out}");
        assert!(
            out.contains("pid 2946187 (`forge-runner start`) is running"),
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
    /// status` and an unrelated process, and this process itself.
    #[cfg(unix)]
    #[test]
    fn the_scan_finds_the_daemons_and_reads_which_run_a_replaced_file() {
        let root = crate::test_scratch::Scratch::new("serving-proc");
        let plant = |pid: u32, argv: &[&str], exe: &str| {
            let d = root.join(pid.to_string());
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("cmdline"), argv.join("\0") + "\0").unwrap();
            std::os::unix::fs::symlink(exe, d.join("exe")).unwrap();
        };
        plant(
            100,
            &["/home/dev/.local/bin/forge-runner", "start"],
            "/home/dev/.local/bin/forge-runner (deleted)",
        );
        plant(
            101,
            &["forge-runner", "--core-url", "x", "start"],
            "/home/dev/.local/bin/forge-runner",
        );
        plant(
            102,
            &["/home/dev/.local/bin/forge-runner", "status"],
            "/home/dev/.local/bin/forge-runner",
        );
        plant(103, &["/usr/bin/sleep", "start"], "/usr/bin/sleep");
        plant(
            104,
            &["/home/dev/.local/bin/forge-runner", "start"],
            "/home/dev/.local/bin/forge-runner",
        );
        std::fs::create_dir_all(root.join("self")).unwrap();
        let found = scan(&root, 104).expect("the planted root lists");
        assert_eq!(
            found,
            vec![
                Running {
                    pid: 100,
                    exe: "/home/dev/.local/bin/forge-runner (deleted)".into(),
                    replaced: Some(true)
                },
                Running {
                    pid: 101,
                    exe: "/home/dev/.local/bin/forge-runner".into(),
                    replaced: Some(false)
                },
            ]
        );
        assert_eq!(scan(&root.join("absent"), 1), None);
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
