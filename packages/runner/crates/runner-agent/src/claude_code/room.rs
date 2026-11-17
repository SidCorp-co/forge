//! A channel agent's resident session as a Claude Code background session, inside a sandbox of
//! its own that its owner attaches to with `forge-runner chat attach <slug>` (ISS-946, ISS-1268
//! BR).
//!
//! The headless chat host runs the resident as a `stream-json` child; here the same confined view
//! (`confine::chat_sandbox`, with the room's own directories) holds the room's own background
//! service (`runner_workspace::bg_session::room`), and every turn still reaches it through the box
//! and closes through the same write:
//! - a turn is a message on the session's peer socket, delivered only on its receipt; a new
//!   session's first is its launch prompt, a resumed session's is sent once the status line it
//!   starts with has given the turn's baseline;
//! - its lines come from the session's transcript, tailed, and go to the turn's sink as the
//!   stream's did, so `chat.rs:consume` posts them and beats the turn unchanged;
//! - its end is the `Stop` hook (`room_turn`), after which the turn's `result` line is made and
//!   `Done` sent, so `chat.rs:close_turn` writes what it writes for a headless turn;
//! - a message written into a running turn is sent `now`, and taken into that turn at its next
//!   step (measured on 2.1.322: a `queued_command` attachment, ISS-1268 B4).

use std::path::PathBuf;

#[cfg(test)]
use super::room_first_turn::first_turn_base;
use super::room_first_turn::{first_turn, launch_prompt};
use super::room_turn::{status_cost, turn_cost, Tally, COST_AFTER_STOP_MS};
use super::*;
use crate::room_launch::{self, SessionStart};
use runner_core::chat_pane_events::{self, STATUS_LINE};
use runner_workspace::bg_session::room::{Host, RoomDirs, HOLDER};
use runner_workspace::bg_session::{self, BgLaunch, Kind, Priority};

pub(crate) type Rooms = Arc<Mutex<HashMap<String, RoomSession>>>;

/// How often the session's events and transcript are read while it lives.
pub(super) const READ_EVERY: Duration = Duration::from_millis(200);

/// Every how many reads the room is asked whether its session still runs.
const ALIVE_EVERY: u32 = 10;

/// How many asks in a row may find no live process for the session before it counts as gone: a
/// respawn changes its pid, and its record stands again within a second.
const GONE_AFTER: u32 = 3;

pub(crate) struct RoomSession {
    /// The room's sandbox; none for a test's turn.
    host: Option<Host>,
    name: String,
    /// The short id `claude stop` takes.
    bg_id: String,
    claude_session_id: String,
    turn_tx: TurnTx,
    in_turn: bool,
    /// The inbox writes of the messages the session took, reported applied once the turn ends.
    pending_inbox: Vec<(String, u64)>,
    turns: u64,
    bearer_dir: Option<PathBuf>,
    mcp_path: PathBuf,
    events: PathBuf,
    model: Option<String>,
    head_sha: Option<String>,
    checkout: crate::CheckoutView,
    siblings: Vec<PathBuf>,
    repo_path: PathBuf,
    watcher: Option<tokio::task::JoinHandle<()>>,
    /// The room's sandbox process: ended with this entry, and with this daemon.
    _sandbox: Option<tokio::process::Child>,
    /// The confined session's network, for as long as the room lives.
    _egress: Option<EgressGuard>,
}

/// What this box says about its room agents on its heartbeat (`capabilities.chatRooms`): each
/// live one's project by the session it serves, or why rooms are on and none can be made.
#[derive(Default)]
struct Facts {
    rooms: std::collections::BTreeMap<String, String>,
    unavailable: Option<String>,
}

static FACTS: std::sync::Mutex<Option<Facts>> = std::sync::Mutex::new(None);

fn with_facts(f: impl FnOnce(&mut Facts)) {
    if let Ok(mut g) = FACTS.lock() {
        f(g.get_or_insert_with(Facts::default));
    }
}

