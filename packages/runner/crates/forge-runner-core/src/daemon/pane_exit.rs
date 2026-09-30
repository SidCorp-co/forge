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

use crate::daemon::subagent_host::{Hosts, Running};

/// How soon after its placement a pane has to be read gone for its exit to
/// count as early.
// cm:guard this labels an exit for the journal and never gates a placement. A pane is read gone by the next sweep, up to `POLL_INTERVAL` (30s) after it died, so the window has to cover a pane that died at once and was read one sweep later, with room for a sweep that ran late. Three sweeps' worth does that and still leaves a pane that ran for minutes outside it.
pub const EARLY_EXIT: Duration = Duration::from_secs(90);

/// The early exit, of consecutive ones for one reason, at which the run of them
/// is named as one condition.
// cm:guard three, not two: a single exit and its replacement dying the same way once more is an ordinary restart that met the same fault twice. The count only decides what is said, which is why it may be small; it is not the ISS-928 breaker ISS-933 deleted and it must never be read by a placement.
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

impl Tally {
    /// Count an exit read gone `lived` after its placement, and answer the
    /// place it takes in a run of early exits for one reason: 0 where it was
    /// not early, which ends any run.
    pub fn count(&mut self, lived: Option<Duration>, exit: &Exit) -> u32 {
        if !lived.is_some_and(|l| l < EARLY_EXIT) {
            *self = Self::default();
            return 0;
        }
        if self.last.as_ref() == Some(exit) {
            self.in_a_row += 1;
        } else {
            self.in_a_row = 1;
            self.last = Some(exit.clone());
        }
        self.in_a_row
    }

