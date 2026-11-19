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
//!
//! Two builds share the map, and ISS-1306 is what that cost when each assumed
//! it was alone. On 2026-11-18 the dev.723 runner placed a background master
//! under the name of a tmux pane still running, and its `mint` dropped that
//! pane's entry, since an entry for the same pane name was taken to be a pane
//! that was gone. The start failed and the withdrawal took the session's other
//! entries with it. From 03:49Z every frame the old panes sent was refused as a
//! bare `unknown_token`. So a mint now adds and drops nothing: the entries it
//! replaces go in [`SessionTokens::settle`], once the new pane is up, and a
//! pane that never started has its own token withdrawn and nothing else. An
//! entry this build cannot read is kept as written and honoured for nothing,
//! and it no longer makes the map unreadable for every other pane.

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
    /// How many entries this build could not read when it last said so.
    unknown_said: Mutex<usize>,
}

/// One entry as the file holds it: what this build reads of it, where it reads
/// it at all, and the value itself, written back unchanged so an entry another
/// build wrote outlives this one's writes, its fields with it.
#[derive(Debug, Clone)]
struct Stored {
    entry: Option<Entry>,
    raw: serde_json::Value,
}

impl Stored {
    fn of(entry: Entry) -> Self {
        let raw = serde_json::to_value(&entry).unwrap_or(serde_json::Value::Null);
        Self {
            entry: Some(entry),
            raw,
        }
    }

    /// Whether `keep` keeps it; an entry this build cannot read is always kept.
    fn kept_by(&self, keep: impl Fn(&Entry) -> bool) -> bool {
        self.entry.as_ref().is_none_or(keep)
    }
}

type Map = HashMap<String, Stored>;

/// Why a token resolves to no capability on this box (ISS-1306): the map was
/// read and has no entry for it, or the map could not be read. Each is answered
/// differently, naming the map's path and the way back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unresolved {
    Absent { map: PathBuf },
    Unreadable { map: PathBuf, why: String },
}

pub const CAPABILITY_ABSENT: &str = "CAPABILITY_ABSENT";
pub const CAPABILITY_MAP_UNREADABLE: &str = "CAPABILITY_MAP_UNREADABLE";

