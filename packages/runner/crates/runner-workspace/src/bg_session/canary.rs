//! The canary a Claude Code version passes before this box adopts it (ISS-1268 C1): throwaway
//! background sessions in a scratch directory, run through every rule this transport stands on.
//! Checks 1, 2, 3, 6 and 7 are here; 4 and 5 (the permission relay) are the permissions
//! builder's, called through [`super::relay::canary_checks`]. Every session it starts is stopped
//! by its id before it returns, whatever passed.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use super::launch::{self, BgLaunch};
use super::peer::{self, Priority};
use super::roster::{self, BgSession};

/// One check's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: &'static str,
    pub passed: bool,
    pub detail: String,
}

impl Check {
    pub fn pass(name: &'static str, detail: impl Into<String>) -> Self {
        Self {
            name,
            passed: true,
            detail: detail.into(),
        }
    }

    pub fn fail(name: &'static str, detail: impl Into<String>) -> Self {
        Self {
            name,
            passed: false,
            detail: detail.into(),
        }
    }
}

/// What the canary found, and the sessions it started (all stopped).
#[derive(Debug, Clone)]
pub struct Report {
    pub version: String,
    pub checks: Vec<Check>,
    pub sessions: Vec<String>,
}

impl Report {
    /// The first failed check, as Forge is told it: `CLAUDE_CANARY_FAILED: <check>`.
    pub fn failure(&self) -> Option<String> {
        self.checks
            .iter()
            .find(|c| !c.passed)
            .map(|c| format!("CLAUDE_CANARY_FAILED: {} ({})", c.name, c.detail))
    }
}

const TURN_WITHIN: Duration = Duration::from_secs(120);
const STATE_WITHIN: Duration = Duration::from_secs(90);

/// Run the canary for `version` in `scratch`, on `model`.
pub async fn run(version: &str, scratch: &Path, model: &str) -> Report {
    let mut r = Report {
        version: version.to_string(),
        checks: Vec::new(),
        sessions: Vec::new(),
    };
    match super::version::installed().await {
        Ok(v) if v == version => {}
        Ok(v) => {
            r.checks.push(Check::fail(
                "installed version",
                format!("`claude --version` is {v}, not the candidate {version}"),
            ));
            return r;
        }
        Err(e) => {
            r.checks.push(Check::fail("installed version", e));
            return r;
        }
    }
    let ctx = match Ctx::prepare(scratch, model) {
        Ok(c) => c,
        Err(e) => {
            r.checks.push(Check::fail("launch", e));
            return r;
        }
    };
    checks(&ctx, &mut r).await;
    for id in &r.sessions {
        let _ = launch::stop(id).await;
    }
    r
}

async fn checks(ctx: &Ctx, r: &mut Report) {
    let main = match launch_check(ctx, r).await {
        Some(s) => s,
        None => return,
    };
    let peer_ok = peer_checks(ctx, r, &main.session_id).await;
    r.checks
        .extend(super::relay::canary_checks(&ctx.work, model_of(ctx)).await);
    if peer_ok {
        respawn_check(r, &main).await;
    }
    states_check(ctx, r, &main).await;
}

fn model_of(ctx: &Ctx) -> &str {
    &ctx.model
}

/// The scratch a canary runs in: a trusted git checkout and a settings file of its own.
pub struct Ctx {
    pub work: PathBuf,
    pub settings: PathBuf,
    pub model: String,
}

impl Ctx {
    fn prepare(scratch: &Path, model: &str) -> Result<Self, String> {
        let work = scratch.join("work");
        std::fs::create_dir_all(&work).map_err(|e| format!("{}: {e}", work.display()))?;
        let git = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&work)
            .status()
            .map_err(|e| format!("git init: {e}"))?;
        if !git.success() {
            return Err(format!("git init in {} exited {git}", work.display()));
        }
        crate::trust::pre_trust(&work)?;
        let settings = scratch.join("settings.json");
        let doc = launch::settings_doc(&[], &[], super::relay::relay_hooks());
        launch::write_settings(&settings, &doc)?;
        Ok(Self {
            work,
            settings,
            model: model.to_string(),
        })
    }

    fn launch(&self, mode: &str, prompt: &str) -> BgLaunch {
        BgLaunch {
            name: format!("forge-canary-{}", &uuid::Uuid::new_v4().to_string()[..8]),
            cwd: self.work.clone(),
            settings: self.settings.clone(),
            permission_mode: mode.into(),
            model: Some(self.model.clone()),
            prompt: Some(prompt.into()),
            ..BgLaunch::default()
        }
    }
}

