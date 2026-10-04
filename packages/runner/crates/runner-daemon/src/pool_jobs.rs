//! Bringing a pool job to life on this box, and staying with it.
//!
//! Core has minted `smoke` and `release_batch`
//! into a JOBS pool since ISS-933 and published a `master.wake` on every one.
//! Three annotations in core say the box reads that pool for itself —
//! `pool-routes.ts` on `GET /me/pool`, `ws/master-wake.ts` on the wake, and
//! `prepare-claimed-job.ts` pointing a contract edge at `daemon/dispatch.rs`.
//! No box ever did. A release sat `queued` with `gateReason: null` while its
//! whole roster waited at `releasing` (ISS-1080).
//!
//! This is that reader. It is NOT the job runner ISS-933 deleted: there is no
//! job token, no event drain, no salvage and no exit-code channel. A job here
//! is a prompt core already built, a pane, and one question asked once a tick —
//! is this job still mine — whose answer core already gives by name.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{control, session_tokens};
use runner_core::agent_activity::{now_ms, Activities, Activity};
use runner_core::job_exit;
use runner_core::job_unheard;
use runner_core::transcript_age;
use runner_core::turn_evidence::{self, Evidence, Watch};
use runner_platform::error::{Error, Result};
use runner_transport::events::{self, JobEventInput};
use runner_transport::mcp_servers::{self, ProjectMcpServers};
use runner_transport::pool::{self, PoolEntry, Prepared, ReadFailure, Started};
use runner_transport::{lifecycle, CoreClient};
use runner_workspace::hook_install;
use runner_workspace::terminal;

/// What the box may read, take, start and give back.
#[async_trait::async_trait]
pub trait Pool: Send + Sync {
    /// A read that failed is a [`ReadFailure`] and never an empty list (ISS-1234).
    async fn claimable(&self, project_id: &str)
        -> std::result::Result<Vec<PoolEntry>, ReadFailure>;
    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared>;
    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started>;
    async fn release(&self, job_id: &str, session_id: &str) -> Result<()>;
    /// The MCP servers this project declares, resolved, which a job pane is started with exactly
    /// as a master pane is. A read that failed is an error and never an empty declaration: a pane
    /// started on that reading carries none of what the project declared (ISS-1235, ISS-1347).
    async fn mcp_servers(&self, project_id: &str) -> Result<ProjectMcpServers>;
}

#[async_trait::async_trait]
pub trait Report: Send + Sync {
    async fn ack(&self, job_id: &str) -> Result<()>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    ///
    /// `runtime_state` is what the box knows the agent to be doing, or `None`
    /// where it knows nothing about it at all.
    async fn progress(&self, job_id: &str, runtime_state: Option<&str>) -> Result<bool>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    async fn fail(&self, job_id: &str, error: &str) -> Result<bool>;
}

#[async_trait::async_trait]
pub trait Records: Send + Sync {
    async fn note(&self, live: &Live);
    async fn forget(&self, job_id: &str);
    async fn all(&self) -> Vec<Live>;
}

/// The pane a job runs in.
#[async_trait::async_trait]
pub trait Panes: Send + Sync {
    /// Start the pane as `launch` says, refusing where it cannot be.
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
        launch: &Launch<'_>,
    ) -> Result<()>;
    /// This box has let go of the job this pane ran: whatever `open` wrote for it goes.
    async fn released(&self, name: &str);
    /// Whether tmux answered that it holds no pane by this name. A question it
    /// could not answer is not an ending, so it is not `gone` (ISS-1312).
    async fn gone(&self, name: &str) -> bool;
    async fn kill(&self, name: &str) -> Result<()>;
    /// Every job pane on this box right now, by name.
    async fn names(&self) -> Vec<String>;
}

/// What a job pane is started with beyond where it runs and what it is told: the project's
/// declared servers, and the model and denied tools of the policy state core prepared it under.
pub struct Launch<'a> {
    pub servers: &'a serde_json::Map<String, serde_json::Value>,
    pub model: &'a str,
    pub denied_tools: &'a [String],
}

const HEARTBEAT_KIND: &str = "progress";

