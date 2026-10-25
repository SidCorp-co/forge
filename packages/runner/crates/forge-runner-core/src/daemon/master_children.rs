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
//! counting once its worktree has been read holding no process that could be
//! the run's on every sweep for [`ASK_FLOOR`] and its transcript has not been
//! written for as long. A reading this box could not take is never read as
//! absence, so the child counts: a process table it cannot open, a transcript
//! it cannot stat, or a process of this daemon's own user, started since the
//! run was declared, whose working directory the kernel withholds.
//!
//! A withheld process of another user, or of this user and started before the
//! run was declared, is set aside and said in the line. A run executes as this
//! daemon's user, and a process takes its working directory from the one that
//! started it. Reading every withheld pid as a possible resident counted a lost
//! run for ever on every real box, where hundreds of other users' processes
//! withhold theirs (ISS-1306 round 3, judge-109). Stopping counting decides
//! nothing about the run: no run is ended, released or closed here, and the
//! next prompt the master is given clears the set its hooks keep.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::daemon::agent_activity::Activity;
use crate::daemon::master_ask::ASK_FLOOR;
use crate::daemon::transcript_age;
use crate::runner::ledger::Ledger;
use crate::workspace::worktree_processes::{self, Reading};

/// Processes whose working directory the kernel withheld from this box and
/// which a reading set aside as not the run's, by why.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SetAside {
    /// Of another user: a run executes as this daemon's user.
    pub other_users: usize,
    /// Of this daemon's user and started before the run was declared: a
    /// process takes its working directory from the one that started it.
    pub own_before: usize,
}

/// Whether a process stands in a child's worktree, as this box read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Residence {
    /// This many processes have their working directory there.
    Found(usize),
    /// None that could be the run's does; what was set aside says which
    /// withheld processes were not taken as the run's.
    Empty(SetAside),
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
            Residence::Empty(_) | Residence::NoWorktree => Some(true),
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
            let declared_ms = run.created_at.saturating_mul(1000);
            let residence = residence(proc_root, &run.worktree_path, declared_ms);
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

fn residence(proc_root: &Path, worktree: &Path, declared_ms: i64) -> Residence {
    residence_by(
        proc_root,
        worktree,
        declared_ms,
        worktree_processes::clk_tck(),
        |at| std::fs::read_link(at),
    )
}

/// [`residence`], with the tick rate and the `cwd` link read supplied: a
/// withheld link is not a state a planted process root can be made to enter.
pub(crate) fn residence_by(
    proc_root: &Path,
    worktree: &Path,
    declared_ms: i64,
    clk_tck: Option<u64>,
    cwd: impl Fn(&Path) -> std::io::Result<PathBuf>,
) -> Residence {
    let (reading, held) =
        worktree_processes::residents_of_with_withheld_by(proc_root, worktree, cwd);
    match reading {
        Reading::Read { residents, .. } if !residents.is_empty() => {
            Residence::Found(residents.len())
        }
        Reading::Read { .. } => set_aside(proc_root, &held, declared_ms, clk_tck),
        Reading::NoTable(why) | Reading::Unreadable(why) => Residence::Unread(why),
    }
}

