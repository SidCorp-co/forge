/*
 * Giving back a run session the box is still recorded as holding.
 *
 * A run outlives the master that started it: the ledger row is written before
 * anything spawns, so a master that dies mid-run leaves marks nobody will set.
 * The box reads what only the machine can — the pid, the master's pane, the
 * process a subagent ran in, the transcript, the checkout — and core takes the
 * verdict on each run (ADR 0009, What core takes over: Recovery verdict). The
 * box beats, ends, closes and releases as it is told, and a run core gives no
 * verdict on is held as it stands and said, never decided here.
 */

mod notices;
use notices::*;

use runner_core::agent_activity::{now_ms, Doing};
use runner_core::ledger::{
    Incarnation, Ledger, Liveness, Run, HOST_PANE_GONE, HOST_PANE_STARTED, HOST_PROCESS_GONE,
};
use runner_core::subagent_end;
use runner_core::transcript_age;
use runner_platform::error::Result;
use runner_platform::subagent_host::HostRead;
use runner_transport::run_verdict::{self, Activity, CloseMarks, Facts, Transcript, Verdict};
use runner_workspace::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterPresence {
    /// The registry named a pane and tmux answered for it.
    Alive,
    /// The registry named a pane and tmux has no such pane — a positive observation.
    Gone,
    /// This box has no entry for that master, which is not the same as it being over.
    Unknown,
    /// The registry named a pane and tmux could not be asked about it, so
    /// nothing was observed either way (ISS-1312).
    Unanswered,
}

impl MasterPresence {
    fn wire(self) -> &'static str {
        match self {
            Self::Alive => "alive",
            Self::Gone => "gone",
            Self::Unknown => "unknown",
            Self::Unanswered => "unanswered",
        }
    }
}

/// Whether the master that started a run is still there to finish it.
#[async_trait::async_trait]
pub trait MasterLiveness: Send + Sync {
    async fn state(&self, master_session_id: &str) -> MasterPresence;
    async fn live_master_for_project(&self, project_id: &str) -> Option<String>;
}

#[async_trait::async_trait]
pub trait ProcessLiveness: Send + Sync {
    async fn is_gone(&self, pid: u32) -> bool;
    /// Whether the Claude Code process recorded for a subagent, `pid` started
    /// at `start`, still runs. A port that cannot say answers `Unreadable`,
    /// which ends nothing.
    async fn host(&self, _pid: u32, _start: &str) -> HostRead {
        HostRead::Unreadable
    }
}

/// Core's half of a sweep: the beat that says this box still holds a run, and
/// the verdict on what becomes of it.
#[async_trait::async_trait]
pub trait RunCore: Send + Sync {
    async fn beat(&self, session_id: &str) -> Result<()>;
    async fn verdict(&self, project_id: Option<&str>, facts: &Facts) -> Result<Verdict>;
}

/// What a run's own session last reported about itself through its hooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reported {
    pub doing: Doing,
    /// The last turn boundary this session reported, in wall-clock ms.
    pub at: i64,
    /// The newest write this box can read to the session's own transcript.
    pub written_at: Option<i64>,
}

#[async_trait::async_trait]
pub trait RunActivity: Send + Sync {
    async fn reported(&self, session_id: &str) -> Option<Reported>;
}

/// Where a project's repository is on this box.
///
/// The close loop's third mark is a question about git's registry — is this
/// run's checkout registered anywhere? — and a registry lives in a
/// repository. Without one the sweep can read the filesystem and nothing
/// else, and a filesystem answers *the path is not there*, which is not the
/// question and was never an answer to it (ISS-1193). A project this box
/// cannot resolve therefore leaves its runs holding, which is the same
/// standing an operator is already warned about by name.
pub trait RepoRoots: Send + Sync {
    fn root_for(&self, project_id: &str) -> Option<PathBuf>;
}

