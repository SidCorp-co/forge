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
    pending_inbox: Option<(String, u64)>,
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
}

/// The current turn's event sink. Shared by the stdout reader, the completion
/// task and [`Runner::send`], because a resident process outlives any one of them.
type TurnTx = Arc<Mutex<mpsc::Sender<RunnerEvent>>>;

type Sessions = Arc<Mutex<HashMap<String, Session>>>;

const RESULT_EXIT_GRACE: Duration = Duration::from_secs(5);

pub struct ClaudeCodeRunner {
    core_url: String,
    device_token: String,
    sessions: Sessions,
    session_sem: Arc<tokio::sync::Semaphore>,
    session_cap: usize,
    pending_permits: Arc<std::sync::Mutex<HashMap<String, String>>>,
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
        }
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
    args
}

impl ClaudeCodeRunner {
    /// What the live duplex session for `id` was spawned with, if there is one.
    pub async fn resident(&self, id: &SessionId) -> Option<Resident> {
        let map = self.sessions.lock().await;
        let s = map.get(id)?;
        s.stdin.as_ref()?;
        Some(Resident {
            model: s.model.clone(),
            head_sha: s.head_sha.clone(),
        })
    }

    /// Whether this runner holds a session under `id` at all, resident or closed. A session it
    /// does not hold is one it can say nothing about, which is not the same as one that ended.
    pub async fn holds(&self, id: &SessionId) -> bool {
        self.sessions.lock().await.contains_key(id)
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
            sess.pending_inbox = pending;
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

    /// End a live session between turns: EOF on stdin, then let the completion
    /// task reap. Used when the next turn cannot reuse it (a model change), and
    /// when core ends its residency.
    pub async fn close(&self, id: &SessionId) {
        if let Some(s) = self.sessions.lock().await.get_mut(id) {
            s.stdin = None;
        }
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
        let credential =
            match (&spec.credential, &spec.confinement) {
                (Some(handed), _) => handed.0.clone(),
                (None, Some(_)) => return Err(Error::Other(
                    "[CHAT_CONFINEMENT_NO_CREDENTIAL] core asked for this session to hold only \
                     the credential it was handed, and handed none; this box's own PAT is not \
                     put in its place"
                        .into(),
                )),
                (None, None) => mcp::config::job_credential()?,
            };

        let invoked_with_resume = spec.resume_id.is_some();

        let (session_permit, pending_permit) = self.permit_for(&spec).await?;

        let slug = spec.project_slug.as_deref().unwrap_or("");
        let mcp_path = mcp::config::write(
            &self.core_url,
            &credential,
            slug,
            &spec.job_id,
            spec.mcp_servers_override.as_ref(),
        )?;
        let turn_started = Arc::new(tokio::sync::Notify::new());
        let turn_done = Arc::new(tokio::sync::Notify::new());
        let mut child = spawn_claude(&spec, &effective_repo, &credential, &mcp_path).await?;
        tracing::info!("[claude] spawned job={job_id}");
        let session_stdin = Some(write_first_turn(&mut child, &prompt).await?);

        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| Error::Other("no stdout".into()))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| Error::Other("no stderr".into()))?;

        if let Some(pid) = child.id() {
            inflight::record(&job_id, pid);
        }
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        let turn_tx: TurnTx = Arc::new(Mutex::new(tx.clone()));
        self.sessions.lock().await.insert(
            job_id.clone(),
            Session {
                child: Some(child),
                claude_session_id: None,
                stdin: session_stdin,
                turn_tx: turn_tx.clone(),
                turn_started: turn_started.clone(),
                pending_inbox: None,
                turns: 0,
                turn_done: turn_done.clone(),
                model: spec.model.clone(),
                head_sha: None,
                permit: session_permit,
                project_slug: spec.project_slug.clone(),
            },
        );
        // The session row is now the countable record; hand over rather than
        // let both report the same permit.
        drop(pending_permit);

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
            job_id: job_id.clone(),
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
            invoked_with_resume,
            tx,
        }));

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
        let _ = tx.send(RunnerEvent::StateChanged("working")).await;
        *sess.turn_tx.lock().await = tx;
        sess.turn_started.notify_one();
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

/// Spawn `claude` for `spec` in `repo`, its MCP config at `mcp_path`.
async fn spawn_claude(
    spec: &JobSpec,
    repo: &str,
    credential: &str,
    mcp_path: &std::path::Path,
) -> Result<tokio::process::Child> {
    let args = build_args(spec, &mcp_path.to_string_lossy());
    let program = std::ffi::OsStr::new(resolve_claude_bin());
    let made = session_command(spec, program, &args, repo, credential, mcp_path, None).await;
    let mut cmd = match made {
        Ok(cmd) => cmd,
        Err(e) => {
            let _ = std::fs::remove_file(mcp_path);
            return Err(e);
        }
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    cmd.spawn().map_err(|e| {
        let _ = std::fs::remove_file(mcp_path);
        Error::Other(format!("failed to spawn claude: {e}"))
    })
}

/// The command a session runs as. A run inherits this runner's environment and view of the box,
/// with `credential` as its `$FORGE_PAT`; a confined session gets [`confine::chat_sandbox`] and
/// is refused by name where this box cannot confine. `view` stands in for this process's own.
pub(crate) async fn session_command(
    spec: &JobSpec,
    program: &std::ffi::OsStr,
    args: &[String],
    repo: &str,
    credential: &str,
    mcp_path: &std::path::Path,
    view: Option<confine::BoxView>,
) -> Result<tokio::process::Command> {
    let Some(confinement) = &spec.confinement else {
        let mut cmd = build_command_for(program, args, repo);
        cmd.env("FORGE_PAT", credential);
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
        return Ok(cmd);
    };
    let view = match view {
        Some(view) => view,
        None => confine::BoxView::current()?,
    };
    let repo = std::path::Path::new(repo);
    let (git_dirs, git_identity) = confine::read_git(repo).await;
    let handed = confine::Handed {
        repo,
        credential,
        mcp_config: mcp_path,
        reads: &confinement.reads,
        project_slug: spec.project_slug.as_deref(),
        project_id: &spec.project_id,
        git_dirs,
        git_identity,
    };
    let mut cmd = confine::chat_sandbox(&view, &handed).command(program, args)?;
    own_session(&mut cmd);
    Ok(cmd)
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
        };
        let view = confine::BoxView {
            home: repo.clone(),
            inherited: vec![],
            runner_config: None,
            claude_bin: None,
            temp_dir: repo.clone(),
        };
        let made = session_command(
            &spec,
            std::ffi::OsStr::new("claude"),
            &[],
            &repo.to_string_lossy(),
            "t",
            &repo.join("mcp.json"),
            Some(view),
        )
        .await;
        let err = made.expect_err("a confined session was built on a box that cannot confine");
        assert!(
            err.to_string().contains("CHAT_CONFINEMENT_UNAVAILABLE"),
            "the refusal does not name itself: {err}"
        );
    }
}
