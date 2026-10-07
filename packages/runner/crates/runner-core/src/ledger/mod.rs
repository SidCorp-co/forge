//! The registry of run sessions this box owns (ISS-933), and the typed shape a
//! blocked one parks in (ISS-964).
//!
//! A run is no longer a `jobs` row: core wakes a master, the master creates
//! runs, and nothing outside this box knows which worktree belongs to which
//! run. This file is that knowledge, in SQLite so it survives the master, the
//! daemon and the boot.
//!
//! Two things it is deliberately NOT. It is not a queue — no event cursor, no
//! wake bookkeeping, no "what have I processed" — because a registry that also
//! remembers progress becomes the second source of truth core already is. And
//! it is not a status string: an incarnation (is the process there) and a work
//! state (can it move) are separate columns, because the question the whole
//! design exists to answer is *waiting or dead*, and one string cannot say
//! both.

mod masters;
mod release;
mod runs;
mod schema;

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use runner_platform::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Incarnation {
    Live,
    Starting,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Liveness {
    Alive,
    Dead,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Work {
    Runnable,
    Blocked,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockerKind {
    Machine,
    MasterOrPeer,
    Human,
    Nobody,
}

impl Run {
    pub fn is_parked_on_human(&self) -> bool {
        matches!(self.incarnation, Incarnation::Exited)
            && matches!(self.work, Work::Blocked)
            && matches!(self.blocker_kind, Some(BlockerKind::Human))
    }
}

impl BlockerKind {
    pub fn wire(self) -> &'static str {
        match self {
            BlockerKind::Machine => "machine",
            BlockerKind::MasterOrPeer => "master_or_peer",
            BlockerKind::Human => "human",
            BlockerKind::Nobody => "nobody",
        }
    }
}

impl Incarnation {
    pub fn wire(self) -> &'static str {
        match self {
            Incarnation::Live => "live",
            Incarnation::Starting => "starting",
            Incarnation::Exited => "exited",
        }
    }
}

impl Work {
    pub fn wire(self) -> &'static str {
        match self {
            Work::Runnable => "runnable",
            Work::Blocked => "blocked",
            Work::Done => "done",
        }
    }
}

/// A refusal as the ledger now holds it: when its streak began, and whether
/// this call is the one that began it — which is what tells a caller to say it
/// out loud rather than to say it again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    pub since: i64,
    /// How many times this streak's refusal has now been taken. A count is the
    /// half of the window no clock can move.
    pub attempts: i64,
    pub opened_the_streak: bool,
}

