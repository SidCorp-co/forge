//! The local socket a master talks to, and why a master may not talk to core.
//!
//! A master is a Claude session on this box. It decides WHICH job runs; the
//! daemon is what actually runs one. Both halves of that have to happen in the
//! same process: the repo lock (`daemon/repo_lock.rs`) and the in-flight map
//! (`runner/inflight.rs`) are in-memory, so a claim made from a second process
//! takes a lock this daemon cannot see and runs a job it cannot cancel, reap or
//! salvage.
//!
//! So the CLI does not claim — it asks here, and the daemon claims and starts
//! the work in one place.
//!
//! Two ops, not one (ISS-919 B2). `prepare` takes the job row and the job token
//! and starts NOTHING; `start` is the spawn. A master can hold a preparation,
//! decide against it and hand it back, which the single irreversible verb this
//! replaced made impossible. The daemon holds the preparation in between and
//! owes the release either way — `Preparations` below is where that debt lives.

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
#[cfg(unix)]
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
#[cfg(unix)]
use tokio::net::{UnixListener, UnixStream};

use crate::config::Config;
#[cfg(unix)]
use crate::daemon::dispatch;
use crate::daemon::repo_lock::RepoLocks;
#[cfg(unix)]
use crate::daemon::InflightGuard;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::transport::pool;
use crate::transport::CoreClient;

/// Where the daemon listens and the CLI connects: beside `config.toml`.
// cm:guard derive this from `Config::path()` and nothing else. dev1 runs several runner services that differ ONLY by `XDG_CONFIG_HOME`, so the config dir is already the thing that separates them; a socket keyed on anything else (a fixed name, the hostname, `XDG_RUNTIME_DIR`) puts two daemons on one path, and a master then reaches whichever bound first — claiming for a project that box is not bound to.
pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    /// Take one job — job row and job token — WITHOUT starting anything.
    // cm:guard the FIELDS need their own `rename_all` — the one on the enum renames variants, not fields. Without it these read `job_id`/`session_id` while the CLI sends camelCase, and every claim comes back "undecodable request".
    #[serde(rename_all = "camelCase")]
    Prepare {
        job_id: String,
        session_id: String,
        // cm:guard the master NAMES the agent, and the name is the worktree branch — core no longer sends one. Keep this `Option` rather than making serde require it: a missing name must come back as `agent_required`, which tells a master what to do, where a required field fails the whole frame as "undecodable request" and names nothing.
        #[serde(default)]
        agent: Option<String>,
    },
    /// Start a job this session already prepared.
    #[serde(rename_all = "camelCase")]
    Start { job_id: String, session_id: String },
    /// Hand back a preparation that will never start.
    #[serde(rename_all = "camelCase")]
    Discard { job_id: String, session_id: String },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimReply {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl ClaimReply {
    fn refused(reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            job_id: None,
            agent_session_id: None,
            issue_key: None,
            reason: Some(reason.into()),
        }
    }
}

pub struct Control {
    pub client: CoreClient,
    pub runner: Arc<ClaudeCodeRunner>,
    pub cfg: Config,
    pub locks: RepoLocks,
    pub inflight: Arc<std::sync::atomic::AtomicUsize>,
    /// Jobs taken and not yet started. See [`Preparations`].
    pub prepared: Preparations,
}

/// How long a preparation may sit before this daemon hands it back.
// cm:guard STRICTLY below core's `MASTER_HOLD_TIMEOUT_MS` (3 minutes), so the daemon that holds the preparation is the one that releases it and the reaper stays the backstop. Above it and the reaper wins the race: the hold comes back while this map still believes it owns the job, and `start` then stamps a job core has already offered to somebody else.
pub const PREPARE_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// The preparations this daemon is holding on a master's behalf.
///
/// B2's debt made explicit: a `prepare` that never becomes a `start` owes the
/// release, and the only process that knows it happened is this one.
// cm:guard the sweep must release through CORE (`pool::release`), not merely drop the entry. Forgetting the map is invisible; forgetting the HOLD parks claimable work on a master that never ran it, which is the exact failure B2 names and the reason a new verb was allowed at all.
#[derive(Clone, Default)]
pub struct Preparations(Arc<std::sync::Mutex<std::collections::HashMap<String, Held>>>);

