//! The forge-master skill a bound checkout carries, and the record of every
//! write of it.
//!
//! The skill used to be written only where a pane was placed, so it followed
//! "a pane was placed here since the last build" rather than "this project is
//! bound to a box running this build": an adopted pane kept the copy it was
//! placed with, and a bound project with no master had none (ISS-1357). It is
//! now written at bind, at provision and at every daemon start, and placement
//! goes through the same rule.
//!
//! The file lands under `.claude/`, which is only harmless where the
//! checkout's git ignores it. Where it does not, `.claude/` is first added to
//! the checkout's box-local exclude file ([`git_exclude`]); where that cannot
//! be done, or the file is tracked, the write is refused and recorded rather
//! than made.
//!
//! `forge-runner status` is another process, so every outcome goes into
//! [`RECORD`] in the runner's config directory, which it reads back.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::daemon::git_exclude::{self, Refused};

pub const ASSET: &str = include_str!("../../assets/forge-master-skill.md");

/// Where the skill lives inside a checkout, as git names it.
pub const RELATIVE: &str = ".claude/skills/forge-master/SKILL.md";

/// The skill's file in `repo`, joined component by component so the path
/// printed carries one separator, the platform's own.
pub fn path_in(repo: &Path) -> PathBuf {
    RELATIVE
        .split('/')
        .fold(repo.to_path_buf(), |p, c| p.join(c))
}

pub const RECORD: &str = "master-skill.json";
const LOCK: &str = "master-skill.json.lock";

/// The record's shape. A reader refuses any other by name rather than read a
/// newer build's record as this one's.
pub const RECORD_VERSION: u32 = 1;

/// What one install did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Outcome {
    /// The file was absent or held other bytes, and now holds the asset.
    Written,
    /// The file already held the asset, and was left untouched.
    Current,
    /// The checkout's git still does not ignore the path with `.claude/` in
    /// `exclude`, so a rule of its own un-ignores it.
    NotIgnored { exclude: PathBuf },
    /// The checkout's git tracks the path, which no ignore rule undoes.
    Tracked,
    /// The checkout could not be written, or whether it may be could not be read.
    Failed { detail: String },
    /// The project is assigned to this box and names a checkout on neither side.
    NoCheckout,
}

impl Outcome {
    pub fn installed(&self) -> bool {
        matches!(self, Outcome::Written | Outcome::Current)
    }

    /// What this outcome says about `path`, in the words `status` and the
    /// journal both print.
    pub fn says(&self, path: Option<&Path>, build: &str) -> String {
        let shown = path
            .map(|p| path_in(p).display().to_string())
            .unwrap_or_else(|| "no checkout".into());
        match self {
            Outcome::Written => format!("written by {build} ← {shown}"),
            Outcome::Current => {
                format!("already the asset of {build}, which checked it and left it untouched ← {shown}")
            }
            Outcome::NotIgnored { exclude } => format!(
                "NOT WRITTEN — {} holds `.claude/` and that checkout's git still does not ignore {RELATIVE}, so a rule of its own (a `!` pattern in a .gitignore) un-ignores it and writing it would leave untracked work there; remove that rule and the next daemon start writes it (checked by {build}) ← {shown}",
                exclude.display()
            ),
            Outcome::Tracked => format!(
                "NOT WRITTEN — that checkout's git tracks {RELATIVE}, so writing it would change a committed file; an ignore rule does not undo that, so it is written only once somebody takes it out of the index on purpose (`git rm --cached`), and the next daemon start then ignores and writes it (checked by {build}) ← {shown}"
            ),
            Outcome::Failed { detail } => {
                format!("NOT WRITTEN — {detail} (checked by {build}) ← {shown}")
            }
            Outcome::NoCheckout => format!(
                "NOT WRITTEN — assigned to this box and names a checkout on neither side, so there is nowhere to write it; `forge-runner bind <slug> --path <dir>` (checked by {build})"
            ),
        }
    }
}

/// Which write point an outcome came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Point {
    Start,
    Bind,
    Provision,
    Placement,
}

impl Point {
    pub fn word(self) -> &'static str {
        match self {
            Point::Start => "at daemon start",
            Point::Bind => "at bind",
            Point::Provision => "at provision",
            Point::Placement => "at pane placement",
        }
    }
}

