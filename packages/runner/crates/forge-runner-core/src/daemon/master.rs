//! What starts work now that nothing pushes it, and what ends it.
//!
//! Core wakes this box and keeps jobs `queued`; this loop is the only thing on
//! the box that notices. It asks core which projects this device serves, reads
//! each pool, and keeps one RESIDENT master per project — a Claude session
//! running the `forge-master` skill, which decides order and batch size and
//! claims through the control socket.
//!
//! Resident, and parented by tmux rather than by this daemon (ISS-919): an
//! attachable pane, a master that survives a `forge-runner` restart.
//!
//! Nothing here supervises that master any more (ISS-933). A pane's byte count
//! cannot tell a master idle on purpose from one that has stopped, so the
//! silence ceiling, the quiet gate, the transcript reads and the crashloop
//! breaker are gone — leaving one detector, the pane exists or it does not,
//! and one exit the master earns for itself out of the ledger.
//!
//! The daemon deliberately makes NO routing decision. It answers one question
//! per project, "is there anything at all", and hands the rest to judgement.
//!

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::daemon::agent_activity;
use crate::daemon::checkpoint;
use crate::daemon::dispatch::resolve_repo;
use crate::daemon::held_report;
use crate::daemon::job_exit;
use crate::daemon::job_unheard;
use crate::daemon::master_exit::{self, Verdict};
use crate::daemon::master_limit;
use crate::daemon::pool_jobs::{self, JobPanes, Records};
use crate::daemon::pool_reads;
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::run_record;
use crate::daemon::session_tokens;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, MasterAuthority, MasterStanding, Run};
use crate::runner::terminate;
use crate::transport::admissible::{self, AdmissibleIssue, DISPATCH_GATING_KIND};
use crate::transport::{master as master_api, mcp_servers, runners, CoreClient};
use tokio::sync::mpsc;

const POLL_INTERVAL: Duration = Duration::from_secs(30);

const WAKE_FLOOR: Duration = Duration::from_secs(5);

pub(crate) const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

pub(crate) const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
    dropped: &[String],
    reach: &crate::mcp::config::PaneReach,
) -> String {
    let mut out = format!(
        "Use the `forge-master` skill. You are the resident master for project `{project}` on \
this box, and you will be woken again in this same session rather than started fresh.\n"
    );
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nYou are standing in this project's checkout, on its base branch `{base}`.\n"
        ));
    }
    // The reach is what this pane HOLDS, read off the two files it will be
    // started with. `dropped` below is what core ASKED for and could not
    // supply; a pane told only that still cannot say what it has. A pane whose
    // declaration could not be read at all is never started (ISS-1235).
    out.push_str(&reach.brief());
    if !dropped.is_empty() {
        out.push_str(&format!(
            "\nThis project declares MCP server(s) this box could NOT supply: {}. Work you hand \
out will not have their tools. An issue whose work needs one of them cannot be built here — say so \
on the issue rather than parking it as a run that failed.\n",
            dropped.join(", ")
        ));
    }
    if let Some(policy) = master_policy {
        out.push_str(
            "\n## The project owner's standing policy\n\nThis is the owner's own instruction for \
this project, and it OUTRANKS the `forge-master` skill wherever the two differ — the skill holds \
the defaults for a project that has set none. It is set as this project's `master-policy` fact and \
is re-sent to every master this box starts, so it survives this session.\n\n",
        );
        out.push_str(policy);
        out.push('\n');
    }
    out
}

#[derive(Default)]
pub struct Masters(Arc<Mutex<Registry>>);

/// The live masters, and what this box has seen the dead ones do.
#[derive(Default)]
struct Registry {
    live: HashMap<String, MasterState>,
    /// What the last sweep read as this box's projects.
    served: Served,
    /// Why each project's master pane was not placed on the last sweep.
    unplaced: HashMap<String, Unplaced>,
    /// The last thing this box said about each project's pane, so a project
    /// stuck in one state is reported on the sweep that finds it and not on all
    /// forty-five after it.
    ///
    /// Keyed by project rather than held on `MasterState`, because every one of
    /// its callers can run for a project this daemon holds no live master for —
    /// which is every project on a daemon that has just started, since `live`
    /// is filled by `remember` and `remember` runs after the sweep's first two
    /// reports. Held on the state, the latch answered "already said" about a
    /// project nothing had said anything about, and the report was lost
    /// (ISS-1099; it is why ISS-1118's contradiction error fired only on the
    /// daemon that placed the pane).
    said: HashMap<String, &'static str>,
    /// The last box-level account of deaf masters this daemon gave, as the
    /// digest of the whole set and what was done about each.
    ///
    /// A digest of the set rather than a count, because four projects deaf and
    /// four others deaf in their place is not the same condition and reads
    /// identically by number. `None` once a sweep finds none, so a fleet that
    /// goes deaf a second time is news again.
    deaf_said: Option<String>,
    /// Per project, a session whose capability this box minted for a pane it
    /// then failed to place AND failed to withdraw.
    ///
    /// The map on disk is the detector, and a mint that could not be taken back
    /// out of it says `current` about a pane that was never replaced. Nothing
    /// on disk can correct that — the correction IS the write that failed — so
    /// the box holds what it knows here and refuses to read that entry as
    /// evidence until the withdrawal takes. The retry is the ordinary sweep:
    /// the verdict stays `stale`, the pane is ended again, and a placement that
    /// works clears this (ISS-1208, criterion 7).
    ///
    /// In this process only. A daemon restarted with an entry still unwithdrawn
    /// reads the map at face value again, which is the residual named in
    /// `docs/proposals/a-panes-control-capability-cannot-outlive-its-session-row.md`.
    unwithdrawn: HashMap<String, String>,
}

#[derive(Default, Clone, PartialEq, Eq)]
pub(crate) enum Served {
    /// No sweep has read the list yet.
    #[default]
    Unread,
    /// The last read failed, and this is what it said.
    Unreadable(String),
    /// The project ids core last answered for this device.
    Read(Vec<String>),
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Unplaced {
    /// The runner row refuses new work, so this sweep placed no pane for it.
    Draining {
        status: String,
    },
    /// Core serves this project to this box but nothing here says where the
    /// checkout is.
    NoRepoPath,
    /// This box has no terminal multiplexer, so it can host no master at all.
    NoTerminal,
    /// Core refused the registration this pane's identity comes from.
    RegisterFailed {
        detail: String,
    },
    /// The pane could not be given the skill it runs on, so none was started.
    SkillMissing {
        detail: String,
    },
    NothingAdmissible,
    /// An owner stood this project's master down, so this box places none
    /// until somebody stands it up again (ISS-1118).
    ///
    /// `pane` is the session running against that stand-down, where one is.
    /// It is part of the value rather than a second map because the two states
    /// are two different things to tell an operator, and a value that cannot
    /// tell them apart cannot report the move from one to the other either.
    StoodDown {
        by: String,
        why: Option<String>,
        slug: String,
        pane: Option<String>,
    },
    /// This box could not read whether its owner stood this project down, so
    /// it placed nothing rather than deciding it was driving.
    StandingUnreadable {
        detail: String,
    },
    /// A pane is up for this project and this box cannot hear it: the
    /// capability it holds names a session core has since replaced, so every
    /// declaration it makes is refused (ISS-1099).
    ///
    /// The pane is placed and the project still has no working master, which is
    /// why this is an `Unplaced` reason and not a state of the pane. The record
    /// exists so the sweep that learns it does not leave the registry saying
    /// nothing: the landed change cleared this map on exactly this path, at the
    /// moment the daemon found out.
    ///
    /// Its one reader is `run_declare`, so the only thing that ever sees this
    /// sentence is the pane itself — which is inside tmux and reaches the
    /// runner's own server through `$TMUX`. That is why a bare `tmux
    /// kill-session` is the right remedy HERE and the wrong one on
    /// `forge-runner master status`, where the reader is an operator in a shell
    /// of their own and the runner's socket is not the default server.
    StaleCapability {
        session: String,
        pane: String,
    },
    /// Core could not be asked which MCP servers this project declares, so no
    /// pane was started: one started now would carry none of them and no
    /// record would say why (ISS-1235). `detail` names the route and what it
    /// met.
    ServersUnreadable {
        detail: String,
    },
    /// The project declares MCP servers and the file handing them to a pane
    /// could not be written, so no pane was started for the same reason.
    ServersUnwritable {
        detail: String,
    },
}

impl std::fmt::Display for Unplaced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Draining { status } => write!(
                f,
                "this box's runner for it is `{status}`, so it starts no work and places no master until that changes"
            ),
            Self::NoRepoPath => write!(
                f,
                "core serves it to this box but nothing here says where its checkout is — bind it, or set the runner's repo_path"
            ),
            Self::NoTerminal => write!(
                f,
                "this box has no tmux, so it can host no master pane for any project"
            ),
            Self::RegisterFailed { detail } => write!(
                f,
                "core refused this box's master registration for it: {detail}"
            ),
            Self::SkillMissing { detail } => write!(
                f,
                "the forge-master skill could not be installed into its checkout: {detail}"
            ),
            Self::NothingAdmissible => write!(
                f,
                "it has nothing claimable and no pane of its own running, so this box started none"
            ),
            Self::StoodDown {
                by,
                why,
                slug,
                pane,
            } => {
                write!(f, "its master was stood down by {by}")?;
                if let Some(w) = why {
                    write!(f, " ({w})")?;
                }
                match pane {
                    None => write!(
                        f,
                        " — this box places none for it and nudges none. `forge-runner master stand-up {slug}` is the one act that lets it be placed again"
                    ),
                    Some(pane) => write!(
                        f,
                        " — nothing here adopts it as this box's master, nudges it or ends it. Either `tmux kill-session -t {pane}` to make the box's two answers agree, or `forge-runner master stand-up {slug}` to put the project back under this box's authority"
                    ),
                }
            }
            Self::StandingUnreadable { detail } => write!(
                f,
                "this box cannot read whether its owner stood this project down ({detail}), so it places no master rather than deciding it is driving. A box that cannot tell a stood-down project from a driving one must not decide it is driving"
            ),
            Self::ServersUnreadable { detail } => write!(
                f,
                "this box could not read which MCP servers it declares ({detail}), so it started no master rather than one carrying none of them. The next sweep whose read succeeds places one"
            ),
            Self::ServersUnwritable { detail } => write!(
                f,
                "it declares MCP servers and the file that hands them to a pane could not be written ({detail}), so this box started no master rather than one carrying none of them"
            ),
            Self::StaleCapability { session, pane } => write!(
                f,
                "its pane {pane} is up but this box cannot hear it — the capability that pane holds names a session core has since replaced, core's session for it is now {session}, and a running pane cannot be handed a new capability. Every declaration it makes is refused and it is not being nudged while it stands like this. `tmux kill-session -t {pane}` ends it, which is what lets a master carrying the current capability be placed — placement itself still answers to the same gates as any other"
            ),
        }
    }
}

impl Unplaced {
    /// What to say before the reason.
    ///
    /// Every reason but one is a report that no pane was placed. The
    /// contradiction is a report that one IS running and this box will not
    /// drive it, and leading that with "no master pane placed" states the
    /// opposite of what an operator finds on the box (ISS-1118 criterion 20).
    fn lead(&self) -> String {
        match self {
            Self::StoodDown {
                pane: Some(pane), ..
            } => format!("{pane} is RUNNING and this box is not driving it"),
            Self::StaleCapability { pane, .. } => {
                format!("{pane} is RUNNING and this box cannot be heard by it")
            }
            _ => "no master pane placed".to_string(),
        }
    }

    /// Whether this is a state an operator has to act on before the box's two
    /// answers agree.
    ///
    /// Three of them are. A pane running against a stand-down is the nine-hour
    /// silence ISS-1118 was filed over; a standing this box could not read is a
    /// box that cannot say what it is doing; a pane whose capability is stale
    /// is the four-hour silence ISS-1099 was filed over, and no sweep resolves
    /// it. Everything else here is a pane absent for a reason the box is
    /// content with.
    fn is_error(&self) -> bool {
        matches!(
            self,
            Self::StoodDown { pane: Some(_), .. }
                | Self::StandingUnreadable { .. }
                | Self::StaleCapability { .. }
                | Self::ServersUnreadable { .. }
                | Self::ServersUnwritable { .. }
        )
    }
}

/// What this sweep could establish about one project's standing.
///
/// Three values and not two. Folding "the ledger could not be asked" into "no
/// stand-down" is what would let a box whose ledger is unreadable place the
/// very pane its owner withheld, and it would do it in silence.
enum StandingRead {
    /// The ledger answered, with a row or with nothing.
    Known(Option<MasterStanding>),
    /// It could not be asked, or it refused, and this is what to say.
    Unreadable(String),
}

fn read_standing(ledger: Option<&Ledger>, project_id: &str) -> StandingRead {
    let Some(led) = ledger else {
        return StandingRead::Unreadable(
            "this box's ledger could not be opened at all, so nothing here can say what its owner decided about this project".into(),
        );
    };
    match led.master_standing(project_id) {
        Ok(row) => StandingRead::Known(row),
        Err(e) => StandingRead::Unreadable(format!("the standing could not be read: {e}")),
    }
}

/// What a project's recorded standing says this sweep may do about its pane
/// (ISS-1118).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placed {
    /// Nothing withholds a pane: place it on the same terms as always.
    Proceed,
    /// Stood down and no pane is up. This sweep places none.
    Withheld,
    /// Stood down and a pane is up anyway. This sweep reports it and neither
    /// adopts it as a driving master nor nudges it; it does not end it either,
    /// because the daemon stopped killing master panes (ISS-933).
    Contradicted,
}

/// The whole of the stand-down decision, as a function of the two facts it
/// turns on.
///
/// A lifted stand-down proceeds: `stand-up` restores a project to the gates
/// every other project answers to rather than to a guaranteed pane.
fn stood_down_reason(
    standing: Option<&MasterStanding>,
    slug: &str,
    pane: Option<&str>,
) -> Unplaced {
    Unplaced::StoodDown {
        by: standing.map_or_else(|| "somebody".to_string(), |s| s.stood_down_by.clone()),
        why: standing.and_then(|s| s.why.clone()),
        slug: slug.to_string(),
        pane: pane.map(str::to_string),
    }
}

/// How long a lifted stand-down held, for the pane placed after it. `None`
/// while it still stands, and `None` on a row whose two stamps cannot make an
/// interval — a clock that went backwards is not a fact to tell a master.
fn stood_down_interval(standing: &MasterStanding) -> Option<Duration> {
    let up = standing.stood_up_at?;
    u64::try_from(up - standing.stood_down_at)
        .ok()
        .map(Duration::from_secs)
}

fn placement_under(standing: Option<&MasterStanding>, pane_alive: bool) -> Placed {
    match standing {
        Some(s) if s.stands() && pane_alive => Placed::Contradicted,
        Some(s) if s.stands() => Placed::Withheld,
        _ => Placed::Proceed,
    }
}

struct MasterState {
    session_id: String,
    name: String,
    /// When this project's pool last held anything at all.
    last_work: Instant,
    /// The work this master was last nudged about, when, and what its own hooks
    /// had reported by then.
    last_nudge: Option<Nudge>,
    mcp_stale_reported: bool,
}

/// One nudge, and the evidence a later sweep judges it by.
#[derive(Debug, Clone, Copy)]
struct Nudge {
    digest: u64,
    at: Instant,
    /// The master's submitted-prompt count at the moment it was nudged, or `None`
    /// where the session had never reported to `agent_activity` at all. A later
    /// count strictly above this one is the proof that a turn BEGAN after the
    /// nudge, which is the only thing that makes the nudge answered.
    prompts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SinceNudge {
    Unreported,
    /// Not one prompt submitted since the nudge: it is sitting in a composer, or
    /// the pane never ran it.
    NoTurn,
    /// A turn began after the nudge and is still running, or a child of it is.
    Working,
    /// A turn began after the nudge and stopped on a question a human owes.
    AwaitingPermission,
    /// A turn began after the nudge and ended on an API or model error.
    Failed,
    /// A turn began after the nudge and ended.
    Ran,
}

/// Read the evidence for one master, off what that session reported.
fn since_nudge(seen: Option<&agent_activity::Activity>, sent_at: Option<u64>) -> SinceNudge {
    let (Some(now), Some(then)) = (seen, sent_at) else {
        return SinceNudge::Unreported;
    };
    if now.prompts <= then {
        return SinceNudge::NoTurn;
    }
    match now.doing() {
        // A master's children are its dispatched runs, and the next nudge's own
        // prompt clears any whose end was lost, so for a master a lead that
        // ended over them is still work in flight.
        agent_activity::Doing::Working | agent_activity::Doing::AwaitingChildren => {
            SinceNudge::Working
        }
        agent_activity::Doing::AwaitingPermission => SinceNudge::AwaitingPermission,
        agent_activity::Doing::Idle => {
            if now.turn_ended_failed {
                SinceNudge::Failed
            } else {
                SinceNudge::Ran
            }
        }
    }
}

fn retry_owed(since: SinceNudge) -> bool {
    match since {
        SinceNudge::Unreported | SinceNudge::NoTurn | SinceNudge::Failed => true,
        SinceNudge::Working | SinceNudge::AwaitingPermission | SinceNudge::Ran => false,
    }
}

fn work_digest(admissible: &[AdmissibleIssue]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut lines: Vec<String> = Vec::with_capacity(admissible.len());
    for a in admissible {
        let mut rels: Vec<String> = a
            .relations
            .iter()
            .filter(|r| r.kind == DISPATCH_GATING_KIND)
            .map(|r| {
                format!(
                    "{}|{}",
                    r.depends_on_key.as_deref().unwrap_or(""),
                    r.blocker_status.as_deref().unwrap_or(""),
                )
            })
            .collect();
        rels.sort_unstable();
        lines.push(format!(
            "issue:{}|{}|{}",
            a.issue_id,
            a.status,
            rels.join(";")
        ));
    }
    lines.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for line in lines {
        line.hash(&mut h);
    }
    h.finish()
}

/// Whether this master is owed a nudge now.
///
/// `held` is a master whose account refused its last turn for capacity. What
/// its hooks say about that turn is no evidence the pass happened: a refused
/// turn ends like one that ran, and the runs it dispatched die on the same
/// limit without reporting their end, which reads as a pass still working. So a
/// held master is asked again every refresh window whatever `since` says —
/// capacity an operator restores out of band is seen only by a turn that tries
/// (ISS-1248). The window binds it even when the work changed: every turn it is
/// sent is refused until capacity returns, and the set a held master is asked
/// over can swing every sweep while its own cut-short runs come and go.
fn nudge_due(
    prev: Option<Nudge>,
    digest: u64,
    now: Instant,
    since: SinceNudge,
    held: bool,
) -> bool {
    let window_passed = |last: Nudge| now.saturating_duration_since(last.at) >= NUDGE_REFRESH;
    match prev {
        None => true,
        Some(last) if held => window_passed(last),
        Some(last) if last.digest != digest => true,
        Some(last) => window_passed(last) && retry_owed(since),
    }
}

/// The capacity refusal this master's pane is sitting behind, if any.
///
/// `newest` is the newest decisive record in the conversation `conversation`
/// names. It holds the pane when it is a quota refusal and the pane's own hooks
/// contradict neither half of that reading: they name no other conversation,
/// and they report no turn begun after the refusal was written. Hooks that have
/// reported nothing veto nothing — a daemon that has just adopted a pane has
/// heard nothing from it yet, and that pane is exactly the one left parked.
fn held_by_limit(
    newest: Option<&master_limit::Decisive>,
    conversation: Option<&str>,
    seen: Option<&agent_activity::Activity>,
) -> Option<master_limit::Refusal> {
    let newest = newest?;
    let refusal = master_limit::quota_refusal(newest)?;
    if let Some(seen) = seen {
        if let (Some(heard), Some(read)) = (seen.conversation.as_deref(), conversation) {
            if heard != read {
                return None;
            }
        }
        let refused_at_ms = newest.at * 1000 + i64::from(newest.millis);
        if seen.turn_started_at.is_some_and(|t| t > refused_at_ms) {
            return None;
        }
    }
    Some(refusal.clone())
}

/// Whether this master is a candidate for a nudge at all this sweep.
///
/// A pass the account refused is one the master still owes itself, and the
/// runs that pass dispatched hold their issues out of the admissible set while
/// they stand — so an empty set is no reason to leave a refused master unasked.
fn asked_this_sweep(admissible: &[AdmissibleIssue], held: Option<&master_limit::Refusal>) -> bool {
    !admissible.is_empty() || held.is_some()
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn live_for_project(&self, project_id: &str) -> Option<(String, String)> {
        self.get(project_id)
    }

    fn get(&self, project_id: &str) -> Option<(String, String)> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .get(project_id)
            .map(|m| (m.session_id.clone(), m.name.clone()))
    }

    fn remember(&self, project_id: &str, state: MasterState) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.live.insert(project_id.to_string(), state);
    }

    /// This project's pool held something; the idle clock restarts.
    fn note_work(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.last_work = Instant::now();
        }
    }

    /// True the first time a project's live pane is found behind its config,
    /// and false every sweep after, until the pane matches again.
    fn claim_mcp_stale(&self, project_id: &str) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            // Not in this process's registry — a pane it did not start, and one
            // it has therefore never reported. Say it.
            return true;
        };
        if m.mcp_stale_reported {
            return false;
        }
        m.mcp_stale_reported = true;
        true
    }

    /// The pane matches again; the next mismatch is worth saying.
    fn clear_mcp_stale(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get_mut(project_id) {
            m.mcp_stale_reported = false;
        }
    }

    /// Record what this box now says about a pane's capability, and answer
    /// whether that is a change from what it last said.
    ///
    /// Answers `true` for a project it has said nothing about yet, whether or
    /// not this daemon holds a live master for it: a project absent from the
    /// registry is one nothing here has ever reported, so the first thing said
    /// about it is a change.
    ///
    /// The latch used to live on the `reg.live` entry, which `remember` fills
    /// and which is empty for every project on a daemon that has just started.
    /// A caller reached before `ensure_master` therefore asked a latch that
    /// answered "already said" about a project nothing had said anything about,
    /// and the report was lost. ISS-1118's two reports route through
    /// `note_unplaced` for a reason of their own — they are about a project
    /// that reaches no pane at all — and that stands whichever way this answers.
    /// Hold, or release, the knowledge that this project's capability map
    /// names a session for a pane that was never placed.
    fn note_unwithdrawn(&self, project_id: &str, session_id: Option<&str>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        match session_id {
            Some(id) => reg
                .unwithdrawn
                .insert(project_id.to_string(), id.to_string()),
            None => reg.unwithdrawn.remove(project_id),
        };
    }

    fn unwithdrawn_for(&self, project_id: &str) -> Option<String> {
        self.0
            .lock()
            .expect("masters poisoned")
            .unwithdrawn
            .get(project_id)
            .cloned()
    }

    fn note_capability(&self, project_id: &str, said: &'static str) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let changed = reg.said.get(project_id) != Some(&said);
        reg.said.insert(project_id.to_string(), said);
        changed
    }

    /// Whether the box-level account of deaf masters this sweep reached is
    /// news, and remember it either way.
    ///
    /// `None` is a sweep that found none: it clears the latch and answers
    /// `false`, because a fleet that is well is not a thing to announce. The
    /// latch is the same rule `note_capability` holds for one project, moved up
    /// to the box — a condition that persists is stated on the sweep that
    /// reaches it and not on all forty-five after it.
    fn claim_deaf_report(&self, digest: Option<String>) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let news = digest.is_some() && reg.deaf_said != digest;
        reg.deaf_said = digest;
        news
    }

    fn claim_nudge(
        &self,
        project_id: &str,
        digest: u64,
        seen: Option<&agent_activity::Activity>,
        held: bool,
    ) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            return false;
        };
        let now = Instant::now();
        let since = since_nudge(seen, m.last_nudge.and_then(|n| n.prompts));
        if !nudge_due(m.last_nudge, digest, now, since, held) {
            return false;
        }
        m.last_nudge = Some(Nudge {
            digest,
            at: now,
            prompts: seen.map(|a| a.prompts),
        });
        true
    }

    /// How long this project has had nothing, or `None` if it has no master.
    fn idle_for(&self, project_id: &str) -> Option<Duration> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live.get(project_id).map(|m| m.last_work.elapsed())
    }

    fn forget(&self, project_id: &str) -> Option<String> {
        let mut reg = self.0.lock().expect("masters poisoned");
        // The unwithdrawn marker goes with it. It says one thing — this
        // project's capability map names a session no pane holds — and a
        // project this box is no longer tracking has no pane for it to be
        // about. Left behind, it is a session id waiting to be matched by
        // whatever core hands out next (ISS-1208).
        reg.unwithdrawn.remove(project_id);
        reg.live.remove(project_id).map(|m| m.session_id)
    }

    pub fn project_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .iter()
            .find(|(_, m)| m.session_id == session_id)
            .map(|(project_id, _)| project_id.clone())
    }

    /// Record what core just answered for this device, or why it could not be
    /// read.
    pub(crate) fn note_served(&self, served: Served) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.served = served;
    }

    pub(crate) fn note_unplaced(&self, project_id: &str, why: Unplaced) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let changed = reg.unplaced.get(project_id) != Some(&why);
        reg.unplaced.insert(project_id.to_string(), why);
        changed
    }

    /// This project's pane was placed; nothing stands against it any more.
    pub(crate) fn clear_unplaced(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.unplaced.remove(project_id);
    }

    pub fn why_unplaced(&self, project_id: &str) -> String {
        let reg = self.0.lock().expect("masters poisoned");
        if let Some(m) = reg.live.get(project_id) {
            return format!(
                "this box's master for {project_id} is session {} in pane {}, and your capability names a different session — it was minted for a session core has since replaced, so this pane's capability is stale and nothing this daemon does will place it. A pane cannot be handed a new capability: end this one, and a fresh master starts for {project_id} in its place",
                m.session_id, m.name
            );
        }
        match &reg.served {
            Served::Unread => format!(
                "this box has not yet read which projects it serves, so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Unreadable(why) => format!(
                "this box could not read which projects it serves ({why}), so it cannot say whether it serves {project_id} at all — nothing here has an answer for you yet"
            ),
            Served::Read(ids) if !ids.iter().any(|id| id == project_id) => format!(
                "this box does not serve {project_id} — core's last answer for this device named {} project(s) and that was not one of them, so no sweep here will place a master for it",
                ids.len()
            ),
            Served::Read(_) => match reg.unplaced.get(project_id) {
                Some(why) => format!(
                    "this daemon has placed no master for {project_id}: {why}. That is the state its last sweep found, and the next sweep finds the same until it changes"
                ),
                None => format!(
                    "this daemon does not yet hold a master session for {project_id}; its next sweep places one, and a declaration made after that is served"
                ),
            },
        }
    }

    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

#[derive(Debug, Clone)]
pub enum Wake {
    /// Core published `master.wake` on this box's device room (ISS-933).
    Core { project_id: Option<String> },
    /// This box's websocket came back up, so anything published while it was
    /// down is gone — `rooms.ts:publish` has no buffer and no replay.
    Reconnect,
}

impl Wake {
    fn describe(&self) -> String {
        match self {
            Wake::Core {
                project_id: Some(p),
            } => format!("core, project {p}"),
            Wake::Core { project_id: None } => "core".into(),
            Wake::Reconnect => "websocket reconnected — catch-up read".into(),
        }
    }
}

/// A sender for [`Wake`], sized so a burst coalesces instead of queueing.
pub fn wake_channel() -> (mpsc::Sender<Wake>, mpsc::Receiver<Wake>) {
    mpsc::channel(1)
}

pub async fn run(
    client: CoreClient,
    cfg: Config,
    masters: Arc<Masters>,
    activity: Arc<agent_activity::Activities>,
    job_panes: Arc<JobPanes>,
    job_records: Arc<dyn Records>,
    adopted: tokio::sync::watch::Receiver<bool>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    mut wake: mpsc::Receiver<Wake>,
) {
    let mut delay = POLL_INTERVAL;
    let mut last_sweep = Instant::now();
    let mut account_limit_said: Option<String> = None;
    let mut ledger = match Ledger::default_path().and_then(|p| Ledger::open(&p)) {
        Ok(l) => Some(l),
        Err(e) => {
            tracing::error!("[master] ledger unavailable ({e}) — no master will retire itself");
            None
        }
    };
    let tokens = session_tokens::default_path().map(session_tokens::SessionTokens::at);
    if tokens.is_none() {
        tracing::error!(
            "[master] the control capability map cannot be resolved on this box — no master pane can be minted a capability, and none will be started"
        );
    }
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Whether a runner row's status lets this box take work for its project, and
/// so whether it places a master for it at all.
///
/// Public because `forge-runner master status` answers the same question to an
/// operator, and two copies of this rule is a box that says one thing and does
/// another. `draining` and `disabled` both land here, which is why neither is
/// the control that stops a resident master (ISS-1118).
pub fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

fn next_poll_delay(served: &[runners::MeRunner]) -> Duration {
    let mut soonest: Option<u64> = None;
    for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
        match r.rate_limited_for_seconds {
            Some(secs) if secs > 0 => {
                soonest = Some(soonest.map_or(secs, |s: u64| s.min(secs)));
            }
            _ => return POLL_INTERVAL,
        }
    }
    match soonest {
        None => POLL_INTERVAL,
        Some(secs) => Duration::from_secs(secs).clamp(POLL_INTERVAL, LIMITED_POLL_INTERVAL),
    }
}

async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let now_unix = master_limit::now_unix();
    let mut account_said: Vec<master_limit::Decisive> = Vec::new();
    let mut deaf_found: Vec<Deaf> = Vec::new();
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            masters.note_served(Served::Unreadable(e.to_string()));
            return POLL_INTERVAL;
        }
    };
    masters.note_served(Served::Read(
        served.iter().map(|r| r.project_id.clone()).collect(),
    ));
    match crate::mcp::config::sweep_orphaned_sessions(
        &served.iter().map(|r| r.slug.clone()).collect::<Vec<_>>(),
    ) {
        Ok(left) => {
            for (path, why) in left {
                tracing::error!(
                    "[master] {} belongs to a project this box no longer serves and could not be removed: {why} — it holds that project's rendered integration credentials",
                    path.display()
                );
            }
        }
        Err(e) => tracing::error!(
            "[master] could not read {} to check for the configs of projects this box no longer serves: {e} — rendered integration credentials may be sitting there and this pass did not look",
            crate::mcp::config::session_dir().display()
        ),
    }
    let delay = next_poll_delay(&served);
    if delay > POLL_INTERVAL {
        for r in served.iter().filter(|r| accepts_new_work(&r.status)) {
            tracing::info!(
                "[master] {}: rate-limited ({}) — still sweeping, next pass in {}s",
                r.slug,
                r.limit_reason.as_deref().unwrap_or("unknown"),
                delay.as_secs()
            );
        }
    }

    for runner in &served {
        if !accepts_new_work(&runner.status) {
            tracing::info!(
                "[master] {}: runner is {} — taking no new work; anything already running finishes",
                runner.slug,
                runner.status
            );
            // A box taking no work still meets the contradiction, and the
            // louder reason wins the one slot this project has: `draining`
            // explains an absent pane, never a pane that is up and never a
            // standing this box could not read. Overwriting either would hide
            // it AND make every unchanged sweep look like a change, which is
            // the repetition `note_unplaced` exists to stop.
            let read = read_standing(ledger.as_ref(), &runner.project_id);
            let verdict = standing_verdict(masters, read, &runner.project_id, &runner.slug).await;
            if matches!(verdict, Some((Placed::Proceed | Placed::Withheld, _))) {
                masters.note_unplaced(
                    &runner.project_id,
                    Unplaced::Draining {
                        status: runner.status.clone(),
                    },
                );
            }
            supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
        take_pool_job(
            client,
            cfg,
            &served,
            job_panes,
            job_records,
            adopted,
            tokens,
            runner,
        )
        .await;

        // The owner's veto, read off the ledger this sweep already holds and
        // decided before anything is asked of core. A stand-down governs the
        // resident master and nothing else, which is why it sits AFTER
        // `take_pool_job`: the box goes on taking pool jobs for a project whose
        // master is stood down (ISS-1118).
        let read = read_standing(ledger.as_ref(), &runner.project_id);
        let Some((placed, standing)) =
            standing_verdict(masters, read, &runner.project_id, &runner.slug).await
        else {
            continue;
        };
        match placed {
            Placed::Proceed => {}
            Placed::Withheld => {
                say_unplaced(
                    masters,
                    &runner.project_id,
                    &runner.slug,
                    stood_down_reason(standing.as_ref(), &runner.slug, None),
                );
                continue;
            }
            Placed::Contradicted => continue,
        }
        let pane_name = terminal::session_name(terminal::MASTER_PREFIX, &runner.slug);
        let lifted_interval = standing.as_ref().and_then(stood_down_interval);

        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        let placement = placement_for(&admissible);
        if placement == Placement::AdoptOnly {
            if retire_if_idle(
                client,
                masters,
                ledger,
                tokens,
                &runner.project_id,
                &runner.slug,
            )
            .await
            {
                continue;
            }
        } else {
            masters.note_work(&runner.project_id);
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                if !admissible.is_empty() {
                    tracing::error!(
                        "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                    );
                }
                say_unplaced(masters, &runner.project_id, &slug, Unplaced::NoRepoPath);
                continue;
            }
        };

        let stored_conversation = ledger
            .as_ref()
            .and_then(|led| led.master_for_project(&runner.project_id).ok().flatten())
            .and_then(|row| row.conversation_id);
        let inherited: Vec<InheritedRun> = masters
            .get(&runner.project_id)
            .map(|(sid, _)| sid)
            .and_then(|sid| {
                ledger
                    .as_ref()
                    .map(|led| inherited_runs(led, &sid, &runner.project_id))
            })
            .unwrap_or_default();
        let told = std::sync::atomic::AtomicBool::new(false);
        let authority = AuthoritySink::default();
        let deaf = DeafSink::default();
        let pane = ensure_master(
            client,
            masters,
            &runner.project_id,
            &resolved,
            &Carryover {
                conversation: stored_conversation.as_deref(),
                inherited: &inherited,
                stood_down_for: lifted_interval,
                stood_down_told: &told,
            },
            placement,
            &CapabilityPorts {
                tokens,
                authority: &authority,
                deaf: &deaf,
            },
        )
        .await;
        // Written before the `Absent` gate below, because a verdict reached and
        // dropped is the defect this issue was reopened for: the sweep that
        // learns a pane is refused is the only one that knows it.
        if let Some(said) = authority.take() {
            write_authority(ledger.as_ref(), &runner.project_id, &resolved.slug, &said);
        }
        // Gathered here rather than reported here: one project's deaf pane is a
        // line, and a box whose whole fleet went deaf at once is a condition
        // nobody reads four quarters of (ISS-1208).
        if let Some(found) = deaf.take() {
            deaf_found.push(found);
        }
        if pane == PaneState::Absent {
            continue;
        }
        if told.load(std::sync::atomic::Ordering::Relaxed) {
            if let Some(led) = ledger.as_ref() {
                if let Err(e) = led.forget_lifted_standing(&runner.project_id) {
                    tracing::warn!(
                        "[master] {}: cannot clear the lifted stand-down a pane has now been told about: {e} — the next pane placed will be told the same interval again",
                        resolved.slug
                    );
                }
            }
        }
        // A stand-down can be written while this sweep is starting a pane. The
        // owner's act was already on the record when the placement finished, so
        // this sweep withdraws the pane IT placed rather than leaving one
        // running until the next pass. A pane it merely adopted is not ended
        // here: that one is somebody else's and ISS-933 took this daemon out of
        // the business of killing panes it did not start. The single condition
        // under which it does end an adopted pane is in the adopt branch of
        // `ensure_master` — a capability this box can prove it never minted,
        // which no later sweep can repair.
        let mut standing_unknown = false;
        if matches!(pane, PaneState::ColdStarted | PaneState::Resumed) {
            // An unreadable standing withholds a placement but never withdraws
            // one: withholding places nothing, and withdrawing ends a pane
            // nobody may have stood down. The next sweep meets the same
            // unreadable ledger at the gate above and withholds there. What it
            // does forfeit is the nudge, below — driving a pane while unable to
            // say whether the project is stood down is the fail-open this whole
            // read exists to close, one step later.
            let since = match read_standing(ledger.as_ref(), &runner.project_id) {
                StandingRead::Known(s) => s,
                StandingRead::Unreadable(detail) => {
                    tracing::error!(
                        "[master] {}: {pane_name} was just placed and this box cannot read back whether its owner stood the project down ({detail}). It is NOT being withdrawn — ending a pane on an unreadable record would take work nobody decided to end — and it is NOT being nudged either. If it was stood down, `forge-runner master kill {}` — a bare `tmux kill-session` typed in your own shell reaches a different tmux server than the one masters run on.",
                        runner.slug,
                        runner.slug
                    );
                    standing_unknown = true;
                    None
                }
            };
            if since.as_ref().is_some_and(MasterStanding::stands) {
                tracing::error!(
                    "[master] {}: {pane_name} was stood down while this sweep was starting it — withdrawing the pane this sweep placed. `forge-runner master stand-up {}` puts the project back under this box's authority.",
                    resolved.slug,
                    resolved.slug
                );
                // A withdrawal that failed leaves the pane up, so the reason
                // recorded against the project has to be the one that says a
                // pane is running — not the one that says none was placed.
                let mut left_running = None;
                if let Err(e) = terminal::kill(&pane_name).await {
                    tracing::error!(
                        "[master] {}: could not withdraw {pane_name}: {e} — it is running against a stand-down and `forge-runner master kill {}` is what ends it, a bare `tmux kill-session` in your own shell reaching a different tmux server than the one masters run on",
                        resolved.slug,
                        resolved.slug
                    );
                    left_running = Some(pane_name.clone());
                }
                if let Some((session_id, _)) = masters.get(&runner.project_id) {
                    end_master(
                        client,
                        masters,
                        tokens,
                        &runner.project_id,
                        &session_id,
                        "stood down while this sweep was placing it",
                    )
                    .await;
                }
                say_unplaced(
                    masters,
                    &runner.project_id,
                    &resolved.slug,
                    stood_down_reason(since.as_ref(), &resolved.slug, left_running.as_deref()),
                );
                continue;
            }
        }
        let last_said = account_record(
            &resolved.repo_path,
            stored_conversation.as_deref(),
            now_unix,
        );
        if let Some(said) = last_said
            .as_ref()
            .filter(|d| master_limit::is_fresh(d, now_unix))
        {
            account_said.push(said.clone());
        }
        if pane == PaneState::Resumed {
            let pane_boot = crate::runner::inflight::boot_identity().unwrap_or_default();
            if let (Some(led), Some((session_id, _))) =
                (ledger.as_mut(), masters.get(&runner.project_id))
            {
                match led.owe_resume_choices(&session_id, &pane_boot) {
                    Ok(0) => {}
                    Ok(n) => tracing::info!(
                        "[master] {}: resumed holding {n} run(s) — it must say what happens to each before declaring new work",
                        resolved.slug
                    ),
                    Err(e) => tracing::warn!(
                        "[master] {}: cannot mark the runs this pane inherited: {e}",
                        resolved.slug
                    ),
                }
            }
        }

        let reported = masters
            .get(&runner.project_id)
            .and_then(|(session_id, _)| activity.get(&session_id));
        let held = held_by_limit(
            last_said.as_ref(),
            stored_conversation.as_deref(),
            reported.as_ref(),
        );

        if !asked_this_sweep(&admissible, held.as_ref()) {
            continue;
        }

        if pane == PaneState::StaleCapability {
            continue;
        }

        if standing_unknown {
            continue;
        }

        if masters.claim_nudge(
            &runner.project_id,
            work_digest(&admissible),
            reported.as_ref(),
            held.is_some(),
        ) {
            nudge_master(masters, &runner.project_id, &resolved.slug, held.as_ref()).await;
        }
    }

    report_deaf_fleet(masters, &deaf_found);
    report_account_limit(client, &served, &account_said, account_limit_said, now_unix).await;
    report_job_capacity(cfg, job_panes, activity);

    let boot = crate::runner::inflight::boot_identity().unwrap_or_default();
    let sessions = run_record::CoreSessions(client);
    // The condition the gate is in as this run is told to core, stamped on the
    // run itself. `None` where the box cannot read its own config directory,
    // which records none rather than a gate that was clear.
    let gate = crate::daemon::control::config_dir().map(|dir| {
        crate::daemon::degraded::report(&dir, crate::daemon::agent_activity::now_ms()).degraded
    });
    let opened = run_record::open_declared_runs(&sessions, ledger, &boot, gate.as_ref()).await;
    let closed = run_record::close_ended_runs(&sessions, ledger, &boot).await;
    let choices_said = say_resume_choices(&CoreChoice(client), ledger, &boot).await;
    if choices_said > 0 {
        tracing::info!("[master] {choices_said} resume choice(s) said on their issues");
    }
    let held_said =
        held_report::report_held_worktrees(&held_report::CoreHeld(client), ledger, &boot).await;
    if held_said > 0 {
        tracing::info!("[master] {held_said} held checkout(s) reported onto their issues");
    }
    if opened > 0 || closed > 0 {
        tracing::info!("[run-record] {opened} run(s) opened at core, {closed} closed");
    }

    give_back_lost_runs(
        boot.as_str(),
        &PaneMasters { masters },
        &Reclaim {
            served: &served,
            cfg,
            procs: &SignalProbe,
            killer: &terminate::SystemProcesses,
            closer: &CoreRunState { client },
        },
        &CoreRunState { client },
        &CoreRunState { client },
        recovery::RunWatch {
            beat: &CoreBeat { client },
            idle: &PaneActivity { activity },
        },
        ledger,
    )
    .await;
    delay
}

