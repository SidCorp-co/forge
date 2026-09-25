/*
 * Giving back a run session the box is still recorded as holding.
 *
 * A run outlives the master that started it: the ledger row is written before
 * anything spawns, so a master that dies mid-run leaves marks nobody will set.
 * This is the local half — fast, and blind to the box's own death. The half
 * that survives losing power lives at core, keyed on the heartbeat.
 */

use crate::daemon::agent_activity::now_ms;
use crate::daemon::run_exit::{self, Reported, Verdict};
use crate::daemon::{subagent_end, transcript_age};
use crate::error::Result;
use crate::runner::close_loop::{self, CloseState, LeaseKeeper, SessionReader};
use crate::runner::ledger::{Ledger, Liveness, Run};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MasterPresence {
    /// The registry named a pane and tmux answered for it.
    Alive,
    /// The registry named a pane and tmux has no such pane — a positive observation.
    Gone,
    /// This box has no entry for that master, which is not the same as it being over.
    Unknown,
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
    /// Recovery has said, once, why this run still stands and what ends it,
    /// so a per-sweep line about it would only repeat that (ISS-1220).
    pub standing_said: bool,
    /// The box may end this run itself, for the cause named.
    pub owed_exit: Option<run_exit::ExitCause>,
    pub owed_death_report: bool,
}