/// The three the close loop reaches the world through: the session row it
/// reads back, the leases it returns and reads back, and the repository whose
/// registry says what became of the run's checkout.
#[derive(Clone, Copy)]
pub struct Closing<'a> {
    pub sessions: &'a dyn SessionReader,
    pub leases: &'a dyn LeaseKeeper,
    pub roots: &'a dyn RepoRoots,
}

pub struct RunWatch<'a> {
    pub core: &'a dyn RunCore,
    pub idle: &'a dyn RunActivity,
}

/// One run core gave a verdict on that the caller acts on, and how far its
/// close loop got.
#[derive(Debug, Clone)]
pub struct Recovered {
    pub run_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub state: CloseState,
    /// Core owes this run's checkout back, for the reason its ended row keeps.
    pub release: Option<String>,
    /// Recovery has said, once, why this run still stands and what ends it,
    /// so a per-sweep line about it would only repeat that (ISS-1220).
    pub standing_said: bool,
    /// Core called the run's agent over while its process runs, for this reason.
    pub exit: Option<String>,
    pub owed_death_report: bool,
}

/// How the master pane was seen when the Claude Code process a subagent ran
/// in was read gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostEnd {
    /// The registry names the pane and tmux has no such pane.
    PaneGone,
    /// This box started a new master pane for the project in its place.
    PaneStarted,
    /// Neither: the process was read gone on its own.
    ProcessGone,
}

impl HostEnd {
    fn from_ledger(by: Option<&str>) -> Self {
        match by {
            Some(HOST_PANE_STARTED) => HostEnd::PaneStarted,
            Some(HOST_PANE_GONE) => HostEnd::PaneGone,
            _ => HostEnd::ProcessGone,
        }
    }

    fn wire(self) -> &'static str {
        match self {
            HostEnd::PaneGone => "pane_gone",
            HostEnd::PaneStarted => "pane_started",
            HostEnd::ProcessGone => "process_gone",
        }
    }

    fn from_wire(how: &str) -> Option<Self> {
        match how {
            "pane_gone" => Some(HostEnd::PaneGone),
            "pane_started" => Some(HostEnd::PaneStarted),
            "process_gone" => Some(HostEnd::ProcessGone),
            _ => None,
        }
    }
}

/// What one sweep read that it says once, after every run.
#[derive(Default)]
struct SweepReads {
    /// Runs whose master pane tmux could not be asked about.
    unanswered: Vec<String>,
    /// Of those, the runs whose subagent's own process was read gone.
    ended_by_process: Vec<String>,
    /// Runs core gave no verdict on, and why.
    unjudged: Vec<String>,
}

/// One run as gathered for core: the facts, and the live master a parked run
/// would answer to.
struct Gathered {
    facts: Facts,
    parent: Option<String>,
}

/// The ports one sweep reads and acts through.
struct Ports<'a> {
    boot_id: &'a str,
    masters: &'a dyn MasterLiveness,
    procs: &'a dyn ProcessLiveness,
    closing: Closing<'a>,
    watch: RunWatch<'a>,
}

/// Ask core for a verdict on every run the ledger holds open, and do what each
/// says. The returned runs are the ones the caller still acts on: an exit, a
/// release, a death report, or a standing it reads.
pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    procs: &dyn ProcessLiveness,
    closing: Closing<'_>,
    watch: RunWatch<'_>,
) -> Result<Vec<Recovered>> {
    end_what_no_master_can_close(ledger);
    let ports = Ports {
        boot_id,
        masters,
        procs,
        closing,
        watch,
    };
    let mut out = Vec::new();
    let mut reads = SweepReads::default();
    for mut run in ledger.unclosed_runs()? {
        let gathered = gather(ledger, &mut run, &ports, &mut reads).await?;
        let verdict = ports
            .watch
            .core
            .verdict(run.project_id.as_deref(), &gathered.facts)
            .await;
        let verdict = match verdict {
            Ok(v) => v,
            Err(e) => {
                hold_unjudged(&run, &e.to_string(), ports.watch.core, &mut reads).await;
                continue;
            }
        };
        if let Some(r) = obey(ledger, &mut run, gathered, verdict, &ports, &mut reads).await? {
            out.push(r);
        }
    }
    if let Some(line) = unanswered_line(&reads.unanswered, &reads.ended_by_process) {
        tracing::warn!("{line}");
    }
    if !reads.unjudged.is_empty() {
        tracing::error!(
            "[recovery] core gave no verdict on {} run(s) this sweep, so none of them was ended, closed or released, and each is held as it stands with its session beaten: {}. A box ahead of its core gets a 404 here: deploy core first",
            reads.unjudged.len(),
            reads.unjudged.join("; ")
        );
    }
    Ok(out)
}

