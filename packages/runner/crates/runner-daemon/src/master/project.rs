//! One project's turn in a sweep: read what the box can see, ask core what to
//! do about its master, and do it (ADR 0009, What core takes over: Placement
//! and Retirement).

use super::*;
use runner_transport::master_verdict as wire;

/// What one sweep hands every project it walks.
pub(crate) struct Sweep<'a> {
    pub(crate) client: &'a CoreClient,
    pub(crate) cfg: &'a Config,
    pub(crate) shared: &'a SweepShared<'a>,
    pub(crate) adopted: &'a tokio::sync::watch::Receiver<bool>,
    pub(crate) tokens: Option<&'a session_tokens::SessionTokens>,
    pub(crate) served: &'a [runners::MeRunner],
    pub(crate) now_unix: i64,
}

/// What a sweep gathers across projects for its box-level reports.
#[derive(Default)]
pub(crate) struct Found {
    pub(crate) deaf: Vec<Deaf>,
    pub(crate) account_said: Vec<master_limit::Decisive>,
}

/// The work only this box holds for one project this sweep: a pool job it
/// took, and the job panes it holds. What the project owes its master is
/// core's, answered beside the verdict.
pub(crate) struct Work {
    pub(crate) pool_waits: bool,
    pub(crate) job_panes: usize,
}

pub(crate) async fn sweep_project(
    sw: &Sweep<'_>,
    ledger: &mut Option<Ledger>,
    runner: &runners::MeRunner,
    found: &mut Found,
) {
    let masters = sw.shared.masters;
    // Leave is taken per project and held to the end of its turn, so a drain
    // that begins part-way through a sweep waits for the project in hand.
    let admit = sw.shared.drain.admit();
    let restarting = admit.as_ref().err().map(|closed| closed.cause.clone());
    supervise(
        sw.client,
        masters,
        sw.tokens,
        &runner.project_id,
        &runner.slug,
    )
    .await;
    let pool_waits = restarting.is_none()
        && accepts_new_work(&runner.status)
        && take_pool_job(sw.client, sw.cfg, sw.shared, sw.adopted, sw.tokens, runner).await;
    let resolved = match resolve_repo(sw.served, sw.cfg, &runner.project_id) {
        Ok(r) => r,
        Err(slug) => {
            say_unplaced(masters, &runner.project_id, &slug, Unplaced::NoRepoPath);
            return;
        }
    };
    let work = Work {
        pool_waits,
        job_panes: sw.shared.job_panes.holds_for(&runner.project_id),
    };
    if work.pool_waits || work.job_panes > 0 {
        masters.note_work(&runner.project_id);
    }
    let read = Read {
        standing: read_standing(ledger.as_ref(), &runner.project_id),
        conversation: ledger
            .as_ref()
            .and_then(|led| led.master_for_project(&runner.project_id).ok().flatten())
            .and_then(|row| row.conversation_id),
        restarting,
    };
    let Some(seen) = see(sw, runner, &resolved, read).await else {
        return;
    };
    let facts = facts_for(sw, ledger.as_ref(), runner, &resolved, &seen, &work);
    let answer = match wire::verdict(sw.client, &runner.project_id, &runner.runner_id, &facts).await
    {
        Ok(a) => a,
        Err(e) => {
            say_unplaced(
                masters,
                &runner.project_id,
                &runner.slug,
                Unplaced::VerdictUnanswered {
                    detail: e.to_string(),
                },
            );
            return;
        }
    };
    if answer.work.admissible > 0 || answer.work.owed > 0 {
        masters.note_work(&runner.project_id);
    }
    let turn = Turn {
        sw,
        runner,
        resolved: &resolved,
        seen: &seen,
        work: &answer.work,
    };
    obey(&turn, ledger, answer.verdict, found).await;
    drop(admit);
}

fn facts_for(
    sw: &Sweep<'_>,
    ledger: Option<&Ledger>,
    runner: &runners::MeRunner,
    resolved: &crate::dispatch::Resolved,
    seen: &Seen,
    work: &Work,
) -> wire::Facts {
    let masters = sw.shared.masters;
    let activity = sw.shared.activity;
    let judged = if seen.pane_alive {
        ledger.and_then(|led| {
            outdated_facts(
                led,
                masters,
                activity,
                &seen.pane_name,
                resolved,
                &runner.project_id,
            )
        })
    } else {
        None
    };
    let idle = idle_facts(ledger, masters, activity, &runner.project_id);
    let reported = masters
        .get(&runner.project_id)
        .and_then(|(s, _)| activity.get(&s));
    let nudge = nudge_facts(masters, &runner.project_id, reported.as_ref());
    let limit = limit_facts(
        seen.last_said.as_ref(),
        seen.stored_conversation.as_deref(),
        reported.as_ref(),
        agent_activity::now_ms(),
    );
    facts_of(seen, work, judged, idle, limit, nudge, &resolved.repo_path)
}