pub struct Held {
    session_id: String,
    job: pool::ClaimedJob,
    at: std::time::Instant,
}

impl Preparations {
    pub fn new() -> Self {
        Self::default()
    }

    fn put(&self, job: pool::ClaimedJob, session_id: &str) {
        let mut map = self.0.lock().expect("preparations poisoned");
        map.insert(
            job.job_id.clone(),
            Held {
                session_id: session_id.to_string(),
                job,
                at: std::time::Instant::now(),
            },
        );
    }

    // cm:guard the session id is checked HERE, not by the caller. A `start` naming a job another master prepared would spawn that master's work under this one's name, and core cannot catch it: the two look identical on the wire because both hold a valid device token on the same box.
    fn take(&self, job_id: &str, session_id: &str) -> Option<pool::ClaimedJob> {
        let mut map = self.0.lock().expect("preparations poisoned");
        match map.get(job_id) {
            Some(h) if h.session_id == session_id => map.remove(job_id).map(|h| h.job),
            _ => None,
        }
    }

    fn expired(&self, ttl: std::time::Duration) -> Vec<(String, String)> {
        let mut map = self.0.lock().expect("preparations poisoned");
        let now = std::time::Instant::now();
        let stale: Vec<String> = map
            .iter()
            .filter(|(_, h)| now.duration_since(h.at) >= ttl)
            .map(|(k, _)| k.clone())
            .collect();
        stale
            .into_iter()
            .filter_map(|k| map.remove(&k).map(|h| (k, h.session_id)))
            .collect()
    }
}

/// Give back every preparation nobody started, forever.
// cm:guard this loop is not optional bookkeeping — it is the half of B2 that keeps the split from parking work. A daemon that offered `prepare` without it would let a master take ten jobs, start two and strand eight until core's reaper noticed, three minutes at a time.
pub async fn reap_preparations(
    client: CoreClient,
    prepared: Preparations,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) {
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = tick.tick() => {
                for (job_id, session_id) in prepared.expired(PREPARE_TTL) {
                    tracing::warn!(
                        "[control] preparation for job {job_id} was never started — returning it to the pool"
                    );
                    let _ = pool::release(&client, Some(&job_id), &session_id).await;
                }
            }
            _ = cancel.changed() => { if *cancel.borrow() { break; } }
        }
    }
}

/// Serve until `cancel` flips.
// cm:guard REFUSE on a platform with no unix socket, never degrade to a daemon that polls the pool and cannot be claimed from. Under the pool a box runs work only when a master claims through this socket, so a Windows daemon that started anyway would sit online, report healthy, and never run a single job — the exact silent shape `daemon/mod.rs` starts both loops to avoid.
#[cfg(not(unix))]
pub async fn serve(
    _ctl: Arc<Control>,
    _cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "the master control socket needs a unix socket; this platform cannot host a runner that claims work",
    ))
}

#[cfg(unix)]
// cm:guard bind by REPLACING a stale socket file, never by refusing to start. A daemon killed by SIGKILL leaves the file behind, and a runner that then declines to listen is a box that accepts no work with nothing in its log naming the socket as the cause.
pub async fn serve(
    ctl: Arc<Control>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
) -> std::io::Result<()> {
    let Some(path) = socket_path() else {
        return Err(std::io::Error::other(
            "cannot resolve the control socket path",
        ));
    };
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let listener = UnixListener::bind(&path)?;
    tracing::info!("[control] listening on {}", path.display());

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, _)) => {
                        let ctl = ctl.clone();
                        tokio::spawn(async move { serve_one(ctl, stream).await });
                    }
                    Err(e) => tracing::warn!("[control] accept: {e}"),
                }
            }
            _ = cancel.changed() => {
                if *cancel.borrow() { break; }
            }
        }
    }
    let _ = std::fs::remove_file(&path);
    Ok(())
}

