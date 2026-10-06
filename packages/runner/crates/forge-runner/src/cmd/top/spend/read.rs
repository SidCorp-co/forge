//! The transcripts under `~/.claude/projects`, read a little at a time.
//!
//! Each file is read from the byte its last read ended at, a whole line at a
//! time, so a frame reads only what was appended since. A line is parsed only
//! where it names `"usage"`, and then only for the fields a response is
//! counted by; every other field, the message content among them, is skipped
//! by the parser and never held.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;

use super::WEEK_MS;
use crate::cmd::top::source::{mtime_ms, Unreadable};

/// One API response, merged over every line it was written on.
#[derive(Debug, Clone)]
pub struct Response {
    /// The earliest timestamp among its lines.
    pub at_ms: i64,
    pub model: Arc<str>,
    /// The cwd its first line was written from, where that line said one.
    pub cwd: Option<Arc<str>>,
    /// The transcript its first line was read from.
    pub file: Arc<Path>,
    /// Input, output, cache-write and cache-read tokens, each the largest any
    /// of its lines carried: a response is written once per content block,
    /// its output growing line to line.
    pub tokens: [u64; 4],
}

/// Where one transcript's reading stands.
#[derive(Debug)]
struct File {
    path: Arc<Path>,
    /// The byte after the last whole line read.
    cursor: u64,
    /// Lines naming usage this file held that could not be counted.
    bad: usize,
    /// Responses in this file carrying no `message.id` or `requestId`.
    unkeyed: usize,
}

/// Everything read so far, kept from one frame to the next.
#[derive(Debug, Default)]
pub struct Reader {
    files: HashMap<PathBuf, File>,
    responses: HashMap<String, Response>,
    strings: HashSet<Arc<str>>,
}

/// What one pass read and what it left.
#[derive(Debug, Clone, Default)]
pub struct Pass {
    /// Every transcript in the window was read to its last whole line.
    pub complete: bool,
    pub read: u64,
    /// Bytes of the window read so far, this pass and every one before it.
    pub done: u64,
    /// Bytes in the window still unread once the pass stopped.
    pub outstanding: u64,
    /// Transcripts modified within the window.
    pub files: usize,
    pub unreadable: Vec<Unreadable>,
    /// Lines naming usage that could not be counted, over the files read.
    pub bad: usize,
    pub unkeyed: usize,
}

impl Reader {
    /// Read what was appended to every transcript under `root` modified
    /// within 7 days of `now_ms`. With a budget, no line is started once
    /// that many bytes have been read in this pass; the line in progress is
    /// read whole, so every pass advances.
    pub fn pass(
        &mut self,
        root: &Path,
        now_ms: i64,
        budget: Option<u64>,
    ) -> Result<Pass, Unreadable> {
        let (listed, unreadable) = listed(root, now_ms - WEEK_MS)?;
        let keep: HashSet<&PathBuf> = listed.iter().map(|(p, _)| p).collect();
        self.files.retain(|p, _| keep.contains(p));
        let mut pass = Pass {
            files: listed.len(),
            unreadable,
            ..Pass::default()
        };
        let mut stopped = false;
        for (path, len) in &listed {
            let file = self.files.entry(path.clone()).or_insert_with(|| File {
                path: Arc::from(path.as_path()),
                cursor: 0,
                bad: 0,
                unkeyed: 0,
            });
            if *len < file.cursor {
                // Rewritten shorter than it was read: read again whole. A
                // response seen before merges into itself.
                file.cursor = 0;
            }
            if stopped || file.cursor >= *len {
                continue;
            }
            let left = budget.map(|b| b.saturating_sub(pass.read));
            match read_from(file, &mut self.responses, &mut self.strings, left) {
                Ok((n, budget_hit)) => {
                    pass.read += n;
                    stopped = budget_hit;
                }
                Err(e) => pass
                    .unreadable
                    .push(Unreadable::new(path.display().to_string(), e)),
            }
        }
        for (path, len) in &listed {
            if let Some(f) = self.files.get(path) {
                pass.bad += f.bad;
                pass.unkeyed += f.unkeyed;
                pass.done += f.cursor.min(*len);
                if stopped {
                    pass.outstanding += len.saturating_sub(f.cursor);
                }
            }
        }
        pass.complete = !stopped;
        // A response is forgotten only once the transcript it was first read
        // from has left the window: forgotten by its time, a later line of
        // it read in a later pass would be counted again as new, at a time
        // after its own (whole-set read at 07832d1f4, F1). The window itself
        // is applied when the responses are summed.
        let kept: HashSet<&Path> = listed.iter().map(|(p, _)| p.as_path()).collect();
        self.responses.retain(|_, r| kept.contains(&*r.file));
        Ok(pass)
    }

