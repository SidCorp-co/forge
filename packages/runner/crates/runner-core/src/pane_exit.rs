//! Why a master pane this box placed is gone, read from what that pane printed
//! after it was placed, and the record of it `forge-runner master status` reads.
//!
//! Liveness stays what ISS-933 left it: the pane exists or it does not, and
//! nothing here decides either that or whether a pane is placed. What this adds
//! is the account of an exit already read. On 2026-09-29 sid-desk's pane died
//! within seconds of every placement for four and a half hours, and the box said
//! only `gone` once a sweep while `master status` said `pane gone` (ISS-1343).

use std::io::{Read as _, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use runner_platform::subagent_host::{Hosts, Running};

/// How soon after its placement a pane has to be read gone for its exit to
/// count as early.
// this labels an exit for the journal and never gates a placement. A pane is read gone by the next sweep, up to `POLL_INTERVAL` (30s) after it died, so the window has to cover a pane that died at once and was read one sweep later, with room for a sweep that ran late. Three sweeps' worth does that and still leaves a pane that ran for minutes outside it.
pub const EARLY_EXIT: Duration = Duration::from_secs(90);

/// The early exit, of consecutive ones for one reason, at which the run of them
/// is named as one condition.
// three, not two: a single exit and its replacement dying the same way once more is an ordinary restart that met the same fault twice. The count only decides what is said, which is why it may be small; it is not the ISS-928 breaker ISS-933 deleted and it must never be read by a placement.
pub const NAMED_AFTER: u32 = 3;

/// What Claude Code prints when asked to resume a conversation it is already
/// running as a background session, captured from a pane on sid-xeon-1
/// (2026-09-29): `Session <id> is running as a background session (<short>).
/// Run `claude attach <short>` to open it, or `claude stop <short>` first to
/// resume it here.`
const BACKGROUND_SESSION: &str = "is running as a background session";

/// How much of a pane's output is read for why it exited: the sentence is
/// printed last, and a pane that ran for hours printed a great deal first.
const EXIT_TAIL: u64 = 64 * 1024;

/// How many characters of a pane's last words an exit carries.
const LAST_WORDS: usize = 240;

/// The file beside a project's `transcript.log` that holds its last exit.
const RECORD_FILE: &str = "last-exit.json";

/// Why a pane this box placed exited, as far as its own output says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Exit {
    /// Claude Code refused to resume `conversation` because a background
    /// session runs it; `short` is the id that refusal printed for it.
    Elsewhere {
        conversation: String,
        short: Option<String>,
    },
    /// The last words the pane printed after it was placed.
    Printed { last: String },
    /// The pane printed nothing after it was placed.
    Silent,
    /// What the pane printed cannot be read here, and why.
    Unread { why: String },
}

impl Exit {
    /// A pane this daemon has no placement mark for: adopted, or placed before
    /// this daemon last started.
    pub fn not_placed() -> Self {
        Self::Unread {
            why: "this daemon did not place that pane, or placed it before it last started, so it holds no mark of where the pane's own output begins".into(),
        }
    }

    /// A pane placed with no transcript to write its output to.
    pub fn no_transcript() -> Self {
        Self::Unread {
            why: "that pane was placed with no transcript file, so nothing it printed was kept"
                .into(),
        }
    }
}

impl std::fmt::Display for Exit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Elsewhere {
                conversation,
                short,
            } => {
                write!(
                    f,
                    "it exited printing that conversation {conversation} is running as a background session"
                )?;
                match short {
                    Some(s) => write!(f, " ({s})"),
                    None => Ok(()),
                }
            }
            Self::Printed { last } => write!(f, "it exited having printed last: \"{last}\""),
            Self::Silent => write!(f, "it exited having printed nothing since it was placed"),
            Self::Unread { why } => write!(f, "why it exited is not known here: {why}"),
        }
    }
}

/// What frees a conversation a background session holds, and whose act that
/// is, in Claude Code's own verbs with the id its refusal printed.
pub fn remedy(conversation: &str, short: Option<&str>) -> String {
    let (id, note) = match short {
        Some(s) => (s, ""),
        None => (
            conversation,
            " (the refusal printed no short id, so the conversation id is named)",
        ),
    };
    format!(
        "Freeing it is a person's or a master's act: this daemon never stops or attaches another Claude session itself. `claude attach {id}` opens that session and `claude stop {id}` ends it{note}"
    )
}