#[cfg(unix)]
async fn serve_one(ctl: Arc<Control>, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(Request::Prepare {
            job_id,
            session_id,
            agent,
        }) => prepare(&ctl, &job_id, &session_id, agent.as_deref()).await,
        Ok(Request::Start { job_id, session_id }) => start(&ctl, &job_id, &session_id).await,
        Ok(Request::Discard { job_id, session_id }) => discard(&ctl, &job_id, &session_id).await,
        Err(e) => ClaimReply::refused(format!("undecodable request: {e}")),
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    out.push('\n');
    let _ = reader.get_mut().write_all(out.as_bytes()).await;
}

#[cfg(unix)]
/// Take the job through core and hold it here. Nothing is spawned.
// cm:guard a preparation that arrives and does not start MUST be released. Core clears a hold on `releaseJobFromMaster` or the 3-minute reaper and nothing else, so every early return below either never took the hold or gives it back, and anything that lands in `ctl.prepared` is owed to `reap_preparations`.
async fn prepare(
    ctl: &Arc<Control>,
    job_id: &str,
    session_id: &str,
    agent: Option<&str>,
) -> ClaimReply {
    // cm:guard refuse an unnamed or unusable agent BEFORE the claim, so there is no hold to give back. The name becomes a git branch, and `git worktree add` rejects the bad ones minutes later from inside the spawn — where the failure reads as a broken repo rather than as a master that sent a name with a space in it.
    let agent = match agent.map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) if is_usable_branch_name(a) => a.to_string(),
        Some(a) => return ClaimReply::refused(format!("agent_unusable: {a}")),
        None => return ClaimReply::refused("agent_required"),
    };
    let outcome = match pool::prepare(&ctl.client, job_id, session_id).await {
        Ok(o) => o,
        Err(e) => return ClaimReply::refused(format!("prepare failed: {e}")),
    };
    if !outcome.ok {
        return ClaimReply::refused(outcome.reason.unwrap_or_else(|| "refused".into()));
    }
    let Some(prepared) = outcome.prepared else {
        // cm:guard an `ok:true` with no preparation is a core too old for this runner, and it must be refused LOUDLY with the hold given back. Running the job from the pool entry instead would be the silent substitution the repo forbids: a job started with no prompt, no overrides and no session row.
        let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
        return ClaimReply::refused("core returned no preparation for this claim");
    };

    let agent_session_id = prepared.agent_session_id.clone();
    let issue_key = outcome.issue_key.clone();
    let job = prepared.into_claimed(outcome.job_token, outcome.issue_key, agent);
    let held_job_id = job.job_id.clone();
    ctl.prepared.put(job, session_id);

    ClaimReply {
        ok: true,
        job_id: Some(held_job_id),
        agent_session_id,
        issue_key,
        reason: None,
    }
}