/// One run session: a worktree, a group of issues, and the marks that close it.
#[derive(Debug, Clone)]
pub struct Run {
    pub run_id: String,
    pub project_id: Option<String>,
    pub master_session_id: String,
    pub session_id: Option<String>,
    pub worktree_path: PathBuf,
    pub pid: Option<u32>,
    pub boot_id: String,
    pub incarnation: Incarnation,
    pub work: Work,
    pub blocker_kind: Option<BlockerKind>,
    pub waiting_on: Option<String>,
    pub session_terminal_at: Option<i64>,
    pub worktree_gone_at: Option<i64>,
    /// How this run stopped holding a checkout it owed back, in the words of
    /// [`CheckoutReturn`]. `None` is a run that still holds one.
    ///
    /// It is a second fact and not a second spelling of the one above.
    /// `worktree_gone_at` says the checkout left the disk; this says why the
    /// run no longer owes it, and the two part company on the one case where
    /// the checkout is alive and owed to nobody — the repository's own main
    /// working tree, which a run declared against it never took from the pool
    /// (ISS-1183). One column carrying both meanings is a row that reads
    /// `worktree gone` over a checkout somebody is standing in (ISS-1193).
    pub released_as: Option<String>,
    pub ended_by: Option<String>,
    pub ended_reason: Option<String>,
    pub agent_id: Option<String>,
    /// What a resumed master chose to do about this run: `continue`, `restart` or `leave`.
    pub resume_choice: Option<String>,
    pub resume_choice_why: Option<String>,
    /// When the refusal this run's release is currently standing on was FIRST
    /// seen. Cleared the moment a release gets past it, so it is the age of one
    /// streak and not a count of every refusal this run ever had.
    pub release_refused_at: Option<i64>,
    /// That refusal in its own words, kept so a person reading the row is told
    /// what the box could not answer rather than that something went wrong.
    pub release_refusal: Option<String>,
    /// When that refusal was decided to be one no retry can get past. From here
    /// the leases are back, the run is over, and the checkout is still on disk.
    pub release_terminal_at: Option<i64>,
    /// When this run's subagent last ended a turn, in wall-clock ms. A turn-end
    /// is not a finish: a subagent ends one to wait on its own background work,
    /// and one that finished can still be resumed by its dispatcher (ISS-1246).
    pub turn_ended_at_ms: Option<i64>,
    /// Where this run's subagent writes its own transcript.
    pub agent_transcript: Option<String>,
    /// When the run was declared, in wall-clock seconds.
    pub created_at: i64,
    /// When the process this run's subagent lived in was last known to end, in
    /// wall-clock ms: this box started a new master pane for its project, or
    /// read its master's pane as gone. A subagent shares its master's process,
    /// so a turn it was in ended then. Anything heard from the subagent later
    /// supersedes it, and a start of its subagent clears it (ISS-1312).
    pub host_ended_at_ms: Option<i64>,
    /// What that end was seen as: [`HOST_PANE_STARTED`], [`HOST_PANE_GONE`] or
    /// [`HOST_PROCESS_GONE`].
    pub host_ended_by: Option<String>,
    /// The Claude Code process this run's subagent runs in, read above the
    /// hook or the `run declare` that last reported for it, and its start time
    /// in clock ticks since boot. A mark in the two columns above counts only
    /// where these are set, because only that process's end is its
    /// subagent's end: a pane can end or be started again while the
    /// conversation runs elsewhere (ISS-1312, run e67c08e0).
    pub host_pid: Option<u32>,
    pub host_start: Option<String>,
    /// When core refused this run's close with a constraint its bytes can never
    /// satisfy, and the sweep stopped re-sending it. This is NOT the session
    /// being over: `session_terminal_at` stays what core says, read back by the
    /// close loop, so a refused close never records a session core did not close.
    pub close_refused_at: Option<i64>,
    /// The constraints core named, one line each.
    pub close_refusal: Option<String>,
}

/// A run's host ended because this box started a new master pane for its
/// project, the one before it being absent.
pub const HOST_PANE_STARTED: &str = "pane-started";
/// A run's host ended because recovery read its master's pane as gone.
pub const HOST_PANE_GONE: &str = "pane-gone";
/// A run's host ended with its master's pane read neither gone nor started
/// again: the process was read gone on its own.
pub const HOST_PROCESS_GONE: &str = "process-gone";

/// `close_loop::CloseState::is_closed` over a row aliased `r`: the session is
/// over, the checkout is back and every lease is back. Such a run holds
/// nothing, whatever its incarnation reads, because the close loop sets these
/// marks without ending the row (ISS-1312 criteria 41-44).
const CLOSED_BY_ITS_MARKS: &str = "(r.session_terminal_at IS NOT NULL AND r.released_as IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM run_issues m WHERE m.run_id = r.run_id AND m.lease_returned_at IS NULL))";

/// A run no master on this box answers for: it has no ending, and the master
/// session it was declared under is no session the `masters` table records, so
/// `run close` from every pane is refused as another master's (ISS-1355).
#[derive(Debug, Clone)]
pub struct Unanswered {
    pub run: Run,
    pub issues: Vec<Membership>,
    pub closed_by_its_marks: bool,
    /// Its project's `masters` row records no session, so whether the pane
    /// there declared it cannot be told.
    pub master_row_has_no_session: bool,
}

/// What will end a run no master answers for, read off its own row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WhatEndsIt {
    /// Its marks close it, so the next recovery sweep ends it.
    NextSweep,
    /// Core has not called its session over, and recovery releases it once it has.
    SessionOver,
    /// Its release was given up on, so only `forge-runner run release` puts it back.
    OperatorRelease,
    /// Recovery still owes the checkout back.
    CheckoutRelease,
    /// Recovery has these leases still to read back.
    LeasesBack(Vec<String>),
    /// Its row records no project, so no sweep can tie it to a master.
    NothingNoProject,
    /// Its project's master row records no session, so that pane may be its
    /// declarer and its close is the only way out.
    NothingMasterUnknown,
}

