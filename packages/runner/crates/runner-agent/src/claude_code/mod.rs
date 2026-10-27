//! Claude Code runner — wraps the `claude` CLI behind the [`Runner`] trait.
//! Ported from the Tauri app's `claude_cli/{spawn,agent,mcp}.rs`, emitting
//! [`RunnerEvent`] on a channel instead of Tauri events.
//!
//! Session key = the core `jobId`, so `abort(job_id)` maps a `job.cancel`
//! frame straight onto the right process.

pub(crate) mod confine;
mod outcome;
use outcome::*;
mod permits;
mod stream;
pub use permits::*;

use std::collections::HashMap;
use std::process::ExitStatus;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, Mutex};

use super::{JobSpec, Runner, RunnerEvent, SessionId};
use runner_core::inflight;
use runner_platform::error::{Error, Result};
use runner_platform::process::{build_command_for, graceful_kill, own_session, resolve_claude_bin};
use runner_workspace::mcp;

fn user_message_line(text: &str) -> String {
    let msg = serde_json::json!({
        "type": "user",
        "message": { "role": "user", "content": [{ "type": "text", "text": text }] }
    });
    format!("{msg}\n")
}

struct Session {
    child: Option<tokio::process::Child>,
    claude_session_id: Option<String>,
    /// Held open for the life of a DUPLEX session — dropping it is EOF, which
    /// is how a resident session is closed. `None` on the print path.
    stdin: Option<tokio::process::ChildStdin>,
    /// Where the CURRENT turn's events go. Swapped by [`Runner::send`].
    turn_tx: TurnTx,
    /// Raised by [`Runner::send`] so the turn loop knows the idle clock stops.
    turn_started: Arc<tokio::sync::Notify>,
    /// Inbox messages written into this process and not yet reported applied: every one a turn
    /// that ends has taken.
    pending_inbox: Vec<(String, u64)>,
    /// User messages written into stdin that Claude Code has not yet replayed. Claude Code takes
    /// a message written while a turn runs either into that turn, at its next tool call, or as a
    /// turn of its own straight after the `result` (measured on 2.1.310); a `result` ends the
    /// caller's turn only when every message written has been replayed.
    unreplayed: u32,
    /// Whether a turn is in flight: written and not yet ended by a `result` with nothing queued.
    in_turn: bool,
    /// Core's `keepResident`: the session takes input only in a turn core started.
    keep_resident: bool,
    /// Where a resident session's bearer file lives (`mcp::config::write_refreshable`).
    bearer_dir: Option<std::path::PathBuf>,
    /// Completed turns, so an `applied` report can name the one that consumed
    /// the message.
    turns: u64,
    /// Raised after each turn's verdict is sent. The only signal a caller
    /// outside the turn loop has that a turn it started has finished.
    turn_done: Arc<tokio::sync::Notify>,
    /// What this session was spawned with, and where its checkout stood at the
    /// last turn — the two facts a caller needs to decide whether the resident
    /// session can serve the next turn as-is.
    model: Option<String>,
    head_sha: Option<String>,
    permit: Option<tokio::sync::OwnedSemaphorePermit>,
    project_slug: Option<String>,
    /// Raised by the completion task once it has reaped the process and removed this entry: what
    /// a close waits on before anything else is spawned under the same key.
    ended: tokio::sync::watch::Receiver<bool>,
}

/// The current turn's event sink. Shared by the stdout reader, the completion
/// task and [`Runner::send`], because a resident process outlives any one of them.
type TurnTx = Arc<Mutex<mpsc::Sender<RunnerEvent>>>;

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

const RESULT_EXIT_GRACE: Duration = Duration::from_secs(5);

/// How long a closed resident has to end on its own once its stdin is closed, before it is killed.
/// One between turns exits within a couple of seconds of EOF.
const CLOSE_GRACE: Duration = Duration::from_secs(10);

/// How long a killed resident's completion task has to reap it and give up its key.
const KILL_GRACE: Duration = Duration::from_secs(10);

/// Turns this box has been handed and not yet placed in a process, by session key, with how many.
type Placing = Arc<std::sync::Mutex<HashMap<String, (usize, tokio::sync::watch::Sender<bool>)>>>;

pub struct ClaudeCodeRunner {
    core_url: String,
    device_token: String,
    sessions: Sessions,
    session_sem: Arc<tokio::sync::Semaphore>,
    session_cap: usize,
    pending_permits: Arc<std::sync::Mutex<HashMap<String, String>>>,
    placing: Placing,
    close_grace: Duration,
}

