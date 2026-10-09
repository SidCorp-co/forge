//! The forge-master skill a bound checkout carries, and the record of every
//! write of it.
//!
//! The skill is a directory, `assets/skills/forge-master/`: `SKILL.md` and
//! whatever it sends the model to read when it needs it. [`FILES`] lists what
//! the binary carries, and the install writes that tree whole.
//!
//! The skill used to be written only where a pane was placed, so it followed
//! "a pane was placed here since the last build" rather than "this project is
//! bound to a box running this build": an adopted pane kept the copy it was
//! placed with, and a bound project with no master had none (ISS-1357). It is
//! now written at bind, at provision and at every daemon start, and placement
//! goes through the same rule.
//!
//! The tree lands under `.claude/`, which is only harmless where the
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

/// The skill's entry file, which is what a session loads when it selects the skill.
pub const ASSET: &str = include_str!("../../assets/skills/forge-master/SKILL.md");

/// One file of the shipped skill directory: where it lands under the skill's
/// directory in a checkout (`/`-separated), and what it holds.
#[derive(Debug, Clone, Copy)]
pub struct Shipped {
    pub path: &'static str,
    pub bytes: &'static [u8],
}

/// Every file the binary carries of the skill. Each is an `include_bytes!`, so a
/// file added under the asset directory ships only once it is listed here;
/// `tests::the_listed_files_are_the_asset_directory` fails naming the one that
/// is not.
pub const FILES: &[Shipped] = &[
    Shipped {
        path: "SKILL.md",
        bytes: include_bytes!("../../assets/skills/forge-master/SKILL.md"),
    },
    Shipped {
        path: "references/what-a-run-leaves.md",
        bytes: include_bytes!("../../assets/skills/forge-master/references/what-a-run-leaves.md"),
    },
];

/// The skill's directory inside a checkout, as git names it.
pub const DIR_RELATIVE: &str = ".claude/skills/forge-master";

/// Where the entry file lives inside a checkout, as git names it.
pub const RELATIVE: &str = ".claude/skills/forge-master/SKILL.md";

/// The skill's directory in `repo`, joined component by component so the path
/// printed carries one separator, the platform's own.
pub fn dir_in(repo: &Path) -> PathBuf {
    DIR_RELATIVE
        .split('/')
        .fold(repo.to_path_buf(), |p, c| p.join(c))
}

/// The entry file in `repo`.
pub fn path_in(repo: &Path) -> PathBuf {
    dir_in(repo).join("SKILL.md")
}

/// Which files in the skill's directory this runner wrote, so a later build
/// that no longer ships one can remove it and nothing else. A file the
/// directory holds that this list does not name was put there by somebody
/// else, and no install touches it unless [`FILES`] now claims its path.
pub const MANIFEST: &str = ".installed-by-forge-runner";

/// The manifest's shape, refused by name when it is any other.
const MANIFEST_VERSION: u32 = 1;

/// Held for the whole of an install, so two installs into one checkout — a
/// `bind` in one process and the daemon's start sweep or a pane placement in
/// another — take turns instead of each removing, creating and replacing what
/// the other is in the middle of. It is the runner's own and holds nothing.
pub const INSTALL_LOCK: &str = ".installed-by-forge-runner.lock";

pub const RECORD: &str = "master-skill.json";
const LOCK: &str = "master-skill.json.lock";

/// The record's shape. A reader refuses any other by name rather than read a
/// newer build's record as this one's.
pub const RECORD_VERSION: u32 = 1;

/// What one install did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Outcome {
    /// A file of the tree was absent or held other bytes, or a file this
    /// runner wrote earlier and no longer ships was removed.
    Written,
    /// Every file already held the asset, and none was left over; nothing was touched.
    Current,
    /// The checkout's git still does not ignore the path with `.claude/` in
    /// `exclude`, so a rule of its own un-ignores it.
    NotIgnored { exclude: PathBuf },
    /// The checkout's git tracks something under the skill's directory, which
    /// no ignore rule undoes.
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
                "NOT WRITTEN — that checkout's git tracks a file under {DIR_RELATIVE}, so writing the skill would change a committed file; an ignore rule does not undo that, so it is written only once somebody takes it out of the index on purpose (`git rm --cached`), and the next daemon start then ignores and writes it (checked by {build}) ← {shown}"
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

/// Write the shipped tree into `repo`, or say why not. Never writes outside
/// `<repo>/.claude/skills/forge-master/` but for the one exclude line
/// [`git_exclude::ensure_ignored`] adds.
pub fn install(repo: &Path) -> Outcome {
    install_tree(repo, FILES)
}

/// [`install`] with the tree handed in, so a test can ship a file the binary
/// does not carry, a script among them.
fn install_tree(repo: &Path, files: &[Shipped]) -> Outcome {
    match std::fs::metadata(repo) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return failed(format!("{} is not a directory", repo.display()));
        }
        Err(e) => return failed(format!("the checkout {}: {e}", repo.display())),
    }
    // Asked of the directory: the writes stage temporary siblings there first,
    // and what counts as the checkout's own is anything under it that is tracked.
    let ignore_target = format!("{DIR_RELATIVE}/");
    match git_exclude::ensure_ignored_as(repo, DIR_RELATIVE, &ignore_target) {
        Ok(_) => {}
        Err(Refused::Tracked) => return Outcome::Tracked,
        Err(Refused::StillNotIgnored { exclude }) => return Outcome::NotIgnored { exclude },
        Err(refused @ (Refused::Exclude { .. } | Refused::Git(_))) => {
            return failed(refused.to_string())
        }
    }
    let dir = dir_in(repo);
    let _turn = match take_turn(&dir) {
        Ok(lock) => lock,
        Err(detail) => return failed(detail),
    };
    match sync(&dir, files) {
        Ok(true) => Outcome::Written,
        Ok(false) => Outcome::Current,
        Err(detail) => failed(detail),
    }
}

/// Wait for every other install into `dir` to finish, then hold the right to
/// be the only one until the returned file is dropped. Two installs that
/// overlap each read the same manifest, so each goes to remove the same
/// dropped file and the same emptied directory: the second finds them gone and
/// fails an install whose tree is right, and a directory removed between its
/// creation and the write into it fails the write. The lock is the OS's, so
/// it is released when the process dies and no stale one is ever left behind.
fn take_turn(dir: &Path) -> Result<std::fs::File, String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(INSTALL_LOCK);
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    lock.lock()
        .map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(lock)
}

fn failed(detail: String) -> Outcome {
    Outcome::Failed { detail }
}