    /// A pane read up past the early window: ends the run, answering its
    /// length where it had been named as a condition.
    pub fn outlived(&mut self) -> Option<u32> {
        let named = (self.in_a_row >= NAMED_AFTER).then_some(self.in_a_row);
        *self = Self::default();
        named
    }
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

/// The directory this box keeps `slug`'s master transcript and last exit in.
/// The daemon writes the record here, so it resolves through
/// [`crate::config::base_dir`], the one resolution a test build refuses outside
/// a scratch (ISS-1344).
pub fn master_dir(slug: &str) -> crate::error::Result<PathBuf> {
    Ok(crate::config::base_dir()?.join("master").join(slug))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::subagent_host::ProcHosts;

    /// The bytes forge-master-sid-desk's pane wrote on sid-xeon-1
    /// (2026-09-29, `~/.config/forge-runner/master/sid-desk/transcript.log`):
    /// Claude Code places each word with a cursor move, not a space.
    pub(crate) const SID_DESK_EXIT: &str = "\x1b[?25h\x1b[38;5;211mSession\x1b[9G19793a14-07b1-4970-9f51-3262792c1414\x1b[46Gis\x1b[49Grunning\x1b[57Gas\x1b[60Ga\x1b[62Gbackground\x1b[73Gsession\x1b[81G(19793a14).\x1b[93GRun\x1b[97G`claude\x1b[105Gattach\x1b[112G19793a14`\x1b[122Gto\x1b[125Gopen\x1b[130Git,\x1b[134Gor\x1b[137G`claude\x1b[145Gstop\x1b[150G19793a14`\x1b[160Gfirst\x1b[166Gto\x1b[169Gresume\x1b[176Git\x1b[179Ghere.\x1b[39m\r\r\n\x1b[38;5;211mcopy\x1b[6Ginstead.\x1b[39m\r\r\n\x1b[?25h\x1b(B\x0f\x1b[?1016l\x1b7\x1b[r\x1b8";

    const CONV: &str = "19793a14-07b1-4970-9f51-3262792c1414";

    fn elsewhere() -> Exit {
        Exit::Elsewhere {
            conversation: CONV.into(),
            short: Some("19793a14".into()),
        }
    }

    fn background_session_named(raw: &str) -> Option<String> {
        elsewhere_in(&screen_words(raw)).map(|(conversation, _)| conversation)
    }

    #[test]
    fn a_pane_s_own_bytes_name_the_conversation_running_as_a_background_session() {
        assert_eq!(
            background_session_named(SID_DESK_EXIT).as_deref(),
            Some(CONV)
        );
        assert_eq!(
            background_session_named("Session abc exited\r\n"),
            None,
            "a pane that exited for anything else names nothing"
        );
    }

    #[test]
    fn only_what_the_pane_this_box_placed_printed_is_read() {
        let dir = crate::test_scratch::Scratch::new("pane-exit");
        let path = dir.join("transcript.log");
        std::fs::write(&path, SID_DESK_EXIT).unwrap();
        let from = std::fs::metadata(&path).unwrap().len();
        assert_eq!(classify(&path, 0), elsewhere());
        assert_eq!(
            classify(&path, from),
            Exit::Silent,
            "an earlier pane's sentence is not why this one exited"
        );
        let mut later = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        std::io::Write::write_all(&mut later, b"\x1b[2J\x1b[Hbye\r\n").unwrap();
        assert_eq!(classify(&path, from), Exit::Printed { last: "bye".into() });
    }

    #[test]
    fn the_short_id_is_the_one_the_refusal_printed() {
        assert_eq!(
            elsewhere_in("Session abc-def is running as a background session. Run it"),
            Some(("abc-def".into(), None)),
            "a refusal with no short id names none rather than a guess"
        );
        assert_eq!(
            elsewhere_in("Session abc-def is running as a background session (abc)."),
            Some(("abc-def".into(), Some("abc".into())))
        );
    }

    #[test]
    fn an_exit_whose_output_is_gone_or_long_says_so() {
        let dir = crate::test_scratch::Scratch::new("pane-exit-long");
        let path = dir.join("transcript.log");
        assert!(
            matches!(classify(&path, 0), Exit::Unread { why } if why.contains("could not be read")),
            "a missing file is unread, never silent"
        );
        std::fs::write(&path, "short").unwrap();
        assert!(
            matches!(classify(&path, 100), Exit::Unread { why } if why.contains("shorter")),
            "a file cut below the placement mark is unread, never silent"
        );
        let words: String = (0..400).map(|n| format!("w{n} ")).collect();
        std::fs::write(&path, &words).unwrap();
        match classify(&path, 0) {
            Exit::Printed { last } => {
                assert!(last.starts_with('…'), "{last}");
                assert!(last.ends_with("w399"), "the LAST words are kept: {last}");
                assert!(last.chars().count() <= LAST_WORDS + 1, "{last}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_exit_line_says_why_and_never_only_gone() {
        let cases = [
            elsewhere(),
            Exit::Printed {
                last: "Error: config unreadable".into(),
            },
            Exit::Silent,
            Exit::not_placed(),
        ];
        for exit in cases {
            let Say::Warn(line) = journal(
                "sid-desk",
                "forge-master-sid-desk",
                Some(Duration::from_secs(27)),
                &exit,
                1,
            ) else {
                panic!("the first exit is a warning");
            };
            assert!(line.contains(&exit.to_string()), "{line}");
            assert!(line.contains("read gone 27s after it was placed"), "{line}");
        }
    }

    #[test]
    fn a_held_conversation_names_its_freeing_as_somebody_else_s_act() {
        let Say::Warn(line) = journal("d", "forge-master-d", None, &elsewhere(), 1) else {
            panic!("a warning");
        };
        for said in [
            "`claude attach 19793a14`",
            "`claude stop 19793a14`",
            "never stops or attaches another Claude session itself",
            "a person's or a master's act",
        ] {
            assert!(line.contains(said), "`{said}` missing: {line}");
        }
    }

    #[test]
    fn repeated_early_exits_are_one_condition_said_once() {
        let exit = Exit::Printed {
            last: "boom".into(),
        };
        let quick = Some(Duration::from_secs(25));
        let mut tally = Tally::default();
        let said: Vec<Say> = (0..6)
            .map(|_| {
                let n = tally.count(quick, &exit);
                journal("p", "forge-master-p", quick, &exit, n)
            })
            .collect();
        assert!(matches!(said[0], Say::Warn(_)), "{said:?}");
        assert!(matches!(said[1], Say::Quiet(_)), "{said:?}");
        match &said[2] {
            Say::Error(l) => {
                assert!(l.contains("last 3 placements"), "{l}");
                assert!(l.contains("One condition"), "{l}");
            }
            other => panic!("the third is the named condition: {other:?}"),
        }
        assert!(
            said[3..].iter().all(|s| matches!(s, Say::Quiet(_))),
            "nothing more at WARN or ERROR: {said:?}"
        );
    }

    #[test]
    fn a_pane_that_stays_up_or_a_new_reason_starts_the_count_again() {
        let boom = Exit::Printed {
            last: "boom".into(),
        };
        let quick = Some(Duration::from_secs(25));
        let mut tally = Tally::default();
        for _ in 0..3 {
            tally.count(quick, &boom);
        }
        assert_eq!(tally.outlived(), Some(3), "a named run ends, said once");
        assert_eq!(tally.outlived(), None, "and not twice");
        assert_eq!(tally.count(quick, &boom), 1, "the next is a first again");

        assert_eq!(tally.count(quick, &boom), 2);
        assert_eq!(
            tally.count(quick, &Exit::Silent),
            1,
            "a new reason restarts it"
        );
        assert_eq!(
            tally.count(Some(EARLY_EXIT), &Exit::Silent),
            0,
            "an exit at the window's edge is not early"
        );
        assert_eq!(
            tally.count(None, &Exit::Silent),
            0,
            "nor one of unknown age"
        );
        assert_eq!(tally.count(quick, &Exit::Silent), 1);
    }

    fn proc_with(conv: Option<&str>) -> crate::test_scratch::Scratch {
        let root = crate::test_scratch::Scratch::new("pane-exit-proc");
        let pid = root.join("3850261");
        std::fs::create_dir_all(&pid).unwrap();
        let args = match conv {
            Some(c) => format!("claude\0bg-pty-host\0--session-id\0{c}\0"),
            None => "sleep\0infinity\0".into(),
        };
        std::fs::write(pid.join("cmdline"), args).unwrap();
        root
    }

    fn held(in_a_row: u32) -> Found {
        Found::Record(Record {
            pane: "forge-master-sid-desk".into(),
            read_gone_at: 1_000,
            lived_secs: Some(4),
            in_a_row,
            exit: elsewhere(),
        })
    }

    #[test]
    fn status_names_the_process_holding_the_conversation_now() {
        let root = proc_with(Some(CONV));
        let line = status_line(&held(1), 1_030, &ProcHosts::at(&root));
        for said in [
            "forge-master-sid-desk read gone 30s ago, 4s after it was placed",
            "the first early exit for this reason",
            "Process 3850261 on this box names conversation 19793a14-07b1-4970-9f51-3262792c1414 now",
            "`claude stop 19793a14`",
            "never stops or attaches another Claude session itself",
        ] {
            assert!(line.contains(said), "`{said}` missing: {line}");
        }
    }

    #[test]
    fn status_says_a_hold_no_process_carries_withholds_nothing() {
        let root = proc_with(None);
        let line = status_line(&held(2), 1_030, &ProcHosts::at(&root));
        assert!(
            line.contains("No process on this box names conversation"),
            "{line}"
        );
        assert!(line.contains("no longer withholds a pane"), "{line}");
        assert!(
            line.contains("placement still answers to the standing and runner lines"),
            "it promises no pane: {line}"
        );
        assert!(line.contains("2 placements in a row"), "{line}");
    }

    #[test]
    fn status_says_when_the_process_table_cannot_be_read() {
        let root = crate::test_scratch::Scratch::new("pane-exit-noproc");
        let missing = root.join("absent");
        let line = status_line(&held(1), 1_030, &ProcHosts::at(&missing));
        assert!(line.contains("could not be read whole"), "{line}");
        assert!(!line.contains("Process 3850261"), "{line}");
        assert!(!line.contains("no longer withholds"), "{line}");
    }

    #[test]
    fn status_without_a_record_or_with_a_broken_one_says_which() {
        let dir = crate::test_scratch::Scratch::new("pane-exit-rec");
        let hosts = ProcHosts::at(&dir);
        assert_eq!(read(&dir), Found::None);
        assert!(status_line(&read(&dir), 0, &hosts).starts_with("none recorded"));

        std::fs::write(record_path(&dir), "{not json").unwrap();
        let line = status_line(&read(&dir), 0, &hosts);
        assert!(line.starts_with("unavailable:"), "{line}");
        assert!(line.contains("does not parse"), "{line}");

        std::fs::remove_file(record_path(&dir)).unwrap();
        std::fs::create_dir(record_path(&dir)).unwrap();
        let line = status_line(&read(&dir), 0, &hosts);
        assert!(line.starts_with("unavailable:"), "{line}");
        assert!(line.contains("could not be read"), "{line}");
    }

    #[test]
    fn a_record_written_is_the_record_read() {
        let dir = crate::test_scratch::Scratch::new("pane-exit-rt");
        let Found::Record(r) = held(3) else {
            unreachable!()
        };
        write(&dir, &r).unwrap();
        assert_eq!(read(&dir), Found::Record(r));
        let printed = Record {
            pane: "p".into(),
            read_gone_at: 5,
            lived_secs: None,
            in_a_row: 0,
            exit: Exit::Printed { last: "x".into() },
        };
        write(&dir, &printed).unwrap();
        assert_eq!(read(&dir), Found::Record(printed), "replaced whole");
    }

    /// Criterion 13: freeing a held conversation is never this code's act.
    #[test]
    fn nothing_here_passes_stop_or_attach_to_a_process() {
        for (file, source) in [
            ("pane_exit.rs", include_str!("pane_exit.rs")),
            ("master.rs", include_str!("master.rs")),
            (
                "cmd/master.rs",
                include_str!("../../../forge-runner/src/cmd/master.rs"),
            ),
        ] {
            let production = source.split("#[cfg(test)]").next().unwrap();
            for banned in ["\"stop\"", "\"attach\"", "signal::kill("] {
                assert!(
                    !production.contains(banned),
                    "{file} carries `{banned}`: stopping or attaching another Claude session is a person's or a master's act, never the daemon's (ISS-1343)"
                );
            }
        }
    }
}
