//! Which build is on disk, which the daemon runs, and the daemon's own file.
//!
//! After a self-update the daemon keeps running the inode it started from
//! while the name on disk is a newer build (ISS-1223). `serving.json` says
//! which build the daemon recorded; `/proc/<pid>/exe` is the file it is
//! actually executing, and the only place its embedded assets can be read
//! from — which is what the skill reading compares a pane's installed copy
//! against.

use std::path::Path;
use std::sync::Arc;

use forge_runner_core::daemon::serving::{self, Liveness, Probe, Serves};

use super::source::{Read, Unreadable};

/// The daemon process this configuration is served by, where one can be named.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Daemon {
    pub pid: u32,
    /// Where `/proc/<pid>/exe` points, or why it could not be read.
    pub exe_link: Read<String>,
}

impl Daemon {
    /// Linux marks a file replaced or removed under a running process by
    /// suffixing the link. `None` where the link could not be read.
    pub fn replaced(&self) -> Option<bool> {
        self.exe_link
            .as_ref()
            .ok()
            .map(|l| l.ends_with(forge_runner_core::exe::DELETED_SUFFIX))
    }
}

/// The running daemon, named from its record where the record's pid is proven
/// still that process, else from the one `forge-runner start` process serving
/// this configuration. A record that cannot be proven the same process — no
/// start time in it — names nothing by itself, since its pid may have been
/// handed to another program. `None` where neither names one.
pub fn daemon(
    record: &Result<Option<serving::Record>, serving::Unreadable>,
    probe: &Probe,
) -> Option<Daemon> {
    let pid = match record {
        Ok(Some(r)) if serving::liveness(r, probe) == Liveness::Same => Some(r.pid),
        _ => (probe.daemons)().and_then(|all| {
            let mine: Vec<u32> = all
                .iter()
                .filter(|d| d.serves == Serves::This)
                .map(|d| d.pid)
                .collect();
            (mine.len() == 1).then(|| mine[0])
        }),
    }?;
    Some(Daemon {
        pid,
        exe_link: exe_link(Path::new("/proc"), pid),
    })
}

pub fn exe_link(proc_root: &Path, pid: u32) -> Read<String> {
    let link = proc_root.join(pid.to_string()).join("exe");
    std::fs::read_link(&link)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|e| Unreadable::new(link.display().to_string(), e))
}

/// The bytes of the file a process is executing, which stay readable through
/// `/proc/<pid>/exe` after the name on disk has been replaced.
pub fn exe_bytes(proc_root: &Path, pid: u32) -> Read<Arc<Vec<u8>>> {
    let link = proc_root.join(pid.to_string()).join("exe");
    std::fs::read(&link)
        .map(Arc::new)
        .map_err(|e| Unreadable::new(link.display().to_string(), e))
}

/// The BINARY section. `record_path` is where `record` was read from, which
/// the daemon line names: `serving::lines` is `status`'s wording, and names
/// the file only where it could not be read.
pub fn lines(
    record: &Result<Option<serving::Record>, serving::Unreadable>,
    record_path: &Path,
    probe: &Probe,
    daemon: Option<&Daemon>,
    now_ms: i64,
) -> Vec<String> {
    let disk = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|e| format!("a path this process cannot name ({e})"));
    let mut out = vec![format!(
        "disk       {} ({}) at {disk} ← the build this command was compiled as",
        forge_runner_core::update::VERSION_LINE,
        forge_runner_core::update::BUILD_TARGET
    )];
    let mut daemon_lines = serving::lines(
        record,
        probe,
        forge_runner_core::update::CURRENT_VERSION,
        forge_runner_core::update::BUILD_COMMIT,
        now_ms,
    );
    let read = match record {
        Ok(Some(_)) => Some(format!(" ← {}", record_path.display())),
        Ok(None) => Some(format!(
            " ← {}, which does not exist, and the processes on this box",
            record_path.display()
        )),
        Err(_) => None,
    };
    if let (Some(read), Some(first)) = (read, daemon_lines.first_mut()) {
        first.push_str(&read);
    }
    out.extend(daemon_lines);
    out.push(match daemon {
        None => "exe        no running daemon could be named, so no daemon file can be read".into(),
        Some(d) => exe_line(d),
    });
    out
}