/// A turn core handed this box for a session, held from the moment its frame is read until the
/// turn is written into a process (or fails to be). An inbox write for the session waits while
/// one is held, so it goes into the process the turn runs in and never into the resident that
/// turn is about to close.
pub struct TurnPlacing {
    placing: Placing,
    id: String,
}

impl Drop for TurnPlacing {
    fn drop(&mut self) {
        let Ok(mut map) = self.placing.lock() else {
            return;
        };
        if let Some((n, placed)) = map.get_mut(&self.id) {
            *n -= 1;
            if *n == 0 {
                let _ = placed.send(true);
                map.remove(&self.id);
            }
        }
    }
}

impl ClaudeCodeRunner {
    pub fn new(
        core_url: impl Into<String>,
        device_token: impl Into<String>,
        session_cap: usize,
    ) -> Self {
        Self {
            core_url: core_url.into(),
            device_token: device_token.into(),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            session_sem: Arc::new(tokio::sync::Semaphore::new(session_cap.max(1))),
            session_cap: session_cap.max(1),
            pending_permits: Arc::new(std::sync::Mutex::new(HashMap::new())),
            placing: Arc::new(std::sync::Mutex::new(HashMap::new())),
            close_grace: CLOSE_GRACE,
        }
    }

    /// The same runner with a shorter wait before a closed resident is killed.
    #[cfg(all(test, unix))]
    pub(crate) fn with_close_grace(mut self, grace: Duration) -> Self {
        self.close_grace = grace;
        self
    }

    /// Hold `id` as having a turn on its way to a process; dropped once the turn is placed.
    pub fn place_turn(&self, id: &str) -> TurnPlacing {
        if let Ok(mut map) = self.placing.lock() {
            map.entry(id.to_string())
                .or_insert_with(|| (0, tokio::sync::watch::channel(false).0))
                .0 += 1;
        }
        TurnPlacing {
            placing: self.placing.clone(),
            id: id.to_string(),
        }
    }

    /// Wait until no turn handed for `id` is still on its way to a process.
    async fn placed(&self, id: &str) {
        let waiting = self
            .placing
            .lock()
            .ok()
            .and_then(|map| map.get(id).map(|(_, placed)| placed.subscribe()));
        if let Some(mut placed) = waiting {
            let _ = placed.wait_for(|done| *done).await;
        }
    }

    fn placing_turn(&self, id: &str) -> bool {
        self.placing.lock().is_ok_and(|map| map.contains_key(id))
    }

    /// Project slugs of everything currently holding a duplex permit.
    ///
    /// One project's claims can exhaust a box-level ceiling that another
    /// project's jobs then fail on, and neither side can see the other from its
    /// own records (ISS-920 B4). This is what puts the holders in the loser's
    /// failure text.
    async fn permit_holders(&self) -> Vec<String> {
        let mut slugs: Vec<String> = {
            let map = self.sessions.lock().await;
            map.values()
                .filter(|s| s.permit.is_some())
                .map(|s| s.project_slug.clone().unwrap_or_else(|| "?".to_string()))
                .collect()
        };
        if let Ok(pending) = self.pending_permits.lock() {
            slugs.extend(pending.values().cloned());
        }
        slugs.sort();
        slugs
    }
}

/// What a live duplex session was spawned with. `None` means no live session.
pub struct Resident {
    pub model: Option<String>,
    /// `head_sha` recorded at the last turn, or `None` if none was recorded.
    pub head_sha: Option<String>,
    /// Spawned to read its bearer from a file the runner rewrites, so a turn carrying its own
    /// token can be written into it.
    pub refreshable: bool,
}

fn build_args(spec: &JobSpec, mcp_path: &str) -> Vec<String> {
    let mode = spec
        .permission_mode
        .as_deref()
        .unwrap_or("bypassPermissions");
    let mut args: Vec<String> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
        // Emit partial-message + subagent stream events so a quiet-but-busy
        // fan-out session keeps producing stdout (liveness) and the runner
        // sees every event (ISS-479).
        "--include-partial-messages".into(),
        "--permission-mode".into(),
        mode.into(),
    ];
    args.push("--input-format".into());
    args.push("stream-json".into());
    args.push("--replay-user-messages".into());
    if let Some(sp) = spec.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        args.push("--append-system-prompt".into());
        args.push(sp.into());
    }
    if let Some(model) = spec.model.as_deref().filter(|s| !s.is_empty()) {
        args.push("--model".into());
        args.push(model.into());
    }
    args.push("--mcp-config".into());
    args.push(mcp_path.into());
    // The temp `--mcp-config` is authoritative for a job run. `--strict-mcp-config`
    // makes Claude ignore the working-dir `.mcp.json` instead of merging it — so a
    // provisioned repo's persistent `.mcp.json` (which also defines a `forge`
    // server, for interactive use) never double-loads on top of this fresh-token
    // temp config. See docs / ISS-466 follow-up.
    args.push("--strict-mcp-config".into());
    if let Some(rid) = spec.resume_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(rid.into());
    }
    if spec.hooks_off {
        // a POC room's agent (REQ-44 BC-3): no hook the checkout declares runs between an edit and
        // the preview showing it
        args.push("--settings".into());
        args.push(HOOKS_OFF.into());
    }
    args
}