/// The heartbeat's `chatRooms`: `None` where this box runs no room agents as background sessions.
pub fn chat_room_facts() -> Option<serde_json::Value> {
    let on = runner_platform::config::Config::load().is_ok_and(|c| c.runner.chat_panes);
    if !on {
        return None;
    }
    let g = FACTS.lock().ok()?;
    let facts = g.as_ref();
    let mut out = serde_json::json!({
        "sessions": facts.map(|f| f.rooms.clone()).unwrap_or_default(),
    });
    if let Some(why) = facts.and_then(|f| f.unavailable.clone()) {
        out["unavailable"] = why.into();
    }
    Some(out)
}

/// Record why a turn that would have run in a room runs headless, for the log and the heartbeat.
pub fn room_refused(session: &str, why: &str) {
    tracing::warn!("[chat {session}] runs headless: {why}");
    with_facts(|f| f.unavailable = Some(why.to_string()));
}

/// A room's sandbox, open: what [`ClaudeCodeRunner::open_room`] made.
struct Opened {
    host: Host,
    sandbox: tokio::process::Child,
    egress: Option<EgressGuard>,
    mcp_path: PathBuf,
    bearer_dir: Option<PathBuf>,
}

impl Opened {
    /// End what was opened for a session that never started.
    fn close(self, id: &str) {
        self.host.end();
        drop(self.sandbox);
        remove_made(id, &self.mcp_path, self.bearer_dir.as_deref());
    }
}