/// Write the asset into `repo`, or say why not. Never writes outside
/// `<repo>/.claude/skills/forge-master/` but for the one exclude line
/// [`git_exclude::ensure_ignored`] adds.
pub fn install(repo: &Path) -> Outcome {
    match std::fs::metadata(repo) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return failed(format!("{} is not a directory", repo.display()));
        }
        Err(e) => return failed(format!("the checkout {}: {e}", repo.display())),
    }
    // Asked of the directory: the write stages a temporary sibling there first.
    match git_exclude::ensure_ignored_as(repo, RELATIVE, ".claude/skills/forge-master/") {
        Ok(_) => {}
        Err(Refused::Tracked) => return Outcome::Tracked,
        Err(Refused::StillNotIgnored { exclude }) => return Outcome::NotIgnored { exclude },
        Err(refused @ (Refused::Exclude { .. } | Refused::Git(_))) => {
            return failed(refused.to_string())
        }
    }
    let path = path_in(repo);
    match std::fs::read(&path) {
        Ok(bytes) if bytes == ASSET.as_bytes() => return Outcome::Current,
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return failed(format!("{}: {e}", path.display())),
    }
    match write_replacing(&path, ASSET.as_bytes()) {
        Ok(()) => Outcome::Written,
        Err(e) => failed(format!("{}: {e}", path.display())),
    }
}

fn failed(detail: String) -> Outcome {
    Outcome::Failed { detail }
}

