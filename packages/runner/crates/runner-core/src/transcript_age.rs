//! When a session last wrote anything to its own conversation transcript.
//!
//! `agent_activity` hears boundaries, and nothing it registers fires while a
//! lead's turn runs on tools alone, so a lead whose `Stop` was lost and a lead
//! three hours into one long turn read identically there (ISS-1244). The
//! transcript tells them apart: Claude Code appends to it with every message
//! and every tool result, and a foreground child writes its own beside it under
//! `<conversation>/subagents/`, so a turn that is running moves one of those
//! files and a turn whose end was lost moves none of them.
//!
//! This is the evidence and nothing else. How long a reader waits on its
//! silence is that reader's policy (`job_exit`, and core's run verdict).

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// The newest write, in wall-clock ms, to the transcript at `path` or to any
/// child transcript of the same conversation. `None` where none of them can be
/// read: no evidence, which a caller must never read as silence.
pub fn last_written(path: &Path) -> Option<i64> {
    let lead = modified_ms(path);
    let children = path
        .file_stem()
        .zip(path.parent())
        .map(|(stem, dir)| dir.join(stem).join("subagents"))
        .and_then(|dir| std::fs::read_dir(dir).ok())
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
        .filter_map(|p| modified_ms(&p))
        .max();
    lead.max(children)
}

/// Where the subagent `agent_id` of the conversation written at `lead` keeps
/// its own transcript: the `<conversation>/subagents/` directory
/// [`last_written`] reads children from. `None` for a lead with no stem, or an
/// id that is not a plain name, since it becomes part of a path.
pub fn child_transcript(lead: &Path, agent_id: &str) -> Option<PathBuf> {
    let plain = !agent_id.is_empty()
        && agent_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !plain {
        return None;
    }
    let (stem, dir) = lead.file_stem().zip(lead.parent())?;
    Some(
        dir.join(stem)
            .join("subagents")
            .join(format!("agent-{agent_id}.jsonl")),
    )
}

/// The newest write, in wall-clock ms, to the one file at `path`. `None` where
/// it cannot be read, which is no evidence and never silence.
pub fn written_at(path: &Path) -> Option<i64> {
    modified_ms(path)
}

/// How much of a transcript's end [`newest_entry`] reads first.
const TAIL_BYTES: u64 = 64 * 1024;

/// The widest end [`newest_entry`] reads before an entry it has not read
/// whole is taken as a turn. 1,491 of 146,876 user entries on this box were
/// longer than [`TAIL_BYTES`], and the longest 1.3 MB (ISS-1312).
const TAIL_CAP: u64 = 4 * 1024 * 1024;

/// The attachments Claude Code writes beside a `user` entry, carrying context
/// for the reply rather than being written by a turn: 19 ms after
/// ISS-553/554's notification, `instructions` and `session_context`, after a
/// tool's result a `total_tokens_reminder`, and a `deferred_tools_record`
/// after either. The only kinds other than a hook record that end any of this
/// box's 1098 subagent transcripts, and of the 1,185 read 2026-09-28 every
/// `deferred_tools_record` stands after a `user` entry, 9,355 of them past a
/// `total_tokens_reminder` (ISS-1312). A kind not named here is never read
/// past, so a `queued_command` beside a user entry, itself a request, holds.
const CONTEXT_KINDS: [&str; 4] = [
    "instructions",
    "session_context",
    "total_tokens_reminder",
    "deferred_tools_record",
];

/// What the newest entry in a subagent's transcript is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Newest {
    /// A record a `SubagentStop` hook left.
    ///
    /// Claude Code appends one such record per hook once the hook returns,
    /// which is after the box stamped the stop, so a subagent's transcript is
    /// always written after the stop it records — 120 to 210 ms after, on both
    /// runs ISS-1312 measured. Read by its time alone, that write is a resumed
    /// turn, and every finished subagent held every restart until its master
    /// closed it.
    StopRecord,
    /// A `user` entry — a prompt, a notification, a tool's result — which is
    /// the model's to answer, with nothing after it but the context written
    /// beside it ([`CONTEXT_KINDS`]). A turn that takes one up writes its reply
    /// promptly: measured over this box's 1075 subagent transcripts
    /// 2026-09-28, 277 notifications were each answered within 29 s and
    /// 145,297 answered entries within 20 min. One nobody answers is left by a
    /// background task that finished after its subagent stopped (ISS-1312).
    AwaitingReply,
    /// Anything else, or an entry that does not parse: a turn wrote it.
    Turn,
}