#[cfg(unix)]
/// Stamp the prepared job onto this box and run it.
// cm:guard the spawn happens only AFTER core stamps, and a refused stamp leaves the preparation gone from this map with the hold given back — never a process running against a job core still calls `queued`. The one ordering that must not be inverted: spawn-then-stamp leaves a live agent whose every event comes back 403, which is the epodsystem wedge with the two halves swapped.
async fn start(ctl: &Arc<Control>, job_id: &str, session_id: &str) -> ClaimReply {
    let Some(job) = ctl.prepared.take(job_id, session_id) else {
        return ClaimReply::refused("not_prepared");
    };
    match pool::start(&ctl.client, job_id, session_id).await {
        Ok(o) if o.ok => {}
        Ok(o) => {
            let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
            return ClaimReply::refused(o.reason.unwrap_or_else(|| "refused".into()));
        }
        Err(e) => {
            let _ = pool::release(&ctl.client, Some(job_id), session_id).await;
            return ClaimReply::refused(format!("start failed: {e}"));
        }
    }

    let agent_session_id = job.agent_session_id.clone();
    let issue_key = job.issue_key.clone();
    let started_job_id = job.job_id.clone();

    let (client, runner, cfg, locks) = (
        ctl.client.clone(),
        ctl.runner.clone(),
        ctl.cfg.clone(),
        ctl.locks.clone(),
    );
    let guard = InflightGuard::enter(&ctl.inflight);
    tokio::spawn(async move {
        let _guard = guard;
        if let Err(e) = dispatch::handle(&client, runner, &cfg, &locks, job).await {
            tracing::error!("[dispatch] {e}");
        }
    });

    ClaimReply {
        ok: true,
        job_id: Some(started_job_id),
        agent_session_id,
        issue_key,
        reason: None,
    }
}

#[cfg(unix)]
/// A master changing its mind: hand the preparation back now.
// cm:guard release even when the map has no entry. A master that retries a discard after a timeout must not be told the job is still held, and `releaseJobFromMaster` is a no-op on a job this session does not hold — so the unconditional call is both safe and the only one that cannot leave a hold behind.
async fn discard(ctl: &Arc<Control>, job_id: &str, session_id: &str) -> ClaimReply {
    ctl.prepared.take(job_id, session_id);
    match pool::release(&ctl.client, Some(job_id), session_id).await {
        Ok(_) => ClaimReply {
            ok: true,
            job_id: Some(job_id.to_string()),
            agent_session_id: None,
            issue_key: None,
            reason: None,
        },
        Err(e) => ClaimReply::refused(format!("release failed: {e}")),
    }
}

/// Whether a master's agent name can be a git branch and a directory.
// cm:guard this is deliberately NARROWER than git's own rules. A name that is merely legal to git — `HEAD`, a leading dash, a slash, a unicode homoglyph — still has to be a path component under `.worktrees/` and an argument on a command line, and the master is free to pick another word. Widening it to match `git check-ref-format` buys nothing and re-opens every one of those.
fn is_usable_branch_name(name: &str) -> bool {
    !name.starts_with('-')
        && !name.starts_with('.')
        && !name.contains("..")
        && name.len() <= 60
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Ask a running daemon to take one job without starting it.
#[cfg(not(unix))]
pub async fn request_prepare(
    _path: &std::path::Path,
    _job_id: &str,
    _session_id: &str,
    _agent: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to start a job this session prepared.
#[cfg(not(unix))]
pub async fn request_start(
    _path: &std::path::Path,
    _job_id: &str,
    _session_id: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

/// Ask a running daemon to hand a preparation back.
#[cfg(not(unix))]
pub async fn request_discard(
    _path: &std::path::Path,
    _job_id: &str,
    _session_id: &str,
) -> std::io::Result<ClaimReply> {
    Err(no_socket())
}

#[cfg(not(unix))]
fn no_socket() -> std::io::Error {
    std::io::Error::other(
        "the master control socket needs a unix socket; this platform cannot claim work",
    )
}

#[cfg(unix)]
pub async fn request_prepare(
    path: &std::path::Path,
    job_id: &str,
    session_id: &str,
    agent: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({
            "op": "prepare", "jobId": job_id, "sessionId": session_id, "agent": agent
        }),
    )
    .await
}

#[cfg(unix)]
pub async fn request_start(
    path: &std::path::Path,
    job_id: &str,
    session_id: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "start", "jobId": job_id, "sessionId": session_id }),
    )
    .await
}

#[cfg(unix)]
pub async fn request_discard(
    path: &std::path::Path,
    job_id: &str,
    session_id: &str,
) -> std::io::Result<ClaimReply> {
    ask(
        path,
        serde_json::json!({ "op": "discard", "jobId": job_id, "sessionId": session_id }),
    )
    .await
}

