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
//! A withheld process of another user, of this user and started before the run
//! was declared, or of this user and descended from neither the tmux server the
//! master panes run on nor this daemon, is set aside and said in the line. A
//! run executes as this daemon's user, is started under that server or by this
//! daemon, and a process takes its working directory and its parent from the
//! one that started it. Reading every withheld pid as a possible resident
//! counted a lost run for ever on every real box, where hundreds of other
//! users' processes withhold theirs (ISS-1306 round 3, judge-109), and reading
//! every newer one of this user so counted it for as long as an ssh login
//! stayed open (round 4, judge-112). A chain that cannot be read whole, or a
//! server whose pid cannot be read, still counts. An own-user process a run
//! started, that withholds its directory and was reparented when its parent
//! exited, reads as outside too; it is set aside only beside a transcript
//! silent for the floor, and what that costs is one ask. Stopping counting
//! decides nothing about the run: no run is ended, released or closed here,
//! and the next prompt the master is given clears the set its hooks keep.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::daemon::agent_activity::Activity;
use crate::daemon::master_ask::ASK_FLOOR;
use crate::daemon::transcript_age;
use crate::runner::ledger::Ledger;
use crate::workspace::worktree_processes::{self, Lineage, Reading};

/// Processes whose working directory the kernel withheld from this box and
/// which a reading set aside as not the run's, by why.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct SetAside {
    /// Of another user: a run executes as this daemon's user.
    pub other_users: usize,
    /// Of this daemon's user and started before the run was declared: a
    /// process takes its working directory from the one that started it.
    pub own_before: usize,
    /// Of this daemon's user, whose whole parent chain reaches neither the tmux
    /// server the master panes run on nor this daemon: an ssh login, a desktop
    /// session, an agent.
    pub own_outside: usize,
}

/// What this box starts a dispatched run under, read once per sweep: a run is
/// a subagent of a master whose pane is a child of the tmux server, or a
/// process this daemon started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Anchors {
    /// The tmux server's pid, or why it could not be asked.
    pub server: Result<u32, String>,
    /// This daemon's own pid.
    pub daemon: u32,
}

impl Anchors {
    /// The anchors of this box as it runs now.
    pub(crate) async fn read() -> Self {
        Anchors {
            server: crate::daemon::terminal::server_pid().await,
            daemon: std::process::id(),
        }
    }

    fn pids(&self) -> Vec<u32> {
        let mut pids = vec![self.daemon];
        pids.extend(self.server.as_ref().ok().copied());
        pids
    }

    fn named(&self, pid: u32) -> String {
        if self.server.as_ref().ok() == Some(&pid) {
            format!("the tmux server the master panes run on, pid {pid}")
        } else {
            format!("this daemon, pid {pid}")
        }
    }
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
    table: Table<'_>,
) -> Vec<Child> {
    read_children_by(
        seen,
        ledger,
        &Probe {
            proc_root: table.proc_root,
            anchors: table.anchors,
            clk_tck: worktree_processes::clk_tck(),
            cwd: |at: &Path| std::fs::read_link(at),
        },
    )
}

/// The process table a sweep reads, and the anchors it reads it against.
#[derive(Clone, Copy)]
pub(crate) struct Table<'a> {
    pub proc_root: &'a Path,
    pub anchors: &'a Anchors,
}

/// How a process table is read: where, against which anchors, at which tick
/// rate, and through which `cwd` read, which a test replaces because a
/// withheld link is not a state a planted process root can be made to enter.
pub(crate) struct Probe<'a, F> {
    pub proc_root: &'a Path,
    pub anchors: &'a Anchors,
    pub clk_tck: Option<u64>,
    pub cwd: F,
}

/// [`read_children`] through `probe`.
pub(crate) fn read_children_by<F>(
    seen: &Activity,
    ledger: Option<&Ledger>,
    probe: &Probe<'_, F>,
) -> Vec<Child>
where
    F: Fn(&Path) -> std::io::Result<PathBuf>,
{
    seen.children
        .iter()
        .map(|agent_id| read_child(agent_id, seen.transcript.as_deref(), ledger, probe))
        .collect()
}

