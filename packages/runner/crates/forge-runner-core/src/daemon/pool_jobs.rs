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

use crate::daemon::terminal;
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

/// What the box tells core about a job it is running.
// cm:guard `progress` is not telemetry. `jobs/loop-monitor.ts:reapResultMisses` fails a `dispatched` job whose last progress is older than `RESULT_QUIET_MINUTES` (60), computed as the greatest of its last job event, its last phase row and `dispatched_at` — and a release runs longer than that. Without this call core reaps every healthy release at the hour mark.
#[async_trait::async_trait]
pub trait Report: Send + Sync {
    async fn ack(&self, job_id: &str) -> Result<()>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    async fn progress(&self, job_id: &str) -> Result<bool>;
    /// `Ok(false)` means core has answered that the job is no longer this box's.
    async fn fail(&self, job_id: &str, error: &str) -> Result<bool>;
}

/// What this box has started and not yet seen the end of, across restarts.
// cm:guard the pane inventory alone cannot answer this, and that is the whole reason this exists: a pane that did not survive leaves NO trace on the box, so a supervisor rebuilt from `tmux list-sessions` finds an empty set and reports nothing — while core waits out `RESULT_QUIET_MINUTES` (60) for a death this box could have named the moment it restarted. Core serves no "what do you still owe me" route either: `GET /me/pool` is queued rows only, and `turn-verdict` answers `done:true` for every job with no issue.
#[async_trait::async_trait]
pub trait Records: Send + Sync {
    async fn note(&self, job_id: &str, pane: &str);
    async fn forget(&self, job_id: &str);
    async fn all(&self) -> Vec<Live>;
}

/// The pane a job runs in.
#[async_trait::async_trait]
pub trait Panes: Send + Sync {
    async fn open(&self, name: &str, cwd: &Path, prompt: &str) -> Result<()>;
    async fn alive(&self, name: &str) -> bool;
    async fn kill(&self, name: &str) -> Result<()>;
    /// Every job pane on this box right now, by name.
    async fn names(&self) -> Vec<String>;
}

/// One job this box is running, and the pane it is running in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Live {
    pub job_id: String,
    pub pane: String,
}

/// What this box is running, keyed by job.
// cm:guard the map is a CACHE and tmux is the authority, the same split `recovery_ports.rs:PaneMasters` makes and for the same reason: a daemon restart empties this while every pane is still running, so a supervisor that trusted it would report every live job dead on the first tick after any restart. `adopt` is what turns that miss into a cache fill.
pub struct JobPanes {
    inner: Mutex<HashMap<String, String>>,
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