/// A run core could not give a verdict on: nothing is decided for it here. Its
/// session is still beaten, because this box does still hold it, and a session
/// left to lapse would hand its issues to another run while this one works.
async fn hold_unjudged(run: &Run, why: &str, core: &dyn RunCore, reads: &mut SweepReads) {
    if let Some(id) = run.session_id.as_deref() {
        let _ = core.beat(id).await;
    }
    reads.unjudged.push(format!("{} ({why})", run.run_id));
}

/// Do what core said about `run`.
async fn obey(
    ledger: &mut Ledger,
    run: &mut Run,
    gathered: Gathered,
    verdict: Verdict,
    ports: &Ports<'_>,
    reads: &mut SweepReads,
) -> Result<Option<Recovered>> {
    match verdict {
        Verdict::Keep {
            beat,
            reparent,
            say_kept,
            ..
        } => {
            if let Some(parent) = gathered.parent.filter(|_| reparent) {
                ledger.reparent_run(&run.run_id, &parent)?;
            }
            if say_kept {
                say_why_kept(ledger, run, now_ms());
            }
            if let Some(id) = run.session_id.as_deref().filter(|_| beat) {
                let _ = ports.watch.core.beat(id).await;
            }
            Ok(None)
        }
        Verdict::Exit { because, .. } => Ok(Some(Recovered {
            run_id: run.run_id.clone(),
            project_id: run.project_id.clone(),
            session_id: run.session_id.clone(),
            state: close_loop::state(ledger, &run.run_id)?,
            release: None,
            standing_said: false,
            exit: Some(because),
            owed_death_report: false,
        })),
        Verdict::Close { end, .. } => {
            close_and_settle(ledger, run, gathered.facts, end, ports, reads).await
        }
        Verdict::Settle { .. } => {
            reads.unjudged.push(format!(
                "{} (core answered settle to a run this sweep has not closed)",
                run.run_id
            ));
            Ok(None)
        }
    }
}

/// End `run` where core named why, run its close loop, and ask core again
/// with the marks the loop read back.
async fn close_and_settle(
    ledger: &mut Ledger,
    run: &mut Run,
    mut facts: Facts,
    end: Option<String>,
    ports: &Ports<'_>,
    reads: &mut SweepReads,
) -> Result<Option<Recovered>> {
    if let Some(reason) = end {
        end_as_told(ledger, run, &reason)?;
        facts.ended = true;
        facts.ledger_dead = true;
    }
    let closing = &ports.closing;
    let repo = run
        .project_id
        .as_deref()
        .and_then(|p| closing.roots.root_for(p));
    let state = close_loop::close(
        ledger,
        &run.run_id,
        repo.as_deref(),
        closing.sessions,
        closing.leases,
    )
    .await?;
    facts.close = Some(CloseMarks {
        session_terminal: state.session_terminal,
        checkout_returned: state.checkout_returned,
        leases_returned: state.leases_returned,
        leases_total: state.leases_total,
    });
    let answer = ports
        .watch
        .core
        .verdict(run.project_id.as_deref(), &facts)
        .await;
    let Verdict::Settle {
        release,
        death_report,
        standing,
        release_after_minutes,
        ..
    } = (match answer {
        Ok(v) => v,
        Err(e) => {
            reads.unjudged.push(format!(
                "{} (asked what its close left owed: {e})",
                run.run_id
            ));
            return Ok(None);
        }
    })
    else {
        reads.unjudged.push(format!(
            "{} (asked what its close left owed, core answered another act)",
            run.run_id
        ));
        return Ok(None);
    };
    let said = settle_said(
        ledger,
        run,
        ports.boot_id,
        &state,
        release.as_ref(),
        standing.as_deref(),
        release_after_minutes,
    );
    Ok(Some(Recovered {
        run_id: run.run_id.clone(),
        project_id: run.project_id.clone(),
        session_id: run.session_id.clone(),
        state,
        release: release.map(|r| r.reason),
        standing_said: said,
        exit: None,
        owed_death_report: death_report,
    }))
}

