use super::*;

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
    /// It is handing itself over already, and a restart now would cut the
    /// in-process work it is waiting on: a chat turn or a message into a pane.
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
    // A handover under way is the daemon replacing ITSELF once its in-process
    // work ends. Restarting the unit here would cut exactly that work — a chat
    // turn, a message into a pane — so the build comparison is not even
    // reached. A handover that was DEFERRED is the opposite case: nothing will
    // turn the box over now but a restart.
    if let Some(
        DrainState::Waiting {
            cause, outstanding, ..
        }
        | DrainState::Draining {
            cause, outstanding, ..
        },
    ) = &record.drain
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
pub(crate) fn replaced_daemon(probe: &Probe) -> Option<(u32, bool)> {
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

pub(crate) fn a_daemon(ours: bool) -> &'static str {
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
