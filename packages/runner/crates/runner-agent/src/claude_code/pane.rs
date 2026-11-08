//! A channel agent's resident session in a tmux pane its owner attaches to (ISS-946).
//!
//! The headless chat host runs the resident as a `stream-json` child; here the same confined
//! command runs interactive in `forge-chat-<slug>` on this box's tmux socket, and every turn still
//! reaches it through the box and closes through the same write:
//! - a turn is typed in (`terminal::send_line`), the first as the session's launch prompt;
//! - its lines come from the session's transcript, tailed, and go to the turn's sink as the
//!   stream's did, so `chat.rs:consume` posts them and beats the turn unchanged;
//! - its end is the `Stop` hook (`pane_turn`), after which the turn's `result` line is made and
//!   `Done` sent, so `chat.rs:close_turn` writes what it writes for a headless turn;
//! - a message written into a running turn is typed while it runs, and the turn ends only once the
//!   session has taken it.

use std::path::PathBuf;

use super::pane_turn::{status_cost, turn_cost, Tally, COST_AFTER_STOP_MS};
use super::*;
use crate::pane_launch::{self, PaneArgs, SessionStart};
use runner_core::chat_pane_events::{self, STATUS_LINE};
use runner_workspace::terminal::{self, ChatPane};

pub(crate) type Panes = Arc<Mutex<HashMap<String, PaneSession>>>;

/// How often the pane's events and transcript are read while it lives.
const READ_EVERY: Duration = Duration::from_millis(200);

/// Every how many reads the pane is asked whether it is still there.
const ALIVE_EVERY: u32 = 10;

pub(crate) struct PaneSession {
    pane: ChatPane,
    claude_session_id: String,
    turn_tx: TurnTx,
    in_turn: bool,
    /// Messages typed into the running turn that the session has not yet said it took.
    unsubmitted: Vec<String>,
    pending_inbox: Vec<(String, u64)>,
    turns: u64,
    bearer_dir: Option<PathBuf>,
    mcp_path: PathBuf,
    events_dir: PathBuf,
    model: Option<String>,
    head_sha: Option<String>,
    checkout: crate::CheckoutView,
    siblings: Vec<PathBuf>,
    repo_path: PathBuf,
    watcher: Option<tokio::task::JoinHandle<()>>,
    /// The confined session's network, for as long as the pane lives.
    _egress: Option<EgressGuard>,
}

/// What this box says about its chat panes on its heartbeat (`capabilities.chatPanes`): the socket
/// and each live pane by the session it serves, or why panes are on and none can be made.
#[derive(Default)]
struct Facts {
    socket: Option<PathBuf>,
    panes: std::collections::BTreeMap<String, String>,
    unavailable: Option<String>,
}

static FACTS: std::sync::Mutex<Option<Facts>> = std::sync::Mutex::new(None);

fn with_facts(f: impl FnOnce(&mut Facts)) {
    if let Ok(mut g) = FACTS.lock() {
        f(g.get_or_insert_with(Facts::default));
    }
}

/// The heartbeat's `chatPanes`: `None` where this box runs no chat panes.
pub fn chat_pane_facts() -> Option<serde_json::Value> {
    let on = runner_platform::config::Config::load().is_ok_and(|c| c.runner.chat_panes);
    if !on {
        return None;
    }
    let g = FACTS.lock().ok()?;
    let facts = g.as_ref();
    let mut out = serde_json::json!({
        "sessions": facts.map(|f| f.panes.clone()).unwrap_or_default(),
    });
    let socket = facts
        .and_then(|f| f.socket.clone())
        .or_else(|| terminal::chat_pane("x").ok().map(|p| p.socket));
    if let Some(socket) = socket {
        out["socket"] = socket.to_string_lossy().into_owned().into();
    }
    if let Some(why) = facts.and_then(|f| f.unavailable.clone()) {
        out["unavailable"] = why.into();
    }
    Some(out)
}

