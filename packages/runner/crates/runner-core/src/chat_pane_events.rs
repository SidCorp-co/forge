//! What a channel agent's pane tells the box through its own hooks (ISS-946).
//!
//! A pane's Claude Code runs interactive inside the chat sandbox, which holds neither the
//! daemon's control socket nor a capability for it: a session that reads strangers' text is given
//! no door into the daemon. So its `Stop`, `UserPromptSubmit` and status-line hooks run
//! `forge-runner hook --chat-pane-events <file>`, which appends one line per event to a file the
//! box made for that pane and bound into the sandbox writable, and the box reads it from outside.
//! The session can write that file too; what it could forge there is its own turn's end, which it
//! can bring about anyway by ending its turn.

use std::io::Write;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// One hook event, as appended: the event's name, when it fired, and Claude Code's own payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub event: String,
    pub at_ms: i64,
    pub payload: serde_json::Value,
}

/// The status line's event name: Claude Code runs the status-line command, not a hook, and its
/// payload is the one place the session's own running cost is written.
pub const STATUS_LINE: &str = "StatusLine";

/// Append `event` with `payload` to `path` as one line. `payload` that is not JSON is kept as a
/// string, so a line is never dropped for its payload.
pub fn append(path: &Path, event: &str, payload: &[u8], at_ms: i64) -> std::io::Result<()> {
    let payload = serde_json::from_slice(payload)
        .unwrap_or_else(|_| serde_json::Value::String(String::from_utf8_lossy(payload).into()));
    let line = Line {
        event: event.to_string(),
        at_ms,
        payload,
    };
    let mut text = serde_json::to_string(&line).map_err(std::io::Error::other)?;
    text.push('\n');
    // one `write` of a line under PIPE_BUF-sized appends keeps concurrent hooks' lines whole; a
    // longer one may interleave, and is skipped by the reader as unparseable rather than misread
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    file.write_all(text.as_bytes())
}

/// The whole lines of `path` past byte `from`, and the offset after the last whole line read: a
/// line still being written is left for the next read. A line that does not parse is skipped.
pub fn read_from(path: &Path, from: u64) -> std::io::Result<(Vec<Line>, u64)> {
    let (raw, next) = whole_lines_from(path, from)?;
    let lines = raw
        .iter()
        .filter_map(|l| serde_json::from_str::<Line>(l).ok())
        .collect();
    Ok((lines, next))
}

/// The whole lines of any append-only file past byte `from` (a hook-events file, a Claude Code
/// transcript), and the offset after the last one. A file that is not there yet has none.
pub fn whole_lines_from(path: &Path, from: u64) -> std::io::Result<(Vec<String>, u64)> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Vec::new(), from)),
        Err(e) => return Err(e),
    };
    file.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let Some(end) = buf.iter().rposition(|b| *b == b'\n') else {
        return Ok((Vec::new(), from));
    };
    let text = String::from_utf8_lossy(&buf[..end]);
    let lines = text
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .map(str::to_string)
        .collect();
    Ok((lines, from + end as u64 + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appended_lines_are_read_back_whole_and_a_partial_last_line_waits() {
        let dir = std::env::temp_dir().join(format!("chat-pane-events-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("events.jsonl");
        append(&path, "Stop", br#"{"session_id":"s1"}"#, 7).unwrap();
        append(&path, STATUS_LINE, b"not json", 8).unwrap();
        let mut f = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        f.write_all(br#"{"event":"Stop","at_ms":9,"#).unwrap();
        let (lines, next) = read_from(&path, 0).unwrap();
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert_eq!(lines[0].event, "Stop");
        assert_eq!(lines[0].payload["session_id"], "s1");
        assert_eq!(lines[1].payload, serde_json::json!("not json"));
        let (later, again) = read_from(&path, next).unwrap();
        assert!(later.is_empty(), "a half-written line was read: {later:?}");
        assert_eq!(again, next);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_file_not_there_yet_has_no_lines() {
        let (lines, next) = read_from(Path::new("/nonexistent/forge/events.jsonl"), 0).unwrap();
        assert!(lines.is_empty());
        assert_eq!(next, 0);
    }
}
