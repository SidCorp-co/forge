//! Why this box placed no master pane for a project, kept on disk beside its
//! last exit so `forge-runner master status`, which runs in a process of its
//! own and asks the daemon nothing, can say it (ISS-1390 criterion 6).
//!
//! The daemon's sweep holds the reason in memory and says it once in the
//! journal. A master refused for its PATH has no pane, so the one reader of
//! that memory, a pane's declaration refusal, never runs; on `master status`
//! the project read `pane gone` and `last exit none recorded`, which is an
//! operator told nothing stands in the way.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// The file beside a project's `transcript.log` that holds why no pane was
/// placed for it.
const RECORD_FILE: &str = "unplaced.json";

/// One reason, as the daemon's sweep recorded it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// Unix seconds at which a sweep first found this reason.
    pub since: i64,
    /// The daemon that recorded it.
    pub pid: u32,
    /// The words the journal leads the reason with.
    pub lead: String,
    /// The reason, as the journal says it.
    pub why: String,
}

pub fn record_path(master_dir: &Path) -> PathBuf {
    master_dir.join(RECORD_FILE)
}

/// Write `record` into `master_dir`, whole or not at all.
pub fn write(master_dir: &Path, record: &Record) -> std::io::Result<()> {
    std::fs::create_dir_all(master_dir)?;
    let body = serde_json::to_vec_pretty(record).map_err(std::io::Error::other)?;
    let tmp = master_dir.join(format!("{RECORD_FILE}.tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, record_path(master_dir))
}

/// Remove the record, where there is one: a pane is placed, or the reason now
/// standing is one another line of `master status` already says.
pub fn clear(master_dir: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(record_path(master_dir)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// What reading a project's record found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Found {
    None,
    Unavailable(String),
    Record(Record),
}

pub fn read(master_dir: &Path) -> Found {
    let path = record_path(master_dir);
    match std::fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Found::None,
        Err(e) => Found::Unavailable(format!("{} could not be read: {e}", path.display())),
        Ok(raw) => match serde_json::from_slice(&raw) {
            Ok(r) => Found::Record(r),
            Err(e) => Found::Unavailable(format!("{} does not parse: {e}", path.display())),
        },
    }
}

/// The `unplaced` line of `master status`, where there is anything to say.
pub fn status_line(found: &Found, now: i64) -> Option<String> {
    match found {
        Found::None => None,
        Found::Unavailable(why) => Some(format!(
            "unavailable: why this box placed no pane cannot be read here: {why}"
        )),
        Found::Record(r) => Some(format!(
            "{} — {}. Recorded by this box's daemon (pid {}) at the sweep that first found it, {}; the sweep that places a pane removes this record, and a daemon that is not running records nothing newer",
            r.lead,
            r.why,
            r.pid,
            crate::daemon::pane_exit::ago(now - r.since)
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_written_is_the_record_read_and_cleared_is_gone() {
        let dir = crate::test_scratch::Scratch::new("unplaced-record");
        let at = dir.join("master").join("p");
        assert_eq!(read(&at), Found::None);
        assert_eq!(
            status_line(&read(&at), 0),
            None,
            "nothing recorded, nothing said"
        );
        let r = Record {
            since: 100,
            pid: 42,
            lead: "no master pane placed".into(),
            why: "`node` resolves in none of (/usr/bin)".into(),
        };
        write(&at, &r).unwrap();
        assert_eq!(read(&at), Found::Record(r));
        let said = status_line(&read(&at), 160).unwrap();
        assert!(
            said.starts_with("no master pane placed — `node` resolves in none of (/usr/bin)."),
            "{said}"
        );
        assert!(
            said.contains("pid 42") && said.contains("60s ago"),
            "{said}"
        );
        clear(&at).unwrap();
        assert_eq!(read(&at), Found::None);
        clear(&at).expect("clearing nothing is not an error");
    }

    #[test]
    fn a_record_that_does_not_parse_says_so_rather_than_nothing() {
        let dir = crate::test_scratch::Scratch::new("unplaced-record-bad");
        std::fs::write(record_path(&dir), b"{").unwrap();
        let said = status_line(&read(&dir), 0).unwrap();
        assert!(
            said.starts_with("unavailable:") && said.contains("does not parse"),
            "{said}"
        );
    }
}
