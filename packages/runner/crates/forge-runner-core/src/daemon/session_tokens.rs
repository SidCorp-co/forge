//! Who is on the other end of the control socket.
//!
//! A master used to say which session it was and the daemon believed it. That
//! is not an identity, it is a claim: any process that can reach the socket can
//! make it, and every verb this issue adds — park, read a question, revive —
//! acts on a session by name (ISS-964 criteria 29-31).
//!
//! So the daemon mints a capability instead. The token goes into the pane's
//! environment at spawn, comes back on every frame, and what it resolves to is
//! the daemon's own record. A frame no longer names a session at all.
//!
//! The record names the session, the project and the pane it was minted for
//! (ISS-1316). A token used to resolve to a session id alone, and core can
//! replace the row that id names under a running pane, whose environment is
//! fixed at exec: the pane's authority died with the row and nothing could
//! hand it another. What the pane was placed to be — this project's master, in
//! this pane — does not change when core re-mints a row, so that is what the
//! record carries, and nothing ever rewrites an entry after its mint.
//!
//! It is on disk because a daemon adopts panes it did not spawn: an in-memory
//! map is empty after a restart while every master is still running, holding a
//! token this process would then refuse.
//!
//! Which makes the file itself load-bearing, and ISS-1099 is what that cost
//! when it was treated as best-effort. A map that could not be parsed was read
//! as empty and the next `mint` wrote its one new entry over it: on forge-vm on
//! 2026-09-18 that left 73 bytes holding a single entry while six master panes
//! ran, and from 13:29:13Z every frame any of them sent was refused. So there
//! are two rules here now, and they are separate defences rather than one:
//! nothing is written FROM a map this process could not read, and nothing is
//! written IN PLACE, so a concurrent reader cannot see a half-written map at
//! all.
//!
//! A map written before the record reads too. Its entries name a session and
//! nothing else, and each is resolved exactly as it was, saying so, because
//! refusing them would refuse every master on the box at the upgrade. A file
//! in neither shape is refused by name.

use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub struct SessionTokens {
    path: PathBuf,
    /// The sessions whose pre-record capability this process has already
    /// named, so a pane sending a frame per hook is named once.
    legacy_said: Mutex<HashSet<String>>,
}

/// What a capability was minted for, as the daemon wrote it at placement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Minted {
    /// The core `agent_sessions` row the pane was placed under.
    pub session: String,
    pub project: String,
    /// The tmux session the pane was started as.
    pub pane: String,
}

/// One entry of the map, in either of the two shapes a file can hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
enum Entry {
    Minted(Minted),
    /// Written before ISS-1316: a session id and nothing else.
    Legacy(String),
}

impl Entry {
    fn session(&self) -> &str {
        match self {
            Entry::Minted(m) => &m.session,
            Entry::Legacy(s) => s,
        }
    }

    fn is_pane(&self, project: &str, pane: &str) -> bool {
        matches!(self, Entry::Minted(m) if m.project == project && m.pane == pane)
    }
}

/// Who a token says is calling.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Holder {
    /// A capability carrying what it was minted for.
    Minted(Minted),
    /// A capability minted before the record, which names only its session and
    /// so loses its authority when core replaces that session's row.
    Legacy { session: String },
}

impl Holder {
    pub fn session(&self) -> &str {
        match self {
            Holder::Minted(m) => &m.session,
            Holder::Legacy { session } => session,
        }
    }
}

const SHAPES: &str = "each entry is `\"<token>\": {\"session\": \"<id>\", \"project\": \"<id>\", \"pane\": \"<tmux session>\"}`, or, written before ISS-1316, `\"<token>\": \"<session id>\"`";

pub fn default_path() -> Option<PathBuf> {
    crate::daemon::control::socket_path().map(|s| s.with_file_name("control-tokens.json"))
}

pub const TOKEN_ENV: &str = "FORGE_CONTROL_TOKEN";

pub fn token_from_env() -> std::io::Result<String> {
    match std::env::var(TOKEN_ENV) {
        Ok(t) if !t.trim().is_empty() => Ok(t),
        _ => Err(std::io::Error::other(format!(
            "{TOKEN_ENV} is not set — this session was not spawned by the runner daemon, and the control socket has no other way to know who is calling"
        ))),
    }
}

fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(body)?;
    f.sync_all()
}

