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

use runner_platform::error::{Error, Result};

pub struct SessionTokens {
    path: PathBuf,
    /// The sessions whose pre-record capability this process has already
    /// named, so a pane sending a frame per hook is named once.
    legacy_said: Mutex<HashSet<String>>,
    /// The failure to read the map this process last logged, so a broken file
    /// is said once per failure rather than once per frame.
    unreadable_said: Mutex<Option<String>>,
}

/// What a capability was minted for, as the daemon wrote it at placement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Minted {
    /// The core `agent_sessions` row the pane was placed under.
    pub session: String,
    pub project: String,
    /// The project's slug at placement: what an operator types to act on the
    /// pane. Absent from a record 0.17.72 wrote, which carried none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    /// The tmux session the pane was started as.
    pub pane: String,
}

/// One entry of the map, in either of the two shapes a file can hold.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
enum Entry {
    Minted(Minted),
    /// Written by forge-runner before 0.17.72: a session id and nothing else.
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

const SHAPES: &str = "each entry is `\"<token>\": {\"session\": \"<id>\", \"project\": \"<id>\", \"slug\": \"<slug>\", \"pane\": \"<tmux session>\"}`, `slug` absent from one 0.17.72 wrote, or, written by forge-runner before 0.17.72, `\"<token>\": \"<session id>\"`";

pub fn default_path() -> Option<PathBuf> {
    crate::control::socket_path().map(|s| s.with_file_name("control-tokens.json"))
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
            unreadable_said: Mutex::new(None),
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
                Entry::Minted(m) => [
                    Some(&m.session),
                    Some(&m.project),
                    m.slug.as_ref(),
                    Some(&m.pane),
                ]
                .iter()
                .flatten()
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
    /// `project` (known to an operator as `slug`) under `session`.
    ///
    /// Every earlier entry for the same session, and every earlier entry for
    /// the same project and pane, goes: a pane is placed under a name only
    /// where no pane of that name is running, so the entry it replaces was for
    /// a pane that is gone.
    pub fn mint(&self, session: &str, project: &str, slug: &str, pane: &str) -> Result<String> {
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
                slug: Some(slug.to_string()),
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
            Ok(map) => {
                if self.unreadable_said_now(None) {
                    tracing::info!(
                        "[control] the capability map at {} reads again — frames are resolved against it from here on",
                        self.path.display()
                    );
                }
                map
            }
            Err(e) => {
                if self.unreadable_said_now(Some(e.to_string())) {
                    tracing::error!(
                        "[control] the capability map at {} could not be read ({e}) — every frame this box receives is refused as `unknown_token` until it can be, and no master running here can declare a run. Said once for this failure; a different one, or the map reading again, is said when it happens",
                        self.path.display()
                    );
                }
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
                        "[control] a frame for session {session} carries a capability minted by forge-runner before 0.17.72: its entry in {} names that session and no project or pane, so it is resolved as it always was and loses its authority when core replaces that session's row. The pane holding it keeps working until then; a pane placed from now on carries a record instead",
                        self.path.display()
                    );
                }
                Some(Holder::Legacy {
                    session: session.clone(),
                })
            }
        }
    }

    /// Record `now` as the map's reading, `None` for one that read, and say
    /// whether it differs from the last one recorded: what `resolve` logs on.
    /// A poisoned lock answers `true` for a failure and `false` for a read,
    /// so a failure is over-said rather than lost.
    fn unreadable_said_now(&self, now: Option<String>) -> bool {
        let Ok(mut last) = self.unreadable_said.lock() else {
            return now.is_some();
        };
        if *last == now {
            return false;
        }
        *last = now;
        true
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
