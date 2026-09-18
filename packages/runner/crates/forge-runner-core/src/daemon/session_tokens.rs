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

/// The token-to-session map for one box, backed by a file beside the socket.
// cm:guard the map is token -> session and is read ONLY in that direction. A lookup by session id would let a caller who knows a session name reach it, which is the declared-id weakness this replaces.
pub struct SessionTokens {
    path: PathBuf,
}

/// Where the map lives: beside `control.sock`, so the config dir separates the
/// box's several runner services exactly as it separates their sockets.
// cm:edge naming -> packages/runner/crates/forge-runner-core/src/daemon/control.rs — `socket_path` picks the directory; two daemons sharing this file would hand each other's masters valid capabilities.
pub fn default_path() -> Option<PathBuf> {
    crate::daemon::control::socket_path().map(|s| s.with_file_name("control-tokens.json"))
}

/// The environment variable a pane carries its capability in.
// cm:edge contract -> packages/runner/crates/forge-runner/src/cmd/hook.rs — the CLI reads this name and puts the value on every frame; a session never sees an id to send.
pub const TOKEN_ENV: &str = "FORGE_CONTROL_TOKEN";

/// The capability this process was spawned with, for the CLI side of the socket.
// cm:guard refuse by NAME when the variable is absent rather than sending an empty token. An empty token is refused as `unknown_token`, which reads as a revoked capability and sends a master looking at core; "not spawned by the daemon" is a different fault with a different fix.
pub fn token_from_env() -> std::io::Result<String> {
    match std::env::var(TOKEN_ENV) {
        Ok(t) if !t.trim().is_empty() => Ok(t),
        _ => Err(std::io::Error::other(format!(
            "{TOKEN_ENV} is not set — this session was not spawned by the runner daemon, and the control socket has no other way to know who is calling"
        ))),
    }
}

/// Write bytes to a file only this user can read, and get them onto the disk
/// before the caller renames it into place.
// cm:guard mode 0600 at CREATION rather than by a `set_permissions` afterwards, because that leaves a window in which this file is world-readable — and this file is the whole of the control socket's authentication.
// cm:guard `sync_all` before the rename, not after: a rename that reaches the disk ahead of its own content is one power cut away from an EMPTY file presented as the complete map. `load` would refuse it correctly, which turns a crash into a box whose every pane has lost its capability.
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

impl SessionTokens {
    pub fn at(path: PathBuf) -> Self {
        Self { path }
    }

    /// The map, or why it could not be read.
    ///
    /// An absent file is an EMPTY map and not an error: that is a box that has
    /// never minted anything, and there "nothing here" is the truth rather than
    /// a loss. Every other failure is an error.
    // cm:guard ABSENT and UNPARSEABLE are different answers, and collapsing them is the whole of ISS-1099. This used to be `.ok().and_then(parse).unwrap_or_default()`, so a torn or corrupt file answered "empty map" — indistinguishable from first boot — and `mint` then stored its one new entry over every capability on the box. The refusal is the deliverable; the caller deciding what to do with it is below.
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