/// Say what a settle verdict owes saying once: the release's first line, and
/// why a run nothing closed this sweep still stands.
fn settle_said(
    ledger: &Ledger,
    run: &Run,
    boot_id: &str,
    state: &CloseState,
    release: Option<&run_verdict::Release>,
    standing: Option<&str>,
    release_after_minutes: u64,
) -> bool {
    match release.and_then(|r| r.notice.as_ref()) {
        Some(run_verdict::Notice::Unanswered { over_ms }) => {
            say_why_released(ledger, run, *over_ms)
        }
        Some(run_verdict::Notice::Host { how }) => match HostEnd::from_wire(how) {
            Some(how) => say_why_released_host(ledger, run, how),
            None => tracing::warn!(
                "[recovery] run {}: core named a host end this build does not know ({how})",
                run.run_id
            ),
        },
        None => {}
    }
    let Some(word) = standing else {
        return false;
    };
    match Standing::from_wire(word) {
        Some(s) => say_standing(ledger, run, boot_id, state, s, release_after_minutes),
        None => {
            tracing::warn!(
                "[recovery] run {}: core named a standing this build does not know ({word})",
                run.run_id
            );
            false
        }
    }
}

/// End `run` in the ledger for the reason core gave, and stand it as a
/// master's close ends one, so the close loop takes it from here in this same
/// sweep.
fn end_as_told(ledger: &Ledger, run: &mut Run, reason: &str) -> Result<()> {
    ledger.end_run(&run.run_id, ENDED_BY_BOX, reason)?;
    let keys = issue_keys(ledger, &run.run_id)?.join(", ");
    tracing::warn!(
        "[recovery] run {} ({}: {keys}) under master session {} ended: {reason}",
        run.run_id,
        run.project_id.as_deref().unwrap_or("no project"),
        runner_core::ledger::short_id(&run.master_session_id)
    );
    run.incarnation = Incarnation::Exited;
    run.ended_by = Some(ENDED_BY_BOX.to_string());
    run.ended_reason = Some(reason.to_string());
    Ok(())
}

/// Who a run core ended says ended it: the box, which ended it on core's word.
pub(crate) const ENDED_BY_BOX: &str = "box";

fn issue_keys(ledger: &Ledger, run_id: &str) -> Result<Vec<String>> {
    Ok(ledger
        .issues(run_id)?
        .into_iter()
        .map(|m| m.issue_key)
        .collect())
}