/// One job this box is running, the pane it is running in, what this box may
/// conclude from that pane's silence, and what the last sweep read of its
/// agent.
///
/// `seen` is on the record rather than only in memory because `Activities` is
/// in memory: after a restart a pane that went quiet BEFORE it never reports
/// again, and without the snapshot it reads as a session that has said nothing
/// — kept for the rest of its life by the rule meant to protect a pane that is
/// mid-turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub job_id: String,
    pub pane: String,
    pub watch: Watch,
    pub seen: Option<job_exit::Reported>,
    /// Where the pane's conversation is written, as its hooks last named it.
    /// On the record for the same reason `seen` is: a pane whose `Stop` was
    /// lost across a restart never speaks to the next daemon, and this path is
    /// the only thing that daemon can age it by (ISS-1244).
    pub transcript: Option<String>,
    /// When this box opened the pane, which is when the slot was taken. On the
    /// record so the age a person reads survives the daemon that counted it;
    /// `None` on a record a daemon before this field wrote.
    pub opened_at: Option<i64>,
}

/// One held slot, and since when this daemon has been counting it.
#[derive(Debug, Clone)]
struct Held {
    pane: String,
    watch: Watch,
    seen: Option<job_exit::Reported>,
    transcript: Option<String>,
    /// When this daemon began counting the pane — the adoption, for one it
    /// adopted, and never the pane's own start. It is the only instant this
    /// box's own silence can be measured from, which is what `job_unheard`
    /// reads it for: a pane's delivery belongs to whichever daemon briefed it
    /// and is persisted nowhere. A reading that wants the slot's age ACROSS a
    /// restart wants a second value rather than this one, which carried across
    /// would conclude an adopted pane the instant it was adopted.
    noted_at: i64,
    /// That second value: when this box opened the pane, off its record.
    opened_at: Option<i64>,
}

/// A slot this box is holding, for the one line an operator reads when it can
/// take no more work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holding {
    pub job_id: String,
    pub pane: String,
    /// What this box may conclude from the pane's silence, which is also where
    /// the session its hooks report under is read from.
    pub watch: Watch,
    /// What the last sweep read of this agent, which is what `job_exit` will
    /// answer on where the session has said nothing in THIS daemon. A reader
    /// told a pane has reported nothing, while the next sweep is about to
    /// conclude it finished, has been handed two answers to one question.
    pub seen: Option<job_exit::Reported>,
    /// Where the pane's conversation is written, which the line reads the
    /// last write of exactly as the sweep does.
    pub transcript: Option<String>,
    /// When this daemon began counting the pane, which for one it adopted is
    /// the adoption and not the pane's own start.
    pub noted_at: i64,
    /// When this box opened the pane, where its record says; the age of the
    /// slot across any restart.
    pub opened_at: Option<i64>,
}

pub struct JobPanes {
    inner: Mutex<HashMap<String, Held>>,
    session_id: String,
    swept_at: Mutex<Option<i64>>,
    /// Which set of jobs this box has already said is holding every slot, so
    /// the condition is stated on its edges rather than on every pass. It
    /// lives here because it is a fact about this registry and nothing else
    /// reads it.
    said_at_bound: Mutex<Option<String>>,
}

impl Default for JobPanes {
    fn default() -> Self {
        Self::new()
    }
}

impl JobPanes {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
            session_id: uuid::Uuid::new_v4().to_string(),
            swept_at: Mutex::new(None),
            said_at_bound: Mutex::new(None),
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The same, carrying what a previous daemon's sweep read of this agent,
    /// where its conversation is written and when the pane was opened, where
    /// anything knows.
    pub fn hold(
        &self,
        job_id: &str,
        pane: &str,
        watch: Watch,
        seen: Option<job_exit::Reported>,
        transcript: Option<String>,
        opened_at: Option<i64>,
    ) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let now = now_ms();
        map.entry(job_id.to_string())
            .and_modify(|h| {
                h.pane = pane.to_string();
                h.watch = watch.clone();
                h.seen = seen;
                h.transcript = transcript.clone();
                h.opened_at = h.opened_at.or(opened_at);
            })
            .or_insert_with(|| Held {
                pane: pane.to_string(),
                watch,
                seen,
                transcript,
                noted_at: now,
                opened_at,
            });
    }

    /// That a supervision sweep ran to the end. Read where the box is refusing
    /// work, because the slot's return depends on this sweep and a design that
    /// leans on a sweep has to say when the sweep last ran.
    pub fn swept(&self) {
        if let Ok(mut at) = self.swept_at.lock() {
            *at = Some(now_ms());
        }
    }

    pub fn last_swept(&self) -> Option<i64> {
        self.swept_at.lock().ok().and_then(|at| *at)
    }

    /// What this box last said was holding every one of its slots, and what it
    /// is saying now. `None` in, `None` out clears the memo.
    pub fn said_at_bound(&self, now: Option<String>) -> Option<String> {
        let Ok(mut said) = self.said_at_bound.lock() else {
            return None;
        };
        std::mem::replace(&mut said, now)
    }

    /// What is holding this box's slots right now.
    pub fn holding(&self) -> Vec<Holding> {
        let Ok(map) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out: Vec<Holding> = map
            .iter()
            .map(|(job_id, h)| Holding {
                job_id: job_id.clone(),
                pane: h.pane.clone(),
                watch: h.watch.clone(),
                seen: h.seen,
                transcript: h.transcript.clone(),
                noted_at: h.noted_at,
                opened_at: h.opened_at,
            })
            .collect();
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }

    pub fn forget(&self, job_id: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(job_id);
        }
    }

    pub fn live(&self) -> Vec<Live> {
        let Ok(map) = self.inner.lock() else {
            return Vec::new();
        };
        let mut out: Vec<Live> = map
            .iter()
            .map(|(job_id, h)| Live {
                job_id: job_id.clone(),
                pane: h.pane.clone(),
                watch: h.watch.clone(),
                seen: h.seen,
                transcript: h.transcript.clone(),
                opened_at: h.opened_at,
            })
            .collect();
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }

    pub fn count(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    /// When this daemon began counting one job's pane. `None` once the slot is
    /// back, which a caller reads as a pane there is nothing left to conclude.
    pub fn noted_at(&self, job_id: &str) -> Option<i64> {
        let map = self.inner.lock().ok()?;
        map.get(job_id).map(|h| h.noted_at)
    }
}

