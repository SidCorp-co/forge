//! Bringing a pool job to life on this box, and staying with it.
//!
//! Core has minted `smoke`, `release_batch`, `reconcile` and `verify_skill`
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

use crate::daemon::agent_activity::{now_ms, Activities};
use crate::daemon::job_exit;
use crate::daemon::job_unheard;
use crate::daemon::turn_evidence::{self, Evidence, Watch};
use crate::daemon::{control, hook_install, session_tokens, terminal};
use crate::error::{Error, Result};
use crate::transport::events::{self, JobEventInput};
use crate::transport::pool::{self, PoolEntry, Prepared, Started};
use crate::transport::{lifecycle, CoreClient};

/// What the box may read, take, start and give back.
#[async_trait::async_trait]
pub trait Pool: Send + Sync {
    async fn claimable(&self, project_id: &str) -> Result<Vec<PoolEntry>>;
    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared>;
    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started>;
    async fn release(&self, job_id: &str, session_id: &str) -> Result<()>;
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
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
    ) -> Result<()>;
    async fn alive(&self, name: &str) -> bool;
    async fn kill(&self, name: &str) -> Result<()>;
    /// Every job pane on this box right now, by name.
    async fn names(&self) -> Vec<String>;
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
}

/// One held slot, and since when this daemon has been counting it.
#[derive(Debug, Clone)]
struct Held {
    pane: String,
    watch: Watch,
    seen: Option<job_exit::Reported>,
    /// When this daemon began counting the pane — the adoption, for one it
    /// adopted, and never the pane's own start. It is the only instant this
    /// box's own silence can be measured from, which is what `job_unheard`
    /// reads it for: a pane's delivery belongs to whichever daemon briefed it
    /// and is persisted nowhere. A reading that wants the slot's age ACROSS a
    /// restart wants a second value rather than this one, which carried across
    /// would conclude an adopted pane the instant it was adopted.
    noted_at: i64,
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
    /// When this daemon began counting the pane, which for one it adopted is
    /// the adoption and not the pane's own start.
    pub noted_at: i64,
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

    pub fn note(&self, job_id: &str, pane: &str, watch: Watch) {
        self.hold(job_id, pane, watch, None);
    }

    /// The same, carrying what a previous daemon's sweep read of this agent.
    pub fn hold(&self, job_id: &str, pane: &str, watch: Watch, seen: Option<job_exit::Reported>) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        let now = now_ms();
        map.entry(job_id.to_string())
            .and_modify(|h| {
                h.pane = pane.to_string();
                h.watch = watch.clone();
                h.seen = seen;
            })
            .or_insert_with(|| Held {
                pane: pane.to_string(),
                watch,
                seen,
                noted_at: now,
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
                noted_at: h.noted_at,
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

    /// Move one pane's count start, so a test can stand where an hour of
    /// watching would have put it without waiting an hour.
    #[cfg(test)]
    pub(crate) fn backdate(&self, job_id: &str, to: i64) {
        if let Ok(mut map) = self.inner.lock() {
            if let Some(h) = map.get_mut(job_id) {
                h.noted_at = to;
            }
        }
    }
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
                records.forget(&rec.job_id).await;
                out.buried += 1;
                tracing::warn!(
                    "[pool] job {} did not survive the restart — reported to core",
                    rec.job_id
                );
            }
            Err(e) => {
                registry.note(&rec.job_id, &rec.pane, Watch::Unhooked);
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
        };
        registry.hold(
            &adopted.job_id,
            &adopted.pane,
            adopted.watch.clone(),
            adopted.seen,
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
    AtBound,
    Refused(String),
    /// A preparation this box could not turn into a pane; the hold is back.
    GaveBack(String),
    /// The stamp neither succeeded nor was refused — the pane stays and the next
    /// supervision tick asks core whose job it is.
    Unresolved(String),
}

pub async fn take_one(
    pool_ports: &dyn Pool,
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
    project_id: &str,
    session_id: &str,
    fallback_cwd: Option<&Path>,
    bound: usize,
    tokens: Option<&session_tokens::SessionTokens>,
) -> Took {
    if registry.count() >= bound {
        return Took::AtBound;
    }
    let entries = match pool_ports.claimable(project_id).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("[pool] {project_id}: cannot read the pool: {e}");
            return Took::NothingClaimable;
        }
    };
    let Some(entry) = entries.into_iter().find(|e| e.held_by.is_none()) else {
        return Took::NothingClaimable;
    };

    let prepared = match pool_ports.prepare(&entry.job_id, session_id).await {
        Ok(Prepared::Took(p)) => p,
        Ok(Prepared::Refused(r)) => {
            tracing::info!(
                "[pool] {project_id}: job {} not taken: {}",
                entry.job_id,
                r.as_str()
            );
            return Took::Refused(r.as_str().to_string());
        }
        Err(e) => {
            tracing::warn!("[pool] {project_id}: prepare failed: {e}");
            return Took::NothingClaimable;
        }
    };

