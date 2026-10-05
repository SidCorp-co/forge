use super::*;

pub(crate) fn agent_event(
    ctl: &Arc<Control>,
    event: &str,
    at_ms: Option<i64>,
    names: &HookNames,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    let agent_id = names.agent_id.as_deref();
    let conversation_id = names.conversation_id.as_deref();
    let agent_type = names.agent_type.as_deref();
    let Some(parsed) = runner_core::agent_activity::Event::from_wire(event) else {
        return ClaimReply::refused(format!("unknown_event: {event}"));
    };
    let at = at_ms.unwrap_or_else(runner_core::agent_activity::now_ms);
    let after = ctl.activity.record(
        session_id,
        runner_core::agent_activity::Report {
            event: parsed,
            at,
            subject: agent_id,
            conversation: conversation_id,
            transcript: names.transcript_path.as_deref(),
        },
    );
    match (parsed, agent_id) {
        (runner_core::agent_activity::Event::SubagentStarted, _) => {
            bind_declared(
                ctl,
                agent_id,
                agent_type,
                session_id,
                at,
                names.transcript_path.as_deref(),
            );
            note_host_of(ctl, agent_id, peer);
        }
        (runner_core::agent_activity::Event::SubagentStopped, Some(child)) => {
            note_subagent_stop(ctl, child, at, names.transcript_path.as_deref());
            note_host_of(ctl, Some(child), peer);
        }
        _ => {}
    }
    note_master_pane(ctl, session_id, conversation_id);
    match after.doing() {
        runner_core::agent_activity::Doing::AwaitingPermission => tracing::warn!(
            "[control] session {session_id} is stopped on a question only a human can answer"
        ),
        doing => tracing::debug!("[control] session {session_id} reports {event} -> {doing:?}"),
    }
    ClaimReply {
        ok: true,
        job_id: None,
        agent_session_id: Some(session_id.to_string()),
        issue_key: None,
        reason: Some(format!("{:?}", after.doing())),
    }
}

pub(crate) fn dispatch_gate_reply(
    ctl: &Arc<Control>,
    d: runner_core::dispatch_gate::Dispatch,
    session_id: &str,
) -> ClaimReply {
    use runner_core::dispatch_gate::{decide, Facts, Verdict, REFUSAL};

    let dir = ctl.config_dir.clone();
    let roles = dir.as_deref().and_then(dispatch_gate_roles);

    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let pending = match held.as_mut() {
        Some(led) => match led.unbound_run_for_master(session_id, &ctl.boot_id) {
            Ok(run) => run.map(|r| r.run_id),
            Err(e) => {
                let why = "this box's own registry of declared runs could not be read";
                tracing::error!("[control] the dispatch gate could not decide: {why}: {e}");
                return allowed_unregistered(ctl, dir.as_deref(), why, &d);
            }
        },
        None => {
            return allowed_unregistered(
                ctl,
                dir.as_deref(),
                "this box holds no registry of declared runs",
                &d,
            );
        }
    };
    let mut memory = ctl.promises.lock().expect("promises poisoned");

    // A tool call this daemon has already answered gets that answer again, whether
    // or not its declaration has since been bound.
    if let Some(tool_use) = d.tool_use_id.as_deref() {
        if memory.allowed.contains(tool_use) {
            return gate_allows(None);
        }
    }

    let promised = pending
        .as_deref()
        .and_then(|run| memory.promised.get(run).cloned());
    let verdict = decide(
        &d,
        &Facts {
            roles: roles.as_ref(),
            pending_run: pending.as_deref(),
            promised_to: promised.as_deref(),
        },
    );
    match verdict {
        Verdict::NotOurs => gate_allows(None),
        Verdict::Replay { .. } => gate_allows(None),
        Verdict::Covered { run_id } => {
            if let Some(tool_use) = d.tool_use_id.clone() {
                memory.promised.insert(run_id.clone(), tool_use.clone());
                memory.allowed.insert(tool_use);
            }
            tracing::info!("[control] run {run_id} is promised to this dispatch");
            let mut reply = gate_allows(None);
            reply.job_id = Some(run_id);
            reply
        }
        Verdict::Undeclared => {
            tracing::warn!(
                "[control] refusing an undeclared hand-off from master session {session_id}"
            );
            ClaimReply::refused(REFUSAL)
        }
        Verdict::Unknown(why) => {
            if let Some(refused) = refused_while_draining(ctl, why, Some(pending.as_deref())) {
                return refused;
            }
            // Failing open for a run declared before the drain admits nothing
            // new only while that run is spent once, so while draining the
            // promise is recorded the way `Covered` records it, and a second
            // tool call against the same run is refused.
            if let (Some(run), Some(cause)) = (pending.as_deref(), ctl.drain.draining_for()) {
                // cm:guard a dispatch carrying no tool call id cannot be limited here: nothing
                // names it to promise the run to or to tell a second hand-off from a replay, so
                // that case still fails open once per call, and the drain counts only the one row.
                if let Some(tool_use) = d.tool_use_id.clone() {
                    if let Some(spent) = memory.promised.get(run).filter(|t| **t != tool_use) {
                        tracing::warn!(
                            "[control] refusing a second hand-off of run {run} while draining: it was spent on {spent}"
                        );
                        return ClaimReply::refused(format!(
                            "this box is handing over to a new build ({cause}) and run {run}, declared before the handover's closing window, was already handed off to tool call {spent}; a second subagent against it would be work nothing accounted for. Declare it again in a moment, and the new build will take it"
                        ));
                    }
                    memory.promised.insert(run.to_string(), tool_use.clone());
                    memory.allowed.insert(tool_use);
                }
            }
            if let Some(dir) = dir.as_deref() {
                // The registry answered here, so the run this dispatch belonged
                // to is known even though the verdict is not.
                let run = match pending.as_deref() {
                    Some(run) => runner_core::degraded::Run::Declared(run),
                    None => runner_core::degraded::Run::Unknown(
                        "this master had declared no run for the gate to bind",
                    ),
                };
                runner_core::degraded::mark(
                    dir,
                    &runner_core::degraded::Mark::new(
                        runner_core::degraded::Kind::Degraded,
                        runner_core::degraded::Source::Daemon,
                        why,
                        run,
                    )
                    .about(&d),
                );
            }
            tracing::error!("[control] the dispatch gate could not decide: {why}");
            gate_allows(Some(why))
        }
    }
}