/// Say, once, that this box can take no more work — and once again when it can.
///
/// Measured sid-xeon-1 2026-09-23: two finished job panes held both slots and
/// the daemon refused all eight bound projects 48 times in two minutes, one
/// `info!` at a time, each naming only the project it had just refused. Nothing
/// anywhere said the box as a whole had stopped, what was holding it, or
/// whether the sweep that returns a slot was still running — so the condition
/// was legible only to somebody who already suspected it.
///
/// The sweep's own last run is in the line because the slot comes back on that
/// sweep and nowhere else: a reader meeting this needs to know whether the
/// panes are working or the supervisor is not.
fn report_job_capacity(
    cfg: &Config,
    job_panes: &Arc<JobPanes>,
    activity: &agent_activity::Activities,
) {
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let holding = job_panes.holding();
    if holding.len() < bound {
        if job_panes.said_at_bound(None).is_some() {
            tracing::warn!(
                "[master] this box is under its job-pane ceiling again ({} of {bound} held) — the pool is claimable",
                holding.len()
            );
        }
        return;
    }
    let mark = holding
        .iter()
        .map(|h| h.job_id.as_str())
        .collect::<Vec<_>>()
        .join(",");
    if job_panes.said_at_bound(Some(mark.clone())).as_deref() == Some(mark.as_str()) {
        return;
    }
    let now = agent_activity::now_ms();
    let who = holding
        .iter()
        .map(|h| {
            // The same precedence the sweep itself reads on: what this daemon
            // has heard, and otherwise what the last one recorded.
            let said = h.watch.session_id().and_then(|s| activity.get(s));
            let seen = said.as_ref().map(job_exit::Reported::of).or(h.seen);
            let written_at = pool_jobs::written_at(said.as_ref(), h.transcript.as_deref());
            // A pane the next sweep is about to let go for having said nothing
            // at all must not read here as one merely waiting to be heard from:
            // that is the second answer to one question this line exists to
            // avoid giving.
            let phrase = match job_unheard::verdict(seen, h.noted_at, now) {
                job_unheard::Verdict::Unheard { .. } => job_unheard::HOLDING_PHRASE,
                job_unheard::Verdict::Keep => {
                    job_exit::holding_phrase(&h.watch, seen, written_at, now)
                }
            };
            // How long the slot has been held, from the pane's opening on its
            // record. A record with none was written by an older daemon, and
            // all this one can say is that the pane is older than its adoption.
            let held_for = match h.opened_at {
                Some(at) => job_exit::minutes(now.saturating_sub(at)),
                None => format!(
                    "at least {}",
                    job_exit::minutes(now.saturating_sub(h.noted_at))
                ),
            };
            format!("{} in {} for {held_for}, {}", h.job_id, h.pane, phrase)
        })
        .collect::<Vec<_>>()
        .join("; ");
    let swept = match job_panes.last_swept() {
        Some(at) => format!("{}s ago", now.saturating_sub(at) / 1000),
        None => "never since this daemon started".to_string(),
    };
    tracing::warn!(
        "[master] every project bound to this box is being refused the pool: all {bound} job slot(s) are held (max_job_panes = {bound}) — {who}. The job supervisor last swept {swept}."
    );
}

/// The newest decisive record in this master's own conversation, however old.
/// The report to core takes it only while it is fresh; the re-ask reads it
/// whatever its age.
fn account_record(
    repo: &std::path::Path,
    conversation: Option<&str>,
    now_unix: i64,
) -> Option<master_limit::Decisive> {
    let id = conversation.filter(|c| !c.is_empty())?;
    let path = conversation_transcript(repo, id)?;
    let tail = master_limit::read_tail(&path)?;
    master_limit::newest_record(&tail, now_unix)
}

/// The line a limit re-ask is announced by.
///
/// The reset is said and never waited on: the account can be swapped, topped
/// up or re-planned before it, and only the turn this nudge starts can tell.
fn limit_reask_line(slug: &str, pane: &str, refusal: &master_limit::Refusal) -> String {
    let reset = match refusal.resets_in_seconds {
        Some(secs) => format!("the account reports its reset in {secs}s"),
        None => "the account reported no reset".to_string(),
    };
    format!(
        "[master] {slug}: its last turn was refused ({}) — asking {pane} again; {reset}, and capacity restored before then is seen only by a turn that tries",
        refusal.reason.wire()
    )
}

const REPORT_TIMEOUT: Duration = Duration::from_secs(10);

async fn bounded<F>(call: F) -> crate::error::Result<()>
where
    F: std::future::Future<Output = crate::error::Result<()>>,
{
    match tokio::time::timeout(REPORT_TIMEOUT, call).await {
        Ok(result) => result,
        Err(_) => Err(crate::error::Error::Other(format!(
            "core did not answer within {}s",
            REPORT_TIMEOUT.as_secs()
        ))),
    }
}

async fn report_account_limit(
    client: &CoreClient,
    served: &[runners::MeRunner],
    said: &[master_limit::Decisive],
    memo: &mut Option<String>,
    now_unix: i64,
) {
    let core_limited = served.iter().any(|r| r.limit_reason.is_some());
    match master_limit::decide(said, core_limited, memo.as_deref(), now_unix) {
        master_limit::Action::Nothing => {}
        master_limit::Action::Unreadable(slug) => tracing::warn!(
            "[master] this box's Claude account refused a turn with `{slug}`, which this binary has not been taught to read — nothing was reported, so core will go on calling this box healthy until it is taught that name"
        ),
        master_limit::Action::Report(r, uuid) => {
            let sent = bounded(master_api::report_limit(
                client,
                r.reason.wire(),
                r.resets_in_seconds,
                &r.detail,
            ))
            .await;
            match sent {
                Ok(()) => {
                    tracing::warn!(
                        "[master] this box's Claude account is capped ({}{}) — reported to core: {}",
                        r.reason.wire(),
                        match r.resets_in_seconds {
                            Some(secs) => format!(", {secs}s to go"),
                            None => String::new(),
                        },
                        r.detail
                    );
                    *memo = Some(uuid);
                }
                Err(e) => tracing::warn!(
                    "[master] could not tell core this box's account is capped: {e} — sending it again next sweep"
                ),
            }
        }
        master_limit::Action::Clear => match bounded(master_api::clear_limit(client)).await {
            Ok(()) => {
                tracing::info!(
                    "[master] this box's Claude account answered a turn — the limit core was holding is lifted"
                );
                *memo = None;
            }
            Err(e) => tracing::warn!(
                "[master] could not lift this box's account limit at core: {e} — trying again next sweep"
            ),
        },
    }
}

async fn take_pool_job(
    client: &CoreClient,
    cfg: &Config,
    served: &[runners::MeRunner],
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    tokens: Option<&session_tokens::SessionTokens>,
    runner: &runners::MeRunner,
) {
    if !*adopted.borrow() {
        return;
    }
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let fallback = resolve_repo(served, cfg, &runner.project_id)
        .ok()
        .map(|r| r.repo_path);
    let took = pool_jobs::take_one(
        &pool_jobs::CorePool {
            client,
            limit: 20,
            deadline: crate::transport::pool::CALL_DEADLINE,
        },
        &pool_jobs::TmuxPanes,
        &pool_jobs::CoreReport { client },
        job_records,
        job_panes,
        &runner.project_id,
        job_panes.session_id(),
        fallback.as_deref(),
        bound,
        tokens,
    )
    .await;
    // What this pass learned about the read itself, on disk where `status`, the
    // heartbeat and a restart all find it (ISS-1234).
    if let Some(dir) = crate::daemon::control::config_dir() {
        pool_reads::note(&dir, &runner.project_id, &took, agent_activity::now_ms());
    }
    if let pool_jobs::Took::AtBound = took {
        // Per project and per pass, which is eight projects times six passes a
        // minute on the box this was measured on. What an operator reads is
        // `report_job_capacity`, once on the edge, for the box as a whole.
        tracing::debug!(
            "[master] {}: {} job pane(s) already open on this box (max_job_panes = {bound}) — taking no more this pass",
            runner.slug,
            job_panes.count()
        );
    }
}

struct Reclaim<'a> {
    served: &'a [runners::MeRunner],
    cfg: &'a Config,
    procs: &'a dyn recovery::ProcessLiveness,
    killer: &'a dyn terminate::ProcessGroup,
    closer: &'a dyn close_loop::RunCloser,
}

/// The same binding the release resolves, handed to the sweep that runs before
/// it: the close loop's worktree mark is a question about a repository's
/// registry, and this is where that repository is (ISS-1193).
impl recovery::RepoRoots for Reclaim<'_> {
    fn root_for(&self, project_id: &str) -> Option<std::path::PathBuf> {
        resolve_repo(self.served, self.cfg, project_id)
            .ok()
            .map(|r| r.repo_path)
    }
}

async fn release_held_tree(
    led: &mut Ledger,
    r: &recovery::Recovered,
    boot_id: &str,
    world: &Reclaim<'_>,
    sessions: &dyn close_loop::SessionReader,
    leases: &dyn close_loop::LeaseKeeper,
) -> bool {
    let Some(project) = r.project_id.as_deref() else {
        tracing::warn!(
            "[master] run {} is owed its worktree back but names no project, so no repo can be resolved for it",
            r.run_id
        );
        return false;
    };
    let resolved = match resolve_repo(world.served, world.cfg, project) {
        Ok(v) => v,
        Err(slug) => {
            tracing::warn!(
                "[master] run {} holds a worktree but {slug} has no repo path on this box — bind it or set the runner's repo_path; the tree stays until it does",
                r.run_id
            );
            return false;
        }
    };
    match terminate::release(
        led,
        &r.run_id,
        terminate::Forcing {
            this_boot: boot_id,
            repo_root: &resolved.repo_path,
            base_branch: resolved.base_branch.as_deref(),
            by: "recovery",
            reason: r.release_reason(),
        },
        terminate::Ports {
            procs: world.killer,
            sessions,
            leases,
        },
        now_secs(),
    )
    .await
    {
        Ok(terminate::Release::Done(forced)) => {
            tracing::info!(
                "[master] run {} reclaimed by {:?}: diff {:?}, checkout {:?}, commits {:?}, close {:?}",
                r.run_id,
                forced.verb,
                forced.salvage.as_ref().map(|s| s.outcome),
                forced.worktree,
                forced.commits,
                forced.close
            );
            forced.close.is_closed()
        }
        // Said once at the head of the window and then left alone: the
        // sweep runs every twenty seconds, and a line per sweep is how a
        // refusal that mattered got lost among nine hundred that did not.
        Ok(terminate::Release::Refusing {
            why,
            first,
            standing_secs: _,
        }) => {
            if first {
                tracing::warn!(
                    "[master] run {} could not be released: {why} — trying again each sweep for the next {}s",
                    r.run_id,
                    terminate::RELEASE_GRACE_SECS
                );
            }
            false
        }
        Ok(terminate::Release::Terminal { why, after, close }) => {
            tracing::error!(
                "[master] run {} will not be released and is over: {why}. {} — so it is not one a \
                 retry gets past. Its leases are back ({}/{}) and its checkout is still on disk, \
                 which nothing on this box will remove. Fix what the refusal names and run \
                 `forge-runner run release {}` to have the next sweep try again.",
                r.run_id,
                match after {
                    terminate::Decided::ByTheWindow { standing_secs } =>
                        format!("It stood for {standing_secs}s of retrying"),
                    terminate::Decided::ByTheAttempts { attempts } => format!(
                        "It was taken {attempts} times, and this box's clock never let the \
                         window it should have ended in arrive"
                    ),
                },
                close.leases_returned,
                close.leases_total,
                r.run_id
            );
            // Not `is_closed()`: the checkout is still there by decision, so
            // the run is over without that mark and the caller must not read
            // this as a close.
            true
        }
        Err(e) => {
            tracing::warn!("[master] run {} could not be released: {e}", r.run_id);
            false
        }
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

async fn report_run_death(run: Option<Run>, r: &recovery::Recovered, world: &Reclaim<'_>) {
    let Some(session_id) = r.session_id.as_deref() else {
        return;
    };
    let checkpoint = match run {
        Some(run) => Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        None => None,
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::Died,
            "the run's process is gone from this box",
            checkpoint,
        )
        .await
    {
        tracing::warn!(
            "[master] run {} is gone but core was not told ({e}) — its session falls to the ten-minute sweep",
            r.run_id
        );
    }
}

struct PaneActivity<'a> {
    activity: &'a agent_activity::Activities,
}

#[async_trait::async_trait]
impl recovery::RunActivity for PaneActivity<'_> {
    async fn reported(&self, session_id: &str) -> Option<run_exit::Reported> {
        let a = self.activity.get(session_id)?;
        Some(run_exit::Reported {
            doing: a.doing(),
            at: a.last_event_at,
            written_at: pool_jobs::written_at(Some(&a), None),
        })
    }
}

async fn end_run(led: &mut Ledger, run_id: &str, cause: run_exit::ExitCause, world: &Reclaim<'_>) {
    let Ok(Some(run)) = led.run(run_id) else {
        return;
    };
    let Some(pid) = run.pid else {
        return;
    };
    world.killer.kill(pid).await;
    let why = cause.reason();
    tracing::info!(
        "[master] run {run_id}: {why} — ending pid {pid}; its close loop starts on the next sweep"
    );
    let Some(session_id) = run.session_id.as_deref() else {
        return;
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::KilledIdle,
            &why,
            Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        )
        .await
    {
        tracing::warn!(
            "[master] run {run_id} was ended but core was not told why ({e}) — its session falls to the ten-minute sweep"
        );
    }
}

async fn give_back_lost_runs(
    boot_id: &str,
    live: &dyn recovery::MasterLiveness,
    world: &Reclaim<'_>,
    sessions: &dyn close_loop::SessionReader,
    leases: &dyn close_loop::LeaseKeeper,
    watch: recovery::RunWatch<'_>,
    ledger: &mut Option<Ledger>,
) {
    let Some(led) = ledger.as_mut() else { return };
    if boot_id.is_empty() {
        tracing::warn!("[master] this box reports no boot id — leaving unclosed runs alone");
        return;
    }
    let closing = recovery::Closing {
        sessions,
        leases,
        roots: world,
    };
    match recovery::reconcile(led, boot_id, live, world.procs, closing, watch).await {
        Ok(done) => {
            for r in done {
                if let Some(cause) = r.owed_exit {
                    end_run(led, &r.run_id, cause, world).await;
                    continue;
                }
                if r.owed_death_report {
                    report_run_death(led.run(&r.run_id).ok().flatten(), &r, world).await;
                }
                // A release owed and not finished has already said why: its
                // refusal at the head of its window, its decision at the end,
                // or the binding it could not resolve. Recovery has said once
                // why any other standing run stands. A line per sweep beside
                // either only repeats it (ISS-1220).
                if r.owed_release {
                    release_held_tree(led, &r, boot_id, world, sessions, leases).await;
                    continue;
                }
                if r.state.is_closed() || r.standing_said {
                    continue;
                }
                tracing::warn!(
                    "[master] run {} is partially closed: session_terminal={} checkout_returned={} leases={}/{}",
                    r.run_id,
                    r.state.session_terminal,
                    r.state.checkout_returned,
                    r.state.leases_returned,
                    r.state.leases_total
                );
            }
        }
        Err(e) => tracing::warn!("[master] reconcile failed: {e}"),
    }
}

const MASTER_SKILL: &str = include_str!("../../assets/forge-master-skill.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

fn install_hooks_logged(repo: &std::path::Path, slug: &str) {
    install_hooks_from(repo, slug, crate::exe::own());
}

/// The same with the resolution handed in, because both of its arms have to be
/// reachable from a test and this process's own binary is there while one runs.
fn install_hooks_from(
    repo: &std::path::Path,
    slug: &str,
    own: crate::error::Result<crate::exe::OwnExe>,
) {
    let exe = match own {
        Ok(exe) => exe,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: {e} — starting without hooks rather than installing commands that die at every call, so this session reports no turn boundaries and its dispatches reach no gate"
            );
            return;
        }
    };
    if let Some(was) = &exe.replaced_from {
        tracing::warn!(
            "[master] {slug}: the binary this daemon started on ({}) was replaced while it ran — its hooks name {}, the build standing there now",
            was.display(),
            exe.path.display()
        );
    }
    match crate::daemon::hook_install::install(repo, &exe.path) {
        Ok(path) => tracing::info!("[master] {slug}: hooks registered in {}", path.display()),
        Err(e) => tracing::warn!(
            "[master] {slug}: could not register hooks in {}: {e} — starting anyway, blind to this session's turn boundaries",
            repo.display()
        ),
    }
}

/// What telling core about a resume choice needs of it.
#[allow(async_fn_in_trait)]
pub trait ChoiceReporter {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> crate::error::Result<()>;
}

/// The live implementation, over this box's device credential.
pub struct CoreChoice<'a>(pub &'a CoreClient);

impl ChoiceReporter for CoreChoice<'_> {
    async fn report(
        &self,
        session_id: &str,
        run_id: &str,
        choice: &str,
        why: &str,
    ) -> crate::error::Result<()> {
        crate::transport::run_sessions::report_resume_choice(
            self.0,
            session_id,
            serde_json::json!({ "runId": run_id, "choice": choice, "why": why }),
        )
        .await
    }
}

pub(crate) async fn say_resume_choices(
    reporter: &impl ChoiceReporter,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let owed = {
        let Some(led) = ledger.as_ref() else { return 0 };
        match led.choices_awaiting_report(boot_id) {
            Ok(rows) => rows,
            Err(e) => {
                tracing::warn!("[master] cannot read recorded resume choices: {e}");
                return 0;
            }
        }
    };
    let mut said = 0;
    for run in owed {
        let Some(choice) = run.resume_choice.clone() else {
            continue;
        };
        let Some(session_id) = run.session_id.clone() else {
            tracing::warn!(
                "[master] run {}: this pane chose to {choice} and the choice cannot reach its issue — the run has no core session, which is what a run whose subagent never started looks like. It stands in the box ledger and nowhere a reader will find it",
                run.run_id
            );
            continue;
        };
        let why = run.resume_choice_why.clone().unwrap_or_default();
        match reporter.report(&session_id, &run.run_id, &choice, &why).await {
            Ok(()) => {
                if let Some(led) = ledger.as_mut() {
                    if let Err(e) = led.mark_resume_choice_said(&run.run_id) {
                        tracing::warn!(
                            "[master] run {}: core has the choice and the mark did not land: {e} — it will be said again",
                            run.run_id
                        );
                        continue;
                    }
                }
                said += 1;
            }
            Err(e) => tracing::warn!(
                "[master] run {}: core would not take the resume choice ({e}) — the next sweep tries again",
                run.run_id
            ),
        }
    }
    said
}

fn inherited_runs(led: &Ledger, master_session_id: &str, _project_id: &str) -> Vec<InheritedRun> {
    let Ok(runs) = led.unclosed_runs() else {
        return Vec::new();
    };
    runs.into_iter()
        .filter(|r| r.master_session_id == master_session_id && r.ended_by.is_none())
        .map(|r| InheritedRun {
            issue_keys: led
                .issues(&r.run_id)
                .map(|m| m.into_iter().map(|i| i.issue_key).collect())
                .unwrap_or_default(),
            run_id: r.run_id,
            worktree_path: r.worktree_path.display().to_string(),
            incarnation: r.incarnation.wire(),
            work: r.work.wire(),
            agent_id: r.agent_id,
            ended_by: r.ended_by,
        })
        .collect()
}

pub(crate) struct InheritedRun {
    pub run_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
}

/// What a pane placed after a stand-down was lifted is told about the gap.
///
/// The brief's first line asserts the reader is this project's master, and a
/// resumed conversation carries a transcript that ends mid-work. Without this,
/// a master stood down for nine hours wakes believing it was driving the whole
/// time (ISS-1118).
pub(crate) fn stood_up_brief(stood_down_for: Duration) -> String {
    let mins = stood_down_for.as_secs() / 60;
    let span = if mins >= 120 {
        format!("{} hours", mins / 60)
    } else if mins >= 1 {
        format!("{mins} minutes")
    } else {
        format!("{} seconds", stood_down_for.as_secs())
    };
    format!(
        "\nThis project was STOOD DOWN for {span} and has just been stood up again. This box \
placed no master for it over that interval and nudged none, so nothing you remember doing \
happened during it — whatever was decided about this project in that time was decided by \
somebody else, and the tracker is where it is written rather than in anything you recall. Read \
the board before you act on any intention you are carrying from before the gap.\n"
    )
}

pub(crate) fn resumed_brief(conversation: &str, runs: &[InheritedRun]) -> String {
    let mut out = format!(
        "\nThis pane was RESUMED, not started fresh: it is continuing conversation `{conversation}`, \
so what you remember of this project may be from before the interruption that ended the last pane.\n"
    );
    if runs.is_empty() {
        out.push_str(
            "\nNo run rows were left open under this master, so there is nothing to decide before \
you carry on.\n",
        );
        return out;
    }
    out.push_str(&format!(
        "\n{} run(s) were left open under this master. For EACH of them, before you declare any new \
work, record one of `continue`, `restart` or `leave` with your reason — the declaration will be \
refused until you have. These are the fields this box can state about each. It states them and \
judges none of them; the judgement is yours:\n",
        runs.len()
    ));
    for r in runs {
        out.push_str(&format!(
            "\n- run `{}`\n  issues: {}\n  worktree: {}\n  incarnation: {}\n  work: {}\n  subagent: {}\n  ended: {}\n",
            r.run_id,
            if r.issue_keys.is_empty() { "none recorded".to_string() } else { r.issue_keys.join(", ") },
            r.worktree_path,
            r.incarnation,
            r.work,
            r.agent_id.as_deref().unwrap_or("never bound"),
            r.ended_by.as_deref().unwrap_or("not ended"),
        ));
    }
    out.push_str(
        "\nRead the worktree and the issue before you choose. `continue` means the work stands and \
you will carry it on; `restart` means it does not and you will cut it again; `leave` means it is \
somebody else's to settle and you will touch neither. Whichever you pick, say why in your own \
words: the record is what the next reader has.\n",
    );
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PaneState {
    /// No master is up for this project and none could be started.
    Absent,
    /// A pane was already running and this daemon adopted it.
    Adopted,
    /// A pane was started with no conversation behind it.
    ColdStarted,
    /// A pane was started on the conversation its predecessor had.
    Resumed,
    /// A pane was already running and this daemon adopted it, but the
    /// capability it holds names a session this box no longer has. It is up and
    /// it is refused, so it is not worth a nudge.
    StaleCapability,
}

pub(crate) fn conversation_transcript(
    cwd: &std::path::Path,
    conversation_id: &str,
) -> Option<std::path::PathBuf> {
    let encoded: String = cwd
        .to_string_lossy()
        .chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect();
    Some(
        dirs_next::home_dir()?
            .join(".claude")
            .join("projects")
            .join(encoded)
            .join(format!("{conversation_id}.jsonl")),
    )
}

pub(crate) fn resume_for(
    slug: &str,
    repo: &std::path::Path,
    stored: Option<&str>,
) -> Option<String> {
    let id = stored.filter(|s| !s.is_empty())?;
    let Some(path) = conversation_transcript(repo, id) else {
        tracing::warn!(
            "[master] {slug}: conversation {id} is recorded for this project but this box cannot say where a transcript for it would live — it has no home directory to look under. Starting cold, so this pane begins with no memory of what its predecessor was doing"
        );
        return None;
    };
    if path.is_file() {
        tracing::info!("[master] {slug}: resuming conversation {id}");
        return Some(id.to_string());
    }
    tracing::warn!(
        "[master] {slug}: conversation {id} is recorded for this project but this box has no transcript for it at {} — starting cold, so this pane begins with no memory of what its predecessor was doing",
        path.display()
    );
    None
}

fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

/// What core answered about this project's declared MCP servers, or why it
/// could not be asked. Kept as the failure's own text so the refusal that
/// follows can name it.
type ServersRead = std::result::Result<mcp_servers::ProjectMcpServers, String>;

async fn project_mcp_servers(client: &CoreClient, project_id: &str) -> ServersRead {
    mcp_servers::fetch(client, project_id)
        .await
        .map_err(|e| e.to_string())
}

/// The declaration a new pane may be started with, or the reason none may be.
///
/// There is no third answer. Reading a failure as an empty declaration is what
/// started masters carrying none of their project's servers (ISS-1235).
fn servers_for_start(
    asked: &ServersRead,
) -> std::result::Result<&mcp_servers::ProjectMcpServers, Unplaced> {
    asked
        .as_ref()
        .map_err(|detail| Unplaced::ServersUnreadable {
            detail: detail.clone(),
        })
}

/// ISS-1208 ends a deaf pane only where a replacement would be placed. A
/// declaration that could not be read withholds the replacement below, so the
/// pane is left standing rather than ended for a placement that is refused.
pub(crate) fn replacement_gate(act: CapabilityAct, servers_readable: bool) -> CapabilityAct {
    match act {
        CapabilityAct::Replace if !servers_readable => CapabilityAct::LeaveDeaf(
            "this box could not read the project's declared MCP servers, so no replacement would be placed in its stead",
        ),
        other => other,
    }
}

/// Whether this box can honestly describe what it is about to hand a pane.
#[derive(Debug, PartialEq, Eq)]
enum LaunchRecord {
    /// The file on disk says exactly what the pane will be given.
    Truthful,
    /// The config could not be written, the project declares nothing, and the
    /// record now says the pane gets nothing — which is what it was owed.
    NoneAndSaysSo,
    /// The config could not be written and the project declares servers the
    /// pane would then lack, so no pane is started (ISS-1235).
    Withheld,
    /// A record of OTHER servers survives that the pane will not carry.
    Lying,
}

fn launch_record(wrote: bool, cleared: bool, declares_any: bool) -> LaunchRecord {
    match (wrote, cleared, declares_any) {
        (true, _, _) => LaunchRecord::Truthful,
        (false, false, _) => LaunchRecord::Lying,
        (false, true, true) => LaunchRecord::Withheld,
        (false, true, false) => LaunchRecord::NoneAndSaysSo,
    }
}

/// What a sweep may conclude about a live pane's MCP configuration.
#[derive(Debug, PartialEq, Eq)]
enum PaneConfig {
    /// Core could not be asked, so nothing about this pane is known.
    Unknown,
    /// The pane carries what core resolves now.
    Current,
    /// The pane cannot carry what core resolves now: an operator must end it.
    Stale,
}

fn pane_config(
    asked: Option<&mcp_servers::ProjectMcpServers>,
    on_disk_matches: bool,
) -> PaneConfig {
    match asked {
        None => PaneConfig::Unknown,
        Some(_) if on_disk_matches => PaneConfig::Current,
        Some(_) => PaneConfig::Stale,
    }
}

fn report_stale_pane_config(
    masters: &Arc<Masters>,
    project_id: &str,
    name: &str,
    slug: &str,
    asked: Option<&mcp_servers::ProjectMcpServers>,
) {
    let on_disk_matches = asked
        .map(|d| crate::mcp::config::session_matches(slug, &d.mcp_servers))
        .unwrap_or(false);
    let declared = match pane_config(asked, on_disk_matches) {
        PaneConfig::Unknown => return,
        PaneConfig::Current => {
            if let Some(d) = asked {
                let _ = crate::mcp::config::write_session(slug, &d.mcp_servers);
            }
            masters.clear_mcp_stale(project_id);
            return;
        }
        PaneConfig::Stale => asked.expect("Stale is only reachable with an answer"),
    };
    if !masters.claim_mcp_stale(project_id) {
        return;
    }
    tracing::error!(
        "[master] {slug}: the resident session {name} was started before this project's MCP servers were resolved, or before they last changed, so its runs do NOT have {}. A pane cannot be told a new MCP config — end it with `forge-runner master kill {slug}`, which reaches the tmux server masters run on where a bare `tmux kill-session` does not, and the next sweep starts one that carries them.",
        if declared.resolved_names.is_empty() {
            "the servers it now declares".to_string()
        } else {
            declared.resolved_names.join(", ")
        }
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Adopt a live pane, and start one where there is none.
    AdoptOrStart,
    /// Adopt a live pane, and start nothing.
    AdoptOnly,
}

pub(crate) fn placement_for(admissible: &[AdmissibleIssue]) -> Placement {
    if admissible.is_empty() {
        Placement::AdoptOnly
    } else {
        Placement::AdoptOrStart
    }
}

/// What a pane this sweep places carries over from whatever stood before it:
/// the conversation it resumes, the runs that conversation holds, and the
/// interval its project spent stood down.
pub(crate) struct Carryover<'a> {
    conversation: Option<&'a str>,
    inherited: &'a [InheritedRun],
    /// Set only for a pane placed after a stand-down was lifted, so a resumed
    /// conversation is not told merely that it is master again (ISS-1118).
    stood_down_for: Option<Duration>,
    /// Raised when the brief carrying `stood_down_for` actually reached a
    /// pane. The sweep forgets the lifted record only on this, because a pane
    /// that was adopted rather than started was sent no brief at all, and one
    /// whose brief failed to land was told nothing — forgetting on either
    /// would drop the interval undelivered.
    stood_down_told: &'a std::sync::atomic::AtomicBool,
}

/// The verdict `ensure_master` reached about the capability a pane holds, on
/// its way to somewhere a restart cannot erase it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Authority {
    /// The pane it is about, by name and by which incarnation of that name was
    /// running: the name is derived from the slug, so every pane this project
    /// ever has carries it and the name alone identifies nothing.
    pane: String,
    incarnation: Option<String>,
    /// One of `MasterAuthority`'s three.
    verdict: &'static str,
    /// Why the verdict is `unknown`, and `None` on the other two.
    detail: Option<String>,
}

/// Where `ensure_master` leaves that verdict for the sweep to write down.
///
/// An out-parameter rather than a return value because `ensure_master` has ten
/// exits and three of them reach a verdict, and rather than the `Ledger`
/// itself because a `rusqlite::Connection` is not `Sync`: holding one across
/// an await inside this spawned future makes the future itself unspawnable.
/// The same shape `Carryover::stood_down_told` already uses for the same
/// reason.
#[derive(Default)]
pub(crate) struct AuthoritySink(Mutex<Option<Authority>>);

