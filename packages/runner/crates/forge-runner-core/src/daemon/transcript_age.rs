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

    /// A directory of this test's own, removed when it drops.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "forge-transcript-age-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("scratch");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn file(path: &Path, secs: u64) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(path, "{}\n").expect("write");
        at(path, secs);
    }

    #[test]
    fn a_lead_transcript_alone_answers_its_own_write() {
        let dir = Scratch::new();
        let lead = dir.path().join("conv.jsonl");
        file(&lead, 1_800_000_000);
        assert_eq!(last_written(&lead), Some(1_800_000_000_000));
    }

    #[test]
    fn a_child_writing_under_the_same_conversation_is_the_newer_evidence() {
        let dir = Scratch::new();
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
        let dir = Scratch::new();
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
        let dir = Scratch::new();
        assert_eq!(last_written(&dir.path().join("gone.jsonl")), None);
        assert_eq!(
            last_written(dir.path()),
            None,
            "a directory named where a transcript should be is not a transcript"
        );
    }

    #[test]
    fn children_still_answer_where_the_lead_file_cannot_be_read() {
        let dir = Scratch::new();
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
        let dir = Scratch::new();
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
        let dir = Scratch::new();
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
        let dir = Scratch::new();
        let lead = dir.path().join("conv.jsonl");
        std::fs::write(&lead, "{}\n").expect("write");
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_millis() as i64;
        let got = last_written(&lead).expect("readable");
        assert!((now - got).abs() < 5_000, "{now} vs {got}");
    }
}