impl Unanswered {
    /// Whether the recovery sweep ends it now. A run whose project is unknown,
    /// or whose project's master may be its declarer, is left.
    pub fn sweep_ends_it(&self) -> bool {
        self.closed_by_its_marks && self.run.project_id.is_some() && !self.master_row_has_no_session
    }

    pub fn what_ends_it(&self) -> WhatEndsIt {
        if self.run.project_id.is_none() {
            return WhatEndsIt::NothingNoProject;
        }
        if self.master_row_has_no_session {
            return WhatEndsIt::NothingMasterUnknown;
        }
        if self.closed_by_its_marks {
            return WhatEndsIt::NextSweep;
        }
        if self.run.session_terminal_at.is_none() {
            return WhatEndsIt::SessionOver;
        }
        if self.run.released_as.is_none() {
            return if self.run.release_terminal_at.is_some() {
                WhatEndsIt::OperatorRelease
            } else {
                WhatEndsIt::CheckoutRelease
            };
        }
        WhatEndsIt::LeasesBack(
            self.issues
                .iter()
                .filter(|m| m.lease_returned_at.is_none())
                .map(|m| m.issue_key.clone())
                .collect(),
        )
    }
}

/// How many characters of an id this box writes when it names one for a
/// person, and the fewest a person may name a run by.
pub const SHORT_ID_CHARS: usize = 8;

/// The first eight characters of an id, which is how a session is named in
/// what this box writes for a person.
pub fn short_id(id: &str) -> &str {
    id.get(..SHORT_ID_CHARS).unwrap_or(id)
}

/// What a run id a person typed names (`Ledger::run_named`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Named {
    /// A run's whole id.
    Whole(String),
    /// The start of exactly one run's id, which is this one.
    Start(String),
    /// The start of several runs' ids, oldest first.
    Ambiguous(Vec<String>),
    /// The start of these runs' ids, and shorter than [`SHORT_ID_CHARS`].
    TooShort(Vec<String>),
    /// No run's id, whole or begun.
    Nothing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterPass {
    pub project_id: String,
    pub session_id: String,
    pub pass_id: String,
    pub verb: String,
    pub issue_key: Option<String>,
    pub opened_at: i64,
    pub opened_by: String,
    /// The lead's turn count (`Activity::turns`) when the pass was asked for.
    /// Stored in the `prompts_at_nudge` column, named when only prompted turns
    /// were counted: a pass opened by another daemon process is closed as
    /// abandoned before this is read, so no value written under the old count
    /// is ever compared, and an older build reopening this ledger still finds
    /// the column it reads.
    pub turns_at_nudge: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterRow {
    pub project_id: String,
    pub pane_name: String,
    pub conversation_id: Option<String>,
    /// The core session id this pane registered under, which is the key its
    /// `runs` rows carry. `None` on a row an older binary wrote, where the
    /// runs this master holds cannot be established at all.
    pub session_id: Option<String>,
    pub boot_id: String,
    pub cold_started_at: i64,
    pub last_seen_at: i64,
    /// The runner build that placed the pane, as `update::VERSION_LINE` reads.
    /// `None` on a pane placed before a build recorded it, or one this box
    /// adopted and never placed (ISS-1379).
    pub placed_build: Option<String>,
    /// The Claude Code plugins installed when the pane was placed, as
    /// `master_build::plugin_set` writes them. `None` where they could not be
    /// read then, which leaves the build alone to judge the pane.
    pub placed_plugins: Option<String>,
    pub placed_at: Option<i64>,
    /// What the pane was placed with that a rebuild can change, as
    /// `master_build::Inputs` writes it: each input by name, with its digest.
    /// `None` on a pane placed by a build that recorded none, which is then
    /// judged by `placed_build` alone.
    pub placed_inputs: Option<String>,
    /// The daemon's last verdict that this pane is outdated, in its own words,
    /// and `None` while it is current or has not been judged. Written so
    /// `forge-runner master status` can name it without knowing what build the daemon runs.
    pub outdated: Option<String>,
    /// Open runs of this project the last carry onto `session_id` left under
    /// another session without being able to say whether they are this pane's,
    /// in the daemon's words; `None` where it attributed every one. While it
    /// stands, which runs this pane holds is not known (ISS-1379).
    pub unattributed: Option<String>,
}

/// One episode of an owner's standing decision about a project's resident
/// master on this box: stood down at a moment, for a reason, until stood up
/// again on an argument (ISS-1118, ISS-1238).
///
/// The table is append-only and a project has as many rows as it has been
/// stood down. It held one row per project until ISS-1238: a second stand-down
/// overwrote the first, and a lifted row was DELETEd as soon as a pane had been
/// told its interval, so the record of what a box had been waiting for outlived
/// the wait by one placement. That is why forge-dev's two idle days could not be
/// accounted for afterwards from anything but unrelated evidence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterStanding {
    /// This episode's own identity. The rows for one project read newest-first
    /// by it, and it is what makes two stand-downs two things rather than one
    /// row written twice.
    pub episode: i64,
    pub project_id: String,
    pub slug: String,
    pub stood_down_at: i64,
    pub stood_down_by: String,
    /// `None` only on an episode a binary older than ISS-1238 wrote, where the
    /// reason was optional. Those rows are carried through the migration with
    /// their NULL rather than given an invented reason — the emptiness is the
    /// only evidence that the gap existed — and every surface that prints a
    /// standing says so in as many words rather than printing nothing.
    pub why: Option<String>,
    /// `None` while the stand-down stands.
    pub stood_up_at: Option<i64>,
    /// Who lifted it, and on what argument. Both `None` while it stands, and
    /// both `None` on an episode lifted by a binary older than ISS-1238, which
    /// took no argument to record.
    pub stood_up_by: Option<String>,
    pub stood_up_why: Option<String>,
    /// When a master pane placed after the lift was told about this episode.
    /// `None` until one has been, and what stops the next pane being told the
    /// same gap again. It replaced deleting the row, which is what made the
    /// lifted half of the record unreadable a placement later.
    pub told_at: Option<i64>,
}