fn read_child<F>(
    agent_id: &str,
    lead: Option<&str>,
    ledger: Option<&Ledger>,
    probe: &Probe<'_, F>,
) -> Child
where
    F: Fn(&Path) -> std::io::Result<PathBuf>,
{
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
            let residence = residence_by(probe, &run.worktree_path, declared_ms);
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

/// Who lives in `worktree`, read through `probe`, for a run declared at
/// `declared_ms`.
pub(crate) fn residence_by<F>(probe: &Probe<'_, F>, worktree: &Path, declared_ms: i64) -> Residence
where
    F: Fn(&Path) -> std::io::Result<PathBuf>,
{
    let (reading, held) =
        worktree_processes::residents_of_with_withheld_by(probe.proc_root, worktree, &probe.cwd);
    match reading {
        Reading::Read { residents, .. } if !residents.is_empty() => {
            Residence::Found(residents.len())
        }
        Reading::Read { .. } => set_aside(
            probe.proc_root,
            &held,
            declared_ms,
            probe.clk_tck,
            probe.anchors,
        ),
        Reading::NoTable(why) | Reading::Unreadable(why) => Residence::Unread(why),
    }
}

/// Sort the withheld pids of a reading that found no resident: set aside the
/// ones that cannot be the run's, and leave the reading unread at the first
/// that could be.
fn set_aside(
    proc_root: &Path,
    held: &[u32],
    declared_ms: i64,
    clk_tck: Option<u64>,
    anchors: &Anchors,
) -> Residence {
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
            (Some(_), started) => {
                let since = if started.is_some() {
                    "started since the run was declared"
                } else {
                    "when it started could not be read"
                };
                let comm = worktree_processes::command_name(proc_root, pid)
                    .unwrap_or_else(|| "command unread".to_string());
                let who = format!("pid {pid} ({comm}), of this daemon's own user ({since}),");
                match worktree_processes::lineage(proc_root, pid, &anchors.pids()) {
                    Lineage::Outside => match &anchors.server {
                        Ok(_) => aside.own_outside += 1,
                        Err(why) => {
                            return Residence::Unread(format!(
                                "{who} would not show its working directory and does not \
                                 descend from this daemon, and whether it descends from the tmux \
                                 server the master panes run on cannot be told, as that server's \
                                 pid could not be read ({why})"
                            ))
                        }
                    },
                    Lineage::Reaches(anchor) => {
                        return Residence::Unread(format!(
                            "{who} descends from {} and would not show its working directory",
                            anchors.named(anchor)
                        ))
                    }
                    // It went mid-walk, itself: there is no process left to be there.
                    Lineage::Untraced(_) if !proc_root.join(pid.to_string()).exists() => {}
                    Lineage::Untraced(why) => {
                        return Residence::Unread(format!(
                            "{who} would not show its working directory, and {why}, so whether a \
                             run started it cannot be told"
                        ))
                    }
                }
            }
        }
    }
    Residence::Empty(aside)
}

/// Why a child still counts only because its worktree could not be read, and
/// how long its transcript has been silent, where that silence has reached
/// the floor: anything else keeps it counting on its own, and is not news.
pub(crate) fn held_by(child: &Child, now_ms: i64) -> Option<(&str, Duration)> {
    let Residence::Unread(why) = &child.residence else {
        return None;
    };
    let silent = Duration::from_millis(now_ms.saturating_sub(child.written_at?).max(0) as u64);
    (silent >= ASK_FLOOR).then_some((why.as_str(), silent))
}

/// The journal line for a child [`held_by`] something this box could not read.
pub(crate) fn held_line(
    slug: &str,
    pane: &str,
    child: &Child,
    why: &str,
    silent: Duration,
) -> String {
    let transcript = child
        .transcript
        .as_deref()
        .map(|p| format!("its transcript {}", p.display()))
        .unwrap_or_else(|| "its transcript".to_string());
    let place = child
        .worktree
        .as_deref()
        .map(|w| format!("its worktree {}", w.display()))
        .unwrap_or_else(|| "its worktree".to_string());
    format!(
        "[master] {slug}: still counting {} as work in flight for {pane} — {transcript} was last written {}m ago, but {why}, so whether the run is still in {place} cannot be told, and {pane} keeps reading as busy until it can",
        what(child),
        silent.as_secs() / 60,
    )
}

