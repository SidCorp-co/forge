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

use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::config::Config;
use crate::daemon::dispatch;
use crate::daemon::repo_lock::RepoLocks;
use crate::daemon::InflightGuard;
use crate::runner::claude_code::ClaudeCodeRunner;
use crate::transport::{pool, CoreClient};

/// Where the daemon listens and the CLI connects: beside `config.toml`.
// cm:guard derive this from `Config::path()` and nothing else. dev1 runs several runner services that differ ONLY by `XDG_CONFIG_HOME`, so the config dir is already the thing that separates them; a socket keyed on anything else (a fixed name, the hostname, `XDG_RUNTIME_DIR`) puts two daemons on one path, and a master then reaches whichever bound first — claiming for a project that box is not bound to.
pub fn socket_path() -> Option<PathBuf> {
    let cfg = Config::path().ok()?;
    Some(cfg.with_file_name("control.sock"))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Request {
    /// Claim one job and start it here.
    // cm:guard the FIELDS need their own `rename_all` — the one on the enum renames variants, not fields. Without it these read `job_id`/`session_id` while the CLI sends camelCase, and every claim comes back "undecodable request".
    #[serde(rename_all = "camelCase")]
    Claim { job_id: String, session_id: String },
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
}

/// Serve until `cancel` flips.
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

async fn serve_one(ctl: Arc<Control>, stream: UnixStream) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    if reader.read_line(&mut line).await.is_err() {
        return;
    }
    let reply = match serde_json::from_str::<Request>(&line) {
        Ok(Request::Claim { job_id, session_id }) => {
            claim_and_start(&ctl, &job_id, &session_id).await
        }
        Err(e) => ClaimReply::refused(format!("undecodable request: {e}")),
    };
    let mut out = serde_json::to_string(&reply).unwrap_or_else(|_| "{\"ok\":false}".into());
    out.push('\n');
    let _ = reader.get_mut().write_all(out.as_bytes()).await;
}

/// Claim through core, then run the job here.
// cm:guard a preparation that arrives and does not start MUST be released. Core clears a hold on `releaseJobFromMaster` or the 3-minute reaper and nothing else, so returning early on a spawn failure without the release parks a claimable job on a master that never ran it.
async fn claim_and_start(ctl: &Arc<Control>, job_id: &str, session_id: &str) -> ClaimReply {
    let outcome = match pool::claim(&ctl.client, job_id, session_id).await {
        Ok(o) => o,
        Err(e) => return ClaimReply::refused(format!("claim failed: {e}")),
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
    let job = prepared.into_claimed(outcome.job_token, outcome.issue_key.clone());
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
        issue_key: outcome.issue_key,
        reason: None,
    }
}

/// Ask a running daemon to claim and start one job.
pub async fn request_claim(
    path: &std::path::Path,
    job_id: &str,
    session_id: &str,
) -> std::io::Result<ClaimReply> {
    let stream = UnixStream::connect(path).await?;
    let mut reader = BufReader::new(stream);
    let body = serde_json::json!({ "op": "claim", "jobId": job_id, "sessionId": session_id });
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
    fn a_claim_request_parses_in_the_shape_the_cli_sends() {
        let raw = r#"{"op":"claim","jobId":"j1","sessionId":"s1"}"#;
        match serde_json::from_str::<Request>(raw).expect("must parse") {
            Request::Claim { job_id, session_id } => {
                assert_eq!(job_id, "j1");
                assert_eq!(session_id, "s1");
            }
        }
    }

    // cm:guard a refusal must serialise WITHOUT the success fields rather than with nulls — the master reads this JSON, and a `jobId: null` beside `ok: false` reads as a job that exists and failed rather than a claim that never landed.
    #[test]
    fn a_refusal_carries_a_reason_and_no_job() {
        let out = serde_json::to_string(&ClaimReply::refused("issue_busy")).unwrap();
        assert!(out.contains("\"reason\":\"issue_busy\""));
        assert!(!out.contains("jobId"));
        assert!(out.contains("\"ok\":false"));
    }
}
