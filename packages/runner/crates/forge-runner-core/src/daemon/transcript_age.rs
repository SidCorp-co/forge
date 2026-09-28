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

/// How much of a transcript's end [`newest_entry`] reads. A stop hook's
/// record is a few hundred bytes; a newest entry longer than this is not one,
/// and reads as the turn that wrote it.
const TAIL_BYTES: u64 = 64 * 1024;

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
    /// the model's to answer. A turn that takes one up writes its reply
    /// promptly: measured over this box's 1075 subagent transcripts
    /// 2026-09-28, 277 notifications were each answered within 29 s and
    /// 145,297 answered entries within 20 min. One nobody answers is left by a
    /// background task that finished after its subagent stopped (ISS-1312).
    AwaitingReply,
    /// Anything else, or an entry that does not parse: a turn wrote it.
    Turn,
}

/// The newest entry in the transcript at `path`. `None` where the file cannot
/// be opened or read, which says nothing about what was written.
pub fn newest_entry(path: &Path) -> Option<Newest> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let tail = String::from_utf8_lossy(&tail);
    let Some(newest) = tail.lines().rev().find(|l| !l.trim().is_empty()) else {
        return Some(Newest::Turn);
    };
    let Ok(entry) = serde_json::from_str::<serde_json::Value>(newest) else {
        return Some(Newest::Turn);
    };
    Some(
        if entry["type"] == "attachment" && entry["attachment"]["hookEvent"] == "SubagentStop" {
            Newest::StopRecord
        } else if entry["type"] == "user" {
            Newest::AwaitingReply
        } else {
            Newest::Turn
        },
    )
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