/// `build_args` with a placeholder MCP config path, for the turn tests.
#[cfg(test)]
pub(crate) fn args_for_test(spec: &JobSpec) -> Vec<String> {
    build_args(spec, "/tmp/mcp.json")
}

/// The settings a session with every hook off is spawned with.
pub const HOOKS_OFF: &str = r#"{"disableAllHooks":true}"#;

impl ClaudeCodeRunner {
    /// What the live duplex session for `id` was spawned with, if there is one.
    pub async fn resident(&self, id: &SessionId) -> Option<Resident> {
        let map = self.sessions.lock().await;
        let s = map.get(id)?;
        s.stdin.as_ref()?;
        Some(Resident {
            model: s.model.clone(),
            head_sha: s.head_sha.clone(),
            refreshable: s.bearer_dir.is_some(),
        })
    }

    /// Hand a resident session the token of the turn about to be written into it.
    pub async fn refresh_bearer(&self, id: &SessionId, credential: &str) -> Result<()> {
        let dir = {
            let map = self.sessions.lock().await;
            map.get(id).and_then(|s| s.bearer_dir.clone())
        };
        let dir = dir.ok_or_else(|| {
            Error::Other("the resident session reads no bearer file to hand a token to".into())
        })?;
        mcp::config::refresh_bearer(&dir, credential)
    }

