//! Whether a master's dispatched runs still count as its work in flight.
//!
//! A master whose turn ended over a child reads `AwaitingChildren`, and for the
//! wake decision that is work in flight: the floor does not type into it and
//! the not-asked clock does not run. A child leaves that set only by its own
//! `SubagentStop`, so a run whose end never reached this box kept its master
//! reading as working for ever, never asked and never warned about (ISS-1306
//! round 2).
//!
//! What ends that is observation, not a timeout on the hook: a run stops
//! counting once its worktree has been read holding no process on every sweep
//! for [`ASK_FLOOR`] and its transcript has not been written for as long. A
//! reading this box could not take — a process table it cannot open, one with
//! pids it was not let ask about, a transcript it cannot stat — is never read
//! as absence, so the child counts. Stopping counting decides nothing about the
//! run: no run is ended, released or closed here, and the next prompt the
//! master is given clears the set its hooks keep.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::daemon::agent_activity::Activity;
use crate::daemon::master_ask::ASK_FLOOR;
use crate::daemon::transcript_age;
use crate::runner::ledger::Ledger;
use crate::workspace::worktree_processes::{self, Reading};

/// Whether a process stands in a child's worktree, as this box read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Residence {
    /// This many processes have their working directory there.
    Found(usize),
    /// The table was read whole and none does.
    Empty,
    /// No open run on this box's ledger names the child, so there is no
    /// worktree to read.
    NoWorktree,
    /// Whether one does could not be read, and why.
    Unread(String),
}

impl Residence {
    /// `Some(true)` for a reading that found the child absent, `Some(false)`
    /// for one that found it present, `None` for no reading.
    pub(crate) fn absent(&self) -> Option<bool> {
        match self {
            Residence::Empty | Residence::NoWorktree => Some(true),
            Residence::Found(_) => Some(false),
            Residence::Unread(_) => None,
        }
    }
}

/// One child of a master, as one sweep read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Child {
    pub agent_id: String,
    /// The open run on this box's ledger that names the child.
    pub run_id: Option<String>,
    pub worktree: Option<PathBuf>,
    pub residence: Residence,
    /// Where its transcript is, where this box knows.
    pub transcript: Option<PathBuf>,
    /// The newest write to that transcript, wall-clock ms; `None` where it
    /// could not be read, which is never silence.
    pub written_at: Option<i64>,
}

impl Child {
    /// What [`crate::daemon::master_ask::AskClocks::absent_for`] is handed for
    /// this child: an absent residence counts as absent only where its
    /// transcript could be read too, so an unreadable transcript also starts
    /// the absence again.
    pub(crate) fn absent(&self) -> Option<bool> {
        match (self.residence.absent(), self.written_at) {
            (Some(true), None) => None,
            (read, _) => read,
        }
    }
}

/// Whether a child still counts as work in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Counted {
    Counts,
    /// Absent on every sweep for `absent` and its transcript silent for
    /// `silent`, both at least [`ASK_FLOOR`].
    Lost {
        silent: Duration,
        absent: Duration,
    },
}

/// `absent_for` is how long every sweep has read the child absent (`None` where
/// the last reading did not), `now_ms` wall-clock ms.
pub(crate) fn counted(child: &Child, absent_for: Option<Duration>, now_ms: i64) -> Counted {
    let (Some(absent), Some(written)) = (absent_for, child.written_at) else {
        return Counted::Counts;
    };
    if child.absent() != Some(true) {
        return Counted::Counts;
    }
    let silent = Duration::from_millis(now_ms.saturating_sub(written).max(0) as u64);
    if absent < ASK_FLOOR || silent < ASK_FLOOR {
        return Counted::Counts;
    }
    Counted::Lost { silent, absent }
}

/// Read each child `seen` holds: its open run, who lives in its worktree under
/// `proc_root`, and when its transcript was last written. `ledger` is `None`
/// where this box holds none open, which reads every child unread.
pub(crate) fn read_children(
    seen: &Activity,
    ledger: Option<&Ledger>,
    proc_root: &Path,
) -> Vec<Child> {
    seen.children
        .iter()
        .map(|agent_id| read_child(agent_id, seen.transcript.as_deref(), ledger, proc_root))
        .collect()
}