/// Make `dir` hold exactly what `files` ships of the skill, beside whatever
/// else it holds. Whether anything changed.
///
/// A file is this runner's when [`MANIFEST`] names it with the digest of what
/// was written: that is how a file it wrote earlier and no longer ships
/// (removed) is told from one somebody put there, or one it wrote and somebody
/// has since changed (both left alone). The manifest first holds the old
/// names and the new ones together and last holds only the new ones, so an
/// install that stops anywhere between leaves every file it wrote named, and
/// the next one still knows what to remove.
fn sync(dir: &Path, files: &[Shipped]) -> Result<bool, String> {
    let held = read_manifest(dir)?;
    let wanted: Vec<Written> = {
        let mut w: Vec<Written> = files
            .iter()
            .map(|f| Written {
                path: f.path.to_string(),
                sha256: digest(f.bytes),
            })
            .collect();
        w.sort_by(|a, b| a.path.cmp(&b.path));
        w
    };
    let in_wanted = |path: &str| wanted.iter().any(|w| w.path == path);
    let stale: Vec<&Written> = held.iter().filter(|h| !in_wanted(&h.path)).collect();
    let stale_present = stale
        .iter()
        .any(|w| std::fs::symlink_metadata(file_in(dir, &w.path)).is_ok_and(|m| !m.is_dir()));
    let behind: Vec<&Shipped> = files.iter().filter(|f| !holds(dir, f)).collect();
    if held == wanted && !stale_present && behind.is_empty() {
        return Ok(false);
    }

    let mut union: Vec<Written> = wanted.clone();
    union.extend(stale.iter().map(|w| (*w).clone()));
    union.sort_by(|a, b| a.path.cmp(&b.path));
    if union != held {
        write_manifest(dir, &union)?;
    }
    for f in &behind {
        let path = file_in(dir, f.path);
        refuse_symlinked_parents(dir, f.path)?;
        write_replacing(&path, f.bytes, is_script(f.path))
            .map_err(|e| format!("{}: {e}", path.display()))?;
    }
    for w in &stale {
        remove_shipped_earlier(dir, w)?;
    }
    if union != wanted {
        write_manifest(dir, &wanted)?;
    }
    Ok(true)
}

fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(bytes))
}

/// A directory below the skill's own that is a symbolic link was put there by
/// somebody, and a write or a removal through it would land outside the skill.
/// The skill's directory itself may be one; a person who links it elsewhere
/// chose that.
fn refuse_symlinked_parents(dir: &Path, relative: &str) -> Result<(), String> {
    let parts: Vec<&str> = relative.split('/').collect();
    let mut at = dir.to_path_buf();
    for part in &parts[..parts.len() - 1] {
        at = at.join(part);
        if std::fs::symlink_metadata(&at).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(format!(
                "{} is a symbolic link inside the skill's directory, and an install does not write or remove through one; replace it with a directory or delete it, and the next install writes the tree",
                at.display()
            ));
        }
    }
    Ok(())
}

/// A file under `scripts/` is run rather than read, so it is installed executable.
fn is_script(path: &str) -> bool {
    path.starts_with("scripts/")
}

fn file_in(dir: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(dir.to_path_buf(), |p, c| p.join(c))
}

/// Whether the file on disk is `f`: its bytes, and for a script its execute bits.
fn holds(dir: &Path, f: &Shipped) -> bool {
    let path = file_in(dir, f.path);
    match std::fs::read(&path) {
        Ok(bytes) if bytes == f.bytes => !is_script(f.path) || is_executable(&path),
        _ => false,
    }
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|m| m.permissions().mode() & 0o111 == 0o111)
}

#[cfg(not(unix))]
fn is_executable(_: &Path) -> bool {
    true
}

/// Remove a file an earlier install wrote and this build no longer ships, and
/// the directories that leaves empty inside the skill's directory. Something
/// that is now a directory was not written by an install, and a file whose
/// digest is no longer the one written has been changed by somebody since, so
/// both stay.
fn remove_shipped_earlier(dir: &Path, was: &Written) -> Result<(), String> {
    let path = file_in(dir, &was.path);
    refuse_symlinked_parents(dir, &was.path)?;
    match std::fs::symlink_metadata(&path) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(m) => {
            let unchanged = !m.file_type().is_symlink()
                && std::fs::read(&path).is_ok_and(|bytes| digest(&bytes) == was.sha256);
            if !unchanged {
                tracing::warn!(
                    "[skill] {} was written by an earlier install and is no longer shipped, but it is not what was written, so it is left in place",
                    path.display()
                );
                return Ok(());
            }
            std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("{}: {e}", path.display())),
    }
    let mut parent = path.parent();
    while let Some(p) = parent.filter(|p| *p != dir && p.starts_with(dir)) {
        // `remove_dir` refuses a directory that holds anything, which is the test.
        if std::fs::remove_dir(p).is_err() {
            break;
        }
        parent = p.parent();
    }
    Ok(())
}

/// One file an install wrote: where, and the digest of what it wrote there.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Written {
    path: String,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    files: Vec<Written>,
}

fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST)
}