/// What the ledger and the drain said about the project before anything is awaited.
struct Read {
    standing: StandingRead,
    conversation: Option<String>,
    restarting: Option<String>,
}

/// Read everything the box can see about the project's master. `None` where a
/// pane is up and core refused the registration it is served under, which is
/// already said.
///
/// Takes what the ledger said rather than the ledger, because a `Ledger` held
/// across an await makes this future non-`Send` and the daemon spawns it.
async fn see(
    sw: &Sweep<'_>,
    runner: &runners::MeRunner,
    resolved: &crate::dispatch::Resolved,
    read: Read,
) -> Option<Seen> {
    let masters = sw.shared.masters;
    let project_id = &runner.project_id;
    let Read {
        standing,
        conversation: stored_conversation,
        restarting,
    } = read;
    let pane_name = terminal::session_name(terminal::MASTER_PREFIX, &runner.slug);
    let pane_alive = terminal::available() && terminal::alive(&pane_name).await;
    // Registering a pane beats its session at core, which says a master is
    // serving. A pane up against a stand-down, an unread standing, a restart
    // or a runner taking no work is not, so it is reported up and unregistered.
    let quiet = restarting.is_some()
        || !accepts_new_work(&runner.status)
        || !matches!(&standing, StandingRead::Known(s) if !s.as_ref().is_some_and(MasterStanding::stands));
    let (adopted, servers) = if pane_alive && !quiet {
        let servers = project_mcp_servers(sw.client, project_id).await;
        let adopted = adopt_pane(sw, runner, &pane_name, &servers).await?;
        (Some(adopted), Some(servers))
    } else {
        (None, None)
    };
    let hosts = subagent_host::ProcHosts::system();
    let elsewhere = elsewhere_of(masters, project_id, stored_conversation.as_deref(), &hosts);
    let last_said = account_record(
        &resolved.repo_path,
        stored_conversation.as_deref(),
        sw.now_unix,
    );
    Some(Seen {
        standing,
        pane_name,
        pane_alive,
        stored_conversation,
        elsewhere,
        adopted,
        servers,
        restarting,
        last_said,
    })
}

/// Register the project's master with core, saying why where core refuses.
pub(crate) async fn register_master(
    sw: &Sweep<'_>,
    project_id: &str,
    slug: &str,
    name: &str,
    running: bool,
) -> Option<master_api::MasterSession> {
    let slots = sw.cfg.runner.max_job_panes.max(1);
    match master_api::register(sw.client, project_id, name, slots).await {
        Ok(s) => Some(s),
        Err(e) => {
            tracing::warn!("[master] {slug}: cannot register with core: {e}");
            say_unplaced(
                masters_of(sw),
                project_id,
                slug,
                Unplaced::RegisterFailed {
                    detail: e.to_string(),
                    pane: running.then(|| name.to_string()),
                },
            );
            None
        }
    }
}

fn masters_of<'a>(sw: &Sweep<'a>) -> &'a Arc<Masters> {
    sw.shared.masters
}

/// Serve a pane found up: register it with core, serve it under the session
/// core answers, and read whether this box can hear it.
async fn adopt_pane(
    sw: &Sweep<'_>,
    runner: &runners::MeRunner,
    name: &str,
    servers: &ServersRead,
) -> Option<Adopted> {
    let masters = sw.shared.masters;
    let (project_id, slug) = (&runner.project_id, &runner.slug);
    let session = register_master(sw, project_id, slug, name, true).await?;
    if let Err(e) = servers {
        tracing::warn!(
            "[master] {slug}: could not read this project's declared MCP servers from core ({e}), so whether {name} carries them is not known this sweep"
        );
    }
    report_stale_pane_config(masters, project_id, name, slug, servers.as_ref().ok());
    if masters.get(project_id).is_none() {
        tracing::info!("[master] {slug}: adopting the resident session {name}");
        remember(masters, project_id, &session);
    }
    let capability = verdict_over_unwithdrawn(
        capability_of(sw.tokens, &session.session_id, project_id, name),
        masters.unwithdrawn_for(project_id).as_deref(),
        &session.session_id,
    );
    Some(Adopted {
        session,
        capability,
        incarnation: terminal::incarnation(name).await,
    })
}
