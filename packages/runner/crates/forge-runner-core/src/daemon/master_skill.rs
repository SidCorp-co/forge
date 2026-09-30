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
//! checkout's git ignores it. Where it does not, or where the file is tracked,
//! a write is untracked work in somebody's repository, so it is refused and
//! recorded rather than made.
//!
//! `forge-runner status` is another process, so every outcome goes into
//! [`RECORD`] in the runner's config directory, which it reads back.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

pub const ASSET: &str = include_str!("../../assets/forge-master-skill.md");

/// Where the skill lives inside a checkout.
pub const RELATIVE: &str = ".claude/skills/forge-master/SKILL.md";

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
    /// The checkout's git does not ignore the path, or tracks it.
    NotIgnored,
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
            .map(|p| p.join(RELATIVE).display().to_string())
            .unwrap_or_else(|| "no checkout".into());
        match self {
            Outcome::Written => format!("written by {build} ← {shown}"),
            Outcome::Current => {
                format!("already the asset of {build}, which checked it and left it untouched ← {shown}")
            }
            Outcome::NotIgnored => format!(
                "NOT WRITTEN — that checkout's git does not ignore {RELATIVE}, or tracks it, so writing it would leave untracked work there; add `.claude/` to its .gitignore or .git/info/exclude and the next daemon start writes it ← {shown}"
            ),
            Outcome::Failed { detail } => format!("NOT WRITTEN — {detail} ← {shown}"),
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

enum Git {
    Ignored,
    NotIgnored,
    /// Not a git work tree at all, so nothing can commit what is written.
    None,
}

/// Write the asset into `repo`, or say why not. Never writes outside
/// `<repo>/.claude/skills/forge-master/`.
pub fn install(repo: &Path) -> Outcome {
    match std::fs::metadata(repo) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => {
            return failed(format!("{} is not a directory", repo.display()));
        }
        Err(e) => return failed(format!("the checkout {}: {e}", repo.display())),
    }
    match ignored(repo) {
        Ok(Git::Ignored | Git::None) => {}
        Ok(Git::NotIgnored) => return Outcome::NotIgnored,
        Err(detail) => return failed(detail),
    }
    let path = repo.join(RELATIVE);
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

fn ignored(repo: &Path) -> Result<Git, String> {
    let inside = git(repo, &["rev-parse", "--is-inside-work-tree"])?;
    if !inside.status.success() {
        let err = String::from_utf8_lossy(&inside.stderr);
        if err.contains("not a git repository") {
            return Ok(Git::None);
        }
        return Err(format!(
            "whether {} ignores {RELATIVE} cannot be read: git rev-parse exited {}: {}",
            repo.display(),
            inside.status,
            err.trim()
        ));
    }
    if String::from_utf8_lossy(&inside.stdout).trim() != "true" {
        return Err(format!(
            "{} is inside a git directory rather than a work tree",
            repo.display()
        ));
    }
    let asked = git(repo, &["check-ignore", "-q", "--", RELATIVE])?;
    match asked.status.code() {
        Some(0) => Ok(Git::Ignored),
        Some(1) => Ok(Git::NotIgnored),
        _ => Err(format!(
            "whether {} ignores {RELATIVE} cannot be read: git check-ignore exited {}: {}",
            repo.display(),
            asked.status,
            String::from_utf8_lossy(&asked.stderr).trim()
        )),
    }
}

fn git(repo: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("LC_ALL", "C")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("git could not be run to ask whether {RELATIVE} is ignored: {e}"))
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
    use crate::test_scratch::Scratch;
    use std::collections::BTreeMap;

    /// The one line recorded for `slug`.
    fn one<'a>(r: &'a Record, slug: &'a str) -> &'a Entry {
        let mut of = r.of(slug);
        let e = of
            .next()
            .unwrap_or_else(|| panic!("no line for {slug}: {r:?}"));
        assert!(of.next().is_none(), "more than one line for {slug}: {r:?}");
        e
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
    fn checkout(root: &Path, name: &str, ignores: bool) -> PathBuf {
        let repo = root.join(name);
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]);
        if ignores {
            std::fs::write(repo.join(".gitignore"), ".claude/\n").unwrap();
        }
        repo
    }

    fn put(repo: &Path, text: &str) {
        let p = repo.join(RELATIVE);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn skill(repo: &Path) -> Option<String> {
        std::fs::read_to_string(repo.join(RELATIVE)).ok()
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
        put(&repo, ASSET);
        let file = repo.join(RELATIVE);
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

    #[test]
    fn a_checkout_that_does_not_ignore_the_path_is_not_written() {
        let s = Scratch::new("mskill-unignored");
        let bare = checkout(s.path(), "bare", false);
        let stale = checkout(s.path(), "stale", false);
        put(&stale, OLDER);

        assert_eq!(install(&bare), Outcome::NotIgnored);
        assert_eq!(skill(&bare), None, "nothing is written into it");
        assert!(!bare.join(".claude").exists(), "not even the directory");
        assert_eq!(install(&stale), Outcome::NotIgnored);
        assert_eq!(
            skill(&stale).as_deref(),
            Some(OLDER),
            "a copy already there is left as it is"
        );
    }

    #[test]
    fn a_tracked_skill_file_is_not_written_even_where_the_ignore_would_cover_it() {
        let s = Scratch::new("mskill-tracked");
        let repo = checkout(s.path(), "r", true);
        put(&repo, OLDER);
        run_git(&repo, &["add", "-f", RELATIVE]);
        run_git(&repo, &["commit", "-q", "-m", "tracked"]);

        assert_eq!(install(&repo), Outcome::NotIgnored);
        assert_eq!(skill(&repo).as_deref(), Some(OLDER));
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
        assert!(
            detail.contains(&repo.join(RELATIVE).display().to_string()),
            "{detail}"
        );
        assert!(
            std::fs::read_dir(&dir).unwrap().next().is_none(),
            "no temporary file is left behind"
        );
    }

    #[test]
    fn the_install_writes_nothing_but_the_skill_file() {
        let s = Scratch::new("mskill-only");
        let repo = checkout(s.path(), "r", true);
        std::fs::write(repo.join("README.md"), "hello").unwrap();
        let before = tree(&repo);
        assert_eq!(install(&repo), Outcome::Written);
        let mut after = tree(&repo);
        assert_eq!(
            after.remove(Path::new(RELATIVE)).as_deref(),
            Some(ASSET.as_bytes())
        );
        assert_eq!(
            after, before,
            "the install changed a file other than the skill"
        );
    }

    #[test]
    fn the_sweep_covers_every_checkout_past_one_it_cannot_write_and_records_each() {
        let s = Scratch::new("mskill-sweep");
        let cfg = s.path().join("config");
        let ok = checkout(s.path(), "ok", true);
        put(&ok, OLDER);
        let open = checkout(s.path(), "open", false);
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
        assert_eq!(one(&r, "beta").outcome, Outcome::NotIgnored);
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
            Outcome::NotIgnored,
        );
        server_only.at_ms -= 3_600_000;
        record(&cfg, vec![server_only], Merge::Upsert).unwrap();
        let local = checkout(s.path(), "local", true);

        install_every(&[("local".to_string(), local)], &[], None, Some(&cfg));

        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        assert_eq!(one(&r, "web-bound").outcome, Outcome::NotIgnored);
        assert_eq!(one(&r, "local").outcome, Outcome::Written);
    }

    /// Consult review F2: one slug bound at two checkouts — the server's path
    /// and an older local one — keeps a line for each, so a refused one is
    /// never hidden behind a written one.
    #[test]
    fn a_project_at_two_checkouts_keeps_a_line_for_each() {
        let s = Scratch::new("mskill-two-paths");
        let cfg = s.path().join("config");
        let active = checkout(s.path(), "a-active", false);
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
        let lines: Vec<(&Path, &Outcome)> = r
            .of("acme")
            .map(|e| (e.path.as_deref().unwrap(), &e.outcome))
            .collect();
        assert_eq!(
            lines,
            [
                (active.as_path(), &Outcome::NotIgnored),
                (old.as_path(), &Outcome::Written)
            ]
        );

        // A later write at one of the two leaves the other's line standing.
        install_and_record("acme", &old, Point::Bind, Some(&cfg));
        let Read::Record(r) = read(&cfg) else {
            panic!()
        };
        let outcomes: Vec<&Outcome> = r.of("acme").map(|e| &e.outcome).collect();
        assert_eq!(outcomes, [&Outcome::NotIgnored, &Outcome::Current], "{r:?}");
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
        let refused = Outcome::NotIgnored.says(Some(p), "0.1 (abc)");
        assert!(
            refused.contains("/r/.claude/skills/forge-master/SKILL.md")
                && refused.contains(".git/info/exclude"),
            "{refused}"
        );
    }
}