/// Where a session's conversation is written. What this daemon has heard wins
/// outright, a path it holds none of included: a session heard here that names
/// no transcript has moved to a conversation the record's path does not belong
/// to, or never named one. Only a session this daemon has heard nothing from
/// is answered off the record a previous daemon left.
pub fn transcript_of(said: Option<&Activity>, recorded: Option<&str>) -> Option<String> {
    match said {
        Some(a) => a.transcript.clone(),
        None => recorded.map(str::to_string),
    }
}

/// The newest write to that transcript. `None` where there is no path or
/// nothing under it can be read — no evidence, never silence.
pub fn written_at(said: Option<&Activity>, recorded: Option<&str>) -> Option<i64> {
    let path = transcript_of(said, recorded)?;
    transcript_age::last_written(Path::new(&path))
}

/// The pane name a job runs under, and the only shape `adopt` can read back.
pub fn pane_name(job_id: &str) -> String {
    terminal::session_name(terminal::JOB_PREFIX, job_id)
}

fn job_id_of(pane: &str) -> Option<String> {
    let suffix = pane.strip_prefix(terminal::JOB_PREFIX)?.strip_prefix('-')?;
    (!suffix.is_empty()).then(|| suffix.to_string())
}

/// What a restart found: the jobs still running here, and the ones that died with
/// the daemon.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Adopted {
    /// Panes that outlived the last daemon and are now supervised again.
    pub alive: usize,
    /// Jobs this box had started whose pane is gone, reported to core by name.
    pub buried: usize,
}

pub async fn adopt(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
) -> Adopted {
    let mut out = Adopted::default();
    let recorded = records.all().await;
    let live: Vec<String> = panes.names().await;

    for rec in &recorded {
        if live.contains(&rec.pane) {
            continue;
        }
        let reason = format!(
            "the job's pane `{}` did not survive a restart of the runner daemon",
            rec.pane
        );
        match report.fail(&rec.job_id, &reason).await {
            Ok(_) => {
                panes.released(&rec.pane).await;
                records.forget(&rec.job_id).await;
                out.buried += 1;
                tracing::warn!(
                    "[pool] job {} did not survive the restart — reported to core",
                    rec.job_id
                );
            }
            Err(e) => {
                registry.hold(
                    &rec.job_id,
                    &rec.pane,
                    Watch::Unhooked,
                    None,
                    None,
                    rec.opened_at,
                );
                tracing::warn!(
                    "[pool] job {} did not survive the restart and core could not be told: {e} — the supervisor will keep sending it",
                    rec.job_id
                );
            }
        }
    }

    for name in live {
        let Some(job_id) = job_id_of(&name) else {
            continue;
        };
        // What the last daemon's sweep left on this job's record is the whole
        // of what this one knows about its agent until the pane's own hooks
        // speak again.
        let held = recorded.iter().find(|r| r.job_id == job_id);
        let watch = match held.and_then(|r| r.watch.session_id()) {
            Some(session) => Watch::Adopted {
                session_id: session.to_string(),
            },
            None => Watch::Unhooked,
        };
        let seen = held.and_then(|r| r.seen);
        let adopted = Live {
            job_id,
            pane: name,
            watch,
            seen,
            transcript: held.and_then(|r| r.transcript.clone()),
            opened_at: held.and_then(|r| r.opened_at),
        };
        registry.hold(
            &adopted.job_id,
            &adopted.pane,
            adopted.watch.clone(),
            adopted.seen,
            adopted.transcript.clone(),
            adopted.opened_at,
        );
        records.note(&adopted).await;
        out.alive += 1;
    }

    if out.alive > 0 || out.buried > 0 {
        tracing::info!(
            "[pool] restart: {} job pane(s) adopted, {} job(s) reported dead",
            out.alive,
            out.buried
        );
    }
    out
}

