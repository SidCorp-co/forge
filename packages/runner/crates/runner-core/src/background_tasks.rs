//! The background children a lead started and has not heard end, read from
//! its own transcript (ISS-858).
//!
//! A lead's turn ending says nothing about the work it left running: a
//! background agent, a background shell and a monitor all outlive the turn
//! that started them, and all die with the Claude Code process. No hook this
//! daemon registers fires for a shell or a monitor at all, and a subagent's
//! `SubagentStop` fires whenever it ends a turn, not only at its end
//! (`subagent_end`). The transcript records both edges of every one of them:
//!
//! - its start, as the launching tool's result: `toolUseResult.backgroundTaskId`
//!   for a shell, `isAsync` with `agentId` for an agent, `taskId` with
//!   `timeoutMs` for a monitor;
//! - its end, as the `<task-notification>` carrying its `<task-id>` and a
//!   `<status>` (`completed`, `failed`, `killed`, `stopped`); a monitor's
//!   expiry (ISS-960) is an `<event>` beginning `[Monitor expired after `
//!   with no status, and ends it too, while its other events end nothing;
//!   `TaskStop`'s result ends the task it names.
//!
//! This is evidence only. How long a reader waits on a child whose end it has
//! not read is that reader's policy.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What kind of background child a lead started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Agent,
    Shell,
    Monitor,
}

impl Kind {
    pub fn word(self) -> &'static str {
        match self {
            Kind::Agent => "agent",
            Kind::Shell => "shell",
            Kind::Monitor => "monitor",
        }
    }
}

/// A background child whose start was read and whose end was not.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub id: String,
    pub kind: Kind,
    /// When the transcript says it started, in wall-clock ms; `None` where the
    /// entry carried no timestamp this reader could parse.
    pub since_ms: Option<i64>,
}

/// The background children one transcript has started and ended so far.
#[derive(Debug, Clone, Default)]
pub struct Tasks {
    open: BTreeMap<String, Open>,
    ended: BTreeSet<String>,
}

/// The substrings a line must carry to say anything here, so the many lines
/// that cannot are never parsed.
const MARKS: [&str; 5] = [
    "backgroundTaskId",
    "async_launched",
    "\"taskId\"",
    "task-notification",
    "Successfully stopped task",
];

impl Tasks {
    /// The children started and not yet heard end.
    pub fn open(&self) -> impl Iterator<Item = &Open> {
        self.open.values()
    }

    /// Whether this transcript recorded the end of `id`.
    pub fn ended(&self, id: &str) -> bool {
        self.ended.contains(id)
    }

    /// Read one transcript line into what is open and what has ended.
    pub fn fold(&mut self, line: &str) {
        if !MARKS.iter().any(|m| line.contains(m)) {
            return;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            return;
        };
        match entry["type"].as_str() {
            Some("user") => {
                let at = entry["timestamp"].as_str().and_then(parse_ms);
                let sidechain = entry["isSidechain"].as_bool() == Some(true);
                if !sidechain {
                    if let Some((id, kind)) = started(&entry["toolUseResult"]) {
                        self.start(id, kind, at);
                    }
                }
                if let Some(id) = stopped(&entry["toolUseResult"]) {
                    self.end(&id);
                }
                for text in texts(&entry["message"]["content"]) {
                    for id in notified_ends(text) {
                        self.end(&id);
                    }
                }
            }
            Some("queue-operation") => {
                if let Some(text) = entry["content"].as_str() {
                    for id in notified_ends(text) {
                        self.end(&id);
                    }
                }
            }
            _ => {}
        }
    }

    fn start(&mut self, id: String, kind: Kind, since_ms: Option<i64>) {
        if self.ended.contains(&id) {
            return;
        }
        self.open.insert(id.clone(), Open { id, kind, since_ms });
    }

    fn end(&mut self, id: &str) {
        self.open.remove(id);
        self.ended.insert(id.to_string());
    }
}

fn parse_ms(stamp: &str) -> Option<i64> {
    runner_platform::clock::rfc3339_ms(stamp)
}

fn started(result: &serde_json::Value) -> Option<(String, Kind)> {
    let text = |k: &str| {
        result[k]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    if let Some(id) = text("backgroundTaskId") {
        return Some((id, Kind::Shell));
    }
    if result["isAsync"].as_bool() == Some(true) {
        if let Some(id) = text("agentId") {
            return Some((id, Kind::Agent));
        }
    }
    if result.get("timeoutMs").is_some() || result.get("persistent").is_some() {
        if let Some(id) = text("taskId") {
            return Some((id, Kind::Monitor));
        }
    }
    None
}

/// The task a `TaskStop` result says it stopped.
fn stopped(result: &serde_json::Value) -> Option<String> {
    let message = result["message"].as_str()?;
    let rest = message.strip_prefix("Successfully stopped task: ")?;
    result["task_id"]
        .as_str()
        .map(str::to_string)
        .or_else(|| rest.split_whitespace().next().map(str::to_string))
        .filter(|s| !s.is_empty())
}

fn texts(content: &serde_json::Value) -> Vec<&str> {
    match content {
        serde_json::Value::String(s) => vec![s.as_str()],
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b["text"].as_str().or_else(|| b["content"].as_str()))
            .collect(),
        _ => Vec::new(),
    }
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let from = text.find(open)? + open.len();
    let to = text[from..].find(close)? + from;
    Some(text[from..to].trim())
}

