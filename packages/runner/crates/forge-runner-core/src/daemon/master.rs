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
use crate::daemon::master_exit::{self, Verdict};
use crate::daemon::master_limit;
use crate::daemon::pool_jobs::{self, JobPanes, Records};
use crate::daemon::recovery;
use crate::daemon::recovery_ports::{CoreBeat, CoreRunState, PaneMasters, SignalProbe};
use crate::daemon::run_exit;
use crate::daemon::run_record;
use crate::daemon::session_tokens;
use crate::daemon::terminal;
use crate::runner::close_loop;
use crate::runner::ledger::{Ledger, Run};
use crate::runner::terminate;
use crate::transport::admissible::{self, AdmissibleIssue, DISPATCH_GATING_KIND};
use crate::transport::{master as master_api, mcp_servers, runners, CoreClient};
use tokio::sync::mpsc;

/// How often the box asks whether any work exists.
// cm:why this interval IS the latency from an issue opening to an agent touching it, and it is the whole budget: nothing pushes any more, so a job queued one tick after a poll waits a full interval before anything looks. 30s was chosen against the old push path's measured dispatch lag on epodsystem (queue→dispatch of 17m, 23m, 46m and 2h08 on 2026-09-04) — an order of magnitude of headroom, at one cheap request per project per half minute.
const POLL_INTERVAL: Duration = Duration::from_secs(30);

/// The closest together two wake-driven sweeps may run.
// cm:guard this is a COALESCING FLOOR, never a rate limit that drops work. A wake inside the window waits out the remainder and then sweeps; it is not discarded. Core publishes one `master.wake` per issue arrival, so promoting five drafts or closing a batch delivers five frames in about as many milliseconds, and a sweep per frame would be five `/me/runners` reads plus five pool reads per project to find what the first one already found. The channel is capacity 1 and extra frames are dropped ON PURPOSE while one is pending — the sweep that follows reads the WHOLE pool, so a dropped frame costs nothing a later read does not already cover.
const WAKE_FLOOR: Duration = Duration::from_secs(5);

/// The longest a master may go un-nudged while the work in front of it is unchanged.
// cm:guard a CEILING ON SILENCE, never a gate: an unchanged pool still reaches the master on this period, so a pass lost to a wedged pane, an ignored line or a limit cleared out of band is retried without an operator. The same reason `LIMITED_POLL_INTERVAL` is a backoff and not a blackout — read it as permission to stop nudging and the fleet cannot self-heal.
// cm:guard the pane costs REAL MONEY per nudge, which is why this exists at all: one nudge is one full agent pass, measured at ~$0.18 on forge-vm 2026-09-08, and 1,354 nudges over 95 minutes bought 0 claims and $245 while every runner sat rate-limited. An unconditional nudge on every sweep is a spend proportional to sweeps rather than to work.
pub(crate) const NUDGE_REFRESH: Duration = Duration::from_secs(5 * 60);

/// Sweep spacing once every project this box serves is rate-limited.
// cm:guard this is a BACKOFF, never a blackout, and the distinction is the whole design. Core clears a limit only when a job SUCCEEDS (`clearRunnerLimit`), so a master that declines to sweep while limited removes the only thing that can clear the stamp, and an operator who fixes the account out of band is left watching an idle fleet forever. Slowing down costs a few minutes of latency; stopping costs the self-heal.
pub(crate) const LIMITED_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// The first thing a resident master is told, once, when its session starts.
// cm:guard name the skill and STOP. Restating its RULES here creates a second copy of the master's process, and the copies drift in silence because nothing compares them — the skill file is where a reader looks and this string is what a master is actually told. The two ship together (see the include_str edge below), so there is no version where inlining the rules here is even the safer half. The owner policy block below is the one thing that is not a copy: the skill holds the defaults and defers to it by name, and it exists nowhere in the binary.
// cm:guard that rule is now ENFORCED and was not before, which is why it failed. This string used to carry "There is no job pool and no second terminal: the lease `forge claim` takes on the issue is the whole record of a run" — true on 2026-09-13, false from ISS-1080 on 2026-09-17, which updated the skill file a person would naturally edit and missed this literal. A master then held two texts contradicting each other on exactly the two points ISS-1094 is about, with this one in context every turn and the skill only read when the model chose to; the masters that resolved it toward this string did not declare. `the_standing_brief_is_only_what_a_wave_cannot_know` is the golden text that makes reintroducing any of it fail, paraphrase included.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — the division is the contract: every rule about how a run works belongs to that file and nothing about it may be restated here. The two ship in one binary and are the pair ISS-1080 broke.
// cm:guard this is the STANDING brief and the pass prompt is the wave, and the split is what makes residency worth anything. Folding the two back together sends the whole brief every 30 seconds — the cold start this change removed, arriving as tokens instead of as a process.
// cm:guard the policy is spliced VERBATIM and is never summarised, reordered or merged into the sentences around it. It is the project owner speaking, this box is a courier, and a courier that paraphrases is how an instruction that was typed correctly arrives wrong. The heading is what lets the skill defer to it by name.
// cm:edge contract -> packages/core/src/devices/me-runners.ts — the text arrives as `masterPolicy` on `/me/runners`, from the `master-policy` projectFact. `None` means the project set none, and the skill's own defaults stand; it never means "brief nothing".
// cm:edge contract -> packages/core/src/devices/mcp-servers-routes.ts — `dropped` is that route's `droppedNames`, the servers this project declared that core could not supply; an empty list says nothing rather than saying all is well.
fn standing_prompt(
    project: &str,
    base_branch: Option<&str>,
    master_policy: Option<&str>,
    dropped: &[String],
    servers_unreadable: bool,
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
    // cm:guard the UNREADABLE case gets its own sentence and never borrows the dropped-names one. "This project declares nothing" and "this box could not find out what it declares" lead a master to opposite acts — the first says build here, the second says do not trust the tool inventory — and a master told the first while the second is true dispatches runs into an empty pane and reads the emptiness as the project's own shape.
    if servers_unreadable {
        out.push_str(
            "\nThis box could NOT read this project's declared MCP servers from core, so this \
pane carries none of them whatever the project declares. Treat the tool inventory you can see as \
incomplete: an issue whose work needs a project MCP server cannot be judged buildable here until a \
master starts on a pane that could read them.\n",
        );
    }
    // cm:guard say it ONCE, here, and never let it become a park three hours later. A declared server that resolved to nothing is the shape this project was unbuildable in for days: the panel says `Connected`, the agent has no tools, and the only reader who can act on it is the master about to spend money dispatching runs into it.
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

/// What this box knows about each project's resident master.
// cm:guard one master per PROJECT, and the key is the project id rather than the box. Two masters on one project read the same queue and both dispatch: core refuses the second lease on the same ISSUE, but two runs on two issues would each cut a worktree from a checkout neither master knows the other is standing in. Two masters on DIFFERENT projects are fine and are the point — they share no tree.
// cm:guard this map is now an OPTIMISATION, not the bound. The bound moved to two places that survive this process: tmux refuses a second session under a name that exists, and core refuses a second live `agent_sessions` row for the same (device, project). It had to move, because a session parented by the multiplexer is invisible to any in-process set — which is exactly the hole ISS-919 B1 names. Never re-derive the bound from this map alone: a daemon restart empties it while every master is still running.
// cm:guard this bounds masters and NOTHING ELSE, and nothing else on the box bounds them either: `duplex_max_sessions` sizes a permit pool no spawn takes from any more. Adding a project adds a claude process with nothing counting it, and each one now dispatches its own runs inside itself; measured on dev1 2026-09-05 at load 17.26 on 12 cores with CPU pressure some=52%. A box-level bound is owed and is not this map.
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
}

/// What this box knows about which projects it serves.
// cm:guard THREE states and never two, because "not in the set" and "no set" send an operator to
// opposite places. A daemon that has not yet read `/me/runners`, or whose last read failed, knows
// nothing about any project — and answering that with an empty set would tell a live master "this
// box does not serve you" on the strength of a network error (ISS-1092 criteria 4, 6).
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

/// Why this box did not place a project's master pane on its last sweep.
///
/// Each is a precondition of adoption that did not hold, named so a refusal can
/// carry it and an operator can act on it.
// cm:guard every variant names a condition SOMETHING has to change, and none of them names a
// deadline. The sentence this replaces promised re-adoption "within thirty seconds" on every one of
// these paths, and on a project with nothing admissible that promise never came true for 14 hours
// (ISS-1092). A variant added here that resolves on its own belongs in the sweep, not in a refusal.
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum Unplaced {
    /// The runner row refuses new work, so this sweep placed no pane for it.
    Draining { status: String },
    /// Core serves this project to this box but nothing here says where the
    /// checkout is.
    NoRepoPath,
    /// This box has no terminal multiplexer, so it can host no master at all.
    NoTerminal,
    /// Core refused the registration this pane's identity comes from.
    RegisterFailed { detail: String },
    /// The pane could not be given the skill it runs on, so none was started.
    SkillMissing { detail: String },
    /// Nothing is claimable and no pane is running, so none was started.
    // cm:guard this is the ONE variant that is not a fault, and it is recorded anyway. It is what
    // `NOTHING admissible starts no master` looks like from the outside, and a master pane cannot
    // exist in this state — so a declaration that meets it is a pane the daemon did not start.
    NothingAdmissible,
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
        }
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
    /// Whether this process has already said that the live pane's MCP
    /// configuration is behind what core resolves.
    // cm:guard in-process ON PURPOSE, and a daemon restart deliberately re-reports once. The alternative is a file, which would have to be swept and could outlive the pane it describes; a duplicate line after a restart costs a reader one glance, while a silence costs the operator the reason their master reaches no tools.
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

/// What the master did with the nudge it was last sent, as its own hooks said.
// cm:guard every arm here is something the AGENT reported through `forge-runner hook`, never something read off the pane. That distinction is the whole of `agent_activity`'s existence and the whole of ISS-933 criteria 17 and 18: transcript growth, a byte count and a quiet window are all a guess about a process, and a `UserPromptSubmit` frame is the process saying so. Adding an arm derived from anything but a hook frame puts the deleted quiet gate back.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SinceNudge {
    /// This session has never reported anything, so there is no evidence either way.
    // cm:guard this is also what a WINDOWS box reads, and the degradation is the safe one by construction rather than by luck. `control::serve` is `#[cfg(not(unix))] -> Err`, so no hook frame ever reaches `Activities` there, every session reads `Unreported`, `retry_owed` answers true, and `NUDGE_REFRESH` behaves exactly as it did before ISS-1100 — the ceiling on the clock. A box that cannot report its turns is told about its work too often, never too rarely.
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
        agent_activity::Doing::Working => SinceNudge::Working,
        agent_activity::Doing::AwaitingPermission => SinceNudge::AwaitingPermission,
        // cm:guard `turn_ended_failed` and NOT `last_event`: every frame overwrites `last_event`, so a lead turn that dies on a limit while a child is outstanding is followed by that child's own `SubagentStop` and reads as a clean finish — which withholds the retry in exactly the case the ceiling exists for. Found by review on ISS-1100 and pinned by `a_turn_that_died_while_a_child_was_outstanding_still_reads_as_failed`.
        agent_activity::Doing::Idle => {
            if now.turn_ended_failed {
                SinceNudge::Failed
            } else {
                SinceNudge::Ran
            }
        }
    }
}

/// Whether the ceiling owes this master the same work a second time.
// cm:guard the ceiling itself is NOT deleted and must not be — `9a7c34b99` states why it exists, and the two cases it exists for are both here: a pass lost to a wedged pane is `NoTurn`, and a pass that died on an account limit which has since cleared out of band is `Failed`. What changed in ISS-1100 is only what justifies the repeat. Collapsing this to `true` restores a pass every five minutes for as long as a blocker stands (1,630 in 24h, measured on forge-vm 2026-09-19); collapsing it to `false` abandons both recoveries with no operator anywhere to notice.
// cm:guard `Unreported` retries, and every unknown must keep doing so: a master whose hooks are not installed, and one this daemon has restarted under, both read that way, and a mistake here has to cost a duplicate pass rather than a missed one.
fn retry_owed(since: SinceNudge) -> bool {
    match since {
        SinceNudge::Unreported | SinceNudge::NoTurn | SinceNudge::Failed => true,
        SinceNudge::Working | SinceNudge::AwaitingPermission | SinceNudge::Ran => false,
    }
}

/// What the master is being asked to look at, as one comparable value.
///
/// Every input the master's own eligibility reads, and nothing else: the issue's
/// identity, its status, and the blocker facts on it. A title or a priority
/// moving is not new work and a digest that tracked them would nudge on every
/// edit an operator makes in the UI.
// cm:guard ORDER-INDEPENDENT by construction (the lines are sorted before hashing) because the route promises no stable order: `readAdmissibleIssues` runs one query per project, so hashing the sequence would report new work every time two rows swapped. The blocker facts of ONE issue are sorted for the same reason — `json_agg` fixes no order either.
// cm:guard this was identity ALONE until ISS-1100, and widening it is that issue's other half rather than a nicety. Core offers rows the master then refuses — forge-dev admits `developed`, `testing`, `tested` and `awaiting_release`, none of which `TAKEABLE` contains — and it offers a row whose `blocks` edge has expired, which the master's own reading still refuses. In every one of those the refusal LIFTS without the id set moving: the row reaches `reopen`, or the blocker reaches `developed`. Under the clock that was covered by the next refresh; under `retry_owed` it is not, so an identity-only digest strands the work silently and for good. What the master decides on has to be what the digest is taken over.
// cm:guard exactly the fields the master's own reading takes and NOT everything the route happens to send. `RELATIONS` in `devices/admissible.ts` returns every incoming edge of every kind with its merge stamp and expiry, and `holdsBack` reads none of that but the kind and the blocker's status: a `relates` edge appearing, a blocker's `merged_at` being stamped, an expiry being moved are all changes the master would answer identically, and hashing them buys back the spend this issue exists to remove — at once, because a changed digest skips the ceiling. An expiry that MATTERS moves the row in or out of the set instead, which the id half already carries.
// cm:edge contract -> packages/core/src/devices/admissible.ts — `RELATIONS` is where these fields come from, and a field added there is not automatically one to hash here
// cm:guard and it is still not a `takeable` boolean computed here. The digest says WHETHER the inputs moved, never what they mean — deciding that is the master's, and a box that pre-answered it would be the second opinion `devices/admissible.ts` spent ISS-1100 collapsing into one.
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