/// Why this box took nothing from the pool this pass.
#[derive(Debug, PartialEq, Eq)]
pub enum Took {
    Started(String),
    NothingClaimable,
    /// The pool could not be read, so nothing is known about what it holds.
    /// An empty pool is `NothingClaimable`; this is the box blind to its queue.
    Unread(ReadFailure),
    AtBound,
    Refused(String),
    /// The read succeeded and the preparation call failed; the reason names
    /// its status. Nothing was held, so there is nothing to give back.
    PrepareFailed(String),
    /// A preparation this box could not turn into a pane; the hold is back.
    GaveBack(String),
    /// The stamp neither succeeded nor was refused — the pane stays and the next
    /// supervision tick asks core whose job it is.
    Unresolved(String),
}

/// The four boundaries a claim crosses: the pool it reads, the terminal a
/// pane starts in, core's record of what was placed, and this box's own.
#[derive(Clone, Copy)]
pub struct JobPorts<'a> {
    pub pool: &'a dyn Pool,
    pub panes: &'a dyn Panes,
    pub report: &'a dyn Report,
    pub records: &'a dyn Records,
}

/// The project a job is taken for: its id, and the slug an operator knows it
/// by, which the pane's capability record carries (ISS-1316 criterion 20).
///
/// One struct rather than two parameters because `take_one` sits at exactly
/// the argument count `clippy::too_many_arguments` allows.
#[derive(Debug, Clone, Copy)]
pub struct ServedProject<'a> {
    pub id: &'a str,
    pub slug: &'a str,
}

