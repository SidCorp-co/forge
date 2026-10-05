use super::*;

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
            boot_id: runner_core::inflight::boot_identity(),
            daemons: running_daemons,
        }
    }
}

pub(crate) fn file_clause(r: &Running) -> String {
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
pub(crate) enum RecordPremise {
    /// No record stands here at all.
    Absent,
    /// A record stands, and the daemon it names is gone.
    Gone,
    /// A record stands and cannot be read.
    Unreadable,
}

impl RecordPremise {
    pub(crate) fn why_no_build(self) -> &'static str {
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
pub(crate) enum Unrecorded {
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
pub(crate) fn unrecorded(probe: &Probe, premise: RecordPremise) -> Unrecorded {
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
pub(crate) fn elsewhere_sentence(dirs: &[PathBuf]) -> Option<String> {
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
pub(crate) fn unrecorded_lines(probe: &Probe) -> Vec<String> {
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
pub(crate) fn beside_an_unreadable_record(probe: &Probe) -> Vec<String> {
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
pub(crate) fn beside_a_gone_record(gone: String, probe: &Probe) -> Vec<String> {
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

pub(crate) fn ago(now_ms: i64, then_ms: i64) -> String {
    span_secs(((now_ms - then_ms).max(0) / 1000) as u64)
}

pub(crate) const INDENT: &str = "           ";

pub(crate) fn drain_lines(drain: &DrainState, now_ms: i64) -> Vec<String> {
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

pub(crate) fn listed(names: &[String]) -> String {
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