    pub fn responses(&self) -> impl Iterator<Item = &Response> {
        self.responses.values()
    }
}

/// Transcripts with their lengths, and what could not be listed.
type Listing = (Vec<(PathBuf, u64)>, Vec<Unreadable>);

/// Every `*.jsonl` directly under a directory of `root`, and under that
/// directory's `<session>/subagents/`, modified at or after `since_ms`, with
/// its length, in path order. A directory that cannot be listed is named;
/// `root` that cannot be listed is the whole answer.
fn listed(root: &Path, since_ms: i64) -> Result<Listing, Unreadable> {
    let top =
        std::fs::read_dir(root).map_err(|e| Unreadable::new(root.display().to_string(), e))?;
    let mut files = Vec::new();
    let mut unreadable = Vec::new();
    for dir in top.flatten() {
        if !dir.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let dir = dir.path();
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) => {
                unreadable.push(Unreadable::new(dir.display().to_string(), e));
                continue;
            }
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(t) if t.is_dir() => {
                    let sub = path.join("subagents");
                    match std::fs::read_dir(&sub) {
                        Ok(children) => {
                            for child in children.flatten() {
                                consider(&child, since_ms, &mut files, &mut unreadable);
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => unreadable.push(Unreadable::new(sub.display().to_string(), e)),
                    }
                }
                Ok(_) => consider(&entry, since_ms, &mut files, &mut unreadable),
                Err(e) => unreadable.push(Unreadable::new(path.display().to_string(), e)),
            }
        }
    }
    files.sort();
    Ok((files, unreadable))
}

fn consider(
    entry: &std::fs::DirEntry,
    since_ms: i64,
    files: &mut Vec<(PathBuf, u64)>,
    unreadable: &mut Vec<Unreadable>,
) {
    let path = entry.path();
    if path.extension().is_none_or(|e| e != "jsonl") {
        return;
    }
    match entry.metadata() {
        Ok(m) if m.is_file() => {
            if mtime_ms(&m).is_none_or(|t| t >= since_ms) {
                files.push((path, m.len()));
            }
        }
        Ok(_) => {}
        Err(e) => unreadable.push(Unreadable::new(path.display().to_string(), e)),
    }
}

/// Read `file` from its cursor, a whole line at a time, starting no line once
/// `left` bytes are read. Returns the bytes read and whether the budget
/// stopped it. A last line with no newline is still being written, and is
/// left for a later pass; its bytes were read all the same, so they count
/// toward the budget (whole-set read at 07832d1f4, F2).
fn read_from(
    file: &mut File,
    responses: &mut HashMap<String, Response>,
    strings: &mut HashSet<Arc<str>>,
    left: Option<u64>,
) -> std::io::Result<(u64, bool)> {
    let mut f = std::fs::File::open(&file.path)?;
    f.seek(SeekFrom::Start(file.cursor))?;
    let mut r = BufReader::with_capacity(1 << 20, f);
    let mut line = Vec::new();
    let mut read = 0u64;
    loop {
        if left.is_some_and(|l| read >= l) {
            return Ok((read, true));
        }
        line.clear();
        let n = r.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') {
            return Ok((read + n as u64, false));
        }
        let at = file.cursor;
        file.cursor += n as u64;
        read += n as u64;
        if names_usage(&line) {
            take(&line, at, file, responses, strings);
        }
    }
}

fn names_usage(line: &[u8]) -> bool {
    std::str::from_utf8(line).map_or_else(
        |_| line.windows(7).any(|w| w == b"\"usage\""),
        |s| s.contains("\"usage\""),
    )
}

/// The fields of a transcript line a response is counted by, and no other.
#[derive(Deserialize)]
struct Entry {
    timestamp: Option<String>,
    cwd: Option<String>,
    #[serde(rename = "requestId")]
    request_id: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize, Default)]