/// Whether the master should hear about this pool now.
// cm:guard TRUE is the safe answer and every unknown returns it: a master with no recorded nudge is nudged, and changed work is nudged immediately rather than waiting out the period.
// cm:guard CHANGED work never consults the evidence, and that order is the answer rather than an optimisation: new work is new whatever the pane is doing, and asking `retry_owed` about it would let a master that happens to be mid-turn miss an issue that appeared while it ran.
fn nudge_due(prev: Option<Nudge>, digest: u64, now: Instant, since: SinceNudge) -> bool {
    match prev {
        None => true,
        Some(last) if last.digest != digest => true,
        Some(last) => now.saturating_duration_since(last.at) >= NUDGE_REFRESH && retry_owed(since),
    }
}

impl Masters {
    pub fn new() -> Self {
        Self::default()
    }

    /// The session id and pane of the master this box has up for a project.
    // cm:guard returns the pane NAME with the session id rather than the id alone, because every caller has to ask tmux whether that pane is still there — a registry entry outlives the process it names by design (the ISS-919 B1 hole), so an answer that could not be checked would be a claim this struct cannot make.
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

    /// Decide whether to nudge this project now, and record having done so.
    ///
    /// One call, because a check that did not record would nudge on every
    /// sweep exactly as before.
    // cm:guard the activity is read by the CALLER and handed in, rather than this method reaching into `Activities` while it holds the registry lock. Two leaf mutexes taken in one order here and the other order anywhere else is a deadlock that appears under load and never in a test.
    // cm:guard ONE reading of that activity answers both halves — what the last nudge produced, and the mark the NEXT one is judged against. Reading it twice would let a turn that began between the two reads be counted against a nudge that had not been sent yet.
    fn claim_nudge(
        &self,
        project_id: &str,
        digest: u64,
        seen: Option<&agent_activity::Activity>,
    ) -> bool {
        let mut reg = self.0.lock().expect("masters poisoned");
        let Some(m) = reg.live.get_mut(project_id) else {
            return false;
        };
        let now = Instant::now();
        let since = since_nudge(seen, m.last_nudge.and_then(|n| n.prompts));
        if !nudge_due(m.last_nudge, digest, now, since) {
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
        reg.live.remove(project_id).map(|m| m.session_id)
    }

    /// Which project's master a session id is, for a declaration this box is
    /// about to bound.
    // cm:guard the REVERSE of `pane_for_session`, and it is a local read of a map already keyed by project — it does NOT ask core which project a session belongs to, which is the thing the guard below says core neither knows nor says on a frame. The two answer opposite questions and neither is the other's fallback (ISS-1050 criterion 7).
    // cm:guard `None` is REFUSED by the caller and never guessed. This map is an optimisation rather than the bound, so a daemon restart empties it while every master is still running: a declaration arriving in that window has to be refused, and `why_unplaced` is what says why rather than promising a sweep. Deriving a project from the only entry present, or from the frame's own claim, is how a pane on one project opens a run over another's issue.
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

    /// Record why this project's master pane was not placed, answering whether
    /// that reason is new or changed.
    // cm:guard the bool is what keeps this out of the log every sweep. A project with nothing
    // admissible is unplaced on every one of the ~2,880 sweeps a day, and a line per sweep is a
    // line an operator learns to scroll past — including on the sweep where the reason changed.
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

    /// Why a declaration for this project cannot be served, in words its caller
    /// can act on.
    ///
    /// Reached only when the caller's capability names no session this box
    /// holds a master under, so every arm refuses.
    // cm:guard the project id is read for the DIAGNOSIS and for nothing else: this answers a
    // string, never a project, and no caller of it may treat its output as a bound. Deriving what a
    // pane serves from what the pane claims is what ISS-1050 criterion 7 refuses, and that refusal
    // is the whole reason this function exists in this shape.
    // cm:guard NO arm carries a number of seconds. The sentence this replaces promised thirty of
    // them on every path, and on the one measured in the field the promise could never come true —
    // a deadline the code does not enforce is worse than no deadline (ISS-1092 criterion 9).
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

    /// The pane name for a master session id, for the inbox's terminal arm.
    // cm:guard keyed by SESSION id, not project id. Core addresses a master by the `agent_sessions` row it registered, which is the only identity a `session.send` frame carries — a lookup by project would need core to know which project a session belongs to and to say so on the frame, and it does neither.
    pub fn pane_for_session(&self, session_id: &str) -> Option<String> {
        let reg = self.0.lock().expect("masters poisoned");
        reg.live
            .values()
            .find(|m| m.session_id == session_id)
            .map(|m| m.name.clone())
    }
}

/// Why a sweep is happening now, when it is not the timer.
// cm:guard a wake carries NO work — not an issue, not a token, not a decision. It says "look now", and the master then reads the queue through the same path the timer uses and decides for itself. A wake that carried the work would be a second dispatcher, and this box would hold two sources of truth about what to run with nothing reconciling them.
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

/// Keep every served project's master alive, on the timer OR on a wake.
///
/// The timer is the floor and the wake is the latency cut. Both call the same
/// `sweep`; there is no second path and no second dispatcher.
// cm:guard the TIMER MUST STAY, and this is the only place that says so on this side. Core's publish is fire-and-forget — `ws/rooms.ts:publish` skips any socket that is not OPEN and buffers nothing — so a wake sent while this box's websocket is down is gone with nothing recording that it happened. Deleting the timer here turns one dropped frame into work that sits forever with nothing reporting why; keeping it makes the same drop cost 30 seconds. The reconnect catch-up covers the same hole from the other end and is not a substitute for either.
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
    // cm:guard ONE memo for the box rather than one per project, because core's limit route fans out to every runner binding of the device — there is one Claude account here and therefore one thing to remember about it. It is deliberately in-process: a restart re-reads the conversations and re-decides, and core's own `limitReason` is what a clear is gated on, so nothing is lost by starting empty.
    let mut account_limit_said: Option<String> = None;
    // cm:guard a ledger that will not open is announced and the box keeps sweeping. It is the input to ONE decision — whether an idle master may leave — and a daemon that refused to dispatch over it would trade every project's work for a housekeeping question.
    let mut ledger = match Ledger::default_path().and_then(|p| Ledger::open(&p)) {
        Ok(l) => Some(l),
        Err(e) => {
            tracing::error!("[master] ledger unavailable ({e}) — no master will retire itself");
            None
        }
    };
    loop {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            Some(w) = wake.recv() => {
                let since = last_sweep.elapsed();
                if since < WAKE_FLOOR {
                    tokio::time::sleep(WAKE_FLOOR - since).await;
                }
                tracing::info!("[master] wake ({}) — sweeping now", w.describe());
                delay = sweep(&client, &cfg, &masters, &activity, &job_panes, job_records.as_ref(), &adopted, &mut ledger, &mut account_limit_said)
                    .await;
                last_sweep = Instant::now();
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Whether a project's runner row on this box still wants new work.
///
/// The drain an operator reaches for when moving a project onto another box:
/// set the runner `draining` (or `disabled`), and this box stops STARTING work
/// while everything already running finishes untouched.
// cm:guard only an EXPLICIT stop counts, and `offline` deliberately does not. That status is written by the heartbeat and lags a live box by up to its interval, so gating on `online` would have a box refuse its own work over a stale row. Two statuses mean an operator decided; every other value, known or added later, keeps working.
// cm:guard this is the ONLY thing that reads the status, and until 2026-09-05 nothing did: `/me/runners` returned it, `MeRunner` parsed it, and no code looked. `retire` and every status change were therefore silent no-ops against a box that kept claiming — measured on epodsystem while moving it off dev1. Core cannot enforce this instead: `pool.ts` joins `runners` on (project, device) with no status filter, and adding one there would hide work from a master rather than let the box decline it.
fn accepts_new_work(status: &str) -> bool {
    !matches!(status, "draining" | "disabled")
}

/// How long to wait before the next sweep, given what core just reported.
///
/// Fast by default; stretched only when EVERY project that would take work is
/// rate-limited, so one limited project never slows down a healthy one.
// cm:guard the stretch requires ALL of them, and `any` here would be a throughput bug rather than a pacing one: this box serves several projects, and one account hitting its window would idle the rest for five minutes at a time.
// cm:guard `Some(0)` counts as NOT limited. An expired stamp is the normal steady state, because core only clears the column on a successful job — treating a lapsed limit as live is how a backoff becomes permanent.
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

/// One look at every project this device serves.
// cm:guard the project list comes from `/me/runners`, NEVER from `config.toml` bindings. Core is the source of truth for what a device serves and for where the checkout lives (`resolve_repo` reads the local binding only as a fallback), and the two disagree in practice: dev1 serves epodsystem-core with no local binding for it at all, so a sweep driven by the config file would leave that project's pool unread forever with nothing reporting why.
async fn sweep(
    client: &CoreClient,
    cfg: &Config,
    masters: &Arc<Masters>,
    activity: &agent_activity::Activities,
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    ledger: &mut Option<Ledger>,
    account_limit_said: &mut Option<String>,
) -> Duration {
    let now_unix = master_limit::now_unix();
    let mut account_said: Vec<master_limit::Decisive> = Vec::new();
    let served = match runners::list_me(client).await {
        Ok(rs) => rs,
        Err(e) => {
            tracing::warn!("[master] cannot read this box's projects: {e}");
            // cm:guard the failure is RECORDED and not merely logged, because the refusal a master
            // gets on the control socket is the only place most of these are ever read. A box with
            // no answer must say it has no answer — reading "not in the set" off a network error
            // would tell a live master this box does not serve it (ISS-1092 criterion 6).
            masters.note_served(Served::Unreadable(e.to_string()));
            return POLL_INTERVAL;
        }
    };
    masters.note_served(Served::Read(
        served.iter().map(|r| r.project_id.clone()).collect(),
    ));
    // cm:guard the listing is AUTHORITATIVE here and only here — the `Err` arm
    // above returned rather than falling through, so this is never a defaulted
    // or partial set. It is the one place on the box that knows which projects
    // it serves, and therefore the only route a session config has off disk:
    // `sweep_stale` never touches them, because a live master stops rewriting
    // its file whenever core is unreachable.
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
            // cm:guard a drained project is recorded as unplaced even though a master may still be
            // running on it from before the drain. What the record answers is whether THIS sweep
            // would place one, which is what a refused declaration needs to know; the pane that is
            // already there is still supervised on the line below.
            masters.note_unplaced(
                &runner.project_id,
                Unplaced::Draining {
                    status: runner.status.clone(),
                },
            );
            // cm:guard a drained runner still gets `supervise`, and only the START of new work is skipped. A master already running on a project being moved off this box must still be watched and still have its row closed when it dies — a drain that stopped watching would leave a dead master's session live in core with nothing reporting why, which is the drain doing damage rather than nothing.
            supervise(client, masters, &runner.project_id, &runner.slug).await;
            continue;
        }
        supervise(client, masters, &runner.project_id, &runner.slug).await;
        take_pool_job(
            client,
            cfg,
            &served,
            job_panes,
            job_records,
            adopted,
            runner,
        )
        .await;

        // cm:guard an unreadable read is EMPTY, not fatal — this project goes quiet for a pass rather than the box going quiet on every project at once. It is now the ONLY thing that tells the daemon a project has work, so a failure here must cost one pass and never a master.
        let admissible = admissible::admissible(client, Some(&runner.project_id))
            .await
            .unwrap_or_default();
        // cm:guard NOTHING admissible starts no master, and that bound survives residency. A resident session is a `claude` process that lives until something ends it, and nothing counts it, so a box serving six projects would carry six permanent processes for however many of them never have work. A master that already exists is kept and still supervised; residency is for a project doing something, not for every row `/me/runners` returns.
        // cm:guard the bound is STARTING one, and it used to be written as skipping the rest of the
        // pass — which also skipped the `register` that keeps a live pane's session row beating, so
        // core reaped the row of a master that was running perfectly and the pane's capability was
        // orphaned for good. `Placement::AdoptOnly` is the same bound with the registration kept
        // (ISS-1092 criteria 10, 13).
        let placement = placement_for(&admissible);
        if placement == Placement::AdoptOnly {
            if retire_if_idle(client, masters, ledger, &runner.project_id, &runner.slug).await {
                continue;
            }
        } else {
            masters.note_work(&runner.project_id);
        }

        let resolved = match resolve_repo(&served, cfg, &runner.project_id) {
            Ok(r) => r,
            Err(slug) => {
                // cm:guard refuse by NAME rather than falling back to some other directory. A master started in the wrong tree reads one repo and claims work for another, and every diff it produces lands where nobody looks — the silent substitution this repo forbids, and unrecoverable by the time anyone notices.
                // cm:guard the ERROR keeps its condition — work waiting with nowhere to run it — and
                // the record is written either way. A project with no claimable work and no repo
                // path is not an emergency, but it is still the reason its master pane is not
                // there, and a pane asking why is owed it (ISS-1092 criterion 5).
                if !admissible.is_empty() {
                    tracing::error!(
                        "[master] {slug} has claimable work but no repo path on this box — no master will run for it; bind it or set the runner's repo_path"
                    );
                }
                say_unplaced(masters, &runner.project_id, &slug, Unplaced::NoRepoPath);
                continue;
            }
        };

        // cm:guard read into an OWNED `Option<String>` before the await below. `Ledger` wraps
        // `rusqlite` behind a `RefCell` and is not `Sync`, so a borrow held across `ensure_master`
        // makes this future non-`Send` and the `tokio::spawn` in `daemon/mod.rs` refuses it.
        let stored_conversation = ledger
            .as_ref()
            .and_then(|led| led.master_for_project(&runner.project_id).ok().flatten())
            .and_then(|row| row.conversation_id);
        // cm:guard built HERE, into owned rows, because `Ledger` is not `Sync` and a borrow held
        // across `ensure_master`'s awaits makes this future non-`Send`.
        let inherited: Vec<InheritedRun> = masters
            .get(&runner.project_id)
            .map(|(sid, _)| sid)
            .and_then(|sid| {
                ledger
                    .as_ref()
                    .map(|led| inherited_runs(led, &sid, &runner.project_id))
            })
            .unwrap_or_default();
        let pane = ensure_master(
            client,
            masters,
            &runner.project_id,
            &resolved,
            stored_conversation.as_deref(),
            &inherited,
            placement,
        )
        .await;
        if pane == PaneState::Absent {
            continue;
        }
        // cm:why collected here, on the path a project with a live pane takes, and NOT on the drained branch above. A drained runner starts no work, so a cap on it changes no dispatch decision — and reading it there would cost a `resolve_repo` and a ledger read on a path that exists to do less. The cost is stated rather than hidden: a box where EVERY project is drained reports no cap, and is also dispatching nothing. Since ISS-1092 this also runs for a project with a live pane and an empty pool, which is correct rather than incidental: that pane is a `claude` process spending the same account whether or not anything is claimable.
        if let Some(said) = account_verdict(
            &resolved.repo_path,
            stored_conversation.as_deref(),
            now_unix,
        ) {
            account_said.push(said);
        }
        // cm:guard the obligation is written by the RESUME, in the same pass that made it. A pane
        // resumed over runs its predecessor left is the one thing that makes a choice owed, and
        // marking anywhere else — on the declaration, on the sweep, on a timer — would either owe a
        // choice for a pane's own fresh work or owe none at all (ISS-1050 criterion 29).
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

        if admissible.is_empty() {
            continue;
        }

        // cm:guard read through the master's OWN session id, off the shared `Activities` the
        // control socket writes into — `run_exit` carries the same guard and for the same reason: a
        // second map here would answer `None` for every session forever, which `retry_owed` reads
        // as "never reported" and re-nudges on, so the fix would be inert, green, and
        // indistinguishable from working.
        let reported = masters
            .get(&runner.project_id)
            .and_then(|(session_id, _)| activity.get(&session_id));
        if masters.claim_nudge(
            &runner.project_id,
            work_digest(&admissible),
            reported.as_ref(),
        ) {
            nudge_master(masters, &runner.project_id, &resolved.slug).await;
        }
    }

    // cm:guard AFTER the project loop and never inside it, and that placement IS the decision. One account serves every pane on this box and core's route fans out to every binding of the device, so a report sent per project would let an older success on one delete the stamp a newer refusal on another had just written — with the winner decided by the order `/me/runners` happened to return the rows in.
    report_account_limit(client, &served, &account_said, account_limit_said, now_unix).await;

    // cm:guard BEFORE `give_back_lost_runs` and at the same brace depth, both deliberately. A run
    // declared this sweep has no core session yet, and `reconcile` reads a row with none as a run
    // that never started and closes the loop over it — so the row has to reach core first or a
    // master's freshly declared work is given back from under the subagent it was just handed to
    // (ISS-1050 criteria 5, 8).
    let boot = crate::runner::inflight::boot_identity().unwrap_or_default();
    let sessions = run_record::CoreSessions(client);
    let opened = run_record::open_declared_runs(&sessions, ledger, &boot).await;
    let closed = run_record::close_ended_runs(&sessions, ledger, &boot).await;
    // cm:guard AFTER `close_ended_runs` and BEFORE `give_back_lost_runs`, and both ends matter. A
    // run this sweep is about to close is not a held checkout yet, so reporting before the close
    // would name a hold that ends seconds later. Running before the release attempt is what makes
    // the report describe the state the release is about to refuse — and when the release succeeds
    // instead, the tree is gone and the next sweep finds nothing to report, which is the correct
    // silence (ISS-1050 criterion 33).
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

/// What this project's master's own conversation says about the account now.
///
/// `None` where the box has no conversation recorded for the pane yet, which is
/// every sweep between a cold start and that pane's first hook event.
// cm:guard the path comes from `conversation_transcript`, the SAME resolver `--resume` uses, and never from a second encoding of Claude Code's layout. Two copies of somebody else's on-disk convention drift apart in silence, and the half that rots is the one that runs less often.
fn account_verdict(
    repo: &std::path::Path,
    conversation: Option<&str>,
    now_unix: i64,
) -> Option<master_limit::Decisive> {
    let id = conversation.filter(|c| !c.is_empty())?;
    let path = conversation_transcript(repo, id)?;
    let tail = master_limit::read_tail(&path)?;
    master_limit::newest_decisive(&tail, now_unix)
}

/// Longest either half of a limit report may hold the sweep.
///
/// Derived rather than chosen: it has to be comfortably under [`POLL_INTERVAL`],
/// because a report that outlasts the sweep spacing has stopped being a report
/// and started being the thing that decides how often this box sweeps at all.
// cm:guard `CoreClient` wraps a bare `reqwest::Client::new()`, which sets NO request timeout, so a core that accepts the connection and never answers holds this await forever. That is not a report failing, it is the sweep stopping: everything after this call — `reconcile`, `give_back_lost_runs`, the next sweep, the cancel branch — is behind it. The guard one line below promises a failed report costs only a report, and without this bound that promise is false.
const REPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// One limit call, with the deadline the client itself does not impose.
// cm:why the elapsed case is folded into the SAME `Err` the transport already returns, rather than given an arm of its own: every caller's answer to both is identical — say so in the log, leave the memo alone, try again next sweep — and a third state would be a distinction no reader could act on.
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

/// Tell core what this box's Claude account said, once for the whole device.
// cm:guard this path reports and does NOTHING else. A cap is not a fault: it must not change a runner's status, must not end a master, must not touch an issue, and must not stop the sweep — work already running finishes and only the STARTING of new turns backs off, which the existing `next_poll_delay` does on its own once the row is stamped.
// cm:guard `core_limited` is read off core's own rows rather than off a memo, and the clear is authorised by nothing finer. One Claude account serves every pane, every job and every chat on this box — one `~/.claude`, one credential — so a master's successful turn is proof the account works whoever stamped the row, exactly as a successful JOB already clears a stamp the master lane wrote. Making the clear conditional on who stamped it would strand a box whose account an operator had just fixed, which is the one failure `LIMITED_POLL_INTERVAL` is a backoff rather than a blackout to avoid. The condition that ends this: per-project Claude credentials on one box, which would make "the account" ambiguous and this read wrong.
// cm:guard `now_unix` is the SWEEP's instant, taken once at the top and passed down, never re-read here. The verdicts were classified against it and the two freshness bounds are distances from it, so reading the clock a second time would judge those verdicts against an instant they were not measured from — and the gap is the whole project loop, network calls to core included.
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
                // cm:guard the memo is written ONLY on the Ok, and that is what makes the next sweep send the same refusal again. Recording it here would leave a cap core never heard, under a box that had stopped trying to tell it.
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

/// Take one pool job for this project, if there is one and this box has room.
///
/// The four kinds with no issue — `release_batch`, `smoke`, `reconcile`,
/// `verify_skill` — never reach a master: core mints them into the JOBS pool and
/// `pool_jobs` opens a pane per job here. Until ISS-1080 nothing read that pool
/// at all, and a release sat `queued` while its whole roster waited at
/// `releasing`.
// cm:guard the pool is read on every sweep of a runner that accepts work, INDEPENDENTLY of whether anything is admissible. The two sets do not overlap — `devices/pool.ts:readPool` serves the issue-less kinds and `admissible` serves issues — so gating this on a non-empty admissible set would leave a project whose only work is a release with its pool unread forever, which is the defect rather than the fix.
// cm:guard this deliberately does NOT feed `retire_if_idle`. A pool job runs in a pane of its own and needs no master, so counting the pool as work would keep a resident `claude` process up for something it does not do — against the residency bound one guard above, and against the ~$0.18-per-nudge spend that bound exists for.
// cm:guard the drained branch above returns before this call, so a runner core has taken off work claims nothing new here while a pane already open still finishes. That is the same split `supervise` makes, and for the same reason: a drain stops the START of work, never the watching of it.
async fn take_pool_job(
    client: &CoreClient,
    cfg: &Config,
    served: &[runners::MeRunner],
    job_panes: &Arc<JobPanes>,
    job_records: &dyn Records,
    adopted: &tokio::sync::watch::Receiver<bool>,
    runner: &runners::MeRunner,
) {
    // cm:guard nothing is claimed until adoption has run, and the reason is in `pool_jobs::adopt`: it reads what this box recorded and what it is running as two snapshots, and a claim landing between them looks to it exactly like a job whose pane died. Claiming first would make a fresh release the most likely thing this box reports dead.
    if !*adopted.borrow() {
        return;
    }
    let bound = cfg.runner.max_job_panes.max(1) as usize;
    // cm:guard the local binding is the FALLBACK only, exactly as the guard on the project list says: core's `repoPath` on the prepared job is the answer, and a box with no binding for a project core says it serves is a real configuration this fleet runs. `take_one` refuses by name when neither exists rather than opening a pane in the daemon's own directory.
    let fallback = resolve_repo(served, cfg, &runner.project_id)
        .ok()
        .map(|r| r.repo_path);
    let took = pool_jobs::take_one(
        &pool_jobs::CorePool { client, limit: 20 },
        &pool_jobs::TmuxPanes,
        &pool_jobs::CoreReport { client },
        job_records,
        job_panes,
        &runner.project_id,
        job_panes.session_id(),
        fallback.as_deref(),
        bound,
    )
    .await;
    if let pool_jobs::Took::AtBound = took {
        tracing::info!(
            "[master] {}: {} job pane(s) already open on this box (max_job_panes = {bound}) — taking no more this pass",
            runner.slug,
            job_panes.count()
        );
    }
}

/// What a sweep needs to take a run back: who this box serves (so a project's
/// repo can be resolved), and the two separate process questions.
// cm:guard `procs` and `killer` are DIFFERENT ports and merging them would be a category error with teeth: one answers "is this pid gone" where only a positive refutation may say yes, the other signals a process group. A single port would let a box that cannot ask about a pid still kill one.
struct Reclaim<'a> {
    served: &'a [runners::MeRunner],
    cfg: &'a Config,
    procs: &'a dyn recovery::ProcessLiveness,
    killer: &'a dyn terminate::ProcessGroup,
    closer: &'a dyn close_loop::RunCloser,
}

/// Give back the worktree a dead run still holds, so its close loop can finish.
// cm:why the deadlock this breaks, and why nothing already in the loop breaks it: `end_run` is reached only through `close.is_closed()`, that needs `worktree_gone`, that mark is set only by observing the tree gone, and the sole remover — the reap — refuses every tree whose run is `ended_by IS NULL`. Nothing lowers that for a session that ended outside `terminate`, so the run keeps its checkout and its leases forever (forge-vm 2026-09-10: 24 runs, 24 trees, the pool empty under them).
// cm:guard the release lives HERE rather than in `recovery` because it needs the project's repo path, and `resolve_repo` is the one reader of that: a repo derived from the worktree path instead would answer differently across a symlink or a bind mount than every other caller on this box, and the fleet's checkouts are bind-mounted.
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
    // cm:guard refuse by NAME and reclaim nothing when the repo is unknown, exactly as the dispatch half does. Releasing a tree through some other repo runs `git worktree remove` against a checkout that never owned it.
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
    match terminate::force_terminal(
        led,
        &r.run_id,
        terminate::Forcing {
            this_boot: boot_id,
            repo_root: &resolved.repo_path,
            base_branch: resolved.base_branch.as_deref(),
            by: "recovery",
            reason: "the run's process is gone and core's session row is terminal",
        },
        terminate::Ports {
            procs: world.killer,
            sessions,
            leases,
        },
    )
    .await
    {
        Ok(forced) => {
            tracing::info!(
                "[master] run {} reclaimed by {:?}: diff {:?}, close {:?}",
                r.run_id,
                forced.verb,
                forced.salvage.as_ref().map(|s| s.outcome),
                forced.close
            );
            forced.close.is_closed()
        }
        // cm:guard a refused release leaves the run exactly as it was and says so — `force_terminal` aborts before touching the tree when the diff could not be preserved, and an operator who reads "reclaimed" over that has lost the diff and does not know it yet.
        Err(e) => {
            tracing::warn!("[master] run {} could not be released: {e}", r.run_id);
            false
        }
    }
}