/// What a monitor's own last event begins with when its watch runs out (ISS-960): the one
/// form seen in this box's transcripts, worded three ways after it ("no events", "1 event",
/// "N events delivered").
const MONITOR_EXPIRED: &str = "[Monitor expired after ";

/// The ids of the tasks whose end the notifications in `text` say: a
/// notification with a status, or a monitor's expiry. Any other monitor event
/// is a line of its watch, and ends nothing.
fn notified_ends(text: &str) -> Vec<String> {
    text.split("<task-notification>")
        .skip(1)
        .filter_map(|block| {
            let block = block.split("</task-notification>").next().unwrap_or(block);
            let id = between(block, "<task-id>", "</task-id>")?;
            let ended = between(block, "<status>", "</status>").is_some()
                || between(block, "<event>", "</event>")
                    .is_some_and(|e| e.starts_with(MONITOR_EXPIRED));
            (ended && !id.is_empty()).then(|| id.to_string())
        })
        .collect()
}

struct Scan {
    offset: u64,
    tasks: Tasks,
}

/// Reads each transcript once, from where it last stopped: a master's
/// transcript runs to tens of megabytes, and the sweep asks every thirty
/// seconds.
#[derive(Default)]
pub struct Reader(Mutex<HashMap<PathBuf, Scan>>);

impl Reader {
    pub fn new() -> Self {
        Self::default()
    }