/// Read what only this machine can say about `run`, recording on its row the
/// end of the process its subagent ran in where that was read.
async fn gather(
    ledger: &mut Ledger,
    run: &mut Run,
    ports: &Ports<'_>,
    reads: &mut SweepReads,
) -> Result<Gathered> {
    let Ports {
        boot_id,
        masters,
        procs,
        closing,
        watch,
    } = ports;
    let boot_id = *boot_id;
    let now = now_ms();
    let parked = run.is_parked_on_human();
    let read = masters.state(&run.master_session_id).await;
    if read == MasterPresence::Unanswered {
        reads.unanswered.push(run.run_id.clone());
    }
    let parent = match run.project_id.as_deref() {
        Some(project)
            if parked && !matches!(read, MasterPresence::Alive | MasterPresence::Unanswered) =>
        {
            masters.live_master_for_project(project).await
        }
        _ => None,
    };
    let pid_refuted = match run.pid {
        Some(pid) => procs.is_gone(pid).await,
        None => false,
    };
    let host_read = match (run.pid, run.host_pid, run.host_start.as_deref()) {
        (None, Some(pid), Some(start)) if run.boot_id == boot_id => {
            Some(procs.host(pid, start).await)
        }
        _ => None,
    };
    if !parked {
        note_host(ledger, run, read, host_read, reads)?;
    }
    let checkout_gone =
        if !parked && run.pid.is_none() && run.ended_by.is_none() && run.boot_id == boot_id {
            Some(checkout_gone(run, closing).await)
        } else {
            None
        };
    let activity = match run.session_id.as_deref() {
        Some(id) => watch.idle.reported(id).await.map(|r| activity_of(r, now)),
        None => None,
    };
    let subagent = subagent_end::of_run(run, now);
    let host_ended = (run.pid.is_none()
        && matches!(subagent, subagent_end::Evidence::HostEnded { .. }))
    .then(|| HostEnd::from_ledger(run.host_ended_by.as_deref()).wire());
    let facts = Facts {
        issue_keys: issue_keys(ledger, &run.run_id)?,
        parked_on_human: parked,
        master: read.wire(),
        live_master_in_project: parent.is_some(),
        this_boot: run.boot_id == boot_id,
        boot_ended: boot_ended(&run.boot_id, boot_id),
        bound: run.agent_id.is_some(),
        process: match run.pid {
            None => "none",
            Some(_) if pid_refuted => "gone",
            Some(_) => "alive",
        },
        ledger_dead: matches!(Ledger::liveness(run, boot_id, pid_refuted), Liveness::Dead),
        host: match host_read {
            None => "not_read",
            Some(HostRead::Alive) => "alive",
            Some(HostRead::Gone) => "gone",
            Some(HostRead::Unreadable) => "unreadable",
        },
        host_ended,
        ended: run.ended_by.is_some(),
        declared_ago_ms: ago(now, run.created_at.saturating_mul(1000)),
        checkout_gone,
        has_session: run.session_id.is_some(),
        activity,
        session_over_for_ms: run
            .session_terminal_at
            .map(|at| ago(now, at.saturating_mul(1000))),
        subagent: subagent.wire().into(),
        transcript: match (run.agent_transcript.as_deref(), transcript_written(run)) {
            (_, Some(w)) => Transcript::Written {
                ago_ms: ago(now, w),
            },
            (Some(_), None) => Transcript::Unreadable,
            (None, None) => Transcript::None,
        },
        release_decided: run.release_terminal_at.is_some(),
        release_refused: run.release_refused_at.is_some(),
        close: None,
    };
    Ok(Gathered { facts, parent })
}

/// Whether the boot a run was declared under is known to have ended: both
/// boots were read and they differ. A box that cannot read its boot, or a row
/// that names none, cannot tell, and says so by claiming no ending.
fn boot_ended(run_boot: &str, this_boot: &str) -> bool {
    !run_boot.is_empty() && !this_boot.is_empty() && run_boot != this_boot
}

fn ago(now: i64, at: i64) -> u64 {
    u64::try_from(now.saturating_sub(at)).unwrap_or(0)
}

fn activity_of(r: Reported, now: i64) -> Activity {
    Activity {
        doing: match r.doing {
            Doing::Working => "working",
            Doing::AwaitingPermission => "awaiting_permission",
            Doing::AwaitingChildren => "awaiting_children",
            Doing::Idle => "idle",
        },
        last_event_ago_ms: ago(now, r.at),
        written_ago_ms: r.written_at.map(|w| ago(now, w)),
    }
}