impl Recovered {
    /// Why this run's release is owed, in the words its ended row keeps. A run
    /// released on the bound was not seen to end, and its row says so.
    pub fn release_reason(&self) -> &'static str {
        if self.unanswered && self.clock_alone {
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

pub async fn reconcile(
    ledger: &mut Ledger,
    boot_id: &str,
    masters: &dyn MasterLiveness,
    procs: &dyn ProcessLiveness,
    closing: Closing<'_>,
    watch: RunWatch<'_>,
) -> Result<Vec<Recovered>> {
    let mut out = Vec::new();
    for run in ledger.unclosed_runs()? {
        if run.is_parked_on_human() {
            if masters.state(&run.master_session_id).await != MasterPresence::Alive {
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
        let pid_refuted = match run.pid {
            Some(pid) => procs.is_gone(pid).await,
            None => false,
        };
        let master = masters.state(&run.master_session_id).await;
        let dead_in_the_ledger =
            matches!(Ledger::liveness(&run, boot_id, pid_refuted), Liveness::Dead);
        let agent_gone = dead_in_the_ledger || master == MasterPresence::Gone;
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
            let keys: Vec<String> = ledger
                .issues(&run.run_id)
                .unwrap_or_default()
                .into_iter()
                .map(|m| m.issue_key)
                .collect();
            every_issue_over(
                &run.run_id,
                run.project_id.as_deref(),
                &keys,
                closing.leases,
            )
            .await
        } else {
            false
        };
        if !orphaned && !issues_over {
            // A subagent run under a live master is only ever kept here: its
            // turn-ends and its silence end nothing, because a subagent that
            // stopped may be waiting on its own work and one that finished can
            // still be resumed. Its master's close or its master's death ends
            // it, and both reach the branch below (ISS-1246).
            if kept_subagent {
                say_why_kept(ledger, &run, now_ms());
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
                    standing_said: false,
                    owed_exit: Some(cause),
                    owed_death_report: false,
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
            Some(Standing::OverAtTheBox)
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
            unanswered: owed_release && !agent_gone,
            clock_alone,
            standing_said,
            owed_exit: None,
            owed_death_report,
        });
    }
    Ok(out)
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
/// `keys` is read off the ledger BEFORE this is called and the handle is not
/// held across the awaits below: `Ledger` wraps a `rusqlite` connection, which
/// is not `Sync`, so a future holding `&Ledger` over an await is not `Send` and
/// the daemon's own `tokio::spawn` refuses it.
async fn every_issue_over(
    run_id: &str,
    project_id: Option<&str>,
    keys: &[String],
    leases: &dyn LeaseKeeper,
) -> bool {
    if keys.is_empty() {
        return false;
    }
    for key in keys {
        match leases.issue_is_over(project_id, key).await {
            Ok(Some(true)) => {}
            _ => return false,
        }
    }
    tracing::info!(
        "[recovery] run {run_id}: every issue it holds ({}) is over at core, so the keep its live \
         master gives it ends here — its leases go back and its checkout is asked for (ISS-1245)",
        keys.join(", ")
    );
    true
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

/// Say, on the sweep that first owes it, why a run nobody here answers for is
/// being released and what it holds. Said once, on the row as well as in the
/// journal: a release that cannot even start — a project with no repo path on
/// this box — is owed again every sweep, and the reason it is owed is not news
/// the second time.
fn say_why_released(ledger: &Ledger, run: &Run, over_ms: i64) {
    match ledger.note_standing(&run.run_id, "unanswered") {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it is being released: {e}",
                run.run_id
            );
            return;
        }
    }
    let issues = ledger
        .issues(&run.run_id)
        .map(|m| {
            m.iter()
                .map(|i| i.issue_key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    // What the silence rests on, said as it is: a transcript nobody could read
    // decided nothing, and the line must not read as if it had.
    let silence = silence_evidence(run);
    tracing::warn!(
        "[recovery] run {} ({issues}): no master on this box answers for it (it answered to {}), \
         core has called its session over for {}m and {silence} — releasing {} now. Its commits \
         are kept before the checkout goes; a release that refuses says why next, and is decided \
         after {}s",
        run.run_id,
        run.master_session_id,
        over_ms / 60_000,
        run.worktree_path.display(),
        crate::runner::terminate::RELEASE_GRACE_SECS
    );
}

/// Why an orphaned run nothing can close this sweep is still standing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Standing {
    /// No master here answers for it and nothing on this sweep can close it:
    /// its session still open at core, its bound not yet run out, or only its
    /// leases left to be taken back.
    Unanswered,
    /// Declared under another boot, which nothing on this one may reclaim.
    ForeignBoot,
    /// Its release was decided terminal and its checkout stays by decision;
    /// only its leases are still being chased.
    Decided,
    /// This box has nothing left to do for it. What is outstanding is a mark
    /// somebody else sets — core calling its session over, or a lease core has
    /// not yet handed back — and no sweep here will move either.
    OverAtTheBox,
}

/// Say once, in the journal and on the row, why this run stands and what ends
/// it. Answers whether it has been said, now or on an earlier sweep, so the
/// sweep's own per-sweep line can stand down; a notice that could not be
/// recorded answers `false` and leaves that line to speak.
fn say_standing(
    ledger: &Ledger,
    run: &Run,
    boot_id: &str,
    state: &CloseState,
    standing: Standing,
) -> bool {
    let notice = match standing {
        Standing::Unanswered if !state.session_terminal => "awaiting-session",
        Standing::Unanswered if !state.checkout_returned => "awaiting",
        Standing::Unanswered => "awaiting-leases",
        Standing::ForeignBoot => "foreign-boot",
        Standing::Decided => "decided",
        Standing::OverAtTheBox if !state.session_terminal => "over-awaiting-session",
        Standing::OverAtTheBox => "over-awaiting-leases",
    };
    match ledger.note_standing(&run.run_id, notice) {
        Ok(false) => return true,
        Ok(true) => {}
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it stands: {e}",
                run.run_id
            );
            return false;
        }
    }
    let issues = ledger
        .issues(&run.run_id)
        .map(|m| {
            m.iter()
                .map(|i| i.issue_key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let holds = format!(
        "session_terminal={} checkout_returned={} leases={}/{}",
        state.session_terminal, state.checkout_returned, state.leases_returned, state.leases_total
    );
    match standing {
        Standing::Unanswered => {
            let what_ends_it = if !state.session_terminal {
                format!(
                    "core still holds its session open, and the bound of {}m starts when core \
                     calls it over",
                    UNANSWERED_RELEASE_AFTER.as_secs() / 60
                )
            } else if !state.checkout_returned {
                format!(
                    "its checkout {} is released once core has called its session over for {}m \
                     ({}, now)",
                    run.worktree_path.display(),
                    UNANSWERED_RELEASE_AFTER.as_secs() / 60,
                    silence_evidence(run)
                )
            } else {
                format!(
                    "its checkout is back and only its leases ({}/{} returned) are still being \
                     asked back",
                    state.leases_returned, state.leases_total
                )
            };
            tracing::warn!(
                "[recovery] run {} ({issues}) is partially closed ({holds}): no master on this box \
                 answers for it (it answered to {}), so {what_ends_it}. Said once; what ends it \
                 says itself when it comes",
                run.run_id,
                run.master_session_id
            )
        }
        Standing::ForeignBoot => {
            let left = if state.checkout_returned {
                format!(
                    "Its checkout is back, {}/{} of its leases are back and the rest stay held",
                    state.leases_returned, state.leases_total
                )
            } else {
                format!("Its checkout {} is still held", run.worktree_path.display())
            };
            tracing::error!(
                "[recovery] run {} ({issues}) is partially closed ({holds}) and will stay so: it \
                 was declared under boot {} and this box is boot {}, and a run from another boot \
                 is never reclaimed here, because its process and its pane cannot be read from \
                 this one. {left}. Said once, not every sweep",
                run.run_id,
                run.boot_id,
                boot_id
            )
        }
        Standing::Decided => {
            tracing::warn!(
            "[recovery] run {} ({issues}) is partially closed ({holds}): its release was decided \
             terminal ({}), so its checkout {} stays on disk by decision and only its leases are \
             still being asked back. `forge-runner run release {}` has the next sweep try the \
             release again. Said once, not every sweep",
            run.run_id,
            run.release_refusal.as_deref().unwrap_or("no refusal was recorded"),
            run.worktree_path.display(),
            run.run_id
        )
        }
        Standing::OverAtTheBox => {
            // The two marks this box cannot set itself, said apart: a session
            // core still holds open and a lease core has not handed back are
            // different facts and a line covering both names no act (ISS-1239).
            let what_ends_it = if !state.session_terminal {
                format!(
                    "core's session row for {} is still open, and nothing on this box sets that \
                     mark — it ends when core calls the session over",
                    run.session_id.as_deref().unwrap_or("this run"),
                )
            } else {
                format!(
                    "its checkout is back and {}/{} of its leases are; the rest end when core \
                     hands them back",
                    state.leases_returned, state.leases_total
                )
            };
            tracing::warn!(
                "[recovery] run {} ({issues}) is partially closed ({holds}): this box has nothing \
                 left to do for it — {what_ends_it}. `forge-runner run release {}` is the act that \
                 takes it up again. Said once, not every sweep",
                run.run_id,
                run.run_id
            )
        }
    }
    true
}

/// Say once, in the journal and on the row, why a subagent run that looks
/// finished or cannot be read is still being kept, and what ends it.
fn say_why_kept(ledger: &mut Ledger, run: &Run, now: i64) {
    let path = run.agent_transcript.as_deref();
    let written = path.and_then(|p| transcript_age::written_at(Path::new(p)));
    let evidence = subagent_end::read(run.turn_ended_at_ms, written, now);
    let Some(notice) = subagent_end::notice(evidence) else {
        return;
    };
    match ledger.note_kept(&run.run_id, notice) {
        Ok(true) => {}
        Ok(false) => return,
        Err(e) => {
            tracing::warn!(
                "[recovery] run {}: cannot record why it is kept: {e}",
                run.run_id
            );
            return;
        }
    }
    let issues = ledger
        .issues(&run.run_id)
        .map(|m| {
            m.iter()
                .map(|i| i.issue_key.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default();
    let observed = match evidence {
        subagent_end::Evidence::Quiet { silent_ms } => format!(
            "its subagent ended a turn {}m ago and has written nothing since",
            silent_ms / 60_000
        ),
        _ => format!(
            "its subagent ended a turn and this box cannot read its transcript ({}), so it cannot tell whether it resumed",
            path.unwrap_or("no path was recorded")
        ),
    };
    tracing::warn!(
        "[recovery] run {} ({issues}): {observed}. Its tree and leases are kept, because a finished subagent can still be resumed. Once it will not be, `forge-runner run close {}` gives them back",
        run.run_id,
        run.run_id
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runner::ledger::NewRun;
    use std::collections::HashSet;
    use std::path::PathBuf;
    use std::sync::Mutex;

    const SOURCE: &str = include_str!("recovery.rs");

    /// Masters this box has a registry entry for: in the set is up, out of it is positively gone.
    struct Masters(HashSet<String>);
    #[async_trait::async_trait]
    impl MasterLiveness for Masters {
        async fn state(&self, master_session_id: &str) -> MasterPresence {
            if self.0.contains(master_session_id) {
                MasterPresence::Alive
            } else {
                MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    /// A box that has never heard of this master — a restarted daemon, or a project that has left
    /// `/me/runners` and is therefore never re-adopted into the registry.
    struct NoRegistryEntry;
    #[async_trait::async_trait]
    impl MasterLiveness for NoRegistryEntry {
        async fn state(&self, _: &str) -> MasterPresence {
            MasterPresence::Unknown
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct Respawned(&'static str);
    #[async_trait::async_trait]
    impl MasterLiveness for Respawned {
        async fn state(&self, master_session_id: &str) -> MasterPresence {
            if master_session_id == self.0 {
                MasterPresence::Alive
            } else {
                MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            Some(self.0.to_string())
        }
    }

    struct Sessions;
    #[async_trait::async_trait]
    impl SessionReader for Sessions {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(true)
        }
    }

    /// Core's row still says the session is running, which is what a master that just died leaves.
    struct SessionCoreStillHolds;
    #[async_trait::async_trait]
    impl SessionReader for SessionCoreStillHolds {
        async fn is_terminal(&self, _: &str) -> Result<bool> {
            Ok(false)
        }
    }

    struct Leases(Mutex<HashSet<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, _project_id: Option<&str>, issue_key: &str) -> Result<()> {
            self.0.lock().unwrap().insert(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, _project_id: Option<&str>, issue_key: &str) -> Result<bool> {
            Ok(self.0.lock().unwrap().contains(issue_key))
        }
    }

    struct Gone(HashSet<u32>);
    #[async_trait::async_trait]
    impl ProcessLiveness for Gone {
        async fn is_gone(&self, pid: u32) -> bool {
            self.0.contains(&pid)
        }
    }

    fn nothing_refuted() -> Gone {
        Gone(HashSet::new())
    }

    #[derive(Default)]
    struct Beats(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl Heartbeat for Beats {
        async fn beat(&self, session_id: &str) -> Result<()> {
            self.0.lock().unwrap().push(session_id.to_string());
            Ok(())
        }
    }

    struct NeverReports;
    #[async_trait::async_trait]
    impl RunActivity for NeverReports {
        async fn reported(&self, _: &str) -> Option<Reported> {
            None
        }
    }

    struct Reports(Reported);
    #[async_trait::async_trait]
    impl RunActivity for Reports {
        async fn reported(&self, _: &str) -> Option<Reported> {
            Some(self.0)
        }
    }

    fn finished_long_ago() -> Reports {
        Reports(Reported {
            doing: crate::daemon::agent_activity::Doing::Idle,
            at: now_ms() - run_exit::RUN_IDLE_BEFORE_EXIT.as_millis() as i64 - 1,
            written_at: None,
        })
    }

    /// A repository whose registry answers. Every test here asks it the same
    /// read-only question — *do you register a worktree at this path?* — so one
    /// serves them all.
    ///
    /// One per test rather than one per process: a process-wide fixture has no drop, so it would
    /// outlive the run. libtest gives every test a thread of its own, and this goes with it.
    fn a_repository() -> PathBuf {
        thread_local! {
            static REPO: crate::test_scratch::Scratch = {
                let root = crate::test_scratch::Scratch::new("recovery-repo");
                let _ = std::process::Command::new("git")
                    .args(["init", "-q", "-b", "main"])
                    .current_dir(&root)
                    .output();
                root
            };
        }
        REPO.with(|r| r.to_path_buf())
    }

    struct Roots;
    impl RepoRoots for Roots {
        fn root_for(&self, _project_id: &str) -> Option<PathBuf> {
            Some(a_repository())
        }
    }

    fn gone() -> PathBuf {
        PathBuf::from("/tmp/forge-recovery-absent-by-construction")
    }

    fn seeded(run_id: &str, master: &str, boot: &str, issues: &[&str]) -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: run_id.into(),
            project_id: "proj-1".into(),
            master_session_id: master.into(),
            worktree_path: gone(),
            boot_id: boot.into(),
            issue_keys: issues.iter().map(|s| (*s).to_string()).collect(),
        })
        .unwrap();
        led.attach_session(run_id, "core-sess-1").unwrap();
        led
    }

    /// A ledger whose run points at a worktree that is REALLY on the disk, and
    /// whose pid is recorded — the shape every stuck run on the fleet has.
    fn seeded_holding_a_tree(pid: u32, boot: &str) -> (Ledger, crate::test_scratch::Scratch) {
        let wt = crate::test_scratch::Scratch::new("recovery-held");
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.to_path_buf(),
            boot_id: boot.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", pid).unwrap();
        (led, wt)
    }

    async fn reconcile_held(
        pid: u32,
        refuted: &[u32],
        boot: &str,
        this_boot: &str,
    ) -> Vec<Recovered> {
        let (mut led, wt) = seeded_holding_a_tree(pid, boot);
        let done = reconcile(
            &mut led,
            this_boot,
            &Masters(HashSet::new()),
            &Gone(refuted.iter().copied().collect()),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        done
    }

    #[tokio::test]
    async fn a_run_whose_release_was_given_up_on_is_never_handed_back_to_it() {
        let (mut led, wt) = seeded_holding_a_tree(424_242, "boot-a");
        led.note_release_refusal(
            "run-1",
            "the diff in the checkout was not preserved",
            1_790_000_000,
        )
        .unwrap();
        led.conclude_release_refusal(
            "run-1",
            1_790_000_300,
            "recovery",
            "the diff in the checkout was not preserved",
        )
        .unwrap();

        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Gone([424_242].into_iter().collect()),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);

        assert_eq!(
            done.len(),
            1,
            "the run is still read, so its leases keep being chased"
        );
        assert!(
            !done[0].owed_release,
            "its checkout is staying on disk by decision, so the three marks alone would put it \
             back on the release path every sweep for ever — which is the loop that held its \
             leases in the first place"
        );
    }

    #[tokio::test]
    async fn a_dead_run_still_holding_its_tree_is_owed_a_release() {
        let done = reconcile_held(424_242, &[424_242], "boot-a", "boot-a").await;
        assert_eq!(done.len(), 1);
        assert!(
            !done[0].state.is_closed() && done[0].state.session_terminal,
            "the state under test is terminal-but-holding, got {:?}",
            done[0].state
        );
        assert!(
            done[0].owed_release,
            "a run whose own pid is refuted, whose session core calls terminal, and whose worktree is still on the disk is in the one state that cannot resolve itself"
        );
        assert_eq!(
            done[0].project_id.as_deref(),
            Some("proj-1"),
            "the release needs the project to resolve a repo path"
        );
    }

    #[tokio::test]
    async fn a_run_whose_master_is_gone_is_owed_its_release_whatever_its_pid_says() {
        let done = reconcile_held(424_243, &[], "boot-a", "boot-a").await;
        assert_eq!(
            done.len(),
            1,
            "a dead master still leaves the run to recovery"
        );
        assert!(
            done[0].owed_release,
            "a run whose master's session is gone has no agent — a subagent runs inside that process and cannot outlive it — so the release it is owed may not wait on a pid nothing writes"
        );
    }

    #[tokio::test]
    async fn a_finished_run_under_a_live_master_is_still_owed_its_checkout_back() {
        let (mut led, wt) = seeded_holding_a_tree(0, "boot-a");
        led.end_run("run-1", "master", "its master closed it")
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            // the fixture's master, named ALIVE here on purpose: the master term must answer
            // `Alive` so that only the ledger half of `agent_gone` can carry this case
            &Masters(HashSet::from(["master-dead".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        assert_eq!(done.len(), 1, "a finished run is reconciled");
        assert!(
            done[0].owed_release,
            "the run is over and core agrees its session is; nothing else will ever take this checkout back"
        );
    }

    #[tokio::test]
    async fn a_run_that_ended_itself_is_never_reported_as_one_that_died() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        led.end_run("run-1", "subagent", "the subagent finished")
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "an ended run is still reconciled");
        assert!(
            !done[0].owed_death_report,
            "this run said it was finished; a core that would not take the close is a reason to try the close again, never a reason to call it a death"
        );
    }

    #[tokio::test]
    async fn a_master_this_box_has_no_record_of_is_not_read_as_a_master_that_ended() {
        let mut led = seeded("run-1", "master-unknown", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &NoRegistryEntry,
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "an unknown master still leaves the run to recovery, as it did before this change"
        );
        assert!(
            !done[0].owed_death_report,
            "this box has no record of that master — saying the run died would be an absence reported as a fact"
        );
        assert!(
            !done[0].owed_release,
            "and it may certainly not license removing a checkout a live subagent may be writing into"
        );
    }

    #[tokio::test]
    async fn a_run_with_no_pid_at_all_whose_master_died_is_reported_dead_rather_than_waited_out() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "a run whose master died is recovered");
        assert!(
            done[0].owed_death_report,
            "core is told this run died by the box; waiting for the ten-minute silence is what this pass exists to replace"
        );
    }

    #[tokio::test]
    async fn a_run_from_a_previous_boot_is_owed_no_release() {
        let done = reconcile_held(424_244, &[424_244], "boot-old", "boot-new").await;
        assert_eq!(done.len(), 1);
        assert!(
            !done[0].owed_release,
            "the pid is from another boot — reclaiming on it is reclaiming on a claim nobody checked"
        );
    }

    #[tokio::test]
    async fn a_park_is_never_owed_a_release() {
        let (mut led, wt) = seeded_holding_a_tree(424_245, "boot-a");
        led.declare_parked_human("run-1", Some("resume-1"), None)
            .unwrap();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &Gone(HashSet::from([424_245])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let _ = std::fs::remove_dir_all(&wt);
        assert!(
            done.is_empty(),
            "a park satisfies both orphan premises by design — recovery must not even report it, let alone owe its tree back"
        );
    }

    #[tokio::test]
    async fn a_master_that_died_mid_run_has_its_run_closed_from_the_ledger() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957", "ISS-958"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a master that died WITHIN this boot leaves a run nothing else will close — recovery keyed only on a reboot never fires for the failure it exists to repair (ISS-933 criterion 16)"
        );
        assert!(
            done[0].state.is_closed(),
            "all three marks must reach their terminal value, got {:?} (ISS-933 criterion 16)",
            done[0].state
        );
    }

    #[tokio::test]
    async fn a_run_left_by_a_previous_boot_is_recovered_too() {
        let mut led = seeded("run-1", "master-old", "boot-old", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-new",
            &Masters(HashSet::from(["master-old".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a run recorded under a boot id that is not this one cannot have a live master however the liveness port answers — a pid or a pane name from a previous boot may belong to something else entirely (ISS-933 criterion 16)"
        );
        assert!(done[0].state.is_closed());
    }

    #[tokio::test]
    async fn a_run_whose_master_is_still_there_is_left_alone() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "recovery that closes a LIVE master's run takes work away mid-decision — the failure `master-reaper.ts` names in its own timeout guard (ISS-933 criterion 16); recovered {done:?}"
        );
        assert_eq!(close_loop::state(&led, "run-1").unwrap().leases_returned, 0);
    }

    #[tokio::test]
    async fn recovering_twice_returns_no_lease_twice() {
        let mut led = seeded("run-1", "master-dead", "boot-a", &["ISS-957"]);
        let leases = Leases(Mutex::new(HashSet::new()));
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &leases,
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let again = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &leases,
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            again.is_empty(),
            "a run whose loop is closed is no longer unclosed, so a second sweep must find nothing to do (ISS-933 criterion 16); found {again:?}"
        );
    }

    #[tokio::test]
    async fn a_live_run_is_beaten_in_the_same_sweep_that_would_have_closed_it() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a sweep that leaves a live run alone but never tells core so has handed that run to core's ten-minute reaper — the beat and the recovery are one pass precisely so this cannot be built apart (ISS-933 criteria 16 and 25a)"
        );
    }

    #[tokio::test]
    async fn a_run_that_reported_itself_finished_is_named_and_not_beaten() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &finished_long_ago(),
            },
        )
        .await
        .unwrap();
        assert!(
            beats.0.lock().unwrap().is_empty(),
            "a finished run that is still beaten is held out of core's reaper by this box forever — 32 panes on forge-vm 2026-09-12, the oldest 22 hours; beats were {:?}",
            beats.0.lock().unwrap()
        );
        assert_eq!(
            done.iter()
                .filter(|r| r.owed_exit == Some(run_exit::ExitCause::Idle))
                .count(),
            1,
            "stopping the beat without naming the run leaves its process up with nothing on the box able to end it; got {done:?}"
        );
    }

    #[tokio::test]
    async fn a_run_whose_end_was_lost_is_named_for_the_silence_and_not_for_idleness() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let silent_since = now_ms() - run_exit::RUN_SILENT_BEFORE_EXIT.as_millis() as i64 - 1;
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &Reports(Reported {
                    doing: crate::daemon::agent_activity::Doing::Working,
                    at: silent_since,
                    written_at: Some(silent_since),
                }),
            },
        )
        .await
        .unwrap();
        assert!(beats.0.lock().unwrap().is_empty());
        assert_eq!(
            done.iter().map(|r| r.owed_exit).collect::<Vec<_>>(),
            vec![Some(run_exit::ExitCause::LeadSilent)],
            "what the box tells core must be the evidence that ended the run, not a claim it went idle"
        );
    }

    #[tokio::test]
    async fn a_run_that_has_reported_nothing_is_beaten_like_any_other() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
        assert!(
            !done.iter().any(|r| r.owed_exit.is_some()),
            "silence is not idleness; got {done:?}"
        );
    }

    #[test]
    fn reconcile_takes_no_session_id_from_its_caller() {
        let sig = SOURCE
            .split("pub async fn reconcile(")
            .nth(1)
            .and_then(|rest| rest.split(')').next())
            .unwrap_or_default();
        assert!(
            !sig.contains("session_id") && !sig.contains("agent_session"),
            "recovery must read the run's session from the LEDGER, not from a caller — a caller that could name it is a caller that could name the wrong one, and the ledger is the only thing that survives the master that knew it (ISS-933 criterion 16); signature was: {sig}"
        );
    }
    fn parked(run_id: &str, master: &str, boot: &str) -> Ledger {
        let mut led = seeded(run_id, master, boot, &["ISS-964"]);
        led.begin_question("q-1", run_id, 1, "q-1").unwrap();
        led.declare_parked_human(run_id, Some("resume-1"), None)
            .unwrap();
        led
    }

    #[tokio::test]
    async fn a_park_is_not_closed_because_its_master_died() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a park whose master is gone is waiting, not abandoned — closing it throws away the answer somebody is about to give"
        );
        let run = led.run("run-1").unwrap().unwrap();
        assert!(run.ended_by.is_none(), "the run must still be open");
        assert_eq!(run.resume_id.as_deref(), Some("resume-1"));
    }

    #[tokio::test]
    async fn a_park_survives_the_box_rebooting_under_it() {
        let mut led = parked("run-1", "master-dead", "boot-before");
        let done = reconcile(
            &mut led,
            "boot-after",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(done.is_empty(), "a reboot is not an abandonment of a park");
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
    }

    #[tokio::test]
    async fn a_park_whose_master_respawned_is_reparented_onto_it() {
        let mut led = parked("run-1", "master-old", "boot-a");
        reconcile(
            &mut led,
            "boot-a",
            &Respawned("master-new"),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(
            run.master_session_id, "master-new",
            "the new master must be able to find this run: `runs_for_master` is what `master_exit::children` reads, so a stale parent leaves the master free to exit over a live park"
        );
    }

    #[tokio::test]
    async fn a_park_keeps_beating_so_cores_reaper_leaves_it_alone() {
        let mut led = parked("run-1", "master-dead", "boot-a");
        let beats = Beats::default();
        reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a park the box is preserving must go on asserting that the box holds it"
        );
    }

    fn with_pid(run_id: &str, master: &str, boot: &str, pid: u32) -> Ledger {
        let led = seeded(run_id, master, boot, &["ISS-957"]);
        led.attach_pid(run_id, pid).unwrap();
        led
    }

    #[tokio::test]
    async fn a_run_whose_own_process_is_gone_is_closed_under_a_master_that_lives() {
        let mut led = with_pid("run-1", "master-live", "boot-a", 4242);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([4242])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "a run whose pane died while its master lived is closed by nothing else on this box, and it goes on beating — core's reaper never fires and every lease it holds stays held by derivation, which is a pool that reads empty with nothing running"
        );
        assert!(done[0].state.is_closed());
        assert!(
            beats.0.lock().unwrap().is_empty(),
            "a run being given back must not also be asserted as held in the same sweep"
        );
    }

    #[tokio::test]
    async fn a_run_whose_process_answers_is_beaten_and_left_alone() {
        let mut led = with_pid("run-1", "master-live", "boot-a", 4242);
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a pid the kernel still answers for is a live agent, and closing its loop takes the worktree out from under it mid-write; recovered {done:?}"
        );
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
    }