impl MasterStanding {
    /// Whether this episode withholds a pane right now.
    pub fn stands(&self) -> bool {
        self.stood_up_at.is_none()
    }

    /// What a reader is told in place of a reason that was never recorded.
    ///
    /// One sentence, here, because the CLI's standing line and the daemon's
    /// unplaced reason both have to say it and two wordings for one state is
    /// how a reader learns to distrust both.
    pub const NO_REASON: &'static str = "no reason was recorded — this predates the requirement";

    /// The reason this project was stood down, or the sentence that says none
    /// was recorded. Never an empty string and never nothing at all: a blank
    /// where a sentence belongs is what a reader cannot tell from a reason
    /// nobody thought to print.
    pub fn reason(&self) -> &str {
        self.why.as_deref().unwrap_or(Self::NO_REASON)
    }

    /// The argument this stand-down was lifted on, where it was lifted at all.
    pub fn lift_reason(&self) -> Option<&str> {
        self.stood_up_why.as_deref()
    }
}

/// What this box last established about the authority of one project's
/// resident master pane: whether the control capability that pane holds is one
/// this daemon can still resolve to the session core gives it (ISS-1099).
///
/// On disk rather than in the daemon's own registry because the state it
/// describes is produced by a restart. An in-process record of why a project
/// has no working master is erased by the very event that creates the state,
/// and the only account left was a journal line — which is what this issue's
/// Outcome says nobody should have to read.
///
/// A table of its own rather than columns on `masters`: that row is written
/// from one place, `control.rs:note_master_pane`, which is gated on the pane's
/// capability resolving. A pane in the state this records writes nothing there,
/// so a row that had to exist for the verdict to be kept would have to invent
/// the `pane_name` and `boot_id` it declares NOT NULL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterAuthority {
    pub project_id: String,
    pub slug: String,
    /// The pane the verdict was reached about.
    pub pane_name: String,
    /// Which incarnation of that name was running, as tmux's own opaque
    /// answer: the name is derived from the slug and every incarnation carries
    /// it, so the name alone identifies nothing. `None` where tmux could not be
    /// asked at the moment the verdict was reached, which is not the same as a
    /// pane that has just started — a reader that finds it `None` says it
    /// cannot tell rather than guessing either way.
    pub pane_incarnation: Option<String>,
    /// `current`, `stale` or `unknown` — the three `capability_of` answers, kept
    /// three here for the same reason they are kept three there.
    pub verdict: String,
    /// Why the answer is `unknown`, and `None` on the other two.
    pub detail: Option<String>,
    /// When this verdict was first reached. A sweep reaching the same verdict
    /// again leaves it alone, so it answers "how long has this stood".
    pub since: i64,
    pub seen_at: i64,
}