/// A pane's raw output as the words a person reads on it. Claude Code places
/// each word with a cursor move rather than a space, so an escape sequence is
/// read as a space and every other control character is dropped.
fn screen_words(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    while chars
                        .next()
                        .is_some_and(|b| !('\x40'..='\x7e').contains(&b))
                    {}
                }
                Some('(' | ')') => {
                    chars.next();
                }
                _ => {}
            }
            out.push(' ');
        } else if c.is_control() {
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The conversation and short id the last background-session sentence in
/// `text` names.
fn elsewhere_in(text: &str) -> Option<(String, Option<String>)> {
    let at = text.rfind(BACKGROUND_SESSION)?;
    let id = text[..at].rsplit("Session ").next()?.trim();
    if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
    }
    let short = text[at + BACKGROUND_SESSION.len()..]
        .trim_start()
        .strip_prefix('(')
        .and_then(|rest| rest.split_once(')'))
        .map(|(s, _)| s.trim())
        .filter(|s| !s.is_empty() && !s.contains(char::is_whitespace))
        .map(str::to_string);
    Some((id.to_string(), short))
}

/// Why the pane whose output is at `path`, written from byte `from` on, exited.
pub fn classify(path: &Path, from: u64) -> Exit {
    let unread = |e: std::io::Error| Exit::Unread {
        why: format!("its output at {} could not be read: {e}", path.display()),
    };
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(e) => return unread(e),
    };
    let len = match file.metadata() {
        Ok(m) => m.len(),
        Err(e) => return unread(e),
    };
    if len < from {
        return Exit::Unread {
            why: format!(
                "its output at {} is shorter than it was when the pane was placed, so what the pane printed is no longer there to read",
                path.display()
            ),
        };
    }
    let start = from.max(len.saturating_sub(EXIT_TAIL));
    let mut raw = Vec::new();
    if let Err(e) = file
        .seek(SeekFrom::Start(start))
        .and_then(|_| file.read_to_end(&mut raw))
    {
        return unread(e);
    }
    let text = screen_words(&String::from_utf8_lossy(&raw));
    if let Some((conversation, short)) = elsewhere_in(&text) {
        return Exit::Elsewhere {
            conversation,
            short,
        };
    }
    if text.is_empty() {
        return Exit::Silent;
    }
    let count = text.chars().count();
    let last = if count > LAST_WORDS {
        let tail: String = text.chars().skip(count - LAST_WORDS).collect();
        format!("…{tail}")
    } else {
        text
    };
    Exit::Printed { last }
}

/// Consecutive early exits of one project's pane for one reason.
#[derive(Debug, Clone, Default)]
pub struct Tally {
    in_a_row: u32,
    last: Option<Exit>,
}

/// Where one exit stands in its project's run of early exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Counted {
    /// Its place in a run of early exits for its reason: 0 where it was not
    /// early.
    pub in_a_row: u32,
    /// The length of a run already named as a condition that this exit ended,
    /// by being for another reason or by not being early.
    pub ended: Option<u32>,
}

impl Tally {
    /// The length of the run so far, where it has been named as a condition.
    fn named(&self) -> Option<u32> {
        (self.in_a_row >= NAMED_AFTER).then_some(self.in_a_row)
    }

    /// Count an exit read gone `lived` after its placement into the run of
    /// early exits for one reason. An exit that is not early, or is for
    /// another reason, ends the run, and a run that had been named answers its
    /// length so that its end is said once.
    pub fn count(&mut self, lived: Option<Duration>, exit: &Exit) -> Counted {
        if !lived.is_some_and(|l| l < EARLY_EXIT) {
            let ended = self.named();
            *self = Self::default();
            return Counted { in_a_row: 0, ended };
        }
        if self.last.as_ref() == Some(exit) {
            self.in_a_row += 1;
            return Counted {
                in_a_row: self.in_a_row,
                ended: None,
            };
        }
        let ended = self.named();
        self.in_a_row = 1;
        self.last = Some(exit.clone());
        Counted { in_a_row: 1, ended }
    }

    /// A pane read up past the early window: ends the run, answering its
    /// length where it had been named as a condition.
    pub fn outlived(&mut self) -> Option<u32> {
        let named = self.named();
        *self = Self::default();
        named
    }
}

/// What ended a run of early exits that had been named as one condition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The pane placed after it was read alive past the early window.
    StayedUp,
    /// The next pane exited early for a different reason.
    OtherReason,
    /// The next pane was read gone, but not within the early window of its
    /// placement, or with no placement mark to measure from.
    NotEarly(Option<Duration>),
}