fn remove_made(id: &str, mcp_path: &std::path::Path, bearer_dir: Option<&std::path::Path>) {
    if let Err(e) = std::fs::remove_file(mcp_path) {
        tracing::debug!("[chat {id}] {}: {e}", mcp_path.display());
    }
    if let Some(dir) = bearer_dir {
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// The session a room started: its ids, where it writes, and the cost its first turn is measured
/// from.
struct Begun {
    bg_id: String,
    sid: String,
    events: PathBuf,
    transcript: PathBuf,
    from: u64,
    cost_base: Option<f64>,
}

impl ClaudeCodeRunner {
    /// Start `spec`'s session in `slug`'s room: its sandbox, its background session, and its
    /// first turn.
    pub async fn start_in_room(
        &self,
        spec: JobSpec,
        slug: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()> {
        let id = spec.job_id.clone();
        if spec.confinement.is_none() {
            return Err(Error::Other(
                "[CHAT_ROOM_UNCONFINED] a room agent's session runs only confined".into(),
            ));
        }
        let prompt = spec
            .prompt
            .clone()
            .ok_or_else(|| Error::Other("job has no prompt".into()))?;
        let credential = session_credential(&spec)?;
        let name = bg_session::session_name(Kind::Chat, &slug);
        self.clear_for(&id, &name, &slug).await?;
        let dirs = RoomDirs::of(&slug).map_err(Error::Other)?;
        dirs.make(&spec.repo_path).map_err(Error::Other)?;
        let events = dirs.events(&name);
        let (mcp_path, bearer_dir) = mcp_config_for(&self.core_url, &spec, &credential)?;
        if let Err(e) = write_settings(&dirs, &events, &mcp_path) {
            remove_made(&id, &mcp_path, bearer_dir.as_deref());
            return Err(e);
        }
        let made = (mcp_path, bearer_dir);
        let opened = self.open_room(&spec, &dirs, &credential, made).await?;
        let begun = match begin(&spec, &opened, (&name, &prompt), &dirs, events).await {
            Ok(b) => b,
            Err(e) => {
                opened.close(&id);
                return Err(e);
            }
        };
        tracing::info!(
            "[chat {id}] started as {name} ({}) — forge-runner chat attach {slug}",
            begun.bg_id
        );
        self.hold(spec, (opened, begun), (name, slug), tx).await;
        Ok(())
    }

    /// The room's sandbox, running its holder, with the session's MCP config and network.
    async fn open_room(
        &self,
        spec: &JobSpec,
        dirs: &RoomDirs,
        credential: &str,
        (mcp_path, bearer_dir): (PathBuf, Option<PathBuf>),
    ) -> Result<Opened> {
        let repo = spec.repo_path.to_string_lossy().into_owned();
        let holder_args: Vec<String> = HOLDER[1..].iter().map(|a| (*a).to_string()).collect();
        let opened = async {
            let (mut cmd, egress) = SessionCommand {
                spec,
                program: std::ffi::OsStr::new(HOLDER[0]),
                args: &holder_args,
                repo: &repo,
                credential,
                mcp_path: &mcp_path,
                bearer_dir: bearer_dir.as_deref(),
                core_url: &self.core_url,
            }
            .build_with(None, Some(dirs))
            .await?;
            cmd.stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true);
            let sandbox = cmd.spawn().map_err(|e| {
                Error::Other(format!("[CHAT_ROOM_UNHOSTED] the room's sandbox: {e}"))
            })?;
            let outer = sandbox.id().ok_or_else(|| {
                Error::Other("[CHAT_ROOM_UNHOSTED] the room's sandbox ended at once".into())
            })?;
            let host = Host::record(outer, dirs.clone())
                .await
                .map_err(Error::Other)?;
            Ok::<_, Error>((host, sandbox, egress))
        }
        .await;
        match opened {
            Ok((host, sandbox, egress)) => Ok(Opened {
                host,
                sandbox,
                egress,
                mcp_path,
                bearer_dir,
            }),
            Err(e) => {
                remove_made(&spec.job_id, &mcp_path, bearer_dir.as_deref());
                Err(e)
            }
        }
    }

    /// Keep the started session under `id`, and read it while it lives.
    async fn hold(
        &self,
        spec: JobSpec,
        (opened, begun): (Opened, Begun),
        (name, slug): (String, String),
        tx: mpsc::Sender<RunnerEvent>,
    ) {
        let id = spec.job_id.clone();
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx.clone()));
        let _ = tx
            .send(RunnerEvent::ClaudeSessionId(begun.sid.clone()))
            .await;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        with_facts(|f| {
            f.rooms.insert(id.clone(), slug);
            f.unavailable = None;
        });
        let watch = Watch {
            rooms: self.rooms.clone(),
            id: id.clone(),
            sid: begun.sid.clone(),
            host: Some(opened.host.clone()),
            events: begun.events.clone(),
            transcript: begun.transcript,
            transcript_from: begun.from,
            cost_base: begun.cost_base,
            core: runner_transport::CoreClient::new(
                self.core_url.clone(),
                self.device_token.clone(),
            ),
        };
        let confinement = spec.confinement.clone().unwrap_or_default();
        let mut map = self.rooms.lock().await;
        map.insert(
            id.clone(),
            RoomSession {
                host: Some(opened.host),
                name,
                bg_id: begun.bg_id,
                claude_session_id: begun.sid,
                turn_tx,
                in_turn: true,
                pending_inbox: Vec::new(),
                turns: 0,
                bearer_dir: opened.bearer_dir,
                mcp_path: opened.mcp_path,
                events: begun.events,
                model: spec.model.clone(),
                head_sha: None,
                checkout: confinement.checkout,
                siblings: confinement.siblings,
                repo_path: spec.repo_path.clone(),
                watcher: None,
                _sandbox: Some(opened.sandbox),
                _egress: opened.egress,
            },
        );
        if let Some(s) = map.get_mut(&id) {
            s.watcher = Some(tokio::spawn(watch.run()));
        }
    }

    /// The key and the room free for a session `id`: whatever held the key is retired, a room
    /// another session holds refuses, and a sandbox of the room that no session here holds is
    /// ended.
    async fn clear_for(&self, id: &str, name: &str, slug: &str) -> Result<()> {
        self.retire(id).await?;
        let holder = {
            let map = self.rooms.lock().await;
            map.iter()
                .find(|(_, s)| s.name == name)
                .map(|(id, _)| id.clone())
        };
        if let Some(holder) = holder {
            return Err(Error::Other(format!(
                "[CHAT_ROOM_HELD] {name} already serves session {holder} on this box"
            )));
        }
        if let Ok(left) = Host::of(slug) {
            tracing::info!("[chat {id}] {name}'s sandbox is left from before — ending it");
            left.end();
        }
        Ok(())
    }

    pub(crate) async fn room_resident(&self, id: &str) -> Option<Resident> {
        let map = self.rooms.lock().await;
        let s = map.get(id)?;
        Some(Resident {
            model: s.model.clone(),
            head_sha: s.head_sha.clone(),
            refreshable: s.bearer_dir.is_some(),
            checkout: s.checkout.clone(),
            siblings: s.siblings.clone(),
            repo_path: s.repo_path.clone(),
        })
    }

    pub(crate) async fn room_bearer_dir(&self, id: &str) -> Option<Option<PathBuf>> {
        self.rooms
            .lock()
            .await
            .get(id)
            .map(|s| s.bearer_dir.clone())
    }

    pub(crate) async fn room_note_head(&self, id: &str, head_sha: Option<String>) -> bool {
        match self.rooms.lock().await.get_mut(id) {
            Some(s) => {
                s.head_sha = head_sha;
                true
            }
            None => false,
        }
    }

    pub(crate) async fn holds_room(&self, id: &str) -> bool {
        self.rooms.lock().await.contains_key(id)
    }

    /// A message written into a room's running turn, or refused where none runs: a resident
    /// support session takes input only in a turn core started.
    pub(crate) async fn room_inject(
        &self,
        id: &str,
        message: &str,
        pending: (String, u64),
    ) -> Result<()> {
        let turn_tx = {
            let map = self.rooms.lock().await;
            let s = map
                .get(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            if !s.in_turn {
                return Err(Error::Other(
                    "the session has no turn in flight, and a resident support session takes input \
                     only in a turn core started"
                        .into(),
                ));
            }
            s.turn_tx.clone()
        };
        let tx = turn_tx.lock().await.clone();
        self.room_send(id, message, tx, Some(pending)).await
    }

    /// Send `message` to the room's session: into the running turn (`now`), or as the next turn.
    /// Delivered only on its receipt; one refused leaves no turn started and no write applied.
    pub(crate) async fn room_send(
        &self,
        id: &str,
        message: &str,
        tx: mpsc::Sender<RunnerEvent>,
        pending: Option<(String, u64)>,
    ) -> Result<()> {
        let (host, joined, sid) = {
            let mut map = self.rooms.lock().await;
            let s = map
                .get_mut(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            let joined = s.in_turn;
            s.in_turn = true;
            *s.turn_tx.lock().await = tx.clone();
            (s.host.clone(), joined, s.claude_session_id.clone())
        };
        let priority = if joined {
            Priority::Now
        } else {
            Priority::Next
        };
        let sent = match &host {
            Some(h) => h
                .send(&sid, message, priority)
                .await
                .map(drop)
                .map_err(|e| e.to_string()),
            None => Err("the session has no room".to_string()),
        };
        let mut map = self.rooms.lock().await;
        let Some(s) = map.get_mut(id) else {
            return Err(Error::Other("session not found".into()));
        };
        if let Err(why) = sent {
            s.in_turn = joined;
            return Err(Error::Other(format!("[CHAT_ROOM_NOT_DELIVERED] {why}")));
        }
        s.pending_inbox.extend(pending);
        drop(map);
        let _ = tx.send(RunnerEvent::ClaudeSessionId(sid)).await;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        Ok(())
    }

    /// End the room holding `id`, if one does: its turn, if one runs, fails naming why.
    pub(crate) async fn close_room(&self, id: &str, why: &str) -> bool {
        let Some(s) = self.rooms.lock().await.remove(id) else {
            return false;
        };
        end_room(id, s, why).await;
        true
    }

    /// End every room: their network ends with this daemon.
    pub(crate) async fn close_all_rooms(&self) -> Vec<SessionId> {
        let all: Vec<(String, RoomSession)> = self.rooms.lock().await.drain().collect();
        let mut ids = Vec::new();
        for (id, s) in all {
            end_room(
                &id,
                s,
                "the runner is stopping, and the room's network stops with it",
            )
            .await;
            ids.push(id);
        }
        ids
    }
}

/// The room's settings, at the one path a flagless resume re-reads them from, allowing the MCP
/// servers the config at `mcp_path` names.
fn write_settings(
    dirs: &RoomDirs,
    events: &std::path::Path,
    mcp_path: &std::path::Path,
) -> Result<()> {
    let failed = |e: String| Error::Other(format!("[CHAT_ROOM_SETTINGS] {e}"));
    if let Some(dir) = events.parent() {
        std::fs::create_dir_all(dir).map_err(|e| failed(format!("{}: {e}", dir.display())))?;
    }
    std::fs::write(events, b"").map_err(|e| failed(format!("{}: {e}", events.display())))?;
    let runner_exe =
        std::env::current_exe().map_err(|e| failed(format!("this runner's binary: {e}")))?;
    let servers = room_launch::mcp_servers_in(mcp_path);
    let doc = room_launch::settings(&runner_exe, events, &servers);
    bg_session::launch::write_settings(&dirs.settings, &doc).map_err(failed)
}

/// Start or wake the session in the opened room, and hand in its first turn.
async fn begin(
    spec: &JobSpec,
    opened: &Opened,
    (name, prompt): (&str, &str),
    dirs: &RoomDirs,
    events: PathBuf,
) -> Result<Begun> {
    let host = &opened.host;
    let session = match spec.resume_id.as_deref().filter(|s| !s.is_empty()) {
        Some(r) => SessionStart::Resume(r.to_string()),
        None => SessionStart::New,
    };
    let launch = BgLaunch {
        name: name.to_string(),
        cwd: spec.repo_path.clone(),
        settings: dirs.settings.clone(),
        permission_mode: room_launch::PERMISSION_MODE.into(),
        model: spec.model.clone(),
        mcp_config: Some(opened.mcp_path.clone()),
        strict_mcp: true,
        append_system_prompt: spec.system_prompt.clone(),
        prompt: launch_prompt(&session, prompt).map(str::to_string),
        ..BgLaunch::default()
    };
    let started = match &session {
        SessionStart::New => host.start(&launch).await,
        SessionStart::Resume(sid) => wake(host, dirs, launch, sid).await,
    }
    .map_err(Error::Other)?;
    let sid = started.session_id.clone();
    let transcript = dirs.transcript(&spec.repo_path, &sid);
    // a resumed session's transcript already holds its history, which core has
    let from = std::fs::metadata(&transcript).map_or(0, |m| m.len());
    let cost_base = first_turn(host, &sid, (&session, prompt), &events).await?;
    Ok(Begun {
        bg_id: started.id,
        sid,
        events,
        transcript,
        from,
        cost_base,
    })
}

/// Continue the conversation `sid` in the room: a background session of the room is woken with
/// its saved options; one that is not yet (a headless session's, whose transcript is the box's)
/// is brought into the room and continued under its own id.
async fn wake(
    host: &Host,
    dirs: &RoomDirs,
    mut launch: BgLaunch,
    sid: &str,
) -> std::result::Result<bg_session::Started, String> {
    let roster = host.roster().await.map_err(|e| e.to_string())?;
    if roster
        .iter()
        .any(|s| s.session_id == sid && s.is_background())
    {
        return host.resume(sid, &launch.name, &launch.cwd).await;
    }
    let ours = dirs.transcript(&launch.cwd, sid);
    if !ours.is_file() {
        let theirs = bg_session::claude_dir()
            .map(|d| {
                d.join("projects")
                    .join(runner_core::claude_paths::project_dir_name(&launch.cwd))
                    .join(format!("{sid}.jsonl"))
            })
            .filter(|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "[CHAT_ROOM_RESUME_UNKNOWN] no transcript of conversation {sid} is in the room \
                     or on this box, so it cannot be continued"
                )
            })?;
        if let Some(dir) = ours.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        std::fs::copy(&theirs, &ours).map_err(|e| format!("{}: {e}", ours.display()))?;
    }
    launch.resume = Some(sid.to_string());
    let mut started = host.start(&launch).await?;
    started.session_id = sid.to_string();
    Ok(started)
}