pub async fn take_one(
    ports: &JobPorts<'_>,
    registry: &JobPanes,
    project: ServedProject<'_>,
    session_id: &str,
    bound: usize,
    tokens: Option<&session_tokens::SessionTokens>,
) -> Took {
    let JobPorts {
        pool: pool_ports,
        panes,
        report,
        records,
    } = *ports;
    let project_id = project.id;
    if registry.count() >= bound {
        return Took::AtBound;
    }
    let entries = match pool_ports.claimable(project_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(
                "[pool] {project_id}: cannot read the pool — its queue is UNREAD, not empty: {e}"
            );
            return Took::Unread(e);
        }
    };
    let Some(entry) = entries.into_iter().next() else {
        return Took::NothingClaimable;
    };

    let prepared = match pool_ports.prepare(&entry.job_id, session_id).await {
        Ok(Prepared::Took(p)) => p,
        Ok(Prepared::Refused(r)) => {
            tracing::info!(
                "[pool] {project_id}: job {} not taken: {}",
                entry.job_id,
                r.describe()
            );
            return Took::Refused(r.as_str().to_string());
        }
        Err(e) => {
            tracing::warn!("[pool] {project_id}: prepare failed: {e}");
            return Took::PrepareFailed(e.to_string());
        }
    };

    let pane = pane_name(&prepared.job_id);
    let Some(cwd) = prepared.repo_path.as_deref().map(PathBuf::from) else {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} given back — core prepared it with no checkout, so this device's binding to {} names none; bind one with `forge-runner bind {} --path <dir>`",
            prepared.job_id,
            project.slug,
            project.slug
        );
        return Took::GaveBack(prepared.job_id);
    };
    if !cwd.is_dir() {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} given back — this box's device binding to {} names {}, which is not a directory here; rebind with `forge-runner bind {} --path <dir>`",
            prepared.job_id,
            project.slug,
            cwd.display(),
            project.slug
        );
        return Took::GaveBack(prepared.job_id);
    }

    let Some(prompt) = prepared
        .prompt_string
        .clone()
        .filter(|p| !p.trim().is_empty())
    else {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} was prepared with no prompt — given back",
            prepared.job_id
        );
        return Took::GaveBack(prepared.job_id);
    };

    let declared = match pool_ports.mcp_servers(project_id).await {
        Ok(declared) => declared,
        Err(e) => {
            give_back(pool_ports, &prepared.job_id, session_id).await;
            tracing::error!(
                "[pool] {project_id}: job {} given back — this box could not read the project's declared MCP servers ({e}), and a pane started now would carry none of them",
                prepared.job_id
            );
            return Took::GaveBack(prepared.job_id);
        }
    };

    let (env, channel) = open_channel(
        &cwd,
        &prepared.agent_session_id,
        project_id,
        project.slug,
        &pane,
        tokens,
        control::HOOKS_CAN_REPORT,
    );

    let opened_at = now_ms();
    if let Err(e) = panes
        .open(
            &pane,
            &cwd,
            &prompt,
            &env,
            &Launch {
                servers: &declared.mcp_servers,
                model: &prepared.model,
                denied_tools: &prepared.denied_tools,
            },
        )
        .await
    {
        panes.released(&pane).await;
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!("[pool] {project_id}: could not open {pane}: {e} — hold given back");
        return Took::GaveBack(prepared.job_id);
    }
    let watch = match channel {
        Some(session) => Watch::Hooked {
            session_id: session,
            delivered_at: now_ms(),
        },
        None => Watch::Unhooked,
    };

    let opened = Live {
        job_id: prepared.job_id.clone(),
        pane: pane.clone(),
        watch: watch.clone(),
        seen: None,
        transcript: None,
        opened_at: Some(opened_at),
    };
    records.note(&opened).await;

    match pool_ports.start(&prepared.job_id, session_id).await {
        Ok(Started::Ok) => {}
        Ok(Started::Refused(r)) => {
            let _ = panes.kill(&pane).await;
            panes.released(&pane).await;
            records.forget(&prepared.job_id).await;
            tracing::warn!(
                "[pool] {project_id}: start refused for job {} ({}) — pane {pane} killed",
                prepared.job_id,
                r.as_str()
            );
            return Took::Refused(r.as_str().to_string());
        }
        Err(e) => {
            registry.hold(&prepared.job_id, &pane, watch, None, None, opened.opened_at);
            tracing::error!(
                "[pool] {project_id}: start for job {} did not answer ({e}) — pane {pane} kept, and the next tick asks core whose job it is",
                prepared.job_id
            );
            return Took::Unresolved(prepared.job_id);
        }
    }

    registry.hold(&prepared.job_id, &pane, watch, None, None, opened.opened_at);
    if let Err(e) = report.ack(&prepared.job_id).await {
        tracing::warn!("[pool] ack for job {} failed: {e}", prepared.job_id);
    }
    tracing::info!(
        "[pool] {project_id}: job {} ({}) running in {pane}, carrying {}",
        prepared.job_id,
        prepared.job_type,
        if declared.resolved_names.is_empty() {
            "no declared MCP servers".to_string()
        } else {
            declared.resolved_names.join(", ")
        }
    );
    Took::Started(prepared.job_id)
}

/// Register this daemon's hooks for a job pane, saying what it did. `false`
/// where the pane has to start unhooked; the resolution is handed in so both of
/// its arms are reachable from a test.
fn install_pane_hooks(
    cwd: &Path,
    project_id: &str,
    pane: &str,
    own: runner_platform::error::Result<runner_platform::exe::OwnExe>,
) -> bool {
    let exe = match own {
        Ok(exe) => exe,
        Err(e) => {
            tracing::error!(
                "[pool] {project_id}: {e} — {pane} starts with no hooks rather than commands that die at every call, blind to its own turn boundaries"
            );
            return false;
        }
    };
    if let Some(was) = &exe.replaced_from {
        tracing::warn!(
            "[pool] {project_id}: the binary this daemon started on ({}) was replaced while it ran — {pane}'s hooks name {}, the build standing there now",
            was.display(),
            exe.path.display()
        );
    }
    if let Err(e) = hook_install::install(cwd, &exe.path) {
        tracing::error!(
            "[pool] {project_id}: could not register hooks in {} ({e}) — {pane} starts blind to its own turn boundaries",
            cwd.display()
        );
        return false;
    }
    true
}