fn exe_line(d: &Daemon) -> String {
    match (&d.exe_link, d.replaced()) {
        (Err(e), _) => format!("exe        {e}"),
        (Ok(link), Some(true)) => format!(
            "exe        REPLACED — pid {} runs {link}: the file it started from is no longer the one on disk ← /proc/{}/exe",
            d.pid, d.pid
        ),
        (Ok(link), _) => format!(
            "exe        pid {} runs {link}, still the file on disk ← /proc/{}/exe",
            d.pid, d.pid
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::test_scratch::Scratch;

    /// Criterion 11. A link Linux has marked replaced says so in the line.
    #[test]
    fn a_replaced_daemon_file_is_named_as_replaced() {
        let d = Daemon {
            pid: 42,
            exe_link: Ok("/home/u/.local/bin/forge-runner (deleted)".into()),
        };
        let line = exe_line(&d);
        assert!(line.contains("REPLACED"), "{line}");
        assert!(line.contains("/proc/42/exe"), "{line}");
        let d = Daemon {
            pid: 42,
            exe_link: Ok("/home/u/.local/bin/forge-runner".into()),
        };
        let line = exe_line(&d);
        assert!(
            !line.contains("REPLACED") && line.contains("still the file on disk"),
            "{line}"
        );
    }

    /// Criterion 22. A link that cannot be read is not a file in place.
    #[test]
    fn an_exe_that_cannot_be_read_is_unreadable() {
        let s = Scratch::new("top-exe");
        let d = Daemon {
            pid: 7,
            exe_link: exe_link(s.path(), 7),
        };
        assert_eq!(d.replaced(), None);
        let line = exe_line(&d);
        assert!(line.contains("UNREADABLE"), "{line}");
        assert!(exe_bytes(s.path(), 7).is_err());
    }

    fn record(pid: u32, start_ticks: Option<&str>) -> serving::Record {
        serving::Record {
            pid,
            boot_id: None,
            start_ticks: start_ticks.map(str::to_string),
            version: "0.17.0".into(),
            commit: "abc".into(),
            started_at_ms: 0,
            drain: None,
        }
    }

    fn probe(daemons: fn() -> Option<Vec<serving::Running>>) -> Probe {
        Probe {
            alive: |_| true,
            start_ticks: |_| Some("555".into()),
            boot_id: None,
            daemons,
        }
    }

    fn one_daemon_at_9() -> Option<Vec<serving::Running>> {
        Some(vec![serving::Running {
            pid: 9,
            exe: "/usr/bin/forge-runner".into(),
            replaced: Some(false),
            serves: Serves::This,
        }])
    }

    /// Whole-set consult at a366fa8, F2: a record with no start time cannot be
    /// proven the process now holding its pid, so that pid is never taken for
    /// the daemon by itself — the one daemon serving this configuration is.
    #[test]
    fn a_record_that_cannot_be_proven_names_no_daemon_by_itself() {
        let unproven = Ok(Some(record(4242, None)));
        assert_eq!(
            daemon(&unproven, &probe(one_daemon_at_9)).map(|d| d.pid),
            Some(9)
        );
        assert!(daemon(&unproven, &probe(|| Some(Vec::new()))).is_none());
        let proven = Ok(Some(record(4242, Some("555"))));
        assert_eq!(
            daemon(&proven, &probe(one_daemon_at_9)).map(|d| d.pid),
            Some(4242)
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn this_process_reads_its_own_executable_through_proc() {
        let bytes = exe_bytes(Path::new("/proc"), std::process::id()).expect("own exe");
        let own = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        assert_eq!(bytes.len(), own.len());
    }
}