impl AuthoritySink {
    fn set(
        &self,
        pane: &str,
        incarnation: Option<String>,
        verdict: &'static str,
        detail: Option<&str>,
    ) {
        *self.0.lock().expect("authority sink poisoned") = Some(Authority {
            pane: pane.to_string(),
            incarnation,
            verdict,
            detail: detail.map(str::to_string),
        });
    }

    fn take(&self) -> Option<Authority> {
        self.0.lock().expect("authority sink poisoned").take()
    }
}

/// What the box did about one pane it found deaf, for the single record the
/// sweep makes about the fleet.
///
/// Separate from `Authority`: that one says what a pane's capability IS and
/// goes to the ledger for every project on every sweep, while this says what
/// was DONE about it and exists only for the projects where there was
/// something to do. A pane replaced ends the sweep recorded `current`, so the
/// authority row alone cannot afterwards say the box found it deaf at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Deaf {
    slug: String,
    pane: String,
    acted: DeafAct,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DeafAct {
    /// Ended, and its replacement placed in the same pass.
    Replaced,
    /// Ended, and the placement that was to follow did not finish — the mint,
    /// the skill install, the MCP config or tmux itself refused, each of which
    /// already says so on its own.
    ///
    /// Not the same as leaving it standing and not the same as replacing it:
    /// the project has no pane at all until the next sweep, which is a third
    /// thing to tell a reader. This is what `end_deaf_pane` records, because
    /// ending is all it did; the placement path below it is what upgrades the
    /// answer once a pane is actually up.
    EndedUnplaced,
    /// Left running, with the reason the box did not end it.
    LeftStanding(String),
}

/// Where `ensure_master` leaves that, for the sweep to gather across projects.
#[derive(Default)]
pub(crate) struct DeafSink(Mutex<Option<Deaf>>);

impl DeafSink {
    fn set(&self, slug: &str, pane: &str, acted: DeafAct) {
        *self.0.lock().expect("deaf sink poisoned") = Some(Deaf {
            slug: slug.to_string(),
            pane: pane.to_string(),
            acted,
        });
    }

    /// A pane is up where one was ended, so what the box did is a replacement
    /// after all.
    ///
    /// Only over `EndedUnplaced`: a placement that followed no kill leaves the
    /// sink empty and this a no-op, and one that answered `LeftStanding`
    /// killed nothing to replace.
    fn placed(&self) {
        let mut held = self.0.lock().expect("deaf sink poisoned");
        if let Some(d) = held.as_mut() {
            if d.acted == DeafAct::EndedUnplaced {
                d.acted = DeafAct::Replaced;
            }
        }
    }

    fn take(&self) -> Option<Deaf> {
        self.0.lock().expect("deaf sink poisoned").take()
    }
}

/// What the box does about the capability a resident pane turned out to hold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CapabilityAct {
    /// Nothing: the pane can be heard, or this box cannot say that it cannot.
    Keep,
    /// End it and place one that carries a capability for the session core
    /// serves now.
    Replace,
    /// It cannot be heard and the box still leaves it running, for this reason.
    LeaveDeaf(&'static str),
}

/// The three conditions ISS-1208 puts on acting, read off the two facts that
/// carry them.
///
/// **The condition is precise.** Only `Stale` is evidence about a pane.
/// `Unknown` is evidence about this box's own capability map and says nothing
/// about any pane, so a map that could not be read never ends one — which is
/// the whole reason `capability_of` keeps three answers rather than two.
///
/// **A replacement would be placed.** `AdoptOrStart` is the sweep's own reading
/// that this project has admissible work; under `AdoptOnly` the placement path
/// below the adopt branch refuses to start anything, so ending the pane would
/// buy an empty project instead of a working master.
///
/// The other two of the three are already true wherever this is reached:
/// `ensure_master` returned early if tmux is absent, the sweep's stand-down
/// gate ran before it, and the command that resolves the condition is the one
/// the daemon has been printing for an operator to type since ISS-1099.
pub(crate) fn capability_act(verdict: &Capability, placement: Placement) -> CapabilityAct {
    match (verdict, placement) {
        (Capability::Stale, Placement::AdoptOrStart) => CapabilityAct::Replace,
        (Capability::Stale, Placement::AdoptOnly) => CapabilityAct::LeaveDeaf(
            "this project has no admissible work, so no replacement would be placed in its stead",
        ),
        (Capability::Current | Capability::Unknown(_), _) => CapabilityAct::Keep,
    }
}

/// The capability map's answer, overruled where this box knows that answer came
/// from a mint it could not take back.
///
/// `capability_of` reads the map, and the map is the only durable evidence
/// there is. Where a placement minted an entry and then placed no pane, the
/// withdrawal is what puts the map right — and a withdrawal that could not be
/// written leaves `Current` standing about a pane that was never replaced. The
/// box would then stop reporting the project deaf and go on nudging a pane that
/// refuses every declaration it makes, which is this issue's own incident with
/// the alarm taken out. Criterion 7 asks that the verdict STAY stale, which is
/// a claim about every later sweep and not only the one that found it.
///
/// `Unknown` is never overruled. A map this box could not read is not evidence
/// about any pane in either direction, and the rule that an unreadable map ends
/// nothing is older than this one.
pub(crate) fn verdict_over_unwithdrawn(
    verdict: Capability,
    unwithdrawn: Option<&str>,
    session_id: &str,
) -> Capability {
    match (&verdict, unwithdrawn) {
        (Capability::Current, Some(held)) if held == session_id => Capability::Stale,
        _ => verdict,
    }
}

/// What `ensure_master` is given to consult and to answer into: this box's own
/// capability map, the sink the verdict about it goes to, and the sink for what
/// was done where the verdict earned an act.
///
/// One struct rather than three parameters because `ensure_master` sits at
/// exactly the argument count `clippy::too_many_arguments` allows.
pub(crate) struct CapabilityPorts<'a> {
    tokens: Option<&'a session_tokens::SessionTokens>,
    authority: &'a AuthoritySink,
    deaf: &'a DeafSink,
}

async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
    carry: &Carryover<'_>,
    placement: Placement,
    ports: &CapabilityPorts<'_>,
) -> PaneState {
    let tokens = ports.tokens;
    let stored_conversation = carry.conversation;
    let inherited = carry.inherited;
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        say_unplaced(masters, project_id, &resolved.slug, Unplaced::NoTerminal);
        return PaneState::Absent;
    }

    if placement == Placement::AdoptOnly && !terminal::alive(&name).await {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    let session = match master_api::register(client, project_id, &name).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::RegisterFailed {
                    detail: e.to_string(),
                },
            );
            return PaneState::Absent;
        }
    };

    let asked = project_mcp_servers(client, project_id).await;

    // Whether the placement path below is a REPLACEMENT or an ordinary cold
    // start, which is the difference between `terminal::ensure` starting
    // nothing because the box is already served and starting nothing because
    // the pane this call ended is still standing (ISS-1208, criterion 7).
    let mut ended_a_deaf_pane = false;
    if terminal::alive(&name).await {
        if let Err(e) = &asked {
            tracing::warn!(
                "[master] {}: could not read this project's declared MCP servers from core ({e}), so whether {name} carries them is not known this sweep",
                resolved.slug
            );
        }
        report_stale_pane_config(
            masters,
            project_id,
            &name,
            &resolved.slug,
            asked.as_ref().ok(),
        );
        if masters.get(project_id).is_none() {
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            remember(masters, project_id, &session);
        }
        let pane_now = terminal::incarnation(&name).await;
        let verdict = verdict_over_unwithdrawn(
            capability_of(tokens, &session.session_id),
            masters.unwithdrawn_for(project_id).as_deref(),
            &session.session_id,
        );
        let act = replacement_gate(capability_act(&verdict, placement), asked.is_ok());
        if let CapabilityAct::LeaveDeaf(why) = act {
            ports.deaf.set(
                &resolved.slug,
                &name,
                DeafAct::LeftStanding(why.to_string()),
            );
        }
        // A pane this box has proved it can never hear again is ended here and
        // this function does NOT return: everything below the adopt branch is
        // the placement path, and falling into it is how the replacement comes
        // to hold a capability minted for the session registered moments ago.
        //
        // This is the one carve-out from the rule stated at the stand-down
        // withdrawal, where a pane this daemon merely adopted is left for
        // whoever owns it. ISS-933 took this daemon out of killing masters on a
        // timer; it did not decide this case, which ISS-1099 left open by name
        // and ISS-1208 closes — a master that cannot be heard is not a master,
        // and the operator who ends it adds no judgement this box does not
        // already hold.
        ended_a_deaf_pane = act == CapabilityAct::Replace
            && end_deaf_pane(&name, &resolved.slug, &session.session_id, ports.deaf).await;
        if !ended_a_deaf_pane {
            return match verdict {
                Capability::Current => {
                    masters.clear_unplaced(project_id);
                    masters.note_capability(project_id, MasterAuthority::CURRENT);
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::CURRENT, None);
                    PaneState::Adopted
                }
                Capability::Stale => {
                    // NOT `clear_unplaced`. The pane is up and this box cannot hear
                    // it, so the project has no working master and the registry has
                    // to say so — clearing it here erased the one record of why, at
                    // the moment the daemon learned it.
                    //
                    // `note_unplaced` and not `say_unplaced`, because the error
                    // below already carries this state to the journal and says more
                    // about it than the generic line would. Recording it twice is
                    // two entries for one event and a reader who cannot tell
                    // whether it happened once.
                    masters.note_unplaced(
                        project_id,
                        Unplaced::StaleCapability {
                            session: session.session_id.clone(),
                            pane: name.clone(),
                        },
                    );
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::STALE, None);
                    if masters.note_capability(project_id, MasterAuthority::STALE) {
                        tracing::error!(
                            "[master] {}: the resident session {name} holds a capability for a session this box no longer has — core's session for it is {}, nothing here ever minted a capability for that session, and a running pane cannot be handed one. Every declaration {name} makes is refused and nothing this daemon does changes that: `forge-runner master kill {}`, which reaches the tmux server masters actually run on where a bare `tmux kill-session` does not, and which is what lets a master carrying the current capability be placed — placement itself still answers to the same gates as any other. It is not being nudged while it stands like this. `forge-runner master status {}` says the same thing without this log.",
                            resolved.slug,
                            session.session_id,
                            resolved.slug,
                            resolved.slug
                        );
                    }
                    PaneState::StaleCapability
                }
                Capability::Unknown(why) => {
                    masters.clear_unplaced(project_id);
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::UNKNOWN, Some(&why));
                    if masters.note_capability(project_id, MasterAuthority::UNKNOWN) {
                        tracing::warn!(
                            "[master] {}: cannot tell whether {name}'s capability is current: {why}. Saying nothing about it rather than calling it stale — an unreadable map is not evidence about any pane.",
                            resolved.slug
                        );
                    }
                    PaneState::Adopted
                }
            };
        }
    }

    if placement == Placement::AdoptOnly {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    // Before anything is installed or minted: a pane that will not be started
    // leaves no capability behind it and nothing to withdraw.
    let declared = match servers_for_start(&asked) {
        Ok(declared) => declared,
        Err(why) => {
            say_unplaced(masters, project_id, &resolved.slug, why);
            return PaneState::Absent;
        }
    };

    if let Err(e) = install_skill(&resolved.repo_path) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::SkillMissing {
                detail: e.to_string(),
            },
        );
        return PaneState::Absent;
    }

    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    let mut env = terminal::pane_env();
    let mcp_config = match crate::mcp::config::write_session(&resolved.slug, &declared.mcp_servers)
    {
        Ok(path) => path,
        Err(e) => {
            let cleared = crate::mcp::config::clear_session(&resolved.slug);
            match (
                launch_record(false, cleared.is_ok(), !declared.mcp_servers.is_empty()),
                &cleared,
            ) {
                (LaunchRecord::Lying, Err(ce)) => {
                    tracing::error!(
                        "[master] {}: could not write the pane's MCP config ({e}) and could not remove the previous one either: refusing to start a master this box could not describe: {ce} — a pane started now would carry none of this project's servers while the file on disk still claims it carries them, so no later sweep could report it. Make {} writable and the next sweep starts one.",
                        resolved.slug,
                        crate::mcp::config::session_dir().display()
                    );
                    say_unplaced(
                        masters,
                        project_id,
                        &resolved.slug,
                        Unplaced::ServersUnwritable {
                            detail: format!("{e}; the previous config could not be removed: {ce}"),
                        },
                    );
                    return PaneState::Absent;
                }
                (LaunchRecord::Withheld, _) => {
                    say_unplaced(
                        masters,
                        project_id,
                        &resolved.slug,
                        Unplaced::ServersUnwritable {
                            detail: format!(
                                "{e}; declared: {}",
                                declared.resolved_names.join(", ")
                            ),
                        },
                    );
                    return PaneState::Absent;
                }
                _ => {
                    tracing::warn!(
                        "[master] {}: could not write the pane's MCP config ({e}); the project declares no servers, so the pane is started with none",
                        resolved.slug
                    );
                    None
                }
            }
        }
    };
    if let Some(path) = mcp_config.as_deref() {
        tracing::info!(
            "[master] {}: pane declares {} from {}",
            resolved.slug,
            declared.resolved_names.join(", "),
            path.display()
        );
    }
    // The mint is the last refusal before the pane. Every refusal above it
    // leaves no capability behind; one below it has to withdraw what it minted.
    match tokens {
        Some(store) => match store.mint(&session.session_id) {
            Ok(token) => env.push((session_tokens::TOKEN_ENV.to_string(), token)),
            Err(e) => {
                tracing::error!(
                    "[master] {}: cannot mint a control capability: {e} — not starting a master",
                    resolved.slug
                );
                return PaneState::Absent;
            }
        },
        None => {
            tracing::error!(
                "[master] {}: cannot resolve the control token map — not starting a master",
                resolved.slug
            );
            return PaneState::Absent;
        }
    }
    let resume = resume_for(&resolved.slug, &resolved.repo_path, stored_conversation);
    let started = match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(mcp_config.as_deref(), resume.as_deref()),
        &env,
        transcript.as_deref(),
    )
    .await
    {
        Ok(started) => started,
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            // No pane holds the capability minted for it, so it is taken back
            // rather than left in the map as proof of a pane that never started.
            let withdrawn = withdraw_unplaced_mint(tokens, &session.session_id);
            masters.note_unwithdrawn(
                project_id,
                withdrawn
                    .as_ref()
                    .err()
                    .map(|_| session.session_id.as_str()),
            );
            if let Err(why) = withdrawn {
                tracing::error!(
                    "[master] {}: the capability minted for {} could NOT be withdrawn: {why}",
                    resolved.slug,
                    session.session_id
                );
            }
            return PaneState::Absent;
        }
    };
    if replacement_of(ended_a_deaf_pane, started) == Replacement::DeafPaneSurvived {
        return deaf_pane_outlived_its_kill(
            masters,
            project_id,
            &resolved.slug,
            &name,
            &session.session_id,
            ports,
        )
        .await;
    }
    tracing::info!(
        "[master] {}: resident session {name} {} in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        match (started, resume.as_deref()) {
            (false, _) => "was already up, and this pass started nothing".to_string(),
            (true, Some(id)) => format!("resumed from conversation {id}"),
            (true, None) => "cold-started".to_string(),
        },
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session);
    masters.clear_unplaced(project_id);
    // A pane is up. Where this call ended a deaf one on its way here, that is
    // the moment its account becomes a replacement rather than an ending; every
    // return between the kill and this line leaves it reading `ended`, which is
    // what was true (ISS-1208).
    ports.deaf.placed();
    // And a pane is up carrying this session's capability, so the entry in the
    // map is one a live pane holds rather than the residue of a placement that
    // placed nothing. Held only while that is in doubt, or one failed
    // withdrawal refuses this project for ever.
    masters.note_unwithdrawn(project_id, None);
    // A pane this sweep started carries a capability minted for this very
    // session moments ago, so the verdict is not in doubt. It is written all the
    // same: the record has to say `current` for a replaced pane, or an operator
    // who killed a stale one reads the old verdict back and concludes the kill
    // did nothing.
    masters.note_capability(project_id, MasterAuthority::CURRENT);
    ports.authority.set(
        &name,
        terminal::incarnation(&name).await,
        MasterAuthority::CURRENT,
        None,
    );

    let reach = crate::mcp::config::pane_reach(&resolved.repo_path, mcp_config.as_deref());
    match reach.forge() {
        crate::mcp::config::ForgeReach::Declared => {
            tracing::info!("[master] {}: pane {}", resolved.slug, reach.verdict())
        }
        _ => tracing::warn!(
            "[master] {}: pane {} — the pane is told this in its own brief, which is the only \
surface it reads",
            resolved.slug,
            reach.verdict()
        ),
    }
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &declared.dropped_names,
        &reach,
    );
    let brief = match resume.as_deref() {
        Some(conv) => format!("{brief}{}", resumed_brief(conv, inherited)),
        None => brief,
    };
    let brief = match carry.stood_down_for {
        Some(down) => format!("{brief}{}", stood_up_brief(down)),
        None => brief,
    };
    match terminal::brief_new_pane(&name, &brief).await {
        Ok(()) => carry.stood_down_told.store(
            carry.stood_down_for.is_some(),
            std::sync::atomic::Ordering::Relaxed,
        ),
        Err(e) => tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug),
    }
    match resume {
        Some(_) => PaneState::Resumed,
        None => PaneState::ColdStarted,
    }
}

/// What this box can say about the capability the resident master pane holds.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Capability {
    /// Some capability this box minted names the session it now holds.
    Current,
    /// None does, so the pane is running on a token for a session that is gone
    /// and every frame it sends will be refused.
    Stale,
    /// This box cannot read its own map, so it says nothing about any pane.
    Unknown(String),
}

/// Judge a resident pane's capability from this box's own record of what it
/// minted.
///
/// The pane's token lives in its environment and is out of reach here, but the
/// map is not: `mint` leaves exactly one entry naming the session it was called
/// for, and `retire` removes by session. So a map holding nothing for the
/// session core now gives us is a map that was never minted for it — which is
/// precisely a pane adopted onto a session row core replaced, whether it was
/// replaced at this call or at one three restarts ago.
///
/// `session.created` answers only the first of those, which is why one project
/// of seven was reported on 2026-09-18 and the one that was actually stuck was
/// not (ISS-1099).
fn capability_of(tokens: Option<&session_tokens::SessionTokens>, session_id: &str) -> Capability {
    let Some(store) = tokens else {
        return Capability::Unknown(
            "this box could not resolve where its capability map lives".to_string(),
        );
    };
    match store.holds_session(session_id) {
        Ok(true) => Capability::Current,
        Ok(false) => Capability::Stale,
        Err(e) => Capability::Unknown(e.to_string()),
    }
}

/// End a pane this box has proved it can never hear again, and say so.
///
/// `false` where tmux refused: the caller then takes the branch that leaves the
/// pane standing and records `stale` about it, so a kill that did not happen is
/// never written down as one that did.
///
/// The report is an error rather than a warning, and says what ends with the
/// pane. Whatever that master had running is a subagent of its own session and
/// dies with it; the box is choosing that over a project that can never take
/// work again, and a reader who is not told which of the two they got cannot
/// tell this line from a crash.
async fn end_deaf_pane(name: &str, slug: &str, session_id: &str, deaf: &DeafSink) -> bool {
    if let Err(e) = terminal::kill(name).await {
        tracing::error!(
            "[master] {slug}: {name} holds a capability for a session this box no longer has and could not be ended: {e}. It stays up and stays deaf — every declaration it makes is refused — and `forge-runner master kill {slug}` is the same act by hand."
        );
        deaf.set(
            slug,
            name,
            DeafAct::LeftStanding(format!("this box could not end it: {e}")),
        );
        return false;
    }
    tracing::error!(
        "[master] {slug}: ended the resident session {name} — it held a capability for a session this box no longer has, core's session for it is {session_id}, and a running pane cannot be handed a new one, so every declaration it made was refused. This is `forge-runner master kill {slug}` taken by the box instead of by a person, and it is taken only where a replacement would be placed in its stead, which this pass is about to do. Whatever that pane was running ended with it; the replacement resumes the same conversation."
    );
    // `EndedUnplaced` and not `Replaced`: this function ended a pane and that
    // is the whole of what it knows. The placement below can still refuse —
    // the mint, the skill, the MCP config, tmux — and an account that said
    // `replaced` here would be telling a reader a pane is up that is not.
    deaf.set(slug, name, DeafAct::EndedUnplaced);
    true
}

/// What a pass that ended a deaf pane may conclude from what `terminal::ensure`
/// then answered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Replacement {
    /// A pane was started where the deaf one had been.
    Placed,
    /// `ensure` started nothing, because a session of that name was ALREADY
    /// alive. On a pass that ended a pane moments earlier, that session is the
    /// pane this box thought it had ended.
    DeafPaneSurvived,
    /// This pass ended nothing, so a pane already up is the ordinary case and
    /// says nothing about any deaf one.
    NoDeafPane,
}

/// The second reading of whether a deaf pane is gone, taken from the one thing
/// that looked afterwards.
///
/// `terminal::kill` now answers for the session being gone, so this is a
/// guard and not the detector. It costs nothing: `terminal::ensure` already
/// asks whether a session of that name is alive, and `Ok(false)` IS that
/// answer — it was being discarded at the call (ISS-1208). The two readings
/// fail independently, and the one that is left is what decides whether the
/// box writes down a replacement.
pub(crate) fn replacement_of(ended_a_deaf_pane: bool, started: bool) -> Replacement {
    match (ended_a_deaf_pane, started) {
        (false, _) => Replacement::NoDeafPane,
        (true, true) => Replacement::Placed,
        (true, false) => Replacement::DeafPaneSurvived,
    }
}

/// Take back a capability minted for a pane that was never started, and answer
/// for it having gone.
///
/// `retire` cannot answer for itself: it logs and returns on both a map it
/// could not read and a map it could not write, which is the right shape for a
/// caller that is tidying up after a session that has already ended. Here it is
/// a rollback, and a rollback nobody checked is what leaves the session core now
/// serves sitting in the map as proof of a replacement this box did not make —
/// `capability_of` then answers `Current` about a deaf pane for ever (ISS-1208).
///
/// So the map is read back. `Err` carries what stopped it in words a caller can
/// put in front of a person.
fn withdraw_unplaced_mint(
    tokens: Option<&session_tokens::SessionTokens>,
    session_id: &str,
) -> std::result::Result<(), String> {
    let Some(store) = tokens else {
        // Not reachable from the placement path, which returns `Absent` rather
        // than reaching a pane with no map to mint from. Stated rather than
        // assumed, because what it would mean is a mint nothing can take back.
        return Err("this box has no capability map to withdraw from".to_string());
    };
    store.retire(session_id);
    match store.holds_session(session_id) {
        Ok(false) => Ok(()),
        Ok(true) => Err("the map still names that session after the withdrawal, so the map could not be written".to_string()),
        Err(e) => Err(format!("the map could not be read back, so whether the withdrawal took is unknown: {e}")),
    }
}

/// A pane this box ended, that is still there — and the capability it minted on
/// the way, withdrawn.
///
/// The mint is the part that cannot be left. It runs before anything looks at
/// whether a pane was replaced, because the token has to be in the environment
/// the pane is started with; so by the time this is known, the session core now
/// serves is already in this box's capability map. Leave it there and
/// `capability_of` answers `Current` on every later sweep about a pane still
/// holding the old token: the stale arm never fires again, the operator is
/// never told, and the box nudges a master that refuses every declaration it
/// makes — this issue's own incident with the alarm taken out. Retiring it puts
/// the verdict back to `stale`, which is what is true, and the next sweep tries
/// the kill again.
///
/// Nothing holds the retired token: `ensure` started no pane, so it was never
/// handed to one.
///
/// And the withdrawal is READ BACK, by the same rule the rest of this change
/// is: `retire` is best-effort by design — it declines to rewrite a map it
/// could not read, and a map it could not write leaves the entry live — so
/// taking it as done is the assumption this whole issue is about. Where it
/// cannot be established, the box says which of the two it got and what an
/// operator has to do, rather than reporting a rollback it did not make.
async fn deaf_pane_outlived_its_kill(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    name: &str,
    session_id: &str,
    ports: &CapabilityPorts<'_>,
) -> PaneState {
    let withdrawn = withdraw_unplaced_mint(ports.tokens, session_id);
    // Held across sweeps where it failed, released where it took. This is what
    // makes the verdict STAY stale: the map still says `current`, and nothing
    // that could correct the map is available to a box that could not write it.
    masters.note_unwithdrawn(project_id, withdrawn.as_ref().err().map(|_| session_id));
    match &withdrawn {
        Ok(()) => tracing::error!(
            "[master] {slug}: {name} was ended as a deaf pane and tmux still holds a session of that name, so nothing was replaced — the capability minted for {session_id} has been withdrawn rather than left standing as proof of a replacement this box did not make. The pane is still deaf and every declaration it makes is refused: `forge-runner master kill {slug}` is the same act by hand."
        ),
        Err(why) => tracing::error!(
            "[master] {slug}: {name} was ended as a deaf pane and is still running, and the capability minted for {session_id} could NOT be withdrawn: {why}. The map on disk now names a session no pane holds, so this daemon holds that fact itself and goes on reading {slug} as stale — it will report this and try the pane again every sweep, and a placement that works clears it. What it cannot survive is its own restart, which would read the map at face value again: fix whatever stopped this box writing its capability map, or `forge-runner master kill {slug}` and let the replacement mint cleanly."
        ),
    }
    ports.deaf.set(
        slug,
        name,
        DeafAct::LeftStanding(match &withdrawn {
            Ok(()) => "this box ended it and tmux still holds a session of that name".to_string(),
            Err(why) => format!(
                "this box ended it, tmux still holds a session of that name, and the capability minted for the replacement could not be withdrawn ({why}) — held in this daemon and retried every sweep, but not across a restart of it"
            ),
        }),
    );
    // As in the stale arm of the adopt branch, and for the same reason: the
    // project has no working master, so the registry may not be cleared.
    masters.note_unplaced(
        project_id,
        Unplaced::StaleCapability {
            session: session_id.to_string(),
            pane: name.to_string(),
        },
    );
    masters.note_capability(project_id, MasterAuthority::STALE);
    ports.authority.set(
        name,
        terminal::incarnation(name).await,
        MasterAuthority::STALE,
        None,
    );
    PaneState::StaleCapability
}

/// The one record a sweep makes about deaf masters on this box.
///
/// A fleet whose panes were all minted against sessions one event replaced is a
/// condition of the BOX, and four per-project lines is four readers each
/// finding a quarter of it (ISS-1208). `None` where this sweep found none, or
/// where it found the same ones it found last time.
fn deaf_fleet_report(found: &[Deaf]) -> Option<(bool, String)> {
    if found.is_empty() {
        return None;
    }
    let mut replaced: Vec<&str> = Vec::new();
    let mut unplaced: Vec<&str> = Vec::new();
    let mut standing: Vec<String> = Vec::new();
    for d in found {
        match &d.acted {
            DeafAct::Replaced => replaced.push(&d.slug),
            DeafAct::EndedUnplaced => unplaced.push(&d.slug),
            DeafAct::LeftStanding(why) => standing.push(format!("{} ({why})", d.slug)),
        }
    }
    let mut out = format!(
        "[master] {} master pane(s) on this box hold a capability for a session core has replaced, which is what one event under a live fleet does to every pane at once: {}.",
        found.len(),
        found.iter().map(|d| d.pane.as_str()).collect::<Vec<_>>().join(", ")
    );
    if !replaced.is_empty() {
        out.push_str(&format!(
            " Ended and replaced by this box, carrying the capability core serves now: {}.",
            replaced.join(", ")
        ));
    }
    if !unplaced.is_empty() {
        out.push_str(&format!(
            " Ended, and the pane that was to take their place did not start this pass — the line above this one says which step refused, and the next sweep tries again from no pane at all: {}.",
            unplaced.join(", ")
        ));
    }
    if !standing.is_empty() {
        out.push_str(&format!(
            " Still running and still deaf, which no sweep will change: {}. `forge-runner master kill <slug>` is what ends each, and `forge-runner master status` says the same without this log.",
            standing.join("; ")
        ));
    }
    Some((!standing.is_empty() || !unplaced.is_empty(), out))
}

/// What the latch is keyed on: which panes, and what was done about each.
///
/// Length-prefixed rather than joined on a separator, because one of the parts
/// is a `LeftStanding` reason and that is an error string this code did not
/// write — tmux's, or an io error's. A plain separator lets one pane carrying a
/// reason that happens to contain the separator produce the same digest as two
/// panes do, and a latch keyed on a colliding digest stays silent about a
/// condition it has never reported. The length is what makes the encoding
/// unambiguous whatever the reason says.
fn deaf_digest(found: &[Deaf]) -> String {
    let mut parts: Vec<String> = found
        .iter()
        .map(|d| {
            let act = match &d.acted {
                DeafAct::Replaced => "replaced".to_string(),
                DeafAct::EndedUnplaced => "ended-unplaced".to_string(),
                DeafAct::LeftStanding(why) => format!("standing:{why}"),
            };
            let part = format!("{}={act}", d.pane);
            format!("{}:{part}", part.len())
        })
        .collect();
    parts.sort();
    parts.concat()
}

/// Say it, once per change of the set.
fn report_deaf_fleet(masters: &Arc<Masters>, found: &[Deaf]) {
    let digest = (!found.is_empty()).then(|| deaf_digest(found));
    if !masters.claim_deaf_report(digest) {
        return;
    }
    let Some((needs_a_person, said)) = deaf_fleet_report(found) else {
        return;
    };
    if needs_a_person {
        tracing::error!("{said}");
    } else {
        tracing::warn!("{said}");
    }
}

/// The owner's veto for one project: what the ledger says, whether a pane
/// contradicts it, and the report where one does.
///
/// Called from both branches of the sweep's per-project loop. A runner that
/// takes no new work is a reason to place nothing; it is not a reason to stop
/// looking, and a pane running against a stand-down on a `draining` box was
/// reported by no daemon at all before this (ISS-1118 criterion 4). The read
/// is the local ledger's, so the branch that asks core nothing still pays
/// nothing.
///
/// `None` where the standing could not be read: the caller places nothing, and
/// the reason is already recorded.
///
/// Takes the read rather than the ledger, because a `Ledger` held across the
/// `terminal::alive` await below makes this future non-`Send` and the daemon
/// spawns it.
async fn standing_verdict(
    masters: &Arc<Masters>,
    read: StandingRead,
    project_id: &str,
    slug: &str,
) -> Option<(Placed, Option<MasterStanding>)> {
    let standing = match read {
        StandingRead::Known(s) => s,
        StandingRead::Unreadable(detail) => {
            say_unplaced(
                masters,
                project_id,
                slug,
                Unplaced::StandingUnreadable { detail },
            );
            return None;
        }
    };
    let stands = standing.as_ref().is_some_and(MasterStanding::stands);
    // The pane is only looked for where something might contradict it: a
    // project nobody stood down answers `Proceed` either way, and asking tmux
    // about every project on every sweep buys that answer nothing.
    let pane_name = terminal::session_name(terminal::MASTER_PREFIX, slug);
    let pane_alive = stands && terminal::alive(&pane_name).await;
    let placed = placement_under(standing.as_ref(), pane_alive);
    if placed == Placed::Contradicted {
        say_unplaced(
            masters,
            project_id,
            slug,
            stood_down_reason(standing.as_ref(), slug, Some(&pane_name)),
        );
    }
    Some((placed, standing))
}

/// Put the verdict this sweep reached about a pane's authority where a restart
/// cannot take it, and where a process other than this daemon can read it.
///
/// The registry holds the same answer and dies with the daemon; the journal
/// holds it and has to be read. This is the copy `forge-runner master status`
/// prints, which is the surface an operator reaches for when a project has
/// stopped (ISS-1099).
fn write_authority(ledger: Option<&Ledger>, project_id: &str, slug: &str, said: &Authority) {
    let Some(led) = ledger else {
        return;
    };
    if let Err(e) = led.note_master_authority(
        project_id,
        slug,
        (&said.pane, said.incarnation.as_deref()),
        said.verdict,
        said.detail.as_deref(),
    ) {
        tracing::warn!(
            "[master] {slug}: cannot record that {}'s capability is {}: {e} — `forge-runner master status {slug}` will not say it, and the daemon log is then the only account of it",
            said.pane,
            said.verdict
        );
    }
}

/// Say why a project got no pane, once per change of reason and at the level
/// the reason earns.
///
/// The de-duplication is `note_unplaced`'s, which is keyed on `reg.unplaced`
/// and asks nothing of `reg.live`. That distinction is the whole of ISS-1118
/// criterion 4: `reg.live` holds the panes THIS process placed, so a report
/// gated on it is unreachable on a daemon that has just started — and a
/// stood-down project never reaches `ensure_master`, so it is in `reg.live` on
/// no daemon at all once one restarts.
fn say_unplaced(masters: &Arc<Masters>, project_id: &str, slug: &str, why: Unplaced) {
    if !masters.note_unplaced(project_id, why.clone()) {
        return;
    }
    let lead = why.lead();
    if why.is_error() {
        tracing::error!("[master] {slug}: {lead} — {why}");
    } else {
        tracing::warn!("[master] {slug}: {lead} — {why}");
    }
}

fn remember(masters: &Arc<Masters>, project_id: &str, session: &master_api::MasterSession) {
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            last_work: Instant::now(),
            last_nudge: None,
            mcp_stale_reported: false,
        },
    );
}

fn nudge() -> String {
    "Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.".into()
}

/// Paste one nudge into this project's master. `held` is the capacity refusal
/// the pane is parked behind, when that is why it is being asked; the nudge is
/// the same line either way, and it submits straight through Claude Code's
/// armed wait-for-reset (captured 2026-09-24: `Usage limit reached again after
/// you continued`), so no key is sent ahead of it.
async fn nudge_master(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    held: Option<&master_limit::Refusal>,
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    match held {
        Some(refusal) => tracing::warn!("{}", limit_reask_line(slug, &name, refusal)),
        None => tracing::info!("[master] {slug}: admissible work — nudging {name}"),
    }
    if let Err(e) = terminal::send_line(&name, &nudge()).await {
        tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
    }
}

async fn supervise(
    client: &CoreClient,
    masters: &Arc<Masters>,
    tokens: Option<&session_tokens::SessionTokens>,
    project_id: &str,
    slug: &str,
) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };

    if !terminal::alive(&name).await {
        tracing::warn!("[master] {slug}: resident session {name} is gone — closing its row");
        end_master(
            client,
            masters,
            tokens,
            project_id,
            &session_id,
            "terminal session vanished",
        )
        .await;
    }
}

async fn retire_if_idle(
    client: &CoreClient,
    masters: &Arc<Masters>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    project_id: &str,
    slug: &str,
) -> bool {
    let (Some(led), Some(idle), Some((session_id, name))) = (
        ledger.as_ref(),
        masters.idle_for(project_id),
        masters.get(project_id),
    ) else {
        return false;
    };
    let kids = match master_exit::children(led, &session_id) {
        Ok(k) => k,
        Err(e) => {
            tracing::warn!("[master] {slug}: ledger unreadable ({e}) — keeping the master");
            return false;
        }
    };
    match master_exit::verdict(idle, &kids) {
        Verdict::Stay(_) => false,
        Verdict::Exit => {
            tracing::info!(
                "[master] {slug}: nothing for {}m and every child run closed — retiring {name}",
                idle.as_secs() / 60
            );
            // Said, not swallowed. `terminal::kill` answers for the session
            // being gone (ISS-1208), and the row is closed either way — so a
            // pane that outlived its retirement is adopted again on the next
            // sweep, and a reader who is not told that reads this line as the
            // pane having ended.
            if let Err(e) = terminal::kill(&name).await {
                tracing::warn!(
                    "[master] {slug}: {name} was retired as idle and tmux would not end it: {e} — its row is closed all the same and the next sweep adopts whatever is still running under that name"
                );
            }
            end_master(
                client,
                masters,
                tokens,
                project_id,
                &session_id,
                "idle, children done",
            )
            .await;
            true
        }
    }
}