    let pane = pane_name(&prepared.job_id);
    let cwd_candidates: Vec<PathBuf> = prepared
        .repo_path
        .as_deref()
        .map(PathBuf::from)
        .into_iter()
        .chain(fallback_cwd.map(Path::to_path_buf))
        .collect();
    let Some(cwd) = cwd_candidates.iter().find(|p| p.is_dir()).cloned() else {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} has no checkout THIS BOX can stand in — tried {:?}; given back. Core's project repo_path may belong to another box; bind it here or set the runner's repo_path",
            prepared.job_id,
            cwd_candidates
        );
        return Took::GaveBack(prepared.job_id);
    };

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

    let (env, channel) = open_channel(
        &cwd,
        &prepared.agent_session_id,
        project_id,
        &pane,
        tokens,
        control::HOOKS_CAN_REPORT,
    );

    if let Err(e) = panes.open(&pane, &cwd, &prompt, &env).await {
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
    };
    records.note(&opened).await;

    match pool_ports.start(&prepared.job_id, session_id).await {
        Ok(Started::Ok) => {}
        Ok(Started::Refused(r)) => {
            let _ = panes.kill(&pane).await;
            records.forget(&prepared.job_id).await;
            tracing::warn!(
                "[pool] {project_id}: start refused for job {} ({}) — pane {pane} killed",
                prepared.job_id,
                r.as_str()
            );
            return Took::Refused(r.as_str().to_string());
        }
        Err(e) => {
            registry.note(&prepared.job_id, &pane, watch);
            tracing::error!(
                "[pool] {project_id}: start for job {} did not answer ({e}) — pane {pane} kept, and the next tick asks core whose job it is",
                prepared.job_id
            );
            return Took::Unresolved(prepared.job_id);
        }
    }

    registry.note(&prepared.job_id, &pane, watch);
    if let Err(e) = report.ack(&prepared.job_id).await {
        tracing::warn!("[pool] ack for job {} failed: {e}", prepared.job_id);
    }
    tracing::info!(
        "[pool] {project_id}: job {} ({}) running in {pane}",
        prepared.job_id,
        prepared.job_type
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
    own: crate::error::Result<crate::exe::OwnExe>,
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
    if !install_pane_hooks(cwd, project_id, pane, crate::exe::own()) {
        return (env, None);
    }
    let Some(store) = tokens else {
        tracing::error!(
            "[pool] {project_id}: cannot resolve the control token map — {pane} starts with no capability and its hooks will be refused"
        );
        return (env, None);
    };
    match store.mint(agent_session_id) {
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
        if !panes.alive(&live.pane).await {
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
        if seen != live.seen {
            records
                .note(&Live {
                    seen,
                    ..live.clone()
                })
                .await;
            registry.hold(&live.job_id, &live.pane, live.watch.clone(), seen);
        }
        if let Some(reason) = job_exit::verdict(&live.watch, seen, now).reason(&live.pane) {
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
    registry.forget(&live.job_id);
    records.forget(&live.job_id).await;
    tracing::error!("[pool] job {}: {reason}", live.job_id);
    true
}

/// The production halves, over a real core and a real tmux.
pub struct CorePool<'a> {
    pub client: &'a CoreClient,
    pub limit: u32,
}

#[async_trait::async_trait]
impl Pool for CorePool<'_> {
    async fn claimable(&self, project_id: &str) -> Result<Vec<PoolEntry>> {
        pool::list(self.client, Some(project_id), self.limit).await
    }

    async fn prepare(&self, job_id: &str, session_id: &str) -> Result<Prepared> {
        pool::prepare(self.client, job_id, session_id).await
    }

    async fn start(&self, job_id: &str, session_id: &str) -> Result<Started> {
        pool::start(self.client, job_id, session_id).await
    }

    async fn release(&self, job_id: &str, session_id: &str) -> Result<()> {
        pool::release(self.client, Some(job_id), session_id).await
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
        dirs_next::config_dir().map(|d| d.join("forge-runner").join("pool-jobs"))
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

#[async_trait::async_trait]
impl Panes for TmuxPanes {
    async fn open(
        &self,
        name: &str,
        cwd: &Path,
        prompt: &str,
        env: &[(String, String)],
    ) -> Result<()> {
        if !terminal::available() {
            return Err(Error::Other(
                "tmux is not installed on this box, and a job pane needs it".into(),
            ));
        }
        let argv = terminal::pane_argv(None, None);
        terminal::ensure(name, cwd, &argv, env, None).await?;
        terminal::brief_new_pane(name, prompt).await
    }

    async fn alive(&self, name: &str) -> bool {
        terminal::alive(name).await
    }

    async fn kill(&self, name: &str) -> Result<()> {
        terminal::kill(name).await
    }

    async fn names(&self) -> Vec<String> {
        terminal::names_with_prefix(terminal::JOB_PREFIX).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const THIS_SOURCE: &str = include_str!("pool_jobs.rs");
    use crate::transport::pool::Refusal;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    #[derive(Default)]
    struct Recorder {
        opened: Mutex<Vec<String>>,
        killed: Mutex<Vec<String>>,
        released: Mutex<Vec<String>>,
        acked: Mutex<Vec<String>>,
        failed: Mutex<Vec<(String, String)>>,
        beats: Mutex<Vec<String>>,
        /// Every beat as `job|runtimeState`, with `-` for a beat that carried none.
        beat_states: Mutex<Vec<String>>,
        recorded: Mutex<Vec<String>>,
        cwds: Mutex<Vec<PathBuf>>,
        envs: Mutex<Vec<Vec<(String, String)>>>,
    }

    struct FakePool {
        entries: Vec<PoolEntry>,
        prepare: Mutex<Option<Prepared>>,
        start: Mutex<Option<Started>>,
        start_errs: std::sync::atomic::AtomicBool,
        rec: Arc<Recorder>,
    }

    fn entry(job_id: &str, held: Option<&str>) -> PoolEntry {
        PoolEntry {
            job_id: job_id.into(),
            job_type: "release_batch".into(),
            issue_id: None,
            issue_key: None,
            age_minutes: 1.0,
            attempts: 0,
            held_by: held.map(str::to_string),
        }
    }

    fn prepared(job_id: &str, prompt: Option<&str>) -> Prepared {
        Prepared::Took(Box::new(pool::PreparedJob {
            job_id: job_id.into(),
            project_id: "p1".into(),
            issue_id: None,
            job_type: "release_batch".into(),
            agent_session_id: "s1".into(),
            system_prompt: "sys".into(),
            prompt_string: prompt.map(str::to_string),
            model: "claude".into(),
            repo_path: Some(core_repo().to_string_lossy().into_owned()),
            prior_claude_session_id: None,
            runner_id: "r1".into(),
        }))
    }

    #[async_trait::async_trait]
    impl Pool for FakePool {
        async fn claimable(&self, _project_id: &str) -> Result<Vec<PoolEntry>> {
            Ok(self.entries.clone())
        }
        async fn prepare(&self, job_id: &str, _session_id: &str) -> Result<Prepared> {
            if self
                .entries
                .iter()
                .any(|e| e.job_id == job_id && e.held_by.is_some())
            {
                return Ok(Prepared::Refused(Refusal::AlreadyHeld));
            }
            Ok(self
                .prepare
                .lock()
                .unwrap()
                .take()
                .unwrap_or(Prepared::Refused(Refusal::NotFound)))
        }
        async fn start(&self, _job_id: &str, _session_id: &str) -> Result<Started> {
            if self.start_errs.load(Ordering::SeqCst) {
                return Err(Error::Other("core did not answer".into()));
            }
            Ok(self.start.lock().unwrap().take().unwrap_or(Started::Ok))
        }
        async fn release(&self, job_id: &str, _session_id: &str) -> Result<()> {
            self.rec.released.lock().unwrap().push(job_id.into());
            Ok(())
        }
    }

    /// A directory that exists, standing in for what core believes the checkout is.
    fn core_repo() -> PathBuf {
        let p = std::env::temp_dir().join("forge-pool-core-repo");
        std::fs::create_dir_all(&p).expect("temp dir");
        p
    }

    /// A directory that exists, standing in for THIS box's own binding.
    fn box_repo() -> PathBuf {
        let p = std::env::temp_dir().join("forge-pool-box-repo");
        std::fs::create_dir_all(&p).expect("temp dir");
        p
    }

    struct FakePanes {
        rec: Arc<Recorder>,
        open_fails: bool,
        alive: Mutex<Vec<String>>,
        names: Vec<String>,
        kill_errs: Mutex<usize>,
    }

    #[async_trait::async_trait]
    impl Panes for FakePanes {
        async fn open(
            &self,
            name: &str,
            cwd: &Path,
            prompt: &str,
            env: &[(String, String)],
        ) -> Result<()> {
            if self.open_fails {
                return Err(Error::Other("no tmux".into()));
            }
            self.rec.envs.lock().unwrap().push(env.to_vec());
            self.rec.cwds.lock().unwrap().push(cwd.to_path_buf());
            self.rec
                .opened
                .lock()
                .unwrap()
                .push(format!("{name}|{prompt}"));
            self.alive.lock().unwrap().push(name.to_string());
            Ok(())
        }
        async fn alive(&self, name: &str) -> bool {
            self.alive.lock().unwrap().iter().any(|n| n == name)
        }
        async fn kill(&self, name: &str) -> Result<()> {
            let mut left = self.kill_errs.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err(Error::Other("tmux would not close it".into()));
            }
            self.rec.killed.lock().unwrap().push(name.into());
            self.alive.lock().unwrap().retain(|n| n != name);
            Ok(())
        }
        async fn names(&self) -> Vec<String> {
            self.names.clone()
        }
    }

    struct FakeRecords {
        inner: Mutex<HashMap<String, Live>>,
        rec: Arc<Recorder>,
    }

    #[async_trait::async_trait]
    impl Records for FakeRecords {
        async fn note(&self, live: &Live) {
            self.rec.recorded.lock().unwrap().push(live.job_id.clone());
            self.inner
                .lock()
                .unwrap()
                .insert(live.job_id.clone(), live.clone());
        }
        async fn forget(&self, job_id: &str) {
            self.inner.lock().unwrap().remove(job_id);
        }
        async fn all(&self) -> Vec<Live> {
            let mut out: Vec<Live> = self.inner.lock().unwrap().values().cloned().collect();
            out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
            out
        }
    }

    /// A record a previous daemon left, as `adopt` reads it back.
    fn recorded(job_id: &str, watch: Watch, seen: Option<job_exit::Reported>) -> Live {
        Live {
            job_id: job_id.into(),
            pane: pane_name(job_id),
            watch,
            seen,
        }
    }

    struct FakeReport {
        rec: Arc<Recorder>,
        disowned: bool,
        fail_errs: Mutex<usize>,
    }

    #[async_trait::async_trait]
    impl Report for FakeReport {
        async fn ack(&self, job_id: &str) -> Result<()> {
            self.rec.acked.lock().unwrap().push(job_id.into());
            Ok(())
        }
        async fn progress(&self, job_id: &str, runtime_state: Option<&str>) -> Result<bool> {
            self.rec.beats.lock().unwrap().push(job_id.into());
            self.rec
                .beat_states
                .lock()
                .unwrap()
                .push(format!("{job_id}|{}", runtime_state.unwrap_or("-")));
            Ok(!self.disowned)
        }
        async fn fail(&self, job_id: &str, error: &str) -> Result<bool> {
            let mut left = self.fail_errs.lock().unwrap();
            if *left > 0 {
                *left -= 1;
                return Err(Error::Other("core unreachable".into()));
            }
            self.rec
                .failed
                .lock()
                .unwrap()
                .push((job_id.into(), error.into()));
            Ok(true)
        }
    }

    struct World {
        rec: Arc<Recorder>,
        pool: FakePool,
        panes: FakePanes,
        report: FakeReport,
        records: FakeRecords,
        registry: JobPanes,
        /// A token map of this test's own, so nothing here writes the box's.
        tokens: session_tokens::SessionTokens,
        /// Removed however the test ends, so a panic leaves no directory behind.
        _home: TempHome,
    }

    struct TempHome(PathBuf);

    impl TempHome {
        fn new(label: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "forge-pool-{label}-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            ));
            std::fs::create_dir_all(&dir).expect("temp home");
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn world(entries: Vec<PoolEntry>, prep: Option<Prepared>, start: Option<Started>) -> World {
        let rec = Arc::new(Recorder::default());
        let rec2 = rec.clone();
        let home = TempHome::new("world");
        World {
            rec: rec.clone(),
            pool: FakePool {
                entries,
                prepare: Mutex::new(prep),
                start: Mutex::new(start),
                start_errs: std::sync::atomic::AtomicBool::new(false),
                rec: rec.clone(),
            },
            panes: FakePanes {
                rec: rec.clone(),
                open_fails: false,
                alive: Mutex::new(Vec::new()),
                names: Vec::new(),
                kill_errs: Mutex::new(0),
            },
            report: FakeReport {
                rec,
                disowned: false,
                fail_errs: Mutex::new(0),
            },
            records: FakeRecords {
                inner: Mutex::new(HashMap::new()),
                rec: rec2,
            },
            registry: JobPanes::new(),
            tokens: session_tokens::SessionTokens::at(home.path().join("control-tokens.json")),
            _home: home,
        }
    }

    fn channel_for(hooks_can_report: bool) -> (Vec<(String, String)>, Option<String>, TempHome) {
        let home = TempHome::new("channel");
        let tokens = session_tokens::SessionTokens::at(home.path().join("control-tokens.json"));
        let (env, channel) = open_channel(
            home.path(),
            "sess-1",
            "p1",
            "forge-job-j1",
            Some(&tokens),
            hooks_can_report,
        );
        (env, channel, home)
    }

    #[test]
    fn a_box_whose_daemon_hosts_the_socket_opens_the_channel() {
        let (env, channel, _home) = channel_for(true);
        assert_eq!(
            channel.as_deref(),
            Some("sess-1"),
            "a box that can receive frames claims the session its hooks report under"
        );
        assert!(
            env.iter().any(|(k, _)| k == session_tokens::TOKEN_ENV),
            "the pane carries the capability its hooks are refused without"
        );
    }

    #[test]
    fn a_box_whose_daemon_hosts_no_socket_opens_none_and_claims_no_session() {
        let (env, channel, _home) = channel_for(false);
        assert_eq!(
            channel, None,
            "no session id may be claimed where no frame can arrive"
        );
        assert!(
            !env.iter().any(|(k, _)| k == session_tokens::TOKEN_ENV),
            "no capability is minted into a pane whose reports nothing can receive"
        );
    }

    #[test]
    fn the_platform_is_what_decides_the_channel_and_nothing_else_differs() {
        let (_, hooked, _a) = channel_for(true);
        let (_, unhooked, _b) = channel_for(false);
        assert_ne!(
            hooked, unhooked,
            "same cwd, same session, same token store — only the platform differs"
        );
    }

    async fn take(w: &World, bound: usize) -> Took {
        take_one(
            &w.pool,
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            "p1",
            "master-session",
            Some(&box_repo()),
            bound,
            Some(&w.tokens),
        )
        .await
    }

    /// A supervision tick with no turn reports at all, which is what every
    /// caller below wants unless it says otherwise.
    async fn sup(w: &World) {
        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;
    }

    /// A job this box hooked, whose prompt was delivered `ago` ms before now.
    fn hooked(session: &str, ago: i64) -> Watch {
        Watch::Hooked {
            session_id: session.into(),
            delivered_at: now_ms() - ago,
        }
    }

    const PAST_THE_WINDOW: i64 = turn_evidence::FIRST_TURN_WINDOW.as_millis() as i64 + 1;

    #[tokio::test]
    async fn a_claimable_job_gets_a_pane_briefed_with_the_prompt_core_built() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("## Batch Release"))),
            None,
        );

        assert_eq!(take(&w, 2).await, Took::Started("j1".into()));

        let opened = w.rec.opened.lock().unwrap().clone();
        assert_eq!(opened, vec!["forge-job-j1|## Batch Release".to_string()]);
        assert_eq!(w.rec.acked.lock().unwrap().clone(), vec!["j1".to_string()]);
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_that_cannot_open_gives_the_hold_back_and_never_stamps() {
        let mut w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        w.panes.open_fails = true;

        assert_eq!(take(&w, 2).await, Took::GaveBack("j1".into()));

        assert_eq!(
            w.rec.released.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
        assert!(w.rec.acked.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_preparation_with_no_prompt_gives_the_hold_back() {
        let w = world(vec![entry("j1", None)], Some(prepared("j1", None)), None);

        assert_eq!(take(&w, 2).await, Took::GaveBack("j1".into()));

        assert_eq!(
            w.rec.released.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_refused_stamp_kills_the_pane_this_pass_opened() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            Some(Started::Refused(Refusal::HoldLost)),
        );

        assert_eq!(take(&w, 2).await, Took::Refused("hold_lost".into()));

        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_refusal_is_reported_by_the_word_core_chose() {
        let w = world(
            vec![entry("j1", None)],
            Some(Prepared::Refused(Refusal::ReleaseLabelMissing)),
            None,
        );

        assert_eq!(
            take(&w, 2).await,
            Took::Refused("release_label_missing".into())
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_pool_of_only_held_rows_offers_the_claim_nothing() {
        let w = world(vec![entry("j1", Some("someone-else"))], None, None);

        assert_eq!(take(&w, 2).await, Took::NothingClaimable);
    }

    #[tokio::test]
    async fn a_held_row_is_stepped_over_to_reach_a_claimable_one() {
        let w = world(
            vec![entry("j1", Some("someone-else")), entry("j2", None)],
            Some(prepared("j2", Some("go"))),
            None,
        );

        assert_eq!(take(&w, 2).await, Took::Started("j2".into()));
    }

    #[tokio::test]
    async fn a_box_at_its_bound_takes_nothing() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        w.registry
            .note("already", "forge-job-already", Watch::Unhooked);

        assert_eq!(take(&w, 1).await, Took::AtBound);

        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_live_pane_is_kept_alive_with_a_progress_event() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        sup(&w).await;

        assert_eq!(w.rec.beats.lock().unwrap().clone(), vec!["j1".to_string()]);
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_that_ended_fails_its_job_by_name() {
        let w = world(vec![], None, None);
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        sup(&w).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "j1");
        assert!(failed[0].1.contains("forge-job-j1"));
        assert_eq!(w.registry.count(), 0);
        assert!(w.rec.beats.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_job_core_calls_terminal_closes_its_pane_and_leaves_the_registry() {
        let mut w = world(vec![], None, None);
        w.report.disowned = true;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        sup(&w).await;

        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
        assert!(w.rec.failed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_prompt_delivered_and_never_submitted_is_failed_by_name() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        // The agent's hooks have reported NOTHING: the prompt is in the composer.
        let acts = Activities::new();

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1, "the job must be failed by name");
        assert_eq!(failed[0].0, "j1");
        assert!(
            failed[0].1.contains("never reported submitting"),
            "the reason must name the unsubmitted prompt, not a timeout: {}",
            failed[0].1
        );
        assert!(
            w.rec.beats.lock().unwrap().is_empty(),
            "a job this box has just called dead must not also be beaten as progress"
        );
        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn the_same_pane_with_one_submitted_prompt_is_working_and_never_failed() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        acts.record(
            "sess-1",
            crate::daemon::agent_activity::Report {
                event: crate::daemon::agent_activity::Event::PromptSubmitted,
                at: now_ms(),
                subject: None,
                conversation: None,
            },
        );

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "a release whose agent answered must never be failed for silence"
        );
        assert_eq!(
            w.rec.beat_states.lock().unwrap().clone(),
            vec!["j1|working".to_string()]
        );
        assert!(w.rec.killed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_job_whose_turn_has_ended_is_still_not_failed() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        for event in [
            crate::daemon::agent_activity::Event::PromptSubmitted,
            crate::daemon::agent_activity::Event::Stopped,
        ] {
            acts.record(
                "sess-1",
                crate::daemon::agent_activity::Report {
                    event,
                    at: now_ms(),
                    subject: None,
                    conversation: None,
                },
            );
        }

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(
            w.rec.beat_states.lock().unwrap().clone(),
            vec!["j1|working".to_string()]
        );
    }

    #[tokio::test]
    async fn inside_the_window_the_beat_says_starting_and_not_working() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", 1_000));

        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;

        assert_eq!(
            w.rec.beat_states.lock().unwrap().clone(),
            vec!["j1|starting".to_string()]
        );
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_this_box_could_not_hook_is_never_failed_for_silence() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "silence from a pane this box has no channel to is not evidence of anything"
        );
        assert_eq!(
            w.rec.beat_states.lock().unwrap().clone(),
            vec!["j1|-".to_string()],
            "a box that knows nothing about the process reports no runtime state at all"
        );
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_adopted_after_a_restart_is_never_failed_for_silence() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;

        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert!(w.rec.killed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_never_started_job_core_would_not_take_is_sent_again_next_tick() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1, "the obligation is kept");
        assert!(
            w.rec.killed.lock().unwrap().is_empty(),
            "the pane is not killed until core has taken the failure"
        );

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;
        assert_eq!(w.rec.failed.lock().unwrap().len(), 1);
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_never_started_job_whose_pane_will_not_close_stays_supervised() {
        let w = world(vec![], None, None);
        *w.panes.kill_errs.lock().unwrap() = 1;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;
        assert_eq!(w.registry.count(), 1, "cleanup is still owed");

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;
        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn nothing_in_supervision_ever_sends_a_second_prompt() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("## Batch Release"))),
            None,
        );
        assert_eq!(take(&w, 4).await, Took::Started("j1".into()));
        let acts = Activities::new();

        for _ in 0..3 {
            supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;
        }

        assert_eq!(
            w.rec.opened.lock().unwrap().len(),
            1,
            "supervision delivers no prompt of its own, on any reading"
        );
    }

    /// A session that submitted a prompt and then reported the boundary given,
    /// that many ms ago.
    fn said(
        acts: &Activities,
        session: &str,
        event: crate::daemon::agent_activity::Event,
        ago: i64,
    ) {
        use crate::daemon::agent_activity::{Event, Report};
        let at = now_ms() - ago;
        for e in [Event::PromptSubmitted, event] {
            acts.record(
                session,
                Report {
                    event: e,
                    at,
                    subject: None,
                    conversation: None,
                },
            );
        }
    }

    const PAST_IDLE: i64 = job_exit::IDLE_BEFORE_FINISHED.as_millis() as i64 + 1;
    const PAST_SILENT: i64 = job_exit::SILENT_BEFORE_ABANDONED.as_millis() as i64 + 1;

    /// What a previous daemon's sweep left behind for a pane in this state.
    fn snapshot(
        doing: crate::daemon::agent_activity::Doing,
        event: crate::daemon::agent_activity::Event,
        ago: i64,
    ) -> Option<job_exit::Reported> {
        Some(job_exit::Reported {
            doing,
            last_event: event,
            at: now_ms() - ago,
            prompts: 1,
        })
    }

    #[tokio::test]
    async fn a_pane_whose_agent_finished_its_turn_gives_the_slot_back() {
        use crate::daemon::agent_activity::Event;
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::Stopped, PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1, "the job must be ended by name");
        assert_eq!(failed[0].0, "j1");
        assert!(
            failed[0].1.contains("ended a turn"),
            "the reason names what the agent last reported: {}",
            failed[0].1
        );
        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(
            w.registry.count(),
            0,
            "the slot comes back on this call and nowhere else"
        );
        assert!(
            w.rec.beats.lock().unwrap().is_empty(),
            "a job this box has just ended must not also be beaten as progress"
        );
    }

    #[tokio::test]
    async fn every_project_is_refused_until_a_finished_pane_lets_go() {
        use crate::daemon::agent_activity::Event;
        // The measured failure: max_job_panes = 2, both panes finished, and
        // nothing on the box can start.
        let w = world(
            vec![entry("j3", None)],
            Some(prepared("j3", Some("## Batch Release"))),
            None,
        );
        let acts = Activities::new();
        for job in ["j1", "j2"] {
            let pane = pane_name(job);
            w.panes.alive.lock().unwrap().push(pane.clone());
            let session = format!("sess-{job}");
            w.registry
                .note(job, &pane, hooked(&session, PAST_THE_WINDOW));
            said(&acts, &session, Event::Stopped, PAST_IDLE);
        }

        assert_eq!(take(&w, 2).await, Took::AtBound, "the box is full");

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert_eq!(w.registry.count(), 0);
        assert_eq!(
            take(&w, 2).await,
            Took::Started("j3".into()),
            "a slot held by a finished agent is a slot the next job never gets"
        );
    }

    #[tokio::test]
    async fn a_pane_stopped_on_a_question_nobody_answers_gives_the_slot_back() {
        use crate::daemon::agent_activity::Event;
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::PermissionRequested, PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert!(
            failed[0].1.contains("only a human can answer"),
            "an operator must be able to tell this from a pane that merely went idle: {}",
            failed[0].1
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_pane_that_compacted_keeps_its_slot_past_the_idle_window() {
        use crate::daemon::agent_activity::Event;
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::Compacted, PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "a compaction reads as idle while the agent may still be working behind it"
        );
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_silent_since_it_compacted_gives_the_slot_back() {
        use crate::daemon::agent_activity::Event;
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::Compacted, PAST_SILENT);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert!(failed[0].1.contains("compacted"), "{}", failed[0].1);
    }

    /// A lead that submitted, started `child-1`, and stopped `ago` ms ago, the
    /// child's own stop never arriving.
    fn stopped_over_a_lost_child(acts: &Activities, session: &str, ago: i64) {
        use crate::daemon::agent_activity::{Event, Report};
        let at = now_ms() - ago;
        for (event, subject) in [
            (Event::PromptSubmitted, None),
            (Event::SubagentStarted, Some("child-1")),
            (Event::Stopped, None),
        ] {
            acts.record(
                session,
                Report {
                    event,
                    at,
                    subject,
                    conversation: None,
                },
            );
        }
    }

    #[tokio::test]
    async fn a_pane_whose_child_end_was_lost_keeps_its_slot_inside_the_longer_window() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        stopped_over_a_lost_child(&acts, "sess-1", PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_whose_child_end_was_lost_gives_the_slot_back_past_the_longer_window() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        stopped_over_a_lost_child(&acts, "sess-1", PAST_SILENT);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(
            failed.len(),
            1,
            "a lost SubagentStop must not hold the slot for the life of the pane (ISS-1232)"
        );
        assert!(
            failed[0].1.contains("forge-job-j1") && failed[0].1.contains("never reported an end"),
            "{}",
            failed[0].1
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_sweep_leaves_what_it_read_on_the_job_record() {
        use crate::daemon::agent_activity::{Doing, Event};
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::PromptSubmitted, 1_000);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let kept = w.records.all().await;
        assert_eq!(kept.len(), 1);
        let seen = kept[0].seen.expect("the sweep records what it read");
        assert_eq!(seen.doing, Doing::Working);
        assert_eq!(seen.last_event, Event::PromptSubmitted);
        assert_eq!(seen.prompts, 2);
    }

    #[tokio::test]
    async fn a_restart_keeps_the_session_its_hooks_report_under() {
        use crate::daemon::agent_activity::{Doing, Event};
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.records
            .note(&recorded(
                "j1",
                Watch::Hooked {
                    session_id: "sess-1".into(),
                    delivered_at: now_ms() - PAST_THE_WINDOW,
                },
                snapshot(Doing::Working, Event::PromptSubmitted, 1_000),
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        let live = w.registry.live();
        assert_eq!(
            live[0].watch,
            Watch::Adopted {
                session_id: "sess-1".into()
            },
            "the pane's hooks still report under that session — the token map is on disk for exactly this"
        );
        assert_eq!(live[0].seen.map(|s| s.doing), Some(Doing::Working));
    }

    #[tokio::test]
    async fn an_adopted_pane_the_record_shows_finished_is_concluded_after_the_restart() {
        use crate::daemon::agent_activity::{Doing, Event};
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                snapshot(Doing::Idle, Event::Stopped, PAST_IDLE),
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        // Activities is empty: this pane went quiet before the restart and will
        // never report again.
        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(
            failed.len(),
            1,
            "without the snapshot a restart makes every job pane unaccountable for the rest of its life"
        );
        assert!(failed[0].1.contains("ended a turn"), "{}", failed[0].1);
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn an_adopted_pane_caught_mid_turn_keeps_its_slot() {
        use crate::daemon::agent_activity::{Doing, Event};
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                snapshot(Doing::Working, Event::PromptSubmitted, PAST_SILENT),
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        supervise(
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            &Activities::new(),
        )
        .await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "a turn still running at the restart is kept until its own agent reports again"
        );
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn what_the_session_says_now_beats_what_a_previous_daemon_recorded() {
        use crate::daemon::agent_activity::{Doing, Event};
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.hold(
            "j1",
            "forge-job-j1",
            Watch::Adopted {
                session_id: "sess-1".into(),
            },
            snapshot(Doing::Idle, Event::Stopped, PAST_IDLE),
        );
        let acts = Activities::new();
        said(&acts, "sess-1", Event::PromptSubmitted, 0);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "a stale snapshot must never outrank the agent speaking in this daemon"
        );
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_with_no_channel_at_all_is_concluded_by_nothing_here() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        sup(&w).await;

        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_sweep_that_ran_to_the_end_says_so() {
        let w = world(vec![], None, None);
        assert_eq!(
            w.registry.last_swept(),
            None,
            "a box that has not swept must not read as one that has"
        );

        sup(&w).await;

        assert!(w.registry.last_swept().is_some());
    }

    #[tokio::test]
    async fn a_pane_that_will_not_close_keeps_its_slot_and_its_job() {
        use crate::daemon::agent_activity::Event;
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        *w.panes.kill_errs.lock().unwrap() = 1;
        w.registry
            .note("j1", "forge-job-j1", hooked("sess-1", PAST_THE_WINDOW));
        let acts = Activities::new();
        said(&acts, "sess-1", Event::Stopped, PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        assert_eq!(
            w.registry.count(),
            1,
            "a slot given back while its pane runs is a slot this box would hand out twice"
        );
    }

    #[tokio::test]
    async fn a_restart_adopts_the_panes_it_finds() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into(), "forge-job-j2".into()];

        assert_eq!(
            adopt(&w.panes, &w.report, &w.records, &w.registry).await,
            Adopted {
                alive: 2,
                buried: 0
            }
        );

        assert_eq!(
            w.registry.live(),
            vec![
                Live {
                    job_id: "j1".into(),
                    pane: "forge-job-j1".into(),
                    watch: Watch::Unhooked,
                    seen: None
                },
                Live {
                    job_id: "j2".into(),
                    pane: "forge-job-j2".into(),
                    watch: Watch::Unhooked,
                    seen: None
                },
            ]
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
        assert!(w.rec.killed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_core_path_this_box_does_not_have_loses_to_the_boxs_own_binding() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        if let Some(Prepared::Took(p)) = w.pool.prepare.lock().unwrap().as_mut() {
            p.repo_path = Some("/home/somebody-else/services/sid-desk".into());
        }

        assert_eq!(take(&w, 2).await, Took::Started("j1".into()));
        assert_eq!(w.rec.cwds.lock().unwrap().clone(), vec![box_repo()]);
    }

    /// And when core's path IS present here, it still wins — the order is unchanged.
    #[tokio::test]
    async fn a_core_path_that_exists_here_is_still_preferred() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );

        assert_eq!(take(&w, 2).await, Took::Started("j1".into()));
        assert_eq!(w.rec.cwds.lock().unwrap().clone(), vec![core_repo()]);
    }

    /// Neither candidate is present: the hold goes back rather than a pane opening in the daemon's home.
    #[tokio::test]
    async fn no_candidate_exists_on_this_box_so_the_hold_goes_back() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        if let Some(Prepared::Took(p)) = w.pool.prepare.lock().unwrap().as_mut() {
            p.repo_path = Some("/nowhere/on/this/box".into());
        }

        let took = take_one(
            &w.pool,
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            "p1",
            "master-session",
            Some(Path::new("/also/nowhere")),
            2,
            Some(&w.tokens),
        )
        .await;

        assert_eq!(took, Took::GaveBack("j1".into()));
        assert!(w.rec.opened.lock().unwrap().is_empty(), "no pane may open");
        assert_eq!(
            w.rec.released.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
    }

    // this is a refusal and not a fallback to the daemon's own working directory.
    #[tokio::test]
    async fn a_job_with_no_checkout_anywhere_gives_the_hold_back() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        if let Some(Prepared::Took(p)) = w.pool.prepare.lock().unwrap().as_mut() {
            p.repo_path = None;
        }

        let took = take_one(
            &w.pool,
            &w.panes,
            &w.report,
            &w.records,
            &w.registry,
            "p1",
            "master-session",
            None,
            2,
            Some(&w.tokens),
        )
        .await;

        assert_eq!(took, Took::GaveBack("j1".into()));
        assert_eq!(
            w.rec.released.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_stamp_that_never_answered_keeps_its_pane_for_the_next_tick() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        *w.pool.start.lock().unwrap() = None;
        w.pool.start_errs.store(true, Ordering::SeqCst);

        assert_eq!(take(&w, 2).await, Took::Unresolved("j1".into()));

        assert!(w.rec.killed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
        assert_eq!(w.records.all().await.len(), 1);
    }

    #[tokio::test]
    async fn the_next_tick_closes_an_unresolved_job_core_says_is_not_ours() {
        let mut w = world(vec![], None, None);
        w.report.disowned = true;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        sup(&w).await;

        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
        assert!(w.records.all().await.is_empty());
    }

    #[tokio::test]
    async fn a_job_is_recorded_before_the_stamp_is_asked_for() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            Some(Started::Refused(Refusal::HoldLost)),
        );

        take(&w, 2).await;

        // the refusal cleared it again, so the proof is that the refusal had something to clear
        assert_eq!(
            w.rec.recorded.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
        assert!(w.records.all().await.is_empty());
    }

    #[tokio::test]
    async fn a_restart_reports_a_job_whose_pane_did_not_survive() {
        let w = world(vec![], None, None);
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        let adopted = adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(
            adopted,
            Adopted {
                alive: 0,
                buried: 1
            }
        );
        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "j1");
        assert!(failed[0].1.contains("did not survive"));
        assert!(w.records.all().await.is_empty());
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_restart_reports_nothing_for_a_job_whose_pane_is_still_there() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        let adopted = adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(
            adopted,
            Adopted {
                alive: 1,
                buried: 0
            }
        );
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert!(w.rec.killed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn a_pane_with_no_record_is_adopted_and_recorded_again() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j9".into()];

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(w.registry.count(), 1);
        assert_eq!(
            w.records.all().await,
            vec![Live {
                job_id: "j9".into(),
                pane: "forge-job-j9".into(),
                watch: Watch::Unhooked,
                seen: None
            }]
        );
    }

    #[tokio::test]
    async fn a_restart_keeps_the_record_when_core_cannot_be_told() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        let adopted = adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(
            adopted,
            Adopted {
                alive: 0,
                buried: 0
            }
        );
        assert_eq!(w.records.all().await.len(), 1);
    }

    #[tokio::test]
    async fn a_death_core_refused_at_boot_is_handed_to_the_supervisor() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);

        sup(&w).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "j1");
        assert_eq!(w.registry.count(), 0);
    }

    #[test]
    fn adoption_reads_what_this_box_recorded_before_what_it_is_running() {
        let body = include_str!("pool_jobs.rs")
            .split("pub async fn adopt(")
            .nth(1)
            .and_then(|r| r.split("\npub ").next())
            .unwrap_or_default();
        let recorded = body
            .find("records.all().await")
            .expect("adoption reads the records");
        let panes = body
            .find("panes.names().await")
            .expect("adoption reads the panes");
        assert!(
            recorded < panes,
            "the record snapshot has to be taken first, or a claim landing between the two reads is reported dead (ISS-1080)"
        );
    }

    #[tokio::test]
    async fn a_failure_core_did_not_take_is_sent_again_next_tick() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);
        w.records.note(&recorded("j1", Watch::Unhooked, None)).await;

        sup(&w).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);

        sup(&w).await;
        assert_eq!(w.rec.failed.lock().unwrap().len(), 1);
        assert_eq!(w.registry.count(), 0);
        assert!(w.records.all().await.is_empty());
    }

    #[tokio::test]
    async fn a_job_record_carries_the_session_and_the_snapshot_across_a_restart() {
        use crate::daemon::agent_activity::{Doing, Event};
        let home = TempHome::new("filerecords");
        let r = FileRecords {
            dir: home.path().to_path_buf(),
        };
        let seen = job_exit::Reported {
            doing: Doing::Idle,
            last_event: Event::Stopped,
            at: now_ms(),
            prompts: 2,
        };
        r.note(&Live {
            job_id: "j1".into(),
            pane: "forge-job-j1".into(),
            watch: Watch::Hooked {
                session_id: "sess-1".into(),
                delivered_at: now_ms(),
            },
            seen: Some(seen),
        })
        .await;

        assert_eq!(
            r.all().await,
            vec![Live {
                job_id: "j1".into(),
                pane: "forge-job-j1".into(),
                watch: Watch::Adopted {
                    session_id: "sess-1".into()
                },
                seen: Some(seen)
            }],
            "what a restart reads back is what decides whether the pane is still work in flight"
        );
    }

    #[tokio::test]
    async fn a_record_that_cannot_be_replaced_leaves_the_one_standing_there() {
        #[cfg(unix)]
        {
            use crate::daemon::agent_activity::{Doing, Event};
            use std::os::unix::fs::PermissionsExt;
            let home = TempHome::new("filerecords-torn");
            let dir = home.path().join("pool-jobs");
            let r = FileRecords { dir: dir.clone() };
            let first = job_exit::Reported {
                doing: Doing::Working,
                last_event: Event::PromptSubmitted,
                at: now_ms(),
                prompts: 1,
            };
            let live = |seen| Live {
                job_id: "j1".into(),
                pane: "forge-job-j1".into(),
                watch: Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                seen: Some(seen),
            };
            r.note(&live(first)).await;

            // No temp file can be created here, so the rename can never happen.
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500)).unwrap();
            r.note(&live(job_exit::Reported {
                prompts: 9,
                ..first
            }))
            .await;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();

            assert_eq!(
                r.all().await[0].seen,
                Some(first),
                "a write that could not be completed must leave the previous record whole — half a record reads back as a pane nothing is known about, kept for the rest of its life"
            );
            assert!(
                std::fs::read_dir(&dir)
                    .unwrap()
                    .flatten()
                    .all(|e| !e.file_name().to_string_lossy().ends_with(".tmp")),
                "a failed replacement leaves no scratch behind"
            );
        }
    }

    #[test]
    fn no_job_record_is_ever_written_in_place() {
        let body = THIS_SOURCE
            .split("impl Records for FileRecords {")
            .nth(1)
            .and_then(|r| r.split("\n}").next())
            .unwrap_or_default();
        assert!(
            !body.contains("fs::write(&path"),
            "a sweep replaces this file every minute now that it carries the snapshot a restart is judged on, and an in-place write truncates first (ISS-1099 on the same disk): {body}"
        );
    }

    #[test]
    fn a_record_path_refuses_an_id_core_would_not_send() {
        let r = FileRecords {
            dir: PathBuf::from("/tmp/forge-pool-jobs-test"),
        };
        assert!(r.path("3d93cbab-98e1-4ea2-97a8-46f3543b92e3").is_some());
        assert!(r.path("../../etc/passwd").is_none());
        assert!(r.path("a/b").is_none());
        assert!(r.path("").is_none());
        assert!(r.path(&"x".repeat(65)).is_none());
    }

    #[test]
    fn a_pane_name_round_trips_to_its_job_id() {
        let job = "3d93cbab-98e1-4ea2-97a8-46f3543b92e3";
        assert_eq!(job_id_of(&pane_name(job)).as_deref(), Some(job));
    }

    #[test]
    fn a_name_that_is_not_a_job_pane_decodes_to_nothing() {
        assert_eq!(job_id_of("forge-master-forge-dev"), None);
        assert_eq!(job_id_of("forge-job-"), None);
        assert_eq!(job_id_of("forge-job"), None);
    }

    const CORE_JOB_EVENT_KINDS: &[&str] = &[
        "stdout",
        "stderr",
        "tool_call",
        "tool_result",
        "progress",
        "result",
        "intervention",
        "kill_ack",
    ];

    /// Captures the body of the first request and answers `200`.
    async fn capture_one() -> (String, tokio::sync::oneshot::Receiver<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let body = "{}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
            let _ = tx.send(req);
        });
        (format!("http://{addr}"), rx)
    }

    #[tokio::test]
    async fn the_heartbeat_carries_a_kind_core_accepts() {
        let (url, rx) = capture_one().await;
        let client = CoreClient::new(url, String::from("tok"));
        let report = CoreReport { client: &client };
        let _ = report.progress("job-1", Some("working")).await;
        let req = rx.await.expect("the server must have seen the beat");
        let kind = CORE_JOB_EVENT_KINDS
            .iter()
            .find(|k| req.contains(&format!("\"kind\":\"{k}\"")));
        assert!(
            kind.is_some(),
            "the heartbeat kind is not one core accepts, so every beat is a 400: {req}"
        );
    }

    /// Longer than this box waits before a pane it has heard nothing from at
    /// all is one it cannot account for.
    const PAST_UNHEARD: i64 = job_unheard::UNHEARD_BEFORE_ABANDONED.as_millis() as i64 + 1;

    /// One hook report, WITHOUT the submission before it — the shape a pane
    /// adopted mid-turn makes, its `UserPromptSubmit` having been counted by a
    /// daemon that is gone.
    fn said_since_the_restart(
        acts: &Activities,
        session: &str,
        event: crate::daemon::agent_activity::Event,
        ago: i64,
    ) {
        use crate::daemon::agent_activity::Report;
        acts.record(
            session,
            Report {
                event,
                at: now_ms() - ago,
                subject: None,
                conversation: None,
            },
        );
    }

    #[tokio::test]
    async fn an_adopted_pane_this_box_never_hears_from_stops_holding_its_slot() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-neverstarted".into(),
                },
                None,
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        w.registry.backdate("j1", now_ms() - PAST_UNHEARD);
        sup(&w).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(
            failed.len(),
            1,
            "turn_evidence declines an adopted watch and job_exit declines an empty snapshot, so without a third reading this pane holds its slot for the rest of its life"
        );
        assert!(
            failed[0].1.contains("nothing whatever"),
            "the reason must say what was missing: {}",
            failed[0].1
        );
        assert_eq!(w.registry.count(), 0, "the slot did not come back");
        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()],
            "a slot given back while its pane runs is a slot this box would hand out twice"
        );
    }

    #[tokio::test]
    async fn a_pane_this_box_has_no_channel_to_stops_holding_its_slot_too() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1", Watch::Unhooked);

        w.registry.backdate("j1", now_ms() - PAST_UNHEARD);
        sup(&w).await;

        assert_eq!(
            w.rec.failed.lock().unwrap().len(),
            1,
            "a pane whose capability could not be minted can never report, so no reading this box has will ever conclude it"
        );
        assert_eq!(w.registry.count(), 0);
    }

    #[tokio::test]
    async fn a_pane_inside_the_window_is_left_alone() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                None,
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        w.registry.backdate("j1", now_ms() - PAST_UNHEARD + 60_000);
        sup(&w).await;

        assert!(
            w.rec.failed.lock().unwrap().is_empty(),
            "an agent this box has not yet waited out is one it may still hear from"
        );
        assert_eq!(w.registry.count(), 1);
    }

    #[tokio::test]
    async fn the_window_starts_again_at_the_adoption_and_not_at_the_pane() {
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                None,
            ))
            .await;

        let before = now_ms();
        adopt(&w.panes, &w.report, &w.records, &w.registry).await;

        let noted = w.registry.noted_at("j1").expect("the slot is held");
        assert!(
            noted >= before,
            "a pane adopted hours into its life must be given the whole window from the adoption, or the first sweep after a restart concludes it"
        );
        sup(&w).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn an_adopted_pane_that_ends_its_turn_gives_the_slot_back_though_this_daemon_counted_no_prompt(
    ) {
        use crate::daemon::agent_activity::Event;
        let mut w = world(vec![], None, None);
        w.panes.names = vec!["forge-job-j1".into()];
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.records
            .note(&recorded(
                "j1",
                Watch::Adopted {
                    session_id: "sess-1".into(),
                },
                None,
            ))
            .await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        // The submission was counted by the daemon that briefed this pane, so
        // this one's counter reads zero however much work the agent did.
        let acts = Activities::new();
        said_since_the_restart(&acts, "sess-1", Event::Stopped, PAST_IDLE);

        supervise(&w.panes, &w.report, &w.records, &w.registry, &acts).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(
            failed.len(),
            1,
            "a zero this daemon never had the chance to increment is not evidence no turn began, and reading it as one holds the slot for the pane's life"
        );
        assert!(failed[0].1.contains("ended a turn"), "{}", failed[0].1);
        assert_eq!(w.registry.count(), 0);
    }
}