async fn end_room(id: &str, s: RoomSession, why: &str) {
    if let Some(w) = &s.watcher {
        w.abort();
    }
    if s.in_turn {
        let tx = s.turn_tx.lock().await.clone();
        let _ = tx
            .send(RunnerEvent::Failed {
                error: format!("[CHAT_ROOM_CLOSED] {} ended mid-turn: {why}", s.name),
            })
            .await;
    }
    if let Some(host) = &s.host {
        // stopped, its conversation is kept in the room for a later session to wake
        if let Err(e) = host.stop(&s.bg_id).await {
            tracing::warn!("[chat {id}] {} could not be stopped: {e}", s.name);
        }
        host.forget();
    }
    remove_made(id, &s.mcp_path, s.bearer_dir.as_deref());
    let _ = std::fs::write(&s.events, b"");
    with_facts(|f| {
        f.rooms.remove(id);
    });
    tracing::info!("[chat {id}] {} closed: {why}", s.name);
}

/// The task that reads one room's session while it lives, and closes each of its turns.
struct Watch {
    rooms: Rooms,
    id: String,
    sid: String,
    /// The room it runs in; a test's turn has none, and is never asked after.
    host: Option<Host>,
    events: PathBuf,
    transcript: PathBuf,
    transcript_from: u64,
    cost_base: Option<f64>,
    core: runner_transport::CoreClient,
}