impl MasterAuthority {
    /// Some capability this box minted names the session core gives it.
    pub const CURRENT: &'static str = "current";
    /// None does, so every frame that pane sends is refused.
    pub const STALE: &'static str = "stale";
    /// This box could not read its own capability map, which is evidence about
    /// the map and not about any pane.
    pub const UNKNOWN: &'static str = "unknown";

    /// How long this verdict has stood, at the moment it was last confirmed.
    pub fn held_for(&self) -> Duration {
        Duration::from_secs(self.seen_at.saturating_sub(self.since).max(0) as u64)
    }
}

/// One issue's membership in a run, and whether its lease came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Membership {
    pub issue_key: String,
    pub lease_returned_at: Option<i64>,
}

/// What a group creation carries. A group of one is a group.
#[derive(Debug, Clone)]
pub struct NewRun {
    pub run_id: String,
    pub project_id: String,
    pub master_session_id: String,
    pub worktree_path: PathBuf,
    pub boot_id: String,
    pub issue_keys: Vec<String>,
}

/// The ledger, open on one box.
pub struct Ledger {
    conn: Connection,
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sql_err(e: rusqlite::Error) -> Error {
    Error::Other(format!("ledger: {e}"))
}

/// The refusal's four fields, set back to the state of a run nothing has
/// refused. Written once so the two verbs that clear them cannot drift.
const CLEAR_REFUSAL: &str = "release_refused_at = NULL, release_refusal = NULL,
        release_terminal_at = NULL, release_attempts = 0";

const SELECT_RUN: &str = "SELECT run_id, project_id, master_session_id, session_id, worktree_path, pid, boot_id,
        incarnation, work, blocker_kind, waiting_on, resume_id, session_terminal_at, worktree_gone_at,
        released_as, ended_by, ended_reason, agent_id, resume_choice, resume_choice_why, resume_owed_at,
        release_refused_at, release_refusal, release_terminal_at, release_attempts,
        turn_ended_at_ms, agent_transcript, kept_notice, created_at, host_ended_at_ms,
        host_ended_by, host_pid, host_start, close_refused_at, close_refusal
 FROM runs";

/// Every read of an episode selects these columns in this order, so one mapper
/// answers for all of them and a column added later cannot reach one reader and
/// miss another.
const SELECT_STANDING: &str = "SELECT episode, project_id, slug, stood_down_at, stood_down_by, why,
        stood_up_at, stood_up_by, stood_up_why, told_at
 FROM master_standing";

fn map_standing(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterStanding> {
    Ok(MasterStanding {
        episode: row.get(0)?,
        project_id: row.get(1)?,
        slug: row.get(2)?,
        stood_down_at: row.get(3)?,
        stood_down_by: row.get(4)?,
        why: row.get(5)?,
        stood_up_at: row.get(6)?,
        stood_up_by: row.get(7)?,
        stood_up_why: row.get(8)?,
        told_at: row.get(9)?,
    })
}

fn map_authority(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterAuthority> {
    Ok(MasterAuthority {
        project_id: row.get(0)?,
        slug: row.get(1)?,
        pane_name: row.get(2)?,
        pane_incarnation: row.get(3)?,
        verdict: row.get(4)?,
        detail: row.get(5)?,
        since: row.get(6)?,
        seen_at: row.get(7)?,
    })
}

fn map_master_pass(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterPass> {
    Ok(MasterPass {
        project_id: row.get(0)?,
        session_id: row.get(1)?,
        pass_id: row.get(2)?,
        verb: row.get(3)?,
        issue_key: row.get(4)?,
        opened_at: row.get(5)?,
        opened_by: row.get(6)?,
        turns_at_nudge: row.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
    })
}

fn map_master(row: &rusqlite::Row<'_>) -> rusqlite::Result<MasterRow> {
    Ok(MasterRow {
        project_id: row.get(0)?,
        pane_name: row.get(1)?,
        conversation_id: row.get(2)?,
        session_id: row.get(3)?,
        boot_id: row.get(4)?,
        cold_started_at: row.get(5)?,
        last_seen_at: row.get(6)?,
        placed_build: row.get(7)?,
        placed_plugins: row.get(8)?,
        placed_at: row.get(9)?,
        outdated: row.get(10)?,
        unattributed: row.get(11)?,
        placed_inputs: row.get(12)?,
    })
}

fn map_run(row: &rusqlite::Row<'_>) -> rusqlite::Result<Run> {
    Ok(Run {
        run_id: row.get(0)?,
        project_id: row.get(1)?,
        master_session_id: row.get(2)?,
        session_id: row.get(3)?,
        worktree_path: PathBuf::from(row.get::<_, String>(4)?),
        pid: row.get::<_, Option<i64>>(5)?.map(|p| p as u32),
        boot_id: row.get(6)?,
        incarnation: match row.get::<_, String>(7)?.as_str() {
            "live" => Incarnation::Live,
            "starting" => Incarnation::Starting,
            _ => Incarnation::Exited,
        },
        work: match row.get::<_, String>(8)?.as_str() {
            "runnable" => Work::Runnable,
            "blocked" => Work::Blocked,
            _ => Work::Done,
        },
        blocker_kind: row
            .get::<_, Option<String>>(9)?
            .and_then(|s| match s.as_str() {
                "machine" => Some(BlockerKind::Machine),
                "master_or_peer" => Some(BlockerKind::MasterOrPeer),
                "human" => Some(BlockerKind::Human),
                "nobody" => Some(BlockerKind::Nobody),
                _ => None,
            }),
        waiting_on: row.get(10)?,
        session_terminal_at: row.get(12)?,
        worktree_gone_at: row.get(13)?,
        released_as: row.get(14)?,
        ended_by: row.get(15)?,
        ended_reason: row.get(16)?,
        agent_id: row.get(17)?,
        resume_choice: row.get(18)?,
        resume_choice_why: row.get(19)?,
        release_refused_at: row.get(21)?,
        release_refusal: row.get(22)?,
        release_terminal_at: row.get(23)?,
        turn_ended_at_ms: row.get(25)?,
        agent_transcript: row.get(26)?,
        created_at: row.get(28)?,
        host_ended_at_ms: row.get(29)?,
        host_ended_by: row.get(30)?,
        host_pid: row.get::<_, Option<i64>>(31)?.map(|p| p as u32),
        host_start: row.get(32)?,
        close_refused_at: row.get(33)?,
        close_refusal: row.get(34)?,
    })
}

/// How a run came to stop holding a checkout it owed back.
///
/// Two facts that one timestamp used to carry between them, told apart because
/// only one of them means a directory left the disk. Each is READ BACK off the
/// world by the close loop and never inferred from the verb having run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckoutReturn {
    /// Git registers no worktree at the path and the path holds none. The
    /// checkout is off the disk, so `worktree_gone_at` is stamped with it.
    Gone,
    /// The path is the repository's own MAIN working tree. The run never took
    /// it from the pool and it has to outlive the run, so nothing was removed
    /// and `worktree_gone_at` is NOT stamped (ISS-1183).
    MainWorkingTreeKept,
}

impl CheckoutReturn {
    pub fn wire(self) -> &'static str {
        match self {
            Self::Gone => "gone",
            Self::MainWorkingTreeKept => "main_working_tree_kept",
        }
    }
}

impl Ledger {
    /// The name an older `master_standing` is parked under while the episode
    /// table is created beside it.
    const STANDING_BEFORE_EPISODES: &'static str = "master_standing_one_row_per_project";
}