/// Tell core a run's process is gone, so its session stops being guessed at.
// cm:guard `Died` is the outcome, and `closeRunSession` returns this run's issues to the status they were claimed from on exactly that value — which is the point: the work stopped mid-turn, so leaving the issues at `in_progress` strands them behind a run nothing is doing (ISS-457 stood there 18 hours).
// cm:guard this sets NO local mark. `session_terminal` is still earned by `close_loop` reading core's row back on the next sweep, so a report whose response was dropped and one that never landed are indistinguishable here, as criterion 13 requires.
// cm:guard the checkpoint is built HERE, on the death report, because this is the case the evidence
// exists for: the run died mid-turn and its own testimony is whatever it managed to write before it
// stopped. A `Died` close that carried no reconstruction would leave the only copy of what the run
// left on a disk nobody reads (ISS-1050).
// cm:guard a run the ledger can no longer name still gets its close, carrying no checkpoint. The
// close is what stops core guessing at the session from silence, and trading that away for the
// evidence would leave the issues held for the full ten minutes to save a block nobody could have
// filled anyway.
// cm:guard the run row is looked up by the CALLER and handed in owned, never `&Ledger`. `Ledger`
// wraps a `rusqlite` connection behind a `RefCell` and is therefore not `Sync`, so a reference held
// across the `.await` below makes the whole master future non-`Send` and `tokio::spawn` refuses it
// — at the spawn site in `daemon/mod.rs`, hundreds of lines from the cause.
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