/// The gate's answer when this box's registry of declared runs cannot say
/// whether `d` was declared: refused while draining, otherwise allowed and the
/// box marked degraded with `why`.
fn allowed_unregistered(
    ctl: &Arc<Control>,
    dir: Option<&Path>,
    why: &str,
    d: &runner_core::dispatch_gate::Dispatch,
) -> ClaimReply {
    if let Some(refused) = refused_while_draining(ctl, why, None) {
        return refused;
    }
    if let Some(dir) = dir {
        runner_core::degraded::mark(
            dir,
            &runner_core::degraded::Mark::new(
                runner_core::degraded::Kind::Degraded,
                runner_core::degraded::Source::Daemon,
                why,
                runner_core::degraded::Run::Unknown(why),
            )
            .about(d),
        );
    }
    gate_allows(Some(why))
}

/// Where the gate cannot decide it fails open, and a draining box does not
/// where the hand-off may be new work: an undeclared subagent let through there
/// is work the drain never counted (ISS-1223).
///
/// `declared` is what the registry answered for this master. A run declared
/// before the drain is already a holder, so failing open for it admits nothing
/// new, and refusing it would leave a row the drain waits on that no subagent
/// can ever bind — the drain could then only give up. So only `Some(None)`
/// (read, and nothing declared) and `None` (the registry could not be read, so
/// nobody can say) refuse. The sentence claims nothing about what is recorded,
/// since where the registry could not be read nobody knows. No degraded mark is
/// written for a refusal: nothing went through.
pub(crate) fn refused_while_draining(
    ctl: &Arc<Control>,
    why: &str,
    declared: Option<Option<&str>>,
) -> Option<ClaimReply> {
    if matches!(declared, Some(Some(_))) {
        return None;
    }
    let cause = ctl.drain.draining_for()?;
    tracing::warn!(
        "[control] refusing a hand-off the gate could not decide ({why}): the box is handing over for {cause}"
    );
    let known = match declared {
        Some(_) => "and this master has declared no run for it",
        None => "and whether a run was declared for it cannot be read",
    };
    Some(ClaimReply::refused(format!(
        "this box is handing over to a new build ({cause}) and admits no hand-off it cannot account for in the seconds that takes: the dispatch gate could not check this one against a declaration ({why}), {known}. Hand it off again in a moment, and the new build will take it"
    )))
}

/// The gate's "go ahead", with an optional reason it could not do better.
pub(crate) fn gate_allows(why: Option<&str>) -> ClaimReply {
    ClaimReply {
        ok: true,
        job_id: None,
        agent_session_id: None,
        issue_key: None,
        reason: why.map(str::to_string),
    }
}

pub(crate) fn dispatch_gate_roles(dir: &Path) -> Option<std::collections::BTreeSet<String>> {
    runner_core::dispatch_gate::shipped_roles(dir)
}

/// Record on `run_id`'s row the Claude Code process above `peer`, the process
/// that just reported for it. A subagent runs in the process of the
/// conversation that dispatched it, which is the one above its own hooks and
/// above its master's `run declare`, and which may be running outside the
/// master's pane (ISS-1312, run e67c08e0). A peer with no such process above it
/// records nothing, and a row with nothing recorded is never ended by a pane.
pub(crate) fn note_host(
    ctl: &Arc<Control>,
    led: &runner_core::ledger::Ledger,
    run_id: &str,
    peer: Option<u32>,
) {
    let Some(host) = peer.and_then(|p| ctl.hosts.above(p)) else {
        tracing::debug!(
            "[control] run {run_id}: no Claude Code process was read above the process that reported for it, so none is recorded"
        );
        return;
    };
    if let Err(e) = led.note_host(run_id, host.pid, &host.start) {
        tracing::warn!(
            "[control] run {run_id}: cannot record the process {} its subagent runs in: {e}",
            host.pid
        );
    }
}

