//! What this box records when the declaration gate could not do its job.
//!
//! Two different facts land here and they must stay apart:
//!
//! - **degraded** — the gate let a dispatch through because it could not tell,
//!   not because it had decided the work was declared. Every one of these is a
//!   moment when the instruction was advice again.
//! - **undeclared** — a subagent started under a role this box's plugin ships
//!   with no declaration to bind it to. The gate was supposed to have refused
//!   that dispatch, so each line is one that got past it.
//!
//! It is a FILE beside `config.toml` and reaches nothing else on purpose: the
//! degraded case is defined by the control socket or the role list having
//! failed, so a record that needed either would be missing exactly when it is
//! owed. `forge-runner status` is the read surface.

use std::io::Write;
use std::path::{Path, PathBuf};

/// Which of the two facts a line carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// The gate opened without deciding.
    Degraded,
    /// A hand-off reached a subagent with nothing declared for it.
    Undeclared,
}

impl Kind {
    pub fn wire(self) -> &'static str {
        match self {
            Kind::Degraded => "degraded",
            Kind::Undeclared => "undeclared",
        }
    }
}

/// How many lines the file keeps before the oldest are dropped.
// cm:guard a CAP and not a rotation: this file is read by an operator asking "how often", never replayed, so the newest half is the whole of its value. Unbounded, a master stuck in a loop of undeclared dispatches writes until the disk is the symptom instead of the master.
const MAX_LINES: usize = 500;

/// `<config dir>/gate-marks.jsonl`.
pub fn marks_path(config_dir: &Path) -> PathBuf {
    config_dir.join("gate-marks.jsonl")
}

/// Append one mark, and never fail the caller.
// cm:guard returns `()` and swallows every error, because both callers are on paths that must not break: one is a hook the agent is waiting on, the other is inside the daemon's own hook handler. A mark that could not be written is worth less than the master it would have wedged.
// cm:guard the write is O_APPEND and one line, so two processes marking at once interleave rather than overwrite. The trim below is the only racy part and the thing it can lose is an old line, which is what the cap exists to throw away anyway.
pub fn mark(config_dir: &Path, kind: Kind, detail: &str) {
    let path = marks_path(config_dir);
    let line = serde_json::json!({
        "at": crate::daemon::agent_activity::now_ms(),
        "kind": kind.wire(),
        "detail": detail,
    })
    .to_string();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let appended = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut f| writeln!(f, "{line}"));
    if appended.is_err() {
        return;
    }
    trim(&path);
}

fn trim(path: &Path) {
    let Ok(body) = std::fs::read_to_string(path) else {
        return;
    };
    let lines: Vec<&str> = body.lines().collect();
    if lines.len() <= MAX_LINES {
        return;
    }
    let keep = lines[lines.len() - MAX_LINES / 2..].join("\n");
    let _ = std::fs::write(path, format!("{keep}\n"));
}

/// What one kind of mark amounts to, for an operator reading it back.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub count: usize,
    /// The most recent detail, which is what says WHY rather than how often.
    pub last: Option<String>,
    /// Milliseconds since the epoch, the same clock every other mark on this box uses.
    pub last_at: Option<i64>,
}

/// Read both tallies back.
// cm:guard an unreadable or absent file answers with two empty tallies rather than an error: a box that has never degraded and a box whose file was removed read the same, and the caller prints a zero either way. There is no question here an error could answer better.
pub fn tally(config_dir: &Path) -> (Tally, Tally) {
    let mut degraded = Tally::default();
    let mut undeclared = Tally::default();
    let Ok(body) = std::fs::read_to_string(marks_path(config_dir)) else {
        return (degraded, undeclared);
    };
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let slot = match v.get("kind").and_then(serde_json::Value::as_str) {
            Some("degraded") => &mut degraded,
            Some("undeclared") => &mut undeclared,
            _ => continue,
        };
        slot.count += 1;
        slot.last = v
            .get("detail")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        slot.last_at = v.get("at").and_then(serde_json::Value::as_i64);
    }
    (degraded, undeclared)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A directory of this test's own, by the idiom this crate already uses
    /// (`daemon/held_report.rs`): keyed on pid and thread so two `cargo test`
    /// runs on one box cannot take each other's, and removed on the way out.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "forge-{name}-{}-{:?}",
                std::process::id(),
                std::thread::current().id()
            ));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).expect("scratch");
            Self(p)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Criteria 17, 25. The two facts are counted apart.
    #[test]
    fn the_two_kinds_are_tallied_separately_and_the_last_detail_survives() {
        let dir = Scratch::new("degraded-1");
        mark(dir.path(), Kind::Degraded, "no control socket");
        mark(dir.path(), Kind::Undeclared, "subagent c1 as runner");
        mark(dir.path(), Kind::Degraded, "roles unreadable");

        let (degraded, undeclared) = tally(dir.path());
        assert_eq!(degraded.count, 2);
        assert_eq!(undeclared.count, 1);
        assert_eq!(degraded.last.as_deref(), Some("roles unreadable"));
        assert_eq!(undeclared.last.as_deref(), Some("subagent c1 as runner"));
    }

    /// Criterion 18. The record is owed exactly when the things it could have
    /// depended on are the ones that failed, so it depends on neither.
    // cm:guard this test is the whole reason the marks are a file. Take the socket away, take the plugin clone away, and the mark still lands — a record routed through either would be missing at the only moment it is worth having.
    #[test]
    fn a_mark_lands_with_no_socket_and_no_plugin_clone_on_the_box() {
        let dir = Scratch::new("degraded-2");
        assert!(!dir.path().join("control.sock").exists());
        assert!(!dir.path().join("marketplaces").exists());
        mark(dir.path(), Kind::Degraded, "the daemon did not answer");
        assert_eq!(tally(dir.path()).0.count, 1);
    }

    #[test]
    fn a_box_that_has_never_degraded_reads_as_zero_rather_than_as_an_error() {
        let dir = Scratch::new("degraded-3");
        let (degraded, undeclared) = tally(dir.path());
        assert_eq!(degraded, Tally::default());
        assert_eq!(undeclared, Tally::default());
    }

    #[test]
    fn the_file_stops_growing_at_the_cap() {
        let dir = Scratch::new("degraded-4");
        for i in 0..MAX_LINES + 40 {
            mark(dir.path(), Kind::Undeclared, &format!("line {i}"));
        }
        let body = std::fs::read_to_string(marks_path(dir.path())).expect("file");
        assert!(
            body.lines().count() <= MAX_LINES,
            "{}",
            body.lines().count()
        );
        assert!(
            body.contains(&format!("line {}", MAX_LINES + 39)),
            "the newest line is the one that must survive"
        );
    }
}