fn open_channel(
    cwd: &Path,
    agent_session_id: &str,
    project_id: &str,
    slug: &str,
    pane: &str,
    tokens: Option<&session_tokens::SessionTokens>,
    hooks_can_report: bool,
) -> (Vec<(String, String)>, Option<String>) {
    let env = terminal::pane_env();
    if !hooks_can_report {
        tracing::info!(
            "[pool] {project_id}: this platform hosts no control socket — {pane} starts unhooked, and nothing will be concluded from its silence"
        );
        return (env, None);
    }
    if agent_session_id.is_empty() {
        tracing::error!(
            "[pool] {project_id}: {pane} was prepared with no agent session id — this box cannot tell whether its agent ever starts, and will never fail it for silence"
        );
        return (env, None);
    }
    if !install_pane_hooks(cwd, project_id, pane, runner_platform::exe::own()) {
        return (env, None);
    }
    let Some(store) = tokens else {
        tracing::error!(
            "[pool] {project_id}: cannot resolve the control token map — {pane} starts with no capability and its hooks will be refused"
        );
        return (env, None);
    };
    match store.mint(agent_session_id, project_id, slug, pane) {
        Ok(token) => {
            let mut env = env;
            env.push((session_tokens::TOKEN_ENV.to_string(), token));
            (env, Some(agent_session_id.to_string()))
        }
        Err(e) => {
            tracing::error!(
                "[pool] {project_id}: cannot mint a control capability for {pane} ({e}) — it starts with no way to report a turn"
            );
            (env, None)
        }
    }
}

async fn give_back(pool_ports: &dyn Pool, job_id: &str, session_id: &str) {
    if let Err(e) = pool_ports.release(job_id, session_id).await {
        tracing::warn!("[pool] could not give job {job_id} back: {e} — the reaper will collect it");
    }
}

pub async fn supervise(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
    activity: &Activities,
) {
    let now = now_ms();
    for live in registry.live() {
        if panes.gone(&live.pane).await {
            let reason = format!(
                "the job's pane `{}` ended without reporting an outcome",
                live.pane
            );
            if let Err(e) = report.fail(&live.job_id, &reason).await {
                tracing::warn!(
                    "[pool] could not tell core job {} lost its pane: {e} — sending it again next tick",
                    live.job_id
                );
                continue;
            }
            panes.released(&live.pane).await;
            registry.forget(&live.job_id);
            records.forget(&live.job_id).await;
            tracing::warn!("[pool] job {} lost its pane {}", live.job_id, live.pane);
            continue;
        }
        let said = live.watch.session_id().and_then(|s| activity.get(s));
        let evidence = turn_evidence::read(
            &live.watch,
            said.as_ref()
                .map(|a| turn_evidence::Reported { prompts: a.prompts }),
            now,
        );
        if let Evidence::NeverStarted { silent_for } = evidence {
            let reason = turn_evidence::never_started_reason(&live.pane, silent_for);
            if conclude(panes, report, records, registry, &live, reason).await {
                continue;
            }
        }
        // What this session has said in THIS daemon wins; the snapshot a
        // previous one left answers for a pane that went quiet before the
        // restart and will never speak again. A pane with neither is a session
        // this box knows nothing about, and `job_exit` keeps it.
        let seen = said.as_ref().map(job_exit::Reported::of).or(live.seen);
        let transcript = transcript_of(said.as_ref(), live.transcript.as_deref());
        if seen != live.seen || transcript != live.transcript {
            records
                .note(&Live {
                    seen,
                    transcript: transcript.clone(),
                    ..live.clone()
                })
                .await;
            registry.hold(
                &live.job_id,
                &live.pane,
                live.watch.clone(),
                seen,
                transcript.clone(),
                live.opened_at,
            );
        }
        let written_at = transcript
            .as_deref()
            .and_then(|p| transcript_age::last_written(Path::new(p)));
        if let Some(reason) =
            job_exit::verdict(&live.watch, seen, written_at, now).reason(&live.pane)
        {
            if conclude(panes, report, records, registry, &live, reason).await {
                continue;
            }
        }
        // Last, and only for the pane the two readings above have each
        // correctly declined: one this box knows nothing whatever about, which
        // neither of them can ever conclude.
        let watching_since = registry.noted_at(&live.job_id).unwrap_or(now);
        if let Some(reason) = job_unheard::verdict(seen, watching_since, now).reason(&live.pane) {
            if conclude(panes, report, records, registry, &live, reason).await {
                continue;
            }
        }
        match report
            .progress(&live.job_id, evidence.runtime_state())
            .await
        {
            Ok(true) => {}
            Ok(false) => {
                let _ = panes.kill(&live.pane).await;
                panes.released(&live.pane).await;
                registry.forget(&live.job_id);
                records.forget(&live.job_id).await;
                tracing::info!(
                    "[pool] job {} is terminal — {} closed",
                    live.job_id,
                    live.pane
                );
            }
            Err(e) => tracing::warn!("[pool] progress for job {}: {e}", live.job_id),
        }
    }
    registry.swept();
}