    /// An inbox message for a session this runner holds: written in at once, and taken by the
    /// turn in flight. A session core keeps resident takes input only within a turn core started
    /// (its token is that turn's), so one with none in flight refuses it, and core hands the
    /// message to its next turn instead. Where a turn core handed this box is still on its way to
    /// a process, the message waits for it and goes into that turn: core wrote it for the turn it
    /// had just started, and the resident that turn may close is not fed (2026-10-27, Sidcorp
    /// Mail's room: a message written into the closing resident was answered there under a revoked
    /// token, and again by the replacement that resumed its transcript).
    pub async fn inject_resident(
        &self,
        id: &SessionId,
        message: &str,
        pending: (String, u64),
    ) -> Result<()> {
        self.placed(id).await;
        {
            let map = self.sessions.lock().await;
            let sess = map
                .get(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            if sess.keep_resident && !sess.in_turn {
                return Err(Error::Other(
                    "the session has no turn in flight, and a resident support session takes input \
                     only in a turn core started"
                        .into(),
                ));
            }
        }
        self.send_resident(id, message, Some(pending)).await
    }

    /// Whether this runner holds a session under `id` at all, resident or closed, or has been
    /// handed a turn for it that is not yet in a process. A session it does not hold is one it can
    /// say nothing about, which is not the same as one that ended.
    pub async fn holds(&self, id: &SessionId) -> bool {
        self.placing_turn(id) || self.sessions.lock().await.contains_key(id)
    }

    pub async fn send_resident(
        &self,
        id: &SessionId,
        message: &str,
        pending: Option<(String, u64)>,
    ) -> Result<()> {
        let turn_tx = {
            let mut map = self.sessions.lock().await;
            let sess = map
                .get_mut(id)
                .ok_or_else(|| Error::Other("session not found".into()))?;
            if sess.stdin.is_none() {
                return Err(Error::Other("session is not resident".into()));
            }
            sess.pending_inbox.extend(pending);
            sess.turn_tx.clone()
        };
        let tx = turn_tx.lock().await.clone();
        Runner::send(self, id, message.to_string(), tx).await
    }

    /// Record the checkout the session has just been told about.
    pub async fn note_head(&self, id: &SessionId, head_sha: Option<String>) {
        if let Some(s) = self.sessions.lock().await.get_mut(id) {
            s.head_sha = head_sha;
        }
    }

    /// End a live session between turns: EOF on stdin, then wait for its completion task to reap
    /// it and give up its key. Used when the next turn cannot reuse it (a model change, a turn
    /// carrying its own token), and when core ends its residency. See [`Self::retire`].
    pub async fn close(&self, id: &SessionId) {
        if let Err(e) = self.retire(id).await {
            tracing::error!("[claude] session={id}: {e}");
        }
    }

    /// Kill the process holding `id`, but only while it is still the one `ended` watches: a close
    /// that timed out may run this after that process was reaped and a replacement adopted under
    /// the same key, and the replacement is not its to kill.
    pub(crate) async fn kill_holder(&self, id: &str, ended: &tokio::sync::watch::Receiver<bool>) {
        let child = self
            .sessions
            .lock()
            .await
            .get_mut(id)
            .filter(|s| s.ended.same_channel(ended))
            .and_then(|s| s.child.take());
        if let Some(mut child) = child {
            graceful_kill(&mut child).await;
        }
    }

    /// Close whatever process holds `id` and return only once it is reaped and its entry gone,
    /// killing it where it has not ended within the close grace. Nothing may be spawned under a key
    /// a live process still holds: its completion task reaps by that key, and before this waited
    /// it took a replacement's child for its own, killed it mid-turn and removed its entry
    /// (2026-10-27, `[NO_RESULT_EXIT] no exit code, no result event`). Waiting rather than giving
    /// each spawn its own handle is also what keeps two processes off one Claude session: the
    /// replacement resumes the same transcript the closed one would otherwise still be writing.
    pub(crate) async fn retire(&self, id: &str) -> Result<()> {
        let ended = {
            let mut map = self.sessions.lock().await;
            let Some(s) = map.get_mut(id) else {
                return Ok(());
            };
            s.stdin = None;
            s.ended.clone()
        };
        if ended_within(ended.clone(), self.close_grace).await {
            return Ok(());
        }
        tracing::warn!(
            "[claude] session={id} had not ended {}s after its stdin closed — killing it",
            self.close_grace.as_secs()
        );
        self.kill_holder(id, &ended).await;
        if ended_within(ended, KILL_GRACE).await {
            return Ok(());
        }
        Err(Error::Other(format!(
            "[RESIDENT_NOT_REAPED] the process session {id} was closed on was killed and its \
             completion task still holds the key {}s later; nothing is spawned under it",
            KILL_GRACE.as_secs()
        )))
    }

    pub const CHECKPOINT_PROMPT: &'static str = "Write down where you are before this session ends: \
        what you have changed so far, what you were about to do next, and anything you know that is \
        not already in the repository. Do not start new work.";

    pub async fn checkpoint_and_close(&self, budget: std::time::Duration) -> Vec<SessionId> {
        let resident: Vec<SessionId> = {
            let map = self.sessions.lock().await;
            map.iter()
                .filter(|(_, s)| s.stdin.is_some())
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in &resident {
            let done = {
                let map = self.sessions.lock().await;
                map.get(id).map(|s| s.turn_done.clone())
            };
            let Some(done) = done else { continue };
            let notified = done.notified();
            if self
                .send_resident(id, Self::CHECKPOINT_PROMPT, None)
                .await
                .is_err()
            {
                continue;
            }
            if tokio::time::timeout(budget, notified).await.is_err() {
                tracing::warn!("[claude] session={id} did not finish its checkpoint in time");
            }
        }
        let closed = self.close_all_resident().await;
        let core =
            runner_transport::CoreClient::new(self.core_url.clone(), self.device_token.clone());
        for id in &closed {
            if !self.sessions.lock().await.contains_key(id) {
                continue;
            }
            report_session_closed(Some(&core), id).await;
        }
        closed
    }

    /// The duplex permit `spec` takes, if it takes one, registered as pending
    /// from here rather than from the session insertion that follows.
    async fn permit_for(
        &self,
        spec: &JobSpec,
    ) -> Result<(
        Option<tokio::sync::OwnedSemaphorePermit>,
        Option<PendingPermit>,
    )> {
        if !takes_session_permit(spec) {
            return Ok((None, None));
        }
        let permit = acquire_session_permit(
            self.session_sem.clone(),
            self.session_cap,
            SESSION_PERMIT_WAIT,
            &spec.job_id,
            self.permit_holders().await,
        )
        .await?;
        let pending = PendingPermit::register(
            &self.pending_permits,
            &spec.job_id,
            spec.project_slug.as_deref(),
        );
        Ok((Some(permit), Some(pending)))
    }

    pub async fn close_all_resident(&self) -> Vec<SessionId> {
        let mut map = self.sessions.lock().await;
        let mut closed = Vec::new();
        for (id, s) in map.iter_mut() {
            if s.stdin.take().is_some() {
                closed.push(id.clone());
            }
        }
        closed
    }
}

/// A process spawned under a key a live one still holds: killed, and refused by name. A key is
/// reused only once its last process is reaped, since that process's tasks reap by it.
async fn refuse_held_key(
    job_id: &str,
    mut child: tokio::process::Child,
    mcp_path: &std::path::Path,
) -> Error {
    graceful_kill(&mut child).await;
    let _ = std::fs::remove_file(mcp_path);
    Error::Other(format!(
        "[SESSION_KEY_HELD] a process still holds session {job_id}, so the one just spawned for \
         it was killed: a key is reused only once its last process is reaped"
    ))
}

/// Whether the session `ended` watches is reaped within `within`. A completion task gone without
/// saying so has nothing left to reap.
async fn ended_within(mut ended: tokio::sync::watch::Receiver<bool>, within: Duration) -> bool {
    tokio::time::timeout(within, ended.wait_for(|done| *done))
        .await
        .is_ok()
}

/// The credential a session holds: the one core handed it, else — for a run only — this box's
/// own. A confined session handed none is refused rather than given the box's.
fn session_credential(spec: &JobSpec) -> Result<String> {
    match (&spec.credential, &spec.confinement) {
        (Some(handed), _) => Ok(handed.0.clone()),
        (None, Some(_)) => Err(Error::Other(
            "[CHAT_CONFINEMENT_NO_CREDENTIAL] core asked for this session to hold only the \
             credential it was handed, and handed none; this box's own PAT is not put in its \
             place"
                .into(),
        )),
        (None, None) => mcp::config::job_credential(),
    }
}

/// The session's MCP config, and the directory its bearer is read from when the process stays
/// resident across turns that each carry their own token (a support group's session, REQ-75):
/// every turn writes its token there before it is written to the process, so one process serves
/// every turn without holding a revoked token.
fn mcp_config_for(
    core_url: &str,
    spec: &JobSpec,
    credential: &str,
) -> Result<(std::path::PathBuf, Option<std::path::PathBuf>)> {
    let slug = spec.project_slug.as_deref().unwrap_or("");
    let servers = spec.mcp_servers_override.as_ref();
    if spec.keep_resident && spec.credential.is_some() {
        let made =
            mcp::config::write_refreshable(core_url, credential, slug, &spec.job_id, servers)?;
        return Ok((made.config, Some(made.bearer_dir)));
    }
    let path = mcp::config::write(core_url, credential, slug, &spec.job_id, servers)?;
    Ok((path, None))
}

/// A process just spawned for a session, its first turn already written into `stdin`: what
/// [`ClaudeCodeRunner::adopt`] makes a session of.
pub(crate) struct Spawned {
    pub(crate) job_id: String,
    pub(crate) child: tokio::process::Child,
    pub(crate) stdin: tokio::process::ChildStdin,
    pub(crate) egress: Option<EgressGuard>,
    pub(crate) mcp_path: std::path::PathBuf,
    pub(crate) bearer_dir: Option<std::path::PathBuf>,
    pub(crate) invoked_with_resume: bool,
    pub(crate) permit: Option<tokio::sync::OwnedSemaphorePermit>,
    pub(crate) keep_resident: bool,
    pub(crate) model: Option<String>,
    pub(crate) project_slug: Option<String>,
}

impl ClaudeCodeRunner {
    /// Make a session of a spawned process: record it under its key, and start the stdout reader
    /// and the completion task that runs its turns and reaps it.
    pub(crate) async fn adopt(
        &self,
        spawned: Spawned,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()> {
        let Spawned {
            job_id,
            mut child,
            stdin,
            egress,
            mcp_path,
            bearer_dir,
            invoked_with_resume,
            permit,
            keep_resident,
            model,
            project_slug,
        } = spawned;
        let turn_started = Arc::new(tokio::sync::Notify::new());
        let turn_done = Arc::new(tokio::sync::Notify::new());
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("no stderr".into()))?;

        let (ended_tx, ended) = tokio::sync::watch::channel(false);
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx.clone()));
        let mut map = self.sessions.lock().await;
        if map.contains_key(&job_id) {
            drop(map);
            return Err(refuse_held_key(&job_id, child, &mcp_path).await);
        }
        if let Some(pid) = child.id() {
            inflight::record(&job_id, pid);
        }
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        map.insert(
            job_id.clone(),
            Session {
                child: Some(child),
                claude_session_id: None,
                stdin: Some(stdin),
                turn_tx: turn_tx.clone(),
                turn_started: turn_started.clone(),
                pending_inbox: Vec::new(),
                unreplayed: 1,
                in_turn: true,
                keep_resident,
                bearer_dir: bearer_dir.clone(),
                turns: 0,
                turn_done: turn_done.clone(),
                model,
                head_sha: None,
                permit,
                project_slug,
                ended,
            },
        );
        drop(map);

        // Shared outcome written incrementally so it survives a reader abort.
        let outcome: Arc<Mutex<Outcome>> = Arc::new(Mutex::new(Outcome::default()));

        // Notified once when the reader sees the definitive `{type:result}`
        // marker, so the completion task can report terminal immediately
        // (ISS-479 terminal-on-result) instead of inferring it from silence.
        let result_notify = Arc::new(tokio::sync::Notify::new());

        // stderr → string.
        let stderr_handle = tokio::spawn(async move {
            let mut buf = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buf).await;
            buf
        });