/// Where a [`Watch`] is in its session's events and transcript, and the turn it is closing.
#[derive(Default)]
struct Reading {
    events_at: u64,
    transcript_at: u64,
    tally: Tally,
    cost_base: Option<f64>,
    stop_at: Option<i64>,
    cost_after: Option<f64>,
    reads: u32,
    missed: u32,
    held: bool,
}

impl Watch {
    async fn run(self) {
        let mut r = Reading {
            transcript_at: self.transcript_from,
            cost_base: self.cost_base,
            ..Reading::default()
        };
        loop {
            tokio::time::sleep(READ_EVERY).await;
            r.reads = r.reads.wrapping_add(1);
            if r.reads.is_multiple_of(ALIVE_EVERY) {
                if let Some(why) = self.gone(&mut r.missed) {
                    if let Some(s) = self.rooms.lock().await.remove(&self.id) {
                        end_room(&self.id, s, why).await;
                    }
                    return;
                }
            }
            let Some((in_turn, tx)) = self.state().await else {
                return;
            };
            self.read_events(&mut r, in_turn);
            self.read_transcript(&mut r, &tx).await;
            let Some(at) = r.stop_at else { continue };
            if !in_turn {
                // a Stop with no turn core handed in flight closes nothing core is waiting on
                r.stop_at = None;
                r.tally.next_turn();
                continue;
            }
            if self.held_open(&r.tally, &mut r.held) {
                continue;
            }
            if r.cost_after.is_none()
                && runner_core::agent_activity::now_ms() < at + COST_AFTER_STOP_MS
            {
                continue;
            }
            self.close_turn(&mut r, &tx).await;
        }
    }

