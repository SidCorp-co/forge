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
use crate::daemon::master_inbox::{self, WakeSource};
use crate::daemon::master_limit;
use crate::daemon::master_pass;
use crate::daemon::pane_exit;
use crate::daemon::pool_jobs::{self, JobPanes, Records};
use crate::daemon::pool_reads;
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{self, CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::run_record;
use crate::daemon::session_tokens;
use crate::daemon::subagent_host;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, MasterAuthority, MasterStanding, Run};
use crate::runner::terminate;
use crate::transport::admissible::{self, AdmissibleIssue, DISPATCH_GATING_KIND};
use crate::transport::channel_inbox::{self, UnansweredDocument};
use crate::transport::comment_inbox;
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
    out.push_str(&reach.brief());
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
    /// reads the map at face value again: a priced residual, not a closed one.
    unwithdrawn: HashMap<String, String>,
    /// The projects whose master pane tmux could not be asked about on the last
    /// sweep, so the account is given when the read first goes unanswered and
    /// not on every sweep it stays that way.
    unanswered: std::collections::HashSet<String>,
    /// When this box last placed each project's pane, and where its output is
    /// kept from, so what the pane printed is read without what earlier panes
    /// printed before it.
    placed: HashMap<String, PlacedPane>,
    /// The conversation a pane this box placed exited over, saying Claude Code
    /// runs it as a background session, with the short id that refusal
    /// printed. No pane resuming it is placed while a process on this box
    /// names it (ISS-1312, F1).
    elsewhere: HashMap<String, (String, Option<String>)>,
    /// Consecutive early exits of each project's pane for one reason, which
    /// decide only what the journal says (ISS-1343).
    exits: HashMap<String, pane_exit::Tally>,
    /// Why each project's channel inbox could not be read on the last sweep,
    /// so a core that does not answer it is said once and not every pass.
    inbox_unread: HashMap<String, String>,
}

/// One pane this box placed: when, and where its output begins.
struct PlacedPane {
    at: Instant,
    /// The transcript and its length when the pane started; `None` where the
    /// pane was placed with no transcript.
    output: Option<(std::path::PathBuf, u64)>,
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
    /// This daemon is draining before a restart, so it admits no new work for
    /// any project until it has restarted or the drain gives up (ISS-1223).
    Restarting {
        cause: String,
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
    /// could not be written into `dir`, so no pane was started for the same
    /// reason. `dir` is what an operator has to make writable.
    ServersUnwritable {
        detail: String,
        dir: std::path::PathBuf,
    },
    /// Everything before the pane was in place and the capability it would
    /// carry could not be minted, so no pane was started: one without it has
    /// every declaration refused.
    CapabilityUnminted {
        detail: String,
    },
    /// Everything was in place and tmux did not start the pane.
    PaneUnstarted {
        detail: String,
    },
    /// The pane last placed for this project resumed its conversation and
    /// exited, printing that Claude Code runs that conversation as a
    /// background session under the id `short`; `pid` is a process on this
    /// box naming it now. A pane placed again would exit the same way
    /// (ISS-1312, F1).
    ConversationElsewhere {
        conversation: String,
        short: Option<String>,
        pid: u32,
    },
    /// As [`Unplaced::ConversationElsewhere`], where this box could not read
    /// its process table to tell whether a process still names that
    /// conversation. Not knowing is not its end (ISS-1312, F1).
    ConversationUnaskable {
        conversation: String,
        short: Option<String>,
    },
}

impl std::fmt::Display for Unplaced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Draining { status } => write!(
                f,
                "this box's runner for it is `{status}`, so it starts no work and places no master until that changes"
            ),
            Self::Restarting { cause } => write!(
                f,
                "this box is draining before a restart ({cause}), so it starts no work and places no master for any project until it has restarted or the drain gives up"
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
                // Always a reason in parentheses, never an absent one. A line
                // that says only who stood it down reads as a stand-down whose
                // reason the reader has not found yet, rather than one that was
                // never recorded — and telling those two apart is the whole of
                // ISS-1238.
                write!(
                    f,
                    "its master was stood down by {by} ({})",
                    why.as_deref().unwrap_or(MasterStanding::NO_REASON)
                )?;
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
                "this box could not read which MCP servers this project declares ({detail}), so it started no master rather than one carrying none of them. The next sweep whose read succeeds places one"
            ),
            Self::ServersUnwritable { detail, dir } => write!(
                f,
                "it declares MCP servers and the file that hands them to a pane could not be written into {} ({detail}), so this box started no master rather than one carrying none of them. Make {} writable and the next sweep starts one",
                dir.display(),
                dir.display()
            ),
            Self::CapabilityUnminted { detail } => write!(
                f,
                "the control capability its pane would carry could not be minted ({detail}), so this box started no master rather than one whose every declaration is refused"
            ),
            Self::PaneUnstarted { detail } => write!(
                f,
                "everything it needs was in place and the pane itself did not start ({detail})"
            ),
            Self::ConversationElsewhere {
                conversation,
                short,
                pid,
            } => write!(
                f,
                "the pane this box last placed for it resumed conversation {conversation} and exited, printing that Claude Code runs that conversation as a background session{}, and process {pid} on this box names it now. A pane placed again would exit the same way, so none is placed while a process names that conversation. {WAITS_NOT_FORKS} {}, and once no process names it a pane resuming it is placed on the next sweep whose other gates admit one",
                short_said(short.as_deref()),
                pane_exit::remedy(conversation, short.as_deref())
            ),
            Self::ConversationUnaskable {
                conversation,
                short,
            } => write!(
                f,
                "the pane this box last placed for it resumed conversation {conversation} and exited, printing that Claude Code runs that conversation as a background session{}, and this box cannot read its process table to tell whether one still does. A pane placed again would exit the same way while it does, so none is placed until a sweep reads the whole table and finds no process naming it, or this daemon restarts and forgets the exit. {WAITS_NOT_FORKS} {}",
                short_said(short.as_deref()),
                pane_exit::remedy(conversation, short.as_deref())
            ),
            Self::StaleCapability { session, pane } => write!(
                f,
                "its pane {pane} is up but this box cannot hear it — the capability that pane holds names a session core has since replaced, core's session for it is now {session}, and a running pane cannot be handed a new capability. Every declaration it makes is refused and it is not being nudged while it stands like this. `tmux kill-session -t {pane}` ends it, which is what lets a master carrying the current capability be placed — placement itself still answers to the same gates as any other"
            ),
        }
    }
}