/// The box's own activity map, read as the run-liveness port.
// cm:guard reads the SHARED map the control socket writes into, never a copy. A second `Activities` here would answer `None` for every session forever, which `run_exit` reads as "never reported" — so every run would keep being beaten and the fix would be inert, green, and indistinguishable from working.
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
        })
    }
}

/// End a run that reported itself finished, so its close loop can start.
// cm:guard the process is signalled and NOTHING else is written here. The three marks are `close_loop`'s and each is set by reading the world back, so a kill that also stamped `session_terminal` would be this repo's one forbidden move — a box declaring an outcome core has not confirmed. The next sweep sees the pid refuted and takes the run through the same path a crashed run takes.
// cm:guard `&mut` and not `&`, though nothing here writes: the borrow is held across the kill, and `&Ledger` is `Send` only if `Ledger` is `Sync` — which rusqlite's `RefCell` connection is not, so the shared borrow makes the whole master loop's future non-`Send` and the daemon stops compiling at `tokio::spawn`.
// cm:guard the KILL happens first and the close is told afterwards, never the reverse. A close that lands over a pane the kill then fails to end leaves core reading `completed` while the agent is still writing to the worktree; this order's failure mode is the one this box already survives — the close does not land, and core's ten-minute sweep closes the row as it did before this verb existed.
// cm:guard the outcome is `KilledIdle` and NOT `Died`: this box decided to end a run whose work was finished, so returning its issues would undo whatever the last turn landed. `closeRunSession` keys the issue return off exactly this distinction.
async fn end_idle_run(led: &mut Ledger, run_id: &str, world: &Reclaim<'_>) {
    let Ok(Some(run)) = led.run(run_id) else {
        return;
    };
    let Some(pid) = run.pid else {
        return;
    };
    world.killer.kill(pid).await;
    tracing::info!(
        "[master] run {run_id} reported idle for over {}m and its work is done — ending pid {pid}; its close loop starts on the next sweep",
        run_exit::RUN_IDLE_BEFORE_EXIT.as_secs() / 60
    );
    let Some(session_id) = run.session_id.as_deref() else {
        return;
    };
    if let Err(e) = world
        .closer
        .close(
            session_id,
            close_loop::Outcome::KilledIdle,
            "idle past the run's exit boundary; the box ended it",
            Some(checkpoint::reconstruct_within_budget(&run).await.to_json()),
        )
        .await
    {
        tracing::warn!(
            "[master] run {run_id} was ended but core was not told why ({e}) — its session falls to the ten-minute sweep"
        );
    }
}

/// Beat what this box still holds, and close the loop on what it does not.
// cm:guard runs AFTER the per-project loop, and the order is the assertion. `ensure_master` re-registers every live master into `Masters` on each pass, and `PaneMasters` reads that map for the pane NAME — placed before the loop, a daemon restart would meet an empty map and read every live run on the box as orphaned (ISS-933 criterion 16).
// cm:guard the beat rides in this same call and is not separable: core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take back every healthy run on the box (ISS-933 criteria 16 and 25a).
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
    // cm:guard an unreadable boot id means NO reconcile, and that refusal is the safe direction. The boot is what separates "the master died within this boot" from "everything recorded before a reboot belongs to a stranger"; an empty one matches nothing recorded, so every live run on the box would read as orphaned and lose its worktree (ISS-933 criterion 16). Windows is not hypothetical here: `boot_identity` answers `None` there.
    if boot_id.is_empty() {
        tracing::warn!("[master] this box reports no boot id — leaving unclosed runs alone");
        return;
    }
    match recovery::reconcile(led, boot_id, live, world.procs, sessions, leases, watch).await {
        Ok(done) => {
            for r in done {
                // cm:guard answered FIRST and with a `continue`, because a run named for the idle exit has none of the other marks yet by construction — its process is still up, so `owed_release` is false and `is_closed` is false, and falling through to the report below would file a "partially closed" complaint about a run this sweep is in the middle of ending.
                if r.owed_idle_exit {
                    end_idle_run(led, &r.run_id, world).await;
                    continue;
                }
                // cm:guard reported BEFORE the release is attempted and WITHOUT a `continue`: `owed_release` needs `session_terminal`, core alone writes that mark, and until this report lands the only writer is core's ten-minute silence sweep — so every orphan on this box waited it out and landed in `runner_unreachable` whether or not the box was reachable (forge-vm 2026-09-12, ~95% of 203 sessions over 7 days on two projects). The release still waits for the next sweep to read the row back, which is criterion 13 and not a delay worth trading away.
                if r.owed_death_report {
                    report_run_death(led.run(&r.run_id).ok().flatten(), &r, world).await;
                }
                // cm:guard the release is attempted BEFORE the report and its result decides whether one is printed, because a run recovery just reclaimed is not a run an operator has anything to do about. Report first and every reclaimed run also files a complaint about the state it was reclaimed out of.
                if r.owed_release
                    && release_held_tree(led, &r, boot_id, world, sessions, leases).await
                {
                    continue;
                }
                if r.state.is_closed() {
                    continue;
                }
                // cm:guard say WHICH marks are missing, never "partially closed". A run holding two of three leases and one holding none are different operator problems, and a line that does not separate them is the report this whole loop exists to replace.
                tracing::warn!(
                    "[master] run {} is partially closed: session_terminal={} worktree_gone={} leases={}/{}",
                    r.run_id,
                    r.state.session_terminal,
                    r.state.worktree_gone,
                    r.state.leases_returned,
                    r.state.leases_total
                );
            }
        }
        Err(e) => tracing::warn!("[master] reconcile failed: {e}"),
    }
}

/// The master's own process, versioned with this binary.
// cm:guard the skill text ships INSIDE the runner and is written to the project checkout before every session starts. Nothing else delivers it — `skill_sync` seeds only what a project's manifest lists — and a master told to "use the forge-master skill" with nothing on disk loads nothing and improvises the one process this design depends on, silently. It SURVIVES `skill_sync`'s converge-on-delete only because `find_prunable` skips a directory with no `.hash` marker and this writes none; seed it through `write_skill_tree` and the next sync deletes it as an unmanifested skill. The price of embedding is real and is the trade: editing the master's process now needs a runner release, where a project skill needs only a push. The checkout copy is GENERATED OUTPUT and `.claude/` is ignored wholesale — an edit made there is overwritten by the next spawn.
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — that file is SOURCE for this binary, not local config, and it lives under `packages/runner/**` so ci.yml's `runner` path filter and check-runner-gates.mjs's own scope both reach it with no special case: a skill-only edit that skipped the runner job would ship an unbuilt master through a green `ci-passed`.
const MASTER_SKILL: &str = include_str!("../../assets/forge-master-skill.md");

/// Write the skill where the session about to start will look for it.
fn install_skill(repo: &std::path::Path) -> std::io::Result<()> {
    let dir = repo.join(".claude/skills/forge-master");
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), MASTER_SKILL)
}

/// Register the daemon's hooks for the session about to start, and say so.
// cm:guard the exe is read from `current_exe` and never hardcoded, because the hook command has to name a binary that will still be there: this box runs `forge-runner` out of `~/.local/bin`, an update replaces it in place, and a command naming anything else is a hook that fires into nothing.
fn install_hooks_logged(repo: &std::path::Path, slug: &str) {
    let Ok(exe) = std::env::current_exe() else {
        tracing::warn!("[master] {slug}: cannot name this binary — starting without hooks, so this session reports no turn boundaries");
        return;
    };
    match crate::daemon::hook_install::install(repo, &exe) {
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

/// Carry every recorded resume choice onto the issues its run holds.
///
/// Answers how many it said. Never fails: one core would not take is tried
/// again next sweep, because the obligation is still recorded.
// cm:guard the local mark is cleared only once core ANSWERED. Marking first would turn one
// unreachable minute into a decision that exists on this box and nowhere else, which is the exact
// silence this issue is about (ISS-1050 criterion 29).
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
        // cm:guard a run with no core session is SAID rather than skipped, and that is the whole of
        // the change here. This was a bare `continue`: a master's recorded choice about a run whose
        // subagent never started was dropped, every sweep, for the life of the boot, with nothing
        // logged — and "the pane died before the subagent was ever dispatched" is the commonest
        // thing a resumed master inherits, so it is the case that mattered most. The choice IS in
        // the ledger; what cannot happen is the report, because
        // `POST /api/devices/me/run-sessions/{session_id}/resume-choice` is keyed on a core session
        // this run never had. A route that is not session-keyed is core's to add, so the residual is
        // named here rather than guessed at (ISS-1050 criterion 29).
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

/// Every run still open under this master, as raw fields.
// cm:guard reads by MASTER SESSION and not by project alone: two projects' masters may be up on one
// box, and a pane handed another project's runs would be asked to judge work it has never seen.
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

/// One run a resumed pane inherited, as the fields the box can state and nothing else.
// cm:guard there is NO recommendation field and there will not be one. The box preserves, the
// kernel retracts what became false, and the MASTER decides whether work continues or restarts —
// a surface that handed over a pre-computed verdict would have moved that judgement into the box
// through a second door, which is the one thing this issue's owner ruled out (ISS-1050 criterion
// 28).
// cm:guard the fields are RAW and are not summarised, scored or ordered by anything but the
// ledger's own order. "3 commits ahead, tree dirty" is a fact; "probably worth restarting" is a
// verdict wearing a fact's clothes.
pub(crate) struct InheritedRun {
    pub run_id: String,
    pub issue_keys: Vec<String>,
    pub worktree_path: String,
    pub incarnation: &'static str,
    pub work: &'static str,
    pub agent_id: Option<String>,
    pub ended_by: Option<String>,
}

/// The block a resumed pane is handed: every run still open under it, raw.
// cm:guard says it was RESUMED in the first line (criterion 27). A pane cannot tell from inside
// whether it is new or continuing, and one that assumes it is new re-declares work already running.
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

/// What `ensure_master` did about this project's pane on this pass.
// cm:guard `Resumed` is distinguished from `ColdStarted` because only a resume creates an
// obligation: the runs the previous pane left are now this one's to answer for, and a cold start
// inherits a conversation it cannot read and therefore cannot be asked about (ISS-1050 criteria
// 27, 29).
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
}

/// Where Claude Code keeps the conversation for a directory, if it keeps one.
///
/// Answers the path it would be at, which may not exist.
// cm:guard this encodes Claude Code's OWN on-disk layout, which is not ours and carries no promise.
// Verified against claude 2.1.273 on forge-vm 2026-09-16: conversations live at
// `~/.claude/projects/<cwd with every `/` and `.` replaced by `-`>/<conversation-id>.jsonl`, e.g.
// `/home/forge/projects/apiflow/.worktrees/ISS-16` -> `-home-forge-projects-apiflow--worktrees-ISS-16`.
// cm:guard every failure direction here is COLD START, never a resume. If this layout changes, the
// file stops being found, `resume_for` answers `None`, and every master cold-starts while saying
// which conversation and which path it could not reach — noisy and recoverable. The other direction
// would pass `--resume` for a conversation that is not there, which kills the pane on spawn and
// leaves the next sweep to rebuild and kill it again, with no line naming anything (ISS-1050
// criterion 18).
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

/// The conversation this project's pane should be resumed from, if this box can
/// actually reach it.
///
/// Says so in the log when it cannot, naming the conversation and the path.
// cm:guard takes the id OWNED and does no ledger read of its own, because `Ledger` is not `Sync`:
// a `&Ledger` held across the `.await` in `ensure_master` makes the master future non-`Send` and
// `tokio::spawn` refuses it. The caller reads the row into a `String` before any await.
pub(crate) fn resume_for(
    slug: &str,
    repo: &std::path::Path,
    stored: Option<&str>,
) -> Option<String> {
    let id = stored.filter(|s| !s.is_empty())?;
    let path = conversation_transcript(repo, id)?;
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

/// Where a project's master keeps what only it can say.
// cm:guard per PROJECT, never one file for the box. Masters on two projects run at the same time by design, and a single log would interleave two sessions into a transcript that reads as one confused master.
// cm:guard APPEND, and the filename says so. This used to be `last-pass.log`, truncated on every spawn — measured 2026-09-05, the master's account of why it claimed ISS-917 was gone three minutes later, overwritten by the ISS-918 pass. B5 is that fix: a pane piped with `>>` into one file per project, so the judgement layer this design calls its entire value outlives the pass that produced it.
fn transcript_path(slug: &str) -> Option<std::path::PathBuf> {
    let dir = Config::path().ok()?.with_file_name("master").join(slug);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("transcript.log"))
}

/// This project's declared MCP servers, resolved by core, or `None` when the
/// box could not ask.
///
/// A failure is NOT fatal and is NOT silent: the box carries on and starts a
/// master with no project servers, having said which project lost them and
/// why. Refusing to start over this would take the reader off the box along
/// with the tools.
// cm:guard `None` and an EMPTY result are different answers and the type is what keeps them apart. "Core said this project declares nothing" is a fact two callers act on — one tells an operator to kill a live pane, the other removes the pane's config file — and a failed fetch flattened into `default()` would make a five-second core blip order an operator to end a correctly configured master. The log line alone cannot stop that, because neither caller reads logs.
async fn project_mcp_servers(
    client: &CoreClient,
    project_id: &str,
    slug: &str,
) -> Option<mcp_servers::ProjectMcpServers> {
    match mcp_servers::fetch(client, project_id).await {
        Ok(found) => Some(found),
        Err(e) => {
            tracing::error!(
                "[master] {slug}: could not read this project's declared MCP servers from core: {e} — any master started now has NONE of them, whatever the project declares"
            );
            None
        }
    }
}

/// Whether this box can honestly describe what it is about to hand a pane.
#[derive(Debug, PartialEq, Eq)]
enum LaunchRecord {
    /// The file on disk says exactly what the pane will be given.
    Truthful,
    /// The config could not be written, but the record now says the pane gets
    /// nothing — which is what will happen.
    NoneAndSaysSo,
    /// A record of OTHER servers survives that the pane will not carry.
    Lying,
}

/// The launch decision, separated from the filesystem and the log so the one
/// state that must refuse can be asserted.
// cm:guard `Lying` is the ONLY refusal and it must stay the only one. `NoneAndSaysSo` has to start: a box whose MCP directory went read-only would otherwise lose every master on it, including for the projects that declare no servers and lose nothing, and the master is the one reader who could report the problem. `Lying` must not start: `session_matches` reads that surviving file as proof the live pane carries those servers, so the stale-pane report criterion 5 exists for goes silent for the whole life of the pane — and a pane cannot be told a new config, so nothing recovers it but an operator who was never told.
fn launch_record(wrote: bool, cleared: bool) -> LaunchRecord {
    match (wrote, cleared) {
        (true, _) => LaunchRecord::Truthful,
        (false, true) => LaunchRecord::NoneAndSaysSo,
        (false, false) => LaunchRecord::Lying,
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

/// The whole decision, separated from the filesystem and the log so the one
/// case that costs a live master can be asserted.
// cm:guard `Unknown` must never collapse into `Stale`. The report `Stale` prints is an instruction to `tmux kill-session` a running master, and a box that could not reach core for five seconds knows nothing about what the pane is missing — a version answering `Stale` there would end a correctly configured master, mid-pass, on every core blip.
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

/// Say, once, that a pane already running does not carry what core now resolves.
///
/// A pane reads `--mcp-config` at startup and can never be told a new one, and
/// this daemon does not kill a live master to re-spawn it: a pass in flight is
/// worth more than a same-sweep correction. So the answer is a line an operator
/// can act on, repeated only when what it says changes.
// cm:guard REPORT, never kill. `ensure_master` runs every sweep, so a version that restarted a mismatched pane would end a master mid-turn every time a project's declaration changed — and once, unrecoverably, for every pane on the box the first time this shipped.
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
        "[master] {slug}: the resident session {name} was started before this project's MCP servers were resolved, or before they last changed, so its runs do NOT have {}. A pane cannot be told a new MCP config — end it with `tmux kill-session -t {name}` and the next sweep starts one that carries them.",
        if declared.resolved_names.is_empty() {
            "the servers it now declares".to_string()
        } else {
            declared.resolved_names.join(", ")
        }
    );
}

/// How far this sweep may go for one project.
// cm:guard `AdoptOnly` is what keeps `NOTHING admissible starts no master` true while still
// registering a pane that already exists. Registering is not starting: the pane is there either
// way, and the call is what keeps core's row for it beating. Skipping the whole of `ensure_master`
// for a quiet project is what let core reap a live master's session row after a daemon restart, so
// that when work returned `register` minted a SECOND row and the running pane's capability named
// the dead one for good (ISS-1092, measured on forge-vm 2026-09-17).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Adopt a live pane, and start one where there is none.
    AdoptOrStart,
    /// Adopt a live pane, and start nothing.
    AdoptOnly,
}