    /// Why the session is gone, if it is: its sandbox ended, or no process of the room has run it
    /// for [`GONE_AFTER`] asks in a row.
    fn gone(&self, missed: &mut u32) -> Option<&'static str> {
        let host = self.host.as_ref()?;
        if !host.alive() {
            return Some("its room's sandbox is gone");
        }
        if host.live(&self.sid) {
            *missed = 0;
            return None;
        }
        *missed += 1;
        (*missed >= GONE_AFTER).then_some("its session no longer runs in its room")
    }

    fn read_events(&self, r: &mut Reading, in_turn: bool) {
        match chat_pane_events::read_from(&self.events, r.events_at) {
            Ok((lines, next)) => {
                r.events_at = next;
                for line in lines {
                    if line.event == STATUS_LINE {
                        if let Some(c) = status_cost(&line.payload) {
                            if r.stop_at.is_some_and(|at| line.at_ms >= at) {
                                r.cost_after.get_or_insert(c);
                            } else if !in_turn {
                                r.cost_base = Some(c);
                            }
                        }
                    } else if line.event == "UserPromptSubmit" && self.ours(&line.payload) {
                        // a message taken: the session works again, and its next Stop, not the
                        // one before, ends the turn
                        r.stop_at = None;
                        r.held = false;
                    } else if line.event == "Stop" && self.ours(&line.payload) {
                        r.stop_at = Some(line.at_ms);
                        r.cost_after = None;
                    }
                }
            }
            Err(e) => tracing::warn!("[chat {}] {}: {e}", self.id, self.events.display()),
        }
    }

    async fn read_transcript(&self, r: &mut Reading, tx: &mpsc::Sender<RunnerEvent>) {
        if let Ok((raw, next)) =
            chat_pane_events::whole_lines_from(&self.transcript, r.transcript_at)
        {
            r.transcript_at = next;
            for text in raw {
                let Ok(line) = serde_json::from_str::<Value>(&text) else {
                    continue;
                };
                if let Some(kept) = r.tally.read(&line) {
                    let _ = tx.send(RunnerEvent::Stdout(kept)).await;
                }
            }
        }
    }

    async fn close_turn(&self, r: &mut Reading, tx: &mpsc::Sender<RunnerEvent>) {
        let cost = turn_cost(r.cost_base, r.cost_after);
        let _ = tx
            .send(RunnerEvent::Stdout(r.tally.result_line(&self.sid, &cost)))
            .await;
        let verdict = match r.tally.usage_limit() {
            Some(msg) => RunnerEvent::Failed {
                error: format!("[USAGE_LIMIT] {msg}"),
            },
            None => RunnerEvent::Done,
        };
        self.end_turn(verdict, tx).await;
        r.cost_base = r.cost_after;
        r.tally.next_turn();
        r.stop_at = None;
        r.cost_after = None;
    }

    async fn state(&self) -> Option<(bool, mpsc::Sender<RunnerEvent>)> {
        let (in_turn, turn_tx) = {
            let map = self.rooms.lock().await;
            let s = map.get(&self.id)?;
            if s.claude_session_id != self.sid {
                return None;
            }
            (s.in_turn, s.turn_tx.clone())
        };
        let tx = turn_tx.lock().await.clone();
        Some((in_turn, tx))
    }

    fn ours(&self, payload: &Value) -> bool {
        payload
            .get("session_id")
            .and_then(Value::as_str)
            .is_none_or(|s| s == self.sid)
    }

    /// Whether a Stop is held open by a message the session queued and has not taken, said once.
    fn held_open(&self, tally: &Tally, held: &mut bool) -> bool {
        let open = tally.queued() > 0;
        if open && !*held {
            tracing::info!(
                "[chat {}] a Stop with a message still queued — the turn goes on",
                self.id
            );
        }
        *held = open;
        open
    }

    /// The turn's verdict, after every inbox write it took is reported applied.
    async fn end_turn(&self, verdict: RunnerEvent, tx: &mpsc::Sender<RunnerEvent>) {
        let consumed = {
            let mut map = self.rooms.lock().await;
            map.get_mut(&self.id).map(|s| {
                s.turns += 1;
                s.in_turn = false;
                let turn = s.turns;
                std::mem::take(&mut s.pending_inbox)
                    .into_iter()
                    .map(|(sid, seq)| (sid, seq, turn))
                    .collect::<Vec<_>>()
            })
        };
        for (sid, seq, turn) in consumed.unwrap_or_default() {
            runner_transport::inbox::applied(&self.core, &sid, seq, turn).await;
        }
        let _ = tx.send(RunnerEvent::StateChanged("awaiting_input")).await;
        let _ = tx.send(verdict).await;
    }
}

