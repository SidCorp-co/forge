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
    if let Some(read) = roles.as_ref() {
        memory.last_roles = Some(read.clone());
    }

    // A tool call this daemon has already answered gets that answer again, whether
    // or not its declaration has since been bound.
    if let Some(tool_use) = d.tool_use_id.as_deref() {
        if memory.allowed.contains(tool_use) {
            return gate_allows(None);
        }
    }

    let promised = pending
        .as_deref()
        .and_then(|run| memory.promised.get(run).map(|p| p.tool_use.clone()));
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
                memory
                    .promised
                    .insert(run_id.clone(), Promise::to(&d, tool_use.clone()));
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
            if let Some(refused) = promise_while_draining(ctl, &mut memory, &d, pending.as_deref())
            {
                return refused;
            }
            if roles.is_none() {
                promise_unread(&mut memory, &d, pending.as_deref());
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

/// Failing open for a run declared before the drain admits nothing new only
/// while that run is spent once, so while draining the promise is recorded the
/// way `Covered` records it, and a second tool call against the same run is
/// refused.
fn promise_while_draining(
    ctl: &Arc<Control>,
    memory: &mut GateMemory,
    d: &runner_core::dispatch_gate::Dispatch,
    pending: Option<&str>,
) -> Option<ClaimReply> {
    let (Some(run), Some(cause)) = (pending, ctl.drain.draining_for()) else {
        return None;
    };
    // a dispatch carrying no tool call id cannot be limited here: nothing
    // names it to promise the run to or to tell a second hand-off from a replay, so
    // that case still fails open once per call, and the drain counts only the one row.
    let tool_use = d.tool_use_id.clone()?;
    if let Some(spent) = memory
        .promised
        .get(run)
        .map(|p| p.tool_use.as_str())
        .filter(|t| *t != tool_use)
    {
        tracing::warn!(
            "[control] refusing a second hand-off of run {run} while draining: it was spent on {spent}"
        );
        return Some(ClaimReply::refused(format!(
            "this box is handing over to a new build ({cause}) and run {run}, declared before the handover's closing window, was already handed off to tool call {spent}; a second subagent against it would be work nothing accounted for. Declare it again in a moment, and the new build will take it"
        )));
    }
    memory
        .promised
        .insert(run.to_string(), Promise::to(d, tool_use.clone()));
    memory.allowed.insert(tool_use);
    None
}

/// With the inventory unread, the run is promised to this dispatch as
/// `Covered` promises it, naming its role, so the subagent that starts as that
/// role binds it rather than being ended at 60m as never bound (ISS-1390). Only
/// a dispatch that could be the run's takes it: a role the last inventory read
/// whole names, or, with none ever read, a plugin's namespaced role, which no
/// built-in helper is; otherwise the first helper sent would take the run.
fn promise_unread(
    memory: &mut GateMemory,
    d: &runner_core::dispatch_gate::Dispatch,
    pending: Option<&str>,
) {
    let eligible =
        d.subagent_type
            .as_deref()
            .is_some_and(|role| match memory.last_roles.as_ref() {
                Some(known) => runner_core::dispatch_gate::shipped(known, role).is_some(),
                None => role
                    .split_once(':')
                    .is_some_and(|(plugin, name)| !plugin.is_empty() && !name.is_empty()),
            });
    let (Some(run), Some(tool_use), true) = (pending, d.tool_use_id.clone(), eligible) else {
        return;
    };
    if memory.promised.contains_key(run) {
        return;
    }
    memory
        .promised
        .insert(run.to_string(), Promise::to(d, tool_use.clone()));
    memory.allowed.insert(tool_use);
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

/// A subagent of a shipped role that no declared run takes. `declared` is the
/// run its master did declare and why this subagent is not that run's, where
/// there was one: the master then took the step, and the journal says what
/// did not match rather than that nothing was declared.
pub(crate) fn undeclared_child(
    ctl: &Arc<Control>,
    child: &str,
    agent_type: Option<&str>,
    declared: Option<&(String, String)>,
) {
    let Some(role) = agent_type else {
        tracing::debug!("[control] subagent {child} answers to no declared run");
        return;
    };
    let dir = ctl.config_dir.clone();
    let ships_it = dir
        .as_deref()
        .and_then(runner_core::dispatch_gate::shipped_roles)
        .is_some_and(|roles| runner_core::dispatch_gate::shipped(&roles, role).is_some());
    if !ships_it {
        tracing::debug!("[control] subagent {child} ({role}) answers to no declared run");
        return;
    }
    let (detail, owed) = match declared {
        None => (
            format!("subagent {child} started as `{role}` with nothing declared for it"),
            "The master was required to run `forge-runner run declare` first.".to_string(),
        ),
        Some((run_id, why)) => (
            format!(
                "subagent {child} started as `{role}`, and the run its master declared, {run_id}, is not its: {why}"
            ),
            format!(
                "The master did declare run {run_id}; it was for another dispatch, and it stays unbound for that one."
            ),
        ),
    };
    tracing::error!(
        "[control] UNDECLARED HAND-OFF: {detail} — this box holds no row for that work, so nothing \
         will reap it, the load count is short, and those issues will never be offered again. {owed}"
    );
    if let Some(dir) = dir.as_deref() {
        runner_core::degraded::mark(
            dir,
            &runner_core::degraded::Mark::new(
                runner_core::degraded::Kind::Undeclared,
                runner_core::degraded::Source::Daemon,
                &detail,
                runner_core::degraded::Run::Unknown(match declared {
                    None => "nothing was declared for it",
                    Some(_) => "the one run its master declared was for another dispatch",
                }),
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

/// A master's subagents as Claude Code names them, bound against a plugin copy
/// as this daemon syncs one (ISS-1378, ported to the split crates).
#[cfg(test)]
mod role_tests {
    use super::*;
    use runner_core::ledger::{Ledger, NewRun};

    const BOOT: &str = "boot-1";
    const MASTER: &str = "sess-a";

    /// A box whose one plugin copy, named `forge` by its manifest, ships `roles`.
    fn a_box(roles: &[&str]) -> (Arc<Control>, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("forge-roles-{}", uuid::Uuid::new_v4()));
        let plugin = dir.join("marketplaces/SidCorp-co__forge-plugin/plugin");
        std::fs::create_dir_all(plugin.join("agents")).unwrap();
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name": "forge", "version": "1"}"#,
        )
        .unwrap();
        for role in roles {
            std::fs::write(plugin.join("agents").join(format!("{role}.md")), "---\n").unwrap();
        }
        let ledger = Ledger::open(&dir.join("ledger.db")).unwrap();
        let ctl = Arc::new(Control {
            tokens: crate::session_tokens::SessionTokens::at(dir.join("tokens.json")),
            activity: Arc::new(runner_core::agent_activity::Activities::new()),
            masters: Arc::new(crate::master::Masters::default()),
            ledger: Arc::new(std::sync::Mutex::new(Some(ledger))),
            boot_id: BOOT.into(),
            config_dir: Some(dir.clone()),
            promises: std::sync::Mutex::new(GateMemory::default()),
            drain: Arc::new(crate::drain::Drain::new(None)),
            hosts: Arc::new(runner_platform::subagent_host::ProcHosts::system()),
            core: None,
        });
        (ctl, dir)
    }

    fn declare(ctl: &Arc<Control>, run_id: &str) {
        let mut held = ctl.ledger.lock().unwrap();
        held.as_mut()
            .unwrap()
            .create_run_group(NewRun {
                run_id: run_id.into(),
                project_id: "proj-1".into(),
                master_session_id: MASTER.into(),
                worktree_path: format!("/w/{run_id}").into(),
                boot_id: BOOT.into(),
                issue_keys: vec![format!("ISS-{}", run_id.trim_start_matches("run-"))],
            })
            .unwrap();
    }

    fn bound(ctl: &Arc<Control>, run_id: &str) -> Option<String> {
        let held = ctl.ledger.lock().unwrap();
        held.as_ref()
            .unwrap()
            .run(run_id)
            .unwrap()
            .unwrap()
            .agent_id
    }

    fn end(ctl: &Arc<Control>, run_id: &str) {
        let held = ctl.ledger.lock().unwrap();
        held.as_ref()
            .unwrap()
            .end_run(run_id, "master", "done")
            .unwrap();
    }

    fn started(ctl: &Arc<Control>, child: &str, role: &str) {
        bind_declared(ctl, Some(child), Some(role), MASTER, 0, None);
    }

    fn dispatch(role: &str, tool_use: &str) -> runner_core::dispatch_gate::Dispatch {
        runner_core::dispatch_gate::Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: Some(tool_use.into()),
        }
    }

    /// Claude Code sends `forge:runner`, and a dispatch to it with nothing
    /// declared is refused; the bare stem is the same role by the same rule.
    #[test]
    fn a_dispatch_to_a_shipped_role_by_its_namespaced_name_is_gated() {
        let (ctl, dir) = a_box(&["runner", "reviewer"]);
        for role in ["forge:runner", "runner"] {
            let reply = dispatch_gate_reply(&ctl, dispatch(role, "toolu_1"), MASTER);
            assert!(
                !reply.ok,
                "`{role}` with nothing declared went through the gate: {reply:?}"
            );
        }
        let helper = dispatch_gate_reply(&ctl, dispatch("Explore", "toolu_2"), MASTER);
        assert!(helper.ok, "a helper is not the gate's subject");
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A helper the master starts before the run's subagent leaves the run
    /// for the subagent dispatched for it.
    #[test]
    fn a_helper_started_first_does_not_take_the_run() {
        let (ctl, dir) = a_box(&["runner"]);
        declare(&ctl, "run-1");
        started(&ctl, "helper-1", "Explore");
        assert_eq!(bound(&ctl, "run-1"), None, "a helper took the run");
        started(&ctl, "agent-1", "forge:runner");
        assert_eq!(bound(&ctl, "run-1").as_deref(), Some("agent-1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A subagent its master resumes for a new declaration, after the run it
    /// answered to was closed, binds that declaration.
    #[test]
    fn a_resumed_subagent_binds_the_run_its_master_declared_for_it() {
        let (ctl, dir) = a_box(&["runner"]);
        declare(&ctl, "run-1");
        started(&ctl, "agent-1", "forge:runner");
        assert_eq!(bound(&ctl, "run-1").as_deref(), Some("agent-1"));
        end(&ctl, "run-1");
        declare(&ctl, "run-2");
        started(&ctl, "agent-1", "forge:runner");
        assert_eq!(
            bound(&ctl, "run-2").as_deref(),
            Some("agent-1"),
            "the resumed subagent was refused the run its master declared for it"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    /// With the inventory unread the gate lets a dispatch through and
    /// promises the run only to one that could be the run's, so the worker
    /// binds it and a helper sent first does not (ISS-1390).
    #[test]
    fn with_no_inventory_the_promised_plugin_role_binds_and_a_helper_does_not() {
        let (ctl, dir) = a_box(&["runner"]);
        std::fs::remove_dir_all(dir.join("marketplaces")).unwrap();
        declare(&ctl, "run-1");
        assert!(dispatch_gate_reply(&ctl, dispatch("general-purpose", "toolu_h"), MASTER).ok);
        assert!(dispatch_gate_reply(&ctl, dispatch("forge:runner", "toolu_1"), MASTER).ok);
        started(&ctl, "helper-1", "general-purpose");
        assert_eq!(bound(&ctl, "run-1"), None, "a helper took the promise");
        started(&ctl, "agent-1", "forge:runner");
        assert_eq!(bound(&ctl, "run-1").as_deref(), Some("agent-1"));
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A subagent still answering to an open run does not take a second.
    #[test]
    fn a_resumed_subagent_still_on_an_open_run_does_not_take_a_second() {
        let (ctl, dir) = a_box(&["runner"]);
        declare(&ctl, "run-1");
        started(&ctl, "agent-1", "forge:runner");
        declare(&ctl, "run-2");
        started(&ctl, "agent-1", "forge:runner");
        assert_eq!(bound(&ctl, "run-2"), None);
        let _ = std::fs::remove_dir_all(dir);
    }
}