        let reader = stream::spawn_reader(
            stdout,
            turn_tx.clone(),
            self.sessions.clone(),
            outcome.clone(),
            result_notify.clone(),
            job_id.clone(),
        );
        tokio::spawn(stream::complete(stream::Completion {
            sessions: self.sessions.clone(),
            job_id,
            core: Some(runner_transport::CoreClient::new(
                self.core_url.clone(),
                self.device_token.clone(),
            )),
            outcome,
            result_notify,
            turn_tx,
            turn_started,
            turn_done,
            reader,
            stderr: stderr_handle,
            mcp_path,
            bearer_dir,
            egress,
            invoked_with_resume,
            tx,
            ended: ended_tx,
        }));
        Ok(())
    }
}

#[async_trait]
impl Runner for ClaudeCodeRunner {
    async fn start(&self, spec: JobSpec, tx: mpsc::Sender<RunnerEvent>) -> Result<SessionId> {
        let job_id = spec.job_id.clone();

        let effective_repo = spec.repo_path.to_string_lossy().to_string();

        // No skill seeding at job start: the job consumes whatever is already
        // in `<worktree>/.claude/skills/`, delivered ahead of time by the disk
        // sync channel (`workspace::skill_sync`, driven by provision / the
        // `skill.sync` event / background auto-pull), plus any device-scope
        // plugin skills inherited from the config dir. A job-start re-seed was
        // removed because it clobbered project-shadowed skills mid-flight.
        //

        let prompt = spec
            .prompt
            .clone()
            .ok_or_else(|| Error::Other("job has no prompt".into()))?;
        let credential = session_credential(&spec)?;
        // whatever still holds this key ends first: a closed resident's reaper reaps by it
        self.retire(&job_id).await?;

        let invoked_with_resume = spec.resume_id.is_some();

        let (session_permit, pending_permit) = self.permit_for(&spec).await?;

        let (mcp_path, bearer_dir) = mcp_config_for(&self.core_url, &spec, &credential)?;
        let (mut child, egress) = spawn_claude(
            &spec,
            &effective_repo,
            &credential,
            &mcp_path,
            bearer_dir.as_deref(),
            &self.core_url,
        )
        .await?;
        tracing::info!("[claude] spawned job={job_id}");
        let stdin = write_first_turn(&mut child, &prompt).await?;
        self.adopt(
            Spawned {
                job_id: job_id.clone(),
                child,
                stdin,
                egress,
                mcp_path,
                bearer_dir,
                invoked_with_resume,
                permit: session_permit,
                keep_resident: spec.keep_resident,
                model: spec.model.clone(),
                project_slug: spec.project_slug.clone(),
            },
            tx,
        )
        .await?;
        // The session row is now the countable record; hand over rather than
        // let both report the same permit.
        drop(pending_permit);
        Ok(job_id)
    }

