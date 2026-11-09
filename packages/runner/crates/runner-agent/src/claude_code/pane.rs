//! A channel agent's resident session in a tmux pane its owner attaches to (ISS-946).
//!
//! The headless chat host runs the resident as a `stream-json` child; here the same confined
//! command runs interactive in `forge-chat-<slug>` on this box's tmux socket, and every turn still
//! reaches it through the box and closes through the same write:
//! - a turn is typed in (`terminal::send_line`), a new session's first as its launch prompt, and
//!   a resumed session's first once the status line it starts with has given the turn's baseline;
//! - its lines come from the session's transcript, tailed, and go to the turn's sink as the
//!   stream's did, so `chat.rs:consume` posts them and beats the turn unchanged;
//! - its end is the `Stop` hook (`pane_turn`), after which the turn's `result` line is made and
//!   `Done` sent, so `chat.rs:close_turn` writes what it writes for a headless turn;
//! - a message written into a running turn is typed while it runs, and the turn ends only once the
//!   session has taken it.

use std::path::PathBuf;

#[cfg(test)]
use super::pane_first_turn::first_turn_base;
use super::pane_first_turn::{first_turn, launch_prompt};
use super::pane_turn::{status_cost, turn_cost, Tally, COST_AFTER_STOP_MS};
use super::*;
use crate::pane_launch::{self, PaneArgs, SessionStart};
use runner_core::chat_pane_events::{self, STATUS_LINE};
use runner_workspace::terminal::{self, ChatPane};

pub(crate) type Panes = Arc<Mutex<HashMap<String, PaneSession>>>;

/// How often the pane's events and transcript are read while it lives.
pub(super) const READ_EVERY: Duration = Duration::from_millis(200);

/// Every how many reads the pane is asked whether it is still there.
const ALIVE_EVERY: u32 = 10;

/// How long a message typed into a running turn may go unreported by `UserPromptSubmit` before the
/// turn stops waiting for it. Measured on 2.1.319, the hook fires within half a second of the paste.
const UNSUBMITTED_WITHIN: Duration = Duration::from_secs(30);

/// Whether `reported`, a `UserPromptSubmit` prompt, is the message `typed`: the same text, its
/// whitespace aside.
fn same_prompt(typed: &str, reported: &str) -> bool {
    let words = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    words(typed) == words(reported)
}

pub(crate) struct PaneSession {
    pane: ChatPane,
    claude_session_id: String,
    turn_tx: TurnTx,
    in_turn: bool,
    /// Messages typed into the running turn that the session has not yet said it took, and when.
    unsubmitted: Vec<(String, std::time::Instant)>,
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

/// What a pane is started from, as [`ClaudeCodeRunner::start_in_pane`] made it.
struct Made {
    runner_exe: PathBuf,
    events: PathBuf,
    events_dir: PathBuf,
    session: SessionStart,
    mcp_path: PathBuf,
    bearer_dir: Option<PathBuf>,
    egress: Option<EgressGuard>,
    launch_path: PathBuf,
    transcript: PathBuf,
    from: u64,
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
        self.clear_for(&id, &pane).await?;
        let Made {
            runner_exe,
            events,
            events_dir,
            session,
            mcp_path,
            bearer_dir,
            egress,
            launch_path,
            transcript,
            from,
        } = self.made(&spec, &pane, &prompt, &credential).await?;
        let argv = vec![
            runner_exe.to_string_lossy().into_owned(),
            "chat-pane-exec".to_string(),
            launch_path.to_string_lossy().into_owned(),
        ];
        if let Err(e) = terminal::ensure(&pane.name, &spec.repo_path, &argv, &[], None).await {
            let _ = std::fs::remove_file(&launch_path);
            let _ = std::fs::remove_file(&mcp_path);
            let _ = std::fs::remove_dir_all(&events_dir);
            return Err(e);
        }
        tracing::info!(
            "[chat {id}] started in {} ({})",
            pane.name,
            pane.attach_command()
        );
        let made = (&*mcp_path, bearer_dir.as_deref(), &*events_dir);
        let cost_base = first_turn(&id, &pane.name, (&session, &prompt), &events, made).await?;
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
            cost_base,
            core: runner_transport::CoreClient::new(
                self.core_url.clone(),
                self.device_token.clone(),
            ),
            check_alive: true,
        };
        let confinement = spec.confinement.clone().unwrap_or_default();
        let (checkout, siblings) = (confinement.checkout, confinement.siblings);
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