/// How far this sweep may go for a project, from what its pool holds.
// cm:guard an empty pool answers `AdoptOnly` and never "skip this project". The two were the same
// thing until ISS-1092, and the difference is the `register` call that keeps a live pane's core
// session row beating: skipping it let core reap the row of a master that was running perfectly.
pub(crate) fn placement_for(admissible: &[AdmissibleIssue]) -> Placement {
    if admissible.is_empty() {
        Placement::AdoptOnly
    } else {
        Placement::AdoptOrStart
    }
}

/// Make sure this project has a live, registered master, and return its id.
// cm:guard register with core on EVERY sweep, not only when the pane is created. The row is what `jobs.held_by` carries, so a cached id would keep claiming onto a session core had already reaped — holds nobody can see, under an identity nobody is beating for. `ensureMasterSession` is idempotent precisely so this can be unconditional.
async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::daemon::dispatch::Resolved,
    stored_conversation: Option<&str>,
    inherited: &[InheritedRun],
    placement: Placement,
) -> PaneState {
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    // cm:guard refuse by name when tmux is missing rather than falling back to the per-pass `claude -p` this replaced. A box that quietly reverted would look identical in the log to one that is working, while none of the liveness, the transcript or the addressable pane exist on it.
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        say_unplaced(masters, project_id, &resolved.slug, Unplaced::NoTerminal);
        return PaneState::Absent;
    }

    // cm:guard the liveness question comes BEFORE the registration on this branch and only on this
    // branch. `register` creates a row where none is live, so asking core first under `AdoptOnly`
    // would open a master session for a project this sweep is about to start no master for.
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

    let asked = project_mcp_servers(client, project_id, &resolved.slug).await;
    // cm:guard an unreadable answer is NOT "declares nothing". The pane is still
    // given nothing — the box has nothing to give it — but the file on disk is
    // made to say so, and the master is told, so the silence ISS-1043 was filed
    // from cannot come back wearing a core outage.
    let declared = asked.clone().unwrap_or_default();

    if terminal::alive(&name).await {
        report_stale_pane_config(masters, project_id, &name, &resolved.slug, asked.as_ref());
        if masters.get(project_id).is_none() {
            // cm:guard adopt a pane this daemon did not create rather than killing it. The master survives a `forge-runner` restart by design, and a daemon that started by clearing what it does not remember would make every deploy an outage for every project on the box.
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            // cm:guard `created` while the pane is ALIVE is core saying it found no live row to
            // reuse — `ensureMasterSession` reuses only a non-terminal one — so the pane running
            // here holds a capability minted for a session core has since failed, and every frame
            // it sends is refused for the rest of its life. Say it at error, because the only
            // recovery is ending the pane and nothing on this box will do that on its own
            // (ISS-1092 criteria 17, 18).
            if session.created {
                tracing::error!(
                    "[master] {}: adopted the resident session {name} onto a master session core created fresh ({}) — whatever capability that pane was started with names a session this box no longer holds, so its declarations are refused until it is replaced. A pane cannot be handed a new capability: `tmux kill-session -t {name}` and the next sweep starts one that carries the current session.",
                    resolved.slug,
                    session.session_id
                );
            }
            remember(masters, project_id, &session);
        }
        masters.clear_unplaced(project_id);
        return PaneState::Adopted;
    }

    // cm:guard the SECOND adopt-only return, and it is not the first one repeated. The first is an
    // optimisation — it avoids asking core for a session this sweep will not use. This one is the
    // bound: the pane was alive at that check and is not alive at this one, which is a pane that
    // exited while `register` and `project_mcp_servers` were awaited, and without this the code
    // falls straight through into minting a capability and starting a master for a project with
    // nothing claimable. Found by review of ISS-1092 (F1), not by a failing sweep.
    if placement == Placement::AdoptOnly {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    // cm:guard refuse to start when the skill cannot be written, rather than starting without it. A master with no skill still starts, still claims, and runs the whole orchestration off a four-line prompt — work that looks like it is being managed and is not.
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

    // cm:guard hooks are installed but a failure does NOT stop the master, and the asymmetry with the skill above is deliberate: a master with no skill improvises the whole process, while a master with no hooks is exactly what every box ran before this channel existed — blind, and working. Trading the pass for the telemetry would be the wrong way round.
    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    // cm:guard the pane is the ONE session this runner opens on a TTY, and a TTY is the only place Claude Code shows the workspace-trust prompt. An unanswered prompt is a session that ends without doing anything and takes the breaker above with it, so the stamp belongs immediately before the spawn — `workspace::provision` covers a fresh box, this covers every box provisioned before it shipped (ISS-928, forge-vm 2026-09-06).
    crate::workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    // cm:guard mint on the SPAWN path only, never on the adopt path above. A pane carries its capability in its environment and cannot be told a new one, so re-minting for a master this daemon merely adopted would refuse every frame that master sends for the rest of its life (ISS-964 criterion 29).
    let mut env = terminal::pane_env();
    match session_tokens::default_path().map(session_tokens::SessionTokens::at) {
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
    let mcp_config = match crate::mcp::config::write_session(&resolved.slug, &declared.mcp_servers)
    {
        Ok(path) => path,
        Err(e) => {
            // cm:guard start ANYWAY and say so. A master that refused to exist over its MCP config would take out every project on a box whose config directory went read-only, including the ones that declare no servers at all — and the master is the one reader who could report the problem.
            // cm:guard clear the file in the same breath, and REFUSE this one spawn when the clear also fails. Starting is right when the record can be made to say "this pane was given nothing" — a box whose config directory went read-only keeps its masters, and the master is the one reader who could report the problem. It is wrong when a record of OTHER servers survives: `session_matches` would later read an identical declaration as a match and go permanently silent on a pane that has none of them, which is criterion 5 failing in exactly the direction it exists to catch. The refusal is narrow by construction — `clear_session` answers Ok when there is no file, so every project with no previous record, including every project that declares no servers, still starts.
            let cleared = crate::mcp::config::clear_session(&resolved.slug);
            tracing::error!(
                "[master] {}: could not write the pane's MCP config: {e} — {}",
                resolved.slug,
                if cleared.is_ok() {
                    format!(
                        "starting WITHOUT the project's declared servers ({})",
                        declared.resolved_names.join(", ")
                    )
                } else {
                    "and the previous config could not be removed either".to_string()
                }
            );
            if let (LaunchRecord::Lying, Err(ce)) =
                (launch_record(false, cleared.is_ok()), &cleared)
            {
                tracing::error!(
                    "[master] {}: refusing to start a master this box could not describe: {ce} — a pane started now would carry none of this project's servers while the file on disk still claims it carries them, so no later sweep could report it. Make {} writable and the next sweep starts one.",
                    resolved.slug,
                    crate::mcp::config::session_dir().display()
                );
                return PaneState::Absent;
            }
            None
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
    // cm:guard resolved on the SPAWN path only. A pane this daemon adopted is already running its
    // own conversation and returned above; deciding a resume for it would be deciding for a pane
    // that cannot be told anything (ISS-1050 criterion 17).
    let resume = resume_for(&resolved.slug, &resolved.repo_path, stored_conversation);
    match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(mcp_config.as_deref(), resume.as_deref()),
        &env,
        transcript.as_deref(),
    )
    .await
    {
        Ok(_) => {}
        Err(e) => {
            tracing::error!("[master] {}: could not start {name}: {e}", resolved.slug);
            return PaneState::Absent;
        }
    }
    tracing::info!(
        "[master] {}: resident session {name} {} in {} — `tmux attach -t {name}` to watch it",
        resolved.slug,
        match resume.as_deref() {
            Some(id) => format!("resumed from conversation {id}"),
            None => "cold-started".to_string(),
        },
        resolved.repo_path.display()
    );
    remember(masters, project_id, &session);
    masters.clear_unplaced(project_id);

    // cm:guard the standing brief is typed ONCE, into a pane that has just started, and the wait inside `brief_new_pane` is not decoration — the next sweep would otherwise prompt a master that was never briefed.
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &declared.dropped_names,
        asked.is_none(),
    );
    // cm:guard the resumed block is APPENDED to the standing brief rather than replacing it. A
    // resumed pane still needs the base branch, the policy and the MCP warnings; a pane told only
    // what it inherited would decide three runs' fates and then work the project blind.
    let brief = match resume.as_deref() {
        Some(conv) => format!("{brief}{}", resumed_brief(conv, inherited)),
        None => brief,
    };
    if let Err(e) = terminal::brief_new_pane(&name, &brief).await {
        tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug);
    }
    match resume {
        Some(_) => PaneState::Resumed,
        None => PaneState::ColdStarted,
    }
}

