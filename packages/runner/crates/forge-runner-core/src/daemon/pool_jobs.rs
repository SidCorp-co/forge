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
    async fn note(&self, job_id: &str, pane: &str);
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

/// One job this box is running, the pane it is running in, and what this box
/// may conclude from that pane's silence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub job_id: String,
    pub pane: String,
    pub watch: Watch,
}

pub struct JobPanes {
    inner: Mutex<HashMap<String, (String, Watch)>>,
    session_id: String,
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
        }
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn note(&self, job_id: &str, pane: &str, watch: Watch) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(job_id.to_string(), (pane.to_string(), watch));
        }
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
            .map(|(job_id, (pane, watch))| Live {
                job_id: job_id.clone(),
                pane: pane.clone(),
                watch: watch.clone(),
            })
            .collect();
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }

    pub fn count(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
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

    for rec in recorded {
        if live.iter().any(|n| *n == rec.pane) {
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
        if let Some(job_id) = job_id_of(&name) {
            registry.note(&job_id, &name, Watch::Unhooked);
            records.note(&job_id, &name).await;
            out.alive += 1;
        }
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

    records.note(&prepared.job_id, &pane).await;

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
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(e) => {
            tracing::error!(
                "[pool] {project_id}: cannot name this binary ({e}) — {pane} starts with no hooks, blind to its own turn boundaries"
            );
            return (env, None);
        }
    };
    if let Err(e) = hook_install::install(cwd, &exe) {
        tracing::error!(
            "[pool] {project_id}: could not register hooks in {} ({e}) — {pane} starts blind to its own turn boundaries",
            cwd.display()
        );
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
        let reported = live
            .watch
            .session_id()
            .and_then(|s| activity.get(s))
            .map(|a| turn_evidence::Reported { prompts: a.prompts });
        let evidence = turn_evidence::read(&live.watch, reported, now);
        if let Evidence::NeverStarted { silent_for } = evidence {
            if never_started(panes, report, records, registry, &live, silent_for).await {
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
}

async fn never_started(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
    live: &Live,
    silent_for: i64,
) -> bool {
    let reason = turn_evidence::never_started_reason(&live.pane, silent_for);
    if let Err(e) = report.fail(&live.job_id, &reason).await {
        tracing::warn!(
            "[pool] could not tell core job {} never started: {e} — sending it again next tick",
            live.job_id
        );
        return false;
    }
    if let Err(e) = panes.kill(&live.pane).await {
        tracing::warn!(
            "[pool] job {} was reported as never started but {} would not close: {e} — keeping it under supervision",
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
    async fn note(&self, job_id: &str, pane: &str) {
        let Some(path) = self.path(job_id) else {
            tracing::error!("[pool] refusing to record job {job_id}: not a job id core would send");
            return;
        };
        let _ = std::fs::create_dir_all(&self.dir);
        let body = serde_json::json!({ "pane": pane }).to_string();
        if let Err(e) = std::fs::write(&path, body) {
            tracing::warn!(
                "[pool] could not record job {job_id} at {}: {e} — a restart will leave it to core",
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
            let pane = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["pane"].as_str().map(str::to_string))
                .unwrap_or_else(|| pane_name(job_id));
            out.push(Live {
                job_id: job_id.to_string(),
                pane,
                watch: Watch::Unhooked,
            });
        }
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }
}

pub struct NoRecords;

#[async_trait::async_trait]
impl Records for NoRecords {
    async fn note(&self, _job_id: &str, _pane: &str) {}
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
        inner: Mutex<HashMap<String, String>>,
        rec: Arc<Recorder>,
    }

    #[async_trait::async_trait]
    impl Records for FakeRecords {
        async fn note(&self, job_id: &str, pane: &str) {
            self.rec.recorded.lock().unwrap().push(job_id.into());
            self.inner
                .lock()
                .unwrap()
                .insert(job_id.into(), pane.into());
        }
        async fn forget(&self, job_id: &str) {
            self.inner.lock().unwrap().remove(job_id);
        }
        async fn all(&self) -> Vec<Live> {
            let mut out: Vec<Live> = self
                .inner
                .lock()
                .unwrap()
                .iter()
                .map(|(job_id, pane)| Live {
                    job_id: job_id.clone(),
                    pane: pane.clone(),
                    watch: Watch::Unhooked,
                })
                .collect();
            out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
            out
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
                    watch: Watch::Unhooked
                },
                Live {
                    job_id: "j2".into(),
                    pane: "forge-job-j2".into(),
                    watch: Watch::Unhooked
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
        w.records.note("j1", "forge-job-j1").await;

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
        w.records.note("j1", "forge-job-j1").await;

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
        w.records.note("j1", "forge-job-j1").await;

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
                watch: Watch::Unhooked
            }]
        );
    }

    #[tokio::test]
    async fn a_restart_keeps_the_record_when_core_cannot_be_told() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.records.note("j1", "forge-job-j1").await;

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
        w.records.note("j1", "forge-job-j1").await;

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
        w.records.note("j1", "forge-job-j1").await;

        sup(&w).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);

        sup(&w).await;
        assert_eq!(w.rec.failed.lock().unwrap().len(), 1);
        assert_eq!(w.registry.count(), 0);
        assert!(w.records.all().await.is_empty());
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
}