/// Whether a turn of this chat session runs in a room on this box, and which project's, or why
/// not. `None` where room agents are off or the turn is not a channel agent's resident one: it
/// runs headless as it always has.
pub fn room_for(
    rooms_on: bool,
    keep_resident: bool,
    confined: bool,
    hooks_off: bool,
    slug: Option<&str>,
) -> Option<std::result::Result<String, String>> {
    if !rooms_on || !keep_resident || !confined {
        return None;
    }
    if hooks_off {
        return Some(Err(
            "[CHAT_ROOM_HOOKS_OFF] this session runs with every hook off, and a room agent's turn ends on its Stop hook"
                .into(),
        ));
    }
    let Some(slug) = slug.filter(|s| !s.is_empty()) else {
        return Some(Err(
            "[CHAT_ROOM_NO_PROJECT] the turn names no project, so its room has no name".into(),
        ));
    };
    Some(Ok(slug.to_string()))
}

/// A room turn with no room: session `id` in a turn whose lines go to `tx`, its session `sid`
/// writing `events` and `transcript`, read as a live room's are. For the tests of what closes it.
#[cfg(test)]
pub(crate) async fn test_turn(
    runner: &ClaudeCodeRunner,
    id: &str,
    sid: &str,
    events: PathBuf,
    transcript: PathBuf,
    tx: mpsc::Sender<RunnerEvent>,
) {
    test_turn_from(runner, id, sid, (events, transcript), Some(0.0), tx).await;
}