#[cfg(unix)]
fn sync_parent(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

impl SessionTokens {
    pub fn at(path: PathBuf) -> Self {
        Self {
            path,
            legacy_said: Mutex::new(HashSet::new()),
        }
    }

    fn load(&self) -> Result<HashMap<String, Entry>> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(HashMap::new()),
            Err(e) => {
                return Err(Error::Other(format!(
                    "tokens: {} could not be read: {e}",
                    self.path.display()
                )))
            }
        };
        let refused = |why: String| {
            Error::Other(format!(
                "tokens: {} holds {} byte(s) that are not a capability map ({why}); {SHAPES} — refusing to read it as empty, because the next mint would then write over every capability this box has handed out",
                self.path.display(),
                raw.len()
            ))
        };
        let map: HashMap<String, Entry> =
            serde_json::from_str(&raw).map_err(|e| refused(e.to_string()))?;
        let blank = map
            .values()
            .filter(|e| match e {
                Entry::Minted(m) => [&m.session, &m.project, &m.pane]
                    .iter()
                    .any(|v| v.trim().is_empty()),
                Entry::Legacy(s) => s.trim().is_empty(),
            })
            .count();
        if blank > 0 {
            return Err(refused(format!("{blank} entry(ies) carry an empty value")));
        }
        Ok(map)
    }

    fn store(&self, map: &HashMap<String, Entry>) -> Result<()> {
        let parent = self.path.parent().ok_or_else(|| {
            Error::Other(format!(
                "tokens: {} has no parent directory to write beside",
                self.path.display()
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        let body = serde_json::to_string(map).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        let tmp = parent.join(format!(
            ".control-tokens.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let done = write_private(&tmp, body.as_bytes())
            .and_then(|()| std::fs::rename(&tmp, &self.path))
            .and_then(|()| sync_parent(parent));
        if let Err(e) = done {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Other(format!(
                "tokens: {} could not be replaced: {e}",
                self.path.display()
            )));
        }
        Ok(())
    }

    /// Mint a capability for a pane about to be placed as `pane`, serving
    /// `project` under `session`.
    ///
    /// Every earlier entry for the same session, and every earlier entry for
    /// the same project and pane, goes: a pane is placed under a name only
    /// where no pane of that name is running, so the entry it replaces was for
    /// a pane that is gone.
    pub fn mint(&self, session: &str, project: &str, pane: &str) -> Result<String> {
        let mut map = self.load()?;
        map.retain(|_, e| e.session() != session && !e.is_pane(project, pane));
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        map.insert(
            token.clone(),
            Entry::Minted(Minted {
                session: session.to_string(),
                project: project.to_string(),
                pane: pane.to_string(),
            }),
        );
        self.store(&map)?;
        Ok(token)
    }

    /// Who `token` was minted for, or `None` where no capability on this box
    /// is that token or the map cannot be read.
    pub fn resolve(&self, token: &str) -> Option<Holder> {
        let map = match self.load() {
            Ok(map) => map,
            Err(e) => {
                tracing::error!(
                    "[control] the capability map at {} could not be read ({e}) — every frame this box receives is refused as `unknown_token` until it can be, and no master running here can declare a run",
                    self.path.display()
                );
                return None;
            }
        };
        match map.get(token)? {
            Entry::Minted(m) => Some(Holder::Minted(m.clone())),
            Entry::Legacy(session) => {
                let first = self
                    .legacy_said
                    .lock()
                    .map(|mut said| said.insert(session.clone()))
                    .unwrap_or(true);
                if first {
                    tracing::warn!(
                        "[control] a frame for session {session} carries a capability minted before ISS-1316: its entry in {} names that session and no project or pane, so it is resolved as it always was and loses its authority when core replaces that session's row. The pane holding it keeps working until then; a pane placed from now on carries a record instead",
                        self.path.display()
                    );
                }
                Some(Holder::Legacy {
                    session: session.clone(),
                })
            }
        }
    }

    /// The capability this map holds for `session`, as a test that knows a
    /// session and not a token reaches it.
    #[cfg(test)]
    pub(crate) fn holder_for_session(&self, session: &str) -> Option<Holder> {
        self.load().ok()?.into_values().find_map(|e| match e {
            Entry::Minted(m) if m.session == session => Some(Holder::Minted(m)),
            Entry::Legacy(s) if s == session => Some(Holder::Legacy { session: s }),
            _ => None,
        })
    }

    /// The session `token` resolves to, whichever shape its entry is.
    pub fn session_for(&self, token: &str) -> Option<String> {
        self.resolve(token).map(|h| h.session().to_string())
    }

    /// Whether any capability on this box names `session_id`.
    ///
    /// `mint` leaves exactly one entry per session and `retire` removes by
    /// session, so a `false` here means nothing on this box was ever minted
    /// for that session.
    ///
    /// The error is never collapsed into `false`. A map this process could not
    /// read is not evidence about any pane, and treating it as one would report
    /// every master on the box as unplaceable at once.
    pub fn holds_session(&self, session_id: &str) -> Result<bool> {
        Ok(self.load()?.values().any(|e| e.session() == session_id))
    }

    /// Whether a capability on this box answers for the pane `pane` serving
    /// `project` while core serves it `session_id`: a record minted for that
    /// project and pane, or any entry naming that session.
    ///
    /// A record answers whatever session core has moved the pane to since,
    /// which is the whole of ISS-1316; a pre-record entry answers only for its
    /// own session, as it always did.
    pub fn answers_for(&self, session_id: &str, project: &str, pane: &str) -> Result<bool> {
        Ok(self
            .load()?
            .values()
            .any(|e| e.session() == session_id || e.is_pane(project, pane)))
    }

    /// The record minted for the pane named `pane`, where there is one.
    pub fn minted_for_pane(&self, pane: &str) -> Result<Option<Minted>> {
        Ok(self.load()?.into_values().find_map(|e| match e {
            Entry::Minted(m) if m.pane == pane => Some(m),
            _ => None,
        }))
    }

    pub fn retire(&self, session_id: &str) {
        self.retire_where(session_id, |e| e.session() != session_id);
    }

    /// Retire the capability recorded for `pane` serving `project`, whatever
    /// session it was minted under: a pane core moved to another session keeps
    /// the entry it was placed with, so retiring by the session a master ends
    /// under would leave that entry behind.
    pub fn retire_pane(&self, project: &str, pane: &str) {
        self.retire_where(pane, |e| !e.is_pane(project, pane));
    }

    fn retire_where(&self, whose: &str, keep: impl Fn(&Entry) -> bool) {
        let mut map = match self.load() {
            Ok(map) => map,
            Err(e) => {
                tracing::error!(
                    "[control] not retiring {whose}'s capability: the map at {} could not be read ({e}). A map rebuilt from a file this process could not read would drop every other pane's capability, so nothing is written",
                    self.path.display()
                );
                return;
            }
        };
        let before = map.len();
        map.retain(|_, e| keep(e));
        if map.len() != before {
            if let Err(e) = self.store(&map) {
                tracing::error!(
                    "[control] {whose}'s capability could not be retired: {e} — it stays live on this box until the map can be written"
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    fn logged_while(f: impl FnOnce()) -> String {
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    struct TempDir(crate::test_scratch::Scratch);

    impl TempDir {
        fn new() -> Self {
            Self(crate::test_scratch::Scratch::new("ft"))
        }

        /// The map's path. NEVER this box's own: the defect under test is that a
        /// test can reach the operator's real map, so a test that reaches it
        /// while proving the fix is the same bug wearing a different name.
        fn map(&self) -> PathBuf {
            self.0.join("control-tokens.json")
        }
    }

    #[test]
    fn a_token_names_exactly_one_session() {
        let dir = crate::test_scratch::Scratch::new("ft");
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        let b = store.mint("sess-b", "proj-a", "sess-b-pane").unwrap();
        assert_ne!(a, b);
        assert_eq!(store.session_for(&a), Some("sess-a".to_string()));
        assert_eq!(store.session_for(&b), Some("sess-b".to_string()));
        assert_eq!(store.session_for("not-a-token"), None);
    }

    #[test]
    fn a_token_survives_the_daemon_that_minted_it() {
        let dir = crate::test_scratch::Scratch::new("ft");
        let path = dir.join("control-tokens.json");
        let token = SessionTokens::at(path.clone())
            .mint("sess-a", "proj-a", "sess-a-pane")
            .unwrap();
        assert_eq!(
            SessionTokens::at(path).session_for(&token),
            Some("sess-a".to_string()),
            "a daemon restart adopts panes it did not spawn, and their tokens live only in their env — an in-memory map would refuse every live master until it respawned (ISS-964 criterion 29)"
        );
    }

    #[test]
    fn retiring_a_session_retires_its_token() {
        let dir = crate::test_scratch::Scratch::new("ft");
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        store.retire("sess-a");
        assert_eq!(store.session_for(&a), None);
    }

    #[test]
    fn re_minting_replaces_the_previous_token_for_that_session() {
        let dir = crate::test_scratch::Scratch::new("ft");
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let first = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        let second = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        assert_eq!(store.session_for(&second), Some("sess-a".to_string()));
        assert_eq!(
            store.session_for(&first),
            None,
            "a respawned master must not leave a live capability behind for a session that is gone"
        );
    }

    #[test]
    fn an_absent_map_an_empty_map_and_an_unreadable_one_are_three_different_answers() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());

        assert_eq!(
            store.load().expect("an absent map is not an error").len(),
            0,
            "a box that has never minted anything has an empty map, and that is the truth rather than a loss"
        );

        std::fs::write(dir.map(), "{}").unwrap();
        assert_eq!(
            store
                .load()
                .expect("a map written empty is not an error")
                .len(),
            0,
            "every capability legitimately retired leaves `{{}}`, which is a map and not a fault"
        );

        std::fs::write(dir.map(), r#"{"tok":"sess-a"#).unwrap();
        assert!(
            store.load().is_err(),
            "a file that is not a token map is refused by name — read as empty, the next mint writes over every capability this box has handed out"
        );
    }

    #[test]
    fn a_mint_against_a_torn_map_refuses_rather_than_writing_over_what_it_could_not_read() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        let a = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        store.mint("sess-b", "proj-a", "sess-b-pane").unwrap();
        store.mint("sess-c", "proj-a", "sess-c-pane").unwrap();

        // What a reader sees mid-`fs::write`: the leading half of a real map.
        let whole = std::fs::read_to_string(dir.map()).unwrap();
        let torn = whole[..whole.len() / 2].to_string();
        std::fs::write(dir.map(), &torn).unwrap();

        assert!(
            store.mint("sess-d", "proj-a", "sess-d-pane").is_err(),
            "a mint that could not read the map must not write one"
        );
        assert_eq!(
            std::fs::read_to_string(dir.map()).unwrap(),
            torn,
            "and it must not have touched the file: what is on disk is still the torn map, not a fresh one holding only sess-d"
        );

        // Nothing was destroyed, which is the difference that matters: the
        // capabilities come back when the file does.
        std::fs::write(dir.map(), &whole).unwrap();
        assert_eq!(
            store.session_for(&a),
            Some("sess-a".to_string()),
            "a pane whose capability was merely unreadable for a moment is still a pane this box can place"
        );
    }

    #[test]
    fn a_retire_that_cannot_read_the_map_says_so_and_writes_nothing() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        store.mint("sess-b", "proj-a", "sess-b-pane").unwrap();

        let whole = std::fs::read_to_string(dir.map()).unwrap();
        let torn = whole[..whole.len() / 2].to_string();
        std::fs::write(dir.map(), &torn).unwrap();

        let said = logged_while(|| store.retire("sess-a"));

        assert!(
            said.contains("sess-a") && said.contains("could not be read"),
            "an unreadable capability map has to be named out loud, or it passes for an ordinary retire and nothing on this box ever says the file is broken — what was said was: {said}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.map()).unwrap(),
            torn,
            "and nothing is written from a map that could not be read"
        );
    }

    const PUBLISHES_DURING_READS: u32 = 64;

    #[test]
    fn a_reader_never_observes_a_half_written_map() {
        let dir = TempDir::new();
        let path = dir.map();
        let seed = SessionTokens::at(path.clone());
        for i in 0..40 {
            seed.mint(&format!("sess-{i}"), "proj-a", &format!("pane-{i}"))
                .unwrap();
        }

        let stop = Arc::new(AtomicBool::new(false));
        let published = Arc::new(AtomicU32::new(0));
        let stop_writer = stop.clone();
        let counted = published.clone();
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let store = SessionTokens::at(writer_path);
            let mut n: u32 = 0;
            while !stop_writer.load(Ordering::Relaxed) {
                store
                    .mint(
                        &format!("churn-{}", n % 8),
                        "proj-a",
                        &format!("churn-pane-{}", n % 8),
                    )
                    .expect("a writer must be able to read back the map it is replacing");
                counted.fetch_add(1, Ordering::Relaxed);
                n = n.wrapping_add(1);
            }
        });

        let reader = SessionTokens::at(path);
        let mut reads: u32 = 0;
        while reads < 2_000 || published.load(Ordering::Relaxed) < PUBLISHES_DURING_READS {
            reader
                .load()
                .expect("a reader must never observe a map it cannot parse");
            reads += 1;
            assert!(
                reads < 2_000_000,
                "the writer published {} time(s) across {reads} reads — this test can establish nothing about concurrent writes and must not report a pass",
                published.load(Ordering::Relaxed)
            );
        }

        stop.store(true, Ordering::Relaxed);
        writer.join().expect("the writer thread panicked");
    }

    #[cfg(unix)]
    #[test]
    fn a_store_that_cannot_write_reports_it_and_leaves_the_map_intact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        let a = store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        let before = std::fs::read_to_string(dir.map()).unwrap();

        // The map stays readable; the directory stops accepting new files, so the
        // temp file cannot be created and the rename can never happen.
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o500)).unwrap();
        let refused = store.mint("sess-b", "proj-a", "sess-b-pane");
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert!(
            refused.is_err(),
            "a store that could not write must not answer Ok"
        );
        assert_eq!(
            std::fs::read_to_string(dir.map()).unwrap(),
            before,
            "the map this box already handed out is untouched by a write that failed"
        );
        assert_eq!(
            store.session_for(&a),
            Some("sess-a".to_string()),
            "and the capability it names is still live"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_map_is_private_and_no_temp_file_is_left_behind() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        store.mint("sess-a", "proj-a", "sess-a-pane").unwrap();
        store.mint("sess-b", "proj-a", "sess-b-pane").unwrap();

        let mode = std::fs::metadata(dir.map()).unwrap().permissions().mode();
        assert_eq!(
            mode & 0o777,
            0o600,
            "the box's whole authentication is in this file"
        );

        let strays: Vec<_> = std::fs::read_dir(&dir.0)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
            .filter(|n| n != "control-tokens.json")
            .collect();
        assert!(
            strays.is_empty(),
            "a write through a temp file takes its temp file with it, or the config dir fills with them: {strays:?}"
        );
    }

    /// A map as the daemon writes it now, read back as JSON rather than through
    /// the reader under test.
    fn on_disk(dir: &TempDir) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(dir.map()).unwrap()).unwrap()
    }

    #[test]
    fn a_capability_is_written_as_the_session_project_and_pane_it_was_minted_for() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        let token = store
            .mint("sess-a", "proj-a", "forge-master-a")
            .expect("mint");
        let written = on_disk(&dir);
        assert_eq!(
            written[&token],
            serde_json::json!({"session": "sess-a", "project": "proj-a", "pane": "forge-master-a"}),
            "the record is what a pane was placed to be, written by the daemon at placement (ISS-1316 criterion 1): {written}"
        );
        assert_eq!(
            store.resolve(&token),
            Some(Holder::Minted(Minted {
                session: "sess-a".into(),
                project: "proj-a".into(),
                pane: "forge-master-a".into(),
            }))
        );
    }

    #[test]
    fn a_map_written_before_the_record_still_resolves_each_session_and_says_so_once() {
        let dir = TempDir::new();
        std::fs::write(dir.map(), r#"{"tok-old":"sess-old"}"#).unwrap();
        let store = SessionTokens::at(dir.map());
        let said = logged_while(|| {
            assert_eq!(
                store.resolve("tok-old"),
                Some(Holder::Legacy {
                    session: "sess-old".into()
                }),
                "an entry in the pre-change shape resolves to its session as it always did (criterion 10)"
            );
            assert_eq!(store.session_for("tok-old"), Some("sess-old".to_string()));
        });
        assert!(
            said.contains("sess-old") && said.contains("before ISS-1316"),
            "resolving a pre-record capability is said by name (criterion 11): {said}"
        );
        assert_eq!(
            said.matches("before ISS-1316").count(),
            1,
            "a pane sends a frame per hook, so the line is said once per session and not once per frame: {said}"
        );
    }

    #[test]
    fn a_map_holding_both_shapes_reads_both_and_a_mint_keeps_the_old_entry_as_written() {
        let dir = TempDir::new();
        std::fs::write(dir.map(), r#"{"tok-old":"sess-old"}"#).unwrap();
        let store = SessionTokens::at(dir.map());
        let fresh = store.mint("sess-new", "proj-a", "forge-master-a").unwrap();
        assert_eq!(
            on_disk(&dir)["tok-old"],
            serde_json::json!("sess-old"),
            "nothing rewrites an entry after its mint — adding a project to a pre-record entry would be deciding afterwards what it was for (shape 2, refused)"
        );
        assert_eq!(store.session_for("tok-old"), Some("sess-old".into()));
        assert_eq!(store.session_for(&fresh), Some("sess-new".into()));
    }

    #[test]
    fn a_file_in_neither_shape_is_refused_by_name_and_never_read_as_empty() {
        for planted in [
            r#"{"tok":42}"#,
            r#"{"tok":{"session":"sess-a"}}"#,
            r#"{"tok":{"session":"sess-a","project":"proj-a","pane":""}}"#,
            r#"["tok","sess-a"]"#,
        ] {
            let dir = TempDir::new();
            std::fs::write(dir.map(), planted).unwrap();
            let store = SessionTokens::at(dir.map());
            let why = store
                .load()
                .expect_err("a file in neither shape is not a map this box can hold")
                .to_string();
            assert!(
                why.contains(&dir.map().display().to_string())
                    && why.contains("\"project\"")
                    && why.contains("\"<token>\": \"<session id>\""),
                "the refusal names the file and both valid shapes (criterion 12), for {planted}: {why}"
            );
            assert_eq!(
                store.resolve("tok"),
                None,
                "and nothing resolves against it, rather than an empty map answering for it (criterion 13)"
            );
            assert!(
                store.mint("sess-b", "proj-b", "pane-b").is_err(),
                "a mint against it refuses"
            );
            assert_eq!(
                std::fs::read_to_string(dir.map()).unwrap(),
                planted,
                "and leaves the file byte for byte as it was (criterion 14)"
            );
            assert!(
                store.holds_session("sess-a").is_err()
                    && store.answers_for("sess-a", "proj-a", "pane-a").is_err()
                    && store.minted_for_pane("pane-a").is_err(),
                "no query reads a file it cannot parse as evidence about any pane"
            );
        }
    }

    #[test]
    fn minting_for_a_pane_removes_the_earlier_capability_for_that_project_and_pane() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        let first = store.mint("sess-1", "proj-a", "forge-master-a").unwrap();
        let other = store.mint("sess-9", "proj-b", "forge-master-b").unwrap();
        let second = store.mint("sess-2", "proj-a", "forge-master-a").unwrap();
        assert_eq!(
            store.resolve(&first),
            None,
            "a pane is placed under a name only where none of that name is running, so the entry it replaces is for a pane that is gone (criterion 15)"
        );
        assert_eq!(store.session_for(&second), Some("sess-2".into()));
        assert_eq!(
            store.session_for(&other),
            Some("sess-9".into()),
            "another project's pane is untouched"
        );
        assert_eq!(
            on_disk(&dir).as_object().unwrap().len(),
            2,
            "one entry per pane"
        );
    }

    #[test]
    fn a_record_answers_for_its_pane_whatever_session_core_has_moved_it_to() {
        let dir = TempDir::new();
        let store = SessionTokens::at(dir.map());
        store.mint("sess-1", "proj-a", "forge-master-a").unwrap();
        std::fs::write(dir.map(), {
            let mut v = on_disk(&dir);
            v.as_object_mut()
                .unwrap()
                .insert("tok-old".into(), serde_json::json!("sess-legacy"));
            v.to_string()
        })
        .unwrap();
        assert!(store
            .answers_for("sess-2", "proj-a", "forge-master-a")
            .unwrap());
        assert!(
            !store
                .answers_for("sess-2", "proj-b", "forge-master-a")
                .unwrap(),
            "a record answers for its own project only"
        );
        assert!(
            !store
                .answers_for("sess-2", "proj-a", "forge-master-b")
                .unwrap(),
            "and for its own pane only"
        );
        assert!(
            store
                .answers_for("sess-legacy", "proj-z", "forge-master-z")
                .unwrap(),
            "a pre-record entry answers for its own session, as it always did"
        );
        assert!(
            !store.answers_for("sess-other", "proj-z", "forge-master-z").unwrap(),
            "and for nothing else, so a pre-record pane whose row core replaced still reads stale and is replaced by the box (ISS-1208)"
        );
        assert_eq!(
            store
                .minted_for_pane("forge-master-a")
                .unwrap()
                .map(|m| m.project),
            Some("proj-a".to_string())
        );
        assert_eq!(store.minted_for_pane("forge-master-z").unwrap(), None);
    }
}