async fn end_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    tokens: Option<&session_tokens::SessionTokens>,
    project_id: &str,
    session_id: &str,
    reason: &str,
) {
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    if let Some(store) = tokens {
        store.retire(session_id);
    }
    masters.forget(project_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    const THIS_SOURCE: &str = include_str!("master.rs");

    #[test]
    fn nothing_here_infers_liveness_from_a_pane() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        for banned in [
            "SILENCE_CEILING",
            "QUIET_BEFORE_PROMPT",
            "pass_prompt",
            "fn observe",
            "DEATH_LIMIT",
            "DEATH_WINDOW",
            "BREAKER_COOLDOWN",
            "transcript_len",
            "seen_len",
            "last_growth",
        ] {
            assert!(
                !production.contains(banned),
                "`{banned}` is part of the supervision cluster this issue deletes: every one of them inferred a process's state from a pane's byte count, and the pane is where a master that is idle ON PURPOSE looks identical to one that has stopped (ISS-933 criteria 17 and 18)"
            );
        }
        assert!(
            production.contains("fn nudge("),
            "the cluster is replaced, not merely removed — a master still has to be told there is work"
        );
    }

    #[test]
    fn the_retirement_path_asks_the_ledger_and_not_just_the_clock() {
        let body = THIS_SOURCE
            .split("async fn retire_if_idle(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        assert!(
            body.contains("master_exit::children("),
            "the wiring must read the children out of the ledger — a caller that passed an empty slice would satisfy `verdict` and retire a master over live runs, which is criterion 19's failure arriving through the call site rather than the decision (ISS-933 criteria 19 and 20)"
        );
    }

    /// The four issue-less kinds are claimed on every sweep, not only when the
    /// admissible set has something in it.
    ///
    /// The two sets do not overlap: `devices/pool.ts:readPool` serves
    /// `release_batch`, `smoke`, `reconcile` and `verify_skill`, and
    /// `admissible` serves issues. A claim gated on a non-empty admissible set
    /// would leave a project whose only work is a release with its pool unread
    /// for ever — which is the whole of ISS-1080, arriving through the call site
    /// rather than the reader.
    #[test]
    fn the_pool_is_read_before_the_sweep_can_decide_there_is_nothing_to_do() {
        let body = THIS_SOURCE
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let claim = body
            .find("take_pool_job(")
            .expect("the sweep must claim from the JOBS pool");
        let admissible_empty = body
            .find("if !asked_this_sweep(&admissible,")
            .expect("the sweep still has its admissible branch");
        assert!(
            claim < admissible_empty,
            "the pool claim has to run BEFORE the branch that gives up on a project with nothing admissible, or a release is the one job kind no box ever reads (ISS-1080)"
        );
    }

    /// A drained runner claims nothing new.
    ///
    /// `accepts_new_work` is the box's answer to core taking a project off it,
    /// and a pool job is new work like any other. What a drain must NOT stop is
    /// the supervision of a pane already open, which lives on its own tick in
    /// `daemon/mod.rs` and never reads this flag.
    #[test]
    fn a_drained_runner_takes_no_pool_job() {
        let body = THIS_SOURCE
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let drain = body
            .find("if !accepts_new_work(&runner.status)")
            .expect("the sweep still has its drain branch");
        let claim = body
            .find("take_pool_job(")
            .expect("the sweep must claim from the JOBS pool");
        assert!(
            drain < claim,
            "the drain branch `continue`s before the claim, so a runner core has taken off work must reach it first"
        );
    }

    /// Nothing is claimed before adoption has run.
    ///
    /// `pool_jobs::adopt` compares what this box recorded against what it is
    /// running, as two snapshots. A claim landing between them looks to it like
    /// a job whose pane did not survive, so a box that claimed first would make
    /// a fresh release the likeliest thing it reports dead.
    /// ISS-1234 criteria 5 and 25. Every pass that took one is recorded, and
    /// recorded off what `take_one` answered: a claim whose outcome went nowhere
    /// but the log is the silence this ends.
    #[test]
    fn every_pool_read_outcome_is_recorded_off_what_take_one_answered() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let claim = body
            .find("let took = pool_jobs::take_one(")
            .expect("the claim is here");
        let noted = body
            .find("pool_reads::note(&dir, &runner.project_id, &took,")
            .expect("the outcome of the read is recorded for this project");
        assert!(
            claim < noted,
            "the record reads the answer, so it follows it"
        );
    }

    #[test]
    fn no_pool_job_is_claimed_before_adoption_has_run() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        let barrier = body
            .find("if !*adopted.borrow()")
            .expect("the claim is gated on adoption having run");
        let claim = body
            .find("pool_jobs::take_one(")
            .expect("the claim is here");
        assert!(
            barrier < claim,
            "the barrier has to precede the claim, or it gates nothing (ISS-1080)"
        );
    }

    fn box_at(bound: u32) -> Config {
        let mut cfg = Config::default();
        cfg.runner.max_job_panes = bound;
        cfg
    }

    #[test]
    fn a_box_that_can_take_no_more_work_says_so_once_and_names_what_holds_it() {
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(2);
        let panes = std::sync::Arc::new(JobPanes::new());
        let activity = agent_activity::Activities::new();
        for job in ["j1", "j2"] {
            let session = format!("sess-{job}");
            panes.note(
                job,
                &pool_jobs::pane_name(job),
                Watch::Hooked {
                    session_id: session.clone(),
                    delivered_at: agent_activity::now_ms(),
                },
            );
            for event in [
                agent_activity::Event::PromptSubmitted,
                agent_activity::Event::Stopped,
            ] {
                activity.record(
                    &session,
                    agent_activity::Report {
                        event,
                        at: agent_activity::now_ms()
                            - job_exit::IDLE_BEFORE_FINISHED.as_millis() as i64
                            - 1,
                        subject: None,
                        conversation: None,
                        transcript: None,
                    },
                );
            }
        }

        let first = give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));

        assert!(first.contains("every project bound to this box"), "{first}");
        assert!(first.contains("max_job_panes = 2"), "{first}");
        assert!(first.contains("j1"), "{first}");
        assert!(first.contains("j2"), "{first}");
        assert!(first.contains("forge-job-j1"), "{first}");
        assert!(
            first.contains("finished"),
            "the line says what each slot is holding, not only that one is: {first}"
        );
        assert!(
            first.contains("last swept never since this daemon started"),
            "the slot comes back on that sweep and nowhere else, so a reader is told when it last ran: {first}"
        );

        let again = give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));

        assert_eq!(
            again, "",
            "eight projects times every pass is the 48 lines in two minutes this replaced: {again}"
        );
    }

    #[test]
    fn a_ceiling_after_a_restart_says_what_the_record_says_the_pane_is() {
        use crate::daemon::agent_activity::{Doing, Event};
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        panes.hold(
            "j1",
            "forge-job-j1",
            Watch::Adopted {
                session_id: "sess-1".into(),
            },
            Some(job_exit::Reported {
                doing: Doing::Idle,
                last_event: Event::Stopped,
                at: agent_activity::now_ms()
                    - job_exit::IDLE_BEFORE_FINISHED.as_millis() as i64
                    - 1,
                prompts: 1,
            }),
            None,
            None,
        );

        // Nothing has been heard in THIS daemon: the pane went quiet before the
        // restart and will never report again.
        let out = give_back_tests::logged_while(|| {
            report_job_capacity(&cfg, &panes, &agent_activity::Activities::new())
        });

        assert!(
            out.contains("finished"),
            "a reader told the pane has reported nothing, while the next sweep is about to conclude it finished, has two answers to one question: {out}"
        );
        assert!(!out.contains("reported nothing"), "{out}");
    }

    #[test]
    fn a_ceiling_after_a_restart_times_the_slot_from_the_panes_opening() {
        use crate::daemon::agent_activity::{Doing, Event};
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        let now = agent_activity::now_ms();
        panes.hold(
            "oldtimer",
            "forge-job-oldtimer",
            Watch::Adopted {
                session_id: "sess-1".into(),
            },
            Some(job_exit::Reported {
                doing: Doing::Working,
                last_event: Event::PromptSubmitted,
                at: now - 3 * 60 * 60 * 1000,
                prompts: 1,
            }),
            None,
            Some(now - 3 * 60 * 60 * 1000 - 30_000),
        );

        let out = give_back_tests::logged_while(|| {
            report_job_capacity(&cfg, &panes, &agent_activity::Activities::new())
        });

        assert!(
            out.contains("oldtimer in forge-job-oldtimer for 180m"),
            "the person hunting a wedged box is told how long the slot has been held, not how long this daemon has counted it (ISS-1231): {out}"
        );
        assert!(!out.contains("for 0m"), "{out}");
    }

    #[test]
    fn a_ceiling_over_a_record_with_no_opening_says_only_what_it_knows() {
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        panes.hold(
            "j1",
            "forge-job-j1",
            Watch::Adopted {
                session_id: "sess-1".into(),
            },
            None,
            None,
            None,
        );
        panes.backdate("j1", agent_activity::now_ms() - 5 * 60_000 - 1_000);

        let out = give_back_tests::logged_while(|| {
            report_job_capacity(&cfg, &panes, &agent_activity::Activities::new())
        });

        assert!(
            out.contains("j1 in forge-job-j1 for at least 5m"),
            "a record an older daemon wrote carries no opening, and the pane is at least as old as its adoption: {out}"
        );
    }

    #[test]
    fn a_pane_the_sweep_is_about_to_let_go_for_saying_nothing_reads_as_that() {
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        panes.hold(
            "j1",
            "forge-job-j1",
            Watch::Adopted {
                session_id: "sess-1".into(),
            },
            None,
            None,
            None,
        );
        panes.backdate(
            "j1",
            agent_activity::now_ms()
                - crate::daemon::job_unheard::UNHEARD_BEFORE_ABANDONED.as_millis() as i64
                - 1,
        );

        let out = give_back_tests::logged_while(|| {
            report_job_capacity(&cfg, &panes, &agent_activity::Activities::new())
        });

        assert!(
            out.contains("never heard from"),
            "the person hunting a box that has stopped taking work is told what is holding it: {out}"
        );
        assert!(
            out.contains("has not let it go yet"),
            "a reader told only that the agent has reported nothing, while the next sweep concludes the pane, has two answers to one question: {out}"
        );
    }

    #[test]
    fn a_box_that_is_taking_work_again_says_that_too() {
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        let activity = agent_activity::Activities::new();
        panes.note("j1", "forge-job-j1", Watch::Unhooked);
        give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));
        assert!(
            panes.said_at_bound(None).is_some(),
            "the box was at its ceiling"
        );
        panes.said_at_bound(Some("j1".into()));

        panes.forget("j1");
        let out = give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));

        assert!(out.contains("under its job-pane ceiling again"), "{out}");
        assert!(
            panes.said_at_bound(None).is_none(),
            "the condition is over and is said once"
        );
        assert_eq!(
            give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity)),
            "",
            "a box under its ceiling says nothing every pass"
        );
    }

    #[test]
    fn a_box_below_its_ceiling_that_never_reached_it_says_nothing() {
        let cfg = box_at(2);
        let panes = std::sync::Arc::new(JobPanes::new());
        assert_eq!(
            give_back_tests::logged_while(|| report_job_capacity(
                &cfg,
                &panes,
                &agent_activity::Activities::new()
            )),
            ""
        );
    }

    #[test]
    fn a_ceiling_held_by_different_jobs_is_a_different_condition() {
        use crate::daemon::turn_evidence::Watch;
        let cfg = box_at(1);
        let panes = std::sync::Arc::new(JobPanes::new());
        let activity = agent_activity::Activities::new();
        panes.note("j1", "forge-job-j1", Watch::Unhooked);
        give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));

        panes.forget("j1");
        panes.note("j2", "forge-job-j2", Watch::Unhooked);
        let out = give_back_tests::logged_while(|| report_job_capacity(&cfg, &panes, &activity));

        assert!(
            out.contains("j2"),
            "a ceiling somebody else is now holding is news: {out}"
        );
    }

    #[test]
    fn the_per_project_refusal_is_no_longer_what_an_operator_reads() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        assert!(
            !body.contains("tracing::info!"),
            "this fired once per bound project per pass — 48 lines in two minutes across eight projects, none of them saying the box as a whole had stopped (ISS-1205): {body}"
        );
    }

    #[test]
    fn the_job_pane_bound_comes_from_this_boxs_own_config() {
        let body = THIS_SOURCE
            .split("async fn take_pool_job(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .unwrap_or_default();
        assert!(
            body.contains("cfg.runner.max_job_panes"),
            "the ceiling is the operator's `[runner] max_job_panes`, read here — a constant would make every box on the fleet identical and unfixable without a release"
        );
    }

    fn served(entries: &[(&str, Option<u64>)]) -> Vec<runners::MeRunner> {
        entries
            .iter()
            .map(|(status, limited)| runners::MeRunner {
                project_id: "p".into(),
                runner_id: "r".into(),
                slug: "s".into(),
                base_branch: None,
                repo_path: None,
                branch: None,
                status: (*status).into(),
                workspace_setup: None,
                master_policy: None,
                rate_limited_for_seconds: *limited,
                limit_reason: None,
            })
            .collect()
    }

    /// The body this box sends core for the captured refusal — the same file the
    /// receiving suite reads.
    const WIRE: &str = include_str!("../../assets/master-limit-wire.json");

    #[test]
    fn the_stamp_a_master_reports_is_what_widens_this_boxs_own_sweep() {
        let wire: serde_json::Value = serde_json::from_str(WIRE).unwrap();
        let secs = wire["resetsInSeconds"]
            .as_u64()
            .expect("the wire carries a reset");
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(secs))])),
            LIMITED_POLL_INTERVAL,
            "a row stamped from this report is what makes the sweep back off"
        );
        assert_eq!(
            next_poll_delay(&served(&[("online", None)])),
            POLL_INTERVAL,
            "and a row the clear emptied is what brings it back"
        );
    }

    #[test]
    fn a_wake_cuts_latency_rather_than_adding_it() {
        assert!(WAKE_FLOOR < POLL_INTERVAL);
    }

    #[tokio::test]
    async fn a_burst_of_wakes_coalesces_into_one_pending_sweep() {
        let (tx, mut rx) = wake_channel();

        assert!(tx
            .try_send(Wake::Core {
                project_id: Some("p1".into())
            })
            .is_ok());
        assert!(
            tx.try_send(Wake::Core {
                project_id: Some("p2".into())
            })
            .is_err(),
            "a second wake while one is pending must be dropped, not queued"
        );
        assert!(
            tx.try_send(Wake::Reconnect).is_err(),
            "the catch-up read coalesces onto a pending wake too — one sweep covers both"
        );

        assert!(matches!(rx.recv().await, Some(Wake::Core { .. })));
        assert!(
            tx.try_send(Wake::Reconnect).is_ok(),
            "once the pending wake is taken, the next one must get through"
        );
    }

    #[test]
    fn a_wake_says_which_trigger_fired() {
        assert!(Wake::Core {
            project_id: Some("forge-dev".into())
        }
        .describe()
        .contains("forge-dev"));
        assert!(Wake::Reconnect.describe().contains("catch-up"));
    }

    #[test]
    fn a_limited_fleet_is_slowed_down_and_never_stopped() {
        let d = next_poll_delay(&served(&[("online", Some(3600))]));
        assert!(d > POLL_INTERVAL, "a limited fleet should back off");
        assert!(
            d <= LIMITED_POLL_INTERVAL,
            "the backoff must stay bounded: {d:?}"
        );
    }

    #[test]
    fn one_limited_project_does_not_slow_a_healthy_one() {
        let mixed = served(&[("online", Some(3600)), ("online", None)]);
        assert_eq!(next_poll_delay(&mixed), POLL_INTERVAL);
    }

    #[test]
    fn an_expired_limit_polls_at_full_speed() {
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(0))])),
            POLL_INTERVAL
        );
    }

    #[test]
    fn a_core_that_does_not_report_limits_polls_at_full_speed() {
        assert_eq!(next_poll_delay(&served(&[("online", None)])), POLL_INTERVAL);
    }

    #[test]
    fn a_drained_runner_is_not_counted_either_way() {
        let mix = served(&[("draining", None), ("online", Some(3600))]);
        assert!(next_poll_delay(&mix) > POLL_INTERVAL);
    }

    #[test]
    fn one_master_per_project_and_projects_do_not_block_each_other() {
        let masters = Masters::new();
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        let masters = Arc::new(masters);
        remember(&masters, "p1", &session);
        assert_eq!(masters.get("p1").map(|m| m.0), Some("s1".into()));
        assert!(
            masters.get("p2").is_none(),
            "one project's master is not another's"
        );
        assert_eq!(masters.forget("p1"), Some("s1".into()));
        assert!(masters.get("p1").is_none());
    }

    #[test]
    fn a_stale_pane_is_reported_once_per_process_and_an_adopted_one_is_always_reported() {
        let masters = Arc::new(Masters::new());

        // Never registered here: an adopted pane, and nothing has spoken for it.
        assert!(masters.claim_mcp_stale("p-adopted"));
        assert!(masters.claim_mcp_stale("p-adopted"));

        remember(
            &masters,
            "p1",
            &master_api::MasterSession {
                session_id: "s1".into(),
                name: "forge-master-p1".into(),
                created: true,
            },
        );
        assert!(masters.claim_mcp_stale("p1"), "the first mismatch is news");
        assert!(
            !masters.claim_mcp_stale("p1"),
            "every sweep after is the same news"
        );

        // One project's silence is not another's.
        remember(
            &masters,
            "p2",
            &master_api::MasterSession {
                session_id: "s2".into(),
                name: "forge-master-p2".into(),
                created: true,
            },
        );
        assert!(masters.claim_mcp_stale("p2"));

        // The pane matches again, so the NEXT mismatch is worth saying.
        masters.clear_mcp_stale("p1");
        assert!(masters.claim_mcp_stale("p1"));
    }

    #[test]
    fn the_brief_tells_the_master_to_record_what_it_decided_rather_than_asked() {
        assert!(
            MASTER_SKILL.contains("forge record decision"),
            "the brief must name the verb that records a decision; without it the ratio's denominator is zero for every master (ISS-964 criteria 1, 2)"
        );
        assert!(
            MASTER_SKILL.contains("reversible"),
            "tier 0 is the rule that a reversible write is TAKEN and recorded — the brief is where the master reads it"
        );
    }

    /// Criterion 12. Until this change a master that had been taken over by a
    /// person could only say so in prose, in a pane nothing reads, and went on
    /// answering nudges for nine hours (ISS-1118 comment 3d208f73).
    #[test]
    fn the_skill_tells_a_master_somebody_else_is_driving_to_stand_itself_down() {
        assert!(
            MASTER_SKILL.contains("forge-runner master stand-down"),
            "a master whose project a person has taken over has no verb to reach for, so it keeps being nudged and keeps writing `Holding.` into a transcript nobody reads"
        );
        assert!(
            MASTER_SKILL.contains("forge-runner master stand-up"),
            "and the way back is named beside it, or the verb reads as one-way and is not taken"
        );
        let section = MASTER_SKILL
            .split("## When the project is not yours to drive")
            .nth(1)
            .expect("the skill carries the section that names the verb")
            .split("\n## ")
            .next()
            .unwrap();
        for flag in ["--why", "--force", "--fresh"] {
            assert!(
                !section.contains(flag),
                "this file states no command's flags: it and the CLI answering it ship on different clocks, so `{flag}` written here is a flag that will be wrong on some box on some day"
            );
        }
    }

    #[test]
    fn the_skill_quotes_the_refusal_it_will_meet() {
        let first_sentence = crate::daemon::dispatch_gate::REFUSAL
            .split_once(". ")
            .map(|(head, _)| format!("{head}."))
            .expect("the refusal opens with a sentence");
        assert!(
            MASTER_SKILL.contains(&first_sentence),
            "a master reading the skill must recognise the refusal when it arrives; \
             the skill does not carry `{first_sentence}`"
        );
    }

    /// Criterion 33. The skill says the declaration is enforced, not advised.
    #[test]
    fn the_skill_says_the_declaration_is_a_condition_and_not_a_suggestion() {
        assert!(
            MASTER_SKILL.contains("no longer advice"),
            "the skill described a rule nothing enforced for four days; it must now say which it is"
        );
        assert!(MASTER_SKILL.contains("forge-runner run declare"));
        assert!(
            MASTER_SKILL.contains("forge-runner run close"),
            "a master holding a spent declaration needs the way out named where it reads"
        );
    }

    /// ISS-1246. A subagent's stop is not its end and nothing on the box ends
    /// it for being quiet, so the skill may not tell a master its runs close
    /// themselves: that is the sentence that left every tree to recovery.
    #[test]
    fn the_skill_says_the_master_closes_a_finished_run() {
        assert!(
            !MASTER_SKILL.contains("closes itself"),
            "a subagent run is ended by its master's close or its master's end, and by nothing it does itself"
        );
        assert!(MASTER_SKILL.contains("Close a run once you will not resume its subagent"));
    }

    #[test]
    fn the_skill_carries_no_flags_and_points_at_the_surface_that_cannot_go_stale() {
        for flag in [
            "--project",
            "--issue",
            "--worktree",
            "--reason",
            "--decision",
        ] {
            assert!(
                !MASTER_SKILL.contains(flag),
                "`{flag}` is the CLI's to describe: it ships on a different clock from this file"
            );
        }
        assert!(
            MASTER_SKILL.contains("-h"),
            "the skill must send a master to the self-describing surface instead"
        );
    }

    #[test]
    fn the_owner_policy_reaches_the_brief_verbatim() {
        let policy = "Budget: 5 sessions.\nDrafts are eligible work.\nGroup related issues.";
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            Some(policy),
            &[],
            &healthy_reach("the_owner_policy_reaches_the_brief_verbatim"),
        );
        assert!(
            brief.contains(policy),
            "the policy must be spliced whole: {brief}"
        );
        assert!(
            brief.contains("OUTRANKS"),
            "the brief must say the policy beats the skill's defaults: {brief}"
        );
    }

    /// A [`PaneReach`] over two real files, which is the only way one is built.
    ///
    /// The directory carries the test's own label and this process's id: two
    /// `cargo test` runs on one box must not share a path (ISS-1073).
    struct ReachFiles(crate::test_scratch::Scratch);

    impl ReachFiles {
        fn new(label: &str, repo: Option<&str>, session: Option<&str>) -> Self {
            let dir = crate::test_scratch::Scratch::new(&format!("reach-{label}"));
            if let Some(body) = repo {
                std::fs::write(dir.join(".mcp.json"), body).expect("repo .mcp.json");
            }
            if let Some(body) = session {
                std::fs::write(dir.join("session.json"), body).expect("session config");
            }
            Self(dir)
        }

        fn reach(&self, has_pat: bool) -> crate::mcp::config::PaneReach {
            let session = self.0.join("session.json");
            crate::mcp::config::pane_reach_in(
                &self.0,
                session.exists().then_some(session.as_path()),
                has_pat,
            )
        }
    }

    fn declares(names: &[&str]) -> String {
        let body: Vec<String> = names
            .iter()
            .map(|n| format!("\"{n}\": {{ \"type\": \"http\", \"url\": \"https://x/mcp\" }}"))
            .collect();
        format!("{{ \"mcpServers\": {{ {} }} }}", body.join(", "))
    }

    fn reach_of(
        label: &str,
        repo: Option<&[&str]>,
        session: Option<&[&str]>,
        has_pat: bool,
    ) -> crate::mcp::config::PaneReach {
        ReachFiles::new(
            label,
            repo.map(declares).as_deref(),
            session.map(declares).as_deref(),
        )
        .reach(has_pat)
    }

    /// The reach of a box that is provisioned: `forge` from the checkout,
    /// `playwright` from the session config, an operator PAT stored.
    fn healthy_reach(label: &str) -> crate::mcp::config::PaneReach {
        reach_of(label, Some(&["forge"]), Some(&["playwright"]), true)
    }

    const STANDING_BRIEF: &str = "Use the `forge-master` skill. You are the resident master for project `forge-dev` on this box, and you will be woken again in this same session rather than started fresh.\n\nYou are standing in this project's checkout, on its base branch `main`.\n";

    #[test]
    fn the_standing_brief_is_only_what_a_wave_cannot_know() {
        let reach = healthy_reach("the_standing_brief_is_only_what_a_wave_cannot_know");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], &reach);
        assert_eq!(
            brief,
            format!("{STANDING_BRIEF}{}", reach.brief()),
            "the standing brief may say only what the skill cannot: which project, which box, \
             which branch, and which MCP servers this box's two config files put within this \
             pane's reach. Every rule about how a run works belongs in forge-master-skill.md, and \
             a copy here is the pair ISS-1080 broke"
        );
    }

    #[test]
    fn the_brief_no_longer_carries_the_two_claims_that_stopped_masters_declaring() {
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            None,
            &[],
            &healthy_reach(
                "the_brief_no_longer_carries_the_two_claims_that_stopped_masters_declaring",
            ),
        );
        assert!(
            !brief.contains("no job pool") && !brief.contains("second terminal"),
            "the job pool and its second terminal came back with ISS-1080 and are on every box: {brief}"
        );
        assert!(
            !brief.contains("whole record of a run"),
            "the lease stopped being the whole record on 2026-09-13; a master told otherwise does not declare: {brief}"
        );
    }

    #[test]
    fn the_brief_states_no_rule_the_skill_file_owns() {
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            None,
            &["playwright".into()],
            &healthy_reach("the_brief_states_no_rule_the_skill_file_owns"),
        )
        .to_lowercase();
        for owned in [
            "job pool",
            "second terminal",
            "run declare",
            "the lease",
            "worktree",
            "subagent",
            "shipped role",
        ] {
            assert!(
                !brief.contains(owned),
                "`{owned}` names how a run works, which forge-master-skill.md owns: {brief}"
            );
        }
    }

    /// Criterion 32. The owner is spliced whole, banned vocabulary and all.
    #[test]
    fn the_owner_policy_survives_words_the_brief_itself_may_not_use() {
        let policy = "Declare every run. Two subagents at a time, each in its own worktree.";
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            Some(policy),
            &[],
            &healthy_reach("the_owner_policy_survives_words_the_brief_itself_may_not_use"),
        );
        assert!(
            brief.contains(policy),
            "the owner is a courier's cargo, not this box's prose to police: {brief}"
        );
    }

    /// A pane is started only where the record says what it will carry AND it
    /// carries what the project declares. A config that could not be written
    /// starts one only for a project that declares nothing (ISS-1235).
    #[test]
    fn a_config_that_could_not_be_written_starts_a_pane_only_for_a_project_declaring_nothing() {
        for (cleared, declares) in [(true, true), (true, false), (false, true), (false, false)] {
            assert_eq!(
                launch_record(true, cleared, declares),
                LaunchRecord::Truthful
            );
        }
        assert_eq!(
            launch_record(false, true, false),
            LaunchRecord::NoneAndSaysSo
        );
        assert_eq!(launch_record(false, true, true), LaunchRecord::Withheld);
        assert_eq!(launch_record(false, false, true), LaunchRecord::Lying);
        assert_eq!(launch_record(false, false, false), LaunchRecord::Lying);
    }

    fn declaring(names: &[&str]) -> mcp_servers::ProjectMcpServers {
        mcp_servers::ProjectMcpServers {
            mcp_servers: names
                .iter()
                .map(|n| (n.to_string(), serde_json::json!({"type": "stdio"})))
                .collect(),
            resolved_names: names.iter().map(|n| n.to_string()).collect(),
            dropped_names: vec![],
        }
    }

    /// Criterion 1: a failed read is a refusal and never an empty declaration.
    #[test]
    fn a_failed_read_refuses_the_start_and_never_reads_as_declaring_nothing() {
        let failed: ServersRead =
            Err("me/mcp-servers 520 (gateway: the origin returned an unknown error)".into());
        match servers_for_start(&failed) {
            Err(Unplaced::ServersUnreadable { detail }) => assert_eq!(
                detail,
                "me/mcp-servers 520 (gateway: the origin returned an unknown error)"
            ),
            Err(other) => panic!("a failed read must refuse the start by its own reason: {other}"),
            Ok(_) => panic!("a failed read must refuse the start, not declare nothing"),
        }
    }

    /// Criterion 8: a read that succeeded hands the declaration through whole,
    /// empty or not.
    #[test]
    fn a_read_that_succeeded_is_the_declaration_the_pane_is_started_with() {
        let read: ServersRead = Ok(declaring(&["playwright"]));
        let declared = match servers_for_start(&read) {
            Ok(declared) => declared,
            Err(why) => panic!("a read declaration starts a pane: {why}"),
        };
        assert_eq!(declared.resolved_names, vec!["playwright".to_string()]);
        assert!(declared.mcp_servers.contains_key("playwright"));

        let none: ServersRead = Ok(mcp_servers::ProjectMcpServers::default());
        assert!(
            servers_for_start(&none).is_ok(),
            "declaring nothing is an answer"
        );
    }

    /// Criteria 9 and 12: a failed read turns only a replacement into a pane
    /// left standing; a pane that can be heard is kept either way.
    #[test]
    fn a_failed_read_leaves_a_deaf_pane_standing_and_keeps_every_other_act() {
        match replacement_gate(CapabilityAct::Replace, false) {
            CapabilityAct::LeaveDeaf(why) => assert!(why.contains("MCP servers"), "{why}"),
            other => panic!("no replacement would be placed, so none may be ended for: {other:?}"),
        }
        assert_eq!(
            replacement_gate(CapabilityAct::Replace, true),
            CapabilityAct::Replace
        );
        for readable in [true, false] {
            assert_eq!(
                replacement_gate(CapabilityAct::Keep, readable),
                CapabilityAct::Keep
            );
            assert_eq!(
                replacement_gate(CapabilityAct::LeaveDeaf("x"), readable),
                CapabilityAct::LeaveDeaf("x")
            );
        }
    }

    #[test]
    fn a_pane_core_could_not_be_asked_about_is_unknown_and_never_stale() {
        let declared = mcp_servers::ProjectMcpServers {
            resolved_names: vec!["playwright".into()],
            ..Default::default()
        };
        let declares_nothing = mcp_servers::ProjectMcpServers::default();

        // Could not ask: nothing is known, whatever the file on disk says.
        assert_eq!(pane_config(None, false), PaneConfig::Unknown);
        assert_eq!(pane_config(None, true), PaneConfig::Unknown);

        // Core answered: the file on disk decides, and it decides both ways.
        assert_eq!(pane_config(Some(&declared), true), PaneConfig::Current);
        assert_eq!(pane_config(Some(&declared), false), PaneConfig::Stale);

        // A project core says declares nothing is still an ANSWER, so a pane
        // holding a file it should not have is still reported.
        assert_eq!(
            pane_config(Some(&declares_nothing), false),
            PaneConfig::Stale
        );
        assert_eq!(
            pane_config(Some(&declares_nothing), true),
            PaneConfig::Current
        );
    }

    /// Criterion 10: no pane is started unreadable, so no brief carries the
    /// paragraph that used to describe one.
    #[test]
    fn no_brief_describes_an_unreadable_declaration() {
        let brief = standing_prompt(
            "mowment",
            Some("main"),
            None,
            &[],
            &healthy_reach("no_brief_describes_an_unreadable_declaration"),
        );
        assert!(!brief.contains("could NOT read"), "{brief}");
        assert!(
            !production_source().contains("could NOT read this project's declared MCP servers"),
            "the paragraph for a pane started without its declaration must be gone"
        );
    }

    fn production_source() -> &'static str {
        THIS_SOURCE.split("#[cfg(test)]").next().unwrap()
    }

    /// ISS-1114, the measured state: a checkout with no `.mcp.json`, a session
    /// config declaring `playwright` alone, and no operator PAT on the box.
    ///
    /// The assertions are on the EXPLANATION and not on the word `forge`, so a
    /// brief that merely announced the server would fail this too.
    #[test]
    fn the_cold_pane_is_told_forge_is_absent_and_why() {
        let reach = reach_of(
            "the_cold_pane_is_told_forge_is_absent_and_why",
            None,
            Some(&["playwright"]),
            false,
        );
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], &reach);
        assert!(
            brief.contains("The `forge` MCP server is in NEITHER half"),
            "a pane whose union holds no `forge` is told nothing about it: {brief}"
        );
        assert!(
            brief.contains("forge_github"),
            "the pane is not told which capability went with it: {brief}"
        );
        assert!(
            brief.contains("Absent is not refused"),
            "the pane is not told absent and refused are different, which is the whole \
             finding: {brief}"
        );
        assert!(
            brief.contains("no operator PAT is stored on this box either")
                && brief.contains("forge-runner login --pat"),
            "the pane is not given the cause or the one command that ends it: {brief}"
        );
        assert!(
            brief.contains("playwright"),
            "the pane is not told what it DOES hold: {brief}"
        );
    }

    /// The false alarm the issue body's own Rule would have shipped: this box,
    /// on the day it was measured, had `forge` in its checkout and `playwright`
    /// alone in its session config. A gate keyed to the session writer fires
    /// here, where nothing is wrong.
    #[test]
    fn a_provisioned_pane_is_told_its_union_and_nothing_is_raised() {
        let reach = healthy_reach("a_provisioned_pane_is_told_its_union_and_nothing_is_raised");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], &reach);
        assert!(
            brief.contains("forge, playwright"),
            "a healthy pane is not told the union it holds: {brief}"
        );
        for alarm in [
            "NEITHER half",
            "ABSENT",
            "forge-runner login",
            "UNDETERMINED",
            "could NOT be determined",
        ] {
            assert!(
                !brief.contains(alarm),
                "`{alarm}` is an alarm on a box where `forge` is present the whole time: {brief}"
            );
        }
    }

    /// Presence is a declaration and never a working route. A `forge` entry
    /// carrying a credential that would answer 401 is still declared, and the
    /// brief must claim nothing more than that about it.
    #[test]
    fn a_declared_forge_is_never_reported_as_a_working_one() {
        let reach = healthy_reach("a_declared_forge_is_never_reported_as_a_working_one");
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], &reach);
        assert!(
            brief.contains("That is what those two files DECLARE")
                && brief.contains("Nothing here has checked that any of them answers"),
            "the brief must say these servers are declared, not that they work: {brief}"
        );
    }

    /// A stored PAT changes the cause and not the verdict: the entry should be
    /// in the checkout and is not, so the checkout is what has to be fixed.
    #[test]
    fn a_stored_pat_with_no_forge_entry_names_the_unprovisioned_checkout() {
        let reach = reach_of(
            "a_stored_pat_with_no_forge_entry_names_the_unprovisioned_checkout",
            Some(&["playwright"]),
            None,
            true,
        );
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], &reach);
        assert!(
            brief.contains("The `forge` MCP server is in NEITHER half"),
            "{brief}"
        );
        assert!(
            brief.contains("DOES hold an operator PAT")
                && brief.contains("Re-provision this checkout on this box"),
            "a box with a PAT must be sent to its checkout, not to `login`: {brief}"
        );
        assert!(
            !brief.contains("forge-runner login"),
            "a box that is already paired must not be told to pair: {brief}"
        );
    }

    /// A half that could not be read is not a half that declares nothing, and
    /// a diagnosis built on it would be the very substitution this issue is
    /// about, one layer along.
    #[test]
    fn an_unreadable_half_is_undetermined_rather_than_absent() {
        let files = ReachFiles::new(
            "an_unreadable_half_is_undetermined_rather_than_absent",
            Some("{ this is not json"),
            Some(&declares(&["playwright"])),
        );
        for has_pat in [false, true] {
            let brief =
                standing_prompt("forge-dev", Some("main"), None, &[], &files.reach(has_pat));
            assert!(
                brief.contains("could NOT be determined"),
                "an unreadable half must be reported as unknown: {brief}"
            );
            assert!(
                !brief.contains("NEITHER half") && !brief.contains("is ABSENT from this pane"),
                "an unreadable half must never be reported as an absence: {brief}"
            );
            for cause in [
                "forge-runner login",
                "Re-provision this checkout",
                "What is observed",
            ] {
                assert!(
                    !brief.contains(cause),
                    "`{cause}` is a cause for an absence nobody established: {brief}"
                );
            }
        }
    }

    #[test]
    fn a_declared_server_this_box_cannot_supply_is_named_in_the_brief() {
        let dropped = vec!["epodsystem".to_string(), "postman".to_string()];
        let brief = standing_prompt(
            "mowment",
            Some("main"),
            None,
            &dropped,
            &healthy_reach("a_declared_server_this_box_cannot_supply_is_named_in_the_brief"),
        );
        assert!(brief.contains("epodsystem, postman"), "{brief}");
        assert!(
            brief.contains("could NOT supply"),
            "the master must be told this is a shortfall, not an inventory: {brief}"
        );
        assert!(
            brief.contains("rather than parking it as a run that failed"),
            "the brief must say what to do instead of discovering it as an empty park: {brief}"
        );
    }
}