/// Through a sibling and a rename, so a session reading the skill while it is
/// replaced reads one whole copy or the other.
fn write_replacing(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().expect("RELATIVE has a parent");
    std::fs::create_dir_all(dir)?;
    static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = dir.join(format!(".SKILL.md.{}.{n}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, bytes).and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub slug: String,
    pub path: Option<PathBuf>,
    pub at_ms: i64,
    pub point: Point,
    /// The build that made this install, `<version> (<commit>)`.
    pub build: String,
    pub outcome: Outcome,
}

impl Entry {
    pub fn now(slug: &str, path: Option<&Path>, point: Point, outcome: Outcome) -> Self {
        Self {
            slug: slug.to_string(),
            path: path.map(Path::to_path_buf),
            at_ms: crate::daemon::agent_activity::now_ms(),
            point,
            build: format!(
                "{} ({})",
                crate::update::CURRENT_VERSION,
                crate::update::BUILD_COMMIT
            ),
            outcome,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    /// One per project and checkout: a project whose server and local
    /// bindings name two checkouts has a line for each, and one naming none
    /// has a line of its own.
    pub entries: Vec<Entry>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Absent,
    Unreadable(String),
    Record(Record),
}

pub fn record_path(dir: &Path) -> PathBuf {
    dir.join(RECORD)
}

pub fn read(dir: &Path) -> Read {
    let path = record_path(dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Absent,
        Err(e) => return Read::Unreadable(format!("{}: {e}", path.display())),
    };
    parse(&path, &raw)
}

fn parse(path: &Path, raw: &str) -> Read {
    let doc: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return Read::Unreadable(format!("{}: does not parse: {e}", path.display())),
    };
    match doc.get("version").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(RECORD_VERSION) => {}
        Some(v) => {
            return Read::Unreadable(format!(
                "{}: version {v}, which this build does not read (it reads {RECORD_VERSION})",
                path.display()
            ))
        }
        None => {
            return Read::Unreadable(format!("{}: carries no version", path.display()));
        }
    }
    match serde_json::from_value(doc) {
        Ok(r) => Read::Record(r),
        Err(e) => Read::Unreadable(format!("{}: does not parse: {e}", path.display())),
    }
}

/// How a write merges into what the record already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Merge {
    /// The start sweep's whole census, begun at `since_ms`: a line it does not
    /// cover is a project no longer bound and goes, unless it was recorded
    /// after the census began — a `bind` the census could not have seen.
    Census { since_ms: i64 },
    /// One write point, one checkout: every other line stands.
    Upsert,
}

fn same_checkout(a: &Entry, b: &Entry) -> bool {
    a.slug == b.slug && a.path == b.path
}

fn merged(held: Vec<Entry>, new: Vec<Entry>, merge: Merge) -> Vec<Entry> {
    let covered = |e: &Entry| {
        new.iter().any(|n| {
            same_checkout(n, e)
                // A project now recorded with a checkout no longer has none.
                || (e.slug == n.slug && e.path.is_none() && n.path.is_some())
        })
    };
    let mut out: Vec<Entry> = held
        .into_iter()
        .filter(|e| !covered(e))
        .filter(|e| match merge {
            Merge::Census { since_ms } => e.at_ms >= since_ms,
            Merge::Upsert => true,
        })
        .collect();
    out.extend(new);
    out.sort_by(|a, b| (&a.slug, &a.path).cmp(&(&b.slug, &b.path)));
    out
}

/// Merge `entries` into the record under an exclusive lock, so a `bind` and
/// the daemon writing at once cannot drop each other's line.
pub fn record(dir: &Path, entries: Vec<Entry>, merge: Merge) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let lock_path = dir.join(LOCK);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("{}: {e}", lock_path.display()))?;
    lock.lock()
        .map_err(|e| format!("{}: {e}", lock_path.display()))?;
    let held = match read(dir) {
        Read::Absent => Vec::new(),
        Read::Record(r) => r.entries,
        Read::Unreadable(why) if why.contains("which this build does not read") => {
            return Err(format!("not overwriting a newer build's record — {why}"));
        }
        // A torn or foreign file holds no line anyone can read back.
        Read::Unreadable(_) => Vec::new(),
    };
    let doc = Record {
        version: RECORD_VERSION,
        entries: merged(held, entries, merge),
    };
    let body = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let path = record_path(dir);
    let tmp = dir.join(format!("{RECORD}.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| format!("{}: {e}", path.display()))
}

/// Install into one checkout, record the outcome where `dir` names a record,
/// and log it. What bind, provision and placement each call.
pub fn install_and_record(slug: &str, repo: &Path, point: Point, dir: Option<&Path>) -> Outcome {
    let outcome = install(repo);
    let entry = Entry::now(slug, Some(repo), point, outcome.clone());
    log(&entry);
    save(dir, vec![entry], Merge::Upsert);
    outcome
}

/// Install into every checkout this box is bound to, once per checkout, and
/// record a line for each project at each, and each assignment naming no
/// checkout. `census_from` is when the set was read, and is `None` where it is
/// not the whole census: one read without the server's assignments prunes
/// nothing, since the lines it would drop are the projects it could not see.
pub fn install_every(
    checkouts: &[(String, PathBuf)],
    pathless: &[String],
    census_from: Option<i64>,
    dir: Option<&Path>,
) -> Vec<Entry> {
    let mut done: Vec<(&Path, Outcome)> = Vec::new();
    let mut entries: Vec<Entry> = Vec::new();
    for (slug, repo) in checkouts {
        let outcome = match done.iter().find(|(p, _)| p == repo) {
            Some((_, o)) => o.clone(),
            None => {
                let o = install(repo);
                done.push((repo, o.clone()));
                o
            }
        };
        let entry = Entry::now(slug, Some(repo), Point::Start, outcome);
        log(&entry);
        entries.push(entry);
    }
    for slug in pathless {
        if entries.iter().any(|e| &e.slug == slug) {
            continue;
        }
        let entry = Entry::now(slug, None, Point::Start, Outcome::NoCheckout);
        log(&entry);
        entries.push(entry);
    }
    let merge = match census_from {
        Some(since_ms) => Merge::Census { since_ms },
        None => Merge::Upsert,
    };
    save(dir, entries.clone(), merge);
    entries
}

fn save(dir: Option<&Path>, entries: Vec<Entry>, merge: Merge) {
    let Some(dir) = dir else {
        tracing::warn!(
            "[skill] no config directory resolves on this box, so `forge-runner status` cannot be told what the forge-master install did"
        );
        return;
    };
    if let Err(e) = record(dir, entries, merge) {
        tracing::warn!(
            "[skill] the install record could not be written, so `forge-runner status` reports an older one: {e}"
        );
    }
}

fn log(entry: &Entry) {
    let slug = &entry.slug;
    let said = entry.outcome.says(entry.path.as_deref(), &entry.build);
    let when = entry.point.word();
    match &entry.outcome {
        Outcome::Written => tracing::info!("[skill] {slug} {when}: {said}"),
        Outcome::Current => tracing::debug!("[skill] {slug} {when}: {said}"),
        _ => tracing::warn!("[skill] {slug} {when}: {said}"),
    }
}