    /// Everything the pane is started from: its events file, its session, its MCP config, the
    /// confined command written to its launch, and where its transcript will be.
    async fn made(
        &self,
        spec: &JobSpec,
        pane: &ChatPane,
        prompt: &str,
        credential: &str,
    ) -> Result<Made> {
        let claude_dir = pane_launch::claude_dir().ok_or_else(|| {
            Error::Other("[CHAT_PANE_NO_HOME] no Claude Code config directory can be named".into())
        })?;
        let events_dir = pane_launch::events_dir(&claude_dir, &pane.name);
        std::fs::create_dir_all(&events_dir).map_err(|e| {
            Error::Other(format!("[CHAT_PANE_EVENTS] {}: {e}", events_dir.display()))
        })?;
        let events = events_dir.join("events.jsonl");
        let _ = std::fs::write(&events, b"");
        let runner_exe = std::env::current_exe().map_err(|e| {
            Error::Other(format!("[CHAT_PANE_NO_RUNNER] this runner's binary: {e}"))
        })?;
        let session = match spec.resume_id.as_deref().filter(|s| !s.is_empty()) {
            Some(r) => SessionStart::Resume(r.to_string()),
            None => SessionStart::New(uuid::Uuid::new_v4().to_string()),
        };
        let (mcp_path, bearer_dir) = mcp_config_for(&self.core_url, spec, credential)?;
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
            first_turn: launch_prompt(&session, prompt),
        }
        .argv();
        let repo = spec.repo_path.to_string_lossy().into_owned();
        let made = SessionCommand {
            spec,
            program: std::ffi::OsStr::new(resolve_claude_bin()),
            args: &args,
            repo: &repo,
            credential,
            mcp_path: &mcp_path,
            bearer_dir: bearer_dir.as_deref(),
            core_url: &self.core_url,
        }
        .build(None)
        .await;
        let written = made.and_then(|(cmd, egress)| {
            let path = launch_path(&pane.name)?;
            pane_launch::write(
                &path,
                &pane_launch::Launch::of(cmd.as_std(), &spec.repo_path),
            )
            .map_err(|e| Error::Other(format!("[CHAT_PANE_LAUNCH] {}: {e}", path.display())))?;
            Ok((path, egress))
        });
        let (launch_path, egress) = match written {
            Ok(w) => w,
            Err(e) => {
                let _ = std::fs::remove_file(&mcp_path);
                if let Some(dir) = &bearer_dir {
                    let _ = std::fs::remove_dir_all(dir);
                }
                return Err(e);
            }
        };
        runner_workspace::trust::pre_trust_logged(&spec.repo_path, &pane.name);
        let transcript = claude_dir
            .join("projects")
            .join(runner_core::claude_paths::project_dir_name(&spec.repo_path))
            .join(format!("{}.jsonl", session.id()));
        // a resumed session's transcript already holds its history, which core has
        let from = std::fs::metadata(&transcript).map_or(0, |m| m.len());
        Ok(Made {
            runner_exe,
            events,
            events_dir,
            session,
            mcp_path,
            bearer_dir,
            egress,
            launch_path,
            transcript,
            from,
        })
    }

    /// The key and the pane name free for a session `id` starting in `pane`: whatever held the key
    /// is retired, a pane another session holds refuses, and a pane by the name that no session
    /// here holds, left by an earlier daemon with its network gone, is ended.
    async fn clear_for(&self, id: &str, pane: &ChatPane) -> Result<()> {
        self.retire(id).await?;
        if let Some(holder) = self.pane_holder(&pane.name).await {
            return Err(Error::Other(format!(
                "[CHAT_PANE_HELD] {} already serves session {holder} on this box",
                pane.name
            )));
        }
        if terminal::alive(&pane.name).await {
            tracing::info!("[chat {id}] {} is left from before — ending it", pane.name);
            terminal::kill(&pane.name).await?;
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
                s.unsubmitted
                    .push((message.to_string(), std::time::Instant::now()));
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
                    if let Some(i) = s.unsubmitted.iter().rposition(|(m, _)| m == message) {
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
            end_pane(
                &id,
                s,
                "the runner is stopping, and the pane's network stops with it",
            )
            .await;
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
            if self.check_alive
                && reads.is_multiple_of(ALIVE_EVERY)
                && !terminal::alive(&self.pane).await
            {
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
            if !in_turn {
                // a Stop with no turn core handed in flight closes nothing core is waiting on
                stop_at = None;
                tally.next_turn();
                continue;
            }
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
            if let Some(i) = s
                .unsubmitted
                .iter()
                .position(|(m, _)| same_prompt(m, prompt))
            {
                s.unsubmitted.remove(i);
            }
        }
    }

    /// Messages typed into the turn the session has not said it took. One it has not named within
    /// [`UNSUBMITTED_WITHIN`] is let go, said in the log: a prompt Claude Code reported in another
    /// form than it was typed must not hold the turn open for ever.
    async fn unsubmitted(&self) -> usize {
        let mut map = self.panes.lock().await;
        let Some(s) = map.get_mut(&self.id) else {
            return 0;
        };
        s.unsubmitted.retain(|(m, at)| {
            let waiting = at.elapsed() < UNSUBMITTED_WITHIN;
            if !waiting {
                tracing::warn!(
                    "[chat {}] a message typed into the turn {}s ago was never reported taken; the turn \
                     no longer waits for it: {}",
                    self.id,
                    UNSUBMITTED_WITHIN.as_secs(),
                    m.chars().take(80).collect::<String>()
                );
            }
            waiting
        });
        s.unsubmitted.len()
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
        panes: runner.panes.clone(),
        id: id.into(),
        sid: sid.into(),
        pane: format!("forge-chat-{id}"),
        events: events.clone(),
        transcript,
        transcript_from: 0,
        cost_base,
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
        let off = pane_for(true, true, true, true, Some("p"))
            .unwrap()
            .unwrap_err();
        assert!(off.starts_with("[CHAT_PANE_HOOKS_OFF]"), "{off}");
        let unnamed = pane_for(true, true, true, false, None)
            .unwrap()
            .unwrap_err();
        assert!(unnamed.starts_with("[CHAT_PANE_NO_PROJECT]"), "{unnamed}");
    }

    #[test]
    fn a_reported_prompt_is_the_typed_message_whatever_its_whitespace() {
        assert!(same_prompt("hello\n  there ", "hello there"));
        assert!(!same_prompt("hello", "hello there"));
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

    /// Whether `rx` yields `Done` within `within`, the lines before it dropped.
    async fn done_within(rx: &mut mpsc::Receiver<RunnerEvent>, within: Duration) -> bool {
        tokio::time::timeout(within, async {
            while let Some(ev) = rx.recv().await {
                if matches!(ev, RunnerEvent::Done) {
                    return true;
                }
            }
            false
        })
        .await
        .unwrap_or(false)
    }

    /// Measured on 2.1.319: a message typed while the model writes its last text is queued, the
    /// turn's Stop fires, and the message runs as a turn of its own straight after with a second
    /// Stop. The turn core handed ends with the second.
    #[tokio::test]
    async fn a_stop_while_a_typed_message_is_still_queued_does_not_end_the_turn() {
        let dir = std::env::temp_dir().join(format!("pane-queued-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (events, transcript) = (dir.join("events.jsonl"), dir.join("t.jsonl"));
        let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 1);
        let (tx, mut rx) = mpsc::channel(64);
        test_turn(&runner, "q", "s1", events.clone(), transcript.clone(), tx).await;
        let line = |v: serde_json::Value| format!("{v}\n");
        let mut t = line(serde_json::json!({"type":"user","message":{"content":"story"}}));
        t += &line(
            serde_json::json!({"type":"queue-operation","operation":"enqueue","content":"HOTEL"}),
        );
        std::fs::write(&transcript, &t).unwrap();
        let now = runner_core::agent_activity::now_ms();
        chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, now).unwrap();
        chat_pane_events::append(
            &events,
            STATUS_LINE,
            br#"{"cost":{"total_cost_usd":0.01}}"#,
            now + 1,
        )
        .unwrap();
        assert!(
            !done_within(&mut rx, Duration::from_millis(1500)).await,
            "the turn ended on a Stop with a typed message still queued"
        );
        t += &line(serde_json::json!({"type":"queue-operation","operation":"dequeue"}));
        t += &line(serde_json::json!({"type":"user","message":{"content":"HOTEL"}}));
        std::fs::write(&transcript, &t).unwrap();
        let now = runner_core::agent_activity::now_ms();
        chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, now).unwrap();
        chat_pane_events::append(
            &events,
            STATUS_LINE,
            br#"{"cost":{"total_cost_usd":0.02}}"#,
            now + 1,
        )
        .unwrap();
        let ended = done_within(&mut rx, Duration::from_secs(5)).await;
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            ended,
            "the second Stop, with nothing queued, did not end the turn"
        );
    }

    /// The `result` line `rx` yields before `Done`, if it yields one within ten seconds.
    async fn result_of(rx: &mut mpsc::Receiver<RunnerEvent>) -> Option<serde_json::Value> {
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut result = None;
            while let Some(ev) = rx.recv().await {
                match ev {
                    RunnerEvent::Stdout(l) if l["type"] == "result" => result = Some(l),
                    RunnerEvent::Done => return result,
                    _ => {}
                }
            }
            None
        })
        .await
        .ok()
        .flatten()
    }

    /// A resumed pane's first turn, its baseline taken the way `start_in_pane` takes it from
    /// `events` before the prompt is handed in, then the turn's Stop and the status line after it.
    async fn resumed_first_turn(
        tag: &str,
        before: Option<&[u8]>,
        within: Duration,
    ) -> (Option<f64>, Option<serde_json::Value>) {
        let dir = std::env::temp_dir().join(format!("pane-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (events, transcript) = (dir.join("events.jsonl"), dir.join("t.jsonl"));
        std::fs::write(&events, b"").unwrap();
        let launched = runner_core::agent_activity::now_ms();
        if let Some(payload) = before {
            chat_pane_events::append(&events, STATUS_LINE, payload, launched).unwrap();
        }
        let base = first_turn_base(&SessionStart::Resume("s1".into()), &events, within).await;
        let runner = ClaudeCodeRunner::new("http://127.0.0.1:9", "t", 1);
        let (tx, mut rx) = mpsc::channel(64);
        let paths = (events.clone(), transcript.clone());
        test_turn_from(&runner, tag, "s1", paths, base, tx).await;
        std::fs::write(
            &transcript,
            concat!(
                r#"{"type":"user","message":{"content":"hi"}}"#,
                "\n",
                r#"{"type":"assistant","message":{"id":"m1","content":[{"type":"text"}],"usage":{"output_tokens":3}}}"#,
                "\n",
            ),
        )
        .unwrap();
        let stop = runner_core::agent_activity::now_ms();
        chat_pane_events::append(&events, "Stop", br#"{"session_id":"s1"}"#, stop).unwrap();
        let after = br#"{"cost":{"total_cost_usd":0.53}}"#;
        chat_pane_events::append(&events, STATUS_LINE, after, stop + 1).unwrap();
        let result = result_of(&mut rx).await;
        let _ = std::fs::remove_dir_all(&dir);
        (base, result)
    }

    /// ISS-1172: a resumed session's status line carries its restored running cost before any
    /// prompt (measured on 2.1.319), so the first turn is that figure's difference, not unread.
    #[tokio::test]
    async fn a_resumed_pane_s_first_turn_is_measured_from_the_status_line_before_its_prompt() {
        let before = br#"{"session_id":"s1","cost":{"total_cost_usd":0.5}}"#;
        let (base, result) =
            resumed_first_turn("base-read", Some(before), Duration::from_secs(5)).await;
        assert_eq!(base, Some(0.5));
        let result = result.expect("the turn closed with no result line");
        assert_eq!(result["total_cost_usd"], 0.03, "{result}");
        assert!(result["forge_pane"]["cost"].is_string(), "{result}");
    }

    /// With no status line before the prompt, the first turn stays unread, saying why, after
    /// waiting no longer than its bound.
    #[tokio::test]
    async fn a_resumed_pane_with_no_status_line_before_its_prompt_says_its_cost_is_unread() {
        let started = std::time::Instant::now();
        let (base, result) =
            resumed_first_turn("base-none", None, Duration::from_millis(600)).await;
        assert_eq!(base, None);
        let result = result.expect("the turn closed with no result line");
        assert!(result.get("total_cost_usd").is_none(), "{result}");
        assert_eq!(
            result["forge_pane"]["cost"]["unread"],
            "no status line stood before the turn to measure from"
        );
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// A session the box just named has spent nothing: it is measured from 0, with no wait.
    #[tokio::test]
    async fn a_new_pane_session_is_measured_from_nothing_spent_without_waiting() {
        let started = std::time::Instant::now();
        let none = std::path::Path::new("/nonexistent/events.jsonl");
        let new = SessionStart::New("n".into());
        let base = first_turn_base(&new, none, Duration::from_secs(30)).await;
        assert_eq!(base, Some(0.0));
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