fn read_child(
    agent_id: &str,
    lead: Option<&str>,
    ledger: Option<&Ledger>,
    proc_root: &Path,
) -> Child {
    let run = match ledger.map(|l| l.run_for_agent(agent_id)) {
        None => Err("this box holds no ledger open to read its run off".to_string()),
        Some(Err(e)) => Err(format!("its run could not be read off the ledger: {e}")),
        Some(Ok(run)) => Ok(run),
    };
    let lead_child = || lead.and_then(|l| transcript_age::child_transcript(Path::new(l), agent_id));
    let (run_id, worktree, transcript, residence) = match run {
        Err(why) => (None, None, lead_child(), Residence::Unread(why)),
        Ok(None) => (None, None, lead_child(), Residence::NoWorktree),
        Ok(Some(run)) => {
            let residence = residence(proc_root, &run.worktree_path);
            let transcript = run
                .agent_transcript
                .as_deref()
                .map(PathBuf::from)
                .or_else(lead_child);
            (
                Some(run.run_id),
                Some(run.worktree_path),
                transcript,
                residence,
            )
        }
    };
    let written_at = transcript.as_deref().and_then(transcript_age::written_at);
    Child {
        agent_id: agent_id.to_string(),
        run_id,
        worktree,
        residence,
        transcript,
        written_at,
    }
}

fn residence(proc_root: &Path, worktree: &Path) -> Residence {
    match worktree_processes::residents_of(proc_root, worktree) {
        Reading::Read { residents, .. } if !residents.is_empty() => {
            Residence::Found(residents.len())
        }
        Reading::Read { not_asked: 0, .. } => Residence::Empty,
        Reading::Read { not_asked, .. } => Residence::Unread(format!(
            "{not_asked} process(es) on this box would not show this daemon their working directory"
        )),
        Reading::NoTable(why) | Reading::Unreadable(why) => Residence::Unread(why),
    }
}