    #[tokio::test]
    async fn a_run_that_has_not_recorded_a_pid_yet_is_left_to_finish_starting() {
        let mut led = seeded("run-1", "master-live", "boot-a", &["ISS-957"]);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([0, 1])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a run with no pid has not started, not died — the ledger row is written BEFORE anything spawns, so this window is a normal one; recovered {done:?}"
        );
    }

    #[tokio::test]
    async fn a_park_is_not_closed_by_the_pid_term_that_every_park_satisfies() {
        let mut led = parked("run-1", "master-live", "boot-a");
        led.attach_pid("run-1", 4242).unwrap();
        let beats = Beats::default();
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::from(["master-live".to_string()])),
            &Gone(HashSet::from([4242])),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(
            done.is_empty(),
            "a park releases its process by design, so a liveness term that reaped it would destroy every question a human has been asked; recovered {done:?}"
        );
        assert_eq!(beats.0.lock().unwrap().as_slice(), ["core-sess-1"]);
        assert!(led.run("run-1").unwrap().unwrap().ended_by.is_none());
    }

    #[tokio::test]
    async fn a_live_pid_does_not_save_a_run_from_a_dead_master_or_a_foreign_boot() {
        let mut led = with_pid("run-1", "master-dead", "boot-a", 4242);
        let done = reconcile(
            &mut led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(done.len(), 1, "the master term must still fire on its own");

        let mut old = with_pid("run-2", "master-live", "boot-old", 4243);
        let done = reconcile(
            &mut old,
            "boot-new",
            &Masters(HashSet::from(["master-live".to_string()])),
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            done.len(),
            1,
            "the boot term must still fire on its own: a pid recorded before a reboot names whatever the kernel has since handed it to, so an answer of `alive` about it is an answer about a stranger"
        );
    }

    // ISS-1246: a subagent run under a live master. Its turn-ends and its
    // silence end nothing; only its master's close or its master's death does.

    const MASTER: &str = "master-live";
    const MIN_MS: i64 = 60_000;

    /// A directory of this test's own, removed when it drops.
    struct Scratch(crate::test_scratch::Scratch);

    impl Scratch {
        fn new(what: &str) -> Self {
            Self(crate::test_scratch::Scratch::new(&format!(
                "recovery-{what}"
            )))
        }
    }

    /// Write the subagent's transcript and stamp its last write at `at_ms`.
    fn transcript_written_at(path: &Path, at_ms: i64) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "{}\n").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at_ms as u64))
            .unwrap();
    }

    /// A bound subagent run whose tree is really on the disk, as the incident
    /// runs were, with its transcript under `scratch`.
    fn a_subagent_run(scratch: &Scratch) -> (Ledger, PathBuf, PathBuf) {
        let wt = scratch.0.join("tree");
        std::fs::create_dir_all(&wt).unwrap();
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: MASTER.into(),
            worktree_path: wt.clone(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1135".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        assert!(led.bind_agent("run-1", "a13e68aaf656d6502").unwrap());
        let lead = scratch.0.join("conv.jsonl");
        let transcript =
            crate::daemon::transcript_age::child_transcript(&lead, "a13e68aaf656d6502").unwrap();
        (led, wt, transcript)
    }

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(std::process::Stdio::null())
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    /// A repository with a remote, and the subagent's checkout a real git
    /// worktree of it with its branch pushed, as the incident trees were. The
    /// ISS-1217 tree kept its directory and lost its `.git/worktrees` entry, so
    /// a plain directory cannot show the harm.
    fn a_subagent_run_in_a_worktree(scratch: &Scratch) -> (Ledger, PathBuf, PathBuf, PathBuf) {
        let root = scratch.0.join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "user.email", "t@t"]);
        git(&root, &["config", "user.name", "t"]);
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-q", "-m", "base"]);
        let remote = scratch.0.join("remote.git");
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "-q", "--bare", "-b", "main"]);
        git(
            &root,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        );
        git(&root, &["push", "-q", "-u", "origin", "main"]);
        let wt = root
            .join(".claude")
            .join("worktrees")
            .join("iss-1217-judge");
        git(
            &root,
            &[
                "worktree",
                "add",
                "-q",
                &wt.to_string_lossy(),
                "-b",
                "ISS-1217",
            ],
        );
        std::fs::write(wt.join("verdict.md"), "judged").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "judge"]);
        git(&wt, &["push", "-q", "-u", "origin", "ISS-1217"]);

        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: MASTER.into(),
            worktree_path: wt.clone(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-1217".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        assert!(led.bind_agent("run-1", "a1217judge").unwrap());
        let transcript = crate::daemon::transcript_age::child_transcript(
            &scratch.0.join("conv.jsonl"),
            "a1217judge",
        )
        .unwrap();
        (led, root, wt, transcript)
    }

    /// Git still registers `wt` as a worktree of `root`: the half of a tree
    /// the ISS-1217 judge found gone while its directory stood.
    fn registered(root: &Path, wt: &Path) -> bool {
        let Ok(want) = std::fs::canonicalize(wt) else {
            return false;
        };
        git(root, &["worktree", "list", "--porcelain"])
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .any(|p| std::fs::canonicalize(p).ok().as_ref() == Some(&want))
    }

    struct NoProcess;
    #[async_trait::async_trait]
    impl crate::runner::terminate::ProcessGroup for NoProcess {
        async fn kill(&self, _pid: u32) -> crate::runner::inflight::Reaped {
            crate::runner::inflight::Reaped::NotFound
        }
    }

    fn stop_at(led: &Ledger, at_ms: i64, transcript: Option<&Path>) {
        let path = transcript.map(|p| p.to_string_lossy().into_owned());
        assert!(led.note_turn_end("run-1", at_ms, path.as_deref()).unwrap());
    }

    /// One sweep's answer for the one run: `None` where it was kept and owed nothing.
    async fn sweep(
        led: &mut Ledger,
        masters: &dyn MasterLiveness,
        beats: &Beats,
    ) -> Option<Recovered> {
        let done = reconcile(
            led,
            "boot-a",
            masters,
            &nothing_refuted(),
            Closing {
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
                roots: &Roots,
            },
            RunWatch {
                beat: beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        assert!(done.len() <= 1, "one run, at most one answer: {done:?}");
        done.into_iter().next()
    }

    fn master_alive() -> Masters {
        Masters(HashSet::from([MASTER.to_string()]))
    }

    fn kept(led: &Ledger) -> Option<String> {
        led.run("run-1").unwrap().unwrap().kept_notice
    }

    fn assert_still_held(led: &Ledger, r: &Option<Recovered>, wt: &Path, why: &str) {
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.ended_by, None, "{why}: the run was ended");
        assert!(r.is_none(), "{why}: recovery owed it something: {r:?}");
        assert!(wt.is_dir(), "{why}: the tree left the disk");
        assert!(
            led.ended_with_open_session("boot-a").unwrap().is_empty(),
            "{why}: its core session would be closed, handing its leases back"
        );
    }

    #[tokio::test]
    async fn the_iss_1135_run_that_stopped_to_wait_on_its_monitor_keeps_its_tree_across_sweeps() {
        let scratch = Scratch::new("iss-1135");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        let beats = Beats::default();
        let stop = now_ms() - 2 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        let r = sweep(&mut led, &master_alive(), &beats).await;
        assert_still_held(&led, &r, &wt, "the sweep right after the stop");
        transcript_written_at(&transcript, stop + MIN_MS);
        for n in 0..3 {
            let r = sweep(&mut led, &master_alive(), &beats).await;
            assert_still_held(&led, &r, &wt, &format!("resumed sweep {n}"));
        }
        assert!(
            registered(&root, &wt),
            "git still knows the tree it is writing in"
        );
        assert_eq!(
            kept(&led),
            None,
            "a subagent writing after its stop is working, and nothing is said about it"
        );
        assert_eq!(
            beats.0.lock().unwrap().len(),
            4,
            "the box still holds the run, so every sweep beats it and core's reaper leaves it alone"
        );
    }

    #[tokio::test]
    async fn the_iss_1217_judge_that_finished_keeps_its_tree_until_its_master_closes_it() {
        let scratch = Scratch::new("iss-1217");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        let beats = Beats::default();
        let stop = now_ms() - 3 * 60 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        for n in 0..3 {
            let r = sweep(&mut led, &master_alive(), &beats).await;
            assert_still_held(&led, &r, &wt, &format!("three hours quiet, sweep {n}"));
        }
        assert!(
            registered(&root, &wt),
            "a dispatcher resuming it now finds a worktree git still knows, not a bare directory"
        );
        assert_eq!(kept(&led).as_deref(), Some("quiet"), "and the box says so");

        led.end_run("run-1", "master", "its report is in").unwrap();
        let r = sweep(&mut led, &master_alive(), &beats)
            .await
            .expect("owed");
        assert!(
            r.owed_release,
            "its master's close is the one act that disowns a resume, so the tree goes back now: {r:?}"
        );
    }

    #[tokio::test]
    async fn the_iss_1217_judge_is_released_once_its_master_closes_it() {
        let scratch = Scratch::new("iss-1217-release");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        let stop = now_ms() - 3 * 60 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        sweep(&mut led, &master_alive(), &Beats::default()).await;
        led.end_run("run-1", "master", "its report is in").unwrap();
        let r = sweep(&mut led, &master_alive(), &Beats::default())
            .await
            .expect("owed");
        assert!(r.owed_release, "{r:?}");

        let leases = Leases(Mutex::new(HashSet::new()));
        let released = crate::runner::terminate::release(
            &mut led,
            "run-1",
            crate::runner::terminate::Forcing {
                this_boot: "boot-a",
                repo_root: &root,
                base_branch: Some("main"),
                by: "recovery",
                reason: "its master closed it",
            },
            crate::runner::terminate::Ports {
                procs: &NoProcess,
                sessions: &Sessions,
                leases: &leases,
            },
            now_ms() / 1000,
        )
        .await
        .unwrap();
        assert!(
            matches!(released, crate::runner::terminate::Release::Done(_)),
            "the release the close licensed is taken, not only owed: {released:?}"
        );
        assert!(!wt.exists(), "the tree is off the disk");
        assert!(!registered(&root, &wt), "and out of git's registry");
        assert!(
            git(&root, &["branch", "--list", "ISS-1217"]).contains("ISS-1217"),
            "the judge's branch, pushed before the close, is kept"
        );
    }

    #[tokio::test]
    async fn no_length_of_silence_ends_a_subagent_run_whose_master_lives() {
        let scratch = Scratch::new("silence");
        let (mut led, wt, transcript) = a_subagent_run(&scratch);
        let beats = Beats::default();
        let stop = now_ms() - 30 * 24 * 60 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        let r = sweep(&mut led, &master_alive(), &beats).await;
        assert_still_held(&led, &r, &wt, "thirty days quiet");
    }

    #[tokio::test]
    async fn a_quiet_run_is_said_once_and_a_later_stop_lets_it_be_said_again() {
        let scratch = Scratch::new("once");
        let (mut led, _wt, transcript) = a_subagent_run(&scratch);
        let beats = Beats::default();
        let stop = now_ms() - 61 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        sweep(&mut led, &master_alive(), &beats).await;
        assert_eq!(kept(&led).as_deref(), Some("quiet"));
        assert!(
            !led.note_kept("run-1", "quiet").unwrap(),
            "the notice is standing, so the next sweep has nothing new to say"
        );
        let resumed = now_ms() - MIN_MS;
        transcript_written_at(&transcript, resumed);
        stop_at(&led, resumed, None);
        assert_eq!(
            kept(&led),
            None,
            "a new turn-end ends the silence the notice was about"
        );
        sweep(&mut led, &master_alive(), &beats).await;
        assert_eq!(
            kept(&led),
            None,
            "and a minute of quiet is not yet worth a word"
        );
    }

    #[tokio::test]
    async fn a_run_whose_transcript_cannot_be_read_is_kept_and_said_once() {
        let scratch = Scratch::new("unreadable");
        let (mut led, wt, _transcript) = a_subagent_run(&scratch);
        let beats = Beats::default();
        stop_at(&led, now_ms() - 5 * 60 * MIN_MS, None);
        let r = sweep(&mut led, &master_alive(), &beats).await;
        assert_still_held(&led, &r, &wt, "no transcript path recorded");
        assert_eq!(kept(&led).as_deref(), Some("unreadable"));

        let missing = scratch.0.join("nowhere").join("agent-x.jsonl");
        stop_at(&led, now_ms() - 5 * 60 * MIN_MS, Some(&missing));
        let r = sweep(&mut led, &master_alive(), &beats).await;
        assert_still_held(&led, &r, &wt, "a path that reads nothing");
        assert_eq!(kept(&led).as_deref(), Some("unreadable"));
    }

    #[tokio::test]
    async fn a_run_that_never_ended_a_turn_is_kept_and_nothing_is_said() {
        let scratch = Scratch::new("never");
        let (mut led, wt, _transcript) = a_subagent_run(&scratch);
        let r = sweep(&mut led, &master_alive(), &Beats::default()).await;
        assert_still_held(&led, &r, &wt, "no stop heard yet");
        assert_eq!(kept(&led), None);
    }

    #[tokio::test]
    async fn a_quiet_subagent_run_whose_master_pane_is_gone_is_still_owed_its_release() {
        let scratch = Scratch::new("master-gone");
        let (mut led, _wt, transcript) = a_subagent_run(&scratch);
        let stop = now_ms() - 61 * MIN_MS;
        transcript_written_at(&transcript, stop);
        stop_at(&led, stop, Some(&transcript));
        let r = sweep(&mut led, &Masters(HashSet::new()), &Beats::default())
            .await
            .expect("owed");
        assert!(
            r.owed_release,
            "a subagent runs inside its master's process and cannot outlive the pane: {r:?}"
        );
        assert!(
            !r.unanswered && r.release_reason().contains("process is gone"),
            "a pane observed gone is an observation, and its reason says so: {r:?}"
        );
    }

    #[tokio::test]
    async fn an_unreadable_subagent_run_whose_master_pane_is_gone_is_still_owed_its_release() {
        let scratch = Scratch::new("master-gone-unread");
        let (mut led, _wt, _transcript) = a_subagent_run(&scratch);
        stop_at(&led, now_ms() - 61 * MIN_MS, None);
        let r = sweep(&mut led, &Masters(HashSet::new()), &Beats::default())
            .await
            .expect("owed");
        assert!(r.owed_release, "{r:?}");
        assert_eq!(
            kept(&led),
            None,
            "nothing is said about keeping a run the box is giving back"
        );
    }

    // ISS-1220: a subagent run whose master this box holds no registry entry
    // for. Nothing on the box can close it, so the bound is what does.

    const HOUR_MS: i64 = 60 * MIN_MS;

    /// A run past the bound: its session was seen over `over_ms` ago and its
    /// subagent last wrote `silent_ms` ago.
    fn over_for(led: &Ledger, transcript: &Path, over_ms: i64, silent_ms: i64) {
        let written = now_ms() - silent_ms;
        transcript_written_at(transcript, written);
        stop_at(led, written, Some(transcript));
        led.backdate_session_terminal("run-1", (now_ms() - over_ms) / 1000)
            .unwrap();
    }

    async fn release_at(
        led: &mut Ledger,
        root: &Path,
        at_secs: i64,
    ) -> crate::runner::terminate::Release {
        crate::runner::terminate::release(
            led,
            "run-1",
            crate::runner::terminate::Forcing {
                this_boot: "boot-a",
                repo_root: root,
                base_branch: Some("main"),
                by: "recovery",
                reason: "no master answers for it",
            },
            crate::runner::terminate::Ports {
                procs: &NoProcess,
                sessions: &Sessions,
                leases: &Leases(Mutex::new(HashSet::new())),
            },
            at_secs,
        )
        .await
        .unwrap()
    }

    /// The same capture `close_loop.rs` carries, local to the log it reads.
    fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::Arc;
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[tokio::test]
    async fn an_unanswered_run_over_at_core_and_silent_past_the_bound_is_owed_its_release() {
        let scratch = Scratch::new("unanswered");
        let (mut led, _root, _wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 2 * HOUR_MS, 2 * HOUR_MS);
        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("an orphan is always answered for");
        assert!(
            r.state.session_terminal && !r.state.checkout_returned,
            "the state under test is b4e955c2's, got {:?}",
            r.state
        );
        assert!(
            r.owed_release,
            "no master on this box answers for it, core ended its session two hours ago and its subagent has written nothing since, so nothing but this sweep will ever give its checkout back: {r:?}"
        );
        assert!(
            !r.owed_death_report,
            "the bound licenses the release, which keeps the work, and never a death"
        );
        assert!(
            r.unanswered && r.release_reason().contains("no master on this box answers"),
            "and the row it ends says the agent's end was concluded from silence, not seen: {r:?}"
        );
    }

    #[tokio::test]
    async fn an_unanswered_run_inside_the_bound_is_owed_nothing_yet() {
        let scratch = Scratch::new("unanswered-young");
        let (mut led, _root, _wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("answered");
        assert!(
            !r.owed_release,
            "the sweep that first sees the session over starts the clock and is not past it: {r:?}"
        );
        over_for(
            &led,
            &transcript,
            UNANSWERED_RELEASE_AFTER.as_millis() as i64 - MIN_MS,
            2 * HOUR_MS,
        );
        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("answered");
        assert!(
            !r.owed_release,
            "a minute short of the bound is short of it: {r:?}"
        );
        over_for(
            &led,
            &transcript,
            UNANSWERED_RELEASE_AFTER.as_millis() as i64,
            2 * HOUR_MS,
        );
        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("answered");
        assert!(r.owed_release, "and at the bound it is owed: {r:?}");
    }

    #[tokio::test]
    async fn an_unanswered_run_whose_subagent_wrote_inside_the_bound_is_kept() {
        let scratch = Scratch::new("unanswered-writing");
        let (mut led, _root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 3 * HOUR_MS, 5 * MIN_MS);
        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("answered");
        assert!(
            !r.owed_release,
            "a subagent that wrote five minutes ago is working in a pane this box cannot see, however long core has called its session over: {r:?}"
        );
        assert!(wt.is_dir());
    }

    #[tokio::test]
    async fn a_subagent_run_under_a_live_master_is_kept_however_long_its_session_is_over() {
        let scratch = Scratch::new("live-master-over");
        let (mut led, _root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 30 * 24 * HOUR_MS, 30 * 24 * HOUR_MS);
        let r = sweep(&mut led, &master_alive(), &Beats::default()).await;
        assert_still_held(&led, &r, &wt, "thirty days over under a live master");
    }

    #[test]
    fn the_release_the_bound_licenses_is_said_once_naming_what_it_holds() {
        let scratch = Scratch::new("unanswered-said");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        git(&wt, &["checkout", "-q", "--detach"]);
        std::fs::write(wt.join("jest-results.json"), "{}").unwrap();
        over_for(&led, &transcript, 2 * HOUR_MS, 2 * HOUR_MS);

        let first = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(r.owed_release, "{r:?}");
            })
        });
        for said in [
            "run-1",
            "ISS-1217",
            &wt.display().to_string(),
            MASTER,
            "120m",
            "its subagent last wrote 120m ago",
        ] {
            assert!(
                first.contains(said),
                "the line an operator reads names {said:?}, so nobody greps `worktree-reap` to find the tree: {first}"
            );
        }

        let again = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(r.owed_release, "{r:?}");
            })
        });
        assert!(
            !again.contains("no master on this box answers"),
            "a release that never started — a project with no repo path here — is owed again next sweep, and its reason is said once: {again}"
        );
        assert_eq!(
            led.run("run-1").unwrap().unwrap().kept_notice.as_deref(),
            Some("unanswered"),
            "and the row says what the box said"
        );

        let now = now_ms() / 1000;
        let refused = block_on(release_at(&mut led, &root, now));
        assert!(
            matches!(
                refused,
                crate::runner::terminate::Release::Refusing { .. }
            ),
            "a detached checkout with an unsaved file has no salvage to run, so the release refuses rather than dropping it: {refused:?}"
        );
        assert!(wt.is_dir(), "and the checkout stays");

        let second = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(r.owed_release, "still owed while the refusal stands: {r:?}");
            })
        });
        assert!(
            !second.contains("no master on this box answers"),
            "still said once while the refusal streak stands and says its own piece: {second}"
        );

        let decided = block_on(release_at(
            &mut led,
            &root,
            now + crate::runner::terminate::RELEASE_GRACE_SECS,
        ));
        assert!(
            matches!(decided, crate::runner::terminate::Release::Terminal { .. }),
            "past the window the refusal is decided, not retried for ever: {decided:?}"
        );
        assert!(
            wt.join("jest-results.json").is_file(),
            "decided terminal with the unsaved file still on disk"
        );
        assert!(
            led.unclosed_runs().unwrap().is_empty(),
            "and the run leaves the sweep, so nothing logs about it again"
        );
    }

    #[test]
    fn a_release_decided_without_a_readable_transcript_says_the_clock_alone_decided() {
        let scratch = Scratch::new("unanswered-unread");
        let (mut led, _root, _wt, _transcript) = a_subagent_run_in_a_worktree(&scratch);
        let missing = scratch.0.join("pruned").join("agent-gone.jsonl");
        stop_at(&led, now_ms() - 2 * HOUR_MS, Some(&missing));
        led.backdate_session_terminal("run-1", (now_ms() - 2 * HOUR_MS) / 1000)
            .unwrap();
        let said = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(r.owed_release, "{r:?}");
                assert!(
                    r.clock_alone && r.release_reason().contains("the clock alone decided"),
                    "and the row it ends keeps the same account, never 'wrote nothing': {r:?}"
                );
            })
        });
        assert!(
            said.contains("cannot be read, so the session's clock alone decides")
                && said.contains(&missing.display().to_string()),
            "a transcript nobody could read is named as deciding nothing, never passed off as silence: {said}"
        );
    }

    #[test]
    fn a_refusal_already_standing_is_not_announced_again_as_a_fresh_release() {
        let scratch = Scratch::new("unanswered-refusing");
        let (mut led, _root, _wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 2 * HOUR_MS, 2 * HOUR_MS);
        led.note_release_refusal(
            "run-1",
            "git worktree remove: permission denied",
            now_ms() / 1000,
        )
        .unwrap();
        let said = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(
                    r.owed_release,
                    "still owed, so the streak runs to its decision: {r:?}"
                );
            })
        });
        assert!(
            !said.contains("no master on this box answers"),
            "a streak opened while the master read as gone, before a restart emptied the registry, is already speaking for this release: {said}"
        );
    }

    #[test]
    fn a_run_kept_as_quiet_under_its_master_is_still_announced_when_the_bound_releases_it() {
        let scratch = Scratch::new("quiet-then-unanswered");
        let (mut led, _root, _wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 2 * HOUR_MS, 2 * HOUR_MS);
        block_on(sweep(&mut led, &master_alive(), &Beats::default()));
        assert_eq!(
            led.run("run-1").unwrap().unwrap().kept_notice.as_deref(),
            Some("quiet"),
            "kept, and said quiet, while its master was here"
        );
        let said = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(r.owed_release, "{r:?}");
            })
        });
        assert!(
            said.contains("no master on this box answers"),
            "an older keep notice does not swallow the release's own: {said}"
        );
    }

    /// Core will not take a lease back, so a run whose release was decided
    /// stays in the sweep for its leases alone.
    struct LeasesRefused;
    #[async_trait::async_trait]
    impl LeaseKeeper for LeasesRefused {
        async fn release(&self, _: Option<&str>, _: &str) -> Result<()> {
            Err(crate::error::Error::Other(
                "409: lease held elsewhere".into(),
            ))
        }
        async fn is_returned(&self, _: Option<&str>, _: &str) -> Result<bool> {
            Ok(false)
        }
    }

    #[test]
    fn a_run_whose_release_was_decided_is_named_once_while_its_leases_are_chased() {
        let scratch = Scratch::new("decided");
        let (mut led, _root, wt, _transcript) = a_subagent_run_in_a_worktree(&scratch);
        led.note_release_refusal("run-1", "the diff was not preserved", 1_790_000_000)
            .unwrap();
        led.conclude_release_refusal(
            "run-1",
            1_790_000_300,
            "recovery",
            "the diff was not preserved",
        )
        .unwrap();
        let mut sweep_once = || {
            logged_while(|| {
                block_on(async {
                    let done = reconcile(
                        &mut led,
                        "boot-a",
                        &NoRegistryEntry,
                        &nothing_refuted(),
                        Closing {
                            sessions: &Sessions,
                            leases: &LeasesRefused,
                            roots: &Roots,
                        },
                        RunWatch {
                            beat: &Beats::default(),
                            idle: &NeverReports,
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(done.len(), 1, "its leases keep it in the sweep");
                    assert!(!done[0].owed_release, "a decided release is not retried");
                    assert!(done[0].standing_said, "{:?}", done[0]);
                })
            })
        };
        let first = sweep_once();
        assert!(
            first.contains("decided terminal (the diff was not preserved)")
                && first.contains(&wt.display().to_string())
                && first.contains("forge-runner run release run-1"),
            "the decision, the checkout it left and the way back are named: {first}"
        );
        let second = sweep_once();
        assert!(
            !second.contains("partially closed"),
            "said once, not on every sweep of the lease chase: {second}"
        );
    }

    #[test]
    fn a_run_awaiting_the_bound_says_so_once_and_what_ends_it() {
        let scratch = Scratch::new("unanswered-awaiting");
        let (mut led, _root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        over_for(&led, &transcript, 5 * MIN_MS, 5 * MIN_MS);
        let first = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(!r.owed_release, "inside the bound: {r:?}");
                assert!(r.standing_said, "and why it stands has been said: {r:?}");
            })
        });
        assert!(
            first.contains("released once core has called its session over for 60m")
                && first.contains(&wt.display().to_string())
                && first.contains("its subagent last wrote 5m ago"),
            "the first sweep names the checkout and the bound that ends it: {first}"
        );
        let second = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(
                    r.standing_said,
                    "still said, so the sweep's own line stays down: {r:?}"
                );
            })
        });
        assert!(
            !second.contains("partially closed"),
            "the second identical sweep says nothing new: {second}"
        );
    }

    #[test]
    fn a_run_awaiting_the_bound_with_no_readable_transcript_says_the_clock_alone_decides() {
        let scratch = Scratch::new("awaiting-unread");
        let (mut led, _root, _wt, _transcript) = a_subagent_run_in_a_worktree(&scratch);
        let missing = scratch.0.join("pruned").join("agent-gone.jsonl");
        stop_at(&led, now_ms() - 30 * MIN_MS, Some(&missing));
        led.backdate_session_terminal("run-1", (now_ms() - 30 * MIN_MS) / 1000)
            .unwrap();
        let said = logged_while(|| {
            block_on(async {
                let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
                    .await
                    .expect("answered");
                assert!(!r.owed_release && r.standing_said, "{r:?}");
            })
        });
        assert!(
            said.contains("the session's clock alone decides") && !said.contains("stayed silent"),
            "a standing with no readable transcript claims no silence: {said}"
        );
    }

    #[test]
    fn a_run_from_another_boot_whose_checkout_is_back_is_not_said_to_hold_one() {
        let mut led = seeded("run-1", "master-unknown", "boot-a", &["ISS-1220"]);
        let said = logged_while(|| {
            block_on(async {
                let done = reconcile(
                    &mut led,
                    "boot-later",
                    &NoRegistryEntry,
                    &nothing_refuted(),
                    Closing {
                        sessions: &Sessions,
                        leases: &LeasesRefused,
                        roots: &Roots,
                    },
                    RunWatch {
                        beat: &Beats::default(),
                        idle: &NeverReports,
                    },
                )
                .await
                .unwrap();
                assert!(
                    done[0].state.checkout_returned && done[0].standing_said,
                    "{:?}",
                    done[0]
                );
            })
        });
        assert!(
            said.contains(
                "Its checkout is back, 0/1 of its leases are back and the rest stay held"
            ) && !said.contains("is still held"),
            "the line says what is left, not a checkout it gave back: {said}"
        );
    }

    #[test]
    fn a_run_left_only_its_leases_is_named_once_and_not_every_sweep() {
        let mut led = seeded("run-1", "master-unknown", "boot-a", &["ISS-1220"]);
        let mut sweep_once = || {
            logged_while(|| {
                block_on(async {
                    let done = reconcile(
                        &mut led,
                        "boot-a",
                        &NoRegistryEntry,
                        &nothing_refuted(),
                        Closing {
                            sessions: &Sessions,
                            leases: &LeasesRefused,
                            roots: &Roots,
                        },
                        RunWatch {
                            beat: &Beats::default(),
                            idle: &NeverReports,
                        },
                    )
                    .await
                    .unwrap();
                    let r = &done[0];
                    assert!(
                        r.state.session_terminal
                            && r.state.checkout_returned
                            && !r.state.is_closed(),
                        "the state under test holds only a lease: {r:?}"
                    );
                    assert!(r.standing_said, "{r:?}");
                })
            })
        };
        let first = sweep_once();
        assert!(
            first.contains("only its leases (0/1 returned)"),
            "the line says what is left, not a checkout it no longer holds: {first}"
        );
        for _ in 0..2 {
            let again = sweep_once();
            assert!(!again.contains("partially closed"), "said once: {again}");
        }
    }

    #[test]
    fn a_run_from_another_boot_is_named_stuck_once_and_not_every_sweep() {
        let scratch = Scratch::new("foreign-boot");
        let (mut led, _root, wt, _transcript) = a_subagent_run_in_a_worktree(&scratch);
        let first = logged_while(|| {
            block_on(async {
                let done = reconcile(
                    &mut led,
                    "boot-later",
                    &NoRegistryEntry,
                    &nothing_refuted(),
                    Closing {
                        sessions: &Sessions,
                        leases: &Leases(Mutex::new(HashSet::new())),
                        roots: &Roots,
                    },
                    RunWatch {
                        beat: &Beats::default(),
                        idle: &NeverReports,
                    },
                )
                .await
                .unwrap();
                assert!(
                    !done[0].owed_release,
                    "another boot is never reclaimed here"
                );
                assert!(done[0].standing_said, "{:?}", done[0]);
            })
        });
        for said in [
            "boot-a",
            "boot-later",
            "will stay so",
            &wt.display().to_string(),
        ] {
            assert!(
                first.contains(said),
                "a run nothing here will ever close is named stuck with {said:?}: {first}"
            );
        }
        let second = logged_while(|| {
            block_on(async {
                let done = reconcile(
                    &mut led,
                    "boot-later",
                    &NoRegistryEntry,
                    &nothing_refuted(),
                    Closing {
                        sessions: &Sessions,
                        leases: &Leases(Mutex::new(HashSet::new())),
                        roots: &Roots,
                    },
                    RunWatch {
                        beat: &Beats::default(),
                        idle: &NeverReports,
                    },
                )
                .await
                .unwrap();
                assert!(done[0].standing_said);
            })
        });
        assert!(
            !second.contains("partially closed"),
            "said once, not every sweep: {second}"
        );
    }

    #[tokio::test]
    async fn a_run_released_on_the_bound_gives_its_checkout_back_and_keeps_its_commits() {
        let scratch = Scratch::new("unanswered-release");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        git(&wt, &["checkout", "-q", "--detach"]);
        std::fs::write(wt.join("unpushed.md"), "local only").unwrap();
        git(&wt, &["add", "."]);
        git(&wt, &["commit", "-q", "-m", "on no remote, on no branch"]);
        let unpushed = git(&wt, &["rev-parse", "HEAD"]).trim().to_string();
        over_for(&led, &transcript, 2 * HOUR_MS, 2 * HOUR_MS);

        let r = sweep(&mut led, &NoRegistryEntry, &Beats::default())
            .await
            .expect("answered");
        assert!(r.owed_release, "{r:?}");
        let released = release_at(&mut led, &root, now_ms() / 1000).await;
        assert!(
            matches!(released, crate::runner::terminate::Release::Done(_)),
            "the release the bound licensed is taken: {released:?}"
        );
        assert!(!wt.exists(), "the tree is off the disk");
        assert!(!registered(&root, &wt), "and out of git's registry");
        assert!(
            git(&root, &["branch", "--list", "ISS-1217"]).contains("ISS-1217"),
            "the pushed branch is kept"
        );
        let holders = git(&root, &["for-each-ref", "--contains", &unpushed]);
        assert!(
            !holders.trim().is_empty(),
            "the commit only the checkout's own HEAD named is given a ref before the checkout goes: {holders}"
        );
        assert!(
            led.unclosed_runs().unwrap().is_empty(),
            "and the run is closed, so the partially-closed line has nothing left to say"
        );
    }

    /// One sweep over a run this box has ended, with core's session row still
    /// open, using whichever lease keeper the caller hands in.
    async fn sweep_ended_run(led: &mut Ledger, leases: &dyn LeaseKeeper) -> Option<Recovered> {
        let done = reconcile(
            led,
            "boot-a",
            &Masters(HashSet::new()),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases,
                roots: &Roots,
            },
            RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
        )
        .await
        .unwrap();
        done.into_iter().next()
    }

    /// ISS-1239 — the combination `Standing` had no arm for.
    ///
    /// This box ended the run, so `ended_by` is set and the ledger reads it
    /// dead; core still holds its session open, so `session_terminal` is false
    /// and the release is not owed; its close loop is therefore not finished.
    /// Every branch that names a reason declined, and the one that spoke — the
    /// sweep's own bare `partially closed` line in `master.rs` — names no
    /// branch, no reason and no act. It was printed every sweep for as long as
    /// the box lived: 4,632 times over two days for one run.
    #[test]
    fn a_run_this_box_ended_whose_session_core_still_holds_names_itself_once() {
        let said = logged_while(|| {
            block_on(async {
                let mut led = seeded("run-1", "master-gone", "boot-a", &["ISS-1239"]);
                led.end_run("run-1", "subagent", "its subagent ended its turn")
                    .unwrap();
                let leases = Leases(Mutex::new(HashSet::new()));
                let r = sweep_ended_run(&mut led, &leases)
                    .await
                    .expect("an orphaned run is always answered for");
                assert!(
                    !r.owed_release && !r.owed_death_report && !r.state.is_closed(),
                    "the state under test is the one every naming branch declines: {r:?}"
                );
                assert!(
                    r.standing_said,
                    "recovery says why it stands, which is the whole of what stands the sweep's own line down: {r:?}"
                );
                for _ in 0..2 {
                    let again = sweep_ended_run(&mut led, &leases).await;
                    assert!(
                        again.is_some_and(|r| r.standing_said),
                        "and it keeps standing that line down on every later sweep"
                    );
                }
            })
        });
        assert_eq!(
            said.matches("is partially closed").count(),
            1,
            "three sweeps over one unchanged standing say it once: {said}"
        );
        assert!(
            said.contains("this box has nothing left to do for it"),
            "the line says which branch it took, rather than repeating the three marks: {said}"
        );
        assert!(
            said.contains("core's session row"),
            "it names the mark that is outstanding: {said}"
        );
        assert!(
            said.contains("forge-runner run release run-1"),
            "and the act that takes the run up again: {said}"
        );
    }

    /// ISS-1239 — said once is not said never. A standing that CHANGES is said
    /// again: the whole point of latching on the notice rather than on a flag.
    #[test]
    fn that_standing_is_said_again_once_it_changes() {
        let said = logged_while(|| {
            block_on(async {
                let mut led = seeded("run-1", "master-gone", "boot-a", &["ISS-1239"]);
                led.end_run("run-1", "subagent", "its subagent ended its turn")
                    .unwrap();
                // The lease is refused throughout, so the run stays unclosed
                // across both sweeps and the only thing that moves is WHICH
                // mark is outstanding.
                assert!(sweep_ended_run(&mut led, &LeasesRefused).await.is_some());
                // Core calls the session over, so what is outstanding stops
                // being the session and becomes the lease this keeper refuses.
                led.backdate_session_terminal("run-1", now_ms() / 1000 - 60)
                    .unwrap();
                let r = reconcile(
                    &mut led,
                    "boot-a",
                    &Masters(HashSet::new()),
                    &nothing_refuted(),
                    Closing {
                        sessions: &Sessions,
                        leases: &LeasesRefused,
                        roots: &Roots,
                    },
                    RunWatch {
                        beat: &Beats::default(),
                        idle: &NeverReports,
                    },
                )
                .await
                .unwrap();
                assert!(
                    r.first().is_some_and(|r| r.standing_said),
                    "the new standing is said, not swallowed by the earlier one: {r:?}"
                );
            })
        });
        assert_eq!(
            said.matches("is partially closed").count(),
            2,
            "two standings, two lines — a latch that never reopens is a warning nobody can act on: {said}"
        );
        assert!(
            said.contains("leases"),
            "and the second names the mark that is outstanding now: {said}"
        );
    }

    /// A keeper that also answers the issue's own status: the keys in the set
    /// are over at core, everything else is live.
    struct LeasesOver {
        returned: Mutex<HashSet<String>>,
        over: HashSet<String>,
    }

    impl LeasesOver {
        fn with(over: &[&str]) -> Self {
            Self {
                returned: Mutex::new(HashSet::new()),
                over: over.iter().map(|s| (*s).to_string()).collect(),
            }
        }
    }

    #[async_trait::async_trait]
    impl LeaseKeeper for LeasesOver {
        async fn release(&self, _: Option<&str>, issue_key: &str) -> Result<()> {
            self.returned.lock().unwrap().insert(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, _: Option<&str>, issue_key: &str) -> Result<bool> {
            Ok(self.returned.lock().unwrap().contains(issue_key))
        }
        async fn issue_is_over(&self, _: Option<&str>, issue_key: &str) -> Result<Option<bool>> {
            Ok(Some(self.over.contains(issue_key)))
        }
    }

    async fn sweep_under_a_live_master(
        led: &mut Ledger,
        leases: &dyn LeaseKeeper,
        beats: &Beats,
    ) -> Option<Recovered> {
        reconcile(
            led,
            "boot-a",
            &master_alive(),
            &nothing_refuted(),
            Closing {
                sessions: &SessionCoreStillHolds,
                leases,
                roots: &Roots,
            },
            RunWatch {
                beat: beats,
                idle: &NeverReports,
            },
        )
        .await
        .unwrap()
        .into_iter()
        .next()
    }

    /// ISS-1245 — the loop the keep is in, and the one fact outside it.
    ///
    /// The run's master is alive, so the keep holds; the keep beats the run's
    /// session on every sweep, so core's row never goes stale; so core never
    /// calls the session over, so the keep never ends. Measured on this box
    /// 2026-09-25: two runs holding unreturned leases on ISS-1234 and ISS-1213,
    /// both issues closed, eight hours after the fact. The issue going over is
    /// the only thing that can break it, and `session_terminal` is deliberately
    /// NOT required — the mark this sweep is waiting for is the one the beat it
    /// stops would have kept from ever arriving.
    #[tokio::test]
    async fn a_kept_run_whose_every_issue_is_over_gives_its_leases_back_and_is_no_longer_beaten() {
        let scratch = Scratch::new("issues-over");
        let (mut led, _root, _wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        stop_at(&led, now_ms() - HOUR_MS, Some(&transcript));
        let beats = Beats::default();
        let leases = LeasesOver::with(&["ISS-1217"]);

        let r = sweep_under_a_live_master(&mut led, &leases, &beats)
            .await
            .expect("a run whose issues are over is no longer kept, so it is answered for");

        assert!(
            !r.state.session_terminal,
            "the state under test is the one the beat keeps alive — core still holds the session open: {r:?}"
        );
        assert_eq!(
            r.state.leases_returned, r.state.leases_total,
            "the harm is a lease nobody returns: an issue no run on this box can take: {r:?}"
        );
        assert!(
            r.owed_release,
            "and its checkout is asked for, by the same path an orphan's is: {r:?}"
        );
        assert!(
            beats.0.lock().unwrap().is_empty(),
            "the sweep no longer beats a run it has stopped keeping — the beat is what held core's \
             session row open: {:?}",
            beats.0.lock().unwrap()
        );
    }

    /// ISS-1245 — every issue, not any. A run holding one issue that is over
    /// and one that is not is still working, and closing it would take the live
    /// one's checkout with it.
    #[tokio::test]
    async fn a_kept_run_holding_one_live_issue_is_kept_and_beaten_as_before() {
        let mut led = seeded("run-1", MASTER, "boot-a", &["ISS-1217", "ISS-1300"]);
        assert!(led.bind_agent("run-1", "a1217judge").unwrap());
        let beats = Beats::default();

        let r = sweep_under_a_live_master(&mut led, &LeasesOver::with(&["ISS-1217"]), &beats).await;

        assert!(
            r.is_none(),
            "it is kept, so the sweep owes nothing for it: {r:?}"
        );
        assert_eq!(
            beats.0.lock().unwrap().len(),
            1,
            "and it is still beaten, because a kept run's session must not go stale under it"
        );
        assert!(
            led.run("run-1").unwrap().unwrap().released_as.is_none(),
            "its checkout was never even asked about"
        );
    }

    /// ISS-1245 — a keeper that cannot answer says so, and *not known to be
    /// over* is not *over*. An older core sending no such field, or a key that
    /// reaches no issue, leaves the run exactly as it is today.
    #[tokio::test]
    async fn a_kept_run_whose_issue_status_is_unknown_is_kept() {
        let mut led = seeded("run-1", MASTER, "boot-a", &["ISS-1217"]);
        assert!(led.bind_agent("run-1", "a1217judge").unwrap());
        let beats = Beats::default();

        // `Leases` does not override `issue_is_over`, so it answers `None`:
        // the default every keeper that cannot ask gives.
        let r =
            sweep_under_a_live_master(&mut led, &Leases(Mutex::new(HashSet::new())), &beats).await;

        assert!(
            r.is_none(),
            "a guess here closes a run somebody is using: {r:?}"
        );
        assert_eq!(beats.0.lock().unwrap().len(), 1, "and it is still beaten");
        assert!(
            led.run("run-1").unwrap().unwrap().released_as.is_none(),
            "and its checkout was never asked about"
        );
    }

    /// ISS-1245's Rule 2 — the guard that stands in for `session_terminal`.
    ///
    /// The licence does not decide what happens to the checkout; `terminate::release`
    /// does, and a checkout holding work no branch carries is refused by name
    /// rather than released. So a run whose issues went over while its subagent
    /// still had an unsaved diff keeps both, and the operator is told which run,
    /// which reason and which path.
    #[test]
    fn a_run_whose_issues_are_over_but_whose_diff_is_unsaved_is_refused_by_name() {
        let scratch = Scratch::new("issues-over-unsaved");
        let (mut led, root, wt, transcript) = a_subagent_run_in_a_worktree(&scratch);
        git(&wt, &["checkout", "-q", "--detach"]);
        std::fs::write(wt.join("unsaved.txt"), "work nobody committed").unwrap();
        stop_at(&led, now_ms() - HOUR_MS, Some(&transcript));

        let said = logged_while(|| {
            block_on(async {
                let r = sweep_under_a_live_master(
                    &mut led,
                    &LeasesOver::with(&["ISS-1217"]),
                    &Beats::default(),
                )
                .await
                .expect("its issues are over, so it is no longer kept");
                assert!(r.owed_release, "and its checkout is asked for: {r:?}");

                let refused = release_at(&mut led, &root, now_ms() / 1000).await;
                match refused {
                    crate::runner::terminate::Release::Refusing { why, .. } => {
                        assert!(
                            why.contains("run-1") && why.contains(&wt.display().to_string()),
                            "the refusal names the run and the path: {why}"
                        );
                        assert!(why.contains("was not preserved"), "and the reason: {why}");
                    }
                    other => panic!("the diff must stop the release, got {other:?}"),
                }
            })
        });
        assert!(wt.exists(), "and the checkout stays on disk: {said}");
        assert!(
            wt.join("unsaved.txt").exists(),
            "with the work still in it: {said}"
        );
    }
}