    /// Who this box holds a job as, for the whole life of this daemon.
    // cm:guard a UUID and nothing else: `claimBodySchema` in `devices/pool-routes.ts` validates `sessionId` as `z.string().uuid()`, so a name like `pool@dev1` is a 400 on every claim this box makes. It is deliberately NOT an `agent_sessions` id — the row a pool job gets is minted by core in `prepare-claimed-job.ts` and this id only ever lives in `jobs.held_by`, for the seconds between the hold and the stamp. `master-reaper.ts` LEFT JOINs the sessions table and collects a session-less holder by the age of `held_at`, which is exactly the right outcome for a box that died mid-claim.
    // cm:guard FRESH on every boot, never persisted. A daemon that reused an id across restarts would let a hold left by the process that died look like one the new process is still following through on, and the reaper is the only thing that clears it.
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn note(&self, job_id: &str, pane: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(job_id.to_string(), pane.to_string());
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
            .map(|(job_id, pane)| Live {
                job_id: job_id.clone(),
                pane: pane.clone(),
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

/// The job id a pane name carries, or `None` when the name is not one of ours.
// cm:guard a name whose suffix is empty answers `None` rather than an empty job id. `forge-job-` alone is not a job, and an empty id would be posted to `/api/jobs//events` — a path that resolves to something else entirely.
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

/// Re-learn what this box is running, from the panes and from what it wrote down.
// cm:guard adoption never OPENS anything, and never kills a pane it finds. A pane that survived is a job still working: re-launching it would put two agents on one release, and killing it would take the checkout out from under one. Every write here is a map fill or a death this box can prove.
// cm:guard the two halves answer different questions and neither is redundant. The records say what this box STARTED, which is the only way to learn that a job's pane is gone — a dead pane leaves no trace to enumerate. The panes say what is RUNNING, which is the only way to pick up a job whose record was lost, and a record write is best-effort so that happens. Dropping either half loses a whole class: without the records a job whose box rebooted waits out core's 60-minute hop, and without the panes a surviving agent runs unsupervised until the same hop kills it under him.
pub async fn adopt(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
) -> Adopted {
    let mut out = Adopted::default();
    // cm:guard the records are read BEFORE the panes, and the order is the whole safety of the two snapshots. A claim landing between them writes its record and then opens its pane, so this order can only miss a record whose pane it then finds — adopted and re-recorded, which costs nothing. Reversed, the same claim would land a record after a pane list that predates it, and this pass would report a job core had just stamped as dead on arrival.
    let recorded = records.all().await;
    let live: Vec<String> = panes.names().await;

    for rec in recorded {
        if live.iter().any(|n| *n == rec.pane) {
            continue;
        }
        // cm:guard a record with no pane is a DEATH this box observed, not a job to start again. The pane is where the agent was; nothing on this machine can resume it, and core is the only place the work can be re-queued from. So it is failed by name and the record is dropped — an entry kept over a failed report is `supervise`'s job, on a job that is still in the registry, and duplicating that retry here would send the same failure twice on every tick of a box that could not reach core.
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
            // cm:guard the obligation is handed to the SUPERVISOR, not left for the next boot. Adoption runs once, so a core that was unreachable for those few seconds would otherwise bury the report until someone restarted the daemon again. `supervise` finds a registry entry whose pane is not alive and sends exactly this failure, every tick, until core takes it — which is the retry that already exists rather than a second one here.
            Err(e) => {
                registry.note(&rec.job_id, &rec.pane);
                tracing::warn!(
                    "[pool] job {} did not survive the restart and core could not be told: {e} — the supervisor will keep sending it",
                    rec.job_id
                );
            }
        }
    }

    for name in live {
        if let Some(job_id) = job_id_of(&name) {
            registry.note(&job_id, &name);
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

/// Take at most one claimable job for this project and bring it to life.
// cm:guard ONE job per project per pass, and the bound is separate from it. A pass that drained the pool would open every pane on this box before the next sweep could see whether any of them survived, and `smoke` mints one job per stage.
// cm:guard the order is prepare, pane, START — never start then pane. `startJobForMaster` stamps `device_id`, `runner_id`, `status` and `started_at` in ONE statement, and everything before it is a plain held `queued` job that `releaseJobFromMaster` and core's three-minute reaper both undo with nothing to unwind. So a box that cannot open the pane gives the hold back and leaves no trace; a box that had stamped first would owe core a failure for a job that never ran.
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
) -> Took {
    if registry.count() >= bound {
        return Took::AtBound;
    }
    let entries = match pool_ports.claimable(project_id).await {
        Ok(e) => e,
        Err(e) => {
            // cm:guard an unreadable pool is EMPTY for this pass and never fatal, the same rule `master.rs:sweep` applies to `admissible`: one project goes quiet for a pass rather than the box going quiet on every project at once.
            tracing::warn!("[pool] {project_id}: cannot read the pool: {e}");
            return Took::NothingClaimable;
        }
    };
    // cm:guard `held_by` is filtered HERE and the filter is not redundant against core's own query: the answer is a page this box may act on some milliseconds later, and a row another session holds is one `prepare` would refuse with `already_held` — a refusal that costs a round trip and reads in the log like a race that mattered. Taking the FIRST claimable row and not the first row is what makes a pool of two, one of them held, still start work this pass.
    let Some(entry) = entries.into_iter().find(|e| e.held_by.is_none()) else {
        return Took::NothingClaimable;
    };

    let prepared = match pool_ports.prepare(&entry.job_id, session_id).await {
        Ok(Prepared::Took(p)) => p,
        Ok(Prepared::Refused(r)) => {
            // cm:guard log the word CORE chose. `release_label_missing` means this box does not hold the production credential and never will until an operator relabels it; `issue_busy` clears itself. A single "claim refused" line makes an operator read two conditions as one.
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
    // cm:guard no checkout means the hold goes BACK, never a pane in whatever directory the daemon happens to be in. A `release_batch` agent tags and promotes the repo it is standing in, so a wrong cwd is not a failed job — it is a release cut from the wrong tree. Core's `repoPath` is the answer; the box's own binding is the fallback `resolve_repo` already computes for every other caller; neither is a refusal by name.
    let Some(cwd) = prepared
        .repo_path
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| fallback_cwd.map(Path::to_path_buf))
    else {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} has no repo path at core and this box has no binding for the project — given back; bind it or set the runner's repo_path",
            prepared.job_id
        );
        return Took::GaveBack(prepared.job_id);
    };

    // cm:guard a preparation with no prompt is refused BY NAME and the hold given back, never run on the system prompt alone. `insertAndEnqueueJob` writes `promptString` for all four kinds and `buildReleaseBatchPrompt` is what tells the agent which release, which runId and which issues — an agent started without it would be a release session with no release.
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

    if let Err(e) = panes.open(&pane, &cwd, &prompt).await {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!("[pool] {project_id}: could not open {pane}: {e} — hold given back");
        return Took::GaveBack(prepared.job_id);
    }

    // cm:guard written BEFORE the stamp is asked for, never after. The window this closes is the one between core committing `startJobForMaster` and this box learning it did: a daemon that died in it would come back with a pane it did not know was its own, and a record written afterwards would never exist for the job it most matters for. A record for a job that never started costs nothing — `adopt` finds the pane, `supervise` asks core, and core's 403 clears it.
    records.note(&prepared.job_id, &pane).await;

    match pool_ports.start(&prepared.job_id, session_id).await {
        Ok(Started::Ok) => {}
        Ok(Started::Refused(r)) => {
            // cm:guard kill the pane this pass opened. The stamp was refused, so the job is not this box's — most often `hold_lost`, which is core's three-minute reaper having handed it on — and an agent left running would work a release another box now owns.
            let _ = panes.kill(&pane).await;
            records.forget(&prepared.job_id).await;
            tracing::warn!(
                "[pool] {project_id}: start refused for job {} ({}) — pane {pane} killed",
                prepared.job_id,
                r.as_str()
            );
            return Took::Refused(r.as_str().to_string());
        }
        // cm:guard a transport error is NOT a refusal, and the pane is KEPT — the opposite of the arm above. `startJobForMaster` stamps in one statement, so a lost response may mean the job is fully this box's with an agent already working it; killing the pane there abandons a running release and leaves core to infer the death. The registry entry resolves it instead: the next tick posts a progress event, and core answers 200 if the stamp landed or 403 if it did not, because `jobs/events-routes.ts` compares `job.deviceId` to the caller and a still-`queued` job has none.
        Err(e) => {
            registry.note(&prepared.job_id, &pane);
            tracing::error!(
                "[pool] {project_id}: start for job {} did not answer ({e}) — pane {pane} kept, and the next tick asks core whose job it is",
                prepared.job_id
            );
            return Took::Unresolved(prepared.job_id);
        }
    }

    registry.note(&prepared.job_id, &pane);
    // cm:guard the ack is owed within `PIPELINE_NEVER_CLAIMED_MS` (3 minutes): `reapAckMisses` fails a `dispatched` job with `acked_at IS NULL` and zero job events, which is every job this arm starts until it says something. It is best-effort only because the first progress event stamps the ack too (`jobs/events-routes.ts`), so a lost ack costs one tick and not the job.
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

async fn give_back(pool_ports: &dyn Pool, job_id: &str, session_id: &str) {
    if let Err(e) = pool_ports.release(job_id, session_id).await {
        // cm:guard a failed release is reported and NOT retried here. Core's three-minute reaper collects a hold whose holder went quiet, so the cost is one window of the row being invisible; a retry loop against a core that is down costs the same window and a log nobody can read.
        tracing::warn!("[pool] could not give job {job_id} back: {e} — the reaper will collect it");
    }
}

/// Stay with every job this box is running, once a tick.
// cm:guard the ONE call does both halves, and that is the design rather than a saving: the progress event is what keeps `reapResultMisses` off a healthy release, and core's refusal of it — 409 `JOB_TERMINATED` or 403, which `events::is_disowned` already names — is how this box learns the job is over. Asking a second route would be a second answer to keep in step with the first.
pub async fn supervise(
    panes: &dyn Panes,
    report: &dyn Report,
    records: &dyn Records,
    registry: &JobPanes,
) {
    for live in registry.live() {
        if !panes.alive(&live.pane).await {
            // cm:guard fail it BY NAME rather than leaving it to the 60-minute result hop. The pane ending is positive evidence this box has: the agent is gone. Waiting for core to infer it from silence costs an hour of a roster sitting at `releasing` — the very wait ISS-1080 exists to remove.
            let reason = format!(
                "the job's pane `{}` ended without reporting an outcome",
                live.pane
            );
            // cm:guard the entry is KEPT when the report does not land, so the next tick sends it again. A box that forgot on a failed call would drop the one piece of evidence nobody else has — that the pane ended — the moment core happened to be unreachable, and the release owner would wait out the 60-minute hop for a death this box watched happen. `Ok(false)` is core answering that the job is already terminal or no longer ours, which is the other way this ends.
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
        match report.progress(&live.job_id).await {
            Ok(true) => {}
            Ok(false) => {
                // cm:guard kill the pane once core says the job is terminal, and the transcript is not what is lost: core holds the job's events and its `agent_sessions` row, which is where a person reads it. An idle TUI pane left standing counts against the bound for ever and accumulates one per release — the same reasoning `master.rs:retire_if_idle` applies to a master with nothing to do.
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

    async fn progress(&self, job_id: &str) -> Result<bool> {
        let beat = JobEventInput::new(
            "status",
            serde_json::json!({ "source": "pool_jobs", "state": "running" }),
        );
        match events::post_job_events(self.client, job_id, &[beat]).await {
            Ok(_) => Ok(true),
            Err(e) if events::is_disowned(&e) => Ok(false),
            Err(e) => Err(e),
        }
    }

    // cm:guard a core that has already ended the job answers `Ok(false)` rather than an error, so the caller stops sending it. `lifecycle::fail` on a terminal job is a refusal, not a failure of this box to report — retrying it for ever would be a tick that never drains against a job nobody can do anything about.
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

    // cm:guard the job id reaches a filesystem path, and core is what supplies it — reject anything that is not the shape core sends, or a crafted id chooses which file this writes or deletes. The same rule and the same character set as `runner/inflight.rs:marker_path`, which is the other place an id off the wire becomes a path.
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
    // cm:guard best-effort, and a write this box could not make is ANNOUNCED rather than swallowed: what is lost is the restart half of the supervision, so the job falls back to core's 60-minute hop instead of being reported dead in seconds. Failing the claim over it would be worse — a release that cannot start because a directory is unwritable.
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

    // cm:guard an unreadable directory answers EMPTY, never an error, the same rule `terminal::names_with_prefix` follows: a restart that could not read this has nothing to say about what died, and refusing to start the daemon over it would cost every project on the box.
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
            });
        }
        out.sort_by(|a, b| a.job_id.cmp(&b.job_id));
        out
    }
}

/// The stand-in for a box that cannot resolve a place to write its records.
// cm:guard this is a PRICED degradation, not a fallback that hides one: what is lost is the restart half of the supervision — a job whose pane died with the daemon waits out core's `RESULT_QUIET_MINUTES` (60) instead of being reported dead in seconds — and the caller says exactly that in an error log before choosing this. Everything else still works, which is why the daemon starts rather than refusing.
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
    // cm:guard briefed through `brief_new_pane` and never `send_line`, which is the rule `terminal.rs` states on that function: a freshly spawned pane is not ready to receive a paste, and the run path that pasted immediately lost the race under load.
    async fn open(&self, name: &str, cwd: &Path, prompt: &str) -> Result<()> {
        if !terminal::available() {
            return Err(Error::Other(
                "tmux is not installed on this box, and a job pane needs it".into(),
            ));
        }
        let argv = terminal::pane_argv(None, None);
        terminal::ensure(name, cwd, &argv, &terminal::pane_env(), None).await?;
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
        recorded: Mutex<Vec<String>>,
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
            repo_path: Some("/srv/app".into()),
            prior_claude_session_id: None,
            runner_id: "r1".into(),
        }))
    }

    #[async_trait::async_trait]
    impl Pool for FakePool {
        async fn claimable(&self, _project_id: &str) -> Result<Vec<PoolEntry>> {
            Ok(self.entries.clone())
        }
        // cm:guard the fake answers `already_held` for a held row rather than handing out whatever
        // preparation the test staged, because core does: without it a claim arm that ignored
        // `held_by` would still look correct here, and the filter would be untested.
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

    struct FakePanes {
        rec: Arc<Recorder>,
        open_fails: bool,
        alive: Mutex<Vec<String>>,
        names: Vec<String>,
    }

    #[async_trait::async_trait]
    impl Panes for FakePanes {
        async fn open(&self, name: &str, _cwd: &Path, prompt: &str) -> Result<()> {
            if self.open_fails {
                return Err(Error::Other("no tmux".into()));
            }
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
        async fn progress(&self, job_id: &str) -> Result<bool> {
            self.rec.beats.lock().unwrap().push(job_id.into());
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
    }

    fn world(entries: Vec<PoolEntry>, prep: Option<Prepared>, start: Option<Started>) -> World {
        let rec = Arc::new(Recorder::default());
        let rec2 = rec.clone();
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
        }
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
            Some(Path::new("/fallback")),
            bound,
        )
        .await
    }

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

    // cm:guard the pane must exist BEFORE the stamp, and the ORDER is the assertion rather than the
    // two calls: a stamp with no process behind it is a job core waits on and then reaps.
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

    // cm:guard a preparation with no prompt is a CONTRACT BREAK core made, and the hold goes back
    // rather than an agent starting on the system prompt alone — a release session with no release.
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

    // cm:guard a refused stamp means another box now owns the job — most often `hold_lost`, core's
    // three-minute reaper having handed it on — so the agent this pass started must not keep working.
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

    // cm:guard skipping a held row is not the same as stopping at one: a box that took only the
    // first row would leave a claimable release behind whichever job another session had just held.
    #[tokio::test]
    async fn a_held_row_is_stepped_over_to_reach_a_claimable_one() {
        let w = world(
            vec![entry("j1", Some("someone-else")), entry("j2", None)],
            Some(prepared("j2", Some("go"))),
            None,
        );

        assert_eq!(take(&w, 2).await, Took::Started("j2".into()));
    }

    // cm:guard the bound is checked BEFORE the pool is read, so a box at capacity costs core no
    // round trip and takes no hold it would immediately have to give back.
    #[tokio::test]
    async fn a_box_at_its_bound_takes_nothing() {
        let w = world(
            vec![entry("j1", None)],
            Some(prepared("j1", Some("go"))),
            None,
        );
        w.registry.note("already", "forge-job-already");

        assert_eq!(take(&w, 1).await, Took::AtBound);

        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_live_pane_is_kept_alive_with_a_progress_event() {
        let w = world(vec![], None, None);
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1");

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(w.rec.beats.lock().unwrap().clone(), vec!["j1".to_string()]);
        assert_eq!(w.registry.count(), 1);
    }

    // cm:guard the pane ending is POSITIVE evidence this box holds, and failing on it is what stops
    // the roster waiting the full 60-minute result hop for core to infer the same thing.
    #[tokio::test]
    async fn a_pane_that_ended_fails_its_job_by_name() {
        let w = world(vec![], None, None);
        w.registry.note("j1", "forge-job-j1");

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "j1");
        assert!(failed[0].1.contains("forge-job-j1"));
        assert_eq!(w.registry.count(), 0);
        assert!(w.rec.beats.lock().unwrap().is_empty());
    }

    // cm:guard core's refusal of the progress event is how this box learns the job is over — one
    // call, both answers; a second route asking "is it done" is a second answer to keep in step.
    #[tokio::test]
    async fn a_job_core_calls_terminal_closes_its_pane_and_leaves_the_registry() {
        let mut w = world(vec![], None, None);
        w.report.disowned = true;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1");

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
        assert!(w.rec.failed.lock().unwrap().is_empty());
    }

    // cm:guard adoption fills the map and touches nothing else. A restart with a live pane must not
    // open a second one — two agents on one release — and must not kill the one that is working.
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
                    pane: "forge-job-j1".into()
                },
                Live {
                    job_id: "j2".into(),
                    pane: "forge-job-j2".into()
                },
            ]
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
        assert!(w.rec.killed.lock().unwrap().is_empty());
    }

    // cm:guard a release cut from the wrong tree is worse than one not cut at all, which is why
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
        )
        .await;

        assert_eq!(took, Took::GaveBack("j1".into()));
        assert_eq!(
            w.rec.released.lock().unwrap().clone(),
            vec!["j1".to_string()]
        );
        assert!(w.rec.opened.lock().unwrap().is_empty());
    }

    // cm:guard the case F1 named: `startJobForMaster` stamps in ONE statement, so a lost response
    // may mean the job is fully this box's with an agent already working it. Killing the pane there
    // abandons a running release; keeping it lets the next tick ask core, which is the only party
    // that knows.
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

    // cm:guard the second half of the same case, and it is what makes the first half safe: core's
    // own answer settles it. A stamp that did not land leaves `jobs.device_id` NULL, and
    // `events-routes.ts` compares it to the caller and answers 403 — which `is_disowned` names.
    #[tokio::test]
    async fn the_next_tick_closes_an_unresolved_job_core_says_is_not_ours() {
        let mut w = world(vec![], None, None);
        w.report.disowned = true;
        w.panes.alive.lock().unwrap().push("forge-job-j1".into());
        w.registry.note("j1", "forge-job-j1");
        w.records.note("j1", "forge-job-j1").await;

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;

        assert_eq!(
            w.rec.killed.lock().unwrap().clone(),
            vec!["forge-job-j1".to_string()]
        );
        assert_eq!(w.registry.count(), 0);
        assert!(w.records.all().await.is_empty());
    }

    // cm:guard the record goes down BEFORE the stamp is asked for. A record written after a
    // successful start does not exist for the job it most matters for — the one whose daemon died
    // inside that window, which is exactly the job whose pane a restart must account for.
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

    // cm:guard F3: a pane that did not survive leaves NO trace on the box, so only the record can
    // say the job existed. Without this the release waits out core's 60-minute result hop for a
    // death this box could name the second it came back.
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

    // cm:guard the other side of the same pass, and the pair is the test: a restart that reported
    // every recorded job dead would kill a release whose agent is still working.
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

    // cm:guard a record is best-effort, so a pane with no record must still be picked up — and the
    // record re-written, or the NEXT restart would report a live job dead.
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
                pane: "forge-job-j9".into()
            }]
        );
    }

    // cm:guard a death core could not be told about is KEPT, so the next start says it again. The
    // record is the only copy of that evidence and a box that dropped it on an unreachable core
    // would lose the one thing it knew.
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

    // cm:guard F5: adoption runs ONCE, so a death core could not be told about at boot has to be
    // handed to the loop that runs for ever. Left only in the records it would wait for the next
    // restart of the daemon, which may be days.
    #[tokio::test]
    async fn a_death_core_refused_at_boot_is_handed_to_the_supervisor() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.records.note("j1", "forge-job-j1").await;

        adopt(&w.panes, &w.report, &w.records, &w.registry).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;

        let failed = w.rec.failed.lock().unwrap().clone();
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].0, "j1");
        assert_eq!(w.registry.count(), 0);
    }

    // cm:guard F6, in the one place it can be asserted without a clock: the records are read BEFORE
    // the panes. A claim writes its record and then opens its pane, so this order can only miss a
    // record whose pane it finds — harmless. Reversed, a job core stamped a moment ago is reported
    // dead on arrival.
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

    // cm:guard F4: the pane ending is evidence nobody else has, and a tick that forgot it because
    // core happened to be unreachable would hand the release back to the 60-minute hop.
    #[tokio::test]
    async fn a_failure_core_did_not_take_is_sent_again_next_tick() {
        let w = world(vec![], None, None);
        *w.report.fail_errs.lock().unwrap() = 1;
        w.registry.note("j1", "forge-job-j1");
        w.records.note("j1", "forge-job-j1").await;

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;
        assert!(w.rec.failed.lock().unwrap().is_empty());
        assert_eq!(w.registry.count(), 1);

        supervise(&w.panes, &w.report, &w.records, &w.registry).await;
        assert_eq!(w.rec.failed.lock().unwrap().len(), 1);
        assert_eq!(w.registry.count(), 0);
        assert!(w.records.all().await.is_empty());
    }

    // cm:guard the id reaches a filesystem path and core supplies it. A crafted id chooses which
    // file this writes or deletes, which is the same rule `runner/inflight.rs:marker_path` states.
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

    // cm:guard the round trip is the whole reason the job id is the entire suffix. A pane name that
    // did not decode would leave a live job with no supervisor after every restart.
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
}
