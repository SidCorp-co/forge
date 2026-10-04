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

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

use crate::error::{Error, Result};

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

/// The first eight characters of an id, which is how a session is named in
/// what this box writes for a person.
pub fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
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
    pub prompts_at_nudge: Option<u64>,
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

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
  run_id              TEXT PRIMARY KEY,
  project_id          TEXT,
  master_session_id   TEXT NOT NULL,
  session_id          TEXT,
  worktree_path       TEXT NOT NULL,
  pid                 INTEGER,
  boot_id             TEXT NOT NULL,
  incarnation         TEXT NOT NULL,
  work                TEXT NOT NULL,
  blocker_kind        TEXT,
  waiting_on          TEXT,
  resume_id           TEXT,
  park_deadline_at    INTEGER,
  session_terminal_at INTEGER,
  worktree_gone_at    INTEGER,
  released_as         TEXT,
  claim_owner         TEXT,
  claim_generation    INTEGER NOT NULL DEFAULT 0,
  claim_expires_at    INTEGER,
  revival_token       TEXT,
  revival_deadline_at INTEGER,
  ended_by            TEXT,
  ended_reason        TEXT,
  created_at          INTEGER NOT NULL,
  agent_id            TEXT,
  resume_choice       TEXT,
  resume_choice_why   TEXT,
  resume_owed_at      INTEGER,
  release_refused_at  INTEGER,
  release_refusal     TEXT,
  release_terminal_at INTEGER,
  release_attempts    INTEGER NOT NULL DEFAULT 0,
  turn_ended_at_ms    INTEGER,
  agent_transcript    TEXT,
  kept_notice         TEXT,
  host_ended_at_ms    INTEGER,
  host_ended_by       TEXT,
  host_pid            INTEGER,
  host_start          TEXT,
  refusal_wrote_ending INTEGER
);
CREATE TABLE IF NOT EXISTS run_issues (
  run_id            TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  issue_key         TEXT NOT NULL,
  lease_returned_at INTEGER,
  PRIMARY KEY (run_id, issue_key)
);
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  round       INTEGER NOT NULL,
  asked_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  verb        TEXT NOT NULL,
  decided_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS masters (
  project_id      TEXT PRIMARY KEY,
  pane_name       TEXT NOT NULL,
  conversation_id TEXT,
  session_id      TEXT,
  boot_id         TEXT NOT NULL,
  cold_started_at INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS master_standing (
  episode       INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    TEXT NOT NULL,
  slug          TEXT NOT NULL,
  stood_down_at INTEGER NOT NULL,
  stood_down_by TEXT NOT NULL,
  why           TEXT,
  stood_up_at   INTEGER,
  stood_up_by   TEXT,
  stood_up_why  TEXT,
  told_at       INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS master_standing_open
  ON master_standing (project_id) WHERE stood_up_at IS NULL;
CREATE TABLE IF NOT EXISTS master_passes (
  project_id       TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  pass_id          TEXT NOT NULL,
  verb             TEXT NOT NULL,
  issue_key        TEXT,
  opened_at        INTEGER NOT NULL,
  opened_by        TEXT NOT NULL,
  prompts_at_nudge INTEGER
);
CREATE TABLE IF NOT EXISTS master_authority (
  project_id      TEXT PRIMARY KEY,
  slug            TEXT NOT NULL,
  pane_name       TEXT NOT NULL,
  pane_incarnation TEXT,
  verdict         TEXT NOT NULL,
  detail          TEXT,
  since           INTEGER NOT NULL,
  seen_at         INTEGER NOT NULL
);
";

/// Columns a build added after the table shipped, by table. A ledger written by
/// an older binary gains them on open, so an upgraded box reads rather than
/// fails.
const ADDED_COLUMNS: &[(&str, &str, &str)] = &[
    ("runs", "project_id", "TEXT"),
    ("runs", "claim_owner", "TEXT"),
    ("runs", "claim_generation", "INTEGER NOT NULL DEFAULT 0"),
    ("runs", "claim_expires_at", "INTEGER"),
    ("runs", "revival_token", "TEXT"),
    ("runs", "revival_deadline_at", "INTEGER"),
    ("runs", "ended_by", "TEXT"),
    ("runs", "ended_reason", "TEXT"),
    ("runs", "agent_id", "TEXT"),
    ("runs", "resume_choice", "TEXT"),
    ("runs", "resume_choice_why", "TEXT"),
    ("runs", "resume_owed_at", "INTEGER"),
    ("runs", "release_refused_at", "INTEGER"),
    ("runs", "release_refusal", "TEXT"),
    ("runs", "release_terminal_at", "INTEGER"),
    ("runs", "release_attempts", "INTEGER NOT NULL DEFAULT 0"),
    ("runs", "released_as", "TEXT"),
    ("runs", "turn_ended_at_ms", "INTEGER"),
    ("runs", "agent_transcript", "TEXT"),
    ("runs", "kept_notice", "TEXT"),
    ("runs", "host_ended_at_ms", "INTEGER"),
    ("runs", "host_ended_by", "TEXT"),
    ("runs", "host_pid", "INTEGER"),
    ("runs", "host_start", "TEXT"),
    ("runs", "refusal_wrote_ending", "INTEGER"),
    ("masters", "session_id", "TEXT"),
];

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
        released_as, claim_owner, claim_generation, claim_expires_at, revival_token, revival_deadline_at,
        ended_by, ended_reason, agent_id, resume_choice, resume_choice_why, resume_owed_at,
        release_refused_at, release_refusal, release_terminal_at, release_attempts,
        turn_ended_at_ms, agent_transcript, kept_notice, created_at, host_ended_at_ms,
        host_ended_by, host_pid, host_start
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
        prompts_at_nudge: row.get::<_, Option<i64>>(7)?.map(|n| n.max(0) as u64),
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
        ended_by: row.get(20)?,
        ended_reason: row.get(21)?,
        agent_id: row.get(22)?,
        resume_choice: row.get(23)?,
        resume_choice_why: row.get(24)?,
        release_refused_at: row.get(26)?,
        release_refusal: row.get(27)?,
        release_terminal_at: row.get(28)?,
        turn_ended_at_ms: row.get(30)?,
        agent_transcript: row.get(31)?,
        created_at: row.get(33)?,
        host_ended_at_ms: row.get(34)?,
        host_ended_by: row.get(35)?,
        host_pid: row.get::<_, Option<i64>>(36)?.map(|p| p as u32),
        host_start: row.get(37)?,
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
    /// Open (and migrate) the ledger at `path`, creating its directory.
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let conn = Connection::open(path).map_err(sql_err)?;
        Self::from_conn(conn)
    }

    /// `~/.local/share/forge-runner/ledger.sqlite` for the box's own daemon; `ledger.sqlite` in
    /// the config dir for a daemon run under a config dir of its own.
    pub fn default_path() -> Result<PathBuf> {
        let base = crate::config::base_dir()?;
        // cm:guard the OS data dir is per user, not per daemon: a second daemon reading it sweeps
        // the first one's runs and stamps them closed at its own core (ISS-10)
        if !crate::daemon::terminal::is_the_boxs_own_config_dir(&base) {
            return Ok(base.join("ledger.sqlite"));
        }
        let dir = dirs_next::data_dir()
            .ok_or_else(|| Error::Other("ledger: cannot resolve OS data dir".into()))?;
        Ok(dir.join("forge-runner").join("ledger.sqlite"))
    }

    /// Open the ledger at `path` for reading only: no migration, no directory
    /// created, and any write through it refused by SQLite. For a command an
    /// operator types, which must leave a live box's ledger as it found it.
    pub fn open_read_only(path: &Path) -> Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(sql_err)?;
        conn.busy_timeout(Duration::from_secs(2)).map_err(sql_err)?;
        Ok(Self { conn })
    }

    fn from_conn(mut conn: Connection) -> Result<Self> {
        conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
            .map_err(sql_err)?;
        Self::migrate(&mut conn)?;
        Ok(Self { conn })
    }

    /// Bring the ledger to this build's shape, under one write lock.
    ///
    /// The lock is the subject. Deciding which columns are missing and adding
    /// them are two statements, and one box has many openers of this one file:
    /// the daemon's start, its reaper tick, its control socket, its
    /// session-ledger tick, and every CLI call. On the first start after an
    /// upgrade they all migrate at once, and with no lock between the two
    /// statements each reads the old shape before any `ALTER` has landed — the
    /// winner adds the column and every other opener is refused `duplicate
    /// column name`, which is `Ledger::open` returning an error to callers that
    /// then do nothing for the life of the process (ISS-1201). `IMMEDIATE`
    /// takes the write lock before the first read, so a second opener waits the
    /// first out on the `busy_timeout` set above and then reads a table already
    /// at this build's shape, with nothing left to alter.
    ///
    /// One transaction over all three steps for the same reason the lock is
    /// taken at all: a migration that fails part-way leaves the shape its
    /// opener found, rather than one no build has a name for.
    fn migrate(conn: &mut Connection) -> Result<()> {
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_err)?;
        let carried = Self::set_aside_the_one_row_standing(&tx)?;
        tx.execute_batch(SCHEMA).map_err(sql_err)?;
        Self::add_missing_columns(&tx)?;
        Self::carry_the_old_mark_forward(&tx)?;
        Self::carry_the_refusal_ending_forward(&tx)?;
        Self::carry_the_standing_forward(&tx, carried)?;
        tx.commit().map_err(sql_err)
    }

    /// The name an older `master_standing` is parked under while the episode
    /// table is created beside it.
    const STANDING_BEFORE_EPISODES: &'static str = "master_standing_one_row_per_project";

    /// Move a pre-ISS-1238 `master_standing` out of the way, so `SCHEMA`'s
    /// `CREATE TABLE IF NOT EXISTS` builds the episode table rather than
    /// finding the old one and leaving it alone.
    ///
    /// Answers whether anything was parked, because the copy back has to know
    /// and `PRAGMA table_info` on a table that is not there is not an error.
    fn set_aside_the_one_row_standing(conn: &Connection) -> Result<bool> {
        let have = Self::column_names(conn, "master_standing")?;
        if have.is_empty() || have.iter().any(|c| c == "episode") {
            return Ok(false);
        }
        conn.execute_batch(&format!(
            "ALTER TABLE master_standing RENAME TO {};",
            Self::STANDING_BEFORE_EPISODES
        ))
        .map_err(|e| {
            Error::Other(format!(
                "ledger: the standing table could not be set aside for the episode log ({e})"
            ))
        })?;
        Ok(true)
    }

    /// Copy every parked row into the episode table and drop the parked table.
    ///
    /// Column for column, with no value invented and none dropped: an episode
    /// whose `why` is NULL keeps its NULL, because that emptiness is the only
    /// evidence that a stand-down could once be taken in silence, and one that
    /// was already lifted arrives with `told_at` NULL — under the old code a
    /// row that survived to be read here had not yet been told to a pane, since
    /// being told is what deleted it.
    fn carry_the_standing_forward(conn: &Connection, carried: bool) -> Result<()> {
        if !carried {
            return Ok(());
        }
        conn.execute_batch(&format!(
            "INSERT INTO master_standing
                (project_id, slug, stood_down_at, stood_down_by, why, stood_up_at)
             SELECT project_id, slug, stood_down_at, stood_down_by, why, stood_up_at
               FROM {parked};
             DROP TABLE {parked};",
            parked = Self::STANDING_BEFORE_EPISODES
        ))
        .map_err(|e| {
            // What the operator is told has to be the state they will actually
            // find. The whole migration runs in one immediate transaction, so
            // this failure rolls the rename back with it: the table is under
            // its own name again and `master_standing_one_row_per_project` is
            // not there to look in. Saying otherwise sends them hunting for a
            // table that never survived the error (F2 of the whole-set read).
            Error::Other(format!(
                "ledger: the standing rows this box already held could not be carried into the episode log ({e}). The whole migration is one transaction and it has rolled back, so `master_standing` is exactly as it was and no row was lost — this box is running a binary its ledger cannot be brought up to, and the ledger is safe to open with the older one"
            ))
        })?;
        Ok(())
    }

    pub fn create_run_group(&mut self, new: NewRun) -> Result<Run> {
        if new.issue_keys.is_empty() {
            return Err(Error::Other(
                "ledger: a run must carry at least one issue".into(),
            ));
        }
        let tx = self.conn.transaction().map_err(sql_err)?;
        for key in &new.issue_keys {
            if let Some(holder) = Self::live_run_holding(&tx, &new.project_id, key, &new.boot_id)? {
                return Err(Error::Other(match Self::host_ended_by(&tx, &holder)? {
                    Some(by) => format!(
                        "ledger: issue {key} is held by run {holder}, which is not running: the Claude Code process its subagent ran in is gone{}. {}",
                        match by.as_str() {
                            HOST_PANE_STARTED => ", and its master's pane has since been started again",
                            HOST_PANE_GONE => ", with the master pane this box read as gone",
                            _ => "",
                        },
                        // Only the session the row names may close it, so the
                        // refusal offers `run close` to that session alone: a
                        // cold-started successor is refused its close as
                        // another master's (ISS-1312 criteria 48 and 49).
                        if Self::master_of(&tx, &holder)?.as_deref() == Some(new.master_session_id.as_str()) {
                            format!("Close it with `forge-runner run close {holder}` to free the issue now; otherwise recovery releases it on the first recovery sweep after core calls that run's session over")
                        } else {
                            "Recovery releases it on the first recovery sweep after core calls that run's session over. It was declared under another master session, so nothing this master can do frees it sooner".to_string()
                        }
                    ),
                    // A row an older binary wrote records no project, so the
                    // key it holds is nobody's in particular: saying the issue
                    // belongs to it asserts a holder this box cannot establish
                    // (ISS-1352).
                    None if Self::project_of(&tx, &holder)?.is_none() => format!(
                        "ledger: issue {key} is held by live run {holder}, whose row records no project, so this box cannot tell whether that run's {key} is this project's issue or another's. It stays held until that run ends, and `forge-runner status` names it where no master answers for it"
                    ),
                    None => format!("ledger: issue {key} already belongs to live run {holder}"),
                }));
            }
        }
        let path = new.worktree_path.to_string_lossy().to_string();
        if let Some(holder) = Self::live_run_at_path(&tx, &path, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: worktree {path} is already held by live run {holder}"
            )));
        }
        if let Some(pending) = Self::unbound_run_of(&tx, &new.master_session_id, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: run {pending} is declared under this master and no subagent has bound it yet — close it before declaring another"
            )));
        }
        tx.execute(
            "INSERT INTO runs (run_id, project_id, master_session_id, worktree_path, pid, boot_id, incarnation, work, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                new.run_id,
                new.project_id,
                new.master_session_id,
                path,
                new.boot_id,
                Incarnation::Live.wire(),
                Work::Runnable.wire(),
                now()
            ],
        )
        .map_err(sql_err)?;
        for key in &new.issue_keys {
            tx.execute(
                "INSERT INTO run_issues (run_id, issue_key) VALUES (?1, ?2)",
                params![new.run_id, key],
            )
            .map_err(sql_err)?;
        }
        tx.commit().map_err(sql_err)?;
        self.run(&new.run_id)?
            .ok_or_else(|| Error::Other("ledger: run vanished after commit".into()))
    }

    /// The live run holding `issue_key` of `project_id`. An issue key names an
    /// issue only inside its project, so another project's ISS-533 is another
    /// issue. A row that records no project cannot be told apart and still
    /// holds.
    fn live_run_holding(
        tx: &rusqlite::Transaction<'_>,
        project_id: &str,
        issue_key: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            &format!(
                "SELECT r.run_id FROM runs r JOIN run_issues i ON i.run_id = r.run_id
                  WHERE i.issue_key = ?1 AND r.incarnation = 'live' AND r.boot_id = ?2
                    AND (r.project_id = ?3 OR r.project_id IS NULL)
                    AND NOT {CLOSED_BY_ITS_MARKS}
                  LIMIT 1"
            ),
            params![issue_key, boot_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    /// The master session `run_id`'s row answers to.
    fn master_of(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<Option<String>> {
        tx.query_row(
            "SELECT master_session_id FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    /// The project `run_id`'s row records, where it records one.
    fn project_of(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<Option<String>> {
        tx.query_row(
            "SELECT project_id FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql_err)
    }

    /// How this box saw the master pane of `run_id` end, where it has.
    fn host_ended_by(tx: &rusqlite::Transaction<'_>, run_id: &str) -> Result<Option<String>> {
        tx.query_row(
            "SELECT host_ended_by FROM runs
              WHERE run_id = ?1 AND host_ended_at_ms IS NOT NULL AND host_pid IS NOT NULL",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql_err)
    }

    fn unbound_run_of(
        tx: &rusqlite::Transaction<'_>,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT run_id FROM runs
              WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL
              ORDER BY created_at LIMIT 1",
            params![master_session_id, boot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    fn live_run_at_path(
        tx: &rusqlite::Transaction<'_>,
        path: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        let wanted = std::fs::canonicalize(path).ok();
        let mut stmt = tx
            .prepare(&format!(
                "SELECT r.run_id, r.worktree_path FROM runs r
                  WHERE r.incarnation = 'live' AND r.boot_id = ?1 AND NOT {CLOSED_BY_ITS_MARKS}"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql_err)?;
        for row in rows {
            let (run_id, held) = row.map_err(sql_err)?;
            if held == path {
                return Ok(Some(run_id));
            }
            if let (Some(w), Ok(h)) = (wanted.as_ref(), std::fs::canonicalize(&held)) {
                if &h == w {
                    return Ok(Some(run_id));
                }
            }
        }
        Ok(None)
    }

    pub fn held_worktrees(&self) -> Result<Vec<(PathBuf, String)>> {
        let mut stmt = self
            .conn
            // A checkout the release terminally refused to remove is not the
            // reaper's to remove either: the same refusal binds both, and
            // ending the run is what would otherwise hand it over (ISS-1188).
            //
            // `released_as IS NULL` narrows that to the refusals it was written
            // for. A run whose checkout git's registry says is back holds none
            // to protect, whatever its refusal said, and a settled refusal
            // (ISS-1242) stamps exactly that row — so without this the stamp
            // would tell the reaper to keep a checkout that is already gone.
            .prepare(
                "SELECT worktree_path, run_id FROM runs
                  WHERE ended_by IS NULL
                     OR (release_terminal_at IS NOT NULL AND released_as IS NULL)",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// One run by id.
    pub fn run(&self, run_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE run_id = ?1"),
                params![run_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every run whose close loop still has something owed.
    ///
    /// A run whose release was decided terminal leaves as soon as its leases
    /// are back, and not before: its checkout is staying on disk by decision,
    /// so `worktree_gone_at` will never be stamped and reading the three marks
    /// alone would keep answering "still owed" every sweep for ever. The leases
    /// are the half that must still be chased, because a lease nobody returns
    /// is an issue no run on this box can take (ISS-1188).
    ///
    /// A row whose three marks are all set but whose refusal was never decided
    /// is owed one more pass, and that disjunct is what gives it one: the rows
    /// ISS-1242 names were every one of them closed by the sweep AFTER their
    /// refusal, so a settle nothing selects them for settles nothing. The pass
    /// terminates because the settle stamps `release_terminal_at`, which the
    /// second clause then excludes on.
    pub fn unclosed_runs(&self) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE (session_terminal_at IS NULL OR released_as IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL)
                 OR (release_refused_at IS NOT NULL AND release_terminal_at IS NULL))
                 AND (release_terminal_at IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL))
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_run).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// The runs a master pane started now for `project_id` inherits: declared on
    /// this boot, not ended, and still holding the checkout they were given,
    /// whichever master session declared them (ISS-1312).
    pub fn inheritable_runs(&self, project_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE project_id = ?1 AND boot_id = ?2 AND ended_by IS NULL
                   AND released_as IS NULL AND release_terminal_at IS NULL
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![project_id, boot_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Every run no master on this box answers for, oldest first.
    ///
    /// The declaring session is compared with every `masters` row and not only
    /// its project's, because `run close` authorises by session alone: a run
    /// is answered for exactly when some pane's recorded session could close it.
    pub fn runs_no_master_answers_for(&self) -> Result<Vec<Unanswered>> {
        let ids: Vec<(String, bool, bool)> = {
            let mut stmt = self
                .conn
                .prepare(&format!(
                    "SELECT r.run_id, {CLOSED_BY_ITS_MARKS},
                            EXISTS (SELECT 1 FROM masters m
                                     WHERE m.project_id = r.project_id AND m.session_id IS NULL)
                       FROM runs r
                      WHERE r.ended_by IS NULL
                        AND NOT EXISTS (SELECT 1 FROM masters m WHERE m.session_id = r.master_session_id)
                      ORDER BY r.created_at, r.run_id"
                ))
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(sql_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_err)?
        };
        let mut out = Vec::with_capacity(ids.len());
        for (run_id, closed_by_its_marks, master_row_has_no_session) in ids {
            let Some(run) = self.run(&run_id)? else {
                continue;
            };
            out.push(Unanswered {
                issues: self.issues(&run_id)?,
                run,
                closed_by_its_marks,
                master_row_has_no_session,
            });
        }
        Ok(out)
    }

    /// End every run no master answers for that its marks already close, and
    /// answer the ones it ended.
    ///
    /// Such a row holds nothing — `live_run_holding` and `unclosed_runs` both
    /// pass over it — and no writer of `ended_by` ever reaches it: its master's
    /// close is refused to every pane, and recovery walks only `unclosed_runs`.
    /// On one box that left 51 rows open for up to six days (ISS-1355). The
    /// update repeats every guard of the selection in its own `WHERE`, so a
    /// row a pane took over, or whose project's master row lost its session,
    /// between the read and the write is left as the selection would leave it.
    pub fn end_closed_runs_no_master_answers_for(&self) -> Result<Vec<Unanswered>> {
        let mut ended = Vec::new();
        for u in self.runs_no_master_answers_for()? {
            if u.sweep_ends_it() && self.end_unanswered(&u)? {
                ended.push(u);
            }
        }
        Ok(ended)
    }

    /// End one run a read of [`Self::runs_no_master_answers_for`] found, if
    /// every guard that read applied still holds; answers whether it did.
    fn end_unanswered(&self, u: &Unanswered) -> Result<bool> {
        let reason = format!(
            "no master on this box can close it: it was declared under master session {}, which is no master session this box records, and its marks already close it — its session is over, its checkout was returned ({}) and every lease is back",
            short_id(&u.run.master_session_id),
            u.run.released_as.as_deref().unwrap_or("unrecorded")
        );
        let changed = self
            .conn
            .execute(
                &format!(
                    "UPDATE runs SET work = 'done', incarnation = 'exited',
                            ended_by = 'recovery', ended_reason = ?2
                      WHERE run_id = ?1 AND ended_by IS NULL AND project_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM masters m WHERE m.session_id = runs.master_session_id)
                        AND NOT EXISTS (SELECT 1 FROM masters m
                                         WHERE m.project_id = runs.project_id AND m.session_id IS NULL)
                        AND run_id IN (SELECT r.run_id FROM runs r WHERE r.run_id = ?1 AND {CLOSED_BY_ITS_MARKS})"
                ),
                params![u.run.run_id, reason],
            )
            .map_err(sql_err)?;
        Ok(changed == 1)
    }

    /// Record that the process the subagent of `run_id` lived in ended at
    /// `at_ms`, seen as `by`. Only a run with no process of its own is a
    /// subagent's, so a run with a pid is left alone. A new pane started is a
    /// later end than any before it and moves a mark already standing; a pane
    /// read gone on every sweep is the same end read again, and writes only
    /// where no mark stands. A row that records no process for its subagent is
    /// left alone: without one, nothing this box saw is that subagent's end.
    pub fn note_host_ended(&self, run_id: &str, at_ms: i64, by: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_ended_at_ms = ?2, host_ended_by = ?3
                  WHERE run_id = ?1 AND pid IS NULL AND ended_by IS NULL
                    AND host_pid IS NOT NULL
                    AND (?3 = ?4 OR host_ended_at_ms IS NULL)",
                params![run_id, at_ms, by, HOST_PANE_STARTED],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Record the Claude Code process `run_id`'s subagent runs in, as read above
    /// the process that just reported for it. The latest report stands, since a
    /// subagent resumed after its master was placed again runs in the new one.
    pub fn note_host(&self, run_id: &str, pid: u32, start: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_pid = ?2, host_start = ?3
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, pid, start],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Take back a [`HOST_PANE_GONE`] mark on an open run, because its master's
    /// pane has since read alive: the earlier read saw nothing end. A
    /// [`HOST_PANE_STARTED`] mark is a placement rather than a read of a pane,
    /// and stands (ISS-1312).
    pub fn withdraw_pane_gone(&self, run_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_ended_at_ms = NULL, host_ended_by = NULL
                  WHERE run_id = ?1 AND host_ended_by = ?2 AND ended_by IS NULL",
                params![run_id, HOST_PANE_GONE],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// A `SubagentStart` of this run's subagent at `at_ms`: it is running in a
    /// live process again, so an earlier end of its host no longer speaks for
    /// it. Where the lead's hook named where the subagent writes, that is kept
    /// too, so what it writes before its first stop can be heard.
    pub fn note_subagent_started(
        &self,
        run_id: &str,
        at_ms: i64,
        transcript: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET agent_transcript = COALESCE(?3, agent_transcript),
                        host_ended_by = CASE WHEN host_ended_at_ms <= ?2 THEN NULL
                                             ELSE host_ended_by END,
                        host_ended_at_ms = CASE WHEN host_ended_at_ms <= ?2 THEN NULL
                                                ELSE host_ended_at_ms END
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, at_ms, transcript],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn reparent_run(&mut self, run_id: &str, master_session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET master_session_id = ?2 WHERE run_id = ?1",
                params![run_id, master_session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_for_master(&self, master_session_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    pub fn attach_session(&self, run_id: &str, session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET session_id = ?2 WHERE run_id = ?1",
                params![run_id, session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn bind_agent(&self, run_id: &str, agent_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET agent_id = ?2
                  WHERE run_id = ?1 AND agent_id IS NULL
                    AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.agent_id = ?2)",
                params![run_id, agent_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// The run this master declared that no subagent has bound yet, if any.
    pub fn unbound_run_for_master(
        &self,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL ORDER BY created_at LIMIT 1"),
                params![master_session_id, boot_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn ended_with_open_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND ended_by IS NOT NULL AND session_id IS NOT NULL
                   AND session_terminal_at IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    pub fn declared_without_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND session_id IS NULL AND ended_by IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    /// The run bound to this subagent, if one is.
    pub fn run_for_agent(&self, agent_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE agent_id = ?1 AND ended_by IS NULL LIMIT 1"),
                params![agent_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn record_resume_choice(
        &self,
        run_id: &str,
        master_session_id: &str,
        choice: &str,
        why: &str,
    ) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_choice = ?3, resume_choice_why = ?4
                  WHERE run_id = ?1 AND master_session_id = ?2
                    AND resume_owed_at IS NOT NULL AND resume_choice IS NULL",
                params![run_id, master_session_id, choice, why],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn owe_resume_choices(&self, master_session_id: &str, boot_id: &str) -> Result<usize> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_owed_at = ?3
                  WHERE master_session_id = ?1 AND boot_id = ?2
                    AND ended_by IS NULL AND resume_choice IS NULL",
                params![master_session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(n)
    }

    pub fn choices_awaiting_report(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NOT NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn mark_resume_choice_said(&self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET resume_owed_at = NULL WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_awaiting_choice(&self, master_session_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id, boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn note_master(
        &self,
        project_id: &str,
        pane_name: &str,
        conversation_id: Option<&str>,
        session_id: Option<&str>,
        boot_id: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO masters (project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(project_id) DO UPDATE SET
                   pane_name       = excluded.pane_name,
                   conversation_id = COALESCE(excluded.conversation_id, masters.conversation_id),
                   session_id      = COALESCE(excluded.session_id, masters.session_id),
                   boot_id         = excluded.boot_id,
                   last_seen_at    = excluded.last_seen_at",
                params![project_id, pane_name, conversation_id, session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn open_master_pass(&self, pass: &MasterPass) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO master_passes (project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    pass.project_id,
                    pass.session_id,
                    pass.pass_id,
                    pass.verb,
                    pass.issue_key,
                    pass.opened_at,
                    pass.opened_by,
                    pass.prompts_at_nudge.map(|n| n as i64),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn master_passes(&self) -> Result<Vec<MasterPass>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge
                 FROM master_passes ORDER BY opened_at",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], map_master_pass)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn master_pass_for(&self, project_id: &str) -> Result<Option<MasterPass>> {
        self.conn
            .query_row(
                "SELECT project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge
                 FROM master_passes WHERE project_id = ?1",
                params![project_id],
                map_master_pass,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn renudge_master_pass(&self, pass_id: &str, prompts: Option<u64>) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE master_passes SET prompts_at_nudge = ?2 WHERE pass_id = ?1",
                params![pass_id, prompts.map(|n| n as i64)],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn closed_master_pass(&self, pass_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "DELETE FROM master_passes WHERE pass_id = ?1",
                params![pass_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn issues_declared_since(
        &self,
        master_session_id: &str,
        since: i64,
    ) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT i.issue_key FROM run_issues i JOIN runs r ON r.run_id = i.run_id
                 WHERE r.master_session_id = ?1 AND r.created_at >= ?2
                 ORDER BY i.issue_key",
            )
            .map_err(sql_err)?;
        let keys = stmt
            .query_map(params![master_session_id, since], |r| r.get(0))
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(sql_err)?;
        Ok(keys)
    }

    /// What this box knows about one project's master pane.
    pub fn master_for_project(&self, project_id: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at
                 FROM masters WHERE project_id = ?1",
                params![project_id],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The master row whose pane carries this name, which is how a command
    /// holding only a slug reaches the project id.
    pub fn master_for_pane(&self, pane_name: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at
                 FROM masters WHERE pane_name = ?1",
                params![pane_name],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Open an episode: this project's resident master is stood down until
    /// somebody stands it up again.
    ///
    /// `why` is a `&str` and not an `Option<&str>`, which is the whole of the
    /// requirement at this boundary: a caller with no reason to give cannot
    /// reach the table. Nothing else in this crate writes `master_standing`, so
    /// that signature is the constraint the column cannot carry — `why` stays
    /// nullable because the episodes an older binary wrote with no reason are
    /// migrated rather than rewritten, and SQLite will not hold a NOT NULL
    /// column over a row that already violates it (ISS-1238).
    ///
    /// Re-recording an already-standing stand-down updates the open episode
    /// rather than opening a second one, so the interval a pane is later told
    /// is the whole of it. The conflict target is the partial index over open
    /// episodes, which is also what keeps "at most one open episode per
    /// project" true in the table rather than only in this method.
    pub fn stand_down_master(
        &self,
        project_id: &str,
        slug: &str,
        by: &str,
        why: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO master_standing
                   (project_id, slug, stood_down_at, stood_down_by, why, stood_up_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(project_id) WHERE stood_up_at IS NULL DO UPDATE SET
                   slug          = excluded.slug,
                   stood_down_by = excluded.stood_down_by,
                   why           = excluded.why",
                params![project_id, slug, now(), by, why],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Close the open episode, recording who ended the wait and on what
    /// argument. Answers whether a standing stand-down was lifted.
    ///
    /// The argument is required for the same reason the reason is: a lift
    /// overrides somebody's deliberate stop, and the half a later reader needs
    /// most is why that stop was judged safe to reverse.
    pub fn stand_up_master(&self, project_id: &str, by: &str, why: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE master_standing
                    SET stood_up_at = ?2, stood_up_by = ?3, stood_up_why = ?4
                  WHERE project_id = ?1 AND stood_up_at IS NULL",
                params![project_id, now(), by, why],
            )
            .map_err(sql_err)?;
        Ok(changed > 0)
    }

    /// The latest standing episode for this project, standing or lifted.
    pub fn master_standing(&self, project_id: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                &format!("{SELECT_STANDING} WHERE project_id = ?1 ORDER BY episode DESC LIMIT 1"),
                params![project_id],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The latest standing episode for the project this box knows by this slug.
    ///
    /// Keyed by slug and not by project id because a command, and `status`,
    /// may hold only the slug — and a stand-down can be recorded for a project
    /// this box has never placed a master for, which is exactly the case a
    /// lookup going through the `masters` row cannot see.
    pub fn master_standing_for_slug(&self, slug: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                &format!("{SELECT_STANDING} WHERE slug = ?1 ORDER BY episode DESC LIMIT 1"),
                params![slug],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every episode this box has held for one project, newest first.
    ///
    /// What the append-only table is for: the current episode says what is
    /// being waited for, and the ones behind it say what the box was waiting
    /// for the last three times and what ended each wait.
    pub fn standing_history(&self, slug: &str) -> Result<Vec<MasterStanding>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_STANDING} WHERE slug = ?1 ORDER BY episode DESC"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![slug], map_standing)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// The latest episode for every project this box has ever held one for.
    pub fn standings(&self) -> Result<Vec<MasterStanding>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_STANDING}
                  WHERE episode IN (SELECT MAX(episode) FROM master_standing GROUP BY project_id)
                  ORDER BY slug"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_standing).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Record what this box has just established about a project's master
    /// pane authority.
    ///
    /// `since` moves only when the answer moves — a different verdict, or the
    /// same verdict about a different pane. A sweep that reaches the same
    /// verdict about the same pane refreshes `seen_at` alone, so the pair says
    /// how long this has stood rather than how recently it was looked at. That
    /// interval is the whole point: the incident this issue was filed from ran
    /// for four hours and nothing on the box could say so (ISS-1099).
    pub fn note_master_authority(
        &self,
        project_id: &str,
        slug: &str,
        pane: (&str, Option<&str>),
        verdict: &str,
        detail: Option<&str>,
    ) -> Result<()> {
        let (pane_name, pane_incarnation) = pane;
        self.conn
            .execute(
                "INSERT INTO master_authority (project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(project_id) DO UPDATE SET
                   slug            = excluded.slug,
                   pane_name       = excluded.pane_name,
                   pane_incarnation = excluded.pane_incarnation,
                   verdict         = excluded.verdict,
                   detail          = excluded.detail,
                   since           = CASE WHEN master_authority.verdict         =  excluded.verdict
                                           AND master_authority.pane_name       =  excluded.pane_name
                                           AND master_authority.pane_incarnation IS excluded.pane_incarnation
                                          THEN master_authority.since
                                          ELSE excluded.since END,
                   seen_at         = excluded.seen_at",
                params![project_id, slug, pane_name, pane_incarnation, verdict, detail, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// The authority verdict for the project this box knows by this slug.
    ///
    /// Keyed by slug for the reason `master_standing_for_slug` is: a command,
    /// and `master status`, may hold only the slug.
    pub fn master_authority_for_slug(&self, slug: &str) -> Result<Option<MasterAuthority>> {
        self.conn
            .query_row(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority WHERE slug = ?1",
                params![slug],
                map_authority,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every project this box holds an authority verdict about.
    pub fn authorities(&self) -> Result<Vec<MasterAuthority>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority ORDER BY slug",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_authority).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Stamp ONE lifted episode as told, once the pane it was kept for has been
    /// told the interval. A standing one is never stamped by this.
    ///
    /// By episode and not by project. A project can hold an older lifted
    /// episode no pane was ever placed for, and stamping every untold one
    /// because a later episode reached a pane would put a delivery on the
    /// record that never happened.
    ///
    /// This replaced a DELETE (ISS-1238). Deleting was enough while the row's
    /// only job was to carry an interval to the next pane; it also destroyed
    /// the one account of what the box had been waiting for and what ended the
    /// wait, one placement after the lift. The stamp does the same job — a pane
    /// is told once — and keeps the episode.
    pub fn note_standing_told(&self, project_id: &str, episode: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE master_standing SET told_at = ?3
                  WHERE project_id = ?1 AND episode = ?2
                    AND stood_up_at IS NOT NULL AND told_at IS NULL",
                params![project_id, episode, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Clear the conversation this project's next pane would resume, so it
    /// cold-starts instead.
    pub fn forget_master_conversation(&self, project_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE masters SET conversation_id = NULL WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn mark_session_terminal_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("session_terminal_at", run_id)
    }

    /// Record that the run no longer holds a checkout it owes back, and which
    /// of the two ways that came about.
    ///
    /// The one writer of both columns, so the pair cannot drift: `Gone` stamps
    /// `worktree_gone_at` as well, and `MainWorkingTreeKept` deliberately does
    /// not — the checkout is standing right there and a row saying otherwise
    /// is the state lying (ISS-1193).
    pub fn mark_checkout_returned_observed(&self, run_id: &str, how: CheckoutReturn) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET released_as = ?2 WHERE run_id = ?1 AND released_as IS NULL",
                params![run_id, how.wire()],
            )
            .map_err(sql_err)?;
        if how == CheckoutReturn::Gone {
            self.stamp("worktree_gone_at", run_id)?;
        }
        Ok(())
    }

    fn stamp(&self, column: &str, run_id: &str) -> Result<()> {
        debug_assert!(matches!(column, "session_terminal_at" | "worktree_gone_at"));
        self.conn
            .execute(
                &format!("UPDATE runs SET {column} = ?2 WHERE run_id = ?1 AND {column} IS NULL"),
                params![run_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn mark_lease_returned_observed(&self, run_id: &str, issue_key: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE run_issues SET lease_returned_at = ?3
                 WHERE run_id = ?1 AND issue_key = ?2 AND lease_returned_at IS NULL",
                params![run_id, issue_key, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>> {
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(1))
            .map_err(sql_err)?;
        let mut have = Vec::new();
        for r in rows {
            have.push(r.map_err(sql_err)?);
        }
        Ok(have)
    }

    /// Bring a ledger written by an earlier build up to this build's shape.
    ///
    /// Named by table rather than assuming `runs`: `masters` gained a column
    /// too, and a migration that can only reach one table would have left an
    /// upgraded box unable to say which runs its resident master holds.
    fn add_missing_columns(conn: &Connection) -> Result<()> {
        let mut known: Vec<(&str, Vec<String>)> = Vec::new();
        for (table, name, ty) in ADDED_COLUMNS {
            if !known.iter().any(|(t, _)| t == table) {
                known.push((table, Self::column_names(conn, table)?));
            }
            let have = known
                .iter_mut()
                .find(|(t, _)| t == table)
                .map(|(_, c)| c)
                .expect("the table's columns were just read");
            if !have.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {name} {ty};"))
                    .map_err(|e| {
                        Error::Other(format!(
                            "ledger: {table}.{name} is missing and could not be added ({e})"
                        ))
                    })?;
                have.push((*name).to_string());
            }
        }
        Ok(())
    }

    /// Give every row an earlier build closed the new fact's value.
    ///
    /// `released_as` is what the close loop now reads for its third mark, and
    /// a ledger upgraded in place holds runs whose only record of that mark is
    /// the old timestamp. Left alone they would read as still holding a
    /// checkout and go back in front of the sweep — a fix that reopens every
    /// run it inherits is a worse defect than the one it closes.
    ///
    /// `gone` is what those rows said and all they said. The one case that
    /// deserves `main_working_tree_kept` is indistinguishable here, because
    /// the build that wrote them could not tell the two apart — that being
    /// this issue. It is not guessed at; a row wrongly reading `gone` over a
    /// main checkout is the state the upgrade found, carried across unchanged
    /// rather than invented, and the next release of that run writes the fact
    /// it reads off git.
    fn carry_the_old_mark_forward(conn: &Connection) -> Result<()> {
        conn.execute(
            "UPDATE runs SET released_as = 'gone'
              WHERE released_as IS NULL AND worktree_gone_at IS NOT NULL",
            [],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    /// Say which decided refusals wrote their run's ending, on rows a build
    /// before `refusal_wrote_ending` decided. That build's
    /// `conclude_release_refusal` always wrote the ending, from the same text
    /// it kept as the refusal, and `settle_release_refusal` wrote none, so a
    /// decided row whose reason is its refusal is exactly one it ended. Only
    /// rows the column has never been written on are read: every decision this
    /// build takes writes it.
    fn carry_the_refusal_ending_forward(conn: &Connection) -> Result<()> {
        conn.execute(
            "UPDATE runs SET refusal_wrote_ending = 1
              WHERE refusal_wrote_ending IS NULL
                AND release_terminal_at IS NOT NULL
                AND ended_by IS NOT NULL
                AND ended_reason IS release_refusal",
            [],
        )
        .map_err(sql_err)?;
        Ok(())
    }

    pub fn liveness(run: &Run, this_boot: &str, pid_refuted: bool) -> Liveness {
        if run.boot_id != this_boot {
            return Liveness::Unknown;
        }
        match (run.incarnation, run.pid) {
            (Incarnation::Live | Incarnation::Starting, Some(_)) if !pid_refuted => Liveness::Alive,
            (Incarnation::Live | Incarnation::Starting, Some(_)) => Liveness::Dead,
            (Incarnation::Exited, _) => Liveness::Dead,
            (_, None) => Liveness::Unknown,
        }
    }

    /// Close a run on the record, with who ended it and why.
    /// Record that this run's release was refused, and answer WHEN the streak
    /// it belongs to began — which is this refusal's own stamp where it is the
    /// first, and the earlier one where it is not.
    ///
    /// The stamp is in the ledger rather than in the daemon's memory so that a
    /// restart inside the window resumes the refusal's age instead of starting
    /// it again, which is how a run kept its leases across restarts for as long
    /// as the box lived.
    ///
    /// A stamp LATER than the clock now reading it is a clock that moved
    /// backwards — ntp correcting a box that booted with a bad RTC is the
    /// ordinary way — and it is pulled back to now rather than kept. Kept, it
    /// would put the end of the window that many seconds further away every
    /// sweep until the clock caught up. The other direction is left alone: a
    /// clock jumping FORWARD past the window decides the refusal early, and
    /// early is the safe end of that trade — the leases come back and the
    /// checkout is untouched.
    ///
    /// Neither of those is what makes the window END, though, because a clock
    /// corrected backwards again and again is a clock that can hold any
    /// deadline off for ever. The attempt count is: it only ever goes up, no
    /// correction reaches it, and it is what decides a refusal on a box whose
    /// clock cannot be trusted at all.
    pub fn note_release_refusal(&mut self, run_id: &str, why: &str, at: i64) -> Result<Refusal> {
        self.conn
            .execute(
                "UPDATE runs SET release_refusal = ?2,
                        release_refused_at = MIN(COALESCE(release_refused_at, ?3), ?3),
                        release_attempts = release_attempts + 1
                  WHERE run_id = ?1",
                params![run_id, why, at],
            )
            .map_err(sql_err)?;
        let row: Option<(Option<i64>, i64)> = self
            .conn
            .query_row(
                "SELECT release_refused_at, release_attempts FROM runs WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_err)?;
        let (since, attempts) = row.unwrap_or((Some(at), 1));
        let since = since.unwrap_or(at);
        Ok(Refusal {
            since,
            attempts,
            opened_the_streak: attempts <= 1,
        })
    }

    /// Say this refusal is one no retry gets past, and end the run over it,
    /// where nothing ended it before. An ending already on the row stands, as
    /// [`Ledger::end_run`] keeps it: a master's `run close` whose release is
    /// then refused is still the master's (ISS-1312 criterion 74).
    /// `refusal_wrote_ending` says which of the two it was, so a retraction
    /// takes back only an ending this decision wrote.
    ///
    /// One transaction, because the two halves are one decision: a box that
    /// stopped between them would come back holding a run that no sweep picks
    /// up — `release_terminal_at` takes it off the release path — and that no
    /// sweep finishes either, because `ended_by` is still unset. That is a
    /// wedged run again, wearing the mark that was meant to end one.
    pub fn conclude_release_refusal(
        &mut self,
        run_id: &str,
        at: i64,
        ended_by: &str,
        reason: &str,
    ) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        tx.execute(
            "UPDATE runs SET release_terminal_at = ?2, work = 'done', incarnation = 'exited',
                    refusal_wrote_ending = CASE WHEN ended_by IS NULL THEN 1 ELSE 0 END,
                    ended_reason = CASE WHEN ended_by IS NULL THEN ?4 ELSE ended_reason END,
                    ended_by = COALESCE(ended_by, ?3)
              WHERE run_id = ?1",
            params![run_id, at, ended_by, reason],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    /// Say a standing refusal was overtaken by the world rather than decided,
    /// and answer whether there was one to settle.
    ///
    /// A refusal is decided by [`Ledger::conclude_release_refusal`] when the
    /// same refusal is taken again past its window or its attempt bound. It is
    /// forgotten by [`Ledger::forget_release_refusal`] when a later release
    /// gets through. Neither fires when the thing the refusal was about stops
    /// being true on its own — a master pruning the worktree a minute after the
    /// release was refused over it, which is `f0c38b4e` — and the row then
    /// keeps `release_refused_at` with a null `release_terminal_at` for ever,
    /// so the ledger reports a refusal that was never decided and the question
    /// "which runs are stranded" has no answer from the row (ISS-1242).
    ///
    /// `release_refusal` is kept verbatim, because what was refused is still
    /// the fact and an operator reading the row is owed it. The ending is left
    /// alone too: another path may already have written one, and this verb
    /// has no ending of its own to give.
    pub fn settle_release_refusal(&mut self, run_id: &str, at: i64) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET release_terminal_at = ?2, refusal_wrote_ending = 0
                  WHERE run_id = ?1
                    AND release_refused_at IS NOT NULL
                    AND release_terminal_at IS NULL",
                params![run_id, at],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Forget a refusal a release got past. The run's own ending, if it has
    /// one, is not this verb's business: a release that succeeded ended the run
    /// on purpose.
    pub fn forget_release_refusal(&mut self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                &format!("UPDATE runs SET {CLEAR_REFUSAL} WHERE run_id = ?1"),
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Take back the decision that a run's release could not be made, so the
    /// next sweep attempts it again. Answers whether there was one to take back.
    ///
    /// The ending goes with it, in the same transaction, where the decision
    /// wrote it, because it was PART of that decision. Left in place it would
    /// say the run is over while its release is owed again — and
    /// `held_worktrees` reads exactly that to decide what the reaper may not
    /// touch, so the checkout being kept for the retry would stop being kept
    /// the moment an operator asked for one. An ending the decision found on
    /// the row, such as a master's `run close`, is not the decision's to take
    /// back, and the run returns to the state it was in before its release was
    /// refused (ISS-1312 criterion 74).
    pub fn retract_release_refusal(&mut self, run_id: &str) -> Result<bool> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        let n = tx
            .execute(
                &format!(
                    "UPDATE runs SET {CLEAR_REFUSAL},
                            ended_by = CASE WHEN refusal_wrote_ending = 1 THEN NULL ELSE ended_by END,
                            ended_reason = CASE WHEN refusal_wrote_ending = 1 THEN NULL ELSE ended_reason END,
                            refusal_wrote_ending = NULL
                      WHERE run_id = ?1
                        AND (release_refused_at IS NOT NULL OR release_terminal_at IS NOT NULL)"
                ),
                params![run_id],
            )
            .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(n == 1)
    }

    /// A subagent run's subagent ended a turn. The run stays open: only its
    /// master's close or its master's death ends a subagent run (ISS-1246).
    ///
    /// The newest stop wins, so a replayed or reordered hook cannot move the
    /// time back; `transcript` is kept where a frame names none; and a notice
    /// already given is cleared only by a stop newer than the one it was about,
    /// so a replayed stop cannot have the same silence said twice.
    pub fn note_turn_end(
        &self,
        run_id: &str,
        at_ms: i64,
        transcript: Option<&str>,
    ) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET turn_ended_at_ms = MAX(COALESCE(turn_ended_at_ms, ?2), ?2),
                        agent_transcript = COALESCE(?3, agent_transcript),
                        kept_notice = CASE WHEN turn_ended_at_ms IS NULL OR ?2 > turn_ended_at_ms
                                           THEN NULL ELSE kept_notice END
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, at_ms, transcript],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Record what the box said about keeping a subagent run open. True only
    /// where this notice was not already the one standing, which is what lets
    /// the caller say it once rather than on every sweep.
    pub fn note_kept(&self, run_id: &str, notice: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET kept_notice = ?2
                  WHERE run_id = ?1 AND ended_by IS NULL AND kept_notice IS NOT ?2",
                params![run_id, notice],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Record what the sweep last said about why an unclosed run stands, and
    /// answer whether that is new. Unlike [`Ledger::note_kept`] it holds for an
    /// ended run too: a run that ended under another boot is still standing,
    /// and is exactly the one whose standing must be said once and not for
    /// ever (ISS-1220).
    pub fn note_standing(&self, run_id: &str, notice: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET kept_notice = ?2 WHERE run_id = ?1 AND kept_notice IS NOT ?2",
                params![run_id, notice],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// End a run. The first ending recorded stands: a release that follows a
    /// master's `run close` finishes the run and leaves who ended it and why,
    /// where it wrote its own over the close (ISS-1312 criterion 74, run
    /// 172f356e).
    pub fn end_run(&self, run_id: &str, ended_by: &str, reason: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET work = 'done', incarnation = 'exited',
                        ended_reason = CASE WHEN ended_by IS NULL THEN ?3 ELSE ended_reason END,
                        ended_by = COALESCE(ended_by, ?2)
                 WHERE run_id = ?1",
                params![run_id, ended_by, reason],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn issues(&self, run_id: &str) -> Result<Vec<Membership>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT issue_key, lease_returned_at FROM run_issues WHERE run_id = ?1 ORDER BY issue_key",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok(Membership {
                    issue_key: row.get(0)?,
                    lease_returned_at: row.get(1)?,
                })
            })
            .map_err(sql_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_err)
    }
}