/// Record why this project's pane was not placed, and say it once.
// cm:guard the log is gated on the reason CHANGING and never on the sweep. This is reached on every
// sweep of every project that has no pane — on a box serving 28 projects that is thousands of lines
// a day, and a reader who learns to scroll past them misses the one where a live pane went unplaced
// (ISS-1092 criteria 15, 16).
fn say_unplaced(masters: &Arc<Masters>, project_id: &str, slug: &str, why: Unplaced) {
    if masters.note_unplaced(project_id, why.clone()) {
        tracing::warn!("[master] {slug}: no master pane placed — {why}");
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

/// The whole of one pass prompt: go, and who you are.
// cm:guard the queue is NOT embedded here, and that absence is what let the quiet gate go. Dispatch reads it itself with its own ranking verb, so a snapshot typed at the master is a second copy already stale by the time the turn reaches it — and a prompt that queued behind a turn then acted on that copy is exactly what the deleted quiet gate existed to prevent (ISS-933 criterion 17).
// cm:edge contract -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — the skill hands every pass to `forge:dispatch`, and this prompt is what must not contradict it by naming a phase, a width or a queue of its own (ISS-964 criterion 29).
fn nudge() -> String {
    "Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.".into()
}

/// Tell a master there is something to look at.
// cm:guard nothing gates this on the master LOOKING idle. Residency used to be policed from outside — transcript growth read as liveness, a quiet window before prompting, a ceiling that killed — and every one of those inferred a process state from a pane's byte count (ISS-933 criteria 17 and 18). `claim_nudge` is NOT that gate and must not become it. What it reads is the admissible WORK's identity, and — since ISS-1100, and only to decide whether to REPEAT a nudge for work it has already sent — what the master's own hooks reported through `forge-runner hook`. The pane is still never read: a `UserPromptSubmit` frame is the agent saying a turn began, which is the one thing a screen could never tell anybody, and it is why `agent_activity` exists at all.
// cm:guard an extra nudge costs a full agent pass, NOT a line in a composer — ~$0.18 measured on forge-vm 2026-09-08, where 1,354 unconditional nudges over 95 minutes bought 0 claims and $245. That is why the caller gates on `claim_nudge`; a new call site that skips it reinstates a spend proportional to sweeps.
async fn nudge_master(masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: admissible work — nudging {name}");
    if let Err(e) = terminal::send_line(&name, &nudge()).await {
        tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
    }
}

/// The dead-master detector, re-homed from the control socket to the pane.
///
/// B3: the daemon is no longer the master's parent, so a dead master drops no
/// socket. What it does do is stop existing as a tmux session, and this is the
/// thing that notices — one sweep, not the three minutes core's reaper costs.
// cm:guard this closes the ROW on the fast path, one sweep instead of the three minutes core's reaper costs. There is nothing to release alongside it any more — a master's runs are subagents of its own process and their leases lapse with the pane — so a caller tempted to add a release here is reaching for a hold this box no longer takes.
async fn supervise(client: &CoreClient, masters: &Arc<Masters>, project_id: &str, slug: &str) {
    let Some((session_id, name)) = masters.get(project_id) else {
        return;
    };

    if !terminal::alive(&name).await {
        tracing::warn!("[master] {slug}: resident session {name} is gone — closing its row");
        end_master(
            client,
            masters,
            project_id,
            &session_id,
            "terminal session vanished",
        )
        .await;
    }
}

/// Let an idle master go, if the ledger says its children are done.
// cm:guard both halves are asked EVERY time, and the ledger read is not skipped when nothing is admissible. No admissible work is the idle half already — reading the children is the half that is easy to drop, and dropping it is what abandons a run's close loop to core's ten-minute reaper.
async fn retire_if_idle(
    client: &CoreClient,
    masters: &Arc<Masters>,
    ledger: &mut Option<Ledger>,
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
            let _ = terminal::kill(&name).await;
            end_master(
                client,
                masters,
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
    project_id: &str,
    session_id: &str,
    reason: &str,
) {
    if let Err(e) = master_api::close(client, session_id, reason).await {
        tracing::warn!("[master] could not close session {session_id}: {e}");
    }
    // cm:guard the capability dies with the session it names. A token left in the map outlives the master and is a live way onto the socket held by whatever can still read the pane's environment — a dead master's tmux buffer among them (ISS-964 criterion 29).
    if let Some(store) = session_tokens::default_path().map(session_tokens::SessionTokens::at) {
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
            .find("if admissible.is_empty()")
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

    /// The claim is bounded by the box's own number and by nothing core said.
    // cm:guard core has NO capacity signal and must not grow one: `runner_full` was a hold nothing enforced and was removed on 2026-09-05. This asserts the bound is read from config here, which is what makes the box the only place that knows it.
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

    // cm:guard the seconds are taken off the WIRE fixture rather than typed here, which is what makes this the far end of one chain: the captured refusal produced that number, core stores it as an instant, `/me/runners` hands it back as seconds, and this is where it becomes the backoff. A literal would assert `next_poll_delay`'s arithmetic and nothing about the report.
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

    // cm:guard the wake floor must stay BELOW the poll interval, or a wake is strictly worse than doing nothing: core publishes to cut the latency from an issue arriving to a box looking, and a floor at or above `POLL_INTERVAL` would make every wake wait longer than the timer it was meant to beat.
    #[test]
    fn a_wake_cuts_latency_rather_than_adding_it() {
        assert!(WAKE_FLOOR < POLL_INTERVAL);
    }

    // cm:guard capacity ONE is the coalescing, and this is the assertion that fails if someone widens the channel to "not lose any". Widening it queues one sweep per arriving issue, and every sweep after the first re-reads a pool the first already covered — five promoted drafts would cost five `/me/runners` reads plus five pool reads per project to learn nothing new.
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

    // cm:guard the operator has to be able to tell which trigger fired, because a box waking only on reconnect is one whose `master.wake` frames are being dropped somewhere — a fault with no other symptom, since the timer keeps the work moving.
    #[test]
    fn a_wake_says_which_trigger_fired() {
        assert!(Wake::Core {
            project_id: Some("forge-dev".into())
        }
        .describe()
        .contains("forge-dev"));
        assert!(Wake::Reconnect.describe().contains("catch-up"));
    }

    // cm:guard this is the test that has to fail if anyone turns the backoff into a skip. A limited fleet must still be swept, because core clears the limit only on a job that SUCCEEDS — the delay may grow, but it is bounded and the sweep always happens.
    #[test]
    fn a_limited_fleet_is_slowed_down_and_never_stopped() {
        let d = next_poll_delay(&served(&[("online", Some(3600))]));
        assert!(d > POLL_INTERVAL, "a limited fleet should back off");
        assert!(
            d <= LIMITED_POLL_INTERVAL,
            "the backoff must stay bounded: {d:?}"
        );
    }

    // cm:guard one limited project must not slow down a healthy sibling — this box serves several, and `any` in place of `all` would idle the rest five minutes at a time.
    #[test]
    fn one_limited_project_does_not_slow_a_healthy_one() {
        let mixed = served(&[("online", Some(3600)), ("online", None)]);
        assert_eq!(next_poll_delay(&mixed), POLL_INTERVAL);
    }

    // cm:guard an EXPIRED stamp is the normal steady state, not a live limit: core clears the column only on a successful job, so reading a lapsed limit as live turns the backoff permanent.
    #[test]
    fn an_expired_limit_polls_at_full_speed() {
        assert_eq!(
            next_poll_delay(&served(&[("online", Some(0))])),
            POLL_INTERVAL
        );
    }

    // cm:guard an older core sends no field at all, and absent must mean "poll normally" — the permissive direction, opposite to `kind`. A cautious default here would idle every box talking to a core that predates the field.
    #[test]
    fn a_core_that_does_not_report_limits_polls_at_full_speed() {
        assert_eq!(next_poll_delay(&served(&[("online", None)])), POLL_INTERVAL);
    }

    // cm:guard a drained runner must not hold the whole box at full speed, nor drag it into a backoff: it is not a candidate for work at all, so it is excluded before the decision.
    #[test]
    fn a_drained_runner_is_not_counted_either_way() {
        let mix = served(&[("draining", None), ("online", Some(3600))]);
        assert!(next_poll_delay(&mix) > POLL_INTERVAL);
    }

    // cm:guard the registry is per PROJECT, and the second assertion is the whole test: a box-wide flag would leave every project after the first unserved for as long as any one master lived.
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

    /// Criterion 5, the half that decides how often it is said. The comparison
    /// itself lives in `mcp::config::session_matches` and is tested there; this
    /// is the gate that keeps a true report from becoming a line every sweep.
    // cm:guard a pane this process did NOT start must report. `ensure_master` adopts panes across a daemon restart, and those are exactly the panes most likely to predate their project's declaration — a version reading an absent registry entry as "already said" would go permanently silent on the only case the criterion is about.
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

    // cm:guard the policy must arrive VERBATIM and this asserts exactly that. A master briefed with a summary of the owner's instruction is a master following the summariser, and the whole failure ISS-929 fixes is an instruction that reached the pane wrong or not at all.
    // cm:edge contract -> packages/runner/crates/forge-runner-core/assets/forge-master-skill.md — `forge record decision` is the plugin's verb, not this binary's, and the skill is the only place a master is told it exists: dispatch names no recording verb, so dropping it here leaves the decided/asked ratio with a denominator of zero (ISS-964 criteria 1, 2).
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

    /// Criterion 34. The skill quotes the refusal a master will actually meet,
    /// and the quote is taken from the refusal itself so the two cannot drift.
    // cm:guard the substring is DERIVED from `dispatch_gate::REFUSAL` rather than written out here. A quoted sentence typed into this test is a third copy of the same text, and this whole issue is about what happens when one copy of something moves and another does not.
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

    /// Criteria 35, 36. No flag list in a file released on another clock.
    // cm:guard the check is for the FLAG SYNTAX and not for the verb names, which a master must know exist. `--project`, `--issue` and `--worktree` were spelled out in this file while the CLI that serves them ships separately; that is the drift the issue names, and `-h` is the surface that cannot have it.
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
        let brief = standing_prompt("forge-dev", Some("main"), Some(policy), &[], false);
        assert!(
            brief.contains(policy),
            "the policy must be spliced whole: {brief}"
        );
        assert!(
            brief.contains("OUTRANKS"),
            "the brief must say the policy beats the skill's defaults: {brief}"
        );
    }

    /// The whole of the standing brief for a project that has set nothing.
    ///
    /// Everything a master needs to know that is NOT in the skill file, and
    /// nothing else. A sentence added here — however true, however well meant —
    /// fails this test, which is the point: ISS-1080 added its sentence to the
    /// skill and left this string saying the opposite, and nothing compared them.
    // cm:guard a GOLDEN TEXT and not a vocabulary check, because the failure it has to catch is a paraphrase. "There is no second terminal" and "the pool on this box is not a thing you use" carry the same wrong claim and share no word; only asserting the whole string catches both. The vocabulary check below is a second layer over the same text, never the first.
    const STANDING_BRIEF: &str = "Use the `forge-master` skill. You are the resident master for project `forge-dev` on this box, and you will be woken again in this same session rather than started fresh.\n\nYou are standing in this project's checkout, on its base branch `main`.\n";

    #[test]
    fn the_standing_brief_is_only_what_a_wave_cannot_know() {
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false);
        assert_eq!(
            brief, STANDING_BRIEF,
            "the standing brief may say only what the skill cannot: which project, which box, \
             which branch. Every rule about how a run works belongs in forge-master-skill.md, and \
             a copy here is the pair ISS-1080 broke"
        );
    }

    /// Criteria 29, 30. The two claims that were false on every box, named.
    // cm:guard these two are asserted BY NAME on top of the golden text, because they are the specific damage: a master reading either did not declare, and a reader six months from now needs the sentences spelled out to know what this test is defending.
    #[test]
    fn the_brief_no_longer_carries_the_two_claims_that_stopped_masters_declaring() {
        let brief = standing_prompt("forge-dev", Some("main"), None, &[], false);
        assert!(
            !brief.contains("no job pool") && !brief.contains("second terminal"),
            "the job pool and its second terminal came back with ISS-1080 and are on every box: {brief}"
        );
        assert!(
            !brief.contains("whole record of a run"),
            "the lease stopped being the whole record on 2026-09-13; a master told otherwise does not declare: {brief}"
        );
    }

    /// Criterion 31. The mechanism the skill owns is named in the skill and nowhere else.
    // cm:guard PHRASES and not bare words, which is the difference between a check and a nuisance: the brief legitimately says a project "declares MCP server(s)", a different sense of the same verb, and a list holding `declare` would refuse that true sentence while catching nothing a paraphrase could not slip past anyway. The golden text above is the defence; this layer names the specific vocabulary whose appearance here has already cost the fleet once.
    // cm:guard run over the brief WITHOUT the owner's policy, and that exclusion is not a loophole: the policy is the project owner speaking and is spliced verbatim by contract, so a check over it would refuse an owner who wrote "declare every run" in their own instruction.
    #[test]
    fn the_brief_states_no_rule_the_skill_file_owns() {
        let brief = standing_prompt(
            "forge-dev",
            Some("main"),
            None,
            &["playwright".into()],
            true,
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
        let brief = standing_prompt("forge-dev", Some("main"), Some(policy), &[], false);
        assert!(
            brief.contains(policy),
            "the owner is a courier's cargo, not this box's prose to police: {brief}"
        );
    }

    /// F1. The one launch state that refuses, and the two that must not.
    // cm:guard `NoneAndSaysSo` starting is half the assertion, and it is the half a defensive rewrite loses first: refusing whenever the config write failed takes out every master on a box with a read-only MCP directory, including the projects that declare no servers and would have been correct with nothing.
    #[test]
    fn only_a_record_that_would_lie_about_a_pane_refuses_the_spawn() {
        assert_eq!(launch_record(true, false), LaunchRecord::Truthful);
        assert_eq!(launch_record(true, true), LaunchRecord::Truthful);
        assert_eq!(launch_record(false, true), LaunchRecord::NoneAndSaysSo);
        assert_eq!(launch_record(false, false), LaunchRecord::Lying);

        // and only `Lying` is the refusal.
        for (wrote, cleared) in [(true, true), (true, false), (false, true)] {
            assert_ne!(
                launch_record(wrote, cleared),
                LaunchRecord::Lying,
                "wrote={wrote} cleared={cleared} must still start a master"
            );
        }
    }

    /// The three verdicts, and the one that must NOT be the kill instruction.
    // cm:guard the `Unknown` case is the whole of this test. `Stale` prints `tmux kill-session` at an operator, and the answer that reaches it after a failed fetch used to be an empty `ProjectMcpServers` — indistinguishable from a project that declares nothing, which on a box holding a config file from a live master reads as a mismatch and orders that master ended.
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

    // cm:guard a project whose servers core COULD be read must not carry the unreadable sentence, and the unreadable one must not borrow the dropped-names sentence. These are the two ways the fix for the flattened fetch goes silently wrong: one tells every master on the fleet its tools may be missing, the other leaves a master on a blipped box believing its empty pane is what the project asked for.
    #[test]
    fn a_box_that_could_not_read_the_declaration_says_so_in_its_own_words() {
        let unreadable = standing_prompt("mowment", Some("main"), None, &[], true);
        assert!(
            unreadable.contains("could NOT read this project's declared MCP servers"),
            "{unreadable}"
        );
        assert!(
            !unreadable.contains("could NOT supply"),
            "an unreadable declaration must not be reported as a named shortfall: {unreadable}"
        );

        let readable = standing_prompt("mowment", Some("main"), None, &[], false);
        assert!(
            !readable.contains("could NOT read"),
            "a project core answered for must be told nothing about readability: {readable}"
        );
    }

    // cm:guard name the SERVERS, not a count. The master's next act is deciding whether an issue can be built here, and "1 server unavailable" is not something it can weigh against an issue that needs the storefront.
    #[test]
    fn a_declared_server_this_box_cannot_supply_is_named_in_the_brief() {
        let dropped = vec!["epodsystem".to_string(), "postman".to_string()];
        let brief = standing_prompt("mowment", Some("main"), None, &dropped, false);
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

    // cm:guard criterion 29's second half: the choice has to reach the ISSUE, not just the ledger.
    // A decision recorded on one box and nowhere a human reads is the silence this whole issue is
    // about, one level up.
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

    // cm:guard said ONCE. The sweep runs every thirty seconds and the obligation is cleared only
    // after core answered, so a decision must not become a comment a minute forever.
    #[tokio::test]
    async fn a_choice_core_has_taken_is_not_said_again() {
        let mut led = a_run_that_chose("leave", "somebody else's to settle");
        let spy = ChoiceSpy::default();

        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 1);
        assert_eq!(say_resume_choices(&spy, &mut led, "boot-a").await, 0);

        assert_eq!(spy.seen.lock().unwrap().len(), 1, "one report, one comment");
    }

    // cm:guard the mark is cleared only once core ANSWERED. Marking first turns one unreachable
    // minute into a decision that exists on this box and nowhere else.
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

    // cm:guard criterion 27: a pane cannot tell from inside whether it is new or continuing, and
    // one that assumes it is new re-declares work already running.
    #[test]
    fn a_resumed_pane_is_told_that_it_was_resumed() {
        let brief = resumed_brief("conv-abc", &three_inherited());
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("conv-abc"), "{brief}");
    }

    // cm:guard criterion 28, and it is the owner's rule rather than a style preference: the box
    // preserves, the kernel retracts, the MASTER decides. A recommendation here moves that
    // judgement into the box through a second door.
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

    // cm:guard every inherited run appears, with the fields the box can state. A block that named
    // only the first would have the master decide three fates from one row.
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

    // cm:guard a resumed pane holding nothing must not be asked to decide anything, or every
    // restart of a quiet project costs a round of prose about an empty list.
    #[test]
    fn a_resumed_pane_holding_nothing_is_asked_for_nothing() {
        let brief = resumed_brief("conv-abc", &[]);
        assert!(brief.contains("RESUMED"), "{brief}");
        assert!(brief.contains("nothing to decide"), "{brief}");
    }

    // cm:guard criterion 18: a stored conversation this box cannot reach must COLD START and say so
    // naming the conversation. The temptation is to pass `--resume` anyway and let claude decide —
    // which kills the pane on spawn, and the next sweep rebuilds it and kills it again, a loop whose
    // only trace is a pane that keeps disappearing (ISS-1050).
    /// What the daemon log SAYS when a recorded conversation cannot be resumed.
    // cm:why captured through a real subscriber rather than asserted on a returned string: `resume_for` answers `None` for "nothing stored" and for "stored but unreachable" alike, so a test reading only the return value passes just as happily when the warning is deleted — and that warning is the whole difference between a pane that silently forgot what it was doing and one whose operator can see why.
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
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[test]
    fn a_conversation_this_box_cannot_reach_is_named_in_the_log_it_starts_cold_from() {
        let repo = std::env::temp_dir().join("forge-resume-log");
        let out = logged_while(|| {
            assert_eq!(
                resume_for("some-slug", &repo, Some("conv-9f3a-unreachable")),
                None
            );
        });

        // cm:why the TRANSCRIPT PATH is what is asserted, not a bare mention of the id. The id
        // appears in this line twice over — once as itself and once inside the path, which is
        // `<conversation>.jsonl` — so an assertion on the id alone stays green when the explicit
        // mention is deleted, and cannot tell the two apart. Planting exactly that proved it: the
        // message was stripped of `{id}` and this test did not notice. The path is also the half
        // that is actually worth naming, because it is the thing an operator goes and looks at.
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
        // cm:guard the absence of a warning is asserted too. A box that has never resumed anything
        // has no conversation to fail to reach, and warning there would put a line in every
        // operator's log on every cold start, which is how the real one stops being read.
        let repo = std::env::temp_dir().join("forge-resume-log-quiet");
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
        let repo = std::env::temp_dir().join("forge-resume-none");
        assert_eq!(
            resume_for("slug", &repo, Some("conv-that-was-never-here")),
            None,
            "a conversation with no transcript may not be handed to --resume"
        );
    }

    #[test]
    fn a_conversation_whose_transcript_is_here_is_resumed() {
        let repo = std::env::temp_dir().join(format!("forge-resume-{}", std::process::id()));
        let id = format!("conv-{}", std::process::id());
        let path = conversation_transcript(&repo, &id).expect("a home directory");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, "{}\n").expect("write");

        let got = resume_for("slug", &repo, Some(&id));

        let _ = std::fs::remove_file(&path);
        assert_eq!(got.as_deref(), Some(id.as_str()));
    }

    // cm:guard nothing stored and an empty string are both cold, and the empty string matters: the
    // ledger column is nullable and a hook that carried a blank conversation would write one.
    #[test]
    fn nothing_stored_is_a_cold_start_and_so_is_an_empty_string() {
        let repo = std::env::temp_dir().join("forge-resume-empty");
        assert_eq!(resume_for("slug", &repo, None), None);
        assert_eq!(resume_for("slug", &repo, Some("")), None);
    }

    // cm:guard the encoding is Claude Code's, verified on this box, and this is the test that fails
    // if it drifts rather than every master silently cold-starting forever.
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
        async fn release(&self, issue_key: &str) -> R<()> {
            self.0.lock().unwrap().push(issue_key.to_string());
            Ok(())
        }
        async fn is_returned(&self, issue_key: &str) -> R<bool> {
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

    // cm:guard the discriminating assertion is that core is TOLD, not that the pid was killed. A build that kills the pane and says nothing still passes every other test in this file, and that build is what this box shipped for weeks: core's ten-minute sweep then wrote `runner_unreachable` over a box that had ended the run deliberately, which is ~95% of a 203-session failure bucket nobody can now decompose.
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
        // cm:guard the checkpoint RIDES the close. Without it the only copy of what the run left is
        // on a disk nobody reads, which is the whole failure this issue exists to end (ISS-1050).
        assert_eq!(
            checkpoint.as_ref().and_then(|c| c["source"].as_str()),
            Some("reconstructed_from_box"),
            "the close must carry the box's half, labelled as reconstruction: {checkpoint:?}"
        );
        assert_eq!(killed.0.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    // cm:guard the discriminating assertion is the BEAT, not that a run was closed. Core reaps a run session silent for ten minutes, so a sweep that reconciled without beating would take every healthy run on this box back after ten minutes — a test that only watched the closing half would go green on exactly that build (ISS-933 criteria 16 and 25a).
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

    // cm:guard the branch Windows actually took: `inflight::boot_identity` answers `None` there, and `unwrap_or_default` hands this an empty string. An empty boot matches NO recorded run, so a build without this refusal reads every live run on the box as orphaned and takes its worktree — the two tests above went red on CI's windows-latest before this branch existed.
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
    async fn a_repo_with_a_live_worktree() -> (std::path::PathBuf, std::path::PathBuf) {
        let repo = std::env::temp_dir().join(format!(
            "forge-master-reclaim-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&repo);
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

    // cm:guard the assertion is that core hears it FROM THE BOX. Without this call the only thing that ever flips the session is core's ten-minute silence sweep, which writes `runner_unreachable` over a box that is plainly reachable — it is talking to core in this very sweep — and holds the run's issues for those ten minutes (forge-vm 2026-09-12: every failure on two projects showed ~10 minutes between `last_heartbeat_at` and `updated_at`, ~95% of 203 sessions in that one bucket).
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
                repo_path: repo.clone(),
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
        // cm:guard a DEATH is the case the evidence exists for, so this is the close that must
        // never lose it.
        let cp = checkpoint.as_ref().expect("a death carries the box's half");
        assert_eq!(cp["source"].as_str(), Some("reconstructed_from_box"));
        // cm:guard the branch asserted is the RUN's worktree branch and deliberately not the one
        // this test process is standing in. Every `git` in `checkpoint.rs` runs with
        // `current_dir(worktree)`, so a relative or empty path resolves against the daemon's own
        // cwd and the payload would confidently describe a different checkout entirely — which an
        // equality on `source` alone would not catch. This fixture's branch differs from the
        // repository this suite runs inside, which is what makes the assertion mean anything.
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

    // cm:guard the assertions are the CHECKOUT off the disk and `ended_by` written, never that a warning changed: the deadlock this closes is invisible to every mark-level assertion, because all three marks are exactly what a stuck run already has. `close_loop::close` alone leaves this run untouched forever — it observes, and the tree is still there to observe (forge-vm 2026-09-10: 24 runs, 24 trees, every lease held under them).
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
                repo_path: repo.clone(),
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
            "the checkout must actually leave the disk: while it is there the `worktree_gone` mark cannot be observed, so `end_run` is never reached and the reap refuses the tree because the run is `ended_by IS NULL` — the cycle has no other exit"
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

    // cm:guard the DIFF is asserted on the remote, not merely that the tree went away: `force_terminal` aborts before touching a worktree whose work could not be preserved, so a build that released this one anyway would pass every assertion about disk and `ended_by` while having thrown away an agent's uncommitted work. Every stuck run measured on forge-vm 2026-09-10 was carrying one.
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
                repo_path: repo.clone(),
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

    // cm:guard depth 1 is the assertion and a mere `contains` is NOT enough: measured while writing this, `if false { give_back_lost_runs(...) }` passed a containment check, so the scan agreed with a build in which no run on the box is ever beaten. A call sitting under any condition is a call an operator cannot rely on.
    #[test]
    fn the_sweep_reconciles_unconditionally() {
        assert_eq!(
            depth_of_call_in_sweep("give_back_lost_runs("),
            Some(1),
            "the sweep must reconcile what this box holds on EVERY pass; behind a condition, or gone, nothing beats a run session and core reaps every healthy one after ten minutes"
        );
    }

    // cm:guard the same source scan as its neighbour, and for the same reason a `contains` check
    // would not do: a declaration reaches core only here, so behind a condition it reaches core on
    // some sweeps and not others, and a master's run row would sit unpublished for as long as that
    // condition held while the master dispatched against it (ISS-1050 criterion 5).
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

    // cm:guard ORDER, not merely presence. `reconcile` reads a row with no core session as a run
    // that never started and closes the loop over it, so a declaration made this sweep has to reach
    // core BEFORE the reconciler sees it — otherwise a master's freshly declared work is given back
    // from under the subagent it was just handed to (ISS-1050 criteria 5, 8).
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

    // cm:guard depth 1 and exactly one occurrence: the report is taken ONCE for the box, after every project has been read. Core's limit route fans out to every runner binding of the device, so a call moved inside the project loop would let an older success on one project delete the stamp a newer refusal on another had just written — decided by whatever order `/me/runners` returned the rows in.
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
            .and_then(|r| r.split("\n/// ").next())
            .expect("sweep is gone");
        assert_eq!(
            sweep.matches("report_account_limit(").count(),
            1,
            "one decision per sweep means one call site"
        );
    }

    // cm:guard the collection is what feeds that one decision, and it sits INSIDE the loop by design — one verdict read per project, one decision taken for the device.
    #[test]
    fn a_verdict_is_read_for_every_project_whose_pane_is_up() {
        assert!(
            depth_of_call_in_sweep("account_verdict(").unwrap_or(0) > 1,
            "the read belongs inside the project loop; only the decision is device-wide"
        );
    }

    /// The reporting path's own source, bounded to it.
    fn reporting_path() -> &'static str {
        THIS_SOURCE
            .split("async fn report_account_limit(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("the reporting path is gone")
    }

    // cm:guard THREE separate guards rather than one list, because they are three different
    // promises and a caller breaks them one at a time: a cap that retires the box, a cap that
    // rewrites the runner row, and a cap that moves somebody's work are each their own regression,
    // and a single assertion would report whichever one it met first as all of them.
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

    // cm:guard ONE clock for the whole sweep. The verdicts are classified against the instant taken at the top of `sweep`, and both freshness bounds are DISTANCES from it — so a second reading here would judge those verdicts against an instant they were never measured from, with the whole project loop and its calls to core in between.
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

    // cm:guard BOTH calls, named separately, because the two arms are written apart and a later edit adds one back unbounded without touching the other. `CoreClient` has no request timeout of its own, so an unbounded call here is the sweep's deadline, not the report's.
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

    // cm:guard a core that ACCEPTS and then says nothing, which is the case no `Err` arm covers: the transport only returns once the request resolves, and without a deadline it never does. Measured as a hang rather than a failure, everything behind this await — `reconcile`, `give_back_lost_runs`, the next sweep, the cancel branch — is stopped with it.
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

    // cm:guard the nudge stays INSIDE the loop and is not gated on anything the report decides. Backing off is not stopping: core clears a limit only on a turn that succeeds, so a box that stopped nudging while capped would remove the only thing that can end its own window.
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
        assert!(nudge_due(None, 7, Instant::now(), SinceNudge::Ran));
    }

    // cm:guard the falsifying case: everything else here passes against the unconditional nudge this replaced.
    #[test]
    fn the_same_work_twice_in_a_row_is_not_nudged_twice() {
        let now = Instant::now();
        assert!(!nudge_due(
            sent(7, now, Some(0)),
            7,
            now,
            SinceNudge::NoTurn
        ));
    }

    // cm:guard NEW work is nudged whatever the pane is doing, and this arm is the one that must not learn to consult the evidence: an issue that appears while the master is mid-turn is still an issue it has not been told about.
    #[test]
    fn changed_work_is_nudged_without_waiting_out_the_period() {
        let now = Instant::now();
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                nudge_due(sent(7, now, Some(3)), 8, now, since),
                "new work must reach the master however {since:?} reads"
            );
        }
    }

    // cm:guard the ceiling on silence, and the test that has to fail if anyone turns this backoff into a skip. Unchanged work must STILL reach the master past `NUDGE_REFRESH` where the last nudge produced no completed turn, because a pass lost to a wedged pane or a limit cleared out of band is otherwise never retried (`9a7c34b99`).
    #[test]
    fn unchanged_work_is_nudged_again_where_the_last_one_produced_no_turn() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::NoTurn
        ));
    }

    #[test]
    fn unchanged_work_is_nudged_again_where_the_master_has_never_reported() {
        assert!(nudge_due(
            sent(7, a_while_ago(), None),
            7,
            Instant::now(),
            SinceNudge::Unreported
        ));
    }

    // cm:guard the limit-cleared-out-of-band half of the ceiling. Claude Code emits `StopFailure` INSTEAD of `Stop` after a model or API error, so a turn that died on the account's window reads here and nowhere else; without this arm the one thing the ceiling was built for is the one thing it would stop doing.
    #[test]
    fn unchanged_work_is_nudged_again_where_the_turn_died_on_an_error() {
        assert!(nudge_due(
            sent(7, a_while_ago(), Some(4)),
            7,
            Instant::now(),
            SinceNudge::Failed
        ));
    }

    // cm:guard THE case ISS-1100 is about: the pass ran, in full, and decided. Repeating it buys a second identical answer at the price of a full agent pass — 1,630 of them in 24h on forge-vm, 258 to a project whose whole candidate set was blocked.
    #[test]
    fn unchanged_work_is_withheld_where_the_last_nudge_produced_a_turn() {
        for since in [
            SinceNudge::Ran,
            SinceNudge::Working,
            SinceNudge::AwaitingPermission,
        ] {
            assert!(
                !nudge_due(sent(7, a_while_ago(), Some(4)), 7, Instant::now(), since),
                "a master that {since:?} has answered this work already"
            );
        }
    }

    // cm:guard a permission stop withholds, and the reason is not only cost: `nudge_master` types a line and presses Enter, so a keystroke sent into a pane holding a permission question ANSWERS that question with the pass prompt. The human still owes an answer either way, and nothing here may supply one.
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

    // cm:guard the evidence is a PROMPT submitted, not any hook frame. A child of an earlier pass finishing bumps `sequence` while the nudge still sits unsubmitted in the composer; reading that as a turn would strand the wedged pane this ceiling exists to rescue.
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

    // cm:guard THE sequence review found on ISS-1100: the lead turn dies on the account limit while
    // a child is still outstanding, and the child's own `SubagentStop` arrives after it. Read off
    // `last_event` this is a clean finish and the nudge is never repeated, so the limit clearing out
    // of band is never picked up — the one recovery `NUDGE_REFRESH` was built for, lost.
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
            since_nudge(Some(&a), Some(0))
        ));
    }

    // cm:guard the other half of the same field: a turn that failed and then a LATER turn that ran
    // cleanly is not still failed, or one bad turn would re-nudge this project for the rest of the
    // pane's life. The clearing is the `Stopped` arm's, and there is deliberately no second clear on
    // `PromptSubmitted`: one was written, and removing it turned no test red because every path out
    // of a turn assigns this field on the way. A write no assertion can reach is a second live path,
    // not a belt and braces.
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

    // cm:guard a title and a priority moving is not new work, and a digest that tracked them would nudge on every edit an operator makes in the UI.
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

    // cm:guard THE stranding ISS-1100's review found. Core admits statuses the master does not take
    // — forge-dev admits `developed`, `testing`, `tested`, `awaiting_release` — so a row can sit in
    // the set for days being correctly refused. When it reaches one the master DOES take, the id set
    // has not moved. Under the clock the next refresh picked it up; under `retry_owed` an
    // identity-only digest never would, and the work is stranded with nothing anywhere saying why.
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

    // cm:guard the same stranding through the blocker rather than the row. Core hides a row behind
    // an unsettled blocker, so the ordinary release moves the id set — but core also OFFERS a row
    // whose edge has expired while the master still refuses it, and that one is released by the
    // blocker moving with the id set unchanged.
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

    // cm:guard the widening is bounded by what `holdsBack` reads, and these three are the boundary.
    // A `relates` edge is not an ordering; a blocker's merge stamp gates nothing anywhere; and an
    // expiry the master never consults either moves the row in or out of the set or means nothing.
    // Hashing any of them re-nudges immediately — a changed digest skips the ceiling entirely — and
    // buys back the spend this issue exists to remove.
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

    // cm:guard order-independence has to survive the widening: `json_agg` promises no order for the
    // relations of one issue any more than the route promises one for the rows.
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
            masters.claim_nudge("p1", 7, None),
            "the first sight of work nudges"
        );
        assert!(
            !masters.claim_nudge("p1", 7, None),
            "the same work on the next sweep must not spend another pass"
        );
        assert!(
            masters.claim_nudge("p1", 8, None),
            "new work nudges at once"
        );
    }

    // cm:guard the whole of ISS-1100's box half, end to end through the real registry: the same
    // work, past the ceiling, with the master's own hooks saying it answered. Delete the evidence
    // term and this is the assertion that goes red.
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
        assert!(masters.claim_nudge("p1", 7, Some(&before)));
        age_last_nudge(&masters, "p1");

        let answered = reported(&[
            (agent_activity::Event::Stopped, None),
            (agent_activity::Event::PromptSubmitted, None),
            (agent_activity::Event::Stopped, None),
        ]);
        assert!(
            !masters.claim_nudge("p1", 7, Some(&answered)),
            "the ceiling came round, the work is the same, and the master's own hooks say it ran the pass"
        );

        let wedged = reported(&[(agent_activity::Event::Stopped, None)]);
        age_last_nudge(&masters, "p1");
        assert!(
            masters.claim_nudge("p1", 7, Some(&wedged)),
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
        assert!(!masters.claim_nudge("nobody", 7, None));
    }

    // cm:guard the repeat decision reads what the AGENT reported and nothing else. The gate ISS-933 deleted read a pane's bytes, and the one thing keeping this from being that gate under a new name is that every input to it comes off a hook frame.
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

    // cm:guard the ratchet on the call SITE, not the helper: `claim_nudge` is worth nothing if a later edit calls `nudge_master` beside it rather than inside it, and that mistake restores a spend proportional to sweeps with every unit test still green.
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