/// Record why a turn that would have run in a pane runs headless, for the log and the heartbeat.
pub fn pane_refused(session: &str, why: &str) {
    tracing::warn!("[chat {session}] runs headless: {why}");
    with_facts(|f| f.unavailable = Some(why.to_string()));
}

impl ClaudeCodeRunner {
    /// Start `spec`'s session in `pane`: its first turn is the launch prompt.
    pub async fn start_in_pane(
        &self,
        spec: JobSpec,
        pane: ChatPane,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()> {
        let id = spec.job_id.clone();
        if spec.confinement.is_none() {
            return Err(Error::Other(
                "[CHAT_PANE_UNCONFINED] a chat pane runs only a confined session".into(),
            ));
        }
        let prompt = spec
            .prompt
            .clone()
            .ok_or_else(|| Error::Other("job has no prompt".into()))?;
        let credential = session_credential(&spec)?;
        self.retire(&id).await?;
        if let Some(holder) = self.pane_holder(&pane.name).await {
            return Err(Error::Other(format!(
                "[CHAT_PANE_HELD] {} already serves session {holder} on this box",
                pane.name
            )));
        }
        // a pane by this name that no session here holds outlived the daemon that made it, and its
        // network with it
        if terminal::alive(&pane.name).await {
            tracing::info!("[chat {id}] {} is left from before — ending it", pane.name);
            terminal::kill(&pane.name).await?;
        }
        let claude_dir = pane_launch::claude_dir().ok_or_else(|| {
            Error::Other("[CHAT_PANE_NO_HOME] no Claude Code config directory can be named".into())
        })?;
        let events_dir = pane_launch::events_dir(&claude_dir, &pane.name);
        std::fs::create_dir_all(&events_dir)
            .map_err(|e| Error::Other(format!("[CHAT_PANE_EVENTS] {}: {e}", events_dir.display())))?;
        let events = events_dir.join("events.jsonl");
        let _ = std::fs::write(&events, b"");
        let runner_exe = std::env::current_exe()
            .map_err(|e| Error::Other(format!("[CHAT_PANE_NO_RUNNER] this runner's binary: {e}")))?;
        let session = match spec.resume_id.as_deref().filter(|s| !s.is_empty()) {
            Some(r) => SessionStart::Resume(r.to_string()),
            None => SessionStart::New(uuid::Uuid::new_v4().to_string()),
        };
        let (mcp_path, bearer_dir) = mcp_config_for(&self.core_url, &spec, &credential)?;
        let settings = pane_launch::settings(
            &runner_exe,
            &events,
            &pane_launch::mcp_servers_in(&mcp_path),
        );
        let args = PaneArgs {
            settings: &settings,
            system_prompt: spec.system_prompt.as_deref(),
            model: spec.model.as_deref(),
            mcp_config: &mcp_path,
            session: &session,
            first_turn: &prompt,
        }
        .argv();
        let repo = spec.repo_path.to_string_lossy().into_owned();
        let made = SessionCommand {
            spec: &spec,
            program: std::ffi::OsStr::new(resolve_claude_bin()),
            args: &args,
            repo: &repo,
            credential: &credential,
            mcp_path: &mcp_path,
            bearer_dir: bearer_dir.as_deref(),
            core_url: &self.core_url,
        }
        .build(None)
        .await;
        let (cmd, egress) = match made {
            Ok(made) => made,
            Err(e) => {
                let _ = std::fs::remove_file(&mcp_path);
                return Err(e);
            }
        };
        let launch_path = launch_path(&pane.name)?;
        pane_launch::write(&launch_path, &pane_launch::Launch::of(cmd.as_std(), &spec.repo_path))
            .map_err(|e| Error::Other(format!("[CHAT_PANE_LAUNCH] {}: {e}", launch_path.display())))?;
        runner_workspace::trust::pre_trust_logged(&spec.repo_path, &pane.name);
        let transcript = claude_dir
            .join("projects")
            .join(runner_core::claude_paths::project_dir_name(&spec.repo_path))
            .join(format!("{}.jsonl", session.id()));
        // a resumed session's transcript already holds its history, which core has
        let from = std::fs::metadata(&transcript).map_or(0, |m| m.len());
        let argv = vec![
            runner_exe.to_string_lossy().into_owned(),
            "chat-pane-exec".to_string(),
            launch_path.to_string_lossy().into_owned(),
        ];
        if let Err(e) = terminal::ensure(&pane.name, &spec.repo_path, &argv, &[], None).await {
            let _ = std::fs::remove_file(&launch_path);
            let _ = std::fs::remove_file(&mcp_path);
            return Err(e);
        }
        tracing::info!("[chat {id}] started in {} ({})", pane.name, pane.attach_command());
        let sid = session.id().to_string();
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx.clone()));
        let _ = tx.send(RunnerEvent::ClaudeSessionId(sid.clone())).await;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        with_facts(|f| {
            f.socket = Some(pane.socket.clone());
            f.panes.insert(id.clone(), pane.name.clone());
            f.unavailable = None;
        });
        let watch = Watch {
            panes: self.panes.clone(),
            id: id.clone(),
            sid: sid.clone(),
            pane: pane.name.clone(),
            events,
            transcript,
            transcript_from: from,
            // a new session has spent nothing; a resumed one's running cost is read from its first
            // status line between turns
            cost_base: matches!(session, SessionStart::New(_)).then_some(0.0),
            core: runner_transport::CoreClient::new(
                self.core_url.clone(),
                self.device_token.clone(),
            ),
            check_alive: true,
        };
        let checkout = spec
            .confinement
            .as_ref()
            .map(|c| c.checkout.clone())
            .unwrap_or_default();
        let siblings = spec
            .confinement
            .as_ref()
            .map(|c| c.siblings.clone())
            .unwrap_or_default();
        let mut map = self.panes.lock().await;
        map.insert(
            id.clone(),
            PaneSession {
                pane,
                claude_session_id: sid,
                turn_tx,
                in_turn: true,
                unsubmitted: Vec::new(),
                pending_inbox: Vec::new(),
                turns: 0,
                bearer_dir,
                mcp_path,
                events_dir,
                model: spec.model.clone(),
                head_sha: None,
                checkout,
                siblings,
                repo_path: spec.repo_path.clone(),
                watcher: None,
                _egress: egress,
            },
        );
        if let Some(s) = map.get_mut(&id) {
            s.watcher = Some(tokio::spawn(watch.run()));
        }
        Ok(())
    }

    async fn pane_holder(&self, name: &str) -> Option<String> {
        let map = self.panes.lock().await;
        map.iter()
            .find(|(_, s)| s.pane.name == name)
            .map(|(id, _)| id.clone())
    }

    pub(crate) async fn pane_resident(&self, id: &str) -> Option<Resident> {
        let map = self.panes.lock().await;
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

    pub(crate) async fn pane_bearer_dir(&self, id: &str) -> Option<Option<PathBuf>> {
        self.panes
            .lock()
            .await
            .get(id)
            .map(|s| s.bearer_dir.clone())
    }

    pub(crate) async fn pane_note_head(&self, id: &str, head_sha: Option<String>) -> bool {
        match self.panes.lock().await.get_mut(id) {
            Some(s) => {
                s.head_sha = head_sha;
                true
            }
            None => false,
        }
    }

    pub(crate) async fn holds_pane(&self, id: &str) -> bool {
        self.panes.lock().await.contains_key(id)
    }

    /// A message written into a pane's running turn, or refused where none runs: a resident
    /// support session takes input only in a turn core started.
    pub(crate) async fn pane_inject(
        &self,
        id: &str,
        message: &str,
        pending: (String, u64),
    ) -> Result<()> {
        let turn_tx = {
            let map = self.panes.lock().await;
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
        self.pane_send(id, message, tx, Some(pending)).await
    }

    /// Type `message` into the pane: into the running turn, or as the next turn.
    pub(crate) async fn pane_send(
        &self,
        id: &str,
        message: &str,
        tx: mpsc::Sender<RunnerEvent>,
        pending: Option<(String, u64)>,
    ) -> Result<()> {
        let (name, joined, sid) = {
            let mut map = self.panes.lock().await;
            let s = map
                .get_mut(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            let joined = s.in_turn;
            if joined {
                s.unsubmitted.push(message.to_string());
            } else {
                s.in_turn = true;
            }
            *s.turn_tx.lock().await = tx.clone();
            (s.pane.name.clone(), joined, s.claude_session_id.clone())
        };
        if let Err(why) = terminal::send_line(&name, message).await {
            let mut map = self.panes.lock().await;
            if let Some(s) = map.get_mut(id) {
                if joined {
                    if let Some(i) = s.unsubmitted.iter().rposition(|m| m == message) {
                        s.unsubmitted.remove(i);
                    }
                } else {
                    s.in_turn = false;
                }
            }
            return Err(Error::Other(format!("[CHAT_PANE_NOT_TYPED] {why}")));
        }
        if let Some(p) = pending {
            if let Some(s) = self.panes.lock().await.get_mut(id) {
                s.pending_inbox.push(p);
            }
        }
        let _ = tx.send(RunnerEvent::ClaudeSessionId(sid)).await;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        Ok(())
    }

    /// End the pane holding `id`, if one does: its turn, if one runs, fails naming why.
    pub(crate) async fn close_pane(&self, id: &str, why: &str) -> bool {
        let Some(s) = self.panes.lock().await.remove(id) else {
            return false;
        };
        end_pane(id, s, why).await;
        true
    }

    /// End every pane: their network ends with this daemon.
    pub(crate) async fn close_all_panes(&self) -> Vec<SessionId> {
        let all: Vec<(String, PaneSession)> = self.panes.lock().await.drain().collect();
        let mut ids = Vec::new();
        for (id, s) in all {
            end_pane(&id, s, "the runner is stopping, and the pane's network stops with it").await;
            ids.push(id);
        }
        ids
    }
}

async fn end_pane(id: &str, s: PaneSession, why: &str) {
    if let Some(w) = &s.watcher {
        w.abort();
    }
    if s.in_turn {
        let tx = s.turn_tx.lock().await.clone();
        let _ = tx
            .send(RunnerEvent::Failed {
                error: format!("[CHAT_PANE_CLOSED] {} ended mid-turn: {why}", s.pane.name),
            })
            .await;
    }
    if let Err(e) = terminal::kill(&s.pane.name).await {
        tracing::error!("[chat {id}] {}: {e}", s.pane.name);
    }
    let _ = std::fs::remove_file(&s.mcp_path);
    if let Some(dir) = &s.bearer_dir {
        let _ = std::fs::remove_dir_all(dir);
    }
    let _ = std::fs::remove_dir_all(&s.events_dir);
    with_facts(|f| {
        f.panes.remove(id);
    });
    tracing::info!("[chat {id}] {} closed: {why}", s.pane.name);
}

/// Where the launch of the pane `name` is written: this runner's own directory, which no session
/// sees, readable by this user alone.
fn launch_path(name: &str) -> Result<PathBuf> {
    let dir = runner_platform::config::base_dir()?.join("chat-panes");
    std::fs::create_dir_all(&dir)
        .map_err(|e| Error::Other(format!("[CHAT_PANE_LAUNCH] {}: {e}", dir.display())))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir.join(format!("{name}.launch.json")))
}

/// The task that reads one pane while it lives, and closes each of its turns.
struct Watch {
    panes: Panes,
    id: String,
    sid: String,
    pane: String,
    events: PathBuf,
    transcript: PathBuf,
    transcript_from: u64,
    cost_base: Option<f64>,
    core: runner_transport::CoreClient,
    /// Whether the pane is asked after on this box's tmux; a test's turn has no pane.
    check_alive: bool,
}

impl Watch {
    async fn run(self) {
        let mut events_at = 0u64;
        let mut transcript_at = self.transcript_from;
        let mut tally = Tally::default();
        let mut cost_base = self.cost_base;
        let mut stop_at: Option<i64> = None;
        let mut cost_after: Option<f64> = None;
        let mut reads = 0u32;
        loop {
            tokio::time::sleep(READ_EVERY).await;
            reads = reads.wrapping_add(1);
            if self.check_alive && reads % ALIVE_EVERY == 0 && !terminal::alive(&self.pane).await {
                let gone = self.panes.lock().await.remove(&self.id);
                if let Some(s) = gone {
                    end_pane(&self.id, s, "its pane is gone").await;
                }
                return;
            }
            let Some((in_turn, tx)) = self.state().await else {
                return;
            };
            match chat_pane_events::read_from(&self.events, events_at) {
                Ok((lines, next)) => {
                    events_at = next;
                    for line in lines {
                        if line.event == STATUS_LINE {
                            if let Some(c) = status_cost(&line.payload) {
                                if stop_at.is_some_and(|at| line.at_ms >= at) {
                                    cost_after.get_or_insert(c);
                                } else if !in_turn {
                                    cost_base = Some(c);
                                }
                            }
                        } else if line.event == "UserPromptSubmit" {
                            self.submitted(&line.payload).await;
                        } else if line.event == "Stop" && self.ours(&line.payload) {
                            stop_at = Some(line.at_ms);
                            cost_after = None;
                        }
                    }
                }
                Err(e) => tracing::warn!("[chat {}] {}: {e}", self.id, self.events.display()),
            }
            if let Ok((raw, next)) =
                chat_pane_events::whole_lines_from(&self.transcript, transcript_at)
            {
                transcript_at = next;
                for text in raw {
                    let Ok(line) = serde_json::from_str::<Value>(&text) else {
                        continue;
                    };
                    if let Some(kept) = tally.read(&line) {
                        let _ = tx.send(RunnerEvent::Stdout(kept)).await;
                    }
                }
            }
            let Some(at) = stop_at else { continue };
            if tally.queued() > 0 || self.unsubmitted().await > 0 {
                tracing::info!(
                    "[chat {}] a Stop with a message typed into the turn not yet taken — the turn goes on",
                    self.id
                );
                stop_at = None;
                continue;
            }
            if cost_after.is_none()
                && runner_core::agent_activity::now_ms() < at + COST_AFTER_STOP_MS
            {
                continue;
            }
            let cost = turn_cost(cost_base, cost_after);
            let _ = tx
                .send(RunnerEvent::Stdout(tally.result_line(&self.sid, &cost)))
                .await;
            let verdict = match tally.usage_limit() {
                Some(msg) => RunnerEvent::Failed {
                    error: format!("[USAGE_LIMIT] {msg}"),
                },
                None => RunnerEvent::Done,
            };
            self.end_turn(verdict, &tx).await;
            cost_base = cost_after;
            tally.next_turn();
            stop_at = None;
            cost_after = None;
        }
    }

    async fn state(&self) -> Option<(bool, mpsc::Sender<RunnerEvent>)> {
        let (in_turn, turn_tx) = {
            let map = self.panes.lock().await;
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

    async fn submitted(&self, payload: &Value) {
        let Some(prompt) = payload.get("prompt").and_then(Value::as_str) else {
            return;
        };
        if let Some(s) = self.panes.lock().await.get_mut(&self.id) {
            if let Some(i) = s.unsubmitted.iter().position(|m| m == prompt) {
                s.unsubmitted.remove(i);
            }
        }
    }

    async fn unsubmitted(&self) -> usize {
        self.panes
            .lock()
            .await
            .get(&self.id)
            .map_or(0, |s| s.unsubmitted.len())
    }

    /// The turn's verdict, after every inbox write it took is reported applied.
    async fn end_turn(&self, verdict: RunnerEvent, tx: &mpsc::Sender<RunnerEvent>) {
        let consumed = {
            let mut map = self.panes.lock().await;
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

/// Whether a turn of this chat session runs in a pane on this box, and which, or why not. `None`
/// where pane mode is off or the turn is not a channel agent's resident one: it runs headless as
/// it always has.
pub fn pane_for(
    chat_panes_on: bool,
    keep_resident: bool,
    confined: bool,
    hooks_off: bool,
    slug: Option<&str>,
) -> Option<std::result::Result<ChatPane, String>> {
    if !chat_panes_on || !keep_resident || !confined {
        return None;
    }
    if hooks_off {
        return Some(Err(
            "[CHAT_PANE_HOOKS_OFF] this session runs with every hook off, and a pane's turn ends on its Stop hook"
                .into(),
        ));
    }
    let Some(slug) = slug.filter(|s| !s.is_empty()) else {
        return Some(Err(
            "[CHAT_PANE_NO_PROJECT] the turn names no project, so its pane has no name".into(),
        ));
    };
    Some(terminal::chat_pane(slug).map_err(|e| e.to_string()))
}

/// A pane turn with no pane: session `id` in a turn whose lines go to `tx`, its session `sid`
/// writing `events` and `transcript`, read as a live pane's are. For the tests of what closes it.
#[cfg(test)]
pub(crate) async fn test_turn(
    runner: &ClaudeCodeRunner,
    id: &str,
    sid: &str,
    events: PathBuf,
    transcript: PathBuf,
    tx: mpsc::Sender<RunnerEvent>,
) {
    let core = runner_transport::CoreClient::new(runner.core_url.clone(), "t");
    let _ = tx.send(RunnerEvent::ClaudeSessionId(sid.into())).await;
    let watch = Watch {
        panes: runner.panes.clone(),
        id: id.into(),
        sid: sid.into(),
        pane: format!("forge-chat-{id}"),
        events: events.clone(),
        transcript,
        transcript_from: 0,
        cost_base: Some(0.0),
        core,
        check_alive: false,
    };
    let mut map = runner.panes.lock().await;
    map.insert(
        id.into(),
        PaneSession {
            pane: ChatPane {
                name: format!("forge-chat-{id}"),
                socket: PathBuf::from("/nonexistent/tmux.sock"),
            },
            claude_session_id: sid.into(),
            turn_tx: Arc::new(Mutex::new(tx)),
            in_turn: true,
            unsubmitted: Vec::new(),
            pending_inbox: Vec::new(),
            turns: 0,
            bearer_dir: None,
            mcp_path: PathBuf::from("/nonexistent/mcp.json"),
            events_dir: events.parent().map(PathBuf::from).unwrap_or_default(),
            model: None,
            head_sha: None,
            checkout: crate::CheckoutView::default(),
            siblings: Vec::new(),
            repo_path: PathBuf::new(),
            watcher: Some(tokio::spawn(watch.run())),
            _egress: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_resident_confined_turn_on_a_box_that_turned_panes_on_takes_a_pane() {
        assert!(pane_for(false, true, true, false, Some("p")).is_none());
        assert!(pane_for(true, false, true, false, Some("p")).is_none());
        assert!(pane_for(true, true, false, false, Some("p")).is_none());
        let off = pane_for(true, true, true, true, Some("p")).unwrap().unwrap_err();
        assert!(off.starts_with("[CHAT_PANE_HOOKS_OFF]"), "{off}");
        let unnamed = pane_for(true, true, true, false, None).unwrap().unwrap_err();
        assert!(unnamed.starts_with("[CHAT_PANE_NO_PROJECT]"), "{unnamed}");
    }

    #[test]
    fn a_stop_for_another_session_is_not_this_pane_s() {
        let w = Watch {
            panes: Arc::default(),
            id: "a".into(),
            sid: "s1".into(),
            pane: "forge-chat-p".into(),
            events: PathBuf::new(),
            transcript: PathBuf::new(),
            transcript_from: 0,
            cost_base: None,
            core: runner_transport::CoreClient::new("http://127.0.0.1:9", "t"),
            check_alive: false,
        };
        assert!(w.ours(&serde_json::json!({"session_id":"s1"})));
        assert!(!w.ours(&serde_json::json!({"session_id":"s2"})));
    }
}