/// End a job this box has decided is not work in flight: tell core by name,
/// close the pane, and let go of the slot. `true` once the slot is back.
///
/// Every reading that can end a job comes through here, because the slot
/// returns on `registry.forget` and nowhere else.
async fn conclude(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
    live: &Live,
    reason: String,
) -> bool {
    if let Err(e) = report.fail(&live.job_id, &reason).await {
        tracing::warn!(
            "[pool] could not tell core job {} is over: {e} — sending it again next tick",
            live.job_id
        );
        return false;
    }
    if let Err(e) = panes.kill(&live.pane).await {
        tracing::warn!(
            "[pool] job {} is over but {} would not close: {e} — keeping it under supervision, because a slot given back while its pane runs is a slot this box would hand out twice",
            live.job_id,
            live.pane
        );
        return false;
    }
    panes.released(&live.pane).await;
    registry.forget(&live.job_id);
    records.forget(&live.job_id).await;
    tracing::error!("[pool] job {}: {reason}", live.job_id);
    true
}

/// The production halves, over a real core and a real tmux.
pub struct CorePool<'a> {
    pub client: &'a CoreClient,
    pub limit: u32,
    /// How long a read or a preparation may take before it is a failure;
    /// [`pool::CALL_DEADLINE`] everywhere but a test.
    pub deadline: std::time::Duration,
}

#[async_trait::async_trait]
impl Pool for CorePool<'_> {
    async fn claimable(
        &self,
        project_id: &str,
    ) -> std::result::Result<Vec<PoolEntry>, ReadFailure> {
        pool::list_within(self.client, Some(project_id), self.limit, self.deadline).await
    }

    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared> {
        pool::prepare_within(self.client, job_id, session_id, self.deadline).await
    }

    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started> {
        pool::start(self.client, job_id, session_id).await
    }

    async fn release(&self, job_id: &str, session_id: &str) -> Result<()> {
        pool::release(self.client, Some(job_id), session_id).await
    }

    async fn mcp_servers(&self, project_id: &str) -> Result<ProjectMcpServers> {
        mcp_servers::fetch_within(self.client, project_id, self.deadline).await
    }
}

pub struct CoreReport<'a> {
    pub client: &'a CoreClient,
}