// cm:guard this `#[cfg(test)]` block is at the END of the file and must stay there. Three tests in
// this module read their subject by splitting the source on the FIRST `#[cfg(test)]` and scanning
// what precedes it, so a test-only item placed above `sweep` or `nudge` truncates the half they
// read — `the_sweep_reconciles_unconditionally` and its neighbours then answer about a body that is
// not there. All three fail loudly when that happens, which is how this block ended up down here.
#[cfg(test)]
impl Masters {
    /// Put a master in the registry without spawning one.
    // cm:guard test-only, so no production path can register a pane nothing started: adoption goes through `ensure_master`, which asks tmux first.
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

    fn ensure_master_body() -> &'static str {
        production()
            .split("\nasync fn ensure_master(")
            .nth(1)
            .and_then(|r| r.split("\n/// ").next())
            .expect("ensure_master must be findable")
    }

    // cm:guard the three helpers below scan SOURCE TEXT, and what that can and cannot catch is
    // stated here rather than left for a reader to infer. It catches the thing removed, renamed or
    // reworded — every ISS-1092 mutation that got past the assertions this replaced. It does NOT
    // catch a behaviour change that leaves the text standing: a branch made unreachable above it, a
    // returned value ignored, a call whose effect is undone further down. It also reds on a
    // refactor that moves no behaviour, which is a real cost paid by whoever edits `sweep` or
    // `ensure_master` next.
    //
    // It is used here because these four criteria are not reachable any other way: criteria 11 and
    // 12 live inside `sweep` and criteria 17 and 18 inside `ensure_master`, and both need a live
    // tmux pane and a core client to run at all. Where a criterion IS reachable it is NOT scanned —
    // criterion 15's `say_unplaced` is a free function, so
    // `an_unplaced_pane_is_reported_once_and_names_its_project_and_reason` drives it through a real
    // subscriber and asserts the emitted level and fields, which is how a demotion from `warn!` to
    // `info!` is caught. A source scan for the format string would not catch that one, which is the
    // measure of the difference.
    /// Where a block opened at `indent` spaces closes, in `rest`.
    ///
    /// Matches the newline BEFORE the closing brace and never the one after
    /// it: a checkout with CRLF endings holds `}\r\n`, so a pattern carrying
    /// the trailing `\n` finds nothing and every block-scoped assertion below
    /// panics on its `expect` instead of running. Measured on CI, which builds
    /// this crate on windows-latest beside ubuntu and macos; the three tests
    /// that read these regions went red there and green here on the same
    /// commit.
    fn block_end(rest: &str, indent: usize) -> Option<usize> {
        rest.find(&format!("\n{}}}", " ".repeat(indent)))
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

    /// The `session.created` report inside `ensure_master`'s adopt branch, on
    /// its own.
    ///
    /// Scoped to the one `if` block. `ensure_master` holds eight further
    /// `tracing::error!` calls, and both `{name}` and `session.session_id`
    /// appear again further down it — so an assertion over the rest of the
    /// function body holds whatever this report is written as.
    fn adopt_report() -> &'static str {
        let body = ensure_master_body();
        let start = body
            .find("if session.created {")
            .expect("the adopt branch must gate its report on session.created");
        let rest = &body[start..];
        let end = block_end(rest, 12).expect("the session.created report must close");
        &rest[..end]
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

    // cm:guard the STALE-CAPABILITY arm, and it is the one the field incident landed in. The daemon
    // had adopted the pane and logged that it had; what it held was the session core minted to
    // replace the one the pane's token names, and no sweep will ever reconcile the two.
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

    // cm:guard an unread list answers "I do not know" and never "you are not served". The two send
    // an operator to opposite places, and a network error would otherwise read as a decommission.
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

    // cm:guard the ONE arm that may promise a sweep, and it may only because the sweep really does
    // place a pane for a served project with nothing recorded against it.
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

    // cm:guard the bool is the whole of the once-ness. A reason that repeats is a line per sweep on
    // a box that sweeps every thirty seconds, which is the silence this issue is about wearing a
    // different face.
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

    // cm:guard an empty pool answers `AdoptOnly`, NOT "skip". The distinction is the `register`
    // call, and it is the whole of the field incident: 14 hours of skipped sweeps let core reap the
    // session row of a master that was running the entire time.
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

    // cm:guard the bound this replaces was written as a `continue`, and reinstating one here
    // reinstates the whole defect. What remains is `AdoptOnly`, which starts nothing.
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

    // cm:guard the liveness question comes BEFORE `register` on the adopt-only path. Asking core
    // first would open a master session row for a project this sweep is about to start no master
    // for — a row nothing beats for, which is the reaping this change exists to stop, arriving
    // through the fix.
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

    // cm:guard the adopt-only path may not reach the spawn at all, and the window this closes is a
    // pane that was alive at the first check and gone by the second — the awaits between them are
    // a core call and an MCP read. Without this return the sweep starts a master for a project with
    // nothing claimable, which is the bound above failing through the fix meant to keep it.
    #[test]
    fn adopt_only_cannot_fall_through_to_the_spawn_when_the_pane_dies_mid_registration() {
        let body = ensure_master_body();
        let adopted = body
            .find("return PaneState::Adopted;")
            .expect("the adopt branch must return");
        let spawn = body
            .find("install_skill(&resolved.repo_path)")
            .expect("the spawn path must start with the skill install");
        let between = &body[adopted..spawn];
        assert!(
            between.contains("if placement == Placement::AdoptOnly {"),
            "a pane that exits while `register` is awaited must not turn `AdoptOnly` into a spawn"
        );
    }

    // cm:guard `created` while a pane is ALIVE is the daemon proving the running pane's capability
    // is orphaned, and it is reported at ERROR because nothing on this box will clear it.
    // cm:guard scoped to `adopt_report` and never to the rest of `ensure_master`. The version this
    // replaces sliced the function from its first `tracing::error!` onward, and the function holds
    // eight more of them plus later uses of both `{name}` and `session.session_id` — so it stayed
    // green when the report was demoted to `info!` and when it named neither the pane nor the
    // session (ISS-1092 criteria 17, 18, measured by planting exactly those three).
    #[test]
    fn adopting_a_pane_onto_a_freshly_created_session_is_reported() {
        let body = ensure_master_body();
        let adopt = body
            .find("adopting the resident session")
            .expect("the adopt branch must be findable");
        assert!(
            body[adopt..].contains("if session.created {"),
            "a pane adopted onto a session core created fresh holds a capability for the session that one replaced, and nothing else on this box can notice it"
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

    // cm:guard the drained branch LEAVES the iteration, and the assertion is scoped to the branch.
    // The sweep holds four later `continue`s, so an ordering test over the whole body stays green
    // when this one is deleted — measured at a40f4bdab, where removing it let a drained project
    // fall through to `resolve_repo` and `ensure_master` with all 737 tests still passing
    // (ISS-1092 criterion 11).
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

    // cm:guard the SWEEP's own call, which `a_recorded_reason_reaches_the_pane_that_asked` does not
    // reach: that test records a Draining reason by hand and proves only that `why_unplaced` reads
    // one back. Deleting this call left all 737 tests green (ISS-1092 criterion 12).
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

    // cm:guard the WARNING itself, through a real subscriber, and NOT the source text of
    // `say_unplaced` nor the bool that gates it. This is the one of ISS-1092's log criteria that a
    // behavioural test can reach — `say_unplaced` is a free function over `Arc<Masters>` and needs
    // no tmux and no core — so it is reached that way. `a_reason_is_reported_when_it_arrives_...`
    // asserts what `note_unplaced` ANSWERS, which stayed green when the `tracing::warn!` was
    // deleted outright (ISS-1092 criteria 15, 16, measured at a40f4bdab: 737 passed with no log
    // line emitted at all).
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
}