/// Why a held conversation is waited out rather than forked, said wherever
/// the wait is.
// cm:guard the deliberate choice ISS-1343 asks to be named. `--fork-session` would start a pane at once, and as a second conversation for this project while the first still runs as a background session that can still claim, dispatch and write; two masters for one project is the failure this box is built to prevent, so it waits and says so.
const WAITS_NOT_FORKS: &str = "This box waits for that session to end rather than starting a pane with `--fork-session`: a fork is a second conversation for this project while the first still runs and can still act.";

/// The short id a background-session refusal printed, as a parenthesis.
fn short_said(short: Option<&str>) -> String {
    short.map(|s| format!(" ({s})")).unwrap_or_default()
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
    /// A pane running against a stand-down is the nine-hour silence ISS-1118
    /// was filed over; a standing this box could not read is a box that cannot
    /// say what it is doing; a pane whose capability is stale is the four-hour
    /// silence ISS-1099 was filed over, and no sweep resolves it. The four that
    /// refuse a start the project wanted — its servers unreadable or
    /// unwritable, its capability unminted, its pane unstarted — leave it with
    /// no master for a fault on this box. Everything else here is a pane absent
    /// for a reason the box is content with.
    fn is_error(&self) -> bool {
        matches!(
            self,
            Self::StoodDown { pane: Some(_), .. }
                | Self::StandingUnreadable { .. }
                | Self::StaleCapability { .. }
                | Self::ServersUnreadable { .. }
                | Self::ServersUnwritable { .. }
                | Self::CapabilityUnminted { .. }
                | Self::PaneUnstarted { .. }
                | Self::ConversationElsewhere { .. }
                | Self::ConversationUnaskable { .. }
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

/// What a pane placed after a lifted stand-down is told about the episode it
/// is following.
///
/// The interval alone was what this carried until ISS-1238, and an interval
/// says a gap happened without saying what the gap was for. The two reasons
/// travel with it because the pane is the one reader who was not there.
pub(crate) struct Lifted {
    /// Which episode this is, so the one a pane is told about is the one
    /// stamped told and no other.
    pub episode: i64,
    pub held_for: Duration,
    /// The reason recorded on the way down, or `None` on an episode written
    /// before a reason was required.
    pub why: Option<String>,
    /// The argument the lift was taken on, or `None` on an episode lifted
    /// before one was required.
    pub lifted_on: Option<String>,
}

/// The lifted episode a pane placed now has to be told about, where there is
/// one.
///
/// `None` while it still stands, `None` once a pane has been told — being told
/// is what spends it, and telling the next pane the same gap again is the same
/// defect as never telling the first — and `None` on a row whose two stamps
/// cannot make an interval, because a clock that went backwards is not a fact
/// to tell a master.
fn lifted_from(standing: &MasterStanding) -> Option<Lifted> {
    if standing.told_at.is_some() {
        return None;
    }
    let up = standing.stood_up_at?;
    let held_for = u64::try_from(up - standing.stood_down_at)
        .ok()
        .map(Duration::from_secs)?;
    Some(Lifted {
        episode: standing.episode,
        held_for,
        why: standing.why.clone(),
        lifted_on: standing.stood_up_why.clone(),
    })
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
fn asked_this_sweep(
    admissible: &[AdmissibleIssue],
    inbox: &[UnansweredDocument],
    held: Option<&master_limit::Refusal>,
) -> bool {
    !admissible.is_empty() || !inbox.is_empty() || held.is_some()
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

    /// `f` over the session this box serves `pane` under as `project_id`'s
    /// master, with the registry held so no adoption moves it meanwhile, or
    /// `None` where `pane` is not that master.
    pub fn while_live<R>(
        &self,
        project_id: &str,
        pane: &str,
        f: impl FnOnce(&str) -> R,
    ) -> Option<R> {
        let reg = self.0.lock().expect("masters poisoned");
        let m = reg.live.get(project_id).filter(|m| m.name == pane)?;
        Some(f(&m.session_id))
    }

    /// Serve the live pane for this project under `session_id`, keeping
    /// everything else this box knows about it, and answer the session it
    /// was served under before where that differs.
    fn readopt(&self, project_id: &str, session_id: &str) -> Option<String> {
        let mut reg = self.0.lock().expect("masters poisoned");
        let m = reg.live.get_mut(project_id)?;
        if m.session_id == session_id {
            return None;
        }
        Some(std::mem::replace(&mut m.session_id, session_id.to_string()))
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

    /// Record whether this sweep's read of the project's pane went unanswered,
    /// and answer whether that is a change from the last sweep's.
    fn note_unanswered(&self, project_id: &str, unanswered: bool) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        if unanswered {
            reg.unanswered.insert(project_id.to_string())
        } else {
            reg.unanswered.remove(project_id)
        }
    }

    /// Remember why the inbox read failed (`None`: it succeeded), answering
    /// whether that is news since the last sweep.
    fn note_inbox_read(&self, project_id: &str, failed: Option<String>) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        match failed {
            Some(why) => reg.inbox_unread.insert(project_id.to_string(), why.clone()) != Some(why),
            None => reg.inbox_unread.remove(project_id).is_some(),
        }
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

    fn note_placed(&self, project_id: &str, output: Option<(std::path::PathBuf, u64)>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.placed.insert(
            project_id.to_string(),
            PlacedPane {
                at: Instant::now(),
                output,
            },
        );
    }

    fn take_placed(&self, project_id: &str) -> Option<PlacedPane> {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.placed.remove(project_id)
    }

    /// Count an exit into this project's run of early exits, answering its
    /// place in it (0 where it was not early).
    fn count_exit(&self, project_id: &str, lived: Option<Duration>, exit: &pane_exit::Exit) -> u32 {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.exits
            .entry(project_id.to_string())
            .or_default()
            .count(lived, exit)
    }

    /// This project's pane was read up past the early window after its
    /// placement: ends its run of early exits, answering the run's length
    /// where it had been named as a condition.
    fn outlived(&self, project_id: &str) -> Option<u32> {
        let mut reg = self.0.lock().expect("masters poisoned");
        let past = reg
            .placed
            .get(project_id)
            .is_some_and(|p| p.at.elapsed() >= pane_exit::EARLY_EXIT);
        if !past {
            return None;
        }
        reg.exits
            .get_mut(project_id)
            .and_then(pane_exit::Tally::outlived)
    }

    fn note_elsewhere(&self, project_id: &str, conversation: String, short: Option<String>) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere
            .insert(project_id.to_string(), (conversation, short));
    }

    fn elsewhere(&self, project_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.get(project_id).map(|(c, _)| c.clone())
    }

    fn elsewhere_short(&self, project_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.get(project_id).and_then(|(_, s)| s.clone())
    }

    fn clear_elsewhere(&self, project_id: &str) {
        let mut reg = self.0.lock().expect("masters poisoned");
        reg.elsewhere.remove(project_id);
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
    /// Core published `master.wake` on this box's device room (ISS-933), for
    /// the reason `source` names (ISS-38).
    Core {
        project_id: Option<String>,
        source: WakeSource,
    },
    /// This box's websocket came back up, so anything published while it was
    /// down is gone — `rooms.ts:publish` has no buffer and no replay.
    Reconnect,
}

impl Wake {
    /// The wake a `master.wake` frame's data is, or why it is refused.
    pub fn of_frame(data: &serde_json::Value) -> Result<Self, String> {
        let source = WakeSource::of_frame(data)?;
        let project_id = data
            .get("projectId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        Ok(Wake::Core { project_id, source })
    }

    fn describe(&self) -> String {
        match self {
            Wake::Core {
                project_id: Some(p),
                source,
            } => format!("core, {}, project {p}", source.label()),
            Wake::Core {
                project_id: None,
                source,
            } => format!("core, {}", source.label()),
            Wake::Reconnect => "websocket reconnected — catch-up read".into(),
        }
    }
}

/// A sender for [`Wake`], sized so a burst coalesces instead of queueing.
pub fn wake_channel() -> (mpsc::Sender<Wake>, mpsc::Receiver<Wake>) {
    mpsc::channel(1)
}

/// The registries the master loop shares with the rest of the daemon.
pub struct Shared {
    pub masters: Arc<Masters>,
    pub activity: Arc<agent_activity::Activities>,
    pub job_panes: Arc<JobPanes>,
    pub job_records: Arc<dyn Records>,
    pub drain: Arc<crate::daemon::drain::Drain>,
}

impl Shared {
    fn borrowed(&self) -> SweepShared<'_> {
        SweepShared {
            masters: &self.masters,
            activity: &self.activity,
            job_panes: &self.job_panes,
            job_records: self.job_records.as_ref(),
            drain: &self.drain,
        }
    }
}

/// [`Shared`] as one sweep reads it.
#[derive(Clone, Copy)]
pub(crate) struct SweepShared<'a> {
    masters: &'a Arc<Masters>,
    activity: &'a agent_activity::Activities,
    job_panes: &'a Arc<JobPanes>,
    job_records: &'a dyn Records,
    drain: &'a crate::daemon::drain::Drain,
}

pub async fn run(
    client: CoreClient,
    cfg: Config,
    shared: Shared,
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
    let mut passes = tokio::time::interval(master_pass::TICK);
    passes.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let sweep_due = tokio::time::sleep(delay);
    tokio::pin!(sweep_due);
    loop {
        tokio::select! {
            _ = passes.tick() => {
                if let Some(led) = ledger.as_mut() {
                    master_pass::reconcile(&client, &shared.masters, &shared.activity, led, master_pass::this_process(), None).await;
                }
            }
            _ = &mut sweep_due => {
                delay = sweep(&client, &cfg, &shared.borrowed(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
                sweep_due.as_mut().reset(tokio::time::Instant::now() + delay);
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &shared.borrowed(), &adopted, &mut ledger, tokens.as_ref(), &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
                sweep_due.as_mut().reset(tokio::time::Instant::now() + delay);
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
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let SweepShared {
        masters,
        activity,
        job_panes,
        drain,
        ..
    } = *shared;
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
        // Leave is taken per project and held to the end of its iteration, so
        // a drain that begins part-way through a sweep waits for the project
        // in hand to finish admitting and stops the sweep at the next one.
        let _admitting = match drain.admit() {
            Ok(permit) => permit,
            Err(closed) => {
                let read = read_standing(ledger.as_ref(), &runner.project_id);
                let verdict =
                    standing_verdict(masters, read, &runner.project_id, &runner.slug).await;
                if matches!(verdict, Some((Placed::Proceed | Placed::Withheld, _))) {
                    masters.note_unplaced(
                        &runner.project_id,
                        Unplaced::Restarting {
                            cause: closed.cause,
                        },
                    );
                }
                supervise(client, masters, tokens, &runner.project_id, &runner.slug).await;
                continue;
            }
        };
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
        take_pool_job(client, cfg, shared, adopted, tokens, runner).await;

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
        let lifted_episode = standing.as_ref().and_then(lifted_from);

        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        let inbox = read_inbox(client, masters, &runner.project_id, &runner.slug).await;
        let placement = placement_for(&admissible, &inbox);
        if placement == Placement::AdoptOnly {
            if retire_if_idle(
                client,
                masters,
                activity,
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
                if !admissible.is_empty() || !inbox.is_empty() {
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
        // Read by project and boot, not off the session this process last
        // registered: a pane placed again is given a new master session, and a
        // run declared under the one it replaced was otherwise listed by
        // nobody after a restart and answerable by nobody after a resume
        // (ISS-1312).
        let inherited: Vec<InheritedRun> = ledger
            .as_ref()
            .and_then(|led| {
                let boot = inheritance_boot(
                    crate::runner::inflight::boot_identity(),
                    led,
                    &runner.project_id,
                    &runner.slug,
                )?;
                Some(inherited_runs(led, &runner.project_id, &boot))
            })
            .unwrap_or_default();
        let told = std::sync::atomic::AtomicBool::new(false);
        let started = std::sync::atomic::AtomicBool::new(false);
        let authority = AuthoritySink::default();
        let deaf = DeafSink::default();
        let hosts = subagent_host::ProcHosts::system();
        let pane = ensure_master(
            client,
            masters,
            &runner.project_id,
            &resolved,
            &Carryover {
                conversation: stored_conversation.as_deref(),
                inherited: &inherited,
                lifted: lifted_episode.as_ref(),
                stood_down_told: &told,
                started: &started,
                hosts: &hosts,
                slots: cfg.runner.max_job_panes.max(1),
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
        let heard = match authority.take() {
            Some(said) => {
                write_authority(ledger.as_ref(), &runner.project_id, &resolved.slug, &said);
                said.verdict == MasterAuthority::CURRENT
            }
            None => false,
        };
        // Gathered here rather than reported here: one project's deaf pane is a
        // line, and a box whose whole fleet went deaf at once is a condition
        // nobody reads four quarters of (ISS-1208).
        if let Some(found) = deaf.take() {
            deaf_found.push(found);
        }
        if let (true, Some((successor, name))) = (
            pane == PaneState::Adopted && heard,
            masters.get(&runner.project_id),
        ) {
            let pane_pid = terminal::pane_pid(&name).await;
            if let Some(led) = ledger.as_mut() {
                carried_across(
                    led,
                    &runner.project_id,
                    &name,
                    &successor,
                    pane_pid,
                    &hosts,
                    &resolved.slug,
                );
            }
        }
        let placed = started.load(std::sync::atomic::Ordering::Relaxed)
            && matches!(pane, PaneState::ColdStarted | PaneState::Resumed);
        if placed {
            if let (Some(led), Some((successor, _))) =
                (ledger.as_mut(), masters.get(&runner.project_id))
            {
                placed_again(
                    led,
                    &inherited,
                    &successor,
                    pane == PaneState::Resumed,
                    agent_activity::now_ms(),
                    &resolved.slug,
                    &hosts,
                );
            }
        }
        if pane == PaneState::Absent {
            continue;
        }
        if told.load(std::sync::atomic::Ordering::Relaxed) {
            let stamped = ledger.as_ref().zip(lifted_episode.as_ref());
            if let Some((led, lifted)) = stamped {
                if let Err(e) = led.note_standing_told(&runner.project_id, lifted.episode) {
                    tracing::warn!(
                        "[master] {}: cannot mark the lifted stand-down a pane has now been told about: {e} — the next pane placed will be told the same interval again",
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

        if !asked_this_sweep(&admissible, &inbox, held.as_ref()) {
            continue;
        }

        if pane == PaneState::StaleCapability {
            continue;
        }

        if standing_unknown {
            continue;
        }

        let digest = work_digest(&admissible).wrapping_add(master_inbox::inbox_digest(&inbox));
        let pass = NudgePass {
            client,
            shared: *shared,
            project_id: &runner.project_id,
            issue_key: master_pass::nudged_issue(&admissible, inbox.is_empty()),
        };
        if masters.claim_nudge(
            &runner.project_id,
            digest,
            reported.as_ref(),
            held.is_some(),
        ) {
            let slug = &resolved.slug;
            pass.open(ledger).await;
            nudge_master(masters, &runner.project_id, slug, held.as_ref(), &inbox).await;
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
/// The pane's `forge` CLI borrows the account its checkout was provisioned with,
/// so it reaches this project as the agent the pane's MCP server is — or, where
/// the provision left none, nothing is set and it reads its home's own account.
fn cli_borrow_env(slug: &str) -> Option<(String, String)> {
    let path = crate::mcp::config::cli_borrow_path(slug).ok()?;
    if !path.is_file() {
        tracing::warn!(
            "[master] {slug}: no checkout credential at {} — this pane's forge CLI reads the box's own account, which may not reach {slug}; re-provision the checkout",
            path.display()
        );
        return None;
    }
    Some((
        crate::mcp::config::CLI_BORROW_VAR.to_string(),
        path.to_string_lossy().into_owned(),
    ))
}

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
    shared: &SweepShared<'_>,
    adopted: &tokio::sync::watch::Receiver<bool>,
    tokens: Option<&session_tokens::SessionTokens>,
    runner: &runners::MeRunner,
) {
    let SweepShared {
        job_panes,
        job_records,
        ..
    } = *shared;
    if !*adopted.borrow() {
        return;
    }
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    let took = pool_jobs::take_one(
        &pool_jobs::JobPorts {
            pool: &pool_jobs::CorePool {
                client,
                limit: 20,
                deadline: crate::transport::pool::CALL_DEADLINE,
            },
            panes: &pool_jobs::TmuxPanes,
            report: &pool_jobs::CoreReport { client },
            records: job_records,
        },
        job_panes,
        pool_jobs::ServedProject {
            id: &runner.project_id,
            slug: &runner.slug,
        },
        job_panes.session_id(),
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
        Ok(terminate::Release::Refusing { why, first }) => {
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

/// Write the skill where the session about to start will look for it, under
/// the rule every other write point keeps: a checkout the install leaves
/// unwritten gets no skill, and so no pane (ISS-1357). `dir` is where the
/// outcome is recorded for `forge-runner status`.
fn install_skill(
    repo: &std::path::Path,
    slug: &str,
    dir: Option<&std::path::Path>,
) -> Result<(), String> {
    use crate::daemon::master_skill::{install_and_record, Point};
    let outcome = install_and_record(slug, repo, Point::Placement, dir);
    if outcome.installed() {
        return Ok(());
    }
    Err(outcome.says(Some(repo), crate::update::CURRENT_VERSION))
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

pub(crate) fn inherited_runs(led: &Ledger, project_id: &str, boot_id: &str) -> Vec<InheritedRun> {
    let runs = match led.inheritable_runs(project_id, boot_id) {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!(
                "[master] {project_id}: cannot read the runs a pane placed now would inherit: {e} — a resumed pane is told of none"
            );
            return Vec::new();
        }
    };
    runs.into_iter()
        .map(|r| InheritedRun {
            master_session_id: r.master_session_id.clone(),
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
            pid: r.pid,
            host: r.host_pid.zip(r.host_start),
        })
        .collect()
}

/// The boot a pane placed now inherits the runs of.
///
/// Read fresh, as the declarations were stamped with it. Where this sweep
/// cannot read it, the boot this daemon recorded against the project's master
/// row stands in, because an empty identity matches no run and a resumed pane
/// told of none can answer for none, with no later sweep to tell it again. Where
/// neither answers, that is said and nothing is inherited (ISS-1312).
pub(crate) fn inheritance_boot(
    read: Option<String>,
    led: &Ledger,
    project_id: &str,
    slug: &str,
) -> Option<String> {
    if let Some(boot) = read {
        return Some(boot);
    }
    match led.master_for_project(project_id) {
        Ok(Some(row)) => Some(row.boot_id),
        Ok(None) => {
            tracing::warn!(
                "[master] {slug}: this box cannot read its boot identity this sweep and holds no master row to take it from, so a pane placed now is told of no inherited run and none is marked or adopted"
            );
            None
        }
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: this box cannot read its boot identity this sweep, nor its master row ({e}), so a pane placed now is told of no inherited run and none is marked or adopted"
            );
            None
        }
    }
}

/// A master pane this sweep started, in place of one that was absent, takes
/// over what the pane before it left.
///
/// A subagent runs inside the Claude Code process recorded for it, so each
/// inherited run whose process is read gone ended with it, whatever turn it
/// was in, and is marked so: that is what lets the drain and recovery stop
/// reading a dead subagent as one still in its first turn. One whose process
/// is alive, or unrecorded, is not: the pane was not where it ran. A resumed pane continues the
/// conversation that dispatched them and its brief lists them as its own, so
/// they are recorded under its master session too, and its choice, its close
/// and its next declaration match them. A cold-started pane is told of none
/// and cannot resume one, so they stay where they were, for recovery to
/// release once core calls each session over (ISS-1312).
pub(crate) fn placed_again(
    led: &mut Ledger,
    inherited: &[InheritedRun],
    successor: &str,
    resumed: bool,
    at_ms: i64,
    slug: &str,
    hosts: &dyn subagent_host::Hosts,
) {
    let mut ended = 0;
    let mut adopted = 0;
    for run in inherited {
        let marked = if run.ends_with_placement(hosts) {
            led.note_host_ended(&run.run_id, at_ms, crate::runner::ledger::HOST_PANE_STARTED)
        } else {
            Ok(false)
        };
        match marked {
            Ok(true) => ended += 1,
            Ok(false) => {}
            Err(e) => tracing::warn!(
                "[master] {slug}: run {}: cannot record that the process its subagent ran in is gone: {e} — the drain still reads it as a subagent at work",
                run.run_id
            ),
        }
        if !resumed || run.master_session_id == successor {
            continue;
        }
        match led.reparent_run(&run.run_id, successor) {
            Ok(()) => adopted += 1,
            Err(e) => tracing::warn!(
                "[master] {slug}: run {}: cannot record it under the resumed pane's session {successor}: {e} — it stays {}'s, which no pane on this box answers for",
                run.run_id,
                run.master_session_id
            ),
        }
    }
    if let Some(line) = placement_line(ended, adopted, resumed, successor) {
        tracing::info!("[master] {slug}: {line}");
    }
}

/// A pane this box adopted onto a session core re-minted keeps answering for
/// the runs it declared before (ISS-1316).
///
/// A run is this pane's where the Claude Code process recorded for it — read
/// above the process that declared it, and again above the subagent that took
/// it — still runs, beneath the pane's own process `pane_pid`. A session id
/// cannot say this, because core reuses a non-terminal row for the pane placed
/// next under the same name, and a process merely alive cannot either, since
/// nothing but its parentage ties it to this pane. So every open run of the
/// project that this box does not serve under the pane's session now, and whose
/// process runs beneath this pane, is recorded under that session, where its
/// `run close` and `run choice` act. A run whose process is gone or runs
/// elsewhere is left where it is; one that could not be placed is counted.
///
/// Nothing here reads the session the pane acted under before. The pane's own
/// frames rewrite that record the moment the registry moves, so a carry keyed
/// on it could lose to a frame and carry nothing.
pub(crate) fn carried_across(
    led: &mut Ledger,
    project_id: &str,
    pane: &str,
    successor: &str,
    pane_pid: Option<u32>,
    hosts: &dyn subagent_host::Hosts,
    slug: &str,
) -> usize {
    let runs = match led.unclosed_runs() {
        Ok(runs) => runs,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: cannot read the open runs to carry {pane}'s across to {successor} ({e}); they stay where they are this sweep"
            );
            return 0;
        }
    };
    let mut moved = 0;
    let mut unattributed = 0;
    for run in runs.iter().filter(|r| {
        r.ended_by.is_none()
            && r.project_id.as_deref() == Some(project_id)
            && r.master_session_id != successor
    }) {
        let ours = match (run.host_pid, run.host_start.as_deref(), pane_pid) {
            (Some(pid), Some(start), Some(pane)) => hosts.beneath(pid, start, pane),
            _ => subagent_host::HostRead::Unreadable,
        };
        match ours {
            subagent_host::HostRead::Alive => match led.reparent_run(&run.run_id, successor) {
                Ok(()) => moved += 1,
                Err(e) => tracing::warn!(
                    "[master] {slug}: run {}: cannot record it under {successor}: {e} — it stays {}'s, which no pane on this box answers for",
                    run.run_id,
                    run.master_session_id
                ),
            },
            subagent_host::HostRead::Gone => {}
            subagent_host::HostRead::Unreadable => unattributed += 1,
        }
    }
    if moved > 0 {
        tracing::info!(
            "[master] {slug}: {moved} open run(s) declared from a process still running in {pane} are now recorded under {successor}, the session core serves it as, so its close and its choice answer for them"
        );
    }
    if unattributed > 0 {
        tracing::warn!(
            "[master] {slug}: {unattributed} open run(s) of this project are under another session and whether their recorded process runs in {pane} could not be read, so they are left where they are"
        );
    }
    moved
}

/// What [`placed_again`] says it did. A run is called ended with the pane only
/// where its end was recorded: a line that says so of runs whose process
/// still reads alive tells the operator the opposite of what the box did
/// (ISS-1312 criterion 72, the eighth judge's J3).
fn placement_line(ended: usize, adopted: usize, resumed: bool, successor: &str) -> Option<String> {
    if ended == 0 && adopted == 0 {
        return None;
    }
    let what_ended = if ended == 0 {
        "no run it inherits ended with it, since no Claude Code process recorded for their subagents was read gone".to_string()
    } else {
        format!("the Claude Code process the subagents of {ended} run(s) it inherits ran in is gone too, so they ended with it")
    };
    let whose = if resumed {
        format!("{adopted} run(s) it inherits declared under a master session this placement replaced are now recorded under this pane's session {successor}, so its choice, its close and its next declaration answer for them")
    } else {
        "a cold-started pane cannot resume any of them, so each stays with the session that declared it and is released once core calls its session over".to_string()
    };
    Some(format!(
        "this pane was started in place of one that is gone, and {what_ended}; {whose}"
    ))
}

pub(crate) struct InheritedRun {
    pub run_id: String,
    /// The master session that declared it, which a placement may have
    /// replaced.
    pub master_session_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
    pub pid: Option<u32>,
    /// The Claude Code process recorded for its subagent, and its start time.
    pub host: Option<(u32, String)>,
}

impl InheritedRun {
    /// A run with no process of its own is a subagent's, living inside the
    /// Claude Code process recorded for it. A pane started in place of its
    /// master's is its end only where that process is read gone: the
    /// conversation can run as a background session outside any pane, and
    /// its subagents with it (ISS-1312, run e67c08e0). The one predicate
    /// [`placed_again`] records and [`resumed_brief`] states.
    pub(crate) fn ends_with_placement(&self, hosts: &dyn subagent_host::Hosts) -> bool {
        self.pid.is_none()
            && self.ended_by.is_none()
            && self.host.as_ref().is_some_and(|(pid, start)| {
                hosts.read(*pid, start) == subagent_host::HostRead::Gone
            })
    }
}

/// What a pane placed after a stand-down was lifted is told about the gap.
///
/// The brief's first line asserts the reader is this project's master, and a
/// resumed conversation carries a transcript that ends mid-work. Without this,
/// a master stood down for nine hours wakes believing it was driving the whole
/// time (ISS-1118).
///
/// The two reasons are here because the interval alone tells a master that
/// something happened and nothing about what. A pane that knows the box was
/// waiting on four outstanding writes, and that the wait ended because one of
/// them landed, can read the board knowing what it is looking for (ISS-1238).
pub(crate) fn stood_up_brief(lifted: &Lifted) -> String {
    let mins = lifted.held_for.as_secs() / 60;
    let span = if mins >= 120 {
        format!("{} hours", mins / 60)
    } else if mins >= 1 {
        format!("{mins} minutes")
    } else {
        format!("{} seconds", lifted.held_for.as_secs())
    };
    let mut out = format!(
        "\nThis project was STOOD DOWN for {span} and has just been stood up again. This box \
placed no master for it over that interval and nudged none, so nothing you remember doing \
happened during it — whatever was decided about this project in that time was decided by \
somebody else, and the tracker is where it is written rather than in anything you recall. Read \
the board before you act on any intention you are carrying from before the gap.\n"
    );
    out.push_str(&format!(
        "\nIt was stood down because: {}\n",
        lifted.why.as_deref().unwrap_or(MasterStanding::NO_REASON)
    ));
    out.push_str(&match lifted.lifted_on.as_deref() {
        Some(on) => format!("It was stood up because: {on}\n"),
        None => "No argument was recorded for standing it up — that episode predates the \
requirement, so what ended the wait is not on this box's record.\n"
            .to_string(),
    });
    out
}

/// `placed` is whether this pane was started in place of an absent one, which
/// [`placed_again`] records as the end of every inherited run's subagent the
/// brief must then not state as live (ISS-1312).
pub(crate) fn resumed_brief(
    conversation: &str,
    runs: &[InheritedRun],
    placed: bool,
    hosts: &dyn subagent_host::Hosts,
) -> String {
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
        let incarnation = if placed && r.ends_with_placement(hosts) {
            "not running: its subagent ended with the pane this one was started in place of, \
and the Claude Code process it ran in is gone"
                .to_string()
        } else {
            r.incarnation.to_string()
        };
        out.push_str(&format!(
            "\n- run `{}`\n  issues: {}\n  worktree: {}\n  incarnation: {}\n  work: {}\n  subagent: {}\n  ended: {}\n",
            r.run_id,
            if r.issue_keys.is_empty() { "none recorded".to_string() } else { r.issue_keys.join(", ") },
            r.worktree_path,
            incarnation,
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
    let dir = crate::config::base_dir().ok()?.join("master").join(slug);
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

pub(crate) fn placement_for(
    admissible: &[AdmissibleIssue],
    inbox: &[UnansweredDocument],
) -> Placement {
    if admissible.is_empty() && inbox.is_empty() {
        Placement::AdoptOnly
    } else {
        Placement::AdoptOrStart
    }
}

/// What a pane this sweep places carries over from whatever stood before it:
/// the conversation it resumes, the runs that conversation holds, and the
/// stand-down its project has just come out of.
pub(crate) struct Carryover<'a> {
    conversation: Option<&'a str>,
    inherited: &'a [InheritedRun],
    /// Set only for a pane placed after a stand-down was lifted, so a resumed
    /// conversation is not told merely that it is master again (ISS-1118), and
    /// carrying the two reasons as well as the interval (ISS-1238).
    lifted: Option<&'a Lifted>,
    /// Raised when the brief carrying `lifted` actually reached a pane. The
    /// sweep stamps the lifted episode told only on this, because a pane that
    /// was adopted rather than started was sent no brief at all, and one whose
    /// brief failed to land was told nothing — stamping on either would spend
    /// the episode undelivered.
    stood_down_told: &'a std::sync::atomic::AtomicBool,
    /// Raised when this call started a pane process of its own, which is what
    /// proves the one before it gone: a pane found already up is somebody's
    /// running process, and its subagents with it.
    started: &'a std::sync::atomic::AtomicBool,
    /// The box's process table: where each inherited subagent runs, and what
    /// runs a conversation outside this box's panes.
    hosts: &'a dyn subagent_host::Hosts,
    slots: u32,
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

    let session = match master_api::register(client, project_id, &name, carry.slots).await {
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
            capability_of(tokens, &session.session_id, project_id, &name),
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
                    if let Some(held) = masters.readopt(project_id, &session.session_id) {
                        tracing::info!(
                            "[master] {}: core now serves {name} as session {} in place of {held}. The pane keeps the capability it was placed with, which names this project and this pane rather than a session, so it is not ended; this box serves it under the new session from now on",
                            resolved.slug,
                            session.session_id
                        );
                    }
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

    // The last pane placed here exited because Claude Code runs this
    // conversation as a background session. Another would exit the same way,
    // so none is placed while a process on this box still names it, or while
    // this box cannot read whether one does; once the whole table reads that
    // none does, the session has ended and a pane resuming it can run
    // (ISS-1312, F1).
    if let Some(conversation) = masters
        .elsewhere(project_id)
        .filter(|c| stored_conversation == Some(c.as_str()))
    {
        let short = masters.elsewhere_short(project_id);
        match carry.hosts.running(&conversation) {
            subagent_host::Running::Found(pid) => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::ConversationElsewhere {
                        conversation,
                        short,
                        pid,
                    },
                );
                return PaneState::Absent;
            }
            subagent_host::Running::Unreadable => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::ConversationUnaskable {
                        conversation,
                        short,
                    },
                );
                return PaneState::Absent;
            }
            subagent_host::Running::Absent => {
                tracing::info!(
                    "[master] {}: no process on this box names conversation {conversation} any more, so its background session has ended and a pane resuming it is placed",
                    resolved.slug
                );
                masters.clear_elsewhere(project_id);
            }
        }
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

    if let Err(e) = install_skill(
        &resolved.repo_path,
        &resolved.slug,
        crate::daemon::control::config_dir().as_deref(),
    ) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::SkillMissing { detail: e },
        );
        return PaneState::Absent;
    }

    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    let mut env = terminal::pane_env();
    env.extend(cli_borrow_env(&resolved.slug));
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
                    say_unplaced(
                        masters,
                        project_id,
                        &resolved.slug,
                        Unplaced::ServersUnwritable {
                            detail: format!(
                                "{e}; the previous config could not be removed either ({ce}), and it still claims servers a pane started now would not carry"
                            ),
                            dir: crate::mcp::config::session_dir(),
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
                            dir: crate::mcp::config::session_dir(),
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
        Some(store) => match store.mint(&session.session_id, project_id, &resolved.slug, &name) {
            Ok(token) => env.push((session_tokens::TOKEN_ENV.to_string(), token)),
            Err(e) => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::CapabilityUnminted {
                        detail: e.to_string(),
                    },
                );
                return PaneState::Absent;
            }
        },
        None => {
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::CapabilityUnminted {
                    detail: "this box cannot resolve where its control token map lives".into(),
                },
            );
            return PaneState::Absent;
        }
    }
    let resume = resume_for(&resolved.slug, &resolved.repo_path, stored_conversation);
    let output_from = transcript
        .as_deref()
        .map(|p| std::fs::metadata(p).map_or(0, |m| m.len()));
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
            let detail = format!("could not start {name}: {e}");
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
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::PaneUnstarted { detail },
            );
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
    if started {
        masters.note_placed(project_id, transcript.clone().zip(output_from));
    }
    carry
        .started
        .store(started, std::sync::atomic::Ordering::Relaxed);
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
        &reach,
    );
    let brief = match resume.as_deref() {
        Some(conv) => format!(
            "{brief}{}",
            resumed_brief(conv, inherited, started, carry.hosts)
        ),
        None => brief,
    };
    let brief = match carry.lifted {
        Some(lifted) => format!("{brief}{}", stood_up_brief(lifted)),
        None => brief,
    };
    match terminal::brief_new_pane(&name, &brief).await {
        Ok(()) => {
            let carried = carry.lifted.is_some();
            let order = std::sync::atomic::Ordering::Relaxed;
            carry.stood_down_told.store(carried, order);
        }
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
    /// A capability this box minted answers for the pane: a record naming its
    /// project and pane, or any entry naming the session core serves it now.
    Current,
    /// None does, so the pane is running on a capability minted before the
    /// record for a session that is gone, and every declaration it makes will
    /// be refused.
    Stale,
    /// This box cannot read its own map, so it says nothing about any pane.
    Unknown(String),
}

/// Judge a resident pane's capability from this box's own record of what it
/// minted.
///
/// The pane's token lives in its environment and is out of reach here, but the
/// map is not: `mint` leaves exactly one entry per pane, naming the project and
/// pane it was placed as (ISS-1316). A record for this project and pane answers
/// whatever session core has since moved the pane to. A map holding neither
/// that nor anything for the session core now gives us is a pane holding a
/// capability minted before the record, adopted onto a row core replaced —
/// whether at this call or at one three restarts ago.
///
/// `session.created` answers only the first of those, which is why one project
/// of seven was reported on 2026-09-18 and the one that was actually stuck was
/// not (ISS-1099).
fn capability_of(
    tokens: Option<&session_tokens::SessionTokens>,
    session_id: &str,
    project_id: &str,
    pane: &str,
) -> Capability {
    let Some(store) = tokens else {
        return Capability::Unknown(
            "this box could not resolve where its capability map lives".to_string(),
        );
    };
    match store.answers_for(session_id, project_id, pane) {
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

fn nudge(inbox: &[UnansweredDocument]) -> String {
    format!(
        "Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.{}",
        master_inbox::inbox_line(inbox)
    )
}

/// What this project's channel and issue threads owe, as core answers them this sweep.
///
/// Each read that fails is said once per cause and counts as nothing owed for
/// this pass only: the issues the sweep already read still decide it, and the
/// next sweep reads again. A failure is never cached as an empty inbox, and one
/// read failing never hides what the other found.
async fn read_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    let mut owed = read_channel_inbox(client, masters, project_id, slug).await;
    owed.extend(read_comment_inbox(client, masters, project_id, slug).await);
    owed
}

/// What a person is owed a reply to on this project's issues, at any status.
async fn read_comment_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    // Keyed apart from the channel read, so each failure is said once and each recovery once.
    let key = format!("{project_id}#comments");
    match comment_inbox::unanswered(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(&key, None) {
                tracing::info!("[master] {slug}: the comment inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(&key, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read which issue comments a person is owed a reply to ({why}) — this pass is decided without them, and a comment waiting for a reply is not seen until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

async fn read_channel_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    match channel_inbox::unanswered(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(project_id, None) {
                tracing::info!("[master] {slug}: the channel inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(project_id, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read what the ecosystem channel owes ({why}) — this pass is decided by its issues alone, and a document waiting for a reply is not seen until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

struct NudgePass<'a> {
    client: &'a CoreClient,
    shared: SweepShared<'a>,
    project_id: &'a str,
    issue_key: Option<&'a str>,
}

impl NudgePass<'_> {
    async fn open(&self, ledger: &mut Option<Ledger>) {
        let masters = self.shared.masters;
        let (Some(led), Some((session_id, _))) = (ledger.as_mut(), masters.get(self.project_id))
        else {
            return;
        };
        let nudged = master_pass::Nudged {
            project_id: self.project_id,
            session_id: &session_id,
            issue_key: self.issue_key,
            prompts: self.shared.activity.get(&session_id).map(|a| a.prompts),
        };
        let process = master_pass::this_process();
        let activity = self.shared.activity;
        master_pass::open_for_nudge(self.client, masters, activity, led, process, &nudged).await;
    }
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
    inbox: &[UnansweredDocument],
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    match held {
        Some(refusal) => tracing::warn!("{}", limit_reask_line(slug, &name, refusal)),
        None if inbox.is_empty() => {
            tracing::info!("[master] {slug}: admissible work — nudging {name}")
        }
        None => tracing::info!(
            "[master] {slug}: admissible work, {} channel document(s) or issue comment(s) owed a reply — nudging {name}",
            inbox.len()
        ),
    }
    if let Err(e) = terminal::send_line(&name, &nudge(inbox)).await {
        // A pane that exited before the nudge reached it is reported by the
        // sweep that reads it gone, with why; a warning here too would be the
        // second line per placement ISS-1343 counted on sid-desk.
        if recovery_ports::pane_presence(&name).await == recovery::MasterPresence::Gone {
            tracing::debug!(
                "[master] {slug}: {name} exited before the nudge reached it ({e}); the sweep that reads it gone says why"
            );
        } else {
            tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
        }
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

    // The reading recovery takes of the same pane (ISS-1312 criteria 45 and
    // 46). `terminal::alive` folds a tmux nobody could ask into `false`, and
    // closing on that ends a master that may be running and makes recovery
    // read its runs as having no master at all.
    let read = recovery_ports::pane_presence(&name).await;
    let unanswered = read == recovery::MasterPresence::Unanswered;
    if masters.note_unanswered(project_id, unanswered) && unanswered {
        tracing::warn!(
            "[master] {slug}: tmux could not be asked whether resident session {name} is there, so its core session is left open and it stays this project's master until tmux answers"
        );
    }
    if read == recovery::MasterPresence::Alive {
        if let Some(n) = masters.outlived(project_id) {
            tracing::info!(
                "[master] {slug}: {name} has stayed up past {}s of its placement, so the condition of {n} early exits in a row has ended",
                pane_exit::EARLY_EXIT.as_secs()
            );
        }
    }
    if read == recovery::MasterPresence::Gone {
        // Why the pane is gone, from what it printed after this box placed
        // it, said in the one line that says it is gone (ISS-1343). A pane
        // resuming a conversation Claude Code runs as a background session
        // exits at once saying so, and placing another only repeats that.
        let placed = masters.take_placed(project_id);
        let lived = placed.as_ref().map(|p| p.at.elapsed());
        let exit = match &placed {
            None => pane_exit::Exit::not_placed(),
            Some(PlacedPane { output: None, .. }) => pane_exit::Exit::no_transcript(),
            Some(PlacedPane {
                output: Some((path, from)),
                ..
            }) => pane_exit::classify(path, *from),
        };
        let in_a_row = masters.count_exit(project_id, lived, &exit);
        match pane_exit::journal(slug, &name, lived, &exit, in_a_row) {
            pane_exit::Say::Warn(line) => tracing::warn!("{line}"),
            pane_exit::Say::Error(line) => tracing::error!("{line}"),
            pane_exit::Say::Quiet(line) => tracing::debug!("{line}"),
        }
        if let pane_exit::Exit::Elsewhere {
            conversation,
            short,
        } = &exit
        {
            masters.note_elsewhere(project_id, conversation.clone(), short.clone());
        }
        record_exit(slug, &name, lived, in_a_row, exit);
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

/// Keep `exit` where `forge-runner master status` reads it, saying so where it
/// cannot be kept.
fn record_exit(
    slug: &str,
    name: &str,
    lived: Option<Duration>,
    in_a_row: u32,
    exit: pane_exit::Exit,
) {
    let record = pane_exit::Record {
        pane: name.to_string(),
        read_gone_at: master_limit::now_unix(),
        lived_secs: lived.map(|l| l.as_secs()),
        in_a_row,
        exit,
    };
    let written = pane_exit::master_dir(slug)
        .map_err(|e| e.to_string())
        .and_then(|dir| {
            pane_exit::write(&dir, &record).map_err(|e| format!("{}: {e}", dir.display()))
        });
    if let Err(e) = written {
        tracing::warn!(
            "[master] {slug}: could not keep why {name} exited ({e}), so `forge-runner master status {slug}` cannot say it"
        );
    }
}

async fn retire_if_idle(
    client: &CoreClient,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
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
    let pane = activity.get(&session_id).map(|a| master_exit::Pane::of(&a));
    let now_ms = agent_activity::now_ms();
    match master_exit::verdict(idle, pane, &kids, now_ms) {
        Verdict::Stay(why) => {
            tracing::debug!("[master] {slug}: keeping {name}: {why:?}");
            false
        }
        Verdict::Exit(quiet) => {
            tracing::info!(
                "[master] {slug}: idle — {} — retiring {name}",
                quiet.reason(now_ms)
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
        // The pane's own entry names the session it was placed under, which
        // is not this one where core moved the pane since (ISS-1316).
        if let Some((_, pane)) = masters.get(project_id) {
            store.retire_pane(project_id, &pane);
        }
    }
    masters.forget(project_id);
}