#[cfg(test)]
mod give_back_tests {
    use super::*;
    use crate::runner::close_loop::{LeaseKeeper, SessionReader};
    use crate::runner::ledger::{Ledger, NewRun};
    use std::sync::Mutex;

    const THIS_SOURCE: &str = include_str!("master.rs");

    type R<T> = crate::error::Result<T>;

    #[derive(Default)]
    struct ChoiceSpy {
        seen: std::sync::Mutex<Vec<(String, String, String, String)>>,
        refuse: bool,
    }

    impl ChoiceReporter for ChoiceSpy {
        async fn report(
            &self,
            session_id: &str,
            run_id: &str,
            choice: &str,
            why: &str,
        ) -> crate::error::Result<()> {
            self.seen.lock().unwrap().push((
                session_id.to_string(),
                run_id.to_string(),
                choice.to_string(),
                why.to_string(),
            ));
            if self.refuse {
                return Err(crate::error::Error::Other("503".into()));
            }
            Ok(())
        }
    }

    fn a_run_that_chose(choice: &str, why: &str) -> Option<Ledger> {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: std::path::PathBuf::from("/w/one"),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-7".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.owe_resume_choices("master-1", "boot-a").unwrap();
        led.record_resume_choice("run-1", "master-1", choice, why)
            .unwrap();
        Some(led)
    }

    #[tokio::test]
    async fn a_recorded_choice_is_carried_to_core_with_its_reason() {
        let mut led = a_run_that_chose("restart", "the branch has nothing on it");
        let spy = ChoiceSpy::default();

        let said = say_resume_choices(&spy, &mut led, "boot-a").await;

        assert_eq!(said, 1);
        let seen = spy.seen.lock().unwrap();
        let (session, run, choice, why) = seen.first().expect("one report");
        assert_eq!(session, "core-sess-1");
        assert_eq!(run, "run-1");
        assert_eq!(choice, "restart");
        assert_eq!(why, "the branch has nothing on it");
    }

    #[tokio::test]
    async fn a_choice_core_has_taken_is_not_said_again() {
        let mut led = a_run_that_chose("leave", "somebody else's to settle");
        let spy = ChoiceSpy::default();

        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 1);
        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 0);

        assert_eq!(spy.seen.lock().unwrap().len(), 1, "one report, one comment");
    }

    #[tokio::test]
    async fn a_choice_core_refused_is_said_again_on_the_next_sweep() {
        let mut led = a_run_that_chose("continue", "the work stands");
        let refusing = ChoiceSpy {
            refuse: true,
            ..Default::default()
        };

        assert_eq!(say_resume_choices(&refusing, &mut led, "boot-a").await, 0);

        let taking = ChoiceSpy::default();
        assert_eq!(say_resume_choices(&taking, &mut led, "boot-a").await, 1);
        assert_eq!(taking.seen.lock().unwrap().len(), 1);
    }

    fn three_inherited() -> Vec<InheritedRun> {
        (1..=3)
            .map(|n| InheritedRun {
                run_id: format!("run-{n}"),
                issue_keys: vec![format!("ISS-{n}")],
                worktree_path: format!("/w/{n}"),
                incarnation: "starting",
                work: "runnable",
                agent_id: None,
                ended_by: None,
            })
            .collect()
    }

    #[test]
    fn a_resumed_pane_is_told_that_it_was_resumed() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("conv-abc"), "{brief}");
    }

    #[test]
    fn the_inherited_block_carries_no_recommendation_and_no_suggested_action() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        for verdict in [
            "recommend",
            "suggest",
            "you should",
            "probably",
            "advise",
            "best to",
            "likely wants",
        ] {
            assert!(
                !brief.to_lowercase().contains(verdict),
                "the block must hand over raw fields, not a verdict — found `{verdict}`:\n{brief}"
            );
        }
    }

    #[test]
    fn every_inherited_run_appears_as_raw_fields() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        for n in 1..=3 {
            assert!(brief.contains(&format!("run-{n}")), "{brief}");
            assert!(brief.contains(&format!("ISS-{n}")), "{brief}");
            assert!(brief.contains(&format!("/w/{n}")), "{brief}");
        }
        assert!(
            brief.contains("never bound"),
            "an unbound run says so: {brief}"
        );
        assert!(brief.contains("continue"), "{brief}");
        assert!(brief.contains("restart"), "{brief}");
        assert!(brief.contains("leave"), "{brief}");
    }

    #[test]
    fn a_resumed_pane_holding_nothing_is_asked_for_nothing() {
        let brief = resumed_brief("conv-abc", &[]);
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("nothing to decide"), "{brief}");
    }

    pub(super) fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
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
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn no_path_out_of_resume_for_starts_a_pane_cold_in_silence() {
        let body = THIS_SOURCE
            .split("pub(crate) fn resume_for(")
            .nth(1)
            .and_then(|r| r.split("\n}").next())
            .expect("resume_for is gone");
        assert!(
            !body.contains("conversation_transcript(repo, id)?"),
            "`?` here returns None with nothing logged when this box has no home directory, so a pane that lost its predecessor's memory looks exactly like one that never had a conversation — and the test that reads this log answers with an empty string rather than a failure it can name: {body}"
        );
        assert_eq!(
            body.matches("tracing::warn!").count(),
            2,
            "there are two ways to start a pane cold while a conversation IS recorded — no home directory to look under, and no transcript at the path — and each one says so; a count below this is a path that goes quiet: {body}"
        );
    }

    #[test]
    fn a_conversation_this_box_cannot_reach_is_named_in_the_log_it_starts_cold_from() {
        let repo = crate::test_scratch::Scratch::new("resume-log");
        let out = logged_while(|| {
            assert_eq!(
                resume_for("some-slug", &repo, Some("conv-9f3a-unreachable")),
                None
            );
        });

        assert!(
            out.contains("conv-9f3a-unreachable.jsonl"),
            "the transcript it could not reach must be named by PATH, so an operator can go and \
             look for it rather than guess where it should have been; log was: {out}"
        );
        assert!(
            out.contains("some-slug"),
            "and which project's pane it was, since one box runs several; log was: {out}"
        );
        assert!(
            out.contains("WARN"),
            "at WARN: starting cold means the pane has lost its predecessor's memory, which is not \
             routine information; log was: {out}"
        );
    }

    #[test]
    fn a_pane_with_nothing_recorded_starts_cold_quietly() {
        let repo = crate::test_scratch::Scratch::new("resume-log-quiet");
        let out = logged_while(|| {
            assert_eq!(resume_for("some-slug", &repo, None), None);
        });
        assert!(
            !out.contains("WARN"),
            "nothing stored is not a fault; log was: {out}"
        );
    }

    #[test]
    fn a_conversation_with_no_transcript_on_this_box_starts_cold() {
        let repo = crate::test_scratch::Scratch::new("resume-none");
        assert_eq!(
            resume_for("slug", &repo, Some("conv-that-was-never-here")),
            None,
            "a conversation with no transcript may not be handed to --resume"
        );
    }

    #[test]
    fn a_conversation_whose_transcript_is_here_is_resumed() {
        let repo = crate::test_scratch::Scratch::new("resume");
        let id = format!("conv-{}", std::process::id());
        let path = conversation_transcript(&repo, &id).expect("a home directory");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}\n").expect("write");

        let got = resume_for("slug", &repo, Some(&id));

        let _ = std::fs::remove_file(&path);
        assert_eq!(got.as_deref(), Some(id.as_str()));
    }

    #[test]
    fn nothing_stored_is_a_cold_start_and_so_is_an_empty_string() {
        let scratch = crate::test_scratch::Scratch::new("resume-empty");
        let repo = scratch.join("never-made");
        assert_eq!(resume_for("slug", &repo, None), None);
        assert_eq!(resume_for("slug", &repo, Some("")), None);
    }

    #[test]
    fn the_transcript_path_is_the_one_claude_code_actually_uses() {
        let home = dirs_next::home_dir().expect("a home directory");
        let got = conversation_transcript(
            std::path::Path::new("/home/forge/projects/apiflow/.worktrees/ISS-16"),
            "conv-1",
        )
        .expect("a path");
        assert_eq!(
            got,
            home.join(".claude")
                .join("projects")
                .join("-home-forge-projects-apiflow--worktrees-ISS-16")
                .join("conv-1.jsonl")
        );
    }

    struct Alive(bool);
    #[async_trait::async_trait]
    impl recovery::MasterLiveness for Alive {
        async fn state(&self, _id: &str) -> recovery::MasterPresence {
            if self.0 {
                recovery::MasterPresence::Alive
            } else {
                recovery::MasterPresence::Gone
            }
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    struct ReportsIdleSince(i64);
    #[async_trait::async_trait]
    impl recovery::RunActivity for ReportsIdleSince {
        async fn reported(&self, _: &str) -> Option<run_exit::Reported> {
            Some(run_exit::Reported {
                doing: crate::daemon::agent_activity::Doing::Idle,
                at: self.0,
                written_at: None,
            })
        }
    }

    struct NeverReports;
    #[async_trait::async_trait]
    impl recovery::RunActivity for NeverReports {
        async fn reported(&self, _: &str) -> Option<run_exit::Reported> {
            None
        }
    }

    #[derive(Default)]
    struct Beats(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl recovery::Heartbeat for Beats {
        async fn beat(&self, session_id: &str) -> R<()> {
            self.0.lock().unwrap().push(session_id.to_string());
            Ok(())
        }
    }

    struct NoPids;
    #[async_trait::async_trait]
    impl recovery::ProcessLiveness for NoPids {
        async fn is_gone(&self, _pid: u32) -> bool {
            false
        }
    }

    /// No pid in these tests is ever refuted, so nothing may reach a kill.
    struct NoKill;
    #[async_trait::async_trait]
    impl terminate::ProcessGroup for NoKill {
        async fn kill(&self, _pid: u32) -> crate::runner::inflight::Reaped {
            unreachable!("a run no test refutes must never be killed")
        }
    }

    struct Terminal(bool);
    #[async_trait::async_trait]
    impl SessionReader for Terminal {
        async fn is_terminal(&self, _id: &str) -> R<bool> {
            Ok(self.0)
        }
    }

    #[derive(Default)]
    struct Closes(Mutex<Vec<(String, close_loop::Outcome, Option<serde_json::Value>)>>);
    #[async_trait::async_trait]
    impl close_loop::RunCloser for Closes {
        async fn close(
            &self,
            agent_session_id: &str,
            outcome: close_loop::Outcome,
            _detail: &str,
            checkpoint: Option<serde_json::Value>,
        ) -> R<()> {
            self.0
                .lock()
                .unwrap()
                .push((agent_session_id.to_string(), outcome, checkpoint));
            Ok(())
        }
    }

    #[derive(Default)]
    struct Leases(Mutex<Vec<String>>);
    #[async_trait::async_trait]
    impl LeaseKeeper for Leases {
        async fn release(&self, _project_id: Option<&str>, issue_key: &str) -> R<()> {
            self.0.lock().unwrap().push(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, _project_id: Option<&str>, issue_key: &str) -> R<bool> {
            Ok(self.0.lock().unwrap().iter().any(|k| k == issue_key))
        }
    }

    const BOOT: &str = "boot-under-test";

    fn a_ledger_holding_one_run() -> Ledger {
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-1".into(),
            worktree_path: "/nonexistent/wt".into(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-1".into(), "ISS-2".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led
    }

    #[tokio::test]
    async fn ending_an_idle_run_tells_core_the_box_did_it() {
        let led = a_ledger_holding_one_run();
        led.attach_pid("run-1", 424_248).unwrap();
        let mut ledger = Some(led);
        let killed = CountedKill(std::sync::atomic::AtomicUsize::new(0));
        let closes = Closes::default();
        let idle_since = crate::daemon::agent_activity::now_ms()
            - run_exit::RUN_IDLE_BEFORE_EXIT.as_millis() as i64;

        give_back_lost_runs(
            BOOT,
            &Alive(true),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &killed,
                closer: &closes,
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &ReportsIdleSince(idle_since),
            },
            &mut ledger,
        )
        .await;

        let seen = closes.0.lock().unwrap();
        let (sess, outcome, checkpoint) = seen.first().expect("one close");
        assert_eq!(
            (sess.as_str(), *outcome),
            ("core-sess-1", close_loop::Outcome::KilledIdle),
            "an idle reap must reach core as its own outcome, not as silence"
        );
        assert_eq!(
            checkpoint.as_ref().and_then(|c| c["source"].as_str()),
            Some("reconstructed_from_box"),
            "the close must carry the box's half, labelled as reconstruction: {checkpoint:?}"
        );
        assert_eq!(killed.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_sweep_beats_the_runs_this_box_still_holds() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();

        give_back_lost_runs(
            BOOT,
            &Alive(true),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert_eq!(
            beats.0.lock().unwrap().as_slice(),
            ["core-sess-1"],
            "a live run this box holds must be beaten every sweep, or core's ten-minute reaper takes its worktree back"
        );
    }

    #[tokio::test]
    async fn a_dead_master_leaves_its_leases_returned_and_no_beat_sent() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();
        let leases = Leases::default();

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            beats.0.lock().unwrap().is_empty(),
            "beating for a master that is gone tells core this box still holds a run nobody is running"
        );
        let mut returned = leases.0.lock().unwrap().clone();
        returned.sort();
        assert_eq!(
            returned,
            ["ISS-1", "ISS-2"],
            "every issue of the group comes back, per issue — a run carrying two that returned one is not closed"
        );
    }

    #[tokio::test]
    async fn a_box_that_cannot_name_its_boot_reconciles_nothing() {
        let mut ledger = Some(a_ledger_holding_one_run());
        let beats = Beats::default();
        let leases = Leases::default();

        give_back_lost_runs(
            "",
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &Config::default(),
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &beats,
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            leases.0.lock().unwrap().is_empty() && beats.0.lock().unwrap().is_empty(),
            "an unreadable boot id must leave every run alone — an empty one matches nothing recorded, so reconciling on it gives back the leases of runs that are still live"
        );
    }

    struct GonePid(u32);
    #[async_trait::async_trait]
    impl recovery::ProcessLiveness for GonePid {
        async fn is_gone(&self, pid: u32) -> bool {
            pid == self.0
        }
    }

    struct CountedKill(std::sync::atomic::AtomicUsize);
    #[async_trait::async_trait]
    impl terminate::ProcessGroup for CountedKill {
        async fn kill(&self, _pid: u32) -> crate::runner::inflight::Reaped {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            crate::runner::inflight::Reaped::NotFound
        }
    }

    async fn git(dir: &std::path::Path, args: &[&str]) {
        tokio::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .await
            .unwrap();
    }

    /// A real repo with a real `git worktree` on a branch — the only way to
    /// watch a checkout actually leave the disk.
    /// The repo sits one level inside its scratch so the bare remote beside it
    /// (`repo.with_extension("remote.git")`) goes with the scratch too.
    async fn a_repo_with_a_live_worktree() -> (crate::test_scratch::InScratch, std::path::PathBuf) {
        let repo = crate::test_scratch::Scratch::new("master-reclaim").at("repo");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]).await;
        git(&repo, &["config", "user.email", "t@t"]).await;
        git(&repo, &["config", "user.name", "t"]).await;
        std::fs::write(repo.join("f.txt"), "one").unwrap();
        git(&repo, &["add", "."]).await;
        git(&repo, &["commit", "-m", "init"]).await;
        // A bare remote so `@{u}` resolves: `holds_work` counts a branch with no
        // upstream as holding work, because commits that were never pushed exist
        // nowhere else — and a tree holding work is refused, not released.
        let remote = repo.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        std::fs::create_dir_all(&remote).unwrap();
        git(&remote, &["init", "--bare", "-b", "main"]).await;
        git(
            &repo,
            &["remote", "add", "origin", &remote.to_string_lossy()],
        )
        .await;
        git(&repo, &["push", "-u", "origin", "main"]).await;
        let wt = crate::workspace::worktree::create(&repo.to_string_lossy(), "ISS-957", None)
            .await
            .unwrap();
        git(&wt, &["push", "-u", "origin", "ISS-957"]).await;
        (repo, wt)
    }

    #[tokio::test]
    async fn reclaiming_a_dead_run_tells_core_it_died_rather_than_waiting_to_be_reaped() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_249).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.to_path_buf(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let closes = Closes::default();
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_249),
                killer: &CountedKill(std::sync::atomic::AtomicUsize::new(0)),
                closer: &closes,
            },
            &Terminal(false),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        let seen = closes.0.lock().unwrap();
        let (sess, outcome, checkpoint) = seen.first().expect("one close");
        assert_eq!(
            (sess.as_str(), *outcome),
            ("core-sess-1", close_loop::Outcome::Died),
            "a run whose process this box refuted must reach core as a death, from the box, now"
        );
        let cp = checkpoint.as_ref().expect("a death carries the box's half");
        assert_eq!(cp["source"].as_str(), Some("reconstructed_from_box"));
        assert_eq!(
            cp["branch"].as_str(),
            Some("ISS-957"),
            "the reconstruction must be of the run's own worktree: {cp}"
        );
        let unread = cp["unread"].as_array().expect("unread is a list");
        assert!(
            unread.is_empty(),
            "a worktree that is still on disk reconstructs completely: {cp}"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    #[tokio::test]
    async fn a_dead_runs_worktree_is_given_back_and_its_run_ended() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_246).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.to_path_buf(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let killed = CountedKill(std::sync::atomic::AtomicUsize::new(0));
        let leases = Leases::default();
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_246),
                killer: &killed,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            !wt.exists(),
            "a LINKED checkout must actually leave the disk: while it is there the `worktree_gone` mark cannot be observed, so `end_run` is never reached and the reap refuses the tree because the run is `ended_by IS NULL` — the cycle has no other exit. A main working tree is the one path that earns the mark without going, because it is not a checkout the run ever held (ISS-1183)"
        );
        let run = ledger.as_ref().unwrap().run("run-1").unwrap().unwrap();
        assert_eq!(
            run.ended_by.as_deref(),
            Some("recovery"),
            "a released tree that leaves the run open re-enters the same deadlock on the next sweep, now with the diff already gone"
        );
        assert_eq!(
            leases.0.lock().unwrap().as_slice(),
            ["ISS-957"],
            "the lease is what another box needs back — a reclaimed worktree whose issue stays leased frees disk and no work"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    /// A registry that has never heard of the run's master: a retired one,
    /// a replaced one, or a project that left `/me/runners`.
    struct NobodyKnows;
    #[async_trait::async_trait]
    impl recovery::MasterLiveness for NobodyKnows {
        async fn state(&self, _id: &str) -> recovery::MasterPresence {
            recovery::MasterPresence::Unknown
        }
        async fn live_master_for_project(&self, _: &str) -> Option<String> {
            None
        }
    }

    /// ISS-1220's b4e955c2, through the sweep: a subagent run whose master this
    /// box no longer registers, core's session over for longer than the bound,
    /// its checkout clean on a pushed branch. Before, every sweep printed
    /// `partially closed` over it for as long as the box lived.
    #[tokio::test]
    async fn a_run_no_master_answers_for_is_given_back_on_the_bound_and_says_why() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-retired".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        assert!(led.bind_agent("run-1", "a497qa").unwrap());
        let over = recovery::UNANSWERED_RELEASE_AFTER.as_secs() as i64 + 60;
        led.backdate_session_terminal("run-1", now_secs() - over)
            .unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.to_path_buf(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let leases = Leases::default();
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &NobodyKnows,
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &NoPids,
                killer: &NoKill,
                closer: &Closes::default(),
            },
            &Terminal(true),
            &leases,
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        assert!(
            !wt.exists(),
            "the checkout goes back on the bound, since no pane on this box can close the run"
        );
        let led = ledger.as_ref().unwrap();
        let run = led.run("run-1").unwrap().unwrap();
        assert_eq!(run.ended_by.as_deref(), Some("recovery"));
        assert!(
            run.ended_reason
                .as_deref()
                .is_some_and(|r| r.contains("no master on this box answers")),
            "the row says the agent's end was concluded from silence, never that its process was seen gone: {:?}",
            run.ended_reason
        );
        assert!(
            led.unclosed_runs().unwrap().is_empty(),
            "and nothing is left for the next sweep to call partially closed"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    /// ISS-1220: the sweep's own `partially closed` line stands down once
    /// recovery has said why the run stands, so the second identical sweep is
    /// silent rather than the thousandth.
    #[test]
    fn a_standing_recovery_has_named_is_not_repeated_every_sweep() {
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
        tracing::subscriber::with_default(sub, || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let led = a_ledger_holding_one_run();
                    assert!(led.bind_agent("run-1", "a-sub").unwrap());
                    led.backdate_session_terminal("run-1", now_secs() - 300)
                        .unwrap();
                    let mut ledger = Some(led);
                    let cfg = Config::default();
                    for _ in 0..3 {
                        give_back_lost_runs(
                            BOOT,
                            &NobodyKnows,
                            &Reclaim {
                                served: &[],
                                cfg: &cfg,
                                procs: &NoPids,
                                killer: &NoKill,
                                closer: &Closes::default(),
                            },
                            &Terminal(true),
                            &Leases::default(),
                            recovery::RunWatch {
                                beat: &Beats::default(),
                                idle: &NeverReports,
                            },
                            &mut ledger,
                        )
                        .await;
                    }
                });
        });
        let out = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
        assert_eq!(
            out.matches("is partially closed").count(),
            1,
            "three sweeps over one unchanged standing say it once: {out}"
        );
        assert!(
            !out.contains("[master] run run-1 is partially closed"),
            "and the once is recovery's, which names what ends it: {out}"
        );
    }

    /// ISS-1220: a release owed and not finished — here its project has no
    /// repository on this box — has said why itself, so the sweep adds no
    /// `partially closed` line on top of it, on this sweep or the next.
    #[test]
    fn a_release_that_cannot_finish_is_not_followed_by_a_partially_closed_line() {
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
        tracing::subscriber::with_default(sub, || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let led = a_ledger_holding_one_run();
                    assert!(led.bind_agent("run-1", "a-sub").unwrap());
                    let over = recovery::UNANSWERED_RELEASE_AFTER.as_secs() as i64 + 60;
                    led.backdate_session_terminal("run-1", now_secs() - over)
                        .unwrap();
                    let mut ledger = Some(led);
                    let cfg = Config::default();
                    for _ in 0..2 {
                        give_back_lost_runs(
                            BOOT,
                            &NobodyKnows,
                            &Reclaim {
                                served: &[],
                                cfg: &cfg,
                                procs: &NoPids,
                                killer: &NoKill,
                                closer: &Closes::default(),
                            },
                            &Terminal(true),
                            &Leases::default(),
                            recovery::RunWatch {
                                beat: &Beats::default(),
                                idle: &NeverReports,
                            },
                            &mut ledger,
                        )
                        .await;
                    }
                });
        });
        let out = String::from_utf8_lossy(&buf.0.lock().unwrap()).into_owned();
        assert_eq!(
            out.matches("no master on this box answers").count(),
            1,
            "the licence is said once: {out}"
        );
        assert!(
            out.contains("no repo path on this box"),
            "the release says why it could not start: {out}"
        );
        assert!(
            !out.contains("is partially closed"),
            "and no per-sweep line repeats either: {out}"
        );
    }

    #[tokio::test]
    async fn a_dead_run_carrying_uncommitted_work_has_it_preserved_before_the_tree_goes() {
        let (repo, wt) = a_repo_with_a_live_worktree().await;
        std::fs::write(wt.join("f.txt"), "the agent got this far").unwrap();
        let mut led = Ledger::open_in_memory().unwrap();
        led.create_run_group(NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "master-dead".into(),
            worktree_path: wt.clone(),
            boot_id: BOOT.into(),
            issue_keys: vec!["ISS-957".into()],
        })
        .unwrap();
        led.attach_session("run-1", "core-sess-1").unwrap();
        led.attach_pid("run-1", 424_247).unwrap();

        let mut cfg = Config::default();
        cfg.bindings.insert(
            "proj-1".into(),
            crate::config::Binding {
                repo_path: repo.to_path_buf(),
                branch: None,
                project_id: Some("proj-1".into()),
            },
        );
        let mut ledger = Some(led);

        give_back_lost_runs(
            BOOT,
            &Alive(false),
            &Reclaim {
                served: &[],
                cfg: &cfg,
                procs: &GonePid(424_247),
                killer: &CountedKill(std::sync::atomic::AtomicUsize::new(0)),
                closer: &Closes::default(),
            },
            &Terminal(true),
            &Leases::default(),
            recovery::RunWatch {
                beat: &Beats::default(),
                idle: &NeverReports,
            },
            &mut ledger,
        )
        .await;

        let log = tokio::process::Command::new("git")
            .args(["log", "--oneline", "origin/ISS-957", "-2"])
            .current_dir(&repo)
            .output()
            .await
            .unwrap();
        let landed = String::from_utf8_lossy(&log.stdout);
        assert!(
            landed.lines().count() >= 2,
            "the agent's work must be on the remote before the checkout is released, got:\n{landed}"
        );
        assert!(
            !wt.exists()
                && ledger
                    .as_ref()
                    .unwrap()
                    .run("run-1")
                    .unwrap()
                    .unwrap()
                    .ended_by
                    .is_some(),
            "with the diff preserved there is nothing left to hold the tree or the run"
        );
        let _ = std::fs::remove_dir_all(&repo);
        let _ = std::fs::remove_dir_all(repo.with_extension("remote.git"));
    }

    /// The brace depth every statement of `sweep`'s own body sits at.
    fn depth_of_call_in_sweep(needle: &str) -> Option<usize> {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sweep = production
            .split("async fn sweep(")
            .nth(1)
            .expect("sweep is gone");
        let body = &sweep[sweep.find('{')?..];
        let mut depth = 0usize;
        for (i, ch) in body.char_indices() {
            match ch {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return None;
                    }
                }
                _ => {}
            }
            if body[i..].starts_with(needle) {
                return Some(depth);
            }
        }
        None
    }

    #[test]
    fn the_sweep_reconciles_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("give_back_lost_runs("),
            Some(1),
            "the sweep must reconcile what this box holds on EVERY pass; behind a condition, or gone, nothing beats a run session and core reaps every healthy one after ten minutes"
        );
    }

    #[test]
    fn the_sweep_tells_core_about_declared_runs_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("run_record::open_declared_runs("),
            Some(1),
            "a declared run reaches core only from this call; behind a condition it reaches core on some sweeps and not others"
        );
        assert_eq!(
            depth_of_call_in_sweep("run_record::close_ended_runs("),
            Some(1),
            "a finished run is released only from this call; behind a condition its issues wait out core's ten-minute reaper instead"
        );
    }

    #[test]
    fn a_declaration_reaches_core_before_the_reconciler_reads_it() {
        let body = THIS_SOURCE
            .split("async fn sweep(")
            .nth(1)
            .expect("sweep must exist");
        let opens = body
            .find("run_record::open_declared_runs(")
            .expect("the sweep must tell core about declared runs");
        let reconciles = body
            .find("give_back_lost_runs(")
            .expect("the sweep must reconcile");
        assert!(
            opens < reconciles,
            "a run declared this sweep must reach core before the reconciler reads it as one that never started"
        );
    }

    #[test]
    fn the_account_is_reported_once_for_the_box_and_never_per_project() {
        assert_eq!(
            depth_of_call_in_sweep("report_account_limit("),
            Some(1),
            "the report must sit at the top level of the sweep, outside the project loop and under no condition"
        );
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sweep = production
            .split("async fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("sweep is gone");
        assert_eq!(
            sweep.matches("report_account_limit(").count(),
            1,
            "one decision per sweep means one call site"
        );
    }

    #[test]
    fn a_verdict_is_read_for_every_project_whose_pane_is_up() {
        assert!(
            depth_of_call_in_sweep("account_record(").unwrap_or(0) > 1,
            "the read belongs inside the project loop; only the decision is device-wide"
        );
    }

    /// The reporting path's own source, bounded to it.
    ///
    /// The closing boundary is the function's own brace at column zero. It used
    /// to be the next doc comment, which put this slice's end in prose: delete
    /// or move a comment and the slice widens into the next function, silently
    /// changing what every assertion below counts.
    fn reporting_path() -> &'static str {
        THIS_SOURCE
            .split("async fn report_account_limit(")
            .nth(1)
            .and_then(|r| r.split("\n}").next())
            .expect("the reporting path is gone")
    }

    #[test]
    fn reporting_a_cap_ends_no_master() {
        for banned in [
            "end_master(",
            "master_api::close(",
            "terminal::kill(",
            "retire_if_idle(",
            "masters.forget(",
        ] {
            assert!(
                !reporting_path().contains(banned),
                "`{banned}` on the reporting path would make a cap a fault: work already running finishes, and only the STARTING of new turns backs off"
            );
        }
    }

    #[test]
    fn reporting_a_cap_changes_no_runner_status() {
        for banned in [
            "patch_runner(",
            "runners::patch",
            "\"draining\"",
            "\"disabled\"",
        ] {
            assert!(
                !reporting_path().contains(banned),
                "`{banned}` on the reporting path would quarantine the box; the limit column is what core stamps, and the status is an operator's decision"
            );
        }
    }

    #[test]
    fn the_decision_is_taken_against_the_sweeps_own_instant() {
        assert!(
            !reporting_path().contains("now_unix()"),
            "the reporting path must take the sweep's `now_unix` as an argument, never re-read the clock: re-read, every verdict silently ages by however long the project loop took"
        );
        assert!(
            reporting_path().contains("now_unix: i64"),
            "and it takes that instant as a parameter, so there is exactly one place the sweep's clock is read"
        );
    }

    #[test]
    fn every_limit_call_on_the_reporting_path_carries_a_deadline() {
        let path: String = reporting_path()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect();
        for call in ["master_api::report_limit(", "master_api::clear_limit("] {
            assert!(
                path.contains(&format!("bounded({call}")),
                "`{call}` must go through `bounded`, or a core that accepts and never answers stops this box sweeping at all"
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_core_that_accepts_and_never_answers_does_not_hold_the_sweep() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            std::future::pending::<()>().await;
        });
        let client = CoreClient::new(format!("http://{addr}"), String::from("tok"));

        match tokio::time::timeout(
            REPORT_TIMEOUT * 3,
            bounded(master_api::clear_limit(&client)),
        )
        .await
        {
            Ok(Err(e)) => assert!(
                e.to_string().contains("did not answer"),
                "the deadline must say what happened, got {e}"
            ),
            Ok(Ok(())) => panic!("core never answered, so this cannot have succeeded"),
            Err(_) => panic!(
                "the call outlived three times its own deadline — this box is stopped, not slowed"
            ),
        }
    }

    #[test]
    fn reporting_a_cap_touches_no_issue() {
        assert!(
            !reporting_path().contains("issue"),
            "nothing here may move, claim or release an issue: a cap says something about the account and nothing about the work"
        );
    }

    #[test]
    fn a_box_that_reported_a_cap_still_nudges_its_masters() {
        let nudge = depth_of_call_in_sweep("nudge_master(").expect("the nudge is gone");
        let report = depth_of_call_in_sweep("report_account_limit(").unwrap();
        assert!(
            nudge > report,
            "the nudge is inside the project loop and the report is not, so a limited sweep still prompts every master"
        );
    }

    fn admiss(issue_id: &str) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({ "issueId": issue_id }))
            .expect("admissible fixture")
    }

    /// One session's activity, built by feeding real hook frames through the real
    /// state machine — `awaiting_permission` is private to `agent_activity`, so a
    /// struct literal here is not available, and that is the better test anyway.
    fn reported(events: &[(agent_activity::Event, Option<&str>)]) -> agent_activity::Activity {
        let acts = agent_activity::Activities::new();
        let mut last = None;
        for (event, subject) in events {
            last = Some(acts.record(
                "s1",
                agent_activity::Report {
                    event: *event,
                    at: 0,
                    subject: *subject,
                    conversation: Some("c1"),
                    transcript: None,
                },
            ));
        }
        last.expect("a fixture needs at least one event")
    }

    fn sent(digest: u64, at: Instant, prompts: Option<u64>) -> Option<Nudge> {
        Some(Nudge {
            digest,
            at,
            prompts,
        })
    }

    fn a_while_ago() -> Instant {
        Instant::now()
            .checked_sub(NUDGE_REFRESH)
            .expect("clock older than the refresh window")
    }

    #[test]
    fn a_master_with_no_recorded_nudge_is_nudged() {
        assert!(nudge_due(None, 7, Instant::now(), SinceNudge::Ran, false));
    }

    #[test]
    fn the_same_work_twice_in_a_row_is_not_nudged_twice() {
        let now = Instant::now();
        assert!(!nudge_due(
            sent(7, now, Some(0)),
            7,
            now,
            SinceNudge::NoTurn,
            false
        ));
    }

    #[test]
    fn changed_work_is_nudged_without_waiting_out_the_period() {
        let now = Instant::now();
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                nudge_due(sent(7, now, Some(3)), 8, now, since, false),
                "new work must reach the master however {since:?} reads"
            );
        }
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_last_one_produced_no_turn() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::NoTurn,
            false
        ));
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_master_has_never_reported() {
        assert!(nudge_due(
            sent(7, a_while_ago(), None),
            7,
            Instant::now(),
            SinceNudge::Unreported,
            false
        ));
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_turn_died_on_an_error() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::Failed,
            false
        ));
    }

    #[test]
    fn unchanged_work_is_withheld_where_the_last_nudge_produced_a_turn() {
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                !nudge_due(
                    sent(7, a_while_ago(), Some(4)),
                    7,
                    Instant::now(),
                    since,
                    false
                ),
                "a master that {since:?} has answered this work already"
            );
        }
    }

    #[test]
    fn a_master_stopped_on_a_permission_question_is_left_alone() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::PermissionRequested, None),
        ]);
        assert_eq!(
            since_nudge(Some(&a), Some(0)),
            SinceNudge::AwaitingPermission
        );
        assert!(!retry_owed(SinceNudge::AwaitingPermission));
    }

    #[test]
    fn a_session_that_never_reported_reads_as_no_evidence() {
        assert_eq!(since_nudge(None, Some(3)), SinceNudge::Unreported);
        let a = reported(&[(agent_activity::Event::Stopped, None)]);
        assert_eq!(
            since_nudge(Some(&a), None),
            SinceNudge::Unreported,
            "a nudge sent before this session ever reported has no mark to compare against"
        );
        assert!(retry_owed(SinceNudge::Unreported));
    }

    #[test]
    fn a_child_of_an_earlier_pass_is_not_a_turn_the_nudge_produced() {
        let a = reported(&[
            (agent_activity::Event::SubagentStarted, Some("child-1")),
            (agent_activity::Event::SubagentStopped, Some("child-1")),
        ]);
        assert!(a.sequence > 0, "the frames were accepted");
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::NoTurn);
    }

    #[test]
    fn a_turn_that_began_and_is_still_running_reads_as_working() {
        let a = reported(&[(agent_activity::Event::PromptSubmitted, None)]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Working);
    }

    #[test]
    fn a_turn_that_began_and_ended_reads_as_ran() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Ran);
        assert!(!retry_owed(SinceNudge::Ran));
    }

    #[test]
    fn a_master_that_ended_its_turn_over_a_dispatched_child_still_reads_as_working() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::SubagentStarted, Some("child-1")),
            (agent_activity::Event::Stopped, None),
        ]);
        assert_eq!(a.doing(), agent_activity::Doing::AwaitingChildren);
        assert_eq!(
            since_nudge(Some(&a), Some(0)),
            SinceNudge::Working,
            "a master's children are its runs in flight; ISS-1232 changed the job and run readings, not the nudge"
        );
    }

    #[test]
    fn a_turn_that_died_while_a_child_was_outstanding_still_reads_as_failed() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::SubagentStarted, Some("child-1")),
            (agent_activity::Event::StoppedFailed, None),
            (agent_activity::Event::SubagentStopped, Some("child-1")),
        ]);
        assert_eq!(a.last_event, agent_activity::Event::SubagentStopped);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Failed);
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(0)),
            7,
            Instant::now(),
            since_nudge(Some(&a), Some(0)),
            false
        ));
    }

    #[test]
    fn a_clean_turn_after_a_failed_one_reads_as_ran() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::StoppedFailed, None),
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Ran);
    }

    #[test]
    fn a_turn_that_ended_on_an_error_reads_as_failed() {
        let a = reported(&[
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::StoppedFailed, None),
        ]);
        assert_eq!(since_nudge(Some(&a), Some(0)), SinceNudge::Failed);
        assert!(retry_owed(SinceNudge::Failed));
    }

    // ---- a master the account refused (ISS-1248) ------------------------------

    const WAIT: &str = include_str!("../../assets/master-limit-wait.jsonl");
    const WAIT_CONVERSATION: &str = "bc76beff-11f2-4d8d-bfef-7190d9d560cd";

    fn wait_tail() -> String {
        WAIT.lines().skip(1).collect::<Vec<_>>().join("\n")
    }

    /// The newest decisive record in epodsystem-core's captured conversation,
    /// read `after_secs` past its second refusal.
    fn parked(after_secs: i64) -> (master_limit::Decisive, i64) {
        let tail = wait_tail();
        let probe = master_limit::newest_record(&tail, 0).expect("the fixture holds a refusal");
        let now = probe.at + after_secs;
        (
            master_limit::newest_record(&tail, now).expect("read at any age"),
            now,
        )
    }

    /// One session's hooks, each frame at its own millisecond and naming the
    /// conversation given — fed through the real state machine.
    fn heard(
        conversation: Option<&str>,
        frames: &[(agent_activity::Event, Option<&str>, i64)],
    ) -> agent_activity::Activity {
        let acts = agent_activity::Activities::new();
        let mut last = None;
        for (event, subject, at) in frames {
            last = Some(acts.record(
                "s1",
                agent_activity::Report {
                    event: *event,
                    at: *at,
                    subject: *subject,
                    conversation,
                    transcript: None,
                },
            ));
        }
        last.expect("a fixture needs at least one frame")
    }

    fn refusal(reason: master_limit::Reason, resets: Option<u64>) -> master_limit::Decisive {
        master_limit::Decisive {
            at: 1_000,
            millis: 500,
            uuid: "u-refused".into(),
            verdict: master_limit::Verdict::Refused(master_limit::Refusal {
                reason,
                resets_in_seconds: resets,
                detail: "You've hit your session limit".into(),
            }),
        }
    }

    #[test]
    fn a_master_the_account_refused_is_asked_again_whatever_its_hooks_say_of_that_turn() {
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::NoTurn,
            SinceNudge::Failed,
            SinceNudge::Unreported,
        ] {
            assert!(
                nudge_due(
                    sent(7, a_while_ago(), Some(4)),
                    7,
                    Instant::now(),
                    since,
                    true
                ),
                "a refused turn that reads {since:?} is no evidence the pass happened"
            );
        }
    }

    #[test]
    fn a_refused_master_is_asked_once_per_refresh_window_and_not_every_sweep() {
        let now = Instant::now();
        assert!(
            !nudge_due(sent(7, now, Some(4)), 7, now, SinceNudge::Ran, true),
            "inside the window a held master waits like any other — the limited sweep is every five minutes, not every thirty seconds"
        );
        let just_inside = now
            .checked_sub(NUDGE_REFRESH - Duration::from_secs(1))
            .expect("clock older than the window");
        assert!(!nudge_due(
            sent(7, just_inside, Some(4)),
            7,
            now,
            SinceNudge::Ran,
            true
        ));
        assert!(
            nudge_due(
                sent(7, now.checked_sub(NUDGE_REFRESH).unwrap(), Some(4)),
                7,
                now,
                SinceNudge::Ran,
                true
            ),
            "at exactly one window it is asked"
        );
    }

    #[test]
    fn changed_work_does_not_ask_a_refused_master_twice_inside_one_window() {
        let now = Instant::now();
        assert!(
            !nudge_due(sent(7, now, Some(4)), 8, now, SinceNudge::Ran, true),
            "its own cut-short runs move the set every sweep, and every turn sent before capacity returns is refused"
        );
        assert!(nudge_due(
            sent(7, now.checked_sub(NUDGE_REFRESH).unwrap(), Some(4)),
            8,
            now,
            SinceNudge::Ran,
            true
        ));
        assert!(
            nudge_due(sent(7, now, Some(4)), 8, now, SinceNudge::Ran, false),
            "a master that is not held still hears about new work at once"
        );
    }

    #[test]
    fn a_master_that_is_not_held_keeps_the_evidence_gate() {
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(!nudge_due(
                sent(7, a_while_ago(), Some(4)),
                7,
                Instant::now(),
                since,
                false
            ));
        }
        let worked = master_limit::Decisive {
            at: 1_000,
            millis: 0,
            uuid: "u-worked".into(),
            verdict: master_limit::Verdict::Worked,
        };
        assert_eq!(
            held_by_limit(Some(&worked), Some("c1"), None),
            None,
            "a turn that worked holds nobody"
        );
        assert_eq!(held_by_limit(None, Some("c1"), None), None);
    }

    #[test]
    fn the_reset_the_account_names_never_moves_the_reask() {
        let far = refusal(master_limit::Reason::UsageLimit, Some(4 * 3600));
        let none = refusal(master_limit::Reason::UsageLimit, None);
        let a = held_by_limit(Some(&far), None, None);
        let b = held_by_limit(Some(&none), None, None);
        assert!(a.is_some() && b.is_some());
        let at = a_while_ago();
        assert_eq!(
            nudge_due(
                sent(7, at, Some(4)),
                7,
                Instant::now(),
                SinceNudge::Ran,
                a.is_some()
            ),
            nudge_due(
                sent(7, at, Some(4)),
                7,
                Instant::now(),
                SinceNudge::Ran,
                b.is_some()
            ),
            "the reset reaches the log line and nothing else"
        );
    }

    #[test]
    fn a_throttle_holds_and_a_credential_does_not() {
        let throttle = refusal(master_limit::Reason::RateLimit, None);
        assert!(held_by_limit(Some(&throttle), None, None).is_some());
        let auth = refusal(master_limit::Reason::Auth, None);
        assert_eq!(held_by_limit(Some(&auth), None, None), None);
    }

    #[test]
    fn a_turn_begun_after_the_refusal_is_left_to_finish() {
        let r = refusal(master_limit::Reason::UsageLimit, None);
        let refused_ms = r.at * 1000 + i64::from(r.millis);
        let after = heard(
            Some("c1"),
            &[(agent_activity::Event::PromptSubmitted, None, refused_ms + 1)],
        );
        assert_eq!(held_by_limit(Some(&r), Some("c1"), Some(&after)), None);

        let same_instant = heard(
            Some("c1"),
            &[(agent_activity::Event::PromptSubmitted, None, refused_ms)],
        );
        assert!(
            held_by_limit(Some(&r), Some("c1"), Some(&same_instant)).is_some(),
            "the turn the refusal answered began at or before it"
        );
    }

    #[test]
    fn hooks_naming_another_conversation_veto_and_silent_hooks_do_not() {
        let r = refusal(master_limit::Reason::UsageLimit, None);
        let ended = |conv| {
            heard(
                conv,
                &[
                    (agent_activity::Event::PromptSubmitted, None, 1),
                    (agent_activity::Event::Stopped, None, 2),
                ],
            )
        };
        assert_eq!(
            held_by_limit(Some(&r), Some("c1"), Some(&ended(Some("c2")))),
            None,
            "the refusal was read from a file this pane is no longer writing"
        );
        assert!(held_by_limit(Some(&r), Some("c1"), Some(&ended(Some("c1")))).is_some());
        assert!(held_by_limit(Some(&r), Some("c1"), Some(&ended(None))).is_some());
        assert!(
            held_by_limit(Some(&r), Some("c1"), None).is_some(),
            "a daemon that has just adopted the pane has heard nothing, and that is the pane left parked"
        );
    }

    #[test]
    fn an_empty_admissible_set_does_not_leave_a_refused_master_unasked() {
        let held = held_by_limit(
            Some(&refusal(master_limit::Reason::UsageLimit, None)),
            None,
            None,
        );
        assert!(asked_this_sweep(&[], held.as_ref()));
        assert!(!asked_this_sweep(&[], None));
        assert!(asked_this_sweep(&[admiss("i1")], None));
    }

    #[test]
    fn the_sweep_asks_a_held_master_before_the_empty_set_can_skip_it() {
        let body = THIS_SOURCE
            .split("\n#[cfg(test)]")
            .next()
            .and_then(|p| p.split("\nasync fn sweep(").nth(1))
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("sweep must be findable");
        let read = body
            .find("held_by_limit(")
            .expect("the sweep reads the hold");
        let gate = body
            .find("if !asked_this_sweep(&admissible, held.as_ref()) {")
            .expect("the empty-set skip is the one that also reads the hold");
        let nudge = body.find("nudge_master(masters,").unwrap();
        assert!(read < gate && gate < nudge);
        assert!(
            !body.contains("if admissible.is_empty() {\n            continue;"),
            "a bare empty-set skip ahead of the nudge would leave a refused master unasked again"
        );
        assert!(body[gate..nudge].contains("held.is_some()"));
    }

    #[test]
    fn the_reask_says_what_the_account_said_and_when_it_expects_to_reset() {
        let r = master_limit::Refusal {
            reason: master_limit::Reason::UsageLimit,
            resets_in_seconds: Some(14_379),
            detail: "x".into(),
        };
        let line = limit_reask_line("epodsystem-core", "forge-master-epodsystem-core", &r);
        for part in [
            "epodsystem-core:",
            "forge-master-epodsystem-core",
            "usage_limit",
            "14379s",
        ] {
            assert!(line.contains(part), "{part} is missing from {line}");
        }
        let unknown = master_limit::Refusal {
            resets_in_seconds: None,
            ..r
        };
        assert!(limit_reask_line("p", "pane", &unknown).contains("reported no reset"));
    }

    /// The reproduction: epodsystem-core on 2026-09-24. Its last nudge was at
    /// 16:36:28Z and started a turn that dispatched two runs; the account refused
    /// at 16:54:18Z and again at 16:55:15Z, and the hooks' last word is a turn
    /// that ended over a child whose end never came. The box never asked again.
    #[test]
    fn epodsystem_cores_parked_master_is_asked_again_where_it_was_not() {
        let (last, now) = parked(15 * 60);
        let refused_ms = last.at * 1000;
        let hooks = heard(
            Some(WAIT_CONVERSATION),
            &[
                (
                    agent_activity::Event::PromptSubmitted,
                    None,
                    refused_ms - 18 * 60_000,
                ),
                (
                    agent_activity::Event::SubagentStarted,
                    Some("a4723aa61fd809a07"),
                    refused_ms - 17 * 60_000,
                ),
                (agent_activity::Event::Stopped, None, refused_ms),
            ],
        );
        let since = since_nudge(Some(&hooks), Some(0));
        let last_nudge = sent(7, a_while_ago(), Some(0));

        assert!(
            !nudge_due(last_nudge, 7, Instant::now(), since, false),
            "without the hold this is what the box decided that night: {since:?}, no retry owed"
        );

        let held = held_by_limit(Some(&last), Some(WAIT_CONVERSATION), Some(&hooks))
            .expect("the pane is parked behind the second refusal");
        assert_eq!(held.reason, master_limit::Reason::UsageLimit);
        assert!(nudge_due(last_nudge, 7, Instant::now(), since, true));
        assert!(
            asked_this_sweep(&[], Some(&held)),
            "its two runs still held ISS-254 and ISS-297 out of the set"
        );

        let (hours_later, later) = parked(3 * 3600);
        assert!(later > now);
        assert!(
            held_by_limit(Some(&hours_later), Some(WAIT_CONVERSATION), Some(&hooks)).is_some(),
            "past the report's freshness window the pane is still parked"
        );
    }

    #[test]
    fn the_digest_does_not_move_when_the_rows_merely_swap_places() {
        let a = work_digest(&[admiss("i1"), admiss("i2")]);
        let b = work_digest(&[admiss("i2"), admiss("i1")]);
        assert_eq!(a, b);
    }

    #[test]
    fn the_digest_moves_when_a_row_arrives_or_leaves() {
        let one = work_digest(&[admiss("i1")]);
        assert_ne!(one, work_digest(&[admiss("i1"), admiss("i2")]));
        assert_ne!(one, work_digest(&[]));
    }

    #[test]
    fn the_digest_ignores_what_the_master_does_not_decide_on() {
        let plain: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "confirmed" }))
                .unwrap();
        let dressed: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed",
            "title": "renamed", "priority": "critical", "category": "bug",
            "description": "rewritten", "ageMinutes": 900.0
        }))
        .unwrap();
        assert_eq!(work_digest(&[plain]), work_digest(&[dressed]));
    }

    fn with_blocker(id: &str, status: &str, blocker: serde_json::Value) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({
            "issueId": id, "status": status, "relations": [blocker]
        }))
        .expect("admissible fixture")
    }

    #[test]
    fn the_digest_moves_when_a_rows_own_status_does() {
        let held: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "developed" }))
                .unwrap();
        let takeable: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "reopen" }))
                .unwrap();
        assert_ne!(work_digest(&[held]), work_digest(&[takeable]));
    }

    #[test]
    fn the_digest_moves_when_a_blockers_status_does() {
        let blocked = with_blocker(
            "i1",
            "confirmed",
            serde_json::json!({
                "kind": "blocks", "dependsOnKey": "ISS-900",
                "blockerStatus": "needs_info", "blockerMergedAt": null,
                "edgeValidUntil": "2020-01-01T00:00:00.000Z"
            }),
        );
        let freed = with_blocker(
            "i1",
            "confirmed",
            serde_json::json!({
                "kind": "blocks", "dependsOnKey": "ISS-900",
                "blockerStatus": "developed", "blockerMergedAt": null,
                "edgeValidUntil": "2020-01-01T00:00:00.000Z"
            }),
        );
        assert_ne!(work_digest(&[blocked]), work_digest(&[freed]));
    }

    #[test]
    fn the_digest_ignores_a_relation_that_orders_nothing() {
        let bare: AdmissibleIssue =
            serde_json::from_value(serde_json::json!({ "issueId": "i1", "status": "confirmed" }))
                .unwrap();
        for kind in ["relates", "decomposes", "duplicates", "parent"] {
            let related = with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": kind, "dependsOnKey": "ISS-900", "blockerStatus": "needs_info"
                }),
            );
            assert_eq!(
                work_digest(std::slice::from_ref(&bare)),
                work_digest(&[related]),
                "a `{kind}` edge orders nothing, so it is not news"
            );
        }
    }

    #[test]
    fn the_digest_ignores_a_blockers_merge_stamp() {
        let edge = |merged: serde_json::Value| {
            with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": "blocks", "dependsOnKey": "ISS-900",
                    "blockerStatus": "needs_info", "blockerMergedAt": merged
                }),
            )
        };
        assert_eq!(
            work_digest(&[edge(serde_json::Value::Null)]),
            work_digest(&[edge(serde_json::json!("2026-09-18T00:00:00.000Z"))])
        );
    }

    #[test]
    fn the_digest_ignores_an_edges_expiry() {
        let edge = |until: serde_json::Value| {
            with_blocker(
                "i1",
                "confirmed",
                serde_json::json!({
                    "kind": "blocks", "dependsOnKey": "ISS-900",
                    "blockerStatus": "needs_info", "edgeValidUntil": until
                }),
            )
        };
        assert_eq!(
            work_digest(&[edge(serde_json::Value::Null)]),
            work_digest(&[edge(serde_json::json!("2020-01-01T00:00:00.000Z"))])
        );
    }

    #[test]
    fn the_digest_does_not_move_when_two_blockers_swap_places() {
        let one = serde_json::json!({ "kind": "blocks", "dependsOnKey": "ISS-1", "blockerStatus": "waiting" });
        let two = serde_json::json!({ "kind": "blocks", "dependsOnKey": "ISS-2", "blockerStatus": "on_hold" });
        let a: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed", "relations": [one.clone(), two.clone()]
        }))
        .unwrap();
        let b: AdmissibleIssue = serde_json::from_value(serde_json::json!({
            "issueId": "i1", "status": "confirmed", "relations": [two, one]
        }))
        .unwrap();
        assert_eq!(work_digest(&[a]), work_digest(&[b]));
    }

    #[test]
    fn claim_nudge_records_so_the_next_sweep_is_held_back() {
        let masters = Arc::new(Masters::new());
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        remember(&masters, "p1", &session);

        assert!(
            masters.claim_nudge("p1", 7, None, false),
            "the first sight of work nudges"
        );
        assert!(
            !masters.claim_nudge("p1", 7, None, false),
            "the same work on the next sweep must not spend another pass"
        );
        assert!(
            masters.claim_nudge("p1", 8, None, false),
            "new work nudges at once"
        );
    }

    #[test]
    fn a_master_that_answered_the_last_nudge_is_not_nudged_again_for_the_same_work() {
        let masters = Arc::new(Masters::new());
        let session = master_api::MasterSession {
            session_id: "s1".into(),
            name: "forge-master-p1".into(),
            created: true,
        };
        remember(&masters, "p1", &session);

        let before = reported(&[(agent_activity::Event::Stopped, None)]);
        assert!(masters.claim_nudge("p1", 7, Some(&before), false));
        age_last_nudge(&masters, "p1");

        let answered = reported(&[
            (agent_activity::Event::Stopped, None),
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert!(
            !masters.claim_nudge("p1", 7, Some(&answered), false),
            "the ceiling came round, the work is the same, and the master's own hooks say it ran the pass"
        );

        let wedged = reported(&[(agent_activity::Event::Stopped, None)]);
        age_last_nudge(&masters, "p1");
        assert!(
            masters.claim_nudge("p1", 7, Some(&wedged), false),
            "no prompt submitted since the nudge is a pass that never ran, and the ceiling exists for exactly that"
        );
    }

    /// Push a project's recorded nudge back past the refresh window.
    fn age_last_nudge(masters: &Arc<Masters>, project_id: &str) {
        let mut reg = masters.0.lock().expect("masters poisoned");
        let m = reg.live.get_mut(project_id).expect("no such master");
        let last = m.last_nudge.as_mut().expect("never nudged");
        last.at = a_while_ago();
    }

    #[test]
    fn a_project_with_no_master_is_never_nudged() {
        let masters = Masters::new();
        assert!(!masters.claim_nudge("nobody", 7, None, false));
    }

    #[test]
    fn the_repeat_decision_reads_only_what_the_agent_reported() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let body = production
            .split("fn since_nudge(")
            .nth(1)
            .and_then(|r| r.split("fn work_digest(").next())
            .expect("the repeat decision is gone");
        for banned in [
            "capture",
            "transcript",
            "terminal::",
            "tmux",
            "len()",
            "elapsed",
        ] {
            assert!(
                !body.contains(banned),
                "`{banned}` in the repeat decision is the quiet gate coming back with a new name (ISS-933 criteria 17 and 18)"
            );
        }
        assert!(
            body.contains("agent_activity::"),
            "every input to this decision is a frame the agent sent through `forge-runner hook`"
        );
    }

    #[test]
    fn every_nudge_in_the_sweep_is_gated_on_claim_nudge() {
        let production = THIS_SOURCE.split("#[cfg(test)]").next().unwrap();
        let sites: Vec<&str> = production
            .match_indices("nudge_master(")
            .map(|(i, _)| &production[i.saturating_sub(260)..i])
            .filter(|before| !before.ends_with("async fn ") && !before.ends_with("fn "))
            .collect();
        let calls = sites.len();
        assert_eq!(
            calls, 1,
            "expected exactly one nudge_master call site in production; found {calls}"
        );
        for before in sites {
            assert!(
                before.contains("claim_nudge("),
                "a nudge_master call must sit inside a claim_nudge gate — an ungated one spends a full agent pass on every sweep (~$0.18, measured 2026-09-08)"
            );
        }
    }
}

