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
//! silence is that reader's policy (`job_exit`, `run_exit`).

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
        if let Some(newest) = decide(&String::from_utf8_lossy(&tail), whole) {
            return Some(newest);
        }
        if whole || window >= TAIL_CAP {
            return Some(Newest::Turn);
        }
        window = (window * 4).min(TAIL_CAP);
    }
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

/// An absolute transcript path on the platform the test runs on, for a fixture
/// nothing reads: `/h/p/x.jsonl` has no drive, so Windows calls it relative.
#[cfg(test)]
pub(crate) fn absolute_fixture(name: &str) -> String {
    std::env::temp_dir()
        .join("forge-transcript-fixture")
        .join(name)
        .to_string_lossy()
        .into_owned()
}

/// The end of `agent-a9860d00885b2b2d0.jsonl` as ISS-1312 found it, cut to the
/// fields that decide: the subagent's last message, then the two records its
/// `SubagentStop` hooks appended after the box stamped the stop.
#[cfg(test)]
pub(crate) const STOP_TAIL: &str = concat!(
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ISS-259 is parked on a question."}]},"timestamp":"2026-09-27T11:10:16.900Z"}"#,
    "\n",
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","attachment":{"type":"hook_success","hookName":"SubagentStop","hookEvent":"SubagentStop","exitCode":0},"type":"attachment","timestamp":"2026-09-27T11:10:17.000Z"}"#,
    "\n",
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","attachment":{"type":"hook_success","hookName":"SubagentStop","hookEvent":"SubagentStop","exitCode":0},"type":"attachment","timestamp":"2026-09-27T11:10:17.080Z"}"#,
    "\n",
);

/// A background notification that arrived after that stop, which the model
/// answers if the notification resumes it.
#[cfg(test)]
pub(crate) const NOTIFIED_TAIL: &str = concat!(
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","type":"user","message":{"role":"user","content":"<task-notification>the suite finished</task-notification>"},"timestamp":"2026-09-27T11:11:13.000Z"}"#,
    "\n",
);

/// The end of ISS-553/554's `agent-a433d2e9b20a24d06.jsonl`, cut to the
/// fields that decide: a notification after the stop, then the context
/// Claude Code (2.1.280, 2.1.282) wrote beside it 19 ms later, and nothing
/// since.
#[cfg(test)]
pub(crate) const NOTIFIED_WITH_CONTEXT_TAIL: &str = concat!(
    r#"{"isSidechain":true,"agentId":"a433d2e9b20a24d06","type":"user","isMeta":true,"message":{"role":"user","content":"[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>the suite finished</task-notification>"},"timestamp":"2026-09-26T00:26:06.307Z"}"#,
    "\n",
    r#"{"isSidechain":true,"agentId":"a433d2e9b20a24d06","attachment":{"type":"instructions","files":[],"changed":true,"reason":"compaction"},"type":"attachment","timestamp":"2026-09-26T00:26:06.326Z"}"#,
    "\n",
    r#"{"isSidechain":true,"agentId":"a433d2e9b20a24d06","attachment":{"type":"session_context","context":{},"changed":true,"reason":"compaction"},"type":"attachment","timestamp":"2026-09-26T00:26:06.326Z"}"#,
    "\n",
);

