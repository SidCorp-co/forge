/*
 * Giving back a run session the box is still recorded as holding.
 *
 * A run outlives the master that started it: the ledger row is written before
 * anything spawns, so a master that dies mid-run leaves marks nobody will set.
 * This is the local half — fast, and blind to the box's own death. The half
 * that survives losing power lives at core, keyed on the heartbeat.
 */

mod notices;
use notices::*;

use runner_core::agent_activity::now_ms;
use runner_core::ledger::{
    Incarnation, Ledger, Liveness, Run, HOST_PANE_GONE, HOST_PANE_STARTED, HOST_PROCESS_GONE,
};
use runner_core::run_exit::{self, Reported, Verdict};
use runner_core::subagent_end;
use runner_core::transcript_age;
use runner_platform::error::Result;
use runner_platform::subagent_host::HostRead;
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

#[async_trait::async_trait]
pub trait Heartbeat: Send + Sync {
    async fn beat(&self, session_id: &str) -> Result<()>;
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
    pub beat: &'a dyn Heartbeat,
    pub idle: &'a dyn RunActivity,
}

/// One run recovery attempted, and how far its loop got.
#[derive(Debug, Clone)]
pub struct Recovered {
    pub run_id: String,
    pub project_id: Option<String>,
    pub session_id: Option<String>,
    pub state: CloseState,
    /// This run's own close loop cannot advance without someone taking its
    /// worktree back first, and nothing else on the box will.
    pub owed_release: bool,
    /// The release is owed on the bound alone: no master here answers for the
    /// run, so its agent being gone is concluded from the silence, never seen.
    pub unanswered: bool,
    /// That release rests on the session's clock alone: no readable transcript
    /// said anything about the subagent either way.
    pub clock_alone: bool,
    /// The release was licensed by every issue this run holds being over at
    /// core, which is a different fact from either of the two above and is
    /// what its ended row has to say (ISS-1245).
    pub issues_over: bool,
    /// Recovery has said, once, why this run still stands and what ends it,
    /// so a per-sweep line about it would only repeat that (ISS-1220).
    pub standing_said: bool,
    /// The box may end this run itself, for the cause named.
    pub owed_exit: Option<run_exit::ExitCause>,
    pub owed_death_report: bool,
    /// The run's subagent is gone because the master pane it ran in is, and
    /// how that was seen, which is what its ended row says rather than that a
    /// process of its own is gone (ISS-1312).
    pub host: Option<HostEnd>,
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
    fn from_wire(by: Option<&str>) -> Self {
        match by {
            Some(HOST_PANE_STARTED) => HostEnd::PaneStarted,
            Some(HOST_PANE_GONE) => HostEnd::PaneGone,
            _ => HostEnd::ProcessGone,
        }
    }
}