#[cfg(unix)]
async fn ask(path: &std::path::Path, body: serde_json::Value) -> std::io::Result<ClaimReply> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    let mut line = serde_json::to_string(&body).unwrap_or_default();
    line.push('\n');
    reader.get_mut().write_all(line.as_bytes()).await?;
    let mut resp = String::new();
    reader.read_line(&mut resp).await?;
    serde_json::from_str(&resp)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_prepare_request_parses_in_the_shape_the_cli_sends() {
        let raw = r#"{"op":"prepare","jobId":"j1","sessionId":"s1","agent":"catalog-sweep"}"#;
        match serde_json::from_str::<Request>(raw).expect("must parse") {
            Request::Prepare {
                job_id,
                session_id,
                agent,
            } => {
                assert_eq!(agent.as_deref(), Some("catalog-sweep"));
                assert_eq!(job_id, "j1");
                assert_eq!(session_id, "s1");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    // cm:guard the two ops must stay SEPARATE on the wire, which is the whole of B2. A `start` that carried an agent name would be a claim wearing two words, and the master could no longer take a job, look at it and hand it back.
    #[test]
    fn start_and_discard_name_a_job_this_session_already_holds() {
        match serde_json::from_str::<Request>(r#"{"op":"start","jobId":"j1","sessionId":"s1"}"#)
            .expect("must parse")
        {
            Request::Start { job_id, session_id } => {
                assert_eq!((job_id.as_str(), session_id.as_str()), ("j1", "s1"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match serde_json::from_str::<Request>(r#"{"op":"discard","jobId":"j1","sessionId":"s1"}"#)
            .expect("must parse")
        {
            Request::Discard { job_id, .. } => assert_eq!(job_id, "j1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    // cm:guard the daemon must release what it holds BEFORE core's three-minute reaper does, or the reaper hands the job to somebody else while this map still believes it owns it — and the next `start` stamps a job that is already running one box over.
    #[test]
    fn the_daemon_gives_a_preparation_back_before_cores_reaper_would() {
        assert!(
            PREPARE_TTL < std::time::Duration::from_secs(180),
            "PREPARE_TTL must stay under core's MASTER_HOLD_TIMEOUT_MS"
        );
    }

    // cm:guard a refusal must serialise WITHOUT the success fields rather than with nulls — the master reads this JSON, and a `jobId: null` beside `ok: false` reads as a job that exists and failed rather than a claim that never landed.
    #[test]
    fn a_refusal_carries_a_reason_and_no_job() {
        let out = serde_json::to_string(&ClaimReply::refused("issue_busy")).unwrap();
        assert!(out.contains("\"reason\":\"issue_busy\""));
        assert!(!out.contains("jobId"));
        assert!(out.contains("\"ok\":false"));
    }

    /// A claim with no agent name must be REFUSED, not silently run in the
    /// repo root — that was the shape core's `worktreeBranch` payload used to
    /// prevent, and nothing replaces it but this.
    #[test]
    fn a_claim_with_no_agent_name_still_parses_so_it_can_be_refused_by_name() {
        let raw = r#"{"op":"prepare","jobId":"j1","sessionId":"s1"}"#;
        match serde_json::from_str::<Request>(raw).expect("must parse") {
            Request::Prepare { agent, .. } => assert!(agent.is_none()),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn a_name_that_would_break_git_or_the_path_is_not_usable() {
        for good in ["catalog-sweep", "ISS-175", "epod_billing.v2"] {
            assert!(is_usable_branch_name(good), "{good} should be usable");
        }
        for bad in [
            "-force",
            ".hidden",
            "a..b",
            "has space",
            "a/b",
            "héllo",
            "HEAD~1",
        ] {
            assert!(!is_usable_branch_name(bad), "{bad} must be refused");
        }
        assert!(!is_usable_branch_name(&"x".repeat(61)));
    }
}
