//! What this box records when the declaration gate could not do its job, and
//! what it says about it afterwards.
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
//! The WRITE is a file beside `config.toml` and reaches nothing else: the
//! degraded case is defined by the control socket or the role list having
//! failed, so a record that needed either would be missing exactly when it is
//! owed. That reasoning is about the write alone. The READ is not local — a
//! safety control whose erosion only one command on one box can see erodes
//! unwatched, which it did here for 3.7 days and 278 dispatches (ISS-1192). So
//! this module also derives the CONDITION the box is in, in one place, and
//! `daemon/mod.rs` carries it out on the heartbeat while `cmd/status.rs` prints
//! it. A mark carries who wrote it and what it admitted, because "was the gate
//! deciding when this ran" is a question asked after the fact.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::daemon::dispatch_gate::Dispatch;

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

/// Which process wrote a mark.
///
/// The pane's hook and the daemon see different things, and a reader that
/// cannot tell them apart misreads the reason: the hook's "no control
/// capability" is a statement about the process the hook ran in, and was read
/// on ISS-1192 as one about the master pane, from a pane whose own token was
/// set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `cmd/gate.rs`, inside the pane, with no daemon to ask.
    Hook,
    /// The daemon itself, which had reached its own registry or failed to.
    Daemon,
}

impl Source {
    pub fn wire(self) -> &'static str {
        match self {
            Source::Hook => "hook",
            Source::Daemon => "daemon",
        }
    }
}

/// The declared run an admitted dispatch belonged to — or why this box has no
/// name for it. There is no third state: a mark that simply omitted the run
/// would read as a run of `null`, which is the silence this record exists to
/// end.
#[derive(Debug, Clone, Copy)]
pub enum Run<'a> {
    /// The run this box had already declared for the work.
    Declared(&'a str),
    /// No run, and this is why.
    Unknown(&'a str),
}

/// One mark, with everything the writing process could say about what it let
/// through.
#[derive(Debug, Clone)]
pub struct Mark<'a> {
    pub kind: Kind,
    pub source: Source,
    pub detail: &'a str,
    pub run: Run<'a>,
    pub agent: Option<&'a str>,
    pub role: Option<&'a str>,
    pub tool_use: Option<&'a str>,
}

impl<'a> Mark<'a> {
    pub fn new(kind: Kind, source: Source, detail: &'a str, run: Run<'a>) -> Self {
        Self {
            kind,
            source,
            detail,
            run,
            agent: None,
            role: None,
            tool_use: None,
        }
    }

    /// The dispatch this mark admitted, as the gate itself received it.
    pub fn about(mut self, d: &'a Dispatch) -> Self {
        self.agent = d.agent_id.as_deref();
        self.role = d.subagent_type.as_deref();
        self.tool_use = d.tool_use_id.as_deref();
        self
    }

    /// A subagent known by id rather than by a dispatch payload.
    pub fn by_child(mut self, child: &'a str, role: Option<&'a str>) -> Self {
        self.agent = Some(child);
        self.role = role;
        self
    }
}

const MAX_LINES: usize = 500;

/// `<config dir>/gate-marks.jsonl`.
pub fn marks_path(config_dir: &Path) -> PathBuf {
    config_dir.join("gate-marks.jsonl")
}

