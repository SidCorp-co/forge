//! The reviewer's structured result, on its way to the ledger.
//!
//! The one thing an autonomous session cannot be trusted to record is the
//! judgement on its own work. So the reviewer writes its result to a file and
//! the RUNNER posts it: the journal row lands with `source='runner'`, which is
//! the only value the CHECK on `phase_journal` accepts for a verdict.
//!
//! What this does and does not buy, stated plainly: it stops the driver
//! SUMMARISING the review in its own words, because the bytes posted are the
//! bytes found on disk. It cannot prove which process wrote the file — the
//! runner has no way to attribute a write inside a worktree it handed to
//! Claude. The `forge-review` skill owns that discipline; this owns the shape
//! and the transport.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// One line of `<worktree>/.forge/review-verdicts.jsonl`.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub struct Verdict {
    pub decision: String,
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub findings: Option<serde_json::Value>,
}

pub fn path(worktree: &Path) -> PathBuf {
    worktree.join(".forge").join("review-verdicts.jsonl")
}

fn is_known_decision(d: &str) -> bool {
    matches!(d, "approve" | "request_changes" | "abstain")
}

/// Read every well-formed verdict and REMOVE the file, so the same result is
/// never posted twice.
///
// cm:guard truncate only after a successful read, and drop malformed lines rather than the whole file — a reviewer that wrote one bad line must still get its other verdicts recorded, and a file left in place would re-post approvals on the next drain
pub fn drain(worktree: &Path) -> Vec<Verdict> {
    let file = path(worktree);
    let Ok(body) = std::fs::read_to_string(&file) else {
        return Vec::new();
    };
    let verdicts: Vec<Verdict> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Verdict>(l).ok())
        .filter(|v| is_known_decision(&v.decision))
        .collect();
    let _ = std::fs::remove_file(&file);
    verdicts
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-verdict-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".forge")).unwrap();
        dir
    }

    fn write(dir: &Path, body: &str) {
        std::fs::write(path(dir), body).unwrap();
    }

    #[test]
    fn reads_one_verdict_per_line() {
        let dir = scratch("lines");
        write(
            &dir,
            "{\"decision\":\"request_changes\",\"phase\":\"review\",\"attempt\":2}\n{\"decision\":\"approve\"}\n",
        );

        let out = drain(&dir);

        assert_eq!(out.len(), 2);
        assert_eq!(out[0].decision, "request_changes");
        assert_eq!(out[0].attempt, Some(2));
        assert_eq!(out[1].phase, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // cm:guard a drained file must be gone — leaving it re-posts the same approval on every later drain, and an approval recorded twice is an approval the reviewer only gave once
    #[test]
    fn removes_the_file_so_a_verdict_is_posted_once() {
        let dir = scratch("once");
        write(&dir, "{\"decision\":\"approve\"}\n");

        assert_eq!(drain(&dir).len(), 1);
        assert!(drain(&dir).is_empty());
        assert!(!path(&dir).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn drops_a_malformed_line_without_losing_its_neighbours() {
        let dir = scratch("malformed");
        write(&dir, "not json\n{\"decision\":\"approve\"}\n{}\n");

        let out = drain(&dir);

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].decision, "approve");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // cm:guard an unknown decision must be dropped, not forwarded — core would reject it anyway, and a runner that posts whatever it read turns a reviewer typo into a failed job instead of a missing verdict
    #[test]
    fn refuses_a_decision_core_does_not_define() {
        let dir = scratch("unknown");
        write(&dir, "{\"decision\":\"looks-fine-to-me\"}\n");

        assert!(drain(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn returns_nothing_when_the_reviewer_wrote_nothing() {
        let dir = scratch("absent");
        assert!(drain(&dir).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