/// What the last install wrote, sorted by path, or nothing where there was no
/// install. A manifest that cannot be read, or names a path that is not a plain
/// relative one inside the directory, is refused: removing what a hand-edited
/// or foreign file names is how an install deletes something that is not its own.
fn read_manifest(dir: &Path) -> Result<Vec<Written>, String> {
    let path = manifest_path(dir);
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let refused = |why: String| {
        format!(
            "{}: {why}; delete that file and the next install writes a fresh one, leaving every file it named in place",
            path.display()
        )
    };
    let doc: Manifest =
        serde_json::from_str(&raw).map_err(|e| refused(format!("does not parse: {e}")))?;
    if doc.version != MANIFEST_VERSION {
        return Err(refused(format!(
            "version {}, which this build does not read (it reads {MANIFEST_VERSION})",
            doc.version
        )));
    }
    let mut files = doc.files;
    for w in &files {
        let name = &w.path;
        let plain = !name.is_empty()
            && name.split('/').all(|c| {
                !c.is_empty() && c != "." && c != ".." && !c.contains('\\') && !c.contains(':')
            });
        if !plain {
            return Err(refused(format!(
                "names `{name}`, which is not a relative path inside the skill's directory"
            )));
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    if let Some(pair) = files.windows(2).find(|p| p[0].path == p[1].path) {
        return Err(refused(format!("names `{}` twice", pair[0].path)));
    }
    Ok(files)
}

fn write_manifest(dir: &Path, files: &[Written]) -> Result<(), String> {
    let doc = Manifest {
        version: MANIFEST_VERSION,
        files: files.to_vec(),
    };
    let body = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    let path = manifest_path(dir);
    write_replacing(&path, body.as_bytes(), false).map_err(|e| format!("{}: {e}", path.display()))
}

/// Through a sibling and a rename, so a session reading the file while it is
/// replaced reads one whole copy or the other. A script is made executable
/// before the rename, so it is never there without being so.
fn write_replacing(path: &Path, bytes: &[u8], executable: bool) -> std::io::Result<()> {
    let dir = path
        .parent()
        .expect("a file under the skill's directory has a parent");
    std::fs::create_dir_all(dir)?;
    static ATTEMPT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = ATTEMPT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path
        .file_name()
        .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
    let tmp = dir.join(format!(".{name}.{}.{n}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, bytes)
        .and_then(|()| set_executable(&tmp, executable))
        .and_then(|()| std::fs::rename(&tmp, path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written
}

#[cfg(unix)]
fn set_executable(path: &Path, executable: bool) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if !executable {
        return Ok(());
    }
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn set_executable(_: &Path, _: bool) -> std::io::Result<()> {
    Ok(())
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

impl Record {
    /// Every line recorded for `slug`.
    pub fn of<'a>(&'a self, slug: &'a str) -> impl Iterator<Item = &'a Entry> + 'a {
        self.entries.iter().filter(move |e| e.slug == slug)
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::git_exclude::tests::{exclude_of, make_read_only, make_writable};
    use crate::test_scratch::Scratch;
    use std::collections::BTreeMap;
    use std::process::Command;

    /// The one line recorded for `slug`.
    fn one<'a>(r: &'a Record, slug: &'a str) -> &'a Entry {
        let mut of = r.of(slug);
        let e = of
            .next()
            .unwrap_or_else(|| panic!("no line for {slug}: {r:?}"));
        assert!(of.next().is_none(), "more than one line for {slug}: {r:?}");
        e
    }

    fn one_at<'a>(r: &'a Record, path: &Path) -> &'a Entry {
        r.entries
            .iter()
            .find(|e| e.path.as_deref() == Some(path))
            .unwrap_or_else(|| panic!("no line at {}: {r:?}", path.display()))
    }

    fn run_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {out:?}");
    }

    /// A scratch git checkout, ignoring `.claude/` or not.
    pub(crate) fn checkout(root: &Path, name: &str, ignores: bool) -> PathBuf {
        let repo = root.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]);
        if ignores {
            std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        }
        repo
    }

    /// A scratch git checkout whose own rules un-ignore `.claude/`, which no
    /// exclude line can overrule.
    fn un_ignoring(root: &Path, name: &str) -> PathBuf {
        let repo = checkout(root, name, false);
        std::fs::write(repo.join(".gitignore"), "!.claude/\n!.claude/**\n").unwrap();
        repo
    }

    fn excluded(repo: &Path) -> bool {
        std::fs::read_to_string(exclude_of(repo))
            .unwrap_or_default()
            .lines()
            .any(|l| l == ".claude/")
    }

    fn put(repo: &Path, text: &str) {
        let p = path_in(repo);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn skill(repo: &Path) -> Option<String> {
        std::fs::read_to_string(path_in(repo)).ok()
    }

    /// Every file under `dir` but `.git`, with its bytes.
    fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
        let mut out = BTreeMap::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.file_name() == Some(std::ffi::OsStr::new(".git")) {
                    continue;
                }
                if p.is_dir() {
                    stack.push(p);
                } else {
                    out.insert(
                        p.strip_prefix(dir).unwrap().to_path_buf(),
                        std::fs::read(&p).unwrap(),
                    );
                }
            }
        }
        out
    }

    const OLDER: &str = "---\nname: forge-master\n---\nan older build's skill\n";

    #[test]
    fn an_ignored_checkout_gets_the_asset_whether_it_had_none_or_an_older_copy() {
        let s = Scratch::new("mskill-ignored");
        let fresh = checkout(s.path(), "fresh", true);
        let adopted = checkout(s.path(), "adopted", true);
        put(&adopted, OLDER);

        assert_eq!(install(&fresh), Outcome::Written);
        assert_eq!(install(&adopted), Outcome::Written);
        assert_eq!(skill(&fresh).as_deref(), Some(ASSET));
        assert_eq!(
            skill(&adopted).as_deref(),
            Some(ASSET),
            "an adopted pane's older copy is replaced"
        );
    }

    #[test]
    fn a_current_copy_is_left_untouched_with_its_write_time() {
        let s = Scratch::new("mskill-current");
        let repo = checkout(s.path(), "r", true);
        assert_eq!(install(&repo), Outcome::Written);
        let file = path_in(&repo);
        let long_ago =
            std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        std::fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(long_ago)
            .unwrap();

        assert_eq!(install(&repo), Outcome::Current);
        assert_eq!(
            std::fs::metadata(&file).unwrap().modified().unwrap(),
            long_ago
        );
    }

    /// Owner, 2026-09-30: a checkout that does not ignore `.claude/` gets it
    /// added to its exclude file, and then the skill.
    #[test]
    fn a_checkout_that_does_not_ignore_the_path_gets_the_exclude_line_and_the_skill() {
        let s = Scratch::new("mskill-unignored");
        let bare = checkout(s.path(), "bare", false);
        let stale = checkout(s.path(), "stale", false);
        put(&stale, OLDER);

        assert_eq!(install(&bare), Outcome::Written);
        assert!(excluded(&bare), "the exclude line was not added");
        assert_eq!(skill(&bare).as_deref(), Some(ASSET));
        assert_eq!(install(&stale), Outcome::Written);
        assert_eq!(skill(&stale).as_deref(), Some(ASSET));
        let status = Command::new("git")
            .arg("-C")
            .arg(&bare)
            .args(["status", "--porcelain", "--untracked-files=all"])
            .env_remove("GIT_DIR")
            .output()
            .unwrap();
        assert_eq!(
            String::from_utf8_lossy(&status.stdout),
            "",
            "the skill shows as untracked work"
        );
    }

    #[test]
    fn a_checkout_whose_exclude_cannot_be_written_gets_no_skill_and_names_the_exclude() {
        let s = Scratch::new("mskill-exclude-ro");
        let repo = checkout(s.path(), "r", false);
        let ex = exclude_of(&repo);
        std::fs::create_dir_all(ex.parent().unwrap()).unwrap();
        std::fs::write(&ex, "*.swp\n").unwrap();
        if !make_read_only(&ex) {
            return;
        }
        let got = install(&repo);
        make_writable(&ex);

        let Outcome::Failed { detail } = got else {
            panic!("an unwritable exclude was not refused: {got:?}")
        };
        assert!(detail.contains(&ex.display().to_string()), "{detail}");
        assert_eq!(skill(&repo), None, "the skill was written unignored");
        assert!(!repo.join(".claude").exists(), "not even the directory");
    }

    #[test]
    fn a_checkout_whose_own_rule_un_ignores_the_path_is_not_written() {
        let s = Scratch::new("mskill-negated");
        let repo = un_ignoring(s.path(), "r");
        let got = install(&repo);
        let Outcome::NotIgnored { exclude } = &got else {
            panic!("{got:?}")
        };
        assert!(
            exclude.ends_with(Path::new("info").join("exclude")),
            "{got:?}"
        );
        assert_eq!(skill(&repo), None);
        let said = got.says(Some(&repo), "0.1 (abc)");
        assert!(said.contains("a rule of its own"), "{said}");
    }

    /// A rule covering only `SKILL.md` leaves the temporary sibling the write
    /// stages beside it untracked, so the directory is what is asked about.
    #[test]
    fn a_rule_covering_only_the_file_still_gets_the_line_for_its_directory() {
        let s = Scratch::new("mskill-file-rule");
        let repo = checkout(s.path(), "r", false);
        std::fs::write(repo.join(".gitignore"), format!("{RELATIVE}\n")).unwrap();
        assert_eq!(install(&repo), Outcome::Written);
        assert!(excluded(&repo), "the directory was left unignored");
    }

    #[test]
    fn a_tracked_skill_file_is_not_written_even_where_the_ignore_would_cover_it() {
        let s = Scratch::new("mskill-tracked");
        let repo = checkout(s.path(), "r", true);
        put(&repo, OLDER);
        run_git(&repo, &["add", "-f", RELATIVE]);
        run_git(&repo, &["commit", "-q", "-m", "tracked"]);

        assert_eq!(install(&repo), Outcome::Tracked);
        assert_eq!(skill(&repo).as_deref(), Some(OLDER));
        let said = Outcome::Tracked.says(Some(&repo), "0.1 (abc)");
        assert!(
            said.contains("an ignore rule does not undo that") && said.contains("git rm --cached"),
            "a tracked file is promised a fix an ignore rule cannot give: {said}"
        );
    }

    #[test]
    fn a_directory_with_no_git_is_written_since_nothing_can_commit_it() {
        let s = Scratch::new("mskill-nogit");
        let dir = s.path().join("repo-less");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(install(&dir), Outcome::Written);
        assert_eq!(skill(&dir).as_deref(), Some(ASSET));
    }

    #[test]
    fn a_missing_checkout_fails_naming_it_and_creates_nothing() {
        let s = Scratch::new("mskill-missing");
        let gone = s.path().join("no-such-checkout");
        let Outcome::Failed { detail } = install(&gone) else {
            panic!("a missing checkout is a failure")
        };
        assert!(detail.contains(&gone.display().to_string()), "{detail}");
        assert!(
            !gone.exists(),
            "the install made the checkout it was refused for"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_directory_that_refuses_the_write_fails_naming_the_file() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("mskill-readonly");
        let repo = checkout(s.path(), "r", true);
        let dir = repo.join(".claude/skills/forge-master");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::write(dir.join("probe"), b"").is_ok() {
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
            eprintln!("skipped: this user writes through a read-only directory (root)");
            return;
        }
        let got = install(&repo);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        let Outcome::Failed { detail } = got else {
            panic!("a refused write is a failure: {got:?}")
        };
        assert!(detail.contains(&dir.display().to_string()), "{detail}");
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "no temporary file is left behind"
        );
    }

    #[test]
    fn the_install_writes_nothing_but_the_skill_tree() {
        let s = Scratch::new("mskill-only");
        let repo = checkout(s.path(), "r", true);
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        let before = tree(&repo);
        assert_eq!(install(&repo), Outcome::Written);
        let mut after = tree(&repo);
        let mut written: Vec<String> = Vec::new();
        for f in FILES {
            let at = PathBuf::from(DIR_RELATIVE).join(f.path);
            assert_eq!(
                after.remove(&at).as_deref(),
                Some(f.bytes),
                "{} is not what the binary ships",
                f.path
            );
            written.push(f.path.to_string());
        }
        assert!(
            after
                .remove(&PathBuf::from(DIR_RELATIVE).join(MANIFEST))
                .is_some(),
            "the install names what it wrote"
        );
        assert_eq!(
            after
                .remove(&PathBuf::from(DIR_RELATIVE).join(INSTALL_LOCK))
                .as_deref(),
            Some(&[][..]),
            "the lock an install takes its turn by holds nothing"
        );
        assert_eq!(
            after, before,
            "the install changed a file outside the skill's tree"
        );
        assert!(written.contains(&"SKILL.md".to_string()));
    }

    #[test]
    fn the_sweep_covers_every_checkout_past_one_it_cannot_write_and_records_each() {
        let s = Scratch::new("mskill-sweep");
        let cfg = s.path().join("config");
        let ok = checkout(s.path(), "ok", true);
        put(&ok, OLDER);
        let open = un_ignoring(s.path(), "open");
        let gone = s.path().join("gone");
        let checkouts = vec![
            ("alpha".to_string(), gone.clone()),
            ("beta".to_string(), open.clone()),
            ("gamma".to_string(), ok.clone()),
        ];

        install_every(&checkouts, &["delta".to_string()], Some(0), Some(&cfg));

        assert_eq!(
            skill(&ok).as_deref(),
            Some(ASSET),
            "a failure earlier in the sweep stopped it"
        );
        let Read::Record(r) = read(&cfg) else {
            panic!("the sweep recorded nothing")
        };
        assert!(matches!(one(&r, "alpha").outcome, Outcome::Failed { .. }));
        assert!(matches!(
            one(&r, "beta").outcome,
            Outcome::NotIgnored { .. }
        ));
        assert_eq!(one(&r, "gamma").outcome, Outcome::Written);
        assert_eq!(one(&r, "gamma").path.as_deref(), Some(ok.as_path()));
        assert_eq!(one(&r, "delta").outcome, Outcome::NoCheckout);
        assert_eq!(one(&r, "delta").path, None);
        assert!(r.entries.iter().all(|e| e.point == Point::Start));
    }

    /// The sweep's only write outside the checkouts is its own record: no
    /// ledger, no drain, no serving record, no marks.
    #[test]
    fn the_sweep_touches_nothing_in_the_config_directory_but_its_record() {
        let s = Scratch::new("mskill-cfg-only");
        let cfg = s.path().join("config");
        std::fs::create_dir_all(&cfg).unwrap();
        std::fs::write(cfg.join("serving.json"), "{\"drain\":\"as it was\"}").unwrap();
        let before = tree(&cfg);
        let ok = checkout(s.path(), "ok", true);

        install_every(&[("ok".to_string(), ok)], &[], Some(0), Some(&cfg));

        let mut after = tree(&cfg);
        assert!(after.remove(Path::new(RECORD)).is_some());
        after.remove(Path::new(LOCK));
        assert_eq!(after, before);
    }

    #[test]
    fn the_census_drops_what_is_no_longer_bound_and_a_single_write_keeps_every_other_line() {
        let s = Scratch::new("mskill-merge");
        let cfg = s.path().join("config");
        let a = checkout(s.path(), "a", true);
        let b = checkout(s.path(), "b", true);
        let gone = checkout(s.path(), "gone", true);
        install_every(
            &[("gone".to_string(), gone), ("a".to_string(), a.clone())],
            &[],
            Some(0),
            Some(&cfg),
        );
        std::thread::sleep(std::time::Duration::from_millis(5));
        install_every(
            &[("a".to_string(), a)],
            &[],
            Some(crate::daemon::agent_activity::now_ms()),
            Some(&cfg),
        );
        install_and_record("b", &b, Point::Bind, Some(&cfg));

        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        let slugs: Vec<&str> = r.entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(
            slugs,
            ["a", "b"],
            "an unbound slug outlived the census, or bind dropped a line"
        );
        assert_eq!(one(&r, "b").point, Point::Bind);
    }

    /// Consult review F1: a `bind` recorded after the census began is one the
    /// census could not have seen, so its line stands.
    #[test]
    fn a_bind_recorded_while_the_census_ran_is_kept() {
        let s = Scratch::new("mskill-census-race");
        let dir = s.path();
        let since_ms = crate::daemon::agent_activity::now_ms() - 1_000;
        let mut stale = Entry::now(
            "unbound",
            Some(Path::new("/old")),
            Point::Start,
            Outcome::Written,
        );
        stale.at_ms = since_ms - 60_000;
        let late = Entry::now(
            "late",
            Some(Path::new("/late")),
            Point::Bind,
            Outcome::Written,
        );
        record(dir, vec![stale, late], Merge::Upsert).unwrap();

        let census = Entry::now("a", Some(Path::new("/a")), Point::Start, Outcome::Written);
        record(dir, vec![census], Merge::Census { since_ms }).unwrap();

        let Read::Record(r) = read(dir) else { panic!() };
        let slugs: Vec<&str> = r.entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, ["a", "late"], "{r:?}");
    }

    /// Consult review F1: a start that could not read the server's assignments
    /// sees only config.toml, so it prunes nothing.
    #[test]
    fn a_census_without_the_servers_assignments_prunes_nothing() {
        let s = Scratch::new("mskill-partial");
        let cfg = s.path().join("config");
        let mut server_only = Entry::now(
            "web-bound",
            Some(Path::new("/w")),
            Point::Start,
            Outcome::Tracked,
        );
        server_only.at_ms -= 3_600_000;
        record(&cfg, vec![server_only], Merge::Upsert).unwrap();
        let local = checkout(s.path(), "local", true);

        install_every(&[("local".to_string(), local)], &[], None, Some(&cfg));

        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        assert_eq!(one(&r, "web-bound").outcome, Outcome::Tracked);
        assert_eq!(one(&r, "local").outcome, Outcome::Written);
    }

    /// Consult review F2: one slug bound at two checkouts — the server's path
    /// and an older local one — keeps a line for each, so a refused one is
    /// never hidden behind a written one.
    #[test]
    fn a_project_at_two_checkouts_keeps_a_line_for_each() {
        let s = Scratch::new("mskill-two-paths");
        let cfg = s.path().join("config");
        let active = un_ignoring(s.path(), "a-active");
        let old = checkout(s.path(), "z-old", true);

        install_every(
            &[
                ("acme".to_string(), active.clone()),
                ("acme".to_string(), old.clone()),
            ],
            &[],
            Some(0),
            Some(&cfg),
        );

        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        let lines: Vec<(&Path, bool)> = r
            .of("acme")
            .map(|e| (e.path.as_deref().unwrap(), e.outcome.installed()))
            .collect();
        assert_eq!(lines, [(active.as_path(), false), (old.as_path(), true)]);
        assert!(matches!(
            one_at(&r, &active).outcome,
            Outcome::NotIgnored { .. }
        ));

        // A later write at one of the two leaves the other's line standing.
        install_and_record("acme", &old, Point::Bind, Some(&cfg));
        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        assert!(
            matches!(one_at(&r, &active).outcome, Outcome::NotIgnored { .. }),
            "{r:?}"
        );
        assert_eq!(one_at(&r, &old).outcome, Outcome::Current, "{r:?}");
    }

    /// Review F1 of the second whole-set read: two projects bound to one
    /// checkout each keep a line, and the checkout is written once.
    #[test]
    fn two_projects_sharing_a_checkout_each_keep_a_line() {
        let s = Scratch::new("mskill-shared");
        let cfg = s.path().join("config");
        let shared = checkout(s.path(), "shared", true);

        let entries = install_every(
            &[
                ("one".to_string(), shared.clone()),
                ("two".to_string(), shared.clone()),
            ],
            &[],
            Some(0),
            Some(&cfg),
        );

        let outcomes: Vec<&Outcome> = entries.iter().map(|e| &e.outcome).collect();
        assert_eq!(
            outcomes,
            [&Outcome::Written, &Outcome::Written],
            "installed once, recorded twice"
        );
        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        assert_eq!(one(&r, "one").path.as_deref(), Some(shared.as_path()));
        assert_eq!(one(&r, "two").path.as_deref(), Some(shared.as_path()));
    }

    /// Review F1 of the second whole-set read against master.rs: two installs
    /// into one stale checkout at once, as two placements in this process can
    /// be, both succeed rather than one consuming the other's temporary file.
    #[test]
    fn two_installs_at_once_into_one_checkout_both_succeed() {
        let s = Scratch::new("mskill-concurrent");
        let repo = checkout(s.path(), "r", true);
        for _ in 0..20 {
            put(&repo, OLDER);
            let (a, b) = (repo.clone(), repo.clone());
            let one = std::thread::spawn(move || install(&a));
            let two = std::thread::spawn(move || install(&b));
            for got in [one.join().unwrap(), two.join().unwrap()] {
                assert!(got.installed(), "{got:?}");
            }
            assert_eq!(skill(&repo).as_deref(), Some(ASSET));
        }
    }

    /// Installs racing over a tree that holds files this build dropped: each
    /// reads the same manifest, so each goes to remove the same file and the
    /// same empty directory, and the one that arrives second finds them gone.
    /// Gone is what it wanted, so both end installed with the shipped tree.
    #[test]
    fn installs_racing_over_a_dropped_file_all_end_installed_with_the_shipped_tree() {
        let s = Scratch::new("mskill-race-stale");
        let old = [
            shipped("SKILL.md", "entry"),
            shipped("references/kept.md", "k"),
            shipped("references/gone/deep/a.md", "a"),
            shipped("references/gone/b.md", "b"),
        ];
        let new = [
            shipped("SKILL.md", "entry"),
            shipped("references/kept.md", "k"),
        ];
        for round in 0..40 {
            let repo = checkout(s.path(), &format!("r{round}"), true);
            assert_eq!(install_tree(&repo, &old), Outcome::Written);
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
            let installs: Vec<_> = (0..4)
                .map(|_| {
                    let (repo, barrier) = (repo.clone(), barrier.clone());
                    std::thread::spawn(move || {
                        barrier.wait();
                        install_tree(&repo, &new)
                    })
                })
                .collect();
            for got in installs {
                let got = got.join().unwrap();
                assert!(got.installed(), "round {round}: {got:?}");
            }
            assert!(!at(&repo, "references/gone").exists(), "round {round}");
            assert_eq!(manifest_of(&repo), ["SKILL.md", "references/kept.md"]);
            assert_eq!(install_tree(&repo, &new), Outcome::Current);
        }
    }

    #[test]
    fn a_checkout_recorded_for_a_project_that_had_none_replaces_that_line() {
        let s = Scratch::new("mskill-pathless-then-bound");
        let dir = s.path();
        record(
            dir,
            vec![Entry::now("p", None, Point::Start, Outcome::NoCheckout)],
            Merge::Upsert,
        )
        .unwrap();
        record(
            dir,
            vec![Entry::now(
                "p",
                Some(Path::new("/p")),
                Point::Bind,
                Outcome::Written,
            )],
            Merge::Upsert,
        )
        .unwrap();
        let Read::Record(r) = read(dir) else { panic!() };
        assert_eq!(one(&r, "p").outcome, Outcome::Written);
    }

    #[test]
    fn a_record_that_cannot_be_read_says_why_and_a_newer_one_is_not_overwritten() {
        let s = Scratch::new("mskill-unreadable");
        let dir = s.path();
        assert_eq!(read(dir), Read::Absent);

        std::fs::write(record_path(dir), "{ not json").unwrap();
        let Read::Unreadable(why) = read(dir) else {
            panic!()
        };
        assert!(
            why.contains("does not parse") && why.contains(RECORD),
            "{why}"
        );

        std::fs::write(record_path(dir), r#"{"version":2,"entries":[]}"#).unwrap();
        let Read::Unreadable(why) = read(dir) else {
            panic!()
        };
        assert!(
            why.contains("version 2, which this build does not read"),
            "{why}"
        );
        let refused = record(dir, vec![], Merge::Upsert).unwrap_err();
        assert!(refused.contains("newer build"), "{refused}");
        assert!(std::fs::read_to_string(record_path(dir))
            .unwrap()
            .contains(r#""version":2"#));
    }

    /// Criterion: two writers at once both keep their line. `flock` binds an
    /// open file description, so a second open in this process is refused the
    /// lock exactly as another process is.
    #[test]
    fn a_writer_waits_for_the_lock_and_both_lines_survive() {
        let s = Scratch::new("mskill-lock");
        let dir = s.path().to_path_buf();
        record(
            &dir,
            vec![Entry::now("first", None, Point::Start, Outcome::NoCheckout)],
            Merge::Upsert,
        )
        .unwrap();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .open(dir.join(LOCK))
            .unwrap();
        held.lock().unwrap();

        let there = dir.clone();
        let second = std::thread::spawn(move || {
            record(
                &there,
                vec![Entry::now("second", None, Point::Bind, Outcome::NoCheckout)],
                Merge::Upsert,
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Read::Record(r) = read(&dir) else {
            panic!()
        };
        assert!(
            r.of("second").next().is_none(),
            "the second writer did not wait for the lock"
        );
        held.unlock().unwrap();
        second.join().unwrap().unwrap();

        let Read::Record(r) = read(&dir) else {
            panic!()
        };
        assert!(
            r.of("first").next().is_some() && r.of("second").next().is_some(),
            "{r:?}"
        );
    }

    #[test]
    fn only_a_write_names_a_writer() {
        let p = Path::new("/r");
        assert!(Outcome::Written
            .says(Some(p), "0.1 (abc)")
            .starts_with("written by 0.1 (abc)"));
        let current = Outcome::Current.says(Some(p), "0.1 (abc)");
        assert!(!current.contains("written by"), "{current}");
        for refused in [
            Outcome::NotIgnored {
                exclude: "/r/.git/info/exclude".into(),
            },
            Outcome::Tracked,
            Outcome::Failed {
                detail: "denied".into(),
            },
        ] {
            let said = refused.says(Some(p), "0.1 (abc)");
            assert!(
                said.contains("checked by 0.1 (abc)") && !said.contains("written by"),
                "{said}"
            );
        }
        let refused = Outcome::NotIgnored {
            exclude: "/r/.git/info/exclude".into(),
        }
        .says(Some(p), "0.1 (abc)");
        assert!(
            refused.contains(&path_in(p).display().to_string())
                && refused.contains("/r/.git/info/exclude holds `.claude/`"),
            "{refused}"
        );
    }

    /// CI run 36746604361, Windows: `Path::join` of a `/`-separated relative
    /// printed `/p/a\\.claude/skills/...`. The path is one separator throughout.
    #[test]
    fn the_skill_path_is_joined_with_one_separator_throughout() {
        let sep = std::path::MAIN_SEPARATOR;
        let shown = path_in(Path::new("repo")).display().to_string();
        assert_eq!(
            shown,
            format!("repo{sep}.claude{sep}skills{sep}forge-master{sep}SKILL.md")
        );
    }

    fn shipped(path: &'static str, text: &'static str) -> Shipped {
        Shipped {
            path,
            bytes: text.as_bytes(),
        }
    }

    fn at(repo: &Path, relative: &str) -> PathBuf {
        file_in(&dir_in(repo), relative)
    }

    fn manifest_of(repo: &Path) -> Vec<String> {
        read_manifest(&dir_in(repo))
            .expect("a manifest this runner wrote reads back")
            .into_iter()
            .map(|w| w.path)
            .collect()
    }

    /// A manifest entry as the install writes it, for a file holding `bytes`.
    fn entry_for(path: &str, bytes: &[u8]) -> serde_json::Value {
        serde_json::json!({"path": path, "sha256": digest(bytes)})
    }

    #[test]
    fn the_listed_files_are_the_asset_directory() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/skills/forge-master");
        let mut on_disk: Vec<String> = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d).unwrap() {
                let p = e.unwrap().path();
                if p.is_dir() {
                    stack.push(p);
                } else {
                    let rel = p.strip_prefix(&root).unwrap();
                    on_disk.push(
                        rel.components()
                            .map(|c| c.as_os_str().to_string_lossy().into_owned())
                            .collect::<Vec<_>>()
                            .join("/"),
                    );
                }
            }
        }
        on_disk.sort();
        let mut listed: Vec<String> = FILES.iter().map(|f| f.path.to_string()).collect();
        listed.sort();
        assert_eq!(
            listed, on_disk,
            "the asset directory and FILES disagree: a file in the directory that FILES does not list \
             is never shipped, and one FILES lists that the directory lacks does not compile"
        );
        for f in FILES {
            let on = std::fs::read(file_in(&root, f.path)).unwrap();
            assert_eq!(on, f.bytes, "{} is not the file the binary embeds", f.path);
        }
        assert_eq!(
            RELATIVE,
            format!("{DIR_RELATIVE}/SKILL.md"),
            "the entry file is SKILL.md in the skill's directory"
        );
    }

    #[test]
    fn a_tree_is_written_whole_with_its_nested_files_and_a_second_install_changes_nothing() {
        let s = Scratch::new("mskill-tree");
        let repo = checkout(s.path(), "r", true);
        let files = [
            shipped("SKILL.md", "entry"),
            shipped("references/deep/one.md", "one"),
            shipped("examples.md", "two"),
        ];

        assert_eq!(install_tree(&repo, &files), Outcome::Written);
        for f in &files {
            assert_eq!(
                std::fs::read(at(&repo, f.path)).unwrap(),
                f.bytes,
                "{}",
                f.path
            );
        }
        assert_eq!(
            manifest_of(&repo),
            ["SKILL.md", "examples.md", "references/deep/one.md"]
        );

        let before = tree(&repo);
        assert_eq!(install_tree(&repo, &files), Outcome::Current);
        assert_eq!(tree(&repo), before, "a second install changed the tree");

        std::fs::write(at(&repo, "references/deep/one.md"), "edited").unwrap();
        assert_eq!(install_tree(&repo, &files), Outcome::Written);
        assert_eq!(
            std::fs::read(at(&repo, "references/deep/one.md")).unwrap(),
            b"one",
            "a file that differs is written back"
        );
        std::fs::remove_file(at(&repo, "examples.md")).unwrap();
        assert_eq!(install_tree(&repo, &files), Outcome::Written);
        assert!(
            at(&repo, "examples.md").is_file(),
            "a missing file is written"
        );
    }

    #[test]
    fn a_file_an_earlier_install_wrote_and_this_build_no_longer_ships_is_removed_with_its_empty_directories(
    ) {
        let s = Scratch::new("mskill-stale");
        let repo = checkout(s.path(), "r", true);
        let old = [
            shipped("SKILL.md", "entry"),
            shipped("references/gone/a.md", "a"),
            shipped("references/kept.md", "k"),
        ];
        let new = [
            shipped("SKILL.md", "entry"),
            shipped("references/kept.md", "k"),
        ];
        assert_eq!(install_tree(&repo, &old), Outcome::Written);

        assert_eq!(install_tree(&repo, &new), Outcome::Written);

        assert!(
            !at(&repo, "references/gone/a.md").exists(),
            "the stale file stayed"
        );
        assert!(
            !at(&repo, "references/gone").exists(),
            "the directory it left empty stayed"
        );
        assert!(at(&repo, "references/kept.md").is_file());
        assert_eq!(manifest_of(&repo), ["SKILL.md", "references/kept.md"]);
        assert_eq!(install_tree(&repo, &new), Outcome::Current);
    }

    #[test]
    fn a_file_nobody_installed_is_never_touched_unless_the_asset_now_claims_its_path() {
        let s = Scratch::new("mskill-theirs");
        let repo = checkout(s.path(), "r", true);
        let one = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        std::fs::write(at(&repo, "notes.md"), "a person's").unwrap();
        std::fs::create_dir_all(at(&repo, "mine")).unwrap();
        std::fs::write(at(&repo, "mine/x.md"), "a person's too").unwrap();
        std::fs::write(
            at(&repo, "claimed.md"),
            "a person's, at a path the asset takes",
        )
        .unwrap();

        // The next build ships a file at a path the person already used, and drops nothing.
        let two = [
            shipped("SKILL.md", "entry"),
            shipped("claimed.md", "the asset's"),
        ];
        assert_eq!(install_tree(&repo, &two), Outcome::Written);
        assert_eq!(
            std::fs::read(at(&repo, "claimed.md")).unwrap(),
            b"the asset's"
        );
        assert_eq!(std::fs::read(at(&repo, "notes.md")).unwrap(), b"a person's");
        assert_eq!(
            std::fs::read(at(&repo, "mine/x.md")).unwrap(),
            b"a person's too"
        );

        // And a build that ships less removes only what an install wrote.
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        assert!(
            !at(&repo, "claimed.md").exists(),
            "the file the runner wrote and dropped"
        );
        assert_eq!(std::fs::read(at(&repo, "notes.md")).unwrap(), b"a person's");
        assert_eq!(
            std::fs::read(at(&repo, "mine/x.md")).unwrap(),
            b"a person's too"
        );
    }

    #[test]
    fn a_directory_standing_where_a_dropped_file_was_is_not_the_runners_to_remove() {
        let s = Scratch::new("mskill-stale-dir");
        let repo = checkout(s.path(), "r", true);
        let old = [shipped("SKILL.md", "entry"), shipped("old.md", "o")];
        assert_eq!(install_tree(&repo, &old), Outcome::Written);
        std::fs::remove_file(at(&repo, "old.md")).unwrap();
        std::fs::create_dir_all(at(&repo, "old.md")).unwrap();
        std::fs::write(at(&repo, "old.md/inside"), "a person's").unwrap();

        assert_eq!(
            install_tree(&repo, &[shipped("SKILL.md", "entry")]),
            Outcome::Written
        );
        assert_eq!(
            std::fs::read(at(&repo, "old.md/inside")).unwrap(),
            b"a person's"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_script_is_installed_executable_and_made_so_again_where_it_is_not() {
        use std::os::unix::fs::PermissionsExt;
        let s = Scratch::new("mskill-exec");
        let repo = checkout(s.path(), "r", true);
        let files = [
            shipped("SKILL.md", "entry"),
            shipped("scripts/run.sh", "#!/bin/sh\n"),
            shipped("references/read.md", "r"),
        ];
        let mode = |rel: &str| {
            std::fs::metadata(at(&repo, rel))
                .unwrap()
                .permissions()
                .mode()
        };

        assert_eq!(install_tree(&repo, &files), Outcome::Written);
        assert_eq!(
            mode("scripts/run.sh") & 0o111,
            0o111,
            "a script is executable"
        );
        assert_eq!(mode("references/read.md") & 0o111, 0, "a reference is not");
        assert_eq!(mode("SKILL.md") & 0o111, 0, "the entry file is not");

        std::fs::set_permissions(
            at(&repo, "scripts/run.sh"),
            std::fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert_eq!(
            install_tree(&repo, &files),
            Outcome::Written,
            "a script whose execute bits were lost is not current"
        );
        assert_eq!(mode("scripts/run.sh") & 0o111, 0o111);
        assert_eq!(install_tree(&repo, &files), Outcome::Current);
    }

    #[test]
    fn a_tracked_file_anywhere_under_the_skill_directory_refuses_the_install_and_writes_nothing() {
        let s = Scratch::new("mskill-tracked-other");
        let repo = checkout(s.path(), "r", true);
        let theirs = repo.join(".claude/skills/forge-master/notes.md");
        std::fs::create_dir_all(theirs.parent().unwrap()).unwrap();
        std::fs::write(&theirs, "committed").unwrap();
        run_git(
            &repo,
            &["add", "-f", ".claude/skills/forge-master/notes.md"],
        );
        run_git(
            &repo,
            &["commit", "-q", "-m", "tracks a file beside the skill"],
        );
        let before = tree(&repo);

        assert_eq!(install(&repo), Outcome::Tracked);
        assert_eq!(tree(&repo), before, "a refused install wrote something");
    }

    #[test]
    fn a_manifest_naming_a_path_outside_the_skill_directory_is_refused_by_name_and_removes_nothing()
    {
        let s = Scratch::new("mskill-hostile");
        let repo = checkout(s.path(), "r", true);
        let one = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        let outside = repo.join("keep-me.txt");
        std::fs::write(&outside, "not the skill's").unwrap();

        for name in [
            "../../../../keep-me.txt",
            "/etc/passwd",
            "a/../b",
            "",
            "c:/x",
        ] {
            let doc = serde_json::json!({
                "version": MANIFEST_VERSION,
                "files": [entry_for("SKILL.md", b"entry"), entry_for(name, b"x")],
            });
            std::fs::write(manifest_path(&dir_in(&repo)), doc.to_string()).unwrap();
            let before = tree(&repo);
            let Outcome::Failed { detail } = install_tree(&repo, &one) else {
                panic!("`{name}` was accepted")
            };
            assert!(detail.contains(&format!("`{name}`")), "{detail}");
            assert!(detail.contains(MANIFEST), "{detail}");
            assert_eq!(tree(&repo), before, "`{name}` changed the tree");
        }
        assert_eq!(std::fs::read(&outside).unwrap(), b"not the skill's");
    }

    #[test]
    fn a_manifest_that_cannot_be_read_is_refused_naming_it_and_the_way_out() {
        let s = Scratch::new("mskill-torn");
        let repo = checkout(s.path(), "r", true);
        let one = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        let manifest = manifest_path(&dir_in(&repo));

        std::fs::write(&manifest, "{ not json").unwrap();
        let Outcome::Failed { detail } = install_tree(&repo, &one) else {
            panic!("a torn manifest was accepted")
        };
        assert!(detail.contains(&manifest.display().to_string()), "{detail}");
        assert!(detail.contains("delete that file"), "{detail}");

        std::fs::write(&manifest, r#"{"version": 99, "files": []}"#).unwrap();
        let Outcome::Failed { detail } = install_tree(&repo, &one) else {
            panic!("a newer manifest was accepted")
        };
        assert!(detail.contains("version 99"), "{detail}");

        std::fs::remove_file(&manifest).unwrap();
        assert_eq!(
            install_tree(&repo, &one),
            Outcome::Written,
            "with the manifest gone the next install writes a fresh one"
        );
    }

    #[test]
    fn an_install_stopped_between_its_writes_still_knows_what_to_remove() {
        let s = Scratch::new("mskill-stopped");
        let repo = checkout(s.path(), "r", true);
        let old = [
            shipped("SKILL.md", "entry"),
            shipped("references/a.md", "a"),
        ];
        assert_eq!(install_tree(&repo, &old), Outcome::Written);
        // What the next build's install leaves if it stops after writing its first
        // manifest: the old and the new names together, and the old file still there.
        let doc = serde_json::json!({
            "version": MANIFEST_VERSION,
            "files": [
                entry_for("SKILL.md", b"entry"),
                entry_for("b.md", b"b"),
                entry_for("references/a.md", b"a"),
            ],
        });
        std::fs::write(manifest_path(&dir_in(&repo)), doc.to_string()).unwrap();

        let new = [shipped("SKILL.md", "entry"), shipped("b.md", "b")];
        assert_eq!(install_tree(&repo, &new), Outcome::Written);
        assert!(!at(&repo, "references/a.md").exists());
        assert_eq!(manifest_of(&repo), ["SKILL.md", "b.md"]);
    }

    #[test]
    fn a_checkout_holding_only_an_older_builds_skill_file_gets_the_tree_and_a_manifest() {
        let s = Scratch::new("mskill-upgrade");
        let repo = checkout(s.path(), "r", true);
        put(&repo, ASSET);

        assert_eq!(install(&repo), Outcome::Written);
        for f in FILES {
            assert_eq!(
                std::fs::read(at(&repo, f.path)).unwrap(),
                f.bytes,
                "{}",
                f.path
            );
        }
        assert_eq!(install(&repo), Outcome::Current);
    }

    #[test]
    fn a_dropped_file_somebody_changed_since_it_was_written_is_left_where_it_is() {
        let s = Scratch::new("mskill-changed");
        let repo = checkout(s.path(), "r", true);
        let old = [
            shipped("SKILL.md", "entry"),
            shipped("old.md", "as written"),
        ];
        assert_eq!(install_tree(&repo, &old), Outcome::Written);
        std::fs::write(at(&repo, "old.md"), "as written, and then a person's notes").unwrap();

        let new = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &new), Outcome::Written);

        assert_eq!(
            std::fs::read(at(&repo, "old.md")).unwrap(),
            b"as written, and then a person's notes",
            "an edited file was removed"
        );
        assert_eq!(
            manifest_of(&repo),
            ["SKILL.md"],
            "it is no longer the runner's"
        );
        assert_eq!(install_tree(&repo, &new), Outcome::Current);
    }

    #[test]
    fn a_manifest_entry_naming_a_persons_file_does_not_make_it_the_runners() {
        let s = Scratch::new("mskill-forged");
        let repo = checkout(s.path(), "r", true);
        let one = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        std::fs::write(at(&repo, "notes.md"), "a person's").unwrap();
        // A valid entry for a file no install wrote: the digest is what it cannot supply.
        let doc = serde_json::json!({
            "version": MANIFEST_VERSION,
            "files": [entry_for("SKILL.md", b"entry"), entry_for("notes.md", b"something else")],
        });
        std::fs::write(manifest_path(&dir_in(&repo)), doc.to_string()).unwrap();

        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        assert_eq!(std::fs::read(at(&repo, "notes.md")).unwrap(), b"a person's");
    }

    #[test]
    fn a_manifest_naming_one_path_twice_is_refused_by_name() {
        let s = Scratch::new("mskill-twice");
        let repo = checkout(s.path(), "r", true);
        let one = [shipped("SKILL.md", "entry")];
        assert_eq!(install_tree(&repo, &one), Outcome::Written);
        let doc = serde_json::json!({
            "version": MANIFEST_VERSION,
            "files": [entry_for("SKILL.md", b"entry"), entry_for("SKILL.md", b"other")],
        });
        std::fs::write(manifest_path(&dir_in(&repo)), doc.to_string()).unwrap();
        let Outcome::Failed { detail } = install_tree(&repo, &one) else {
            panic!("a duplicate was accepted")
        };
        assert!(detail.contains("`SKILL.md` twice"), "{detail}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_standing_for_a_directory_inside_the_skill_is_refused_and_written_through_never(
    ) {
        let s = Scratch::new("mskill-symlink");
        let repo = checkout(s.path(), "r", true);
        let outside = s.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("sentinel.md"), "not the skill's").unwrap();
        let files = [
            shipped("SKILL.md", "entry"),
            shipped("references/a.md", "a"),
        ];
        std::fs::create_dir_all(dir_in(&repo)).unwrap();
        std::os::unix::fs::symlink(&outside, at(&repo, "references")).unwrap();

        let Outcome::Failed { detail } = install_tree(&repo, &files) else {
            panic!("a write through a symbolic link was attempted")
        };
        assert!(detail.contains("is a symbolic link"), "{detail}");
        assert!(
            detail.contains(&at(&repo, "references").display().to_string()),
            "{detail}"
        );
        assert!(
            !outside.join("a.md").exists(),
            "the write went through the link"
        );
        assert_eq!(
            std::fs::read(outside.join("sentinel.md")).unwrap(),
            b"not the skill's"
        );

        // And a removal does not follow one either.
        let old = [shipped("SKILL.md", "entry")];
        std::fs::remove_file(at(&repo, "references")).unwrap();
        let with_ref = [
            shipped("SKILL.md", "entry"),
            shipped("references/a.md", "a"),
        ];
        assert_eq!(install_tree(&repo, &with_ref), Outcome::Written);
        std::fs::remove_dir_all(at(&repo, "references")).unwrap();
        std::fs::write(outside.join("a.md"), "a").unwrap();
        std::os::unix::fs::symlink(&outside, at(&repo, "references")).unwrap();
        let Outcome::Failed { .. } = install_tree(&repo, &old) else {
            panic!("a removal through a symbolic link was attempted")
        };
        assert!(
            outside.join("a.md").exists(),
            "the removal went through the link"
        );
    }
}