#[cfg(test)]
impl Masters {
    pub fn remember_for_test(&self, project_id: &str, session_id: &str, name: &str) {
        self.remember(
            project_id,
            MasterState {
                session_id: session_id.to_string(),
                name: name.to_string(),
                last_work: Instant::now(),
                last_nudge: None,
                mcp_stale_reported: false,
            },
        );
    }
}

/// What a master pane is told when this box cannot place it, and what the sweep
/// does to make that answer true (ISS-1092).
#[cfg(test)]
mod unplaced_tests {
    use super::*;

    const SOURCE: &str = include_str!("master.rs");

    fn production() -> &'static str {
        SOURCE.split("\n#[cfg(test)]").next().unwrap()
    }

    fn sweep_body() -> &'static str {
        production()
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("sweep must be findable")
    }

    /// `ensure_master`'s own source, bounded by its own closing brace.
    ///
    /// Not by the next `async fn`: the item after `ensure_master` is a plain
    /// `fn`, so that token would widen this by two hundred lines. Not by the
    /// next doc comment either — that put the boundary in prose, where a lint
    /// pass free to delete comments can move it.
    fn ensure_master_body() -> &'static str {
        let rest = production()
            .split("\nasync fn ensure_master(")
            .nth(1)
            .expect("ensure_master must be findable");
        let end = block_end(rest, 0).expect("ensure_master must close");
        &rest[..end]
    }

    fn block_end(rest: &str, indent: usize) -> Option<usize> {
        rest.find(&format!("\n{}}}", " ".repeat(indent)))
    }

    /// ISS-1235, criteria 1 and 13: the refusal is taken after the adopt branch
    /// and before anything is installed or minted, and nothing between the read
    /// and the placement turns a failed read into an empty declaration.
    #[test]
    fn a_failed_read_is_refused_before_the_skill_install_and_the_mint() {
        let body = ensure_master_body();
        let at = |needle: &str| {
            body.find(needle)
                .unwrap_or_else(|| panic!("`{needle}` must be in ensure_master"))
        };
        let refusal = at("servers_for_start(&asked)");
        assert!(
            at("if terminal::alive(&name).await {") < refusal,
            "adoption comes first"
        );
        assert!(
            refusal < at("install_skill("),
            "nothing is installed for a refused pane"
        );
        assert!(
            refusal < at("store.mint("),
            "nothing is minted for a refused pane"
        );
        assert!(
            refusal < at("write_session("),
            "the declaration written is the one read"
        );
        assert!(
            at("write_session(") < at("store.mint(")
                && at("Unplaced::ServersUnwritable") < at("store.mint("),
            "an unwritable config is refused before the mint, so no capability is left behind"
        );
        let ensure_failed = &body[at("could not start {name}")..];
        assert!(
            ensure_failed[..ensure_failed.find("return PaneState::Absent;").unwrap()]
                .contains("withdraw_unplaced_mint(tokens, &session.session_id)"),
            "a pane that could not be started gives back the capability minted for it"
        );
        assert!(
            !body.contains("unwrap_or_default()"),
            "a failed read must never become an empty declaration"
        );
        assert!(
            at("replacement_gate(") < at("end_deaf_pane("),
            "a deaf pane is gated on the read before it is ended"
        );
        let arm = &body[refusal..at("install_skill(")];
        assert!(
            arm.contains("say_unplaced(masters, project_id, &resolved.slug, why);")
                && arm.contains("return PaneState::Absent;"),
            "the refusal records its reason and places nothing: {arm}"
        );
        let started = at("terminal::ensure(");
        assert!(
            body[started..].contains("masters.clear_unplaced(project_id);"),
            "a placement after a refused sweep clears the recorded refusal"
        );
    }

    /// Criterion 2: the refusal is the project's recorded reason, carries what
    /// the read met, and is an error an operator reads.
    #[test]
    fn a_refused_start_is_recorded_naming_the_route_and_what_it_met() {
        let why = Unplaced::ServersUnreadable {
            detail: "me/mcp-servers 525 (gateway: the TLS handshake with the origin failed)".into(),
        };
        let said = why.to_string();
        assert!(
            said.contains("me/mcp-servers 525 (gateway: the TLS handshake"),
            "{said}"
        );
        assert!(why.is_error());
        assert_eq!(why.lead(), "no master pane placed");

        let masters = Arc::new(Masters::default());
        say_unplaced(&masters, "proj-1", "slug", why.clone());
        assert!(
            !masters.note_unplaced("proj-1", why.clone()),
            "the same reason on the next sweep is already recorded, so it is said once"
        );
        // Criterion 13: a placement clears it, as it clears every reason.
        masters.clear_unplaced("proj-1");
        assert!(masters.note_unplaced("proj-1", why));
    }

    /// Criterion 7.
    #[test]
    fn an_unwritable_config_is_recorded_naming_the_write() {
        let why = Unplaced::ServersUnwritable {
            detail: "permission denied; declared: playwright".into(),
        };
        let said = why.to_string();
        assert!(said.contains("could not be written"), "{said}");
        assert!(
            said.contains("permission denied; declared: playwright"),
            "{said}"
        );
        assert!(why.is_error());
    }

    /// The drained-runner branch of the sweep, on its own.
    ///
    /// Scoped to the branch rather than to the sweep, because the sweep holds
    /// four later `continue`s and an assertion that reads any of them cannot
    /// tell this branch leaving from this branch falling through.
    fn drain_branch() -> &'static str {
        let body = sweep_body();
        let start = body
            .find("if !accepts_new_work(&runner.status) {")
            .expect("the sweep still has its drained-runner branch");
        let rest = &body[start..];
        let end = block_end(rest, 8).expect("the drained-runner branch must close");
        &rest[..end]
    }

    /// The stale-capability report in `ensure_master`'s adopt branch, on its
    /// own.
    ///
    /// Scoped to the one match arm. `ensure_master` holds eight further
    /// `tracing::error!` calls, and both `{name}` and `session.session_id`
    /// appear again further down it — so an assertion over the rest of the
    /// function body holds whatever this report is written as.
    fn adopt_report() -> &'static str {
        let body = ensure_master_body();
        let start = body
            .find("Capability::Stale => {")
            .expect("the adopt branch must have an arm for a stale capability");
        let rest = &body[start..];
        let end = block_end(rest, 16).expect("the stale-capability arm must close");
        &rest[..end]
    }

    /// Make a directory unwritable, and say whether it took.
    ///
    /// A process with `CAP_DAC_OVERRIDE` — root in a container, which some CI
    /// is — writes into a directory whose mode forbids it, so the mode alone
    /// is not the plant. The probe is what establishes it, and a caller told
    /// `false` runs nothing rather than asserting against a map that is still
    /// perfectly writable.
    fn seal(dir: &std::path::Path) -> bool {
        #[cfg(unix)]
        {
            let mut locked = std::fs::metadata(dir).expect("dir mode").permissions();
            std::os::unix::fs::PermissionsExt::set_mode(&mut locked, 0o500);
            if std::fs::set_permissions(dir, locked).is_err() {
                return false;
            }
            let probe = dir.join(".seal-probe");
            if std::fs::write(&probe, b"x").is_ok() {
                let _ = std::fs::remove_file(&probe);
                unseal(dir);
                return false;
            }
            true
        }
        #[cfg(not(unix))]
        {
            let _ = dir;
            false
        }
    }

    fn unseal(dir: &std::path::Path) {
        #[cfg(unix)]
        {
            if let Ok(meta) = std::fs::metadata(dir) {
                let mut open = meta.permissions();
                std::os::unix::fs::PermissionsExt::set_mode(&mut open, 0o700);
                let _ = std::fs::set_permissions(dir, open);
            }
        }
        #[cfg(not(unix))]
        let _ = dir;
    }

    /// A capability map of this run's own, never this box's.
    fn temp_map(tag: &str) -> crate::test_scratch::InScratch {
        crate::test_scratch::Scratch::new(&format!("cap-{tag}")).at("control-tokens.json")
    }

    #[test]
    fn a_capability_minted_for_the_session_this_box_holds_reads_current() {
        let path = temp_map("current");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        store.mint("sess-A").expect("mint");
        assert_eq!(capability_of(Some(&store), "sess-A"), Capability::Current);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_map_that_names_only_other_sessions_reads_stale() {
        let path = temp_map("stale");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        store.mint("sess-OLD").expect("mint");
        assert_eq!(
            capability_of(Some(&store), "sess-NEW"),
            Capability::Stale,
            "this is the whole defect: the pane is up on a token for sess-OLD while core has replaced it with sess-NEW, and `session.created` is false because the replacement happened in an earlier sweep"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_map_that_was_never_written_reads_stale_rather_than_current() {
        let path = temp_map("absent");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        assert_eq!(
            capability_of(Some(&store), "sess-A"),
            Capability::Stale,
            "a box that has minted nothing can resolve nothing, so a pane running on it is refused; an absent map is an answer, unlike an unreadable one"
        );
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_map_this_box_cannot_read_is_never_reported_as_a_stale_capability() {
        let path = temp_map("torn");
        std::fs::write(&path, b"{\"07ccaad6\": ").expect("plant a half-written map");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        match capability_of(Some(&store), "sess-A") {
            Capability::Unknown(why) => assert!(
                !why.is_empty(),
                "the verdict has to carry why this box could not tell"
            ),
            other => panic!(
                "an unreadable map is not evidence about any pane; calling it {other:?} would report every master on the box as unplaceable at once"
            ),
        }
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn a_box_that_cannot_resolve_its_map_at_all_says_unknown() {
        match capability_of(None, "sess-A") {
            Capability::Unknown(_) => {}
            other => panic!("no map to ask is not an answer about the pane: {other:?}"),
        }
    }

    #[test]
    fn a_pane_that_stays_stale_is_reported_on_the_sweep_that_finds_it_and_not_after() {
        let masters = Masters::new();
        masters.remember_for_test("proj-1", "sess-NEW", "pane-1");
        assert!(
            masters.note_capability("proj-1", "stale"),
            "the sweep that first finds it has to report it"
        );
        for _ in 0..45 {
            assert!(
                !masters.note_capability("proj-1", "stale"),
                "45 passes against a pane in one unchanged state is the cost this defect charged for four hours on 2026-09-18"
            );
        }
        assert!(
            masters.note_capability("proj-1", "current"),
            "a state that changes is reported again, or a pane that recovers is never heard from"
        );
    }

    #[test]
    fn a_pane_whose_capability_is_stale_is_not_nudged() {
        let body = sweep_body();
        let guard = body
            .find("if pane == PaneState::StaleCapability {")
            .expect("the sweep has to notice a pane it already knows will be refused");
        let nudge = body
            .find("nudge_master(")
            .expect("the sweep must still nudge the panes that can act");
        assert!(
            guard < nudge,
            "the guard is only a guard if it is reached first"
        );
        assert!(
            body[guard..nudge].contains("continue;"),
            "the guard has to leave the iteration; a nudge to a pane whose declarations are refused spends a full master pass to produce a report nobody can act on"
        );
    }

    /// The finding the review of `7d13c344d` returned `changes-requested` on.
    /// Withdrawing the nudge took the account of the state with it: the pane
    /// runs a pass only when nudged, so it never declares, so `why_unplaced` is
    /// never called — and the adopt branch then cleared the registry's own
    /// record at the moment the daemon learned there was something to record
    /// (ISS-1099 criterion 9).
    #[test]
    fn the_sweep_that_finds_a_pane_refused_records_why_instead_of_clearing_it() {
        let body = ensure_master_body();
        let arm = body
            .split("Capability::Stale =>")
            .nth(1)
            .expect("the stale arm has to be findable");
        let arm = &arm[..arm
            .find("Capability::Unknown")
            .expect("the stale arm ends where the unknown arm starts")];
        assert!(
            arm.contains("Unplaced::StaleCapability"),
            "the sweep that learns a project has no working master is the only one that knows it; recording nothing leaves the daemon journal as the whole account"
        );
        assert!(
            !arm.contains("clear_unplaced("),
            "clearing here erases the record of why, at the exact moment there is finally a why to record"
        );
        for other in ["Capability::Current =>", "Capability::Unknown(why) =>"] {
            let arm = body
                .split(other)
                .nth(1)
                .expect("the arm has to be findable");
            let arm = &arm[..arm.find("PaneState::").unwrap_or(arm.len())];
            assert!(
                arm.contains("clear_unplaced("),
                "`{other}` is a pane this box CAN place, so whatever stood against it before no longer does"
            );
        }
    }

    /// A verdict reached and dropped is the defect over again. The sweep writes
    /// it down before it decides what to do about the pane, because every exit
    /// below that point is one where the verdict is the only thing left
    /// (ISS-1099 criterion 10).
    #[test]
    fn the_verdict_is_written_down_before_the_sweep_acts_on_it() {
        let body = sweep_body();
        let taken = body
            .find("authority.take()")
            .expect("the sweep has to collect what `ensure_master` reached");
        let written = body
            .find("write_authority(")
            .expect("and put it where a restart cannot take it");
        let absent_gate = body
            .find("if pane == PaneState::Absent {")
            .expect("the sweep still leaves the iteration for a project with no pane");
        assert!(
            taken < written && written < absent_gate,
            "a verdict collected after the gate that leaves the loop is a verdict nothing writes down"
        );
        let production = production();
        assert!(
            production.contains("fn write_authority("),
            "and the write is one function, so there is one place a reader has to check to know what the ledger can say"
        );
    }

    /// `note_capability`'s latch lived on `MasterState`, which `remember` fills
    /// — and `remember` runs after the sweep's first two reports. So a latch
    /// consulted before it answered "already said" about a project nothing had
    /// said anything about, and the report was lost. Across a daemon restart
    /// that is every project (ISS-1099 criterion 16).
    #[test]
    fn a_project_this_daemon_holds_no_master_for_is_still_reported_once() {
        let masters = Masters::new();
        assert!(
            masters.get("proj-1").is_none(),
            "the case is exactly a project the registry has never held — a daemon that has just adopted panes it did not start"
        );
        assert!(
            masters.note_capability("proj-1", "stood-down-contradicted"),
            "the first thing this box says about a project is a change from the nothing it said before"
        );
        for _ in 0..45 {
            assert!(
                !masters.note_capability("proj-1", "stood-down-contradicted"),
                "and saying it again is not news, whether or not a master was ever placed"
            );
        }
        assert!(
            masters.note_capability("proj-1", MasterAuthority::STALE),
            "a different thing said about the same project is said"
        );
    }

    /// Every remedy this daemon prints to its own journal is typed by an
    /// operator into a shell of their own, and masters run on a tmux server of
    /// the runner's own at a socket under the config directory. A bare `tmux
    /// kill-session` there reaches the DEFAULT server: it ends nothing, or it
    /// ends a same-named session belonging to something else. The one place
    /// the bare form is right is `Unplaced`'s `Display`, whose only reader is
    /// `run_declare` — that is, the pane, which is inside tmux and finds its
    /// own server through `$TMUX`.
    ///
    /// The status line was fixed for this under ISS-1099's own review; these
    /// four journal lines said the same wrong thing to the same reader.
    ///
    /// It is `-t` that is looked for and not the two words: an operator copies
    /// a command with a target in it, and naming the bare form to say it is
    /// NOT the remedy is the sentence that stops them reaching for it.
    #[test]
    fn no_line_this_daemon_logs_sends_an_operator_at_a_bare_tmux_kill_session() {
        let offenders: Vec<&str> = production()
            .lines()
            .filter(|l| l.contains("[master] ") && l.contains("tmux kill-session -t"))
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect();
        assert!(
            offenders.is_empty(),
            "a journal line is read in the operator's own shell, where `tmux kill-session` reaches a different server than the one masters run on — name `forge-runner master kill <slug>`: {offenders:#?}"
        );
        let display = production()
            .split("impl std::fmt::Display for Unplaced {")
            .nth(1)
            .and_then(|r| r.split("\nimpl Unplaced {").next())
            .expect("Unplaced's Display must be findable");
        assert!(
            display.contains("tmux kill-session -t {pane}"),
            "and the one sentence a PANE reads keeps the bare form, because a pane is inside tmux and reaches the right server without being told which: {display}"
        );
    }

    #[test]
    fn nothing_under_the_sweep_resolves_this_boxs_real_capability_map() {
        let production = production();
        assert_eq!(
            production.matches("session_tokens::default_path()").count(),
            1,
            "`default_path()` resolves the operator's live map, so every call under `sweep` is one `cargo test` away from minting into it. It is resolved once and passed down"
        );
        let rest = production
            .split("\npub async fn run(")
            .nth(1)
            .expect("the daemon loop must be findable");
        let run_body = &rest[..block_end(rest, 0).expect("run must close")];
        assert!(
            run_body.contains("session_tokens::default_path()"),
            "the one site is the daemon loop's own, beside the ledger it already resolves there — not anything a test can reach"
        );
        for reached in [
            "async fn sweep(",
            "async fn ensure_master(",
            "async fn take_pool_job(",
        ] {
            let f = production
                .split(reached)
                .nth(1)
                .expect("the function must be findable");
            assert!(
                !f[..f.find("\n}").unwrap_or(f.len())].contains("session_tokens::default_path()"),
                "`{reached}` runs on every sweep, so it takes the store it was given"
            );
        }
    }

    #[test]
    fn ensure_masters_source_stops_at_its_own_closing_brace() {
        let body = ensure_master_body();
        for beyond in [
            "async fn supervise(",
            "async fn retire_if_idle(",
            "async fn nudge_master(",
            "async fn end_master(",
        ] {
            assert!(
                !body.contains(beyond),
                "`{beyond}` is a later function, and a slice carrying it lets one of its tokens satisfy an assertion written about `ensure_master`"
            );
        }
        assert!(
            body.contains("adopting the resident session"),
            "the slice still has to carry the adopt branch it exists to measure"
        );
    }

    fn issue(id: &str) -> AdmissibleIssue {
        serde_json::from_value(serde_json::json!({ "issueId": id })).expect("admissible fixture")
    }

    /// The sentence this replaces promised thirty seconds on every path. A
    /// number here is a promise the sweep does not keep, and the pane that met
    /// it waited out fourteen hours of them.
    fn carries_no_deadline(why: &str) {
        for banned in ["thirty seconds", "30 seconds", "seconds,", " seconds."] {
            assert!(
                !why.contains(banned),
                "a refusal may not name a deadline the sweep does not enforce: {why}"
            );
        }
    }

    /// The sentence the registry now holds for this case. It has to name the
    /// one act that ends the state, because a refusal that says only "refused"
    /// sends an operator looking for a sweep that will never fix it.
    #[test]
    fn the_recorded_reason_for_a_refused_pane_names_the_act_that_ends_it() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.note_unplaced(
            "proj-1",
            Unplaced::StaleCapability {
                session: "sess-NEW".into(),
                pane: "forge-master-sidpeak".into(),
            },
        );
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("tmux kill-session -t forge-master-sidpeak"),
            "ending the pane is the only act that clears this, and it is not guessable from the symptom: {why}"
        );
        assert!(
            why.contains("sess-NEW"),
            "the session core now gives this box is what the pane's own capability has to be compared against: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_pane_whose_capability_names_a_replaced_session_is_told_that_and_not_told_to_wait() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.remember_for_test("proj-1", "sess-NEW", "pane-1");
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("sess-NEW") && why.contains("pane-1"),
            "the pane has to be told which session this box does hold, or it cannot tell a stale capability from a daemon that has not looked yet: {why}"
        );
        assert!(
            why.contains("stale"),
            "the reason the declaration fails is the capability, and naming anything else sends the master looking in the wrong place: {why}"
        );
        assert!(
            !why.contains("sweep"),
            "no sweep resolves this state — a pane cannot be handed a new capability, so naming one is the false promise this issue exists to remove: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_box_that_has_not_read_its_projects_says_so_rather_than_denying_the_project() {
        let masters = Masters::new();
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("has not yet read which projects it serves"),
            "an unread list is not an empty one: {why}"
        );
        assert!(
            !why.contains("does not serve"),
            "reading absence off a list this box never read is how a live master is told it was decommissioned: {why}"
        );
        assert!(!why.contains("sweep"), "nothing is promised here: {why}");
        carries_no_deadline(&why);
    }

    #[test]
    fn a_box_whose_read_failed_names_the_failure_rather_than_denying_the_project() {
        let masters = Masters::new();
        masters.note_served(Served::Unreadable("connect timeout".into()));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("connect timeout"),
            "the reason core could not be read is the only thing an operator can act on: {why}"
        );
        assert!(
            !why.contains("does not serve"),
            "a failed read is not a denial: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_project_missing_from_a_list_this_box_did_read_is_denied_by_name() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-2".into(), "proj-3".into()]));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("does not serve") && why.contains("proj-1"),
            "a snapshot that was read and does not hold the project is the one case this box may deny: {why}"
        );
        assert!(
            why.contains("no sweep here will place"),
            "the denial has to close the door rather than leave a master waiting on one: {why}"
        );
        assert!(
            !why.contains("next sweep"),
            "no sweep adds a project core does not serve to this box: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_recorded_reason_reaches_the_pane_that_asked() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.note_unplaced(
            "proj-1",
            Unplaced::Draining {
                status: "draining".into(),
            },
        );
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("draining"),
            "the precondition the sweep recorded is the whole deliverable of this refusal: {why}"
        );
        assert!(
            !why.contains("sweep place") && !why.contains("next sweep places"),
            "a recorded obstacle is not a wait: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn only_a_served_project_with_nothing_against_it_is_promised_the_next_sweep() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        let why = masters.why_unplaced("proj-1");
        assert!(
            why.contains("next sweep"),
            "this is the one state a wait is the right answer for, and a master told nothing here stops declaring for good: {why}"
        );
        carries_no_deadline(&why);
    }

    #[test]
    fn a_reason_is_reported_when_it_arrives_and_when_it_changes_and_never_in_between() {
        let masters = Masters::new();
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NothingAdmissible),
            "a reason nothing has said yet is new"
        );
        assert!(
            !masters.note_unplaced("proj-1", Unplaced::NothingAdmissible),
            "the same reason on the next sweep says nothing"
        );
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NoRepoPath),
            "a different reason is a different thing for an operator to do"
        );
        masters.clear_unplaced("proj-1");
        assert!(
            masters.note_unplaced("proj-1", Unplaced::NoRepoPath),
            "a project placed and then unplaced again is reported again — the clear is what makes the next report honest"
        );
    }

    #[test]
    fn a_placed_project_has_nothing_recorded_against_it() {
        let masters = Masters::new();
        masters.note_served(Served::Read(vec!["proj-1".into()]));
        masters.note_unplaced("proj-1", Unplaced::NothingAdmissible);
        let held = masters.why_unplaced("proj-1");
        assert!(
            held.contains("nothing claimable"),
            "while the reason stands it is what the pane is told: {held}"
        );
        masters.clear_unplaced("proj-1");
        let cleared = masters.why_unplaced("proj-1");
        assert_ne!(
            held, cleared,
            "a refusal that reads the same before and after the state changed is one nothing can learn from"
        );
        assert!(
            !cleared.contains("nothing claimable"),
            "a reason that outlives the state it described is a refusal that lies: {cleared}"
        );
    }

    #[test]
    fn an_empty_pool_still_places_a_pane_that_already_exists() {
        assert_eq!(
            placement_for(&[]),
            Placement::AdoptOnly,
            "a project with nothing claimable still has its live pane adopted and re-registered, or core reaps the row that pane's capability names"
        );
        assert_eq!(
            placement_for(&[issue("a")]),
            Placement::AdoptOrStart,
            "a project with work may have a master started for it"
        );
    }

    #[test]
    fn the_empty_pool_branch_no_longer_skips_the_registration() {
        let body = sweep_body();
        assert!(
            body.contains("placement_for(&admissible)"),
            "the sweep decides placement from the pool through the named function, so the decision is a thing a test can call"
        );
        assert!(
            !body.contains("|| masters.get(&runner.project_id).is_none()"),
            "this short-circuit is what skipped `ensure_master` for a quiet project, and with it the `register` that keeps a live pane's session row beating (ISS-1092)"
        );
        assert!(
            body.contains("ensure_master(") && body.contains("placement,"),
            "the placement has to reach `ensure_master`, or the branch decides nothing"
        );
    }

    #[test]
    fn adopt_only_answers_absent_before_it_asks_core_for_a_session() {
        let body = ensure_master_body();
        let guard = body
            .find("Placement::AdoptOnly && !terminal::alive")
            .expect("the adopt-only path must ask tmux whether a pane is there");
        let register = body
            .find("master_api::register(")
            .expect("ensure_master must register with core");
        assert!(
            guard < register,
            "a sweep that starts no master must not create a session row for one"
        );
    }

    #[test]
    fn adopt_only_cannot_fall_through_to_the_spawn_when_the_pane_dies_mid_registration() {
        let body = ensure_master_body();
        let adopted = body
            .find("let verdict = verdict_over_unwithdrawn(")
            .expect("the adopt branch must judge the capability the pane holds");
        let spawn = body
            .find("install_skill(&resolved.repo_path)")
            .expect("the spawn path must start with the skill install");
        let between = &body[adopted..spawn];
        assert!(
            between.contains("return match verdict {"),
            "the adopt branch falls through to the spawn for one reason only — it ended a deaf pane — and returns on the verdict in every other case (ISS-1208)"
        );
        assert!(
            between.contains("if placement == Placement::AdoptOnly {"),
            "a pane that exits while `register` is awaited must not turn `AdoptOnly` into a spawn"
        );
    }

    #[test]
    fn every_adopted_pane_is_judged_against_this_boxs_own_capability_map() {
        let body = ensure_master_body();
        let adopt = body
            .find("adopting the resident session")
            .expect("the adopt branch must be findable");
        let after = &body[adopt..];
        assert!(
            after.contains("capability_of(tokens, &session.session_id)"),
            "every adopt asks the map what this box actually minted; that is the only question whose answer is the same for all seven panes on a box"
        );
        assert!(
            !after.contains("session.created"),
            "`session.created` is true only when core minted the row at this very call, so a pane whose row was replaced in an earlier sweep is adopted in silence and refused forever — one project of seven was reported on 2026-09-18 and the stuck one was not (ISS-1099)"
        );
        let report = adopt_report();
        assert!(
            report.contains("tracing::error!"),
            "it is an error and not an info or a warn: the only recovery is an operator ending the pane, and nothing on this box will do it: {report}"
        );
        assert!(
            report.contains("{name}"),
            "the report names the pane to end, because that is what the operator acts on: {report}"
        );
        assert!(
            report.contains("session.session_id"),
            "the report names the session this box now holds, which is what tells a stale capability from a daemon that has not looked yet: {report}"
        );
    }

    #[test]
    fn a_drained_runner_has_no_master_pane_placed_for_it() {
        let branch = drain_branch();
        assert!(
            branch.contains("continue;"),
            "a drained runner must leave the iteration before placement, or core taking a project off this box still starts a master for it: {branch}"
        );
        assert!(
            !branch.contains("ensure_master("),
            "placement must sit outside the drained branch, not inside it"
        );
        let body = sweep_body();
        let drain = body
            .find("if !accepts_new_work(&runner.status) {")
            .expect("the sweep still has its drained-runner branch");
        let ensure = body
            .find("ensure_master(")
            .expect("the sweep must place panes through ensure_master");
        assert!(
            drain < ensure,
            "the drain branch has to be reached before placement, or it decides nothing"
        );
    }

    #[test]
    fn a_drained_runner_records_its_status_as_the_reason_no_pane_was_placed() {
        let branch = drain_branch();
        assert!(
            branch.contains("note_unplaced("),
            "the sweep has to record why it placed no pane, or the refusal a master gets has nothing to carry: {branch}"
        );
        assert!(
            branch.contains("Unplaced::Draining"),
            "the reason recorded for a drained runner is the drain itself: {branch}"
        );
        assert!(
            branch.contains("runner.status"),
            "the runner row's own status is what an operator changes, so it is the status that is carried and not a fixed word: {branch}"
        );
    }

    #[test]
    fn an_unplaced_pane_is_reported_once_and_names_its_project_and_reason() {
        let masters = Arc::new(Masters::new());
        let first = super::give_back_tests::logged_while(|| {
            say_unplaced(
                &masters,
                "proj-1",
                "the-slug",
                Unplaced::Draining {
                    status: "draining".into(),
                },
            );
        });
        assert!(
            first.contains("WARN"),
            "at WARN: a project this box cannot place a master for is not routine information, and \
             a reason nothing writes down is one no operator ever reads; log was: {first}"
        );
        assert!(
            first.contains("the-slug"),
            "the warning names the project, or a box serving 28 of them says only that something \
             is unplaced; log was: {first}"
        );
        assert!(
            first.contains("draining"),
            "and carries the reason, which is the whole of what an operator acts on; log was: \
             {first}"
        );

        let again = super::give_back_tests::logged_while(|| {
            say_unplaced(
                &masters,
                "proj-1",
                "the-slug",
                Unplaced::Draining {
                    status: "draining".into(),
                },
            );
        });
        assert!(
            again.is_empty(),
            "the SAME reason on the next sweep says nothing. This box sweeps every thirty seconds, \
             so a line per sweep per project is one a reader learns to scroll past — including on \
             the sweep where the reason changed; log was: {again}"
        );

        let changed = super::give_back_tests::logged_while(|| {
            say_unplaced(&masters, "proj-1", "the-slug", Unplaced::NoRepoPath);
        });
        assert!(
            changed.contains("WARN") && changed.contains("checkout"),
            "a DIFFERENT reason is a different thing for an operator to do, so it is reported \
             again; log was: {changed}"
        );
    }

    fn deaf(slug: &str, acted: DeafAct) -> Deaf {
        Deaf {
            slug: slug.to_string(),
            pane: format!("forge-master-{slug}"),
            acted,
        }
    }

    #[test]
    fn a_pane_this_box_can_never_hear_again_is_ended_where_one_would_replace_it() {
        assert_eq!(
            capability_act(&Capability::Stale, Placement::AdoptOrStart),
            CapabilityAct::Replace,
            "a master that cannot be heard is not a master, and the operator who ends it adds no judgement this box does not already hold (ISS-1208)"
        );
    }

    #[test]
    fn a_map_this_box_could_not_read_never_ends_a_pane() {
        for placement in [Placement::AdoptOrStart, Placement::AdoptOnly] {
            assert_eq!(
                capability_act(
                    &Capability::Unknown("the map is a directory".to_string()),
                    placement
                ),
                CapabilityAct::Keep,
                "an unreadable capability map is evidence about the map and not about any pane; acting on it would end every master on the box at once, which is the reason `capability_of` keeps three answers and not two"
            );
        }
    }

    #[test]
    fn a_pane_that_can_be_heard_is_never_touched() {
        for placement in [Placement::AdoptOrStart, Placement::AdoptOnly] {
            assert_eq!(
                capability_act(&Capability::Current, placement),
                CapabilityAct::Keep,
                "the capability resolves, so there is nothing here to recover from"
            );
        }
    }

    #[test]
    fn a_deaf_pane_that_no_replacement_would_follow_is_left_standing() {
        match capability_act(&Capability::Stale, Placement::AdoptOnly) {
            CapabilityAct::LeaveDeaf(why) => assert!(
                why.contains("no admissible work"),
                "the reason has to say why the box stopped short, or a reader cannot tell it from a box that did not look: {why}"
            ),
            other => panic!(
                "ending a pane no replacement would follow buys an empty project instead of a working master, and ISS-1208 conditions the act on a replacement being placed: got {other:?}"
            ),
        }
    }

    #[test]
    fn one_record_names_every_project_the_box_found_deaf() {
        let found = vec![
            deaf("mowment", DeafAct::Replaced),
            deaf("sidpeak", DeafAct::Replaced),
            deaf("sid-desk", DeafAct::Replaced),
            deaf(
                "pixelight",
                DeafAct::LeftStanding("this box could not end it: no server".to_string()),
            ),
        ];
        let (needs_a_person, said) =
            deaf_fleet_report(&found).expect("a box holding deaf masters has something to say");
        for slug in ["mowment", "sidpeak", "sid-desk", "pixelight"] {
            assert!(
                said.contains(slug),
                "a fleet that went deaf at once is a condition of the BOX, and a record naming three of four leaves the fourth to whoever reads the per-project lines: {said}"
            );
        }
        assert!(
            needs_a_person,
            "one pane still standing is an act somebody owes, and a warning is what a reader scrolls past"
        );
    }

    #[test]
    fn a_box_with_no_deaf_master_says_nothing_about_the_fleet() {
        assert!(
            deaf_fleet_report(&[]).is_none(),
            "a fleet that is well is not a thing to announce"
        );
    }

    #[test]
    fn a_fleet_that_put_itself_right_is_told_without_asking_for_anybody() {
        let (needs_a_person, said) = deaf_fleet_report(&[deaf("mowment", DeafAct::Replaced)])
            .expect("a pane replaced is still a thing that happened");
        assert!(
            !needs_a_person,
            "nothing is owed: the box ended the pane and placed its replacement in the same pass"
        );
        assert!(
            said.contains("replaced"),
            "the record has to say what was DONE, not only what was found: {said}"
        );
    }

    #[test]
    fn the_box_level_record_is_not_restated_until_the_set_moves() {
        let masters = Masters::new();
        let one = vec![deaf(
            "mowment",
            DeafAct::LeftStanding("nothing".to_string()),
        )];
        assert!(
            masters.claim_deaf_report(Some(deaf_digest(&one))),
            "the sweep that reaches the condition is the one that says it"
        );
        assert!(
            !masters.claim_deaf_report(Some(deaf_digest(&one))),
            "this box sweeps every thirty seconds; a standing condition restated on each is the line a reader learns to scroll past"
        );
        let two = vec![
            deaf("mowment", DeafAct::LeftStanding("nothing".to_string())),
            deaf("sidpeak", DeafAct::Replaced),
        ];
        assert!(
            masters.claim_deaf_report(Some(deaf_digest(&two))),
            "a second project going deaf is a different condition of the box and is news again"
        );
        assert!(
            !masters.claim_deaf_report(None),
            "a sweep that found none announces nothing"
        );
        assert!(
            masters.claim_deaf_report(Some(deaf_digest(&two))),
            "the latch cleared with the condition, so a fleet that goes deaf a second time is news again"
        );
    }

    #[test]
    fn what_was_done_is_part_of_the_condition_and_not_only_which_panes() {
        let standing = vec![deaf(
            "mowment",
            DeafAct::LeftStanding("nothing admissible".to_string()),
        )];
        let replaced = vec![deaf("mowment", DeafAct::Replaced)];
        assert_ne!(
            deaf_digest(&standing),
            deaf_digest(&replaced),
            "the same pane left standing and then ended are two different things to tell a reader, and a latch keyed on the panes alone would tell them only the first"
        );
    }

    /// The reason in a `LeftStanding` is an error string this code did not
    /// write, so it can hold whatever a separator would have meant.
    #[test]
    fn one_pane_carrying_a_reason_can_never_read_as_two_panes() {
        // Exactly what the separator-joined encoding would have made of the
        // two below, carried inside the reason of the one above it.
        let one = vec![deaf(
            "a",
            DeafAct::LeftStanding("x|forge-master-b=replaced".to_string()),
        )];
        let two = vec![
            deaf("a", DeafAct::LeftStanding("x".to_string())),
            deaf("b", DeafAct::Replaced),
        ];
        assert_ne!(
            deaf_digest(&one),
            deaf_digest(&two),
            "a digest two different fleets can share is a latch that stays silent about the second of them, and the reason is tmux's text rather than ours to constrain"
        );
    }

    #[test]
    fn a_pane_ended_and_never_replaced_is_a_third_answer_and_asks_for_a_person() {
        let (needs_a_person, said) = deaf_fleet_report(&[deaf("mowment", DeafAct::EndedUnplaced)])
            .expect("a project left with no pane at all is a thing that happened");
        assert!(
            needs_a_person,
            "the box ended a pane and placed nothing: that project has no master until a sweep succeeds, which is not the state a warning describes"
        );
        assert!(
            said.contains("mowment"),
            "the record names the project, or the reader has three answers and no subjects: {said}"
        );
        assert_ne!(
            deaf_digest(&[deaf("m", DeafAct::EndedUnplaced)]),
            deaf_digest(&[deaf("m", DeafAct::Replaced)]),
            "a pane ended and a pane replaced are two conditions, and a latch that read them as one would report only whichever came first"
        );
    }

    #[test]
    fn the_account_becomes_a_replacement_only_once_a_pane_is_up() {
        let sink = DeafSink::default();
        sink.set("mowment", "forge-master-mowment", DeafAct::EndedUnplaced);
        sink.placed();
        assert_eq!(
            sink.take().expect("the sink held a pane").acted,
            DeafAct::Replaced,
            "a pane placed where one was ended is a replacement"
        );

        let refused = DeafSink::default();
        refused.set(
            "sidpeak",
            "forge-master-sidpeak",
            DeafAct::LeftStanding("nothing admissible".to_string()),
        );
        refused.placed();
        assert_eq!(
            refused.take().expect("the sink held a pane").acted,
            DeafAct::LeftStanding("nothing admissible".to_string()),
            "a pane left standing was never ended, so a placement elsewhere in the call does not make it a replacement"
        );

        let untouched = DeafSink::default();
        untouched.placed();
        assert!(
            untouched.take().is_none(),
            "every cold start runs this line; one that found no deaf pane must not invent a record of having replaced one"
        );
    }

    /// The chain criterion 7 governs, walked against a real pane this box
    /// could not end, rather than read off the source.
    ///
    /// What stood here before was an assertion over `end_deaf_pane`'s TEXT. It
    /// went red when the text changed and it could not go red for the
    /// proposition its name made, because the branch it was about was dead
    /// code: `terminal::kill` answered `Ok` whatever tmux did, so the box read
    /// every kill as one that took. A refused kill was then written down as a
    /// replacement, `current` was recorded about a pane still holding the old
    /// token, and the mint taken on the way silenced the stale verdict for
    /// good — the alarm removed by the change that exists to make it louder
    /// (ISS-1208).
    ///
    /// Here tmux genuinely refuses and the session genuinely survives, which is
    /// the pair tmux itself produces and which this test asserts before it
    /// asserts anything about us.
    #[cfg(unix)]
    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn a_deaf_pane_tmux_would_not_end_is_left_standing_on_the_record() {
        let _serialised = terminal::testing::ONE_AT_A_TIME.lock().await;
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let iso = terminal::testing::IsolatedServer::new("deafkill");
        if !terminal::available() {
            eprintln!("tmux is not installed here — the transport this rests on cannot run");
            return;
        }
        if !iso.took() {
            eprintln!("this box does not resolve its tmux socket from the config dir, so the only server here is its own — not starting a pane on it");
            return;
        }
        let dir = crate::test_scratch::Scratch::new("deafkill");
        let name = terminal::session_name(terminal::MASTER_PREFIX, "deafkill");
        terminal::ensure(
            &name,
            &dir,
            &["sleep".to_string(), "60".to_string()],
            &[],
            None,
        )
        .await
        .expect("the pane standing in for the deaf master must start");

        let sink = DeafSink::default();
        let ended = {
            let _refusing = terminal::testing::RefusingKill::installed();
            end_deaf_pane(&name, "deafkill", "sess-core-serves-now", &sink).await
        };

        assert!(
            terminal::alive(&name).await,
            "the plant is only the plant while the pane is still there: a kill that took proves nothing about one that did not"
        );
        assert!(
            !ended,
            "the pane is still running, so the caller must fall to the branch that leaves it standing and records `stale` — answering true here is how the sweep goes on nudging a master that refuses every declaration it makes"
        );
        let held = sink.take().expect("a deaf pane the box met is recorded");
        match held.acted {
            DeafAct::LeftStanding(why) => assert!(
                why.contains("could not end it"),
                "the reason is what tells a reader the box tried and failed rather than chose not to: {why}"
            ),
            other => panic!(
                "a pane that is still running was recorded as {other:?} — the box-level record then tells an operator this project was put right, and nothing ever says otherwise again"
            ),
        }

        // And the same call against the same pane, with tmux no longer
        // refusing, still ends it: the guard above may not cost the box the
        // recovery it exists for.
        let took = DeafSink::default();
        assert!(
            end_deaf_pane(&name, "deafkill", "sess-core-serves-now", &took).await,
            "with tmux taking the kill this is the act ISS-1208 was filed for"
        );
        assert!(!terminal::alive(&name).await, "the pane is gone");
        assert_eq!(
            took.take().expect("the sink held a pane").acted,
            DeafAct::EndedUnplaced,
            "ending is all this function did; the placement below it is what upgrades the answer"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_upgrade_is_taken_only_after_the_pane_is_actually_running() {
        let body = ensure_master_body();
        let started = body
            .find("terminal::ensure(")
            .expect("the placement path starts the pane through terminal::ensure");
        let upgraded = body
            .find("ports.deaf.placed()")
            .expect("the placement path has to say a pane is up where one was ended");
        assert!(
            started < upgraded,
            "read before the pane is running, the account says `replaced` about every return between the kill and here — the mint, the skill, the MCP config and tmux each refuse after the pane is already gone"
        );
    }

    #[test]
    fn the_box_ends_a_deaf_pane_before_it_falls_through_to_the_placement() {
        let body = ensure_master_body();
        let judged = body
            .find("capability_act(&verdict, placement)")
            .expect("the adopt branch decides what to do through the named rule");
        let ended = body
            .find("end_deaf_pane(")
            .expect("the adopt branch ends the pane itself; nothing else on this box will");
        let returned = body
            .find("return match verdict {")
            .expect("every other verdict still returns from the adopt branch");
        assert!(
            judged < ended && ended < returned,
            "the pane is ended only after the rule says so, and the fall-through to the placement path is what puts a capability the box can hear onto its replacement (ISS-1208)"
        );
    }

    /// The SHAPE of `end_deaf_pane`, which is all an assertion over text can
    /// answer for.
    ///
    /// It used to be named for the proposition that a kill which did not
    /// happen is never written down as one that did, and it could not go red
    /// for it: the branch it read was dead code while `terminal::kill` answered
    /// `Ok` whatever tmux did. That proposition is now
    /// `a_deaf_pane_tmux_would_not_end_is_left_standing_on_the_record`, which
    /// walks a real pane tmux refuses to end. This keeps the three structural
    /// guards and claims nothing more.
    #[test]
    fn end_deaf_pane_keeps_ending_and_placing_apart_in_its_text() {
        let body = production();
        let rest = body
            .split("\nasync fn end_deaf_pane(")
            .nth(1)
            .expect("end_deaf_pane must be findable");
        let f = &rest[..block_end(rest, 0).expect("end_deaf_pane must close")];
        let refused = f
            .find("if let Err(e) = terminal::kill(name).await {")
            .expect("tmux can refuse, and a daemon that assumed it did not would record a kill that never happened");
        let done = f
            .find("DeafAct::EndedUnplaced")
            .expect("a pane that WAS ended is recorded as ended, which is the whole of what this function knows");
        assert!(
            !f.contains("DeafAct::Replaced"),
            "ending is not placing: a replacement is what the placement path below records once a pane is actually up, and claiming it here tells a reader a pane is running that may not be"
        );
        assert!(
            refused < done && f[refused..done].contains("return false"),
            "a failed kill leaves the pane up, so the caller has to take the branch that records `stale` about a pane that is still running"
        );
        assert!(
            f[refused..done].contains("DeafAct::LeftStanding"),
            "a kill this box could not take is exactly the case the box-level record exists to put in front of a person"
        );
    }

    #[test]
    fn only_a_pass_that_ended_a_pane_can_find_one_that_survived_its_kill() {
        assert_eq!(
            replacement_of(true, true),
            Replacement::Placed,
            "a pane was started where the deaf one had been, which is the act ISS-1208 asks for"
        );
        assert_eq!(
            replacement_of(true, false),
            Replacement::DeafPaneSurvived,
            "the kill answered Ok and a session of that name is still alive — the one reading left that says the box replaced nothing"
        );
        for started in [true, false] {
            assert_eq!(
                replacement_of(false, started),
                Replacement::NoDeafPane,
                "a cold start that ended nothing says nothing about any deaf pane, and a pass that read one here would refuse every ordinary placement on this box"
            );
        }
    }

    /// The repair, walked rather than read: what the box does with the
    /// capability it minted for a replacement it turns out not to have made.
    ///
    /// The mint has to run before the pane starts, because the token goes into
    /// that pane's environment. So by the time the box learns nothing was
    /// replaced, the session core now serves is already in its capability map —
    /// and `capability_of` answers `Current` about a pane still holding the old
    /// token from then on, for ever. That is this issue's own incident with the
    /// alarm taken out, and it is why the withdrawal below is the part that
    /// matters (ISS-1208, criterion 7).
    #[tokio::test]
    async fn a_pane_that_outlived_its_kill_takes_the_minted_capability_back_down_with_it() {
        let path = temp_map("outlived");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        store.mint("sess-core-serves-now").expect("mint");
        assert!(
            matches!(
                capability_of(Some(&store), "sess-core-serves-now"),
                Capability::Current
            ),
            "the mint is what the placement path takes before it starts anything, and it is what makes the verdict read current"
        );

        let masters = Arc::new(Masters::new());
        let authority = AuthoritySink::default();
        let deaf = DeafSink::default();
        let state = deaf_pane_outlived_its_kill(
            &masters,
            "proj-1",
            "mowment",
            "forge-master-mowment",
            "sess-core-serves-now",
            &CapabilityPorts {
                tokens: Some(&store),
                authority: &authority,
                deaf: &deaf,
            },
        )
        .await;

        assert_eq!(
            state,
            PaneState::StaleCapability,
            "the pane is still deaf, so the sweep must go on skipping the nudge rather than talking to it"
        );
        assert!(
            matches!(
                capability_of(Some(&store), "sess-core-serves-now"),
                Capability::Stale
            ),
            "leaving the mint standing is what silences the stale arm on every later sweep — the operator is never told again, and the box nudges a master that refuses every declaration it makes"
        );
        let said = authority
            .take()
            .expect("a verdict was reached about this pane");
        assert_eq!(
            said.verdict,
            MasterAuthority::STALE,
            "`forge-runner master status` reads this row, and `current` there tells an operator the box put the project right"
        );
        match deaf.take().expect("the box met a deaf pane").acted {
            DeafAct::LeftStanding(_) => {}
            other => panic!(
                "a pane still running was recorded as {other:?}, which is what the one box-level record then tells a person"
            ),
        }
        let _ = std::fs::remove_dir_all(path.parent().expect("temp dir"));
    }

    /// The rollback answers for itself, or it is not a rollback.
    ///
    /// `retire` logs and returns on a map it could not read and on a map it
    /// could not write, which is right for tidying up after a session that has
    /// already ended and wrong for this, where the entry left behind is the
    /// session core now serves — sitting in the map as proof of a replacement
    /// this box did not make. Raised as F1 on the review of `b15ff428b`.
    #[test]
    fn a_withdrawal_that_did_not_take_is_never_reported_as_one_that_did() {
        let path = temp_map("withdrawn");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        store.mint("sess-core-serves-now").expect("mint");
        assert_eq!(
            withdraw_unplaced_mint(Some(&store), "sess-core-serves-now"),
            Ok(()),
            "a map this box can write is the ordinary case, and the withdrawal has to be reported as taken there or the recovery is refused on every box"
        );

        // The map made unwritable under the entry, which is what `retire`
        // meets when the disk fills between the mint and the rollback.
        store.mint("sess-core-serves-now").expect("re-mint");
        let dir = path.parent().expect("temp dir");
        if !seal(dir) {
            eprintln!("this box writes into a directory it has no write bit on — root, most likely — so the map cannot be made unwritable here and the plant is not the plant");
            let _ = std::fs::remove_dir_all(dir);
            return;
        }
        let said = withdraw_unplaced_mint(Some(&store), "sess-core-serves-now");
        unseal(dir);

        assert!(
            said.is_err(),
            "the entry is still in the map, so the next sweep reads this pane as current and stops recovering it — a box that reports that as a withdrawal has removed its own alarm and told nobody"
        );
        assert!(
            matches!(
                capability_of(Some(&store), "sess-core-serves-now"),
                Capability::Current
            ),
            "this is the state the message has to be about: the verdict really does read current from here on, and only an operator breaks it"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_cancel_that_could_not_end_its_pane_says_so_before_it_answers_gone() {
        let body = include_str!("inbox.rs");
        let start = body
            .find("\"cancel\" => {")
            .expect("the inbox still handles a cancel frame");
        let arm = &body[start
            ..start
                + body[start..]
                    .find("\"checkpoint\" => {")
                    .expect("the cancel arm is followed by the next one")];
        assert!(
            !arm.contains("let _ = terminal::kill("),
            "`Ack::Gone` is sent unconditionally here because the ack has no third answer, so a kill that did not take has to be reported by the box or core is told a running pane is gone and nothing anywhere says otherwise (ISS-1208)"
        );
        let refused = arm
            .find("if let Err(e) = terminal::kill(")
            .expect("the cancel path reads what the kill answered");
        let acked = arm
            .find("Ack::Gone")
            .expect("the cancel path still answers the frame");
        assert!(
            refused < acked,
            "the report comes before the ack, so a reader of the log sees why the `gone` it is about to read is not the whole truth"
        );
    }

    /// Criterion 7 says the verdict STAYS stale, which is a claim about every
    /// later sweep.
    ///
    /// A read-back that only tells the truth once leaves the map saying
    /// `current` about a pane that was never replaced, and the sweep after it
    /// believes the map. Raised on the recheck of F1.
    #[test]
    fn a_mint_this_box_could_not_take_back_is_never_read_as_evidence_again() {
        assert!(
            matches!(
                verdict_over_unwithdrawn(Capability::Current, Some("sess-A"), "sess-A"),
                Capability::Stale
            ),
            "the entry in the map is a mint for a pane that was never placed, so reading it as current is how the box stops recovering a project it has already reported deaf"
        );
        assert!(
            matches!(
                verdict_over_unwithdrawn(Capability::Current, Some("sess-OLD"), "sess-A"),
                Capability::Current
            ),
            "what this box could not withdraw was some other session's, and holding it against this one would refuse a pane that is perfectly reachable"
        );
        assert!(
            matches!(
                verdict_over_unwithdrawn(Capability::Current, None, "sess-A"),
                Capability::Current
            ),
            "every ordinary sweep on this box comes through here, and one that read a stale verdict would end a healthy master"
        );
        assert!(
            matches!(
                verdict_over_unwithdrawn(Capability::Stale, Some("sess-A"), "sess-A"),
                Capability::Stale
            ),
            "stale stays stale"
        );
        match verdict_over_unwithdrawn(
            Capability::Unknown("no map".to_string()),
            Some("sess-A"),
            "sess-A",
        ) {
            Capability::Unknown(_) => {}
            other => panic!(
                "an unreadable map is not evidence about any pane in either direction, and {other:?} here would end one on the strength of a map nobody could read"
            ),
        }
    }

    /// The whole of criterion 7 over two sweeps, which is the unit the
    /// criterion is actually about.
    #[tokio::test]
    async fn a_withdrawal_that_failed_keeps_the_verdict_stale_on_the_sweep_after_it() {
        let path = temp_map("stays-stale");
        let store = session_tokens::SessionTokens::at(path.to_path_buf());
        let masters = Arc::new(Masters::new());
        let dir = path.parent().expect("temp dir").to_path_buf();

        store.mint("sess-core-serves-now").expect("mint");
        if !seal(&dir) {
            eprintln!("this box writes into a directory it has no write bit on — root, most likely — so the map cannot be made unwritable here and the plant is not the plant");
            let _ = std::fs::remove_dir_all(&dir);
            return;
        }
        let authority = AuthoritySink::default();
        let deaf = DeafSink::default();
        deaf_pane_outlived_its_kill(
            &masters,
            "proj-1",
            "mowment",
            "forge-master-mowment",
            "sess-core-serves-now",
            &CapabilityPorts {
                tokens: Some(&store),
                authority: &authority,
                deaf: &deaf,
            },
        )
        .await;
        unseal(&dir);

        // The sweep after it, reading the same map.
        assert!(
            matches!(
                capability_of(Some(&store), "sess-core-serves-now"),
                Capability::Current
            ),
            "the map really does say current — the withdrawal could not be written, and nothing that could correct the map is available to a box that could not write it"
        );
        assert!(
            matches!(
                verdict_over_unwithdrawn(
                    capability_of(Some(&store), "sess-core-serves-now"),
                    masters.unwithdrawn_for("proj-1").as_deref(),
                    "sess-core-serves-now",
                ),
                Capability::Stale
            ),
            "and the box refuses to read it, so the project goes on being reported deaf and the pane goes on being ended — which is what `stays stale` means"
        );
        assert_eq!(
            capability_act(&Capability::Stale, Placement::AdoptOrStart),
            CapabilityAct::Replace,
            "the retry is the ordinary sweep: a stale verdict with admissible work ends the pane again, and a placement that works clears what is held here"
        );
        // And what the box SAYS about it has to be that, or an operator is told
        // to intervene by hand on a state the daemon is in fact retrying every
        // sweep. Raised as F3 on the review of ba415f04f.
        match deaf.take().expect("the box met a deaf pane").acted {
            DeafAct::LeftStanding(why) => {
                assert!(
                    why.contains("retried every sweep"),
                    "the one box-level record is where a person reads this, and it has to say the daemon is still trying: {why}"
                );
                assert!(
                    !why.contains("no later sweep"),
                    "that was true before this box held the fact itself, and saying it now contradicts what the next sweep does: {why}"
                );
            }
            other => panic!("a pane still running was recorded as {other:?}"),
        }

        // A withdrawal that DID take releases it, or the box refuses a project
        // for ever over a mint it successfully took back.
        let took = Arc::new(Masters::new());
        let map2 = temp_map("released");
        let store2 = session_tokens::SessionTokens::at(map2.to_path_buf());
        store2.mint("sess-B").expect("mint");
        deaf_pane_outlived_its_kill(
            &took,
            "proj-2",
            "sidpeak",
            "forge-master-sidpeak",
            "sess-B",
            &CapabilityPorts {
                tokens: Some(&store2),
                authority: &AuthoritySink::default(),
                deaf: &DeafSink::default(),
            },
        )
        .await;
        assert_eq!(
            took.unwithdrawn_for("proj-2"),
            None,
            "the map was written, so there is nothing left to hold against this project"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The marker says one thing — this project's capability map names a
    /// session no pane holds — so it may not outlive the project it is about.
    ///
    /// Left behind, it is a session id sitting in wait for whatever core hands
    /// out next, and a healthy master matched by it would be ended for being
    /// healthy. Raised as F2 on the review of ba415f04f, where the worry was
    /// that a session id alone is not an identity; this is the window it was
    /// worried about, closed.
    #[test]
    fn a_project_this_box_stops_tracking_holds_nothing_against_its_next_session() {
        let masters = Masters::new();
        masters.remember_for_test("proj-1", "sess-A", "forge-master-mowment");
        masters.note_unwithdrawn("proj-1", Some("sess-A"));
        assert_eq!(
            masters.unwithdrawn_for("proj-1"),
            Some("sess-A".to_string())
        );

        masters.forget("proj-1");
        assert_eq!(
            masters.unwithdrawn_for("proj-1"),
            None,
            "the project is no longer this box's, so there is no pane for the marker to be about — and a later session that happened to carry the same id would be refused on the strength of it"
        );
        assert!(
            matches!(
                verdict_over_unwithdrawn(
                    Capability::Current,
                    masters.unwithdrawn_for("proj-1").as_deref(),
                    "sess-A",
                ),
                Capability::Current
            ),
            "which is what stops a healthy master being ended for holding an id this box once could not withdraw"
        );
    }

    #[test]
    fn the_map_is_never_read_without_what_this_box_knows_about_its_own_mints() {
        let body = ensure_master_body();
        assert!(
            !body.contains("let verdict = capability_of(tokens, &session.session_id);"),
            "the adopt branch reads the map through `verdict_over_unwithdrawn`, or a mint this box could not take back is read back as proof the pane it never placed is reachable (ISS-1208)"
        );
        let read = body
            .find("verdict_over_unwithdrawn(")
            .expect("the adopt branch consults what this box knows about its own mints");
        let judged = body
            .find("capability_act(&verdict, placement)")
            .expect("the adopt branch decides what to do through the named rule");
        assert!(
            read < judged,
            "the overrule has to happen before the act is chosen, or the box acts on the map's answer and records the overruled one"
        );
        let placed = body
            .find("masters.note_unwithdrawn(project_id, None)")
            .expect("the placement path releases what was held, or one failed withdrawal refuses the project for ever — including after a pane carrying that very capability is up and answering");
        assert!(
            body[..placed].contains("ports.deaf.placed()"),
            "it is released where a pane is actually up, not on the way to one"
        );
    }

    #[test]
    fn what_ensure_answered_is_read_before_the_pass_calls_itself_a_replacement() {
        let body = ensure_master_body();
        let started = body
            .find("let started = match terminal::ensure(")
            .expect("the placement path must keep what `ensure` answered; discarding it is the second half of ISS-1208's fault");
        let guarded = body
            .find("replacement_of(ended_a_deaf_pane, started)")
            .expect("the answer is ruled on by the named rule");
        let upgraded = body
            .find("ports.deaf.placed()")
            .expect("the account is upgraded to a replacement somewhere in this function");
        // From `started`, because the adopt branch above writes
        // `MasterAuthority::CURRENT` too, for a pane it never touched.
        let current = started
            + body[started..]
                .find("MasterAuthority::CURRENT,")
                .expect("the placement path writes the verdict it earned");
        assert!(
            started < guarded && guarded < upgraded && guarded < current,
            "the guard has to sit between what tmux answered and both of the things that claim a replacement, or the box writes `replaced` and `current` about a pane it never ended"
        );
    }

    #[test]
    fn a_capability_is_withdrawn_only_where_the_pane_it_was_minted_for_never_started() {
        let body = production();
        assert_eq!(
            body.matches("store.retire(session_id)").count(),
            2,
            "exactly two withdrawals in this file, and each is entitled to one: `end_master` has just closed the session row, and `deaf_pane_outlived_its_kill` knows the pane its mint was for was never started. A third caller is a live master losing the capability it is holding"
        );
        let ending = body
            .split("\nasync fn end_master(")
            .nth(1)
            .expect("end_master must be findable");
        assert!(
            ending[..block_end(ending, 0).expect("end_master must close")]
                .contains("store.retire(session_id)"),
            "the other withdrawal is end_master's, which retires a capability for a session it has just closed"
        );
        let rest = body
            .split(
                "
async fn deaf_pane_outlived_its_kill(",
            )
            .nth(1)
            .expect("deaf_pane_outlived_its_kill must be findable");
        let f = &rest[..block_end(rest, 0).expect("it must close")];
        assert!(
            f.contains("withdraw_unplaced_mint(ports.tokens, session_id)"),
            "the withdrawal belongs to this path, and goes through the one function that reads the map back afterwards"
        );
        let taking = body
            .split("\nfn withdraw_unplaced_mint(")
            .nth(1)
            .expect("withdraw_unplaced_mint must be findable");
        let w = &taking[..block_end(taking, 0).expect("it must close")];
        assert!(
            w.contains("store.retire(session_id)") && w.contains("store.holds_session(session_id)"),
            "it names the session the mint named and then reads the map back: `retire` logs and returns on a map it could not write, so a caller that did not look has reported a rollback it may not have made"
        );
        for banned in ["ports.deaf.placed(", "MasterAuthority::CURRENT"] {
            assert!(
                !f.contains(banned),
                "`{banned}` here would say the box replaced a pane that is still standing, which is the state this whole path exists to refuse"
            );
        }
    }

    /// Criterion 2's whole chain, as far as a crate with no core and no tmux
    /// can reach it: the replacement's capability is minted for the session
    /// this very call registered.
    ///
    /// The executable half is `a_capability_minted_for_the_session_this_box_
    /// holds_reads_current`, which proves `mint` then `holds_session` answers
    /// `Current`. What that cannot see is WHICH session id `ensure_master`
    /// hands the mint, and a mint for any other one places a pane as deaf as
    /// the one it replaced. So this reads the two expressions and requires
    /// them to be the same one, and requires there to be only one mint to
    /// read.
    #[test]
    fn the_replacement_is_minted_for_the_very_session_this_call_registered() {
        let body = ensure_master_body();
        assert_eq!(
            body.matches(".mint(").count(),
            1,
            "a second mint in this function is a second session a pane could be placed against, and this assertion could no longer say which one it read"
        );
        assert!(
            body.contains("store.mint(&session.session_id)"),
            "the capability the replacement carries has to name the session core serves now, which is the one `master_api::register` answered with in this same call"
        );
        assert!(
            body.contains("capability_of(tokens, &session.session_id)"),
            "the judgement and the mint have to be about one session, or a pane can be judged stale against one and placed against another"
        );
        let minted = body.find("store.mint(").expect("the mint must be findable");
        // `rfind`: the adopt branch records `current` about a pane it did not
        // place, further up. The one this is about is the placement path's,
        // which is the last in the function.
        let recorded = body
            .rfind("MasterAuthority::CURRENT,")
            .expect("a pane this sweep placed is recorded current");
        assert!(
            minted < recorded,
            "`current` is written about a capability that exists, not ahead of one"
        );
    }

    /// The rule reads two facts, and the other conditions ISS-1208 puts on
    /// acting are upstream of its one call site rather than arguments to it.
    ///
    /// That is only safe while there IS one call site: a second caller reaching
    /// it before the stand-down gate, the repo-path resolution or the tmux
    /// check would end a pane on gates nobody ran. Threading those results in
    /// as a value would be a second copy of them, which is the shape that goes
    /// quietly wrong; this goes loudly wrong instead.
    #[test]
    fn the_rule_that_ends_a_pane_has_exactly_one_caller_and_it_is_past_the_gates() {
        let body = production();
        assert_eq!(
            body.matches("capability_act(").count(),
            2,
            "one definition and one call: a second caller is one this assertion has never read, reached on gates it cannot see"
        );
        let inner = ensure_master_body();
        let registered = inner
            .find("master_api::register(")
            .expect("ensure_master registers with core");
        let alive = inner
            .find("if terminal::alive(&name).await {")
            .expect("the adopt branch opens on the pane being there");
        let judged = inner
            .find("capability_act(&verdict, placement)")
            .expect("the call has to be inside ensure_master");
        assert!(
            registered < judged && alive < judged,
            "the rule is asked only about a pane that is up, and only once core has said which session it serves — asked earlier it answers about nothing"
        );
    }

    #[test]
    fn the_sweep_gathers_the_fleet_and_reports_it_once_outside_the_loop() {
        let body = sweep_body();
        let gathered = body
            .find("deaf_found.push(")
            .expect("the sweep collects what each project turned out to be");
        let reported = body
            .find("report_deaf_fleet(")
            .expect("the sweep says what the box is");
        assert!(
            gathered < reported,
            "a report written before the set is gathered names whatever had been reached by then"
        );
        assert!(
            body.contains("\n    report_deaf_fleet("),
            "the record is the BOX's, so it is written once at the sweep's own level; called from inside the per-project loop it is the per-project line again under another name (ISS-1208)"
        );
    }
}

/// A master an owner stood down stays down, and the box tells its two answers
/// apart (ISS-1118).
#[cfg(test)]
mod stand_down_tests {
    use super::*;

    const SOURCE: &str = include_str!("master.rs");

    fn production() -> &'static str {
        SOURCE.split("\n#[cfg(test)]").next().unwrap()
    }

    fn sweep_body() -> &'static str {
        production()
            .split("\nasync fn sweep(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .expect("sweep must be findable")
    }

    fn ensure_master_body() -> &'static str {
        let rest = production()
            .split("\nasync fn ensure_master(")
            .nth(1)
            .expect("ensure_master must be findable");
        &rest[..rest.find("\n}").expect("ensure_master must close")]
    }

    /// The veto's own source. The decision moved out of `sweep` so both
    /// branches of its loop could reach it — the one that takes work and the
    /// one that does not.
    fn verdict_body() -> &'static str {
        production()
            .split("\nasync fn standing_verdict(")
            .nth(1)
            .and_then(|r| r.split("\nasync fn ").next())
            .and_then(|r| r.split("\nfn ").next())
            .expect("standing_verdict must be findable")
    }

    /// The part of the loop reached only for a runner this box takes work for,
    /// which is where a pane may actually be placed.
    fn admitting_branch() -> &'static str {
        let body = sweep_body();
        let at = body
            .find("take_pool_job(")
            .expect("the admitting branch still takes pool jobs");
        &body[at..]
    }

    fn stood_down() -> MasterStanding {
        MasterStanding {
            project_id: "proj-1".into(),
            slug: "forge-dev".into(),
            stood_down_at: 1_000,
            stood_down_by: "owner".into(),
            why: Some("a human is driving it".into()),
            stood_up_at: None,
        }
    }

    fn lifted() -> MasterStanding {
        MasterStanding {
            stood_up_at: Some(5_000),
            ..stood_down()
        }
    }

    #[test]
    fn a_project_nobody_stood_down_is_placed_exactly_as_it_is_today() {
        assert_eq!(placement_under(None, false), Placed::Proceed);
        assert_eq!(
            placement_under(None, true),
            Placed::Proceed,
            "a live pane under no stand-down is the ordinary case and this decision must not touch it"
        );
    }

    #[test]
    fn a_stood_down_project_gets_no_pane_placed() {
        assert_eq!(
            placement_under(Some(&stood_down()), false),
            Placed::Withheld,
            "an owner who stood a master down and killed its pane gets it back on the next sweep, resuming the same conversation, because nothing between the ledger and ensure_master reads the stand-down (ISS-1118)"
        );
    }

    #[test]
    fn a_pane_alive_under_a_stand_down_is_a_contradiction_and_not_a_placement() {
        assert_eq!(
            placement_under(Some(&stood_down()), true),
            Placed::Contradicted,
            "a pane running against a stand-down is reported, never adopted as a driving master and never nudged"
        );
    }

    #[test]
    fn standing_a_master_up_restores_it_to_the_gates_and_not_to_a_pane() {
        assert_eq!(
            placement_under(Some(&lifted()), false),
            Placed::Proceed,
            "a lifted stand-down withholds nothing; whether a pane is placed is then the usual question of admissible work and a runner that accepts it"
        );
        assert_eq!(placement_under(Some(&lifted()), true), Placed::Proceed);
    }

    #[test]
    fn the_sweep_reads_the_stand_down_before_it_places_a_pane() {
        let body = sweep_body();
        let reads = body.find("read_standing(").expect(
            "the sweep places a pane for every project it serves and consults no record of one \
             being stood down, so the kill and the restart are the same lever: `master kill` \
             removes the pane, touches no ledger row, and the next sweep hands the stored \
             conversation id back to --resume (ISS-1118)",
        );
        let places = body
            .find("ensure_master(")
            .expect("the sweep must still be the one thing that places a pane");
        assert!(
            reads < places,
            "the standing is read AFTER the pane is placed, which places the very pane it exists to withhold"
        );
    }

    /// Criterion 15. The owner's act is a ledger write and the sweep's answer
    /// to it must not depend on anything off this box — otherwise a box that
    /// cannot reach core replaces the pane its owner withheld.
    #[test]
    fn the_stand_down_is_read_off_the_ledger_and_decided_before_core_is_asked_anything() {
        let branch = admitting_branch();
        let reads = branch
            .find("read_standing(")
            .expect("the admitting branch must consult the standing");
        assert!(
            branch[reads..].starts_with("read_standing(ledger.as_ref()"),
            "the standing is read off the same ledger handle the sweep already reads the conversation id from, never off a field on the runner row or a fresh core call"
        );
        let reader = production()
            .split("fn read_standing(")
            .nth(1)
            .expect("read_standing must be findable");
        assert!(
            reader[..reader.find("\n}").unwrap_or(reader.len())].contains("led.master_standing("),
            "and `read_standing` asks the ledger and nothing else"
        );
        for gating in [
            "admissible::admissible(",
            "master_api::register(",
            "resolve_repo(",
        ] {
            assert!(
                !branch[..reads].contains(gating),
                "`{gating}` is reached before the standing is, so a project whose owner stood its master down still pays for it — and a box that cannot reach core decides nothing (ISS-1118 criterion 15)"
            );
        }
        assert!(
            !verdict_body().contains("client")
                && !verdict_body().contains("admissible::")
                && !verdict_body().contains("master_api::"),
            "and the veto itself asks core nothing: no network call stands between the owner's act and the pane not returning"
        );
        assert!(
            sweep_body()[..sweep_body()
                .find("take_pool_job(")
                .expect("the sweep still takes pool jobs")]
                .contains("standing_verdict("),
            "the draining branch consults the veto too, or a pane running against a stand-down on a box taking no work is reported by no daemon at all (ISS-1118 criterion 4)"
        );
    }

    /// Criterion 4, the third place the report was unreachable. A runner that
    /// takes no new work is a reason to place nothing; it is not a reason to
    /// stop looking at a pane that is already up.
    #[test]
    fn a_box_taking_no_work_still_reports_a_pane_running_against_a_stand_down() {
        let body = sweep_body();
        let at = body
            .find("if !accepts_new_work(&runner.status) {")
            .expect("the branch for a runner taking no new work must be findable");
        let rest = &body[at..];
        let end = rest.find("\n        }").expect("that branch must close");
        let branch = &rest[..end];
        assert!(
            branch.contains("standing_verdict("),
            "a stood-down project whose box is `draining` never reached the veto, so its contradicted pane was named nowhere: {branch}"
        );
        assert!(
            branch.contains("Placed::Proceed | Placed::Withheld"),
            "and the louder reason wins the one slot this project has — `draining` explains an absent pane, never a pane that is up and never a standing this box could not read: {branch}"
        );
        assert!(
            !branch.contains("ensure_master(") && !branch.contains("nudge_master("),
            "looking is not placing: the branch still places nothing and nudges nothing"
        );
    }

    /// The other half of that slot. A standing this box could NOT read is the
    /// loudest thing it has to say about the project; overwriting it with
    /// `draining` hides it and makes every unchanged sweep after it look like
    /// a change, which is the repetition `note_unplaced` exists to stop.
    #[test]
    fn an_unreadable_standing_is_not_overwritten_by_the_drained_reason() {
        let masters = Masters::new();
        let unreadable = Unplaced::StandingUnreadable {
            detail: "the standing could not be read: disk is gone".into(),
        };
        assert!(masters.note_unplaced("proj-1", unreadable.clone()));
        let drained = Unplaced::Draining {
            status: "draining".into(),
        };
        assert!(
            masters.note_unplaced("proj-1", drained.clone()),
            "the two ARE different values, which is exactly why the branch must not write the second over the first"
        );
        assert!(
            masters.note_unplaced("proj-1", unreadable),
            "and writing them alternately on every sweep is a fresh report every 30s from a box whose state never changed"
        );
        let _ = drained;
    }

    #[test]
    fn the_sweep_does_not_end_a_pane_it_found_rather_than_placed() {
        let body = sweep_body();
        let start = body
            .find("Placed::Contradicted")
            .expect("the contradicted branch must be findable");
        let branch = &body[start..start + 600.min(body.len() - start)];
        assert!(
            !branch.contains("terminal::kill"),
            "the daemon deliberately stopped killing master panes (ISS-933); a pane alive under a stand-down is reported, never terminated by the sweep"
        );
    }

    /// Criterion 5. `Contradicted` reports and leaves; anything after it in
    /// the loop would adopt the pane as this box's master or nudge it.
    #[test]
    fn a_pane_alive_under_a_stand_down_is_neither_adopted_nor_nudged() {
        let body = admitting_branch();
        let at = body
            .find("Placed::Contradicted =>")
            .expect("the contradicted arm must be findable");
        let rest = &body[at..];
        let end = rest.find("\n        }").expect("the match must close");
        let branch = &rest[..end];
        assert!(
            branch.contains("continue"),
            "the arm has to leave the iteration: falling through reaches `ensure_master`, which adopts a live pane as this box's master, and then the nudge: {branch}"
        );
        for reached in ["ensure_master(", "nudge_master(", "masters.note_work("] {
            assert!(
                !branch.contains(reached),
                "`{reached}` inside the contradicted arm drives a pane its owner stood down"
            );
        }
        assert!(
            !verdict_body().contains("ensure_master(")
                && !verdict_body().contains("nudge_master("),
            "and the verdict that reports the contradiction places nothing and nudges nothing either"
        );
    }

    /// Criterion 17. A pane this sweep started and then ended is two acts an
    /// operator did not see; the log is the only place either of them exists.
    #[test]
    fn the_withdrawal_of_a_pane_this_sweep_placed_is_named_in_the_log() {
        let body = sweep_body();
        let at = body
            .find("was stood down while this sweep was starting it")
            .expect("the withdrawal must say what it is doing");
        let before = &body[at.saturating_sub(120)..at];
        assert!(
            before.contains("tracing::error!"),
            "a pane started and then withdrawn inside one sweep is not an info line: {before}"
        );
        let after = &body[at..at + 900.min(body.len() - at)];
        assert!(
            after.contains("stand-up"),
            "and it names the act that stops the withdrawal happening again: {after}"
        );
        assert!(
            after.contains("could not withdraw"),
            "a withdrawal that FAILS is louder still — the pane is up, running against a stand-down, and only the log can say so"
        );
    }

    /// Criterion 4, and the defect the reopen was filed for.
    ///
    /// `Masters::new()` is not a convenience here — it IS the state a daemon
    /// that has just started holds, and it is the state EVERY daemon holds for
    /// a stood-down project, because such a project `continue`s before
    /// `ensure_master` and `ensure_master` is the only thing that ever puts a
    /// project in `reg.live`. The report this arm makes must therefore ask
    /// nothing of `reg.live`. It used to, through `note_capability`, and the
    /// consequence was zero ERROR lines for the whole life of a daemon meeting
    /// a pane running against a stand-down.
    #[test]
    fn a_contradiction_is_reported_by_a_daemon_that_never_placed_the_pane() {
        let masters = Masters::new();
        let contradicted = stood_down_reason(
            Some(&stood_down()),
            "judgeproj",
            Some("forge-master-judgeproj"),
        );
        assert!(
            contradicted.is_error(),
            "a master driving a project its owner stood down is the one state this change exists to make impossible to miss, so it is not a warn line (ISS-1118 criterion 4)"
        );
        assert!(
            masters.note_unplaced("proj-1", contradicted.clone()),
            "a daemon that never placed this pane meets it under the stand-down and says nothing — which is the nine-hour silence this issue was filed over, returning on every auto-update restart (ISS-1118 criterion 4)"
        );
        assert!(
            !masters.note_unplaced("proj-1", contradicted),
            "and it says it once, not on all forty-five sweeps after (ISS-1118 criterion 29)"
        );
    }

    /// Criterion 4, the other half: the arm may not go back to gating its
    /// report on the registry of panes this process placed.
    #[test]
    fn the_contradicted_arm_gates_its_report_on_nothing_this_process_placed() {
        let body = sweep_body();
        let start = body
            .find("Placed::Contradicted")
            .expect("the contradicted branch must be findable");
        let branch = &body[start..start + 600.min(body.len() - start)];
        assert!(
            !branch.contains("note_capability"),
            "`Masters::note_capability` opens `reg.live.get_mut(project_id)` and returns false for a project that is not there; a stood-down project is in `reg.live` on no daemon that did not place its pane, so a report gated on it is unreachable by its own report: {branch}"
        );
    }

    /// Criterion 20. Withheld and contradicted are two different things to
    /// tell an operator, and one `Unplaced` value for both says the wrong one.
    #[test]
    fn a_stood_down_project_with_a_pane_up_is_not_reported_as_having_no_pane() {
        let withheld = stood_down_reason(Some(&stood_down()), "judgeproj", None);
        let contradicted = stood_down_reason(
            Some(&stood_down()),
            "judgeproj",
            Some("forge-master-judgeproj"),
        );
        assert!(
            withheld.lead().contains("no master pane placed"),
            "a project withheld with no pane up is exactly that: {}",
            withheld.lead()
        );
        assert!(
            !contradicted.lead().contains("no master pane placed"),
            "the line that survives a contradicted sweep asserted the opposite of what an operator finds: a pane alive, holding a session, reported as none placed: {}",
            contradicted.lead()
        );
        assert!(
            contradicted.lead().contains("forge-master-judgeproj"),
            "and it names the pane, which is what `tmux kill-session` needs: {}",
            contradicted.lead()
        );
        assert!(
            !withheld.is_error(),
            "a stand-down the box is honouring with no pane up is the owner's own act working, not a fault"
        );
        let masters = Masters::new();
        masters.note_unplaced("proj-1", withheld);
        assert!(
            masters.note_unplaced("proj-1", contradicted),
            "a project that goes from withheld to contradicted — somebody started a pane by hand — is a change, and one value for both states makes it invisible"
        );
    }

    #[test]
    fn a_pane_this_sweep_placed_under_a_stand_down_written_since_is_withdrawn_by_it() {
        let body = sweep_body();
        let first = body
            .find("read_standing(")
            .expect("the sweep must consult the standing before it places");
        let after_place = body
            .find("ensure_master(")
            .expect("the sweep must still place a pane");
        let second = body[after_place..]
            .find("read_standing(")
            .map(|i| i + after_place);
        assert!(
            second.is_some_and(|s| s > first),
            "a stand-down written while this sweep was starting a pane leaves the pane running until the NEXT sweep, and an owner watching for it to stop sees it not stop (ISS-1118 criterion 16)"
        );
    }

    /// F1 from the ISS-1118 review. Folding "could not ask" into "no
    /// stand-down" is a fail-open: a box whose ledger is unreadable would
    /// place the pane its owner withheld, and would do it in silence.
    #[test]
    fn a_standing_that_cannot_be_read_is_not_read_as_no_stand_down() {
        assert!(
            matches!(read_standing(None, "proj-1"), StandingRead::Unreadable(_)),
            "a box with no ledger at all cannot say what its owner decided, and must not answer that nothing was decided"
        );
        let led = Ledger::open_in_memory().expect("an in-memory ledger opens");
        assert!(
            matches!(
                read_standing(Some(&led), "proj-1"),
                StandingRead::Known(None)
            ),
            "a ledger that answers `no row` is a real answer and stays one"
        );
    }

    #[test]
    fn an_unreadable_standing_withholds_the_pane_and_says_which_it_could_not_read() {
        let body = verdict_body();
        let at = body
            .find("StandingRead::Unreadable(detail)")
            .expect("the veto must handle the unreadable case by name");
        let branch = &body[at..at + 900.min(body.len() - at)];
        assert!(
            branch.contains("return None;"),
            "the verdict has to refuse rather than answer, and every caller places nothing on a refusal — carrying on to `ensure_master` would place the pane an owner may have withheld"
        );
        // Read through a copy with one line ending: a checkout with CRLF holds
        // `\r\n` where a multi-line literal here holds `\n`, and this assertion
        // then reports a missing branch on source that carries it.
        let sweep = sweep_body().replace("\r\n", "\n");
        for call in [
            "standing_verdict(",
            "else {\n            continue;\n        };",
        ] {
            assert!(
                sweep.contains(call),
                "and the sweep consumes that refusal by leaving the iteration: `{call}` is missing"
            );
        }
        assert!(
            !branch.contains("note_capability"),
            "gating this report on the registry of panes this process placed makes it unreachable on a daemon that placed none, which is every daemon that restarts (ISS-1118 criterion 4): {branch}"
        );
        let unreadable = Unplaced::StandingUnreadable {
            detail: "the standing could not be read: disk is gone".into(),
        };
        assert!(
            unreadable.is_error(),
            "a box that cannot say whether it is driving a project is reported loudly, on every daemon that meets it"
        );
        let why = unreadable.to_string();
        assert!(
            why.contains("disk is gone"),
            "and the reason a pane is absent names what could not be read, not merely that something could not be: {why}"
        );
    }

    /// The same unreadable answer must NOT withdraw. Withholding places
    /// nothing; withdrawing ends a pane nobody may have stood down.
    #[test]
    fn an_unreadable_read_back_reports_and_never_withdraws() {
        let body = sweep_body();
        let after = body
            .find("ensure_master(")
            .expect("the sweep must still place a pane");
        let recheck = &body[after..];
        let at = recheck
            .find("StandingRead::Unreadable(detail)")
            .expect("the read-back must handle the unreadable case by name");
        let branch = &recheck[at..at + 900.min(recheck.len() - at)];
        assert!(
            branch.contains("NOT being withdrawn"),
            "the two directions are not symmetric and the log has to say which one this is: {branch}"
        );
        assert!(
            !branch[..branch.find("=> ").map_or(branch.len(), |i| i + 400)].contains("terminal::kill"),
            "ending a pane on a record this box could not read would take work nobody decided to end"
        );
    }

    /// The remainder of F1, found by the recheck. Refusing to withdraw on an
    /// unreadable record is right; going on to NUDGE the pane is the same
    /// fail-open one step later — driving a master while unable to say whether
    /// its project is stood down.
    #[test]
    fn a_pane_whose_standing_could_not_be_read_back_is_not_nudged_either() {
        let body = sweep_body();
        let sets = body
            .find("standing_unknown = true;")
            .expect("the unreadable read-back must mark what it could not establish");
        let skips = body
            .find("if standing_unknown {")
            .expect("and something must act on that mark");
        let nudges = body
            .find("nudge_master(masters,")
            .expect("the sweep still nudges");
        assert!(
            sets < skips && skips < nudges,
            "the mark is set on the unreadable read-back and consumed before the nudge, or a pane is driven under a standing this box could not read"
        );
        let branch = &body[skips..nudges];
        assert!(
            branch.contains("continue;"),
            "and it leaves the iteration rather than falling through: {branch}"
        );
    }

    /// F3 from the review. The interval is spent when a pane is TOLD it, not
    /// when a pane exists: an adopted pane was sent no brief at all.
    #[test]
    fn the_lifted_interval_is_forgotten_only_once_a_pane_has_been_told_it() {
        let body = sweep_body();
        assert!(
            body.contains("if told.load("),
            "forgetting on `lifted_interval.is_some()` drops the interval undelivered whenever the pane was adopted rather than started, or its brief failed to land"
        );
        let brief = ensure_master_body();
        assert!(
            brief.contains("stood_down_told.store("),
            "and the acknowledgement is raised where the brief is actually delivered, not where one was assembled"
        );
        let at = brief
            .find("stood_down_told.store(")
            .expect("the acknowledgement must be findable");
        let window = &brief[at.saturating_sub(200)..at];
        assert!(
            window.contains("Ok(()) =>"),
            "it is raised on a delivered brief only — a failed one told the pane nothing: {window}"
        );
    }

    #[test]
    fn the_unplaced_reason_names_the_act_that_reverses_it() {
        let why = Unplaced::StoodDown {
            by: "owner".into(),
            why: Some("a human is driving it".into()),
            slug: "forge-dev".into(),
            pane: None,
        }
        .to_string();
        assert!(
            why.contains("stand-up forge-dev"),
            "whatever stops a master reads as reversible from the same surface; the reason a pane is absent names the one command that brings it back: {why}"
        );
        assert!(
            why.contains("owner") && why.contains("a human is driving it"),
            "who stood it down and why are what tell a deliberate stand-down from a fault: {why}"
        );
        let bare = Unplaced::StoodDown {
            by: "owner".into(),
            why: None,
            slug: "forge-dev".into(),
            pane: None,
        }
        .to_string();
        assert!(
            bare.contains("stand-up forge-dev") && !bare.contains("()"),
            "a stand-down with no reason given still names the way back, and does not print an empty one: {bare}"
        );
    }
}

/// What a master pane's preparation says when this daemon's own binary has been
/// replaced under it, or is gone (ISS-1200).
#[cfg(test)]
mod own_exe_reporting_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn logged_while(f: impl FnOnce()) -> String {
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
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn scratch(label: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("master-exe-{label}"))
    }

    /// A file `is_runnable` accepts, on every platform this crate builds for:
    /// what these cases are about is a journal line and a settings file, and
    /// neither has a shell in it.
    fn runnable(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        p
    }

    #[test]
    fn a_replaced_binary_is_named_in_the_journal_with_the_project_and_both_paths() {
        let dir = scratch("replaced");
        let installed = runnable(&dir, "forge-runner");
        let annotated = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo");

        let said = logged_while(|| {
            install_hooks_from(&repo, "acme-web", crate::exe::resolve(&annotated));
        });

        assert!(
            said.contains("acme-web"),
            "the project is not named: {said}"
        );
        assert!(
            said.contains(annotated.to_str().unwrap()),
            "the path it started on is not named, so a reader cannot tell what was replaced: {said}"
        );
        assert!(
            said.contains(&format!(
                "hooks name {}, the build standing there now",
                installed.display()
            )),
            "the destination is not named in its own right — and the annotated path CONTAINS it, so a bare `contains` here passes whatever the line says (consult bec748 F1): {said}"
        );
        assert!(
            crate::daemon::hook_install::settings_path(&repo).exists(),
            "the pane was left unhooked although a build stands at the path"
        );
    }

    #[test]
    fn a_binary_that_is_gone_leaves_the_pane_unhooked_and_says_why() {
        let dir = scratch("gone");
        let annotated = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo");

        let said = logged_while(|| {
            install_hooks_from(&repo, "acme-web", crate::exe::resolve(&annotated));
        });

        assert!(
            said.contains("acme-web"),
            "the project is not named: {said}"
        );
        assert!(
            said.contains("nothing can invoke it"),
            "the reason is not in the line, so the journal says only that hooks are missing: {said}"
        );
        assert!(
            !crate::daemon::hook_install::settings_path(&repo).exists(),
            "commands that die at every call were written anyway"
        );
    }

    #[test]
    fn a_binary_that_is_still_there_is_installed_with_nothing_said_about_a_fallback() {
        let dir = scratch("present");
        let installed = runnable(&dir, "forge-runner");
        let repo = dir.join("repo");
        std::fs::create_dir_all(&repo).expect("repo");

        let said = logged_while(|| {
            install_hooks_from(&repo, "acme-web", crate::exe::resolve(&installed));
        });

        assert!(
            !said.contains("was replaced while it ran"),
            "a fallback was reported where nothing fell back: {said}"
        );
        assert!(
            crate::daemon::hook_install::settings_path(&repo).exists(),
            "the hooks were not written: {said}"
        );
    }
}