/// A turn resumed after that stop: the notification, and the model's reply
/// starting a tool that can run for hours without a write.
#[cfg(test)]
pub(crate) const RESUMED_TAIL: &str = concat!(
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","type":"user","message":{"role":"user","content":"<task-notification>the suite finished</task-notification>"},"timestamp":"2026-09-27T11:11:13.000Z"}"#,
    "\n",
    r#"{"isSidechain":true,"agentId":"a9860d00885b2b2d0","type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}]},"timestamp":"2026-09-27T11:11:17.000Z"}"#,
    "\n",
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn at(path: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .expect("open to stamp");
        f.set_modified(UNIX_EPOCH + Duration::from_secs(secs))
            .expect("set mtime");
    }

    use crate::test_scratch::Scratch;

    fn file(path: &Path, secs: u64) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, "{}\n").expect("write");
        at(path, secs);
    }

    #[test]
    fn a_lead_transcript_alone_answers_its_own_write() {
        let dir = Scratch::new("transcript-age");
        let lead = dir.path().join("conv.jsonl");
        file(&lead, 1_800_000_000);
        assert_eq!(last_written(&lead), Some(1_800_000_000_000));
    }

    #[test]
    fn a_child_writing_under_the_same_conversation_is_the_newer_evidence() {
        let dir = Scratch::new("transcript-age");
        let lead = dir.path().join("conv.jsonl");
        file(&lead, 1_800_000_000);
        file(
            &dir.path()
                .join("conv")
                .join("subagents")
                .join("agent-a1.jsonl"),
            1_800_003_600,
        );
        assert_eq!(
            last_written(&lead),
            Some(1_800_003_600_000),
            "a foreground child works in its own file while the lead's stands still"
        );
    }

    #[test]
    fn what_is_not_a_child_transcript_is_not_evidence() {
        let dir = Scratch::new("transcript-age");
        let lead = dir.path().join("conv.jsonl");
        file(&lead, 1_800_000_000);
        file(
            &dir.path()
                .join("conv")
                .join("subagents")
                .join("agent-a1.meta.json"),
            1_900_000_000,
        );
        file(
            &dir.path()
                .join("other")
                .join("subagents")
                .join("agent-b.jsonl"),
            1_900_000_000,
        );
        assert_eq!(last_written(&lead), Some(1_800_000_000_000));
    }

    #[test]
    fn a_missing_transcript_is_no_evidence_rather_than_silence() {
        let dir = Scratch::new("transcript-age");
        assert_eq!(last_written(&dir.path().join("gone.jsonl")), None);
        assert_eq!(
            last_written(dir.path()),
            None,
            "a directory named where a transcript should be is not a transcript"
        );
    }

    #[test]
    fn children_still_answer_where_the_lead_file_cannot_be_read() {
        let dir = Scratch::new("transcript-age");
        let child = dir
            .path()
            .join("conv")
            .join("subagents")
            .join("agent-a1.jsonl");
        file(&child, 1_800_000_000);
        assert_eq!(
            last_written(&dir.path().join("conv.jsonl")),
            Some(1_800_000_000_000)
        );
    }

    #[test]
    fn a_subagent_transcript_sits_where_last_written_reads_children_from() {
        let dir = Scratch::new("transcript-age");
        let lead = dir.path().join("conv.jsonl");
        let child = child_transcript(&lead, "a13e68aaf656d6502").expect("a plain id");
        assert_eq!(
            child,
            dir.path()
                .join("conv")
                .join("subagents")
                .join("agent-a13e68aaf656d6502.jsonl")
        );
        file(&lead, 1_800_000_000);
        file(&child, 1_800_003_600);
        assert_eq!(
            last_written(&lead),
            written_at(&child),
            "the one file named for a child is the one the lead's reader already counts"
        );
    }

    #[test]
    fn an_id_that_is_not_a_plain_name_names_no_file() {
        let lead = Path::new("/h/p/conv.jsonl");
        for id in ["", "../escape", "a/b", "a b", "a.jsonl"] {
            assert_eq!(child_transcript(lead, id), None, "{id:?}");
        }
    }

    #[test]
    fn one_file_answers_for_itself_and_not_for_its_siblings() {
        let dir = Scratch::new("transcript-age");
        let mine = dir
            .path()
            .join("conv")
            .join("subagents")
            .join("agent-a.jsonl");
        let sibling = dir
            .path()
            .join("conv")
            .join("subagents")
            .join("agent-b.jsonl");
        file(&mine, 1_800_000_000);
        file(&sibling, 1_900_000_000);
        assert_eq!(written_at(&mine), Some(1_800_000_000_000));
        assert_eq!(
            written_at(
                &dir.path()
                    .join("conv")
                    .join("subagents")
                    .join("agent-c.jsonl")
            ),
            None,
            "a file that is not there is no evidence rather than silence"
        );
    }

    #[test]
    fn a_file_written_now_reads_as_now() {
        let dir = Scratch::new("transcript-age");
        let lead = dir.path().join("conv.jsonl");
        std::fs::write(&lead, "{}\n").expect("write");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        let got = last_written(&lead).expect("readable");
        assert!((now - got).abs() < 5_000, "{now} vs {got}");
    }

    fn transcript(dir: &Scratch, body: &str) -> std::path::PathBuf {
        let path = dir.path().join("agent-a1.jsonl");
        std::fs::write(&path, body).expect("write");
        path
    }

    #[test]
    fn a_transcript_ending_on_its_stop_hooks_records_ends_on_its_stop() {
        let dir = Scratch::new("transcript-age");
        assert_eq!(
            newest_entry(&transcript(&dir, STOP_TAIL)),
            Some(Newest::StopRecord)
        );
    }

    #[test]
    fn a_notification_after_the_stop_records_awaits_a_reply() {
        let dir = Scratch::new("transcript-age");
        assert_eq!(
            newest_entry(&transcript(&dir, &format!("{STOP_TAIL}{NOTIFIED_TAIL}"))),
            Some(Newest::AwaitingReply)
        );
    }

    #[test]
    fn an_entry_after_the_stop_records_is_a_turn_and_not_the_stop() {
        let dir = Scratch::new("transcript-age");
        let resumed = format!("{STOP_TAIL}{RESUMED_TAIL}");
        assert_eq!(
            newest_entry(&transcript(&dir, &resumed)),
            Some(Newest::Turn),
            "the reply to the notification is the turn it resumed"
        );
    }

    #[test]
    fn a_newest_entry_that_does_not_parse_is_never_read_as_a_stop() {
        let dir = Scratch::new("transcript-age");
        let torn = format!("{STOP_TAIL}{{\"type\":\"attach");
        assert_eq!(newest_entry(&transcript(&dir, &torn)), Some(Newest::Turn));
        assert_eq!(newest_entry(&transcript(&dir, "")), Some(Newest::Turn));
    }

    #[test]
    fn another_hook_s_record_is_not_this_stop_s() {
        let dir = Scratch::new("transcript-age");
        let pre_tool = r#"{"type":"attachment","attachment":{"type":"hook_success","hookEvent":"PreToolUse"}}"#;
        assert_eq!(
            newest_entry(&transcript(&dir, &format!("{STOP_TAIL}{pre_tool}\n"))),
            Some(Newest::Turn)
        );
    }

    #[test]
    fn only_the_tail_is_read_however_long_the_transcript() {
        let dir = Scratch::new("transcript-age");
        let long = format!("{}{STOP_TAIL}", RESUMED_TAIL.repeat(2_000));
        assert!(long.len() as u64 > 4 * TAIL_BYTES);
        assert_eq!(
            newest_entry(&transcript(&dir, &long)),
            Some(Newest::StopRecord)
        );
    }

    #[test]
    fn a_tool_s_result_is_the_model_s_to_answer_too() {
        let dir = Scratch::new("transcript-age");
        let result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
        assert_eq!(
            newest_entry(&transcript(&dir, &format!("{RESUMED_TAIL}{result}\n"))),
            Some(Newest::AwaitingReply)
        );
    }

    /// ISS-1312, criterion 10: ISS-553/554's notification is the newest
    /// entry, and the context written beside it is not.
    #[test]
    fn the_context_written_beside_a_notification_is_read_past_to_it() {
        let dir = Scratch::new("transcript-age");
        let body = format!("{STOP_TAIL}{NOTIFIED_WITH_CONTEXT_TAIL}");
        assert_eq!(
            newest_entry(&transcript(&dir, &body)),
            Some(Newest::AwaitingReply)
        );
    }

    #[test]
    fn a_token_reminder_beside_a_tool_s_result_is_read_past_to_it() {
        let dir = Scratch::new("transcript-age");
        let result = r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#;
        let reminder = r#"{"type":"attachment","attachment":{"type":"total_tokens_reminder","text":"<total_tokens>1 tokens left</total_tokens>"}}"#;
        assert_eq!(
            newest_entry(&transcript(
                &dir,
                &format!("{RESUMED_TAIL}{result}\n{reminder}\n")
            )),
            Some(Newest::AwaitingReply)
        );
    }

    /// ISS-1312, criterion 26: the third judge's alternate shape, a
    /// notification with `total_tokens_reminder` and `deferred_tools_record`
    /// beside it, and the record alone.
    #[test]
    fn a_deferred_tools_record_beside_a_notification_is_read_past_to_it() {
        let dir = Scratch::new("transcript-age");
        let notified = NOTIFIED_WITH_CONTEXT_TAIL.lines().next().unwrap();
        let reminder =
            r#"{"type":"attachment","attachment":{"type":"total_tokens_reminder","text":"t"}}"#;
        let deferred = r#"{"type":"attachment","attachment":{"type":"deferred_tools_record","entries":[{"name":"mcp__claude_ai_Claude_Docs__batch","description":"d"}]}}"#;
        for (tail, shape) in [
            (
                format!("{notified}\n{reminder}\n{deferred}\n"),
                "reminder, then record",
            ),
            (format!("{notified}\n{deferred}\n"), "record alone"),
            (
                format!("{NOTIFIED_WITH_CONTEXT_TAIL}{deferred}\n"),
                "record after the other context",
            ),
        ] {
            assert_eq!(
                newest_entry(&transcript(&dir, &format!("{STOP_TAIL}{tail}"))),
                Some(Newest::AwaitingReply),
                "{shape}"
            );
        }
        let queued = r#"{"type":"attachment","attachment":{"type":"queued_command","prompt":"p"}}"#;
        assert_eq!(
            newest_entry(&transcript(
                &dir,
                &format!("{STOP_TAIL}{notified}\n{queued}\n{deferred}\n")
            )),
            Some(Newest::Turn),
            "a kind not named is never read past, however much named context stands over it"
        );
    }

    #[test]
    fn context_over_anything_but_the_entry_it_accompanies_is_a_turn() {
        let dir = Scratch::new("transcript-age");
        let context = NOTIFIED_WITH_CONTEXT_TAIL
            .split_inclusive('\n')
            .skip(1)
            .collect::<String>();
        for (below, why) in [
            (
                STOP_TAIL,
                "context after the stop's own records is written for a request, which is a turn",
            ),
            (RESUMED_TAIL, "context over the model's own entry is a turn"),
            ("", "context alone accompanies nothing that was read"),
        ] {
            assert_eq!(
                newest_entry(&transcript(&dir, &format!("{below}{context}"))),
                Some(Newest::Turn),
                "{why}"
            );
        }
    }

    #[test]
    fn an_attachment_of_a_kind_not_named_as_context_is_never_read_past() {
        let dir = Scratch::new("transcript-age");
        let unknown =
            r#"{"type":"attachment","attachment":{"type":"a_kind_no_release_wrote_yet"}}"#;
        assert_eq!(
            newest_entry(&transcript(
                &dir,
                &format!("{STOP_TAIL}{NOTIFIED_TAIL}{unknown}\n")
            )),
            Some(Newest::Turn),
            "only the kinds measured beside a user entry are passed over; anything else holds"
        );
    }

    /// 1,491 of 146,876 user entries on this box were longer than one tail,
    /// the longest 1.3 MB, so the entry under the context may start before it.
    #[test]
    fn an_entry_longer_than_the_tail_under_its_context_is_still_read_whole() {
        let dir = Scratch::new("transcript-age");
        let long = format!(
            r#"{{"type":"user","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"t1","content":"{}"}}]}}}}"#,
            "x".repeat(3 * TAIL_BYTES as usize)
        );
        let reminder =
            r#"{"type":"attachment","attachment":{"type":"total_tokens_reminder","text":"t"}}"#;
        assert_eq!(
            newest_entry(&transcript(
                &dir,
                &format!("{STOP_TAIL}{long}\n{reminder}\n")
            )),
            Some(Newest::AwaitingReply)
        );
    }

    #[test]
    fn an_entry_longer_than_the_widest_read_is_a_turn_and_not_a_guess() {
        let dir = Scratch::new("transcript-age");
        let long = format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{}"}}}}"#,
            "x".repeat(TAIL_CAP as usize + 1)
        );
        let reminder =
            r#"{"type":"attachment","attachment":{"type":"total_tokens_reminder","text":"t"}}"#;
        assert_eq!(
            newest_entry(&transcript(&dir, &format!("{long}\n{reminder}\n"))),
            Some(Newest::Turn),
            "what was never read whole is held rather than guessed at"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_transcript_that_cannot_be_opened_says_nothing_about_what_was_written() {
        use std::os::unix::fs::PermissionsExt;
        let dir = Scratch::new("transcript-age");
        let path = transcript(&dir, STOP_TAIL);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let opened = std::fs::File::open(&path).is_ok();
        let got = newest_entry(&path);
        let written = written_at(&path);
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            !opened,
            "the plant did not take: this process opens a mode-000 file, as root does"
        );
        assert_eq!(got, None);
        assert!(written.is_some(), "its time is still read");
    }

    #[test]
    fn a_transcript_that_is_not_there_says_nothing_about_a_stop() {
        let dir = Scratch::new("transcript-age");
        assert_eq!(newest_entry(&dir.path().join("gone.jsonl")), None);
    }
}