pub fn mark(config_dir: &Path, m: &Mark<'_>) {
    let path = marks_path(config_dir);
    let mut line = serde_json::json!({
        "at": crate::daemon::agent_activity::now_ms(),
        "kind": m.kind.wire(),
        "source": m.source.wire(),
        "detail": m.detail,
    });
    match m.run {
        Run::Declared(id) => line["run"] = serde_json::Value::String(id.to_string()),
        Run::Unknown(why) => line["run_unknown"] = serde_json::Value::String(why.to_string()),
    }
    for (key, value) in [
        ("agent", m.agent),
        ("role", m.role),
        ("tool_use", m.tool_use),
    ] {
        if let Some(v) = value {
            line[key] = serde_json::Value::String(v.to_string());
        }
    }
    let line = line.to_string();
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

/// The most recent mark of a kind, read back. Every field but `detail` is
/// optional, because a file an older binary wrote carries none of them and must
/// still tally.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Last {
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_unknown: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use: Option<String>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Tally {
    /// How many marks of this kind the file still holds — not how many ever happened.
    pub count: usize,
    /// How many marks each distinct reason accounts for. A bare count reads as a
    /// mixture; on sid-xeon-1 all 279 of them were one reason, which is a
    /// different fact and the one worth acting on (ISS-1192).
    pub by_reason: std::collections::BTreeMap<String, usize>,
    /// The most recent mark, which is what says WHY rather than how often.
    pub last: Option<Last>,
    /// Milliseconds since the epoch, the same clock every other mark on this box uses.
    pub last_at: Option<i64>,
    /// The oldest mark of this kind the file still holds, so a reader can see the window.
    pub first_at: Option<i64>,
    /// Whether older marks have been dropped, which makes `count` a floor rather than a total.
    pub trimmed: bool,
}

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
        let text = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        let detail = text("detail").unwrap_or_default();
        *slot.by_reason.entry(detail.clone()).or_default() += 1;
        slot.last = Some(Last {
            detail,
            source: text("source"),
            run: text("run"),
            run_unknown: text("run_unknown"),
            agent: text("agent"),
            role: text("role"),
            tool_use: text("tool_use"),
        });
        let at = v.get("at").and_then(serde_json::Value::as_i64);
        slot.last_at = at;
        if slot.first_at.is_none() {
            slot.first_at = at;
        }
    }
    let trimmed = body.lines().count() >= MAX_LINES / 2;
    degraded.trimmed = trimmed && degraded.count > 0;
    undeclared.trimmed = trimmed && undeclared.count > 0;
    (degraded, undeclared)
}

/// A window shorter than this states no rate at all. One mark in fifty-five
/// minutes extrapolates to whatever the arithmetic is asked for, and ISS-1192's
/// own counter was read both ways in one afternoon.
pub const MIN_WINDOW_MS: i64 = 60 * 60 * 1000;

/// Past this, the newest mark is history rather than an open wound. `149` alone
/// and `149 over 45 hours and still climbing` are different facts.
pub const RECENT_WITHIN_MS: i64 = 6 * 60 * 60 * 1000;

/// One undecided dispatch every two hours, held up over a window. Below it the
/// gate is marked and readable; at or above it the box is admitting work it
/// never judged, often enough that the instruction is advice.
pub const SUSTAINED_PER_DAY: f64 = 12.0;

/// The most `byReason` entries a condition carries. The file keeps up to
/// `MAX_LINES` marks and a reason is free text, so an unbounded breakdown is a
/// wire shape the consumer cannot declare; past this the tail folds into one
/// entry that SAYS what it stands for. The consumer's matching ceiling is
/// `packages/core/src/devices/gate-report.ts:WIRE_REASONS`, and
/// `gate-report.fixture.json` carries the number both sides read (ISS-1192).
pub const MAX_REASONS: usize = 24;

/// The most UTF-16 code units any one string in a condition carries. Details
/// interpolate pane ids and role names, so the length is not ours to promise.
/// The unit is the CONSUMER's: core's `utf16String` counts UTF-16 units, so
/// a bound counted in Unicode scalars would pass here and be refused there for
/// every string outside the basic plane. A clipped string says how much went;
/// the file keeps the whole of it.
pub const WIRE_UNITS: usize = 300;

/// The widest any string in a condition can be: `WIRE_UNITS` of the original
/// plus the clause that says what was cut. The consumer declares THIS number,
/// and `a_clipped_string_stays_inside_the_declared_ceiling` is what stops the
/// clause outgrowing it.
pub const WIRE_UNITS_CEILING: usize = WIRE_UNITS + 120;

/// A string's length in the unit the consumer measures.
fn units(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// What this box says about its own gate. One definition, read by
/// `cmd/status.rs`, by the heartbeat and by the daemon's own warning.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Nothing of this kind is on record.
    Clear,
    /// Marks exist, and the box will not call them a rate: too short a window,
    /// nothing recent, or under the threshold.
    Marked,
    /// A sustained rate, still running.
    FailingOpen,
}

/// A tally read as a rate over a window, which is the form the number has to
/// take to mean anything to a reader.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    pub verdict: Verdict,
    /// A floor where `trimmed`, never a lifetime total.
    pub count: usize,
    pub trimmed: bool,
    pub first_at: Option<i64>,
    pub last_at: Option<i64>,
    /// The span the kept marks cover, `None` where fewer than two of them do.
    pub window_ms: Option<i64>,
    pub per_day: Option<f64>,
    /// How long since the newest mark, which is what separates an open wound
    /// from a closed one.
    pub since_last_ms: Option<i64>,
    pub last: Option<Last>,
    /// What the count is made of, commonest first. A reason standing for the
    /// whole count and a genuine mixture are different facts about the same
    /// number, and only one of them is actionable.
    pub by_reason: Vec<ReasonCount>,
}

