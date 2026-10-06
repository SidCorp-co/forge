use super::*;

pub(crate) fn run_choice(
    ctl: &Arc<Control>,
    run_id: &str,
    choice: &str,
    why: &str,
    session_id: &str,
) -> ClaimReply {
    if !RESUME_CHOICES.contains(&choice) {
        return ClaimReply::refused(format!(
            "`{choice}` is not one of the three choices a resumed master may record: {}",
            RESUME_CHOICES.join(", ")
        ));
    }
    if why.trim().is_empty() {
        return ClaimReply::refused(
            "a choice needs its reason — say why in your own words, because the record is what the next reader has",
        );
    }
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    // A choice is recorded once, and core is told the one recorded: a second
    // choice answered `ok` and replaced the first with nothing said (ISS-1312).
    if let Ok(Some(run)) = led.run(run_id) {
        if let (true, Some(chosen)) = (
            run.master_session_id == session_id,
            run.resume_choice.as_deref(),
        ) {
            return ClaimReply::refused(format!(
                "run {run_id} already has `{chosen}` recorded for it: \u{ab}{}\u{bb}. A choice is recorded once, so `{choice}` changed nothing",
                run.resume_choice_why.as_deref().unwrap_or("no reason recorded")
            ));
        }
    }
    match led.record_resume_choice(run_id, session_id, choice, why) {
        Ok(true) => {
            tracing::info!("[control] run {run_id}: this master chose to {choice} — {why}");
            ClaimReply {
                ok: true,
                job_id: Some(run_id.to_string()),
                agent_session_id: Some(session_id.to_string()),
                issue_key: None,
                reason: Some(choice.to_string()),
            }
        }
        Ok(false) => ClaimReply::refused(format!(
            "run {run_id} is not one this pane inherited, so it is not this pane's to answer for"
        )),
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// The refusal for a pane resumed holding runs it has not answered for, if it holds any.
fn unanswered_inherited(
    led: &runner_core::ledger::Ledger,
    session_id: &str,
    boot_id: &str,
) -> Option<ClaimReply> {
    match led.runs_awaiting_choice(session_id, boot_id) {
        Ok(pending) if !pending.is_empty() => {
            let names: Vec<String> = pending
                .iter()
                .map(|r| {
                    let keys = led
                        .issues(&r.run_id)
                        .map(|m| {
                            m.iter()
                                .map(|i| i.issue_key.clone())
                                .collect::<Vec<_>>()
                                .join(", ")
                        })
                        .unwrap_or_default();
                    format!("{} ({keys})", r.run_id)
                })
                .collect();
            Some(ClaimReply::refused(format!(
                "this pane was resumed holding {} run(s) it has not answered for yet: {}. Answer each one with `forge-runner run choice <run-id> continue|restart|leave --reason \"<why>\"` before declaring new work. Closing a run is not answering for it: the close records that the row ended, not what you decided, and a reason written there reaches no issue.",
                pending.len(),
                names.join("; ")
            )))
        }
        Ok(_) => None,
        Err(e) => Some(ClaimReply::refused(format!(
            "cannot read this pane's inherited runs: {e}"
        ))),
    }
}

pub(crate) fn run_declare_as(
    ctl: &Arc<Control>,
    holder: &Holder,
    project_id: &str,
    issue_keys: &[String],
    worktree_path: &str,
    session_id: &str,
    peer: Option<u32>,
) -> ClaimReply {
    // First, before anything is read or written: a drain that admits a run is
    // waiting on a queue it keeps refilling (ISS-1223). The permit is held to
    // the end of this function, past the ledger write, so a drain that begins
    // meanwhile waits for this row rather than reading the box idle without it.
    let _admitted = match ctl.drain.admit() {
        Ok(permit) => permit,
        Err(closed) => return ClaimReply::refused(closed.refusal),
    };
    let serves = match declaring_project(&ctl.masters, holder, project_id, session_id) {
        Ok(serves) => serves,
        Err(why) => return ClaimReply::refused(why),
    };
    // A record was matched by id or slug in `declaring_project`; a capability
    // minted before the record names an id or nothing.
    if !matches!(holder, Holder::Minted(_)) && serves != project_id {
        return ClaimReply::refused(format!(
            "this pane is the master for {serves} and cannot declare a run for {project_id}"
        ));
    }
    // Every row below is keyed by the project's id, never by the slug it was named by.
    let project_id = serves.as_str();
    // A graceful stop, as a CI agent drains for an upgrade: finish what is
    // held, take nothing new. Core decided it; the box only refuses by it.
    if let Some(live) = ctl.masters.get(project_id).map(|(session, _)| session) {
        if let Some(because) = ctl.masters.draining(project_id, &live) {
            return ClaimReply::refused(format!(
                "this master is draining and declares no new run: {because}. Leave the issue unclaimed for its successor, which core places on the first sweep that finds no run this pane holds still working and it at its prompt, resuming this conversation. Nothing was recorded"
            ));
        }
    }
    if let Some(bad) = issue_keys.iter().find(|k| !is_issue_key(k)) {
        return ClaimReply::refused(format!(
            "`{bad}` is not an issue reference — a declaration takes one per issue the subagent is being given, each a display id such as `ISS-42` or your project's own prefix, or the bare number. Nothing was recorded"
        ));
    }
    // Refused here rather than trimmed to fit: the keys are what the caller
    // declared and dropping the seventeenth would be this box deciding which
    // issue the run is not about. Refused here rather than downstream because
    // core's refusal arrives at a sweep and not at this pane — one declaration
    // of 27 keys was answered `400` every twenty seconds for an hour and
    // forty-seven minutes, and the master that built it never saw one of them
    // (ISS-1284).
    let cap = runner_transport::run_sessions::MAX_ISSUE_KEYS;
    if issue_keys.len() > cap {
        return ClaimReply::refused(format!(
            "a run carries at most {cap} issues and this declaration names {}. Core refuses more by name and the refusal reaches this box's sweep rather than this pane, so the run would be opened nowhere and retried for ever. Declare the work in groups of {cap} or fewer. Nothing was recorded",
            issue_keys.len()
        ));
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    if let Some(refused) = unanswered_inherited(led, session_id, &ctl.boot_id) {
        return refused;
    }
    let new_run = |session: &str| runner_core::ledger::NewRun {
        run_id: run_id.clone(),
        project_id: project_id.to_string(),
        master_session_id: session.to_string(),
        worktree_path: std::path::PathBuf::from(worktree_path),
        boot_id: ctl.boot_id.clone(),
        issue_keys: issue_keys.to_vec(),
    };
    // A record's run is written while the registry is held, under the session
    // it names for the pane at that moment: an adoption between the bound
    // above and this write would otherwise leave the row under the session it
    // replaced, or let a pane that had just stopped being the master declare.
    let (recorded, written) = match holder {
        Holder::Minted(m) => {
            let under = ctl.masters.while_live(&m.project, &m.pane, |live| {
                (live.to_string(), led.create_run_group(new_run(live)))
            });
            match under {
                Some(w) => w,
                None => {
                    return ClaimReply::refused(format!(
                        "pane {} stopped being this box's master for {} while the declaration was being written. Nothing was recorded",
                        m.pane, m.project
                    ))
                }
            }
        }
        Holder::Legacy { .. } => (
            session_id.to_string(),
            led.create_run_group(new_run(session_id)),
        ),
    };
    match written {
        Ok(run) => {
            tracing::info!(
                "[control] {project_id}: run {} declared over {:?}",
                run.run_id,
                issue_keys
            );
            note_host(ctl, led, &run.run_id, peer);
            ClaimReply {
                ok: true,
                job_id: Some(run.run_id),
                agent_session_id: Some(recorded),
                issue_key: issue_keys.first().cloned(),
                reason: None,
            }
        }
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

pub(crate) fn is_issue_key(s: &str) -> bool {
    let body = match s.split_once('-') {
        Some((prefix, rest)) => {
            let len = prefix.chars().count();
            if !(2..=6).contains(&len) || !prefix.chars().all(|c| c.is_ascii_alphanumeric()) {
                return false;
            }
            if !prefix
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
            {
                return false;
            }
            rest
        }
        None => s,
    };
    !body.is_empty() && body.len() <= 10 && body.chars().all(|c| c.is_ascii_digit())
}

pub(crate) fn run_close(
    ctl: &Arc<Control>,
    run_id: &str,
    reason: Option<&str>,
    session_id: &str,
) -> ClaimReply {
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else {
        return ClaimReply::refused("this daemon has no ledger open, so it can record nothing");
    };
    match led.run(run_id) {
        Ok(Some(run)) if run.master_session_id == session_id => {
            // An ending is recorded once. A second close answered `ok` and
            // wrote its own reason over the first, so the row said whatever
            // the last caller typed (ISS-1312).
            if let Some(by) = run.ended_by.as_deref() {
                return ClaimReply::refused(format!(
                    "run {run_id} is already ended by {by}: \u{ab}{}\u{bb}. An ending is recorded once, so this close changed nothing",
                    run.ended_reason.as_deref().unwrap_or("no reason recorded")
                ));
            }
            if let Err(e) = led.end_run(run_id, "master", reason.unwrap_or("the master said so")) {
                return ClaimReply::refused(e.to_string());
            }
            tracing::info!("[control] run {run_id} closed by its master");
            ClaimReply {
                ok: true,
                job_id: Some(run_id.to_string()),
                agent_session_id: Some(session_id.to_string()),
                issue_key: None,
                reason: None,
            }
        }
        Ok(Some(_)) => ClaimReply::refused(format!("run {run_id} belongs to another master")),
        Ok(None) => ClaimReply::refused(format!("no run {run_id} on this box")),
        Err(e) => ClaimReply::refused(e.to_string()),
    }
}

/// A subagent started: it takes the run its master declared for it.
///
/// A start is also the subagent heard from, in a process that is running now,
/// so an end recorded for the pane it ran in before no longer speaks for it,
/// and where the lead's hook names its transcript the run keeps that path from
/// its first turn rather than from its first stop (ISS-1312).
pub(crate) fn bind_declared(
    ctl: &Arc<Control>,
    agent_id: Option<&str>,
    agent_type: Option<&str>,
    session_id: &str,
    at_ms: i64,
    lead: Option<&str>,
) {
    let Some(child) = agent_id else { return };
    let transcript = lead
        .map(Path::new)
        .filter(|p| p.is_absolute())
        .and_then(|p| runner_core::transcript_age::child_transcript(p, child))
        .map(|p| p.to_string_lossy().into_owned());
    let mut held = ctl.ledger.lock().expect("ledger poisoned");
    let Some(led) = held.as_mut() else { return };
    let heard = |led: &runner_core::ledger::Ledger, run_id: &str| {
        if let Err(e) = led.note_subagent_started(run_id, at_ms, transcript.as_deref()) {
            tracing::warn!("[control] run {run_id}: cannot note that {child} started: {e}");
        }
    };
    match led.unbound_run_for_master(session_id, &ctl.boot_id) {
        Ok(Some(run)) => match led.bind_agent(&run.run_id, child) {
            Ok(true) => {
                heard(led, &run.run_id);
                ctl.promises
                    .lock()
                    .expect("promises poisoned")
                    .promised
                    .remove(&run.run_id);
                tracing::info!("[control] run {} is subagent {child}", run.run_id)
            }
            Ok(false) => tracing::debug!(
                "[control] run {} was already bound when {child} started",
                run.run_id
            ),
            Err(e) => tracing::warn!("[control] cannot bind {child}: {e}"),
        },
        Ok(None) => match classify_start(
            led.run_for_agent(child)
                .map(|r| r.map(|run| run.run_id))
                .map_err(|e| e.to_string()),
        ) {
            StartKind::Replay(run_id) => {
                heard(led, &run_id);
                tracing::debug!(
                    "[control] subagent {child} is already run {run_id}, so its start is a replay"
                )
            }
            StartKind::Undeclared => undeclared_child(ctl, child, agent_type),
            StartKind::Unreadable(e) => unreadable_ledger(ctl, child, &e),
        },
        Err(e) => tracing::warn!("[control] cannot read declared runs: {e}"),
    }
}