/// The newest entry in the transcript at `path`, read past the context
/// written beside a `user` entry. `None` where the file cannot be opened or
/// read, which says nothing about what was written.
pub fn newest_entry(path: &Path) -> Option<Newest> {
    read_back(path, decide, Newest::Turn)
}

/// What `tail` says the newest entry is, or `None` where the entry that
/// decides begins before it. Unless the tail is the `whole` file its first
/// line may be cut where the read began, so it is never read.
fn decide(tail: &str, whole: bool) -> Option<Newest> {
    let mut lines = tail.lines();
    if !whole {
        lines.next();
    }
    let mut under_context = false;
    for line in lines.rev().filter(|l| !l.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            return Some(Newest::Turn);
        };
        let attachment = &entry["attachment"];
        let is_attachment = entry["type"] == "attachment";
        if is_attachment
            && attachment["hookEvent"].is_null()
            && CONTEXT_KINDS.iter().any(|kind| attachment["type"] == *kind)
        {
            under_context = true;
            continue;
        }
        return Some(if entry["type"] == "user" {
            Newest::AwaitingReply
        } else if is_attachment && attachment["hookEvent"] == "SubagentStop" && !under_context {
            Newest::StopRecord
        } else {
            Newest::Turn
        });
    }
    whole.then_some(Newest::Turn)
}

fn modified_ms(path: &Path) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let ms = meta
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis();
    i64::try_from(ms).ok()
}

/// Read the end of the transcript at `path` in widening windows until
/// `decide` answers, or answer `fallback` once the whole file or
/// [`TAIL_CAP`] has been read without one. `None` where the file cannot be
/// opened or read.
fn read_back<T>(path: &Path, decide: fn(&str, bool) -> Option<T>, fallback: T) -> Option<T> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut window = TAIL_BYTES;
    loop {
        let start = len.saturating_sub(window);
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail).ok()?;
        let whole = start == 0;
        if let Some(found) = decide(&String::from_utf8_lossy(&tail), whole) {
            return Some(found);
        }
        if whole || window >= TAIL_CAP {
            return Some(fallback);
        }
        window = (window * 4).min(TAIL_CAP);
    }
}

/// The entry kinds a lead's conversation is made of. Claude Code also writes
/// records about the session into the same file — `last-prompt`,
/// `cost-state`, `queue-operation`, `permission-mode`, `mode`, `atis-latch`,
/// `ai-title` and more, 331 of them standing after the newest conversation
/// entry of the 153 lead transcripts on this box read 2026-10-01 — and none of those
/// is written by a turn or begins one, so they are read past.
const CONVERSATION_KINDS: [&str; 5] = ["user", "assistant", "system", "attachment", "progress"];

/// The `system` entries Claude Code writes once a lead's turn is over: the
/// summary of its `Stop` hooks, then the turn's duration, and later, while
/// the session sits at its prompt, a summary of the time away. Of those 153
/// transcripts, 57 ended on `turn_duration`, 18 on `stop_hook_summary` and 2
/// on `away_summary`, each `away_summary` after a `turn_duration` (ISS-1379).
const TURN_OVER: [&str; 3] = ["turn_duration", "stop_hook_summary", "away_summary"];

/// Whether the newest conversation entry in a lead's transcript at `path`
/// says its turn is over. `Some(false)` is anything else — a message, a
/// tool's result, a tool call waiting on a permission, an input queued — and
/// an entry that does not parse; `None` is a transcript that cannot be read.
///
/// For a session whose hooks this box has not heard since it started, which
/// is every pane an update handed over (ISS-1379): only an affirmative end
/// says the session is at its prompt.
pub fn lead_turn_ended(path: &Path) -> Option<bool> {
    read_back(path, decide_lead, false)
}

fn decide_lead(tail: &str, whole: bool) -> Option<bool> {
    let mut lines = tail.lines();
    if !whole {
        lines.next();
    }
    for line in lines.rev().filter(|l| !l.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            return Some(false);
        };
        let kind = entry["type"].as_str().unwrap_or("");
        if !CONVERSATION_KINDS.contains(&kind) {
            continue;
        }
        let subtype = entry["subtype"].as_str().unwrap_or("");
        return Some(
            (kind == "system" && TURN_OVER.contains(&subtype))
                || (kind == "attachment" && entry["attachment"]["hookEvent"] == "Stop"),
        );
    }
    whole.then_some(false)
}