/// [`note_host`] for the run `child` is bound to.
pub(crate) fn note_host_of(ctl: &Arc<Control>, child: Option<&str>, peer: Option<u32>) {
    let (Some(child), Some(_)) = (child, peer) else {
        return;
    };
    let held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_ref() else { return };
    match led.run_for_agent(child) {
        Ok(Some(run)) => note_host(ctl, led, &run.run_id, peer),
        Ok(None) => {}
        Err(e) => tracing::warn!("[control] cannot read the run for {child}: {e}"),
    }
}

/// A subagent ended a turn, which is not the end of its run: it may be waiting
/// on work of its own, and one that finished can still be resumed. The stop
/// and where its transcript is are recorded; the run stays open until its
/// master closes it or its master's pane is gone (ISS-1246).
pub(crate) fn note_subagent_stop(ctl: &Arc<Control>, child: &str, at_ms: i64, lead: Option<&str>) {
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| runner_core::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    match led.run_for_agent(child) {
        Ok(Some(run)) => match led.note_turn_end(&run.run_id, at_ms, transcript.as_deref()) {
            Ok(_) => tracing::info!(
                "[control] run {}: subagent {child} ended a turn, and the run stays open until its master closes it",
                run.run_id
            ),
            Err(e) => tracing::warn!("[control] cannot note {child}'s turn end: {e}"),
        },
        Ok(None) => tracing::debug!("[control] subagent {child} answered to no declared run"),
        Err(e) => tracing::warn!("[control] cannot read the run for {child}: {e}"),
    }
}

/// What a `SubagentStart` with no pending declaration turned out to be.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum StartKind {
    /// This child already holds an open run, so its start is a repeat of one already handled.
    Replay(String),
    /// This box holds no row for this child's work.
    Undeclared,
    /// This box could not read its own ledger, so it knows neither of the above.
    Unreadable(String),
}

pub(crate) fn classify_start(read: Result<Option<String>, String>) -> StartKind {
    match read {
        Ok(Some(run_id)) => StartKind::Replay(run_id),
        Ok(None) => StartKind::Undeclared,
        Err(e) => StartKind::Unreadable(e),
    }
}

pub(crate) fn unreadable_ledger(ctl: &Arc<Control>, child: &str, e: &str) {
    let detail = format!("could not read the declared runs when subagent {child} started: {e}");
    tracing::warn!("[control] {detail} — this box knows neither that the work was declared nor that it was not");
    if let Some(dir) = ctl.config_dir.as_deref() {
        runner_core::degraded::mark(
            dir,
            &runner_core::degraded::Mark::new(
                runner_core::degraded::Kind::Degraded,
                runner_core::degraded::Source::Daemon,
                &detail,
                runner_core::degraded::Run::Unknown(
                    "the declared runs could not be read, so this box knows of none",
                ),
            )
            .by_child(child, None),
        );
    }
}

pub(crate) fn undeclared_child(ctl: &Arc<Control>, child: &str, agent_type: Option<&str>) {
    let Some(role) = agent_type else {
        tracing::debug!("[control] subagent {child} answers to no declared run");
        return;
    };
    let dir = ctl.config_dir.clone();
    let ships_it = dir
        .as_deref()
        .and_then(runner_core::dispatch_gate::shipped_roles)
        .is_some_and(|roles| roles.contains(role));
    if !ships_it {
        tracing::debug!("[control] subagent {child} ({role}) answers to no declared run");
        return;
    }
    let detail = format!("subagent {child} started as `{role}` with nothing declared for it");
    tracing::error!(
        "[control] UNDECLARED HAND-OFF: {detail} — this box holds no row for that work, so nothing \
         will reap it, the load count is short, and those issues will never be offered again. The \
         master was required to run `forge-runner run declare` first."
    );
    if let Some(dir) = dir.as_deref() {
        runner_core::degraded::mark(
            dir,
            &runner_core::degraded::Mark::new(
                runner_core::degraded::Kind::Undeclared,
                runner_core::degraded::Source::Daemon,
                &detail,
                runner_core::degraded::Run::Unknown("nothing was declared for it"),
            )
            .by_child(child, Some(role)),
        );
    }
}

pub(crate) fn note_master_pane(
    ctl: &Arc<Control>,
    session_id: &str,
    conversation_id: Option<&str>,
) {
    let Some(project_id) = ctl.masters.project_for_session(session_id) else {
        return;
    };
    let Some(pane) = ctl.masters.pane_for_session(session_id) else {
        return;
    };
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    if let Err(e) = led.note_master(
        &project_id,
        &pane,
        conversation_id,
        Some(session_id),
        &ctl.boot_id,
    ) {
        tracing::warn!("[control] cannot record {project_id}'s master pane: {e}");
    }
}