/// Record on the row what this sweep read of the process a subagent ran in.
///
/// A subagent runs in the Claude Code process recorded for it, and that
/// process read gone is its end, whatever the master's pane reads. A pane read
/// gone is not by itself that end: the conversation can run as a background
/// session outside the pane (ISS-1312, run e67c08e0). The same pane read alive
/// again says the read that marked it saw nothing end, so that mark is
/// withdrawn; a mark its process's own end wrote stays.
fn note_host(
    ledger: &Ledger,
    run: &mut Run,
    read: MasterPresence,
    host_read: Option<HostRead>,
    reads: &mut SweepReads,
) -> Result<()> {
    if run.host_ended_at_ms.is_none() && host_read == Some(HostRead::Gone) {
        let at = now_ms();
        let by = if read == MasterPresence::Gone {
            HOST_PANE_GONE
        } else {
            HOST_PROCESS_GONE
        };
        if ledger.note_host_ended(&run.run_id, at, by)? {
            run.host_ended_at_ms = Some(at);
            run.host_ended_by = Some(by.to_string());
            if read == MasterPresence::Unanswered {
                reads.ended_by_process.push(run.run_id.clone());
            }
        }
    }
    if read == MasterPresence::Alive
        && run.host_ended_by.as_deref() == Some(HOST_PANE_GONE)
        && host_read != Some(HostRead::Gone)
        && ledger.withdraw_pane_gone(&run.run_id)?
    {
        tracing::info!(
            "[recovery] run {}: its master's pane reads alive again, so the earlier read of it as gone is withdrawn and its subagent is read by its own evidence",
            run.run_id
        );
        run.host_ended_at_ms = None;
        run.host_ended_by = None;
    }
    Ok(())
}

/// Whether git no longer registers `run`'s checkout. The filesystem alone is
/// no answer (ISS-1193): an absent path is asked of the repository's registry,
/// and a project this box cannot resolve reads as not gone.
async fn checkout_gone(run: &Run, closing: &Closing<'_>) -> bool {
    let worktree = Path::new(&run.worktree_path);
    run.worktree_gone_at.is_some()
        || (!worktree.exists()
            && match run
                .project_id
                .as_deref()
                .and_then(|p| closing.roots.root_for(p))
            {
                Some(repo) => matches!(
                    runner_workspace::worktree::residence_of(&repo, worktree).await,
                    runner_workspace::worktree::Residence::Gone
                ),
                None => false,
            })
}

/// End the runs no master on this box answers for once their marks close
/// them, and name each one ended (ISS-1355).
///
/// Taken first, because `unclosed_runs` below never selects such a row: a
/// replaced master's run whose lease this sweep reads back is ended by the
/// next one. A ledger that refuses the ending stops nothing else this sweep
/// owes, and says so.
fn end_what_no_master_can_close(ledger: &Ledger) {
    let ended = match ledger.end_closed_runs_no_master_answers_for() {
        Ok(ended) => ended,
        Err(e) => {
            tracing::warn!(
                "[recovery] the runs no master on this box answers for could not be ended ({e}); they stay open, and `forge-runner status` names them"
            );
            return;
        }
    };
    for u in ended {
        let keys = u
            .issues
            .iter()
            .map(|m| m.issue_key.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        tracing::info!(
            "[recovery] run {} ({}: {keys}) ended: declared under master session {}, which no master on this box holds now, and its session, checkout and leases are all back",
            u.run.run_id,
            u.run.project_id.as_deref().unwrap_or("no project"),
            runner_core::ledger::short_id(&u.run.master_session_id)
        );
    }
}

/// When the run's subagent last wrote its own transcript, or `None` where no
/// path is recorded or the recorded one cannot be read.
fn transcript_written(run: &Run) -> Option<i64> {
    run.agent_transcript
        .as_deref()
        .and_then(|p| transcript_age::written_at(Path::new(p)))
}

/// What a silence rests on, in the words a journal line needs.
fn silence_evidence(run: &Run) -> String {
    match (run.agent_transcript.as_deref(), transcript_written(run)) {
        (_, Some(w)) => format!(
            "its subagent last wrote {}m ago",
            now_ms().saturating_sub(w) / 60_000
        ),
        (Some(path), None) => format!(
            "its subagent's transcript at {path} cannot be read, so the session's clock alone \
             decides"
        ),
        (None, None) => {
            "no transcript was recorded for its subagent, so the session's clock alone decides"
                .to_string()
        }
    }
}

#[cfg(test)]
mod tests;