impl Recovered {
    /// Why this run's release is owed, in the words its ended row keeps. A run
    /// released on the bound was not seen to end, and its row says so.
    pub fn release_reason(&self) -> &'static str {
        if self.issues_over {
            "every issue this run holds has reached a terminal status at core, so nothing \
             further will be done on any of them"
        } else if self.host == Some(HostEnd::PaneGone) {
            "the Claude Code process its subagent ran in is gone, and so is its master's pane, and \
             nothing has been heard from its subagent since; core's session row is terminal"
        } else if self.host == Some(HostEnd::PaneStarted) {
            "the Claude Code process its subagent ran in is gone and its master's pane was started \
             again, and nothing has been heard from its subagent since; core's session row is terminal"
        } else if self.host == Some(HostEnd::ProcessGone) {
            "the Claude Code process its subagent ran in is gone, and nothing has been heard from \
             its subagent since; core's session row is terminal"
        } else if self.unanswered && self.clock_alone {
            "no master on this box answers for it and core's session row has been terminal for \
             the whole bound; no readable transcript was recorded, so the clock alone decided"
        } else if self.unanswered {
            "no master on this box answers for it, core's session row is terminal, and its \
             subagent wrote nothing for the whole bound"
        } else {
            "the run's process is gone and core's session row is terminal"
        }
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "recovery verdicts, which core takes over per ADR 0009 What core takes over: Recovery verdict; deleted rather than split once core answers them (ISS-218 amnesty)"
)]
pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    procs: &dyn ProcessLiveness,
    closing: Closing<'_>,
    watch: RunWatch<'_>,
) -> Result<Vec<Recovered>> {
    end_what_no_master_can_close(ledger);
    let mut out = Vec::new();
    let mut unanswered_reads: Vec<String> = Vec::new();
    let mut ended_by_process: Vec<String> = Vec::new();
    for mut run in ledger.unclosed_runs()? {
        if run.is_parked_on_human() {
            // A read tmux did not answer observed nothing, so the park stays
            // with the master it answers to rather than moving on it (ISS-1312).
            let read = masters.state(&run.master_session_id).await;
            if read == MasterPresence::Unanswered {
                unanswered_reads.push(run.run_id.clone());
            }
            if !matches!(read, MasterPresence::Alive | MasterPresence::Unanswered) {
                if let Some(project) = run.project_id.as_deref() {
                    if let Some(parent) = masters.live_master_for_project(project).await {
                        ledger.reparent_run(&run.run_id, &parent)?;
                    }
                }
            }
            if let Some(id) = run.session_id.as_deref() {
                let _ = watch.beat.beat(id).await;
            }
            continue;
        }
        end_if_unbound(ledger, &mut run, boot_id)?;
        let pid_refuted = match run.pid {
            Some(pid) => procs.is_gone(pid).await,
            None => false,
        };
        let read = masters.state(&run.master_session_id).await;
        let dead_in_the_ledger =
            matches!(Ledger::liveness(&run, boot_id, pid_refuted), Liveness::Dead);
        let host_read = match (run.pid, run.host_pid, run.host_start.as_deref()) {
            (None, Some(pid), Some(start)) if run.boot_id == boot_id => {
                Some(procs.host(pid, start).await)
            }
            _ => None,
        };
        // A subagent runs in the Claude Code process recorded for it, and that
        // process read gone is its end, whatever the master's pane reads. It
        // goes on the row, where the run's evidence is read, and not in this
        // registry. A pane read gone is not by itself that end: the
        // conversation can run as a background session outside the pane
        // (ISS-1312, run e67c08e0).
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
                    ended_by_process.push(run.run_id.clone());
                }
            }
        }
        // The same pane read alive again says the read that marked it saw
        // nothing end, and a mark left standing reads a live pane's subagent as
        // ended (ISS-1312). A mark its process's own end wrote stays.
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
        // A read tmux could not answer observed nothing, so this sweep decides
        // as it would under the pane last seen: no end is recorded, no death is
        // reported and the keep is not dropped on a question nobody answered.
        // A pane that is really gone reads gone once tmux answers again.
        if read == MasterPresence::Unanswered {
            unanswered_reads.push(run.run_id.clone());
        }
        // A subagent's master is the process it runs in. Read alive, it is a
        // master hosted outside its pane, which is where Claude Code runs a
        // background session, and it is kept as any live master's run is. With
        // no such process read, a pane read gone licenses nothing a master this
        // box has no entry for would not: the bound decides.
        let open_subagent = run.pid.is_none() && run.ended_by.is_none();
        let master = match (read, open_subagent, host_read) {
            (MasterPresence::Unanswered, _, _) => MasterPresence::Alive,
            (MasterPresence::Gone | MasterPresence::Unknown, true, Some(HostRead::Alive)) => {
                MasterPresence::Alive
            }
            (MasterPresence::Gone, true, Some(HostRead::Gone)) => MasterPresence::Gone,
            (MasterPresence::Gone, true, _) => MasterPresence::Unknown,
            (other, _, _) => other,
        };
        let host = (run.pid.is_none()
            && matches!(
                subagent_end::of_run(&run, now_ms()),
                subagent_end::Evidence::HostEnded { .. }
            ))
        .then(|| HostEnd::from_wire(run.host_ended_by.as_deref()));
        let agent_gone = dead_in_the_ledger || master == MasterPresence::Gone || host.is_some();
        let orphaned =
            run.boot_id != boot_id || dead_in_the_ledger || master != MasterPresence::Alive;
        // A subagent run under a live master is kept, and what ends that keep
        // is its issues going over — the one fact outside the loop it is in.
        // The keep beats the run's session on every sweep, so core's row can
        // never go stale, so core never calls the session over, so the keep
        // never ends: the run is alive because this box says so and this box
        // says so because the run is alive (ISS-1245). Asked only of the
        // population the keep covers, and only where an issue could have gone
        // over since the run opened.
        let kept_subagent = !orphaned && run.agent_id.is_some() && run.pid.is_none();
        let issues_over = if kept_subagent {
            // `?` and never a default: a ledger this box cannot read is a
            // silence on our own side of the line, and an empty list here
            // reads as *not over*, which keeps the run and beats its session
            // with nothing said. That is the state this change exists to end,
            // recreated by the failure to measure it.
            let keys: Vec<String> = ledger
                .issues(&run.run_id)?
                .into_iter()
                .map(|m| m.issue_key)
                .collect();
            every_issue_over(run.project_id.as_deref(), &keys, closing.leases).await
        } else {
            IssuesOver::No
        };
        let unreadable = match &issues_over {
            IssuesOver::Unreadable(why) => Some(why.clone()),
            _ => None,
        };
        let issues_over = matches!(issues_over, IssuesOver::Yes);
        if !orphaned && !issues_over {
            // A subagent run under a live master is only ever kept here: its
            // turn-ends and its silence end nothing, because a subagent that
            // stopped may be waiting on its own work and one that finished can
            // still be resumed. Its master's close or its master's death ends
            // it, and both reach the branch below (ISS-1246).
            if kept_subagent {
                match unreadable.as_deref() {
                    Some(why) => say_issue_status_unreadable(ledger, &run, why),
                    None => say_why_kept(ledger, &run, now_ms()),
                }
                if let Some(id) = run.session_id.as_deref() {
                    let _ = watch.beat.beat(id).await;
                }
                continue;
            }
            let Some(id) = run.session_id.as_deref() else {
                continue;
            };
            if let Verdict::Exit(cause) = run_exit::verdict(watch.idle.reported(id).await, now_ms())
            {
                out.push(Recovered {
                    run_id: run.run_id.clone(),
                    project_id: run.project_id.clone(),
                    session_id: Some(id.to_string()),
                    state: close_loop::state(ledger, &run.run_id)?,
                    owed_release: false,
                    unanswered: false,
                    clock_alone: false,
                    issues_over: false,
                    standing_said: false,
                    owed_exit: Some(cause),
                    owed_death_report: false,
                    host: None,
                });
                continue;
            }
            let _ = watch.beat.beat(id).await;
            continue;
        }
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
        // A run whose release was decided terminal is NOT owed one. Its
        // checkout is staying on disk by decision, so `checkout_returned` will
        // never go true and the three marks alone would put it back on the
        // release path every sweep for ever — which is the loop that held its
        // leases in the first place (ISS-1188). The one act that puts it back
        // is an operator's `run release`.
        //
        // A master this box has no entry for is never read as gone, so on its
        // own it licenses nothing, and nothing else on the box can close a run
        // it declared: the pane that could is not here and no other project's
        // pane may. The bound is the way out, and it licenses only the
        // release, which keeps the work before the checkout goes (ISS-1220).
        let unanswered = if master == MasterPresence::Unknown {
            over_and_silent(&run, now_ms())
        } else {
            None
        };
        // `session_terminal` is NOT conjoined under the issues-over licence,
        // and that is the whole point of it: the mark can only be set by core
        // calling the session over, and the beat that would have to stop is the
        // one this licence stops. Requiring it here would make the licence
        // unreachable by construction. What guards the release instead is
        // `terminate::release`, which salvages the diff first and refuses by
        // name — naming the run, the reason and the path — where it cannot
        // (ISS-1245).
        let owed_release = (agent_gone || unanswered.is_some() || issues_over)
            && run.boot_id == boot_id
            && (state.session_terminal || issues_over)
            && !state.checkout_returned
            && run.release_terminal_at.is_none();
        // A refusal streak already standing, opened while this master still
        // read as gone before a restart emptied the registry, says its own
        // piece; announcing a release it is already retrying would be noise.
        let announce = owed_release && !agent_gone && run.release_refused_at.is_none();
        if let Some(over_ms) = unanswered.filter(|_| announce) {
            say_why_released(ledger, &run, over_ms);
        }
        let host = host.filter(|_| !dead_in_the_ledger);
        if let Some(how) = host.filter(|_| owed_release && run.release_refused_at.is_none()) {
            say_why_released_host(ledger, &run, how);
        }
        let owed_death_report = agent_gone
            && run.ended_by.is_none()
            && run.boot_id == boot_id
            && !state.session_terminal;
        let standing = if owed_release || owed_death_report || state.is_closed() {
            None
        } else if run.release_terminal_at.is_some() {
            Some(Standing::Decided)
        } else if run.boot_id != boot_id {
            Some(Standing::ForeignBoot)
        } else if master == MasterPresence::Unknown {
            Some(Standing::Unanswered)
        } else {
            // Total on purpose (ISS-1239). Every orphaned run that is not owed
            // a release, not owed a death report and not closed now has a
            // standing, so `master.rs`'s bare `partially closed` line — which
            // names no branch, no reason and no act — is never the one that
            // speaks. Before this arm the combination fell here silently and
            // that line was printed on every sweep for as long as the box
            // lived: 4,632 times over two days for one run.
            //
            // What lands here is narrow and knowable, which is what lets the
            // line name an ask rather than a guess. `agent_gone` holds over
            // this whole arm, so a run reaching it with the session still open
            // has `ended_by` set — `owed_death_report` would have taken it
            // otherwise — and one reaching it with the session over has its
            // checkout back, or `owed_release` would have.
            Some(Standing::AwaitingCore)
        };
        let standing_said =
            standing.is_some_and(|s| say_standing(ledger, &run, boot_id, &state, s));
        let session_id = run.session_id.clone();
        let clock_alone = transcript_written(&run).is_none();
        out.push(Recovered {
            run_id: run.run_id,
            project_id: run.project_id,
            session_id,
            state,
            owed_release,
            unanswered: owed_release && !agent_gone && !issues_over,
            clock_alone,
            issues_over,
            standing_said,
            owed_exit: None,
            owed_death_report,
            host: host.filter(|_| !issues_over),
        });
    }
    if let Some(line) = unanswered_line(&unanswered_reads, &ended_by_process) {
        tracing::warn!("{line}");
    }
    Ok(out)
}