/// The one line that says a named condition of `n` early exits has ended.
pub fn ended(slug: &str, name: &str, n: u32, how: Ended) -> String {
    let window = EARLY_EXIT.as_secs();
    let because = match how {
        Ended::StayedUp => format!("{name} has stayed up past {window}s of its placement"),
        Ended::OtherReason => format!(
            "{name} has exited early for a different reason, said next on its own"
        ),
        Ended::NotEarly(Some(l)) => format!(
            "{name} was read gone {}s after its placement, outside the {window}s early window",
            l.as_secs()
        ),
        Ended::NotEarly(None) => format!(
            "{name} was read gone with no placement mark in this daemon to measure it from, so its exit cannot count as early"
        ),
    };
    format!("[master] {slug}: {because}, so the condition of {n} early exits in a row has ended")
}

/// A journal line and the level it is said at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Say {
    Warn(String),
    Error(String),
    /// A repeat of a condition already named: kept at DEBUG so the journal
    /// carries it once rather than once per placement.
    Quiet(String),
}

/// How long after its placement a pane was read gone, as a phrase.
fn within(lived: Option<Duration>) -> String {
    match lived {
        Some(l) => format!(", read gone {}s after it was placed", l.as_secs()),
        None => String::new(),
    }
}

/// What the journal says about one exit, the `in_a_row`-th early one for its
/// reason (0 where it was not early).
pub fn journal(slug: &str, name: &str, lived: Option<Duration>, exit: &Exit, in_a_row: u32) -> Say {
    let tail = match exit {
        Exit::Elsewhere {
            conversation,
            short,
        } => format!(". {}", remedy(conversation, short.as_deref())),
        _ => String::new(),
    };
    let line = format!(
        "[master] {slug}: resident session {name} is gone{} — {exit} — closing its row{tail}",
        within(lived)
    );
    match in_a_row {
        0 | 1 => Say::Warn(line),
        n if n == NAMED_AFTER => Say::Error(format!(
            "[master] {slug}: {name} has been read gone within {}s of each of its last {n} placements, each time because {exit}. One condition, said here once rather than on every placement: this box goes on placing a pane on each sweep whose gates admit one, because it decides nothing from a count of exits (ISS-933), and `forge-runner master status {slug}` carries the running count{tail}",
            EARLY_EXIT.as_secs()
        )),
        n => Say::Quiet(format!("{line} ({n} early exits in a row for this reason)")),
    }
}

/// The last exit of one project's pane, as the daemon records it for
/// `forge-runner master status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub pane: String,
    /// Unix seconds at which the sweep read the pane gone.
    pub read_gone_at: i64,
    /// Seconds from placement to that read, where this daemon placed it.
    pub lived_secs: Option<u64>,
    /// Its place in a run of early exits for one reason; 0 where not early.
    pub in_a_row: u32,
    pub exit: Exit,
}

/// Where a project's last exit is kept, in the directory `master_dir` names.
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

/// What reading a project's last exit found.
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

fn ago(secs: i64) -> String {
    let secs = secs.max(0);
    match secs {
        s if s < 120 => format!("{s}s ago"),
        s if s < 7200 => format!("{}m ago", s / 60),
        s if s < 172_800 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    }
}

/// The `last exit` line of `master status`, for a pane that is gone. A
/// background-session exit is read against `hosts` now, since who holds the
/// conversation is a present fact and the record is a past one.
pub fn status_line(found: &Found, now: i64, hosts: &dyn Hosts) -> String {
    let record = match found {
        Found::None => {
            return "none recorded — this box has not read a pane it placed for this project gone since it began keeping this record".into()
        }
        Found::Unavailable(why) => return format!("unavailable: {why}"),
        Found::Record(r) => r,
    };
    let when = match record.lived_secs {
        Some(s) => format!("{s}s after it was placed"),
        None => "at an unknown time after its placement".into(),
    };
    let run = match record.in_a_row {
        0 => "not an early exit".to_string(),
        1 => "the first early exit for this reason".to_string(),
        n => format!("{n} placements in a row read gone early for this reason"),
    };
    let mut line = format!(
        "{} read gone {}, {when}; {run}: {}",
        record.pane,
        ago(now - record.read_gone_at),
        record.exit
    );
    if let Exit::Elsewhere {
        conversation,
        short,
    } = &record.exit
    {
        let remedy = remedy(conversation, short.as_deref());
        line.push_str(&match hosts.running(conversation) {
            Running::Found(pid) => format!(
                ". Process {pid} on this box names conversation {conversation} now, so the daemon places no pane resuming it. {remedy}"
            ),
            Running::Absent => format!(
                ". No process on this box names conversation {conversation} now, so that hold no longer withholds a pane — placement still answers to the standing and runner lines"
            ),
            Running::Unreadable => format!(
                ". This box's process table could not be read whole, so whether a process still names conversation {conversation} is not known here, and the daemon withholds a pane while it cannot tell. {remedy}"
            ),
        });
    }
    line
}