/// Sort the withheld pids of a reading that found no resident: set aside the
/// ones that cannot be the run's, and leave the reading unread at the first
/// that could be.
fn set_aside(proc_root: &Path, held: &[u32], declared_ms: i64, clk_tck: Option<u64>) -> Residence {
    let mut aside = SetAside::default();
    if held.is_empty() {
        return Residence::Empty(aside);
    }
    let Some(own) = worktree_processes::own_uid(proc_root) else {
        return Residence::Unread(format!(
            "{} process(es) would not show this daemon their working directory, and this daemon \
             could not read its own user id to tell whether any is of its user",
            held.len()
        ));
    };
    for &pid in held {
        let seen = worktree_processes::withheld(proc_root, pid, clk_tck);
        match (seen.uid, seen.started_ms) {
            (Some(uid), _) if uid != own => aside.other_users += 1,
            (Some(_), Some(started)) if started < declared_ms => aside.own_before += 1,
            // It went between the two reads: there is no process left to be there.
            (None, _) if !proc_root.join(pid.to_string()).exists() => {}
            (None, _) => {
                return Residence::Unread(format!(
                    "pid {pid} would not show this daemon its working directory, and whose it is \
                     could not be read"
                ))
            }
            (Some(_), None) => {
                return Residence::Unread(format!(
                    "pid {pid}, of this daemon's own user, would not show its working directory, \
                     and when it started could not be read"
                ))
            }
            (Some(_), Some(_)) => {
                return Residence::Unread(format!(
                    "pid {pid}, of this daemon's own user and started since the run was declared, \
                     would not show its working directory"
                ))
            }
        }
    }
    Residence::Empty(aside)
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
    let aside = match &child.residence {
        Residence::Empty(SetAside {
            other_users,
            own_before,
        }) if other_users + own_before > 0 => format!(
            " This box could not look inside {} process(es): {other_users} of other users and \
             {own_before} of its own user started before the run was declared. A run executes as \
             this user and a process takes its working directory from the one that started it, \
             so none of them was taken as the run's.",
            other_users + own_before
        ),
        _ => String::new(),
    };
    let transcript = child
        .transcript
        .as_deref()
        .map(|p| format!("its transcript {}", p.display()))
        .unwrap_or_else(|| "its transcript".to_string());
    format!(
        "[master] {slug}: no longer counting {what} as work in flight for {pane} — {place} on every sweep for {}m and {transcript} was last written {}m ago, both past the {}m ask floor. Its end never reached this box, so it no longer keeps {pane} reading as busy when deciding whether to ask it, and {pane} reads idle once no other run counts; the run itself is not ended.{aside}",
        absent.as_secs() / 60,
        silent.as_secs() / 60,
        ASK_FLOOR.as_secs() / 60,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
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
        let c = child(Residence::Empty(SetAside::default()), Some(NOW - 31 * MIN));
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
        let c = child(Residence::Empty(SetAside::default()), Some(NOW - 31 * MIN));
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
        let writing = child(Residence::Empty(SetAside::default()), Some(NOW - 29 * MIN));
        assert_eq!(counted(&writing, Some(floor() * 3), NOW), Counted::Counts);
    }

    /// Criterion 18: what could not be read is never read as absence.
    #[test]
    fn an_unread_reading_keeps_it_counting() {
        let table = child(Residence::Unread("no table".into()), Some(NOW - 90 * MIN));
        assert_eq!(table.absent(), None);
        assert_eq!(counted(&table, Some(floor() * 3), NOW), Counted::Counts);
        let transcript = child(Residence::Empty(SetAside::default()), None);
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

    #[cfg(target_os = "linux")]
    fn planted_proc(root: &Path, pid: u32, cwd: &Path) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::os::unix::fs::symlink(cwd, dir.join("cwd")).unwrap();
        std::fs::write(dir.join("cmdline"), "node\0server.js").unwrap();
        std::fs::write(dir.join("status"), "Name:\tnode\nPPid:\t1\n").unwrap();
    }

    #[cfg(target_os = "linux")]
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
        assert_eq!(empty[0].residence, Residence::Empty(SetAside::default()));

        planted_proc(&proc_root, 4242, &tree.join("packages"));
        let lived = read_children(&seen, Some(&led), &proc_root);
        assert_eq!(lived[0].residence, Residence::Found(1));
    }

    /// A planted process root for the withheld readings: this daemon is uid
    /// 1000, the box booted at `BTIME`, and each pid named here withholds its
    /// working directory with the uid and start given (`None` plants no file).
    #[cfg(target_os = "linux")]
    fn withheld_root(
        root: &Path,
        own: Option<u32>,
        pids: &[(u32, Option<u32>, Option<u64>)],
    ) -> std::collections::BTreeSet<u32> {
        std::fs::create_dir_all(root.join("self")).unwrap();
        if let Some(uid) = own {
            std::fs::write(
                root.join("self").join("status"),
                format!("Name:\tforge-runner\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n"),
            )
            .unwrap();
        }
        std::fs::write(root.join("stat"), format!("cpu 1 2 3\nbtime {BTIME}\n")).unwrap();
        for (pid, uid, ticks) in pids {
            let dir = root.join(pid.to_string());
            std::fs::create_dir_all(&dir).unwrap();
            std::os::unix::fs::symlink("/somewhere/else", dir.join("cwd")).unwrap();
            if let Some(uid) = uid {
                std::fs::write(
                    dir.join("status"),
                    format!("Name:\tagent\nUid:\t{uid}\t0\t0\t0\n"),
                )
                .unwrap();
            }
            if let Some(ticks) = ticks {
                let zeros = " 0".repeat(18);
                std::fs::write(
                    dir.join("stat"),
                    format!("{pid} (a (b) c) S{zeros} {ticks} 0 0\n"),
                )
                .unwrap();
            }
        }
        pids.iter().map(|(pid, ..)| *pid).collect()
    }

    #[cfg(target_os = "linux")]
    const BTIME: i64 = 1_000_000;
    /// Declared 500s after boot; ticks at 100 a second.
    #[cfg(target_os = "linux")]
    const DECLARED_MS: i64 = (BTIME + 500) * 1000;
    #[cfg(target_os = "linux")]
    const HZ: Option<u64> = Some(100);
    #[cfg(target_os = "linux")]
    const BEFORE: Option<u64> = Some(100 * 100);
    #[cfg(target_os = "linux")]
    const AFTER: Option<u64> = Some(100 * 1000);

    #[cfg(target_os = "linux")]
    fn read_withheld(
        root: &Path,
        own: Option<u32>,
        pids: &[(u32, Option<u32>, Option<u64>)],
    ) -> Residence {
        let held = withheld_root(root, own, pids);
        let tree = root.join("wt");
        std::fs::create_dir_all(&tree).unwrap();
        residence_by(root, &tree, DECLARED_MS, HZ, |at| {
            let pid: u32 = at
                .parent()
                .and_then(|d| d.file_name())
                .and_then(|n| n.to_str())
                .and_then(|n| n.parse().ok())
                .unwrap_or(0);
            if held.contains(&pid) {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                std::fs::read_link(at)
            }
        })
    }

    /// Criterion 23 (judge-109, criterion 16 at 3798b1d): other users'
    /// processes withholding their directory leave the worktree read empty.
    #[cfg(target_os = "linux")]
    #[test]
    fn another_users_withheld_process_is_not_the_run() {
        let scratch = crate::test_scratch::Scratch::new("children-other-uid");
        let read = read_withheld(
            &scratch.path().join("proc"),
            Some(1000),
            &[
                (301, Some(0), AFTER),
                (302, Some(113), AFTER),
                (303, Some(0), None),
            ],
        );
        assert_eq!(
            read,
            Residence::Empty(SetAside {
                other_users: 3,
                own_before: 0
            })
        );
        assert_eq!(read.absent(), Some(true));
    }

    /// Criteria 24 and 25: this user's withheld process is set aside only where
    /// it started before the run was declared.
    #[cfg(target_os = "linux")]
    #[test]
    fn this_users_withheld_process_counts_only_where_it_started_since_the_declaration() {
        let scratch = crate::test_scratch::Scratch::new("children-own-uid");
        let before = read_withheld(
            &scratch.path().join("before"),
            Some(1000),
            &[(401, Some(1000), BEFORE), (402, Some(0), AFTER)],
        );
        assert_eq!(
            before,
            Residence::Empty(SetAside {
                other_users: 1,
                own_before: 1
            })
        );
        let after = read_withheld(
            &scratch.path().join("after"),
            Some(1000),
            &[(401, Some(1000), BEFORE), (403, Some(1000), AFTER)],
        );
        let Residence::Unread(why) = &after else {
            panic!("{after:?}");
        };
        assert!(
            why.contains("pid 403") && why.contains("since the run was declared"),
            "{why}"
        );
        assert_eq!(after.absent(), None);
    }

    /// Criteria 18 and 24: what could not be read of a withheld process keeps
    /// the run counting.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_withheld_process_whose_owner_or_start_is_unread_keeps_it_counting() {
        let scratch = crate::test_scratch::Scratch::new("children-unread");
        for (name, own, pids, says) in [
            (
                "no-start",
                Some(1000),
                vec![(501, Some(1000), None)],
                "when it started could not be read",
            ),
            (
                "no-owner",
                Some(1000),
                vec![(502, None, AFTER)],
                "whose it is could not be read",
            ),
            (
                "no-self",
                None,
                vec![(503, Some(0), AFTER)],
                "could not read its own user id",
            ),
        ] {
            let read = read_withheld(&scratch.path().join(name), own, &pids);
            let Residence::Unread(why) = &read else {
                panic!("{name}: {read:?}");
            };
            assert!(why.contains(says), "{name}: {why}");
        }
        let tick_rate_unknown = {
            let root = scratch.path().join("no-hz");
            let held = withheld_root(&root, Some(1000), &[(504, Some(1000), BEFORE)]);
            std::fs::create_dir_all(root.join("wt")).unwrap();
            residence_by(&root, &root.join("wt"), DECLARED_MS, None, |at| {
                if held
                    .iter()
                    .any(|p| at.starts_with(root.join(p.to_string())))
                {
                    Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
                } else {
                    std::fs::read_link(at)
                }
            })
        };
        assert!(
            matches!(tick_rate_unknown, Residence::Unread(_)),
            "{tick_rate_unknown:?}"
        );
    }

    /// A resident still wins over anything withheld beside it.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_resident_beside_withheld_processes_is_found() {
        let scratch = crate::test_scratch::Scratch::new("children-resident");
        let root = scratch.path().join("proc");
        let held = withheld_root(&root, Some(1000), &[(601, Some(0), AFTER)]);
        let tree = root.join("wt");
        std::fs::create_dir_all(&tree).unwrap();
        planted_proc(&root, 602, &tree);
        let read = residence_by(&root, &tree, DECLARED_MS, HZ, |at| {
            if held
                .iter()
                .any(|p| at.starts_with(root.join(p.to_string())))
            {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                std::fs::read_link(at)
            }
        });
        assert_eq!(read, Residence::Found(1));
    }

    /// Criterion 26: the line says what it could not look inside and why none
    /// of it was taken as the run's; with nothing set aside it says nothing.
    #[test]
    fn the_lost_line_says_what_was_set_aside_and_why() {
        let aside = child(
            Residence::Empty(SetAside {
                other_users: 852,
                own_before: 10,
            }),
            Some(NOW - 47 * MIN),
        );
        let line = lost_line(
            "sid-desk",
            "forge-master-sid-desk",
            &aside,
            Duration::from_secs(47 * 60),
            Duration::from_secs(31 * 60),
        );
        for part in [
            "could not look inside 862 process(es): 852 of other users and 10 of its own user started before the run was declared",
            "A run executes as this user",
            "none of them was taken as the run's",
        ] {
            assert!(line.contains(part), "{part} missing from: {line}");
        }
        let plain = lost_line(
            "sid-desk",
            "forge-master-sid-desk",
            &child(Residence::Empty(SetAside::default()), Some(NOW - 47 * MIN)),
            Duration::from_secs(47 * 60),
            Duration::from_secs(31 * 60),
        );
        assert!(!plain.contains("could not look inside"), "{plain}");
        assert!(plain.ends_with("the run itself is not ended."), "{plain}");
    }

    #[test]
    fn the_lost_line_names_the_run_its_worktree_and_the_silence() {
        let c = child(Residence::Empty(SetAside::default()), Some(NOW - 47 * MIN));
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