    async fn send(
        &self,
        session: &SessionId,
        message: String,
        tx: mpsc::Sender<RunnerEvent>,
    ) -> Result<()> {
        let mut map = self.sessions.lock().await;
        let sess = map
            .get_mut(session)
            .ok_or_else(|| Error::Other("session not found".into()))?;
        let stdin = sess
            .stdin
            .as_mut()
            .ok_or_else(|| Error::Other("session is not duplex — nothing to send to".into()))?;
        stdin
            .write_all(user_message_line(&message).as_bytes())
            .await
            .map_err(|e| Error::Other(format!("failed to write the turn: {e}")))?;
        stdin
            .flush()
            .await
            .map_err(|e| Error::Other(format!("failed to flush the turn: {e}")))?;
        sess.unreplayed += 1;
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        *sess.turn_tx.lock().await = tx;
        // a message written while a turn runs joins that turn; only one written between turns
        // starts one
        if !sess.in_turn {
            sess.in_turn = true;
            sess.turn_started.notify_one();
        }
        Ok(())
    }

    async fn abort(&self, session: &SessionId) -> Result<()> {
        let mut s = self.sessions.lock().await;
        if let Some(sess) = s.get_mut(session) {
            sess.stdin = None;
            if let Some(mut child) = sess.child.take() {
                graceful_kill(&mut child).await;
            }
            Ok(())
        } else {
            Err(Error::Other("session not found".into()))
        }
    }
}