/// Check 1: a bypass session starts with no dialog and answers its launch prompt.
async fn launch_check(ctx: &Ctx, r: &mut Report) -> Option<launch::Started> {
    const NAME: &str = "launch";
    let started = match ctx
        .launch(
            "bypassPermissions",
            "Reply with exactly CANARY-READY and nothing else.",
        )
        .start()
        .await
    {
        Ok(s) => s,
        Err(e) => {
            r.checks.push(Check::fail(NAME, e));
            return None;
        }
    };
    r.sessions.push(started.id.clone());
    let watch = watch_until(&started.session_id, TURN_WITHIN, |s, text| {
        s.waiting().is_none() && text.contains("CANARY-READY")
    })
    .await;
    r.checks.push(match watch {
        Ok(seen) if !seen.waited => Check::pass(NAME, format!("{} answered", started.id)),
        Ok(_) => Check::fail(NAME, format!("{} waited on a dialog at launch", started.id)),
        Err(e) => Check::fail(NAME, e),
    });
    Some(started)
}

/// Checks 2 and 3: a peer message is received by its receipt, and acted on under bypass with no
/// dialog (`crossSessionInbound: "accept"`).
async fn peer_checks(_ctx: &Ctx, r: &mut Report, sid: &str) -> bool {
    let sent = peer::send(
        sid,
        "Reply with exactly CANARY-PEER and nothing else.",
        Priority::Next,
    )
    .await;
    match sent {
        Ok(rc) => r.checks.push(Check::pass(
            "peer receipt",
            format!("msg {} in {:?}", rc.msg_id, rc.after),
        )),
        Err(e) => {
            r.checks.push(Check::fail("peer receipt", e.to_string()));
            r.checks.push(Check::fail(
                "crossSessionInbound",
                "no message reached the session",
            ));
            return false;
        }
    }
    let acted = watch_until(sid, TURN_WITHIN, |s, text| {
        s.waiting().is_none() && text.contains("CANARY-PEER\"")
    })
    .await;
    r.checks.push(match acted {
        Ok(seen) if !seen.waited => Check::pass("crossSessionInbound", "acted on with no dialog"),
        Ok(_) => Check::fail(
            "crossSessionInbound",
            "the session held the message behind a dialog",
        ),
        Err(e) => Check::fail("crossSessionInbound", e),
    });
    true
}

/// Check 6: `claude respawn` keeps the conversation under a new process, and a send resolves the
/// new socket by `sessionId`.
async fn respawn_check(r: &mut Report, main: &launch::Started) {
    const NAME: &str = "respawn";
    let before = live(&main.session_id).await.and_then(|s| s.pid);
    if let Err(e) = launch::respawn(&main.id).await {
        r.checks.push(Check::fail(NAME, e));
        return;
    }
    let after = wait_for(&main.session_id, STATE_WITHIN, |s| {
        s.pid.is_some() && s.pid != before
    })
    .await;
    let Some(after) = after else {
        r.checks.push(Check::fail(
            NAME,
            format!("no new process after respawn (was {before:?})"),
        ));
        return;
    };
    let sent = resend(
        &main.session_id,
        "Reply with exactly CANARY-RESPAWNED and nothing else.",
    )
    .await;
    r.checks.push(match sent {
        Ok(rc) if Some(rc.pid) == after.pid => Check::pass(
            NAME,
            format!("pid {before:?} -> {:?}, receipt {}", after.pid, rc.msg_id),
        ),
        Ok(rc) => Check::fail(
            NAME,
            format!("the send reached pid {}, not {:?}", rc.pid, after.pid),
        ),
        Err(e) => Check::fail(NAME, e.to_string()),
    });
}

/// A send to a session just restarted: its new record can take a moment to be written.
async fn resend(sid: &str, body: &str) -> Result<peer::Receipt, peer::Refused> {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match peer::send(sid, body, Priority::Next).await {
            Err(peer::Refused::NoLiveProcess(_)) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await
            }
            other => return other,
        }
    }
}

/// Check 7: each state the roster reports, as the watcher reads them: idle, busy, waiting,
/// done (stopped) and crashed (killed, then restarted under a new pid).
async fn states_check(ctx: &Ctx, r: &mut Report, main: &launch::Started) {
    const NAME: &str = "agents states";
    let mut seen: Vec<&'static str> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    let _ = resend(
        &main.session_id,
        "Run the Bash command `sleep 8`, then reply with exactly CANARY-SLEPT.",
    )
    .await;
    if wait_for(&main.session_id, STATE_WITHIN, |s| {
        s.status.as_deref() == Some("busy")
    })
    .await
    .is_some()
    {
        seen.push("busy");
    } else {
        missing.push("busy".into());
    }
    if wait_for(&main.session_id, TURN_WITHIN, |s| {
        s.status.as_deref() == Some("idle")
    })
    .await
    .is_some()
    {
        seen.push("idle");
    } else {
        missing.push("idle".into());
    }
    match waiting_state(ctx, r).await {
        Ok(()) => seen.extend(["waiting", "done"]),
        Err(e) => missing.push(e),
    }
    match crashed_state(&main.session_id).await {
        Ok(()) => seen.push("crashed"),
        Err(e) => missing.push(e),
    }
    r.checks.push(if missing.is_empty() {
        Check::pass(NAME, seen.join(", "))
    } else {
        Check::fail(
            NAME,
            format!("seen {}; not: {}", seen.join(", "), missing.join("; ")),
        )
    });
}