#[async_trait::async_trait]
impl Report for CoreReport<'_> {
    async fn ack(&self, job_id: &str) -> Result<()> {
        lifecycle::ack(self.client, job_id, None).await
    }

    async fn progress(&self, job_id: &str, runtime_state: Option<&str>) -> Result<bool> {
        let mut data = serde_json::json!({ "source": "pool_jobs" });
        if let Some(state) = runtime_state {
            data["runtimeState"] = serde_json::Value::String(state.to_string());
        }
        let beat = JobEventInput::new(HEARTBEAT_KIND, data);
        match events::post_job_events(self.client, job_id, &[beat]).await {
            Ok(_) => Ok(true),
            Err(e) if events::is_disowned(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    async fn fail(&self, job_id: &str, error: &str) -> Result<bool> {
        match lifecycle::fail(self.client, job_id, error).await {
            Ok(()) => Ok(true),
            Err(e) if events::is_disowned(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// One file per started job, under the daemon's own config directory.
pub struct FileRecords {
    pub dir: PathBuf,
}

impl FileRecords {
    /// Where a daemon keeps them, beside `inflight/`.
    pub fn default_dir() -> Option<PathBuf> {
        runner_platform::config::base_dir()
            .ok()
            .map(|d| d.join("pool-jobs"))
    }

    fn path(&self, job_id: &str) -> Option<PathBuf> {
        if job_id.is_empty()
            || job_id.len() > 64
            || !job_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        {
            return None;
        }
        Some(self.dir.join(format!("{job_id}.json")))
    }
}

#[async_trait::async_trait]
impl Records for FileRecords {
    async fn note(&self, live: &Live) {
        let Some(path) = self.path(&live.job_id) else {
            tracing::error!(
                "[pool] refusing to record job {}: not a job id core would send",
                live.job_id
            );
            return;
        };
        let _ = std::fs::create_dir_all(&self.dir);
        let mut body = serde_json::json!({ "pane": live.pane });
        let obj = body.as_object_mut().expect("json! object");
        if let Some(session) = live.watch.session_id() {
            obj.insert("session".into(), session.into());
        }
        if let Some(seen) = live.seen {
            obj.insert("seen".into(), seen.to_json());
        }
        if let Some(path) = &live.transcript {
            obj.insert("transcript".into(), path.as_str().into());
        }
        if let Some(at) = live.opened_at {
            obj.insert("openedAt".into(), at.into());
        }
        // Never in place. A sweep replaces this file every minute now that it
        // carries the snapshot a restart is judged on, and `std::fs::write`
        // truncates before it writes: a daemon that dies mid-write would leave
        // half a record, which reads back as a pane nothing is known about and
        // so is kept for the rest of its life — the very hole the snapshot
        // closes. `session_tokens` learned this on the same disk (ISS-1099).
        if let Err(e) = replace(&self.dir, &path, &body.to_string()) {
            tracing::warn!(
                "[pool] could not record job {} at {}: {e} — the record standing there is the one a restart will read",
                live.job_id,
                path.display()
            );
        }
    }

    async fn forget(&self, job_id: &str) {
        if let Some(path) = self.path(job_id) {
            let _ = std::fs::remove_file(path);
        }
    }

    async fn all(&self) -> Vec<Live> {
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(job_id) = name.strip_suffix(".json") else {
                continue;
            };
            let Ok(body) = std::fs::read_to_string(entry.path()) else {
                continue;
            };
            let held = serde_json::from_str::<serde_json::Value>(&body).ok();
            let field = |k: &str| {
                held.as_ref()
                    .and_then(|v| v[k].as_str().map(str::to_string))
            };
            out.push(Live {
                job_id: job_id.to_string(),
                pane: field("pane").unwrap_or_else(|| pane_name(job_id)),
                watch: match field("session") {
                    Some(session_id) => Watch::Adopted { session_id },
                    None => Watch::Unhooked,
                },
                seen: held
                    .as_ref()
                    .map(|v| &v["seen"])
                    .and_then(job_exit::Reported::from_json),
                // Absolute or not at all, the rule `agent_activity` holds a
                // hook to: a relative path would be read against this
                // daemon's cwd and age some other file.
                transcript: field("transcript").filter(|p| Path::new(p).is_absolute()),
                opened_at: held.as_ref().and_then(|v| v["openedAt"].as_i64()),
            });
        }
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }
}

/// Put `body` at `path` whole or not at all, leaving whatever stood there if
/// the replacement cannot be completed.
fn replace(dir: &Path, path: &Path, body: &str) -> std::io::Result<()> {
    let tmp = dir.join(format!(
        ".pool-job.{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    let done = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, path));
    if done.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    done
}

pub struct NoRecords;

#[async_trait::async_trait]
impl Records for NoRecords {
    async fn note(&self, _live: &Live) {}
    async fn forget(&self, _job_id: &str) {}
    async fn all(&self) -> Vec<Live> {
        Vec::new()
    }
}

pub struct TmuxPanes;

/// The command a job pane is started with: the launch a master pane takes, handed the project's
/// declared servers through a config of the job's own, and the model and denied tools of its
/// policy state. A declaration that cannot be written is a refusal, because the pane it would
/// start carries none of it.
fn job_pane_argv(dir: &Path, name: &str, launch: &Launch<'_>) -> Result<Vec<String>> {
    let servers = launch.servers;
    let config =
        runner_workspace::mcp::config::write_job_session_in(dir, name, servers).map_err(|e| {
            Error::Other(format!(
                "the project's declared MCP servers ({}) could not be written for {name}: {e}",
                servers.keys().cloned().collect::<Vec<_>>().join(", ")
            ))
        })?;
    Ok(terminal::job_argv(
        config.as_deref(),
        None,
        Some(launch.model),
        launch.denied_tools,
    ))
}

#[async_trait::async_trait]
impl Panes for TmuxPanes {
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
        launch: &Launch<'_>,
    ) -> Result<()> {
        if !terminal::available() {
            return Err(Error::Other(
                "tmux is not installed on this box, and a job pane needs it".into(),
            ));
        }
        let argv = job_pane_argv(&runner_workspace::mcp::config::session_dir(), name, launch)?;
        terminal::ensure(name, cwd, &argv, env, None).await?;
        terminal::brief_new_pane(name, prompt).await
    }

    async fn released(&self, name: &str) {
        if let Err(e) = runner_workspace::mcp::config::clear_job_session(name) {
            tracing::warn!(
                "[pool] {name} is over, but its MCP config could not be removed ({e}) — it holds the project's server credentials until the 24-hour sweep takes it"
            );
        }
    }

    async fn gone(&self, name: &str) -> bool {
        crate::recovery_ports::pane_presence(name).await == crate::recovery::MasterPresence::Gone
    }

    async fn kill(&self, name: &str) -> Result<()> {
        terminal::kill(name).await
    }

    async fn names(&self) -> Vec<String> {
        terminal::names_with_prefix(terminal::JOB_PREFIX).await
    }
}