/// What a confined session's network runs through for as long as it lives; dropped once the
/// process is reaped. Nothing elsewhere, where no session is confined.
#[cfg(target_os = "linux")]
pub(crate) type EgressGuard = runner_platform::confine::egress::Proxy;
#[cfg(not(target_os = "linux"))]
pub(crate) type EgressGuard = std::convert::Infallible;

/// Spawn `claude` for `spec` in `repo`, its MCP config at `mcp_path`.
async fn spawn_claude(
    spec: &JobSpec,
    repo: &str,
    credential: &str,
    mcp_path: &std::path::Path,
    bearer_dir: Option<&std::path::Path>,
    core_url: &str,
) -> Result<(tokio::process::Child, Option<EgressGuard>)> {
    let args = build_args(spec, &mcp_path.to_string_lossy());
    let program = std::ffi::OsStr::new(resolve_claude_bin());
    let made = SessionCommand {
        spec,
        program,
        args: &args,
        repo,
        credential,
        mcp_path,
        bearer_dir,
        core_url,
    }
    .build(None)
    .await;
    let (mut cmd, egress) = match made {
        Ok(made) => made,
        Err(e) => {
            let _ = std::fs::remove_file(mcp_path);
            return Err(e);
        }
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let child = cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_file(mcp_path);
        Error::Other(format!("failed to spawn claude: {e}"))
    })?;
    Ok((child, egress))
}

/// What one session is spawned from.
pub(crate) struct SessionCommand<'a> {
    pub spec: &'a JobSpec,
    pub program: &'a std::ffi::OsStr,
    pub args: &'a [String],
    pub repo: &'a str,
    pub credential: &'a str,
    pub mcp_path: &'a std::path::Path,
    /// A resident session's bearer file directory: its `forge` server reads the token there, and
    /// its environment holds none.
    pub bearer_dir: Option<&'a std::path::Path>,
    pub core_url: &'a str,
}

impl SessionCommand<'_> {
    /// The command a session runs as. A run inherits this runner's environment and view of the
    /// box, with `credential` as its `$FORGE_PAT`; a confined session gets
    /// [`confine::chat_sandbox`] and the egress proxy its network runs through, and is refused by
    /// name where this box cannot confine. `view` stands in for this process's own.
    pub(crate) async fn build(
        &self,
        view: Option<confine::BoxView>,
    ) -> Result<(tokio::process::Command, Option<EgressGuard>)> {
        let Self {
            spec,
            program,
            args,
            repo,
            credential,
            mcp_path,
            bearer_dir,
            core_url,
        } = *self;
        // a resident session's token changes with each turn, so none sits in its environment
        let env_credential = if bearer_dir.is_some() {
            None
        } else {
            Some(credential)
        };
        let Some(confinement) = &spec.confinement else {
            return Ok((
                unconfined_command(spec, program, args, repo, env_credential),
                None,
            ));
        };
        let view = match view {
            Some(view) => view,
            None => confine::BoxView::current()?,
        };
        let repo = std::path::Path::new(repo);
        let (git_dirs, git_identity) = confine::read_git(repo).await;
        let handed = confine::Handed {
            repo,
            credential: env_credential,
            mcp_config: mcp_path,
            bearer_dir,
            reads: &confinement.reads,
            project_slug: spec.project_slug.as_deref(),
            project_id: &spec.project_id,
            git_dirs,
            git_identity,
            core_url,
            egress_socket: view.egress_dir.join(egress_dir_name()).join("s"),
        };
        let allow = confine::egress_allow(&view, &handed)?;
        let upstream = confine::upstream(&view)?;
        let mut cmd = confine::chat_sandbox(&view, &handed)?.command(program, args)?;
        own_session(&mut cmd);
        let egress = start_egress(&handed.egress_socket, allow, upstream)?;
        Ok((cmd, Some(egress)))
    }
}

/// The proxy a confined session's network runs through, listening at `socket`.
#[cfg(target_os = "linux")]
fn start_egress(
    socket: &std::path::Path,
    allow: Vec<runner_platform::confine::egress::Host>,
    upstream: Option<runner_platform::confine::egress::Upstream>,
) -> Result<EgressGuard> {
    runner_platform::confine::egress::Proxy::start(socket, allow, upstream).map_err(|e| {
        Error::Other(format!(
            "[CHAT_CONFINEMENT_UNAVAILABLE] the egress proxy a confined chat session's network \
             runs through cannot listen at {}: {e}",
            socket.display()
        ))
    })
}