/// A session outside bypass asked to run a command waits on its prompt, named in `waitingFor`;
/// stopped, it is listed with no process.
async fn waiting_state(ctx: &Ctx, r: &mut Report) -> Result<(), String> {
    let plain = launch::settings_doc(&[], &[], None);
    let settings = ctx.settings.with_file_name("settings.waiting.json");
    launch::write_settings(&settings, &plain)?;
    let mut l = ctx.launch(
        "default",
        "Run the Bash command `touch canary-waiting.txt`.",
    );
    l.settings = settings;
    let s = l.start().await.map_err(|e| format!("waiting: {e}"))?;
    r.sessions.push(s.id.clone());
    let waited = wait_for(&s.session_id, STATE_WITHIN, |x| x.waiting().is_some()).await;
    let _ = launch::stop(&s.id).await;
    let w = waited.ok_or("waiting: never waited on its prompt")?;
    let done = wait_listed(&s.session_id, STATE_WITHIN, |x| !x.is_live()).await;
    done.ok_or("done: still listed with a process after stop")?;
    tracing::info!("[canary] waiting on {:?}", w.waiting_for);
    Ok(())
}

/// Killed outright, the session loses its process: listed with no pid, or already restarted
/// under a new one (measured 2026-11-17: a session killed mid-turn was restarted after about 12 s;
/// one killed idle was not). Which of the two is said.
async fn crashed_state(sid: &str) -> Result<(), String> {
    let pid = live(sid)
        .await
        .and_then(|s| s.pid)
        .ok_or("crashed: no live process to kill")?;
    #[cfg(unix)]
    {
        let raw = i32::try_from(pid).map_err(|e| e.to_string())?;
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(raw),
            nix::sys::signal::Signal::SIGKILL,
        )
        .map_err(|e| format!("crashed: kill -9 {pid}: {e}"))?;
    }
    let after = wait_listed(sid, STATE_WITHIN, |s| s.pid != Some(pid)).await;
    match after {
        Some(s) => {
            tracing::info!(
                "[canary] after kill -9 {pid}: pid {:?}, state {:?}",
                s.pid,
                s.state
            );
            Ok(())
        }
        None => Err(format!(
            "crashed: pid {pid} is still listed as its process after kill -9"
        )),
    }
}

async fn live(sid: &str) -> Option<BgSession> {
    roster::list()
        .await
        .ok()?
        .into_iter()
        .find(|s| s.session_id == sid)
}

async fn wait_for(
    sid: &str,
    within: Duration,
    ok: impl Fn(&BgSession) -> bool,
) -> Option<BgSession> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(s) = live(sid).await.filter(|s| ok(s)) {
            return Some(s);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
    None
}

async fn wait_listed(
    sid: &str,
    within: Duration,
    ok: impl Fn(&BgSession) -> bool,
) -> Option<BgSession> {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        let found = roster::list_all()
            .await
            .ok()
            .and_then(|all| all.into_iter().find(|s| s.session_id == sid));
        if let Some(s) = found.filter(|s| ok(s)) {
            return Some(s);
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    None
}

struct Seen {
    waited: bool,
}

/// Watch `sid` until `done` holds of its roster row and its transcript, noting whether it ever
/// waited on a dialog meanwhile.
async fn watch_until(
    sid: &str,
    within: Duration,
    done: impl Fn(&BgSession, &str) -> bool,
) -> Result<Seen, String> {
    let deadline = Instant::now() + within;
    let mut waited = false;
    while Instant::now() < deadline {
        if let Some(s) = live(sid).await {
            waited |= s.waiting().is_some();
            let text = transcript_text(sid).unwrap_or_default();
            if done(&s, &text) {
                return Ok(Seen { waited });
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    Err(format!(
        "session {sid} did not answer within {within:?}{}",
        if waited {
            ", and waited on a dialog"
        } else {
            ""
        }
    ))
}

fn transcript_text(sid: &str) -> Option<String> {
    let projects = super::claude_dir()?.join("projects");
    let file = format!("{sid}.jsonl");
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|d| d.path().join(&file))
        .find(|p| p.is_file())
        .and_then(|p| std::fs::read_to_string(p).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_failed_check_is_what_forge_is_told_by_name() {
        let r = Report {
            version: "2.1.400".into(),
            checks: vec![
                Check::pass("launch", "ok"),
                Check::fail("peer receipt", "no line"),
                Check::fail("respawn", "x"),
            ],
            sessions: vec![],
        };
        assert_eq!(
            r.failure().as_deref(),
            Some("CLAUDE_CANARY_FAILED: peer receipt (no line)")
        );
    }
}
