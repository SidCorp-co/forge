//! Who is on the other end of the control socket.
//!
//! A master used to say which session it was and the daemon believed it. That
//! is not an identity, it is a claim: any process that can reach the socket can
//! make it, and every verb this issue adds — park, read a question, revive —
//! acts on a session by name (ISS-964 criteria 29-31).
//!
//! So the daemon mints a capability instead. The token goes into the pane's
//! environment at spawn, comes back on every frame, and the map from token to
//! session is the daemon's own. A frame no longer names a session at all.
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

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

pub struct SessionTokens {
    path: PathBuf,
}

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
        Self { path }
    }

    fn load(&self) -> Result<HashMap<String, String>> {
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
        serde_json::from_str(&raw).map_err(|e| {
            Error::Other(format!(
                "tokens: {} holds {} byte(s) that are not a token map ({e}) — refusing to read it as empty, because the next mint would then write over every capability this box has handed out",
                self.path.display(),
                raw.len()
            ))
        })
    }

    fn store(&self, map: &HashMap<String, String>) -> Result<()> {
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

    pub fn mint(&self, session_id: &str) -> Result<String> {
        let mut map = self.load()?;
        map.retain(|_, s| s != session_id);
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        map.insert(token.clone(), session_id.to_string());
        self.store(&map)?;
        Ok(token)
    }

    pub fn session_for(&self, token: &str) -> Option<String> {
        match self.load() {
            Ok(map) => map.get(token).cloned(),
            Err(e) => {
                tracing::error!(
                    "[control] the capability map at {} could not be read ({e}) — every frame this box receives is refused as `unknown_token` until it can be, and no master running here can declare a run",
                    self.path.display()
                );
                None
            }
        }
    }

    /// Whether any capability on this box names `session_id`.
    ///
    /// `mint` leaves exactly one entry per session and `retire` removes by
    /// session, so a `false` here means nothing on this box was ever minted
    /// for that session — which is what a pane adopted onto a session row core
    /// replaced looks like from the daemon's side.
    ///
    /// The error is never collapsed into `false`. A map this process could not
    /// read is not evidence about any pane, and treating it as one would report
    /// every master on the box as unplaceable at once.
    pub fn holds_session(&self, session_id: &str) -> Result<bool> {
        Ok(self.load()?.values().any(|s| s == session_id))
    }

    pub fn retire(&self, session_id: &str) {
        let mut map = match self.load() {
            Ok(map) => map,
            Err(e) => {
                tracing::error!(
                    "[control] not retiring {session_id}'s capability: the map at {} could not be read ({e}). A map rebuilt from a file this process could not read would drop every other pane's capability, so nothing is written",
                    self.path.display()
                );
                return;
            }
        };
        let before = map.len();
        map.retain(|_, s| s != session_id);
        if map.len() != before {
            if let Err(e) = self.store(&map) {
                tracing::error!(
                    "[control] {session_id}'s capability could not be retired: {e} — it stays live on this box until the map can be written"
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
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "ft-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("temp dir");
            Self(dir)
        }

        /// The map's path. NEVER this box's own: the defect under test is that a
        /// test can reach the operator's real map, so a test that reaches it
        /// while proving the fix is the same bug wearing a different name.
        fn map(&self) -> PathBuf {
            self.0.join("control-tokens.json")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_token_names_exactly_one_session() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a").unwrap();
        let b = store.mint("sess-b").unwrap();
        assert_ne!(a, b);
        assert_eq!(store.session_for(&a), Some("sess-a".to_string()));
        assert_eq!(store.session_for(&b), Some("sess-b".to_string()));
        assert_eq!(store.session_for("not-a-token"), None);
    }

    #[test]
    fn a_token_survives_the_daemon_that_minted_it() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let path = dir.join("control-tokens.json");
        let token = SessionTokens::at(path.clone()).mint("sess-a").unwrap();
        assert_eq!(
            SessionTokens::at(path).session_for(&token),
            Some("sess-a".to_string()),
            "a daemon restart adopts panes it did not spawn, and their tokens live only in their env — an in-memory map would refuse every live master until it respawned (ISS-964 criterion 29)"
        );
    }

    #[test]
    fn retiring_a_session_retires_its_token() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let a = store.mint("sess-a").unwrap();
        store.retire("sess-a");
        assert_eq!(store.session_for(&a), None);
    }

    #[test]
    fn re_minting_replaces_the_previous_token_for_that_session() {
        let dir = std::env::temp_dir().join(format!("ft-{}", uuid::Uuid::new_v4()));
        let store = SessionTokens::at(dir.join("control-tokens.json"));
        let first = store.mint("sess-a").unwrap();
        let second = store.mint("sess-a").unwrap();
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
        let a = store.mint("sess-a").unwrap();
        store.mint("sess-b").unwrap();
        store.mint("sess-c").unwrap();

        // What a reader sees mid-`fs::write`: the leading half of a real map.
        let whole = std::fs::read_to_string(dir.map()).unwrap();
        let torn = whole[..whole.len() / 2].to_string();
        std::fs::write(dir.map(), &torn).unwrap();

        assert!(
            store.mint("sess-d").is_err(),
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
        store.mint("sess-a").unwrap();
        store.mint("sess-b").unwrap();

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
            seed.mint(&format!("sess-{i}")).unwrap();
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
                    .mint(&format!("churn-{}", n % 8))
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
        let a = store.mint("sess-a").unwrap();
        let before = std::fs::read_to_string(dir.map()).unwrap();

        // The map stays readable; the directory stops accepting new files, so the
        // temp file cannot be created and the rename can never happen.
        std::fs::set_permissions(&dir.0, std::fs::Permissions::from_mode(0o500)).unwrap();
        let refused = store.mint("sess-b");
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
        store.mint("sess-a").unwrap();
        store.mint("sess-b").unwrap();

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
}