/// No box but a Linux one confines a session, and its sandbox command is refused before this.
#[cfg(not(target_os = "linux"))]
fn start_egress(
    _socket: &std::path::Path,
    _allow: Vec<runner_platform::confine::egress::Host>,
    _upstream: Option<runner_platform::confine::egress::Upstream>,
) -> Result<EgressGuard> {
    Err(Error::Other(
        "[CHAT_CONFINEMENT_UNAVAILABLE] a chat session's egress is confined only on Linux".into(),
    ))
}

/// A directory name no other session of this or an earlier runner process holds, short enough
/// that the socket inside fits a unix socket path.
fn egress_dir_name() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    format!("{:x}-{n:x}-{nanos:x}", std::process::id())
}

/// A run's command: this runner's environment and view of the box, `credential` its
/// `$FORGE_PAT` where it has one.
fn unconfined_command(
    spec: &JobSpec,
    program: &std::ffi::OsStr,
    args: &[String],
    repo: &str,
    credential: Option<&str>,
) -> tokio::process::Command {
    let mut cmd = build_command_for(program, args, repo);
    match credential {
        Some(credential) => {
            cmd.env("FORGE_PAT", credential);
        }
        None => {
            cmd.env_remove("FORGE_PAT");
        }
    }
    for (k, v) in project_env(spec) {
        cmd.env(k, v);
    }
    // Give MCP servers room to connect before the `system/init` snapshot.
    // Heavy stdio servers (e.g. chrome-devtools-mcp / playwright launched via
    // `npx`, which fetch a package + spawn a browser) routinely need >5s; the
    // claude default is tight. Caller-set env wins (don't clobber an override).
    if std::env::var_os("MCP_TIMEOUT").is_none() {
        cmd.env("MCP_TIMEOUT", "15000");
    }
    cmd
}

/// Write the first turn into the spawn's stdin, and hand the stdin back held
/// open: dropping it is EOF, which is how a resident session is closed.
async fn write_first_turn(
    child: &mut tokio::process::Child,
    prompt: &str,
) -> Result<tokio::process::ChildStdin> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| Error::Other("no stdin on the spawn".into()))?;
    stdin
        .write_all(user_message_line(prompt).as_bytes())
        .await
        .map_err(|e| Error::Other(format!("failed to write the first turn: {e}")))?;
    let _ = stdin.flush().await;
    Ok(stdin)
}

fn project_env(spec: &JobSpec) -> Vec<(&'static str, String)> {
    let mut out = Vec::new();
    if !spec.project_id.is_empty() {
        out.push(("FORGE_PROJECT_ID", spec.project_id.clone()));
    }
    if let Some(slug) = spec.project_slug.as_ref() {
        out.push(("FORGE_PROJECT_SLUG", slug.clone()));
    }
    out
}

#[cfg(all(test, target_os = "linux"))]
mod confine_tests;

#[cfg(all(test, unix))]
mod resident_tests;

#[cfg(all(test, not(target_os = "linux")))]
mod confine_elsewhere_tests {
    //! Where this box cannot confine, a session core marks `confined` is refused by name, never
    //! run with the box's view.
    use super::*;

    #[tokio::test]
    async fn a_confined_session_is_refused_by_name_where_the_box_cannot_confine() {
        let repo = std::env::temp_dir();
        let spec = JobSpec {
            job_id: "s1".into(),
            project_id: String::new(),
            project_slug: Some("p".into()),
            repo_path: repo.clone(),
            prompt: Some("hi".into()),
            system_prompt: None,
            model: None,
            permission_mode: None,
            mcp_servers_override: None,
            resume_id: None,
            counts_against_session_cap: false,
            credential: Some(crate::TurnCredential("t".into())),
            confinement: Some(crate::Confinement::default()),
            hooks_off: false,
            keep_resident: false,
        };
        let view = confine::BoxView {
            home: repo.clone(),
            inherited: vec![],
            runner_config: None,
            claude_bin: None,
            temp_dir: repo.clone(),
            runner_exe: Some(repo.join("forge-runner")),
            egress_dir: repo.join("egress"),
            egress_allow: vec![],
        };
        let mcp_path = repo.join("mcp.json");
        let made = SessionCommand {
            spec: &spec,
            program: std::ffi::OsStr::new("claude"),
            args: &[],
            repo: &repo.to_string_lossy(),
            credential: "t",
            mcp_path: &mcp_path,
            bearer_dir: None,
            core_url: "https://core.example",
        }
        .build(Some(view))
        .await;
        let err = made.expect_err("a confined session was built on a box that cannot confine");
        assert!(
            err.to_string().contains("CHAT_CONFINEMENT_UNAVAILABLE"),
            "the refusal does not name itself: {err}"
        );
    }
}