    /// What the transcript at `path` has started and ended so far, or why it
    /// could not be read. A file shorter than what was read of it is a new
    /// file, read again from its start.
    pub fn read(&self, path: &Path) -> Result<Tasks, String> {
        let mut map = self.0.lock().map_err(|_| "reader poisoned".to_string())?;
        let file = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let len = file
            .metadata()
            .map_err(|e| format!("{}: {e}", path.display()))?
            .len();
        let scan = map.entry(path.to_path_buf()).or_insert(Scan {
            offset: 0,
            tasks: Tasks::default(),
        });
        if len < scan.offset {
            scan.offset = 0;
            scan.tasks = Tasks::default();
        }
        let mut reader = BufReader::new(file);
        reader
            .seek(SeekFrom::Start(scan.offset))
            .map_err(|e| format!("{}: {e}", path.display()))?;
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("{}: {e}", path.display()))?;
            // A line still being written is read whole on the next call.
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            scan.offset += n as u64;
            scan.tasks.fold(&String::from_utf8_lossy(&line));
        }
        Ok(scan.tasks.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fold(entries: &[serde_json::Value]) -> Tasks {
        let mut t = Tasks::default();
        for e in entries {
            t.fold(&e.to_string());
        }
        t
    }

    fn ids(t: &Tasks) -> Vec<(String, Kind)> {
        t.open().map(|o| (o.id.clone(), o.kind)).collect()
    }

    fn note(id: &str, status: Option<&str>) -> String {
        let status = status
            .map(|s| format!("<status>{s}</status>\n"))
            .unwrap_or_default();
        format!("<task-notification>\n<task-id>{id}</task-id>\n{status}<summary>x</summary>\n</task-notification>")
    }

    fn event(id: &str, text: &str) -> String {
        format!("<task-notification>\n<task-id>{id}</task-id>\n<event>{text}</event>\n</task-notification>")
    }

    /// ISS-960: a monitor that expires says so in an event with no status (agenfold's
    /// byge5xot0, 2026-11-04, held a draining master's replacement until the 3 h ceiling).
    /// Each wording below is one seen on this box's transcripts.
    #[test]
    fn an_expired_monitor_ends_without_a_status() {
        let expiries = [
            "[Monitor expired after 30m with 8 events delivered. Re-arm it if you still need the watch.]",
            "[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]",
            "[Monitor expired after 5m 20s with no events delivered. Re-arm it if you still need the watch — and widen the filter if silence was unexpected.]",
            "[Monitor expired after 30m with 8 events delivered. Re-arm it…]",
        ];
        for text in expiries {
            let entries = [
                json!({"type": "user", "toolUseResult": {"taskId": "byge5xot0", "timeoutMs": 1_800_000, "persistent": false}}),
                json!({"type": "user", "message": {"content": event("byge5xot0", text)}}),
            ];
            let t = fold(&entries);
            assert!(
                t.ended("byge5xot0"),
                "an expiry did not end its monitor: {text}"
            );
            assert!(
                t.open().next().is_none(),
                "an expired monitor still reads open: {text}"
            );
        }
        // Any other event is one of the watch's lines, and ends nothing.
        let watching = [
            json!({"type": "user", "toolUseResult": {"taskId": "bfqqk3ok6", "timeoutMs": 1_800_000, "persistent": false}}),
            json!({"type": "user", "message": {"content": event("bfqqk3ok6", "deploy=0 Monitor expired is just text in a line")}}),
        ];
        assert_eq!(
            ids(&fold(&watching)),
            vec![("bfqqk3ok6".to_string(), Kind::Monitor)]
        );
    }

    #[test]
    fn each_kind_of_background_child_is_open_from_its_start_to_its_notified_end() {
        let starts = [
            json!({"type": "user", "timestamp": "2026-11-01T02:01:04.904Z", "toolUseResult": {"stdout": "", "backgroundTaskId": "b4df87t2s"}}),
            json!({"type": "user", "timestamp": "2026-11-01T02:01:05.000Z", "toolUseResult": {"isAsync": true, "status": "async_launched", "agentId": "a0003b4e46c9cf5fe"}}),
            json!({"type": "user", "toolUseResult": {"taskId": "bfqqk3ok6", "timeoutMs": 1_800_000, "persistent": false}}),
        ];
        let t = fold(&starts);
        assert_eq!(
            ids(&t),
            vec![
                ("a0003b4e46c9cf5fe".to_string(), Kind::Agent),
                ("b4df87t2s".to_string(), Kind::Shell),
                ("bfqqk3ok6".to_string(), Kind::Monitor),
            ]
        );
        assert_eq!(
            t.open().find(|o| o.kind == Kind::Shell).unwrap().since_ms,
            Some(1_793_498_464_904)
        );

        let mut ends = starts.to_vec();
        // A monitor's event has no status and ends nothing.
        ends.push(json!({"type": "user", "message": {"content": note("bfqqk3ok6", None)}}));
        ends.push(json!({"type": "queue-operation", "operation": "enqueue", "content": note("b4df87t2s", Some("completed"))}));
        ends.push(json!({"type": "user", "message": {"content": [{"type": "text", "text": note("a0003b4e46c9cf5fe", Some("failed"))}]}}));
        let t = fold(&ends);
        assert_eq!(ids(&t), vec![("bfqqk3ok6".to_string(), Kind::Monitor)]);
        assert!(t.ended("b4df87t2s") && t.ended("a0003b4e46c9cf5fe"));

        ends.push(json!({"type": "user", "toolUseResult": {"message": "Successfully stopped task: bfqqk3ok6 (tail -f x)"}}));
        assert!(
            fold(&ends).open().next().is_none(),
            "a TaskStop did not end its monitor"
        );
    }

    #[test]
    fn a_tool_result_that_is_no_background_launch_opens_nothing() {
        let t = fold(&[
            json!({"type": "user", "toolUseResult": {"taskId": "7", "subject": "a team task"}}),
            json!({"type": "user", "toolUseResult": {"isAsync": false, "agentId": "afg"}}),
            json!({"type": "user", "isSidechain": true, "toolUseResult": {"backgroundTaskId": "bside"}}),
            json!({"type": "assistant", "message": {"content": "backgroundTaskId"}}),
        ]);
        assert!(t.open().next().is_none());
    }

    #[test]
    fn the_reader_takes_up_where_it_stopped_and_never_reads_half_a_line() {
        let path =
            std::env::temp_dir().join(format!("forge-bg-reader-{}.jsonl", std::process::id()));
        let start =
            json!({"type": "user", "toolUseResult": {"backgroundTaskId": "b1"}}).to_string();
        let end =
            json!({"type": "user", "message": {"content": note("b1", Some("killed"))}}).to_string();
        std::fs::write(&path, format!("{start}\n{}", &end[..10])).unwrap();
        let r = Reader::new();
        assert_eq!(r.read(&path).unwrap().open().count(), 1);
        std::fs::write(&path, format!("{start}\n{end}\n")).unwrap();
        assert_eq!(
            r.read(&path).unwrap().open().count(),
            0,
            "the completed line was not read"
        );
        // A shorter file is a new one, read from its start.
        std::fs::write(&path, format!("{start}\n")).unwrap();
        assert_eq!(r.read(&path).unwrap().open().count(), 1);
        std::fs::remove_file(&path).unwrap();
        assert!(
            r.read(&path).is_err(),
            "a missing transcript was read as empty"
        );
    }
}