fn what(child: &Child) -> String {
    match &child.run_id {
        Some(run) => format!("run {run} (subagent {})", child.agent_id),
        None => format!(
            "subagent {}, which no open run on this box's ledger names",
            child.agent_id
        ),
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
    let what = what(child);
    let place = match &child.worktree {
        Some(at) => format!("its worktree {} has held no process", at.display()),
        None => "it has no worktree to hold a process".to_string(),
    };
    let aside = match &child.residence {
        Residence::Empty(SetAside {
            other_users,
            own_before,
            own_outside,
        }) if other_users + own_before + own_outside > 0 => format!(
            " This box could not look inside {} process(es): {other_users} of other users, \
             {own_before} of its own user started before the run was declared, and {own_outside} \
             of its own user descended from neither the tmux server the master panes run on nor \
             this daemon. A run executes as this user, is started under that server or by this \
             daemon, and takes its working directory from the one that started it, so none of \
             them was taken as the run's.",
            other_users + own_before + own_outside
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

        let anchors = planted_anchors();
        let no_ledger = read_children(
            &seen,
            None,
            Table {
                proc_root: &proc_root,
                anchors: &anchors,
            },
        );
        assert!(matches!(no_ledger[0].residence, Residence::Unread(_)));
        assert_eq!(no_ledger[0].transcript.as_deref(), Some(sub.as_path()));
        assert!(no_ledger[0].written_at.is_some());

        let mut led = Ledger::open(&root.join("ledger.sqlite")).unwrap();
        let none = read_children(
            &seen,
            Some(&led),
            Table {
                proc_root: &proc_root,
                anchors: &anchors,
            },
        );
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
        let empty = read_children(
            &seen,
            Some(&led),
            Table {
                proc_root: &proc_root,
                anchors: &anchors,
            },
        );
        assert_eq!(empty[0].run_id.as_deref(), Some("run-1"));
        assert_eq!(empty[0].residence, Residence::Empty(SetAside::default()));

        planted_proc(&proc_root, 4242, &tree.join("packages"));
        let lived = read_children(
            &seen,
            Some(&led),
            Table {
                proc_root: &proc_root,
                anchors: &anchors,
            },
        );
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
        withheld_root_under(root, own, pids, &[])
    }

    /// [`withheld_root`], where `parents` names a parent for a pid (withheld or
    /// not) as `(pid, uid, parent)`: a pid named there gets a `status` with its
    /// `PPid:`, and one that is not withheld gets no `cwd`, so the table reads
    /// it as gone and it is only a link in a chain.
    #[cfg(target_os = "linux")]
    fn withheld_root_under(
        root: &Path,
        own: Option<u32>,
        pids: &[(u32, Option<u32>, Option<u64>)],
        parents: &[(u32, u32, u32)],
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
            let ppid = parents
                .iter()
                .find(|(p, ..)| p == pid)
                .map(|(.., parent)| format!("PPid:\t{parent}\n"))
                .unwrap_or_default();
            if let Some(uid) = uid {
                std::fs::write(
                    dir.join("status"),
                    format!("Name:\tagent\nUid:\t{uid}\t0\t0\t0\n{ppid}"),
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
        for (pid, uid, parent) in parents {
            let dir = root.join(pid.to_string());
            if dir.join("status").exists() {
                continue;
            }
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("status"),
                format!("Name:\tlink\nUid:\t{uid}\t0\t0\t0\nPPid:\t{parent}\n"),
            )
            .unwrap();
        }
        pids.iter().map(|(pid, ..)| *pid).collect()
    }

    /// The anchors the planted roots are read against: the tmux server is pid
    /// 900 and this daemon pid 950.
    #[cfg(target_os = "linux")]
    fn planted_anchors() -> Anchors {
        Anchors {
            server: Ok(900),
            daemon: 950,
        }
    }

    /// A `cwd` read that answers `PermissionDenied` for every pid in `held`
    /// under `root`, as the kernel does for a process it withholds.
    #[cfg(target_os = "linux")]
    fn withholding(
        root: &Path,
        held: std::collections::BTreeSet<u32>,
    ) -> impl Fn(&Path) -> std::io::Result<PathBuf> + '_ {
        move |at: &Path| {
            if held
                .iter()
                .any(|p| at.starts_with(root.join(p.to_string())))
            {
                Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
            } else {
                std::fs::read_link(at)
            }
        }
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
        read_withheld_under(root, own, pids, &[], &planted_anchors())
    }

    /// [`read_withheld`] with parents planted and the anchors given.
    #[cfg(target_os = "linux")]
    fn read_withheld_under(
        root: &Path,
        own: Option<u32>,
        pids: &[(u32, Option<u32>, Option<u64>)],
        parents: &[(u32, u32, u32)],
        anchors: &Anchors,
    ) -> Residence {
        let held = withheld_root_under(root, own, pids, parents);
        let tree = root.join("wt");
        std::fs::create_dir_all(&tree).unwrap();
        let probe = Probe {
            proc_root: root,
            anchors,
            clk_tck: HZ,
            cwd: withholding(root, held),
        };
        residence_by(&probe, &tree, DECLARED_MS)
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
                own_before: 0,
                own_outside: 0
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
                own_before: 1,
                own_outside: 0
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
            let probe = Probe {
                proc_root: &root,
                anchors: &planted_anchors(),
                clk_tck: None,
                cwd: withholding(&root, held),
            };
            residence_by(&probe, &root.join("wt"), DECLARED_MS)
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
        let probe = Probe {
            proc_root: &root,
            anchors: &planted_anchors(),
            clk_tck: HZ,
            cwd: withholding(&root, held),
        };
        let read = residence_by(&probe, &tree, DECLARED_MS);
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
                own_outside: 3,
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
            "could not look inside 865 process(es): 852 of other users, 10 of its own user started before the run was declared, and 3 of its own user descended from neither the tmux server the master panes run on nor this daemon",
            "A run executes as this user, is started under that server or by this daemon",
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

    /// Criteria 29 and 16 (judge-112): an ssh login of this user, opened after
    /// the run was declared, is set aside by its parent chain, which runs up
    /// through root's sshd to pid 1 and meets neither anchor.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_login_of_this_user_is_not_the_run() {
        let scratch = crate::test_scratch::Scratch::new("children-login");
        let read = read_withheld_under(
            &scratch.path().join("proc"),
            Some(1000),
            &[(701, Some(1000), AFTER)],
            &[(701, 1000, 700), (700, 0, 15), (15, 0, 1)],
            &planted_anchors(),
        );
        assert_eq!(
            read,
            Residence::Empty(SetAside {
                other_users: 0,
                own_before: 0,
                own_outside: 1
            })
        );
        assert_eq!(read.absent(), Some(true));
    }

    /// Criterion 24: a process of this user descended from the masters' tmux
    /// server, or from this daemon, keeps the run counting, and the reading
    /// names it, its command and what it descends from (criterion 30).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_process_under_the_masters_server_or_this_daemon_keeps_it_counting() {
        let scratch = crate::test_scratch::Scratch::new("children-anchored");
        for (name, parents, says) in [
            (
                "server",
                vec![(702, 1000, 800), (800, 1000, 900), (900, 1000, 1)],
                "pid 702 (agent), of this daemon's own user (started since the run was declared), descends from the tmux server the master panes run on, pid 900",
            ),
            (
                "daemon",
                vec![(702, 1000, 950), (950, 1000, 1)],
                "descends from this daemon, pid 950",
            ),
        ] {
            let read = read_withheld_under(
                &scratch.path().join(name),
                Some(1000),
                &[(702, Some(1000), AFTER)],
                &parents,
                &planted_anchors(),
            );
            let Residence::Unread(why) = &read else {
                panic!("{name}: {read:?}");
            };
            assert!(why.contains(says), "{name}: {why}");
            assert_eq!(read.absent(), None, "{name}");
        }
    }

    /// Criterion 24: a chain that cannot be read whole, or a server whose pid
    /// could not be read beside a chain that misses this daemon, still counts.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_untraced_chain_or_an_unknown_server_keeps_it_counting() {
        let scratch = crate::test_scratch::Scratch::new("children-untraced");
        let broken = read_withheld_under(
            &scratch.path().join("broken"),
            Some(1000),
            &[(703, Some(1000), AFTER)],
            &[(703, 1000, 777)],
            &planted_anchors(),
        );
        let Residence::Unread(why) = &broken else {
            panic!("{broken:?}");
        };
        assert!(
            why.contains("pid 703 (agent)")
                && why.contains("the parent of pid 777 could not be read"),
            "{why}"
        );
        let unknown = read_withheld_under(
            &scratch.path().join("unknown"),
            Some(1000),
            &[(704, Some(1000), AFTER)],
            &[(704, 1000, 700), (700, 0, 1)],
            &Anchors {
                server: Err("no server running on /x/tmux.sock".into()),
                daemon: 950,
            },
        );
        let Residence::Unread(why) = &unknown else {
            panic!("{unknown:?}");
        };
        assert!(
            why.contains("pid 704 (agent)")
                && why.contains(
                    "that server's pid could not be read (no server running on /x/tmux.sock)"
                ),
            "{why}"
        );
    }

    /// The exception the ruling takes on purpose: a process a run started,
    /// withholding its directory, whose parent exited so that it was
    /// reparented to `systemd --user`, reads as outside and is set aside.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_reparented_orphan_reads_as_outside() {
        let scratch = crate::test_scratch::Scratch::new("children-orphan");
        let read = read_withheld_under(
            &scratch.path().join("proc"),
            Some(1000),
            &[(705, Some(1000), AFTER)],
            &[(705, 1000, 298), (298, 1000, 1)],
            &planted_anchors(),
        );
        assert_eq!(
            read,
            Residence::Empty(SetAside {
                other_users: 0,
                own_before: 0,
                own_outside: 1
            })
        );
    }

    /// judge-112's n23d: the declaration reaches the reading through the
    /// ledger, in seconds, and is compared in ms. A process of this user that
    /// started an hour before the run was declared is set aside; read as
    /// seconds the declaration would fall in 1970, and the process would count.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_declaration_is_read_off_the_ledger_in_its_own_unit() {
        let scratch = crate::test_scratch::Scratch::new("children-declared");
        let root = scratch.path();
        let proc_root = root.join("proc");
        let now_secs = agent_now_secs();
        let booted = now_secs - 10_000;
        let started_ticks = (10_000 - 3_600) * 100;
        let held = withheld_root(
            &proc_root,
            Some(1000),
            &[(801, Some(1000), Some(started_ticks))],
        );
        std::fs::write(
            proc_root.join("stat"),
            format!("cpu 1 2 3\nbtime {booted}\n"),
        )
        .unwrap();
        let tree = root.join("w").join("iss-1");
        std::fs::create_dir_all(&tree).unwrap();
        let lead = root.join("t").join("conv.jsonl");
        std::fs::create_dir_all(lead.parent().unwrap()).unwrap();
        std::fs::write(&lead, "{}\n").unwrap();
        let seen = master_over("a1", &lead);
        let mut led = Ledger::open(&root.join("ledger.sqlite")).unwrap();
        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: "run-1".into(),
            project_id: "p".into(),
            master_session_id: "m".into(),
            worktree_path: tree,
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1".into()],
        })
        .unwrap();
        assert!(led.bind_agent("run-1", "a1").unwrap());
        led.backdate_declared("run-1", now_secs).unwrap();
        let probe = Probe {
            proc_root: &proc_root,
            anchors: &planted_anchors(),
            clk_tck: HZ,
            cwd: withholding(&proc_root, held),
        };
        let read = read_children_by(&seen, Some(&led), &probe);
        assert_eq!(
            read[0].residence,
            Residence::Empty(SetAside {
                other_users: 0,
                own_before: 1,
                own_outside: 0
            })
        );
    }

    #[cfg(target_os = "linux")]
    fn agent_now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64
    }

    /// Criterion 30: only a child that counts solely because its worktree
    /// could not be read, with its transcript silent for the floor, is held.
    #[test]
    fn a_child_is_held_only_by_an_unread_worktree_past_the_floor() {
        let why = "pid 702 (ssh), of this daemon's own user (started since the run was declared), descends from the tmux server the master panes run on, pid 900 and would not show its working directory";
        let held = child(Residence::Unread(why.into()), Some(NOW - 31 * MIN));
        assert_eq!(
            held_by(&held, NOW),
            Some((why, Duration::from_secs(31 * 60)))
        );
        assert_eq!(
            held_by(
                &child(Residence::Unread(why.into()), Some(NOW - 29 * MIN)),
                NOW
            ),
            None,
            "its transcript keeps it counting"
        );
        assert_eq!(
            held_by(&child(Residence::Unread(why.into()), None), NOW),
            None
        );
        assert_eq!(
            held_by(&child(Residence::Found(1), Some(NOW - 31 * MIN)), NOW),
            None
        );
        let line = held_line(
            "sid-desk",
            "forge-master-sid-desk",
            &held,
            why,
            Duration::from_secs(31 * 60),
        );
        for part in [
            "[master] sid-desk: still counting run run-1 (subagent a1) as work in flight for forge-master-sid-desk",
            "/t/agent-a1.jsonl was last written 31m ago",
            "pid 702 (ssh)",
            "whether the run is still in its worktree /w/iss-1 cannot be told",
        ] {
            assert!(line.contains(part), "{part} missing from: {line}");
        }
    }
}