/// End `run` where it is a declaration nothing has bound past
/// [`UNBOUND_BEFORE_END_SECS`], and stand it as a master's close ends one, so
/// the close loop takes it from here in this same sweep.
fn end_if_unbound(ledger: &Ledger, run: &mut Run, boot_id: &str) -> Result<()> {
    let Some(age_secs) = unbound_past_the_bound(run, boot_id, now_ms() / 1000) else {
        return Ok(());
    };
    let reason = unbound_reason(age_secs);
    ledger.end_run(&run.run_id, ENDED_BY_BOX, &reason)?;
    let keys = ledger
        .issues(&run.run_id)?
        .into_iter()
        .map(|m| m.issue_key)
        .collect::<Vec<_>>()
        .join(", ");
    tracing::warn!(
        "[recovery] run {} ({}: {keys}) under master session {} ended: {reason}",
        run.run_id,
        run.project_id.as_deref().unwrap_or("no project"),
        runner_core::ledger::short_id(&run.master_session_id)
    );
    run.incarnation = Incarnation::Exited;
    run.ended_by = Some(ENDED_BY_BOX.to_string());
    run.ended_reason = Some(reason);
    Ok(())
}

/// How long a declared run may stand bound to nothing before the box ends it
/// (ISS-1379).
///
/// A declaration is the master saying a subagent is about to start; the
/// subagent binds it with its first hook. One that is never bound holds its
/// issues' leases and its master's one unbound slot — the dispatch gate
/// refuses that master every further declaration while it stands — and before
/// this rule nothing but that master's own close ever ended it. Measured over
/// 781 bound runs on the fleet, declaration to first transcript entry took 51s
/// at the median, 399s at p99 and 3,037s at the longest, so an hour is past
/// every binding this box has seen.
pub(crate) const UNBOUND_BEFORE_END_SECS: i64 = 60 * 60;

