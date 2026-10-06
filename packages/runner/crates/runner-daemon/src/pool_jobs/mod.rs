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

mod ports;
pub use ports::*;
mod panes;
pub use panes::*;

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
use runner_transport::pool::{self, PoolEntry, Prepared, PreparedJob, ReadFailure, Started};
use runner_transport::{lifecycle, CoreClient};
use runner_workspace::hook_install;
use runner_workspace::terminal;

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
    /// This job waits and the project has no master session core issued this
    /// box, which is the only session core holds a pool job under; nothing was
    /// asked of core beyond the read.
    NoMasterSession(String),
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

/// Ask core to prepare the job for this master session; a refusal or a failure is what `take_one` answers.
async fn prepare(
    pool_ports: &dyn Pool,
    job_id: &str,
    session_id: &str,
    project_id: &str,
) -> std::result::Result<Box<PreparedJob>, Took> {
    match pool_ports.prepare(job_id, session_id).await {
        Ok(Prepared::Took(p)) => Ok(p),
        Ok(Prepared::Refused(r)) => {
            tracing::info!(
                "[pool] {project_id}: job {} not taken: {}",
                job_id,
                r.describe()
            );
            Err(Took::Refused(r.as_str().to_string()))
        }
        Err(e) => {
            tracing::warn!("[pool] {project_id}: prepare failed: {e}");
            Err(Took::PrepareFailed(e.to_string()))
        }
    }
}

/// What a pane for a prepared job starts from: its checkout, its prompt and the project's declared
/// MCP servers. A job missing any of them is given back, and the refusal is what `take_one` answers.
async fn launch_inputs(
    pool_ports: &dyn Pool,
    prepared: &PreparedJob,
    session_id: &str,
    project: ServedProject<'_>,
) -> std::result::Result<(PathBuf, String, ProjectMcpServers), Took> {
    let project_id = project.id;
    let Some(cwd) = prepared.repo_path.as_deref().map(PathBuf::from) else {
        give_back(pool_ports, &prepared.job_id, session_id).await;
        tracing::error!(
            "[pool] {project_id}: job {} given back — core prepared it with no checkout, so this device's binding to {} names none; bind one with `forge-runner bind {} --path <dir>`",
            prepared.job_id,
            project.slug,
            project.slug
        );
        return Err(Took::GaveBack(prepared.job_id.clone()));
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
        return Err(Took::GaveBack(prepared.job_id.clone()));
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
        return Err(Took::GaveBack(prepared.job_id.clone()));
    };

    let declared = match pool_ports.mcp_servers(project_id).await {
        Ok(declared) => declared,
        Err(e) => {
            give_back(pool_ports, &prepared.job_id, session_id).await;
            tracing::error!(
                "[pool] {project_id}: job {} given back — this box could not read the project's declared MCP servers ({e}), and a pane started now would carry none of them",
                prepared.job_id
            );
            return Err(Took::GaveBack(prepared.job_id.clone()));
        }
    };
    Ok((cwd, prompt, declared))
}

/// Tell core the job started. A refusal kills the pane, or holds it under supervision when it will
/// not close; no answer holds it for the next tick to ask whose job it is. `None` when core took it.
async fn start_or_hold(
    ports: &JobPorts<'_>,
    registry: &JobPanes,
    job_id: &str,
    pane: &str,
    opened: &Live,
    session_id: &str,
    project_id: &str,
) -> Option<Took> {
    match ports.pool.start(job_id, session_id).await {
        Ok(Started::Ok) => None,
        Ok(Started::Refused(r)) => {
            if let Err(e) = ports.panes.kill(pane).await {
                // The pane may still be working a job core refused, so the
                // slot and the record stay: the next tick asks core again,
                // hears the job is not this box's, and closes it then.
                registry.hold(
                    job_id,
                    pane,
                    opened.watch.clone(),
                    None,
                    None,
                    opened.opened_at,
                );
                registry.note_project(job_id, project_id);
                tracing::warn!(
                    "[pool] {project_id}: start refused for job {} ({}) but {pane} would not close: {e} — kept under supervision, and the next tick closes it",
                    job_id,
                    r.as_str()
                );
                return Some(Took::Refused(r.as_str().to_string()));
            }
            ports.panes.released(pane).await;
            ports.records.forget(job_id).await;
            tracing::warn!(
                "[pool] {project_id}: start refused for job {} ({}) — pane {pane} killed",
                job_id,
                r.as_str()
            );
            Some(Took::Refused(r.as_str().to_string()))
        }
        Err(e) => {
            registry.hold(
                job_id,
                pane,
                opened.watch.clone(),
                None,
                None,
                opened.opened_at,
            );
            registry.note_project(job_id, project_id);
            tracing::error!(
                "[pool] {project_id}: start for job {} did not answer ({e}) — pane {pane} kept, and the next tick asks core whose job it is",
                job_id
            );
            Some(Took::Unresolved(job_id.to_string()))
        }
    }
}

/// The record of a pane just opened for a job: watched through its hooks when a channel was opened.
fn opened_live(job_id: &str, pane: &str, channel: Option<String>, opened_at: i64) -> Live {
    let watch = match channel {
        Some(session) => Watch::Hooked {
            session_id: session,
            delivered_at: now_ms(),
        },
        None => Watch::Unhooked,
    };
    Live {
        job_id: job_id.to_string(),
        pane: pane.to_string(),
        watch,
        seen: None,
        transcript: None,
        opened_at: Some(opened_at),
    }
}

/// The MCP servers a started pane carries, as its log line names them.
fn carrying(declared: &ProjectMcpServers) -> String {
    if declared.resolved_names.is_empty() {
        "no declared MCP servers".to_string()
    } else {
        declared.resolved_names.join(", ")
    }
}

pub async fn take_one(
    ports: &JobPorts<'_>,
    registry: &JobPanes,
    project: ServedProject<'_>,
    master_session: Option<&str>,
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
    let Some(session_id) = master_session else {
        return Took::NoMasterSession(entry.job_id);
    };

    let prepared = match prepare(pool_ports, &entry.job_id, session_id, project_id).await {
        Ok(prepared) => prepared,
        Err(not_taken) => return not_taken,
    };

    let pane = pane_name(&prepared.job_id);
    let (cwd, prompt, declared) =
        match launch_inputs(pool_ports, &prepared, session_id, project).await {
            Ok(inputs) => inputs,
            Err(gave_back) => return gave_back,
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
    let opened = opened_live(&prepared.job_id, &pane, channel, opened_at);
    records.note(&opened).await;

    if let Some(not_started) = start_or_hold(
        ports,
        registry,
        &prepared.job_id,
        &pane,
        &opened,
        session_id,
        project_id,
    )
    .await
    {
        return not_started;
    }

    registry.hold(
        &prepared.job_id,
        &pane,
        opened.watch,
        None,
        None,
        opened.opened_at,
    );
    registry.note_project(&prepared.job_id, project_id);
    if let Err(e) = report.ack(&prepared.job_id).await {
        tracing::warn!("[pool] ack for job {} failed: {e}", prepared.job_id);
    }
    tracing::info!(
        "[pool] {project_id}: job {} ({}) running in {pane}, carrying {}",
        prepared.job_id,
        prepared.job_type,
        carrying(&declared)
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
    let env = terminal::pane_env(project_id, slug);
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
                if let Err(e) = panes.kill(&live.pane).await {
                    tracing::warn!(
                        "[pool] job {} is terminal but {} would not close: {e} — keeping it under supervision, and the next tick closes it",
                        live.job_id,
                        live.pane
                    );
                    continue;
                }
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

#[cfg(test)]
mod tests;