/// The journal line for a child that stopped counting as work in flight.
pub(crate) fn lost_line(
    slug: &str,
    pane: &str,
    child: &Child,
    silent: Duration,
    absent: Duration,
) -> String {
    let what = match &child.run_id {
        Some(run) => format!("run {run} (subagent {})", child.agent_id),
        None => format!(
            "subagent {}, which no open run on this box's ledger names",
            child.agent_id
        ),
    };
    let place = match &child.worktree {
        Some(at) => format!("its worktree {} has held no process", at.display()),
        None => "it has no worktree to hold a process".to_string(),
    };
    let transcript = child
        .transcript
        .as_deref()
        .map(|p| format!("its transcript {}", p.display()))
        .unwrap_or_else(|| "its transcript".to_string());
    format!(
        "[master] {slug}: no longer counting {what} as work in flight for {pane} — {place} on every sweep for {}m and {transcript} was last written {}m ago, both past the {}m ask floor. Its end never reached this box, so it no longer keeps {pane} reading as busy when deciding whether to ask it, and {pane} reads idle once no other run counts; the run itself is not ended",
        absent.as_secs() / 60,
        silent.as_secs() / 60,
        ASK_FLOOR.as_secs() / 60,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::agent_activity::{Activities, Event, Report};

    const NOW: i64 = 100_000_000_000;
    const MIN: i64 = 60_000;

    fn child(residence: Residence, written_at: Option<i64>) -> Child {
        Child {
            agent_id: "a1".into(),
            run_id: Some("run-1".into()),
            worktree: Some(PathBuf::from("/w/iss-1")),
            residence,
            transcript: Some(PathBuf::from("/t/agent-a1.jsonl")),
            written_at,
        }
    }

    fn floor() -> Duration {
        ASK_FLOOR
    }

    /// Criterion 16: absent for the floor and silent for the floor is lost.
    #[test]
    fn absent_and_silent_past_the_floor_stops_counting() {
        let c = child(Residence::Empty, Some(NOW - 31 * MIN));
        assert_eq!(
            counted(&c, Some(floor()), NOW),
            Counted::Lost {
                silent: Duration::from_secs(31 * 60),
                absent: floor()
            }
        );
        let no_run = Child {
            run_id: None,
            worktree: None,
            residence: Residence::NoWorktree,
            ..c
        };
        assert!(matches!(
            counted(&no_run, Some(floor()), NOW),
            Counted::Lost { .. }
        ));
    }

    /// Consult 08737d F1: a transcript silent past the floor is not enough; the
    /// absence itself has to have stood for it.
    #[test]
    fn a_child_seen_alive_on_the_last_sweep_counts_until_its_absence_reaches_the_floor() {
        let c = child(Residence::Empty, Some(NOW - 31 * MIN));
        assert_eq!(counted(&c, Some(Duration::ZERO), NOW), Counted::Counts);
        assert_eq!(
            counted(&c, Some(floor() - Duration::from_secs(1)), NOW),
            Counted::Counts
        );
        assert_eq!(counted(&c, None, NOW), Counted::Counts);
    }

    /// Criterion 17: a resident, or a write inside the floor, keeps it counting.
    #[test]
    fn a_resident_or_a_recent_write_keeps_it_counting() {
        let resident = child(Residence::Found(1), Some(NOW - 90 * MIN));
        assert_eq!(counted(&resident, Some(floor() * 3), NOW), Counted::Counts);
        let writing = child(Residence::Empty, Some(NOW - 29 * MIN));
        assert_eq!(counted(&writing, Some(floor() * 3), NOW), Counted::Counts);
    }

    /// Criterion 18: what could not be read is never read as absence.
    #[test]
    fn an_unread_reading_keeps_it_counting() {
        let table = child(Residence::Unread("no table".into()), Some(NOW - 90 * MIN));
        assert_eq!(table.absent(), None);
        assert_eq!(counted(&table, Some(floor() * 3), NOW), Counted::Counts);
        let transcript = child(Residence::Empty, None);
        assert_eq!(
            transcript.absent(),
            None,
            "an unread transcript breaks the absence"
        );
        assert_eq!(
            counted(&transcript, Some(floor() * 3), NOW),
            Counted::Counts
        );
    }

    #[cfg(unix)]
    fn planted_proc(root: &Path, pid: u32, cwd: &Path) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(cwd, dir.join("cwd")).unwrap();
        std::fs::write(dir.join("cmdline"), "node\0server.js").unwrap();
        std::fs::write(dir.join("status"), "Name:\tnode\nPPid:\t1\n").unwrap();
    }

    fn master_over(child_id: &str, transcript: &Path) -> Activity {
        let all = Activities::new();
        for (event, subject) in [
            (Event::PromptSubmitted, None),
            (Event::SubagentStarted, Some(child_id)),
            (Event::Stopped, None),
        ] {
            all.record(
                "m",
                Report {
                    event,
                    at: NOW,
                    subject,
                    conversation: Some("conv"),
                    transcript: Some(transcript.to_str().unwrap()),
                },
            );
        }
        all.get("m").unwrap()
    }

    /// The reading of one child: its open run, who lives in its worktree, and
    /// its transcript's last write, off a planted `/proc` and files.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_child_is_read_off_its_run_its_worktree_and_its_transcript() {
        let scratch = crate::test_scratch::Scratch::new("master-children-read");
        let root = scratch.path();
        let proc_root = root.join("proc");
        std::fs::create_dir_all(&proc_root).unwrap();
        let tree = root.join("w").join("iss-1");
        std::fs::create_dir_all(&tree).unwrap();
        let lead = root.join("t").join("conv.jsonl");
        let sub = transcript_age::child_transcript(&lead, "a1").unwrap();
        std::fs::create_dir_all(sub.parent().unwrap()).unwrap();
        std::fs::write(&lead, "{}\n").unwrap();
        std::fs::write(&sub, "{}\n").unwrap();
        let seen = master_over("a1", &lead);

        let no_ledger = read_children(&seen, None, &proc_root);
        assert!(matches!(no_ledger[0].residence, Residence::Unread(_)));
        assert_eq!(no_ledger[0].transcript.as_deref(), Some(sub.as_path()));
        assert!(no_ledger[0].written_at.is_some());

        let mut led = Ledger::open(&root.join("ledger.sqlite")).unwrap();
        let none = read_children(&seen, Some(&led), &proc_root);
        assert_eq!(none[0].residence, Residence::NoWorktree);

        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: tree.clone(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        assert!(led.bind_agent("run-1", "a1").unwrap());
        let empty = read_children(&seen, Some(&led), &proc_root);
        assert_eq!(empty[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(empty[0].residence, Residence::Empty);

        planted_proc(&proc_root, 4242, &tree.join("packages"));
        let lived = read_children(&seen, Some(&led), &proc_root);
        assert_eq!(lived[0].residence, Residence::Found(1));
    }

    #[test]
    fn the_lost_line_names_the_run_its_worktree_and_the_silence() {
        let c = child(Residence::Empty, Some(NOW - 47 * MIN));
        let line = lost_line(
            "sid-desk",
            "forge-master-sid-desk",
            &c,
            Duration::from_secs(47 * 60),
            Duration::from_secs(31 * 60),
        );
        for part in [
            "sid-desk:",
            "run run-1 (subagent a1)",
            "/w/iss-1",
            "/t/agent-a1.jsonl was last written 47m ago",
            "for 31m",
            "30m ask floor",
            "no longer keeps forge-master-sid-desk reading as busy",
            "once no other run counts",
        ] {
            assert!(line.contains(part), "{part} missing from: {line}");
        }
    }
}