/// [`test_turn`] measured from `cost_base`, the running cost read before the turn.
#[cfg(test)]
async fn test_turn_from(
    runner: &ClaudeCodeRunner,
    id: &str,
    sid: &str,
    (events, transcript): (PathBuf, PathBuf),
    cost_base: Option<f64>,
    tx: mpsc::Sender<RunnerEvent>,
) {
    let core = runner_transport::CoreClient::new(runner.core_url.clone(), "t");
    let _ = tx.send(RunnerEvent::ClaudeSessionId(sid.into())).await;
    let watch = Watch {
        rooms: runner.rooms.clone(),
        id: id.into(),
        sid: sid.into(),
        host: None,
        events: events.clone(),
        transcript,
        transcript_from: 0,
        cost_base,
        core,
    };
    let mut map = runner.rooms.lock().await;
    map.insert(
        id.into(),
        RoomSession {
            host: None,
            name: format!("forge-chat-{id}"),
            bg_id: String::new(),
            claude_session_id: sid.into(),
            turn_tx: Arc::new(Mutex::new(tx)),
            in_turn: true,
            pending_inbox: Vec::new(),
            turns: 0,
            bearer_dir: None,
            mcp_path: PathBuf::from("/nonexistent/mcp.json"),
            events,
            model: None,
            head_sha: None,
            checkout: crate::CheckoutView::default(),
            siblings: Vec::new(),
            repo_path: PathBuf::new(),
            watcher: Some(tokio::spawn(watch.run())),
            _sandbox: None,
            _egress: None,
        },
    );
}

#[cfg(test)]
#[path = "room_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "room_live_tests.rs"]
mod room_live_tests;