/// What a job pane's preparation says when this daemon's own binary has been
/// replaced under it, or is gone (ISS-1200).
#[cfg(test)]
mod own_exe_reporting_tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn logged_while(f: impl FnOnce()) -> String {
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        // Why a capture needs this: `crate::daemon::keep_tracing_capturable`.
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    fn scratch(label: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "forge-pool-exe-{label}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    /// A file `is_runnable` accepts, on every platform this crate builds for:
    /// what these cases are about is a journal line and a settings file, and
    /// neither has a shell in it.
    fn runnable(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "#!/bin/sh\nexit 0\n").expect("write");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
        p
    }

    #[test]
    fn a_replaced_binary_is_named_in_the_journal_with_the_project_the_pane_and_both_paths() {
        let dir = scratch("replaced");
        let installed = runnable(&dir, "forge-runner");
        let annotated = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let cwd = dir.join("checkout");
        std::fs::create_dir_all(&cwd).expect("checkout");

        let mut went = false;
        let said = logged_while(|| {
            went = install_pane_hooks(
                &cwd,
                "proj-7",
                "forge-job-1",
                crate::exe::resolve(&annotated),
            );
        });

        assert!(
            went,
            "the pane was refused although a build stands at the path"
        );
        assert!(said.contains("proj-7"), "the project is not named: {said}");
        assert!(
            said.contains("forge-job-1"),
            "the pane is not named: {said}"
        );
        assert!(
            said.contains(annotated.to_str().unwrap()),
            "the path it started on is not named, so a reader cannot tell what was replaced: {said}"
        );
        assert!(
            said.contains(&format!(
                "hooks name {}, the build standing there now",
                installed.display()
            )),
            "the destination is not named in its own right — and the annotated path CONTAINS it, so a bare `contains` here passes whatever the line says (consult bec748 F1): {said}"
        );
    }

    #[test]
    fn a_binary_that_is_gone_refuses_the_hooks_and_says_why() {
        let dir = scratch("gone");
        let annotated = dir.join(format!("forge-runner{}", crate::exe::DELETED_SUFFIX));
        let cwd = dir.join("checkout");
        std::fs::create_dir_all(&cwd).expect("checkout");

        let mut went = true;
        let said = logged_while(|| {
            went = install_pane_hooks(
                &cwd,
                "proj-7",
                "forge-job-1",
                crate::exe::resolve(&annotated),
            );
        });

        assert!(
            !went,
            "the pane was opened as though its hooks were registered"
        );
        assert!(
            said.contains("proj-7") && said.contains("forge-job-1"),
            "{said}"
        );
        assert!(
            said.contains("nothing can invoke it"),
            "the reason is not in the line: {said}"
        );
        assert!(
            !hook_install::settings_path(&cwd).exists(),
            "commands that die at every call were written anyway"
        );
    }
}