    // cm:guard mode 0600 on write, and the file is created here rather than trusted to exist. A capability readable by another user on the box is not a capability, and this file is the whole of the socket's authentication.
    // cm:guard a sibling temp file and a RENAME, never `fs::write` in place. `fs::write` truncates before it writes, and `session_for` reads this file on every frame of every pane on the box, so an in-place write publishes an empty and then a half-written map to every concurrent reader. `load`'s refusal above keeps such a read from destroying anything; this keeps the read from happening (ISS-1099).
    fn store(&self, map: &HashMap<String, String>) -> Result<()> {
        let parent = self.path.parent().ok_or_else(|| {
            Error::Other(format!(
                "tokens: {} has no parent directory to write beside",
                self.path.display()
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        let body = serde_json::to_string(map).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        // cm:guard the temp file is a SIBLING, because `rename` is atomic only within one
        // filesystem and the system temp dir is routinely a different one.
        let tmp = parent.join(format!(
            ".control-tokens.{}.{}.tmp",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let done =
            write_private(&tmp, body.as_bytes()).and_then(|()| std::fs::rename(&tmp, &self.path));
        if let Err(e) = done {
            let _ = std::fs::remove_file(&tmp);
            return Err(Error::Other(format!(
                "tokens: {} could not be replaced: {e}",
                self.path.display()
            )));
        }
        Ok(())
    }

    /// Give this session a fresh capability, retiring anything it held.
    // cm:guard the `?` is the fix's load-bearing character: a mint that could not read the map does not write one. Minting anyway is how one unreadable file became six panes with no capability and a fleet that stood still.
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

    /// Which session holds this capability, if any.
    // cm:guard a map this process cannot read answers `None`, exactly as a forged token does, so it is said OUT LOUD here. `serve_one` logs nothing on the refusal it builds from this — it answers `unknown_token` down the socket and returns — so without this line an unreadable map and an idle box leave identical records, which is how ISS-1099 ran for hours with nothing in the journal naming it.
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

    /// This session is gone; its capability goes with it.
    // cm:guard the same refusal as `mint`, on the other writer and for a sharper reason: `retire` is reached from `end_master` whenever a master stands down, so a retire that rebuilt the map from an unreadable file would drop every OTHER pane's capability in the course of removing one.
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
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};

    /// Whatever the daemon said while `f` ran.
    // cm:guard the same shape `master.rs` uses for the same need: a `tracing` line is the only
    // observable difference some of these arms have, and an arm whose report nothing reads is one
    // that can be deleted without a test noticing.
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

    /// A directory this test owns and takes with it.
    // cm:guard RAII rather than a line at the end of the body: a `remove_dir_all` at the end is skipped by a panic, and skipping it is how 90 `/tmp/forge-cred-*` directories came to sit on forge-vm.
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

    // cm:guard the three states asserted against EACH OTHER in one test, because the defect was
    // precisely that two of them were one: `load` answered an empty map both to "nothing was ever
    // written" and to "this file is not a token map". A test that checked only the absent case
    // passes the code that lost this fleet its capabilities.
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

    // cm:guard THE assertion for ISS-1099's box half, and the plant is the truncation and nothing
    // else: same three capabilities, same mint, one torn file. Put `unwrap_or_default()` back in
    // `load` and this goes red, because the old mint SUCCEEDED and left the map holding only its
    // one new entry — 73 bytes where six panes' capabilities had been (forge-vm, 13:29:13Z on
    // 2026-09-18).
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

    // cm:guard the assertion here is the REPORT, and it is the report because the file outcome does
    // NOT discriminate: the implementation this replaces also wrote nothing on this path, by
    // accident of the length guard — `load` answered an empty map, `retain` removed nothing, and
    // `len() != before` was false, so `store` was never reached. The first version of this test
    // asserted only "the file is unchanged" and stayed GREEN under the plant that reds the two
    // above it, which is a test that cannot fail. What is genuinely new is that an unreadable map
    // is SAID: delete the `tracing::error!` and its `return` and this goes red, while the file
    // assertion below would not.
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

    // cm:guard the half `load`'s refusal cannot give. With `fs::write` the file is TRUNCATED before
    // it is rewritten, and `session_for` reads it on every frame of every pane on the box, so a
    // concurrent reader observes an empty or half-written map. Refusing that read keeps the
    // capabilities; writing through a rename means the read never happens. Against the bare
    // `fs::write` this replaces, the `expect` below fires within a few hundred reads.
    #[test]
    fn a_reader_never_observes_a_half_written_map() {
        let dir = TempDir::new();
        let path = dir.map();
        let seed = SessionTokens::at(path.clone());
        for i in 0..40 {
            seed.mint(&format!("sess-{i}")).unwrap();
        }

        let stop = Arc::new(AtomicBool::new(false));
        let stop_writer = stop.clone();
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let store = SessionTokens::at(writer_path);
            let mut n: u32 = 0;
            while !stop_writer.load(Ordering::Relaxed) {
                store
                    .mint(&format!("churn-{}", n % 8))
                    .expect("a writer must be able to read back the map it is replacing");
                n = n.wrapping_add(1);
            }
        });

        let reader = SessionTokens::at(path);
        for _ in 0..2000 {
            reader
                .load()
                .expect("a reader must never observe a map it cannot parse");
        }

        stop.store(true, Ordering::Relaxed);
        writer.join().expect("the writer thread panicked");
    }

    // cm:guard the file the socket authenticates against is never left readable by another user on
    // the box, and the rename is what makes that assertable: the mode is on the temp file before it
    // becomes the map, so there is no window to catch it in.
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