/// One reason, and how many of the kept marks carry it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReasonCount {
    pub reason: String,
    pub count: usize,
}

impl Condition {
    /// A kind this box has never marked.
    pub fn none() -> Self {
        Self {
            verdict: Verdict::Clear,
            count: 0,
            trimmed: false,
            first_at: None,
            last_at: None,
            window_ms: None,
            per_day: None,
            since_last_ms: None,
            last: None,
            by_reason: Vec::new(),
        }
    }
}

pub fn condition(t: &Tally, now_ms: i64) -> Condition {
    let window_ms = match (t.first_at, t.last_at) {
        (Some(first), Some(last)) if last > first => Some(last - first),
        _ => None,
    };
    let per_day = window_ms.map(|w| t.count as f64 * 86_400_000.0 / w as f64);
    let since_last_ms = t.last_at.map(|last| (now_ms - last).max(0));
    let verdict = if t.count == 0 {
        Verdict::Clear
    } else if window_ms.is_some_and(|w| w >= MIN_WINDOW_MS)
        && since_last_ms.is_some_and(|s| s <= RECENT_WITHIN_MS)
        && per_day.is_some_and(|r| r >= SUSTAINED_PER_DAY)
    {
        Verdict::FailingOpen
    } else {
        Verdict::Marked
    };
    Condition {
        verdict,
        count: t.count,
        trimmed: t.trimmed,
        first_at: t.first_at,
        last_at: t.last_at,
        window_ms,
        per_day,
        since_last_ms,
        last: t.last.as_ref().map(clipped_last),
        by_reason: by_reason(t),
    }
}

/// Commonest reason first, and alphabetical between equals so the order is the
/// file's content rather than its iteration. Past `MAX_REASONS` the tail is
/// summed into a final entry naming how many reasons and how many marks it
/// stands for: what leaves the list is stated, never missing.
fn by_reason(t: &Tally) -> Vec<ReasonCount> {
    let mut out: Vec<ReasonCount> = t
        .by_reason
        .iter()
        .map(|(reason, count)| ReasonCount {
            reason: clip(reason),
            count: *count,
        })
        .collect();
    out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.reason.cmp(&b.reason)));
    if out.len() > MAX_REASONS {
        let tail = out.split_off(MAX_REASONS - 1);
        let marks: usize = tail.iter().map(|r| r.count).sum();
        out.push(ReasonCount {
            reason: format!(
                "{} further reason(s), carried as this one total — read them on the box",
                tail.len()
            ),
            count: marks,
        });
    }
    out
}

/// A string at its wire width, saying how much of it did not fit. Cut on a char
/// boundary, so a surrogate pair is never halved and the clipped string is still
/// text rather than a shape the consumer has to guess at.
pub(crate) fn clip(s: &str) -> String {
    let whole = units(s);
    if whole <= WIRE_UNITS {
        return s.to_string();
    }
    let mut kept = String::new();
    let mut used = 0;
    for c in s.chars() {
        let w = c.len_utf16();
        if used + w > WIRE_UNITS {
            break;
        }
        kept.push(c);
        used += w;
    }
    format!("{kept}… (+{} more unit(s), whole on the box)", whole - used)
}

fn clip_opt(s: &Option<String>) -> Option<String> {
    s.as_deref().map(clip)
}

fn clipped_last(l: &Last) -> Last {
    Last {
        detail: clip(&l.detail),
        source: clip_opt(&l.source),
        run: clip_opt(&l.run),
        run_unknown: clip_opt(&l.run_unknown),
        agent: clip_opt(&l.agent),
        role: clip_opt(&l.role),
        tool_use: clip_opt(&l.tool_use),
    }
}

/// Both facts, as they leave the box.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Report {
    pub degraded: Condition,
    pub undeclared: Condition,
}

/// Read the file and say what condition this box's gate is in.
pub fn report(config_dir: &Path, now_ms: i64) -> Report {
    let (degraded, undeclared) = tally(config_dir);
    Report {
        degraded: condition(&degraded, now_ms),
        undeclared: condition(&undeclared, now_ms),
    }
}