/// Who a run ended by [`UNBOUND_BEFORE_END_SECS`] says ended it.
pub(crate) const ENDED_BY_BOX: &str = "box";

/// How old `run` is, where it is a declaration of this boot that nothing has
/// bound for the whole bound. A run of another boot is not this rule's: its
/// process could not have bound it here, and the boot rules already own it.
fn unbound_past_the_bound(run: &Run, boot_id: &str, now_secs: i64) -> Option<i64> {
    let age = now_secs - run.created_at;
    (run.agent_id.is_none()
        && run.pid.is_none()
        && run.ended_by.is_none()
        && run.boot_id == boot_id
        && age >= UNBOUND_BEFORE_END_SECS)
        .then_some(age)
}

fn unbound_reason(age_secs: i64) -> String {
    format!(
        "declared {}m ago and never bound to a subagent or a process, past the {}m within which a declared run binds, so the box ended it; its session and its leases go back by the close loop, and its issues can be declared again",
        age_secs / 60,
        UNBOUND_BEFORE_END_SECS / 60
    )
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

/// Whether EVERY issue this run holds has reached a terminal status.
///
/// Every, not any: a run holding one issue that is over and one that is not is
/// still working, and closing it would take the live one's checkout with it. A
/// run holding no issues at all answers `false` — it is not a run whose issues
/// went over, it is a run there is nothing to conclude from — and an issue the
/// keeper cannot answer for answers `false` the same way, because *not known to
/// be over* is not *over* and a guess here closes a run somebody is using
/// (ISS-1245).
/// Measures and says nothing. Both populations it separates are already
/// reported by a LATCHED line, and `kept_notice` holds one notice per run, so
/// a second writer on the same sweep would reset the first and make both
/// repeat for ever: a run released on this sweep is named by
/// [`release_reason`], and one measured over but released anyway never —
/// its checkout already back — by the standing line (ISS-1245 F1).
/// `keys` is read off the ledger BEFORE this is called and the handle is not
/// held across the awaits below: `Ledger` wraps a `rusqlite` connection, which
/// is not `Sync`, so a future holding `&Ledger` over an await is not `Send` and
/// the daemon's own `tokio::spawn` refuses it.
async fn every_issue_over(
    project_id: Option<&str>,
    keys: &[String],
    leases: &dyn LeaseKeeper,
) -> IssuesOver {
    if keys.is_empty() {
        return IssuesOver::No;
    }
    for key in keys {
        match leases.issue_is_over(project_id, key).await {
            Ok(Some(true)) => {}
            Ok(_) => return IssuesOver::No,
            // A core that answered `not over` and a core that could not be
            // asked both leave the run kept, and only one of them is a fact.
            // Read the same way, the second is a measurement that did not
            // happen wearing the shape of one that did (ISS-1245 F2).
            Err(e) => {
                return IssuesOver::Unreadable(format!(
                    "the status of {key} could not be read from core ({e})"
                ))
            }
        }
    }
    IssuesOver::Yes
}

/// What the sweep could establish about the issues one kept run holds.
enum IssuesOver {
    /// Every one of them is over at core.
    Yes,
    /// At least one is not, which core answered for.
    No,
    /// Core could not be asked, which is not the same answer and is said once.
    Unreadable(String),
}

/// How long a run no master on this box answers for may stand with its session
/// over at core, and its subagent silent, before it is released.
///
/// A registry miss is not a pane that ended: a daemon restart empties the
/// registry until adoption refills it, and a project that left `/me/runners`
/// is never re-adopted while its pane may still run (c41f9e7a3). So the miss
/// alone licenses nothing, and an hour is the price of waiting it out: the
/// same hour `run_exit` already reads as a silent run being over. What it
/// costs the other way is bounded by what the release does — a subagent still
/// working in a pane this box cannot see, past an hour of both silences, has
/// its branch published, its commits named by a ref and an unsaved diff
/// salvaged or refused, never dropped. Its leases were already back: the close
/// loop returns them for every orphaned run. The trade ends when this box keeps
/// a durable record of the master sessions it ended, so a miss can be told
/// apart from an ending and positive evidence replaces the clock.
pub const UNANSWERED_RELEASE_AFTER: std::time::Duration = subagent_end::SUBAGENT_QUIET;

/// How long `run`'s session has been over at core, where that is at least
/// [`UNANSWERED_RELEASE_AFTER`] and its subagent's own transcript was not
/// written inside the same window. `None` otherwise.
///
/// The session is read off the stamp an earlier sweep wrote, never this
/// sweep's: the sweep that first sees it over starts the clock. An unreadable
/// transcript is no evidence either way, so only the session's clock decides.
fn over_and_silent(run: &Run, now_ms: i64) -> Option<i64> {
    let bound = UNANSWERED_RELEASE_AFTER.as_millis() as i64;
    let over_ms = now_ms.saturating_sub(run.session_terminal_at?.saturating_mul(1000));
    if over_ms < bound {
        return None;
    }
    if transcript_written(run).is_some_and(|w| now_ms.saturating_sub(w) < bound) {
        return None;
    }
    Some(over_ms)
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