struct Counts {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

impl Counts {
    fn four(&self) -> [u64; 4] {
        [
            self.input_tokens,
            self.output_tokens,
            self.cache_creation_input_tokens,
            self.cache_read_input_tokens,
        ]
        .map(|n| n.unwrap_or(0))
    }
}

#[derive(Deserialize)]
struct Usage {
    #[serde(flatten)]
    counts: Counts,
    iterations: Option<Vec<Counts>>,
}

impl Usage {
    /// Each count the larger of the response's own and its iterations' sum:
    /// a response whose top-level counts read zero can carry its whole usage
    /// in `iterations` (22 such on this box in two days, 2026-10-07).
    fn tokens(&self) -> [u64; 4] {
        let top = self.counts.four();
        let mut summed = [0u64; 4];
        for it in self.iterations.iter().flatten() {
            for (s, n) in summed.iter_mut().zip(it.four()) {
                *s += n;
            }
        }
        std::array::from_fn(|i| top[i].max(summed[i]))
    }
}

fn take(
    line: &[u8],
    at: u64,
    file: &mut File,
    responses: &mut HashMap<String, Response>,
    strings: &mut HashSet<Arc<str>>,
) {
    let Ok(entry) = serde_json::from_slice::<Entry>(line) else {
        // A line that names usage and is not the shape a line is written in.
        file.bad += 1;
        return;
    };
    let Some(usage) = entry.message.as_ref().and_then(|m| m.usage.as_ref()) else {
        // "usage" was a word in it, not a response's usage.
        return;
    };
    let tokens = usage.tokens();
    if tokens == [0; 4] {
        return;
    }
    let Some(at_ms) = entry
        .timestamp
        .as_deref()
        .and_then(forge_runner_core::daemon::master_limit::unix_ms)
    else {
        file.bad += 1;
        return;
    };
    let message = entry.message.as_ref().expect("usage came from it");
    let key = match (&message.id, &entry.request_id) {
        (Some(id), Some(req)) => format!("{id}\u{0}{req}"),
        _ => {
            file.unkeyed += 1;
            format!("{}\u{0}{at}", file.path.display())
        }
    };
    if let Some(r) = responses.get_mut(&key) {
        r.at_ms = r.at_ms.min(at_ms);
        for (was, now) in r.tokens.iter_mut().zip(tokens) {
            *was = (*was).max(now);
        }
        return;
    }
    let model = intern(
        strings,
        message.model.as_deref().unwrap_or("no model named"),
    );
    let cwd = entry.cwd.as_deref().map(|c| intern(strings, c));
    responses.insert(
        key,
        Response {
            at_ms,
            model,
            cwd,
            file: Arc::clone(&file.path),
            tokens,
        },
    );
}

fn intern(strings: &mut HashSet<Arc<str>>, s: &str) -> Arc<str> {
    if let Some(have) = strings.get(s) {
        return Arc::clone(have);
    }
    let a: Arc<str> = Arc::from(s);
    strings.insert(Arc::clone(&a));
    a
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::test_scratch::Scratch;

    pub(crate) fn line(at: &str, cwd: &str, ids: (&str, &str), model: &str, n: [u64; 4]) -> String {
        format!(
            "{{\"type\":\"assistant\",\"timestamp\":\"{at}\",\"cwd\":\"{cwd}\",\"requestId\":\"{}\",\"message\":{{\"id\":\"{}\",\"model\":\"{model}\",\"content\":[{{\"type\":\"text\",\"text\":\"hello\"}}],\"usage\":{{\"input_tokens\":{},\"output_tokens\":{},\"cache_creation_input_tokens\":{},\"cache_read_input_tokens\":{}}}}}}}\n",
            ids.1, ids.0, n[0], n[1], n[2], n[3]
        )
    }

    const NOW: i64 = 1_790_985_600_000;

    fn write(root: &Path, rel: &str, body: &str) -> PathBuf {
        let p = root.join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, body).unwrap();
        p
    }