impl Unresolved {
    /// The reply a pane is given for a frame its token did not resolve.
    pub fn refusal(&self) -> String {
        match self {
            Self::Absent { map } => format!(
                "[{CAPABILITY_ABSENT}] the capability map at {} can be read and has no entry for \
                 the token in this pane's ${TOKEN_ENV}. This box minted none for it, or it was \
                 retired with the pane it was minted for, so the daemon does not know this pane and \
                 nothing was recorded. The way back: `forge-runner master status <slug>` names the \
                 pane this box serves as the project's master. If it is not this one, this pane is \
                 not the master and its work goes through that pane. If it is this one, `forge-runner \
                 master kill <slug>` ends it, and the next sweep resumes this conversation in a \
                 master whose capability resolves",
                map.display()
            ),
            Self::Unreadable { map, why } => format!(
                "[{CAPABILITY_MAP_UNREADABLE}] this box's capability map at {} could not be read \
                 ({why}). No frame from any pane resolves, including this one, and nothing is \
                 written over the file. The way back is to make {} readable again, or put back the \
                 map it replaced. Frames resolve from the first read that succeeds, with no \
                 restart. Moving the file aside drops every pane's capability, and the box then \
                 places each master again with a new one",
                map.display(),
                map.display()
            ),
        }
    }
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
            unknown_said: Mutex::new(0),
        }
    }

    /// Where the map lives, which every refusal of a frame names.
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn load(&self) -> Result<Map> {
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
        let values: HashMap<String, serde_json::Value> =
            serde_json::from_str(&raw).map_err(|e| refused(e.to_string()))?;
        let map: Map = values
            .into_iter()
            .map(|(token, raw)| {
                let entry = serde_json::from_value::<Entry>(raw.clone()).ok();
                (token, Stored { entry, raw })
            })
            .collect();
        let blank = map
            .values()
            .filter_map(|s| s.entry.as_ref())
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
        self.say_unknown(map.values().filter(|s| s.entry.is_none()).count());
        Ok(map)
    }

    /// Say, once per change in their number, that the map holds entries this
    /// build cannot read: kept as written, and honoured for nothing.
    fn say_unknown(&self, unknown: usize) {
        let Ok(mut said) = self.unknown_said.lock() else {
            return;
        };
        if *said == unknown {
            return;
        }
        *said = unknown;
        if unknown > 0 {
            tracing::warn!(
                "[control] the capability map at {} holds {unknown} entry(ies) in a shape this build does not read ({SHAPES}). A build other than this one wrote them. Each is kept as written and resolves no frame here, and every other entry resolves as before",
                self.path.display()
            );
        }
    }

    fn store(&self, map: &Map) -> Result<()> {
        let parent = self.path.parent().ok_or_else(|| {
            Error::Other(format!(
                "tokens: {} has no parent directory to write beside",
                self.path.display()
            ))
        })?;
        std::fs::create_dir_all(parent).map_err(|e| Error::Other(format!("tokens: {e}")))?;
        let raw: HashMap<&String, &serde_json::Value> =
            map.iter().map(|(token, s)| (token, &s.raw)).collect();
        let body = serde_json::to_string(&raw).map_err(|e| Error::Other(format!("tokens: {e}")))?;
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
    /// Nothing else goes. An earlier entry for the same pane name may be a pane
    /// still running that this build cannot see, and another build placing over
    /// it took its capability with it (ISS-1306). What the new pane replaces is
    /// retired by [`Self::settle`], once that pane is up.
    pub fn mint(&self, session: &str, project: &str, slug: &str, pane: &str) -> Result<String> {
        let mut map = self.load()?;
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        map.insert(
            token.clone(),
            Stored::of(Entry::Minted(Minted {
                session: session.to_string(),
                project: project.to_string(),
                slug: Some(slug.to_string()),
                pane: pane.to_string(),
            })),
        );
        self.store(&map)?;
        Ok(token)
    }

    /// The pane `token` was minted for is up: every other entry for its session,
    /// and every other entry for its project and pane, goes. A process now runs
    /// under that name holding `token`, so the pane those entries were minted
    /// for has ended.
    pub fn settle(&self, token: &str) -> Result<()> {
        let mut map = self.load()?;
        let Some(Entry::Minted(minted)) = map.get(token).and_then(|s| s.entry.clone()) else {
            return Err(Error::Other(format!(
                "tokens: {} holds no record for the capability just minted, so nothing it replaces was retired",
                self.path.display()
            )));
        };
        let before = map.len();
        map.retain(|t, s| {
            t == token
                || s.kept_by(|e| {
                    e.session() != minted.session && !e.is_pane(&minted.project, &minted.pane)
                })
        });
        if map.len() == before {
            return Ok(());
        }
        self.store(&map)
    }

    /// Take back `token`, minted for a pane that did not start or found one
    /// already running under its name, so no process holds it. Only that entry
    /// goes; the running pane keeps its own (ISS-1306).
    pub fn withdraw(&self, token: &str) -> Result<()> {
        let mut map = self.load()?;
        if map.remove(token).is_none() {
            return Ok(());
        }
        self.store(&map)
    }

    /// Who `token` was minted for, or why no capability on this box is that
    /// token: the map holds no entry for it, or the map cannot be read.
    pub fn resolve(&self, token: &str) -> std::result::Result<Holder, Unresolved> {
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
                        "[control] the capability map at {} could not be read ({e}) — every frame this box receives is refused as `{CAPABILITY_MAP_UNREADABLE}` until it can be, and no master running here can declare a run. Said once for this failure; a different one, or the map reading again, is said when it happens",
                        self.path.display()
                    );
                }
                return Err(Unresolved::Unreadable {
                    map: self.path.clone(),
                    why: e.to_string(),
                });
            }
        };
        let absent = || Unresolved::Absent {
            map: self.path.clone(),
        };
        match map.get(token).ok_or_else(absent)?.entry.as_ref() {
            None => Err(absent()),
            Some(Entry::Minted(m)) => Ok(Holder::Minted(m.clone())),
            Some(Entry::Legacy(session)) => Ok(self.legacy(session)),
        }
    }

    fn legacy(&self, session: &str) -> Holder {
        let first = self
            .legacy_said
            .lock()
            .map(|mut said| said.insert(session.to_string()))
            .unwrap_or(true);
        if first {
            tracing::warn!(
                "[control] a frame for session {session} carries a capability minted by forge-runner before 0.17.72: its entry in {} names that session and no project or pane, so it is resolved as it always was and loses its authority when core replaces that session's row. The pane holding it keeps working until then; a pane placed from now on carries a record instead",
                self.path.display()
            );
        }
        Holder::Legacy {
            session: session.to_string(),
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

    /// Whether the map holds `token`.
    ///
    /// The error is never collapsed into `false`. A map this process could not
    /// read says nothing about any token, and reading it as an answer would
    /// report a withdrawal that may not have been made.
    pub fn holds_token(&self, token: &str) -> Result<bool> {
        Ok(self.load()?.contains_key(token))
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
            .filter_map(|s| s.entry.as_ref())
            .any(|e| e.session() == session_id || e.is_pane(project, pane)))
    }

    /// The record minted for the pane named `pane`, where there is one.
    pub fn minted_for_pane(&self, pane: &str) -> Result<Option<Minted>> {
        Ok(self.load()?.into_values().find_map(|s| match s.entry {
            Some(Entry::Minted(m)) if m.pane == pane => Some(m),
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
        map.retain(|_, s| s.kept_by(&keep));
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
#[path = "session_tokens_tests.rs"]
mod tests;