    fn at(ms: i64) -> String {
        // NOW is 2026-10-03T00:00:00Z.
        let secs = (ms - NOW) / 1000;
        assert!((0..86_400).contains(&secs), "{secs}");
        format!(
            "2026-10-03T{:02}:{:02}:{:02}.{:03}Z",
            secs / 3600,
            secs % 3600 / 60,
            secs % 60,
            (ms - NOW) % 1000
        )
    }

    /// Criterion 4: one response on three lines, its output growing, is one
    /// response at its largest counts and its earliest time.
    #[test]
    fn a_response_on_several_lines_is_one_at_its_largest_counts() {
        let dir = Scratch::new("spend-read");
        let body = [
            line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [5, 8, 100, 1000]),
            line(
                &at(NOW + 2_000),
                "/r",
                ("m1", "q1"),
                "a",
                [5, 400, 100, 1000],
            ),
            line(
                &at(NOW + 3_000),
                "/r",
                ("m1", "q1"),
                "a",
                [5, 300, 100, 1000],
            ),
        ]
        .concat();
        write(dir.path(), "p/s.jsonl", &body);
        let mut r = Reader::default();
        let pass = r.pass(dir.path(), NOW + 60_000, None).unwrap();
        assert!(pass.complete && pass.unreadable.is_empty(), "{pass:?}");
        let all: Vec<&Response> = r.responses().collect();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].tokens, [5, 400, 100, 1000]);
        assert_eq!(all[0].at_ms, NOW + 1_000);
    }

    /// Consult 2a9cbb, F1, and criterion 12: a record larger than two budgets
    /// is read whole in one pass, never started again, and counted once; a
    /// pass starts no line once its budget is read.
    #[test]
    fn a_record_larger_than_the_budget_is_read_once_and_every_pass_advances() {
        let dir = Scratch::new("spend-read");
        let mut big = line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [1, 2, 3, 4]);
        big.insert_str(
            big.len() - 3,
            &format!(",\"pad\":\"{}\"", "x".repeat(5_000)),
        );
        let small = line(&at(NOW + 2_000), "/r", ("m2", "q2"), "a", [1, 1, 1, 1]);
        write(dir.path(), "p/a.jsonl", &big);
        write(dir.path(), "p/b.jsonl", &small);
        let mut r = Reader::default();
        let budget = Some(2_000);
        let first = r.pass(dir.path(), NOW + 60_000, budget).unwrap();
        assert!(!first.complete, "{first:?}");
        assert_eq!(
            first.read,
            big.len() as u64,
            "the big line whole, and nothing after it"
        );
        assert_eq!(first.outstanding, small.len() as u64);
        assert_eq!(r.responses().count(), 1);
        let second = r.pass(dir.path(), NOW + 60_000, budget).unwrap();
        assert!(second.complete, "{second:?}");
        assert_eq!(
            second.read,
            small.len() as u64,
            "the big line is not read again"
        );
        assert_eq!(r.responses().count(), 2);
        let third = r.pass(dir.path(), NOW + 60_000, budget).unwrap();
        assert_eq!((third.read, third.complete), (0, true));
    }

    /// A line still being written is left until it ends; what is appended
    /// later is read from where the last pass stopped.
    #[test]
    fn appended_lines_are_read_from_the_cursor_and_a_partial_one_waits() {
        let dir = Scratch::new("spend-read");
        let one = line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [1, 0, 0, 0]);
        let two = line(&at(NOW + 2_000), "/r", ("m2", "q2"), "a", [2, 0, 0, 0]);
        let p = write(dir.path(), "p/s.jsonl", &format!("{one}{}", &two[..20]));
        let mut r = Reader::default();
        let pass = r.pass(dir.path(), NOW + 60_000, None).unwrap();
        assert!(pass.complete);
        assert_eq!(r.responses().count(), 1);
        std::fs::write(&p, format!("{one}{two}")).unwrap();
        let pass = r.pass(dir.path(), NOW + 60_000, None).unwrap();
        assert_eq!(pass.read, two.len() as u64);
        assert_eq!(r.responses().count(), 2);
    }

    /// Whole-set read at 07832d1f4, F2: a line still being written is read
    /// and counts toward the budget, so several large unfinished tails stop
    /// the pass after the first rather than each being read in full.
    #[test]
    fn an_unfinished_tail_counts_toward_the_budget() {
        let dir = Scratch::new("spend-read");
        let tail = format!("{{\"pad\":\"{}", "x".repeat(5_000));
        for name in ["a", "b", "c"] {
            write(dir.path(), &format!("p/{name}.jsonl"), &tail);
        }
        let mut r = Reader::default();
        let pass = r.pass(dir.path(), NOW + 60_000, Some(2_000)).unwrap();
        assert_eq!(
            pass.read,
            tail.len() as u64,
            "the first tail, and no other: {pass:?}"
        );
        assert!(!pass.complete);
        let ended = line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [1, 0, 0, 0]);
        write(dir.path(), "p/a.jsonl", &ended);
        let mut r = Reader::default();
        r.pass(dir.path(), NOW + 60_000, Some(2_000)).unwrap();
        assert_eq!(r.responses().count(), 1);
    }

    /// Whole-set read at 07832d1f4, F1: a response whose lines straddle the
    /// 7-day line, read in two passes, keeps its earliest time, so it stays
    /// out of the 7-day window as it does when read in one pass.
    #[test]
    fn a_response_straddling_the_window_read_in_two_passes_keeps_its_earliest_time() {
        let dir = Scratch::new("spend-read");
        let now = NOW + WEEK_MS;
        let before = line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [1, 5, 0, 0]);
        let after = line(&at(NOW + 120_000), "/r", ("m1", "q1"), "a", [1, 50, 0, 0]);
        write(dir.path(), "p/s.jsonl", &format!("{before}{after}"));
        let mut r = Reader::default();
        let first = r
            .pass(dir.path(), now + 60_000, Some(before.len() as u64))
            .unwrap();
        assert!(!first.complete, "{first:?}");
        r.pass(dir.path(), now + 60_000, Some(before.len() as u64))
            .unwrap();
        let all: Vec<&Response> = r.responses().collect();
        assert_eq!(all.len(), 1);
        assert_eq!((all[0].at_ms, all[0].tokens[1]), (NOW + 1_000, 50));
        assert!(all[0].at_ms < now + 60_000 - WEEK_MS, "outside the window");
    }

    /// Criterion 3's places, and criterion 14: a subagent's transcript is
    /// read; a line naming usage only in its content is no response, and the
    /// content is never kept; a line of no known shape is counted as one
    /// that could not be read.
    #[test]
    fn subagents_are_read_and_content_is_never_a_response() {
        let dir = Scratch::new("spend-read");
        write(
            dir.path(),
            "p/conv/subagents/agent-1.jsonl",
            &line(&at(NOW + 1_000), "/r/wt", ("m1", "q1"), "a", [1, 0, 0, 0]),
        );
        write(
            dir.path(),
            "p/conv.jsonl",
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"what is \\\"usage\\\" here\"}}\n{\"usage\": [1,2]\n",
        );
        let mut r = Reader::default();
        let pass = r.pass(dir.path(), NOW + 60_000, None).unwrap();
        assert_eq!(r.responses().count(), 1);
        assert!(r
            .responses()
            .all(|x| x.file.ends_with("subagents/agent-1.jsonl")));
        assert_eq!(pass.bad, 1, "{pass:?}");
    }

    /// Criterion 10: a root that cannot be listed is the answer, never an
    /// empty reading.
    #[test]
    fn a_root_that_cannot_be_listed_is_unreadable() {
        let dir = Scratch::new("spend-read");
        let not_a_dir = write(dir.path(), "projects", "a file");
        let err = Reader::default().pass(&not_a_dir, NOW, None).unwrap_err();
        assert_eq!(err.source, not_a_dir.display().to_string());
    }

    /// A transcript last modified before the 7-day window is not read.
    #[test]
    fn a_transcript_older_than_the_window_is_not_read() {
        let dir = Scratch::new("spend-read");
        write(
            dir.path(),
            "p/s.jsonl",
            &line(&at(NOW + 1_000), "/r", ("m1", "q1"), "a", [1, 0, 0, 0]),
        );
        let mut r = Reader::default();
        let later = mtime_ms(&std::fs::metadata(dir.path().join("p/s.jsonl")).unwrap()).unwrap()
            + WEEK_MS
            + 1;
        let pass = r.pass(dir.path(), later, None).unwrap();
        assert_eq!((pass.files, r.responses().count()), (0, 0));
    }
}
