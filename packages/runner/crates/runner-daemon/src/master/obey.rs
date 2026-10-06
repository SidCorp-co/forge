//! Doing what core decided about one project's master (ADR 0009, What core
//! takes over: Placement and Retirement). The box opens, ends, nudges or leaves
//! the pane it is told to, and records what it saw on the way; it decides none
//! of it.

use super::*;
use runner_transport::master_verdict::Verdict;

/// One project's turn in a sweep, as the acts below read it.
pub(crate) struct Turn<'a> {
    pub(crate) sw: &'a Sweep<'a>,
    pub(crate) runner: &'a runners::MeRunner,
    pub(crate) resolved: &'a crate::dispatch::Resolved,
    pub(crate) seen: &'a Seen,
    pub(crate) work: &'a Work,
}

impl Turn<'_> {
    fn masters(&self) -> &Arc<Masters> {
        self.sw.shared.masters
    }

    fn project_id(&self) -> &str {
        &self.runner.project_id
    }

    fn slug(&self) -> &str {
        &self.resolved.slug
    }
}

/// How a pane core placed is placed.
pub(crate) struct Placing {
    pub(crate) resume: Option<String>,
    pub(crate) nudge: bool,
    /// Whether this turn ended a deaf pane to make room for it.
    pub(crate) ended_deaf: bool,
}

pub(crate) async fn obey(
    t: &Turn<'_>,
    ledger: &mut Option<Ledger>,
    verdict: Verdict,
    found: &mut Found,
) {
    let authority = AuthoritySink::default();
    let deaf = DeafSink::default();
    match verdict {
        Verdict::Withhold { reason, because } => withhold(t, &reason, &because),
        Verdict::Leave { reason, because } => {
            leave(t, ledger, &reason, &because, &authority, &deaf, found).await
        }
        Verdict::Retire { because } => retire(t, &because).await,
        Verdict::Keep {
            nudge,
            drain,
            because,
        } => {
            note_draining(t, drain, &because);
            record_heard(t, ledger, &authority).await;
            tend(t, found).await;
            if nudge {
                tracing::debug!("[master] {}: nudge owed: {because}", t.slug());
                drive(t, ledger, true).await;
            }
        }
        Verdict::Place {
            resume,
            nudge,
            because,
        } => {
            tracing::info!("[master] {}: core places its master: {because}", t.slug());
            let placing = Placing {
                resume,
                nudge,
                ended_deaf: false,
            };
            place(t, ledger, placing, &authority, &deaf, found).await;
        }
        Verdict::Replace {
            reason,
            resume,
            nudge,
            because,
        } => {
            if let Some(ended_deaf) =
                end_for_replacement(t, &reason, &because, &authority, &deaf).await
            {
                let placing = Placing {
                    resume,
                    nudge,
                    ended_deaf,
                };
                place(t, ledger, placing, &authority, &deaf, found).await;
            }
        }
    }
    if let Some(said) = authority.take() {
        write_authority(ledger.as_ref(), t.project_id(), t.slug(), &said);
    }
    // Gathered rather than reported here: one project's deaf pane is a line,
    // and a whole fleet gone deaf at once is one condition (ISS-1208).
    if let Some(d) = deaf.take() {
        found.deaf.push(d);
    }
}

/// What core withheld, in the words this box's own records use where it has
/// them, and in core's where it does not.
pub(crate) fn withheld_as(
    reason: &str,
    because: &str,
    runner: &runners::MeRunner,
    seen: &Seen,
) -> Unplaced {
    let standing = match &seen.standing {
        StandingRead::Known(s) => Ok(s.as_ref()),
        StandingRead::Unreadable(detail) => Err(detail),
    };
    match (reason, standing, &seen.elsewhere) {
        ("standing_unreadable", Err(detail), _) => Unplaced::StandingUnreadable {
            detail: detail.clone(),
        },
        ("restarting", _, _) if seen.restarting.is_some() => Unplaced::Restarting {
            cause: seen.restarting.clone().unwrap_or_default(),
        },
        ("runner_not_accepting", _, _) => Unplaced::Draining {
            status: runner.status.clone(),
        },
        ("stood_down", Ok(row), _) => stood_down_reason(row, &runner.slug, None),
        ("no_terminal", _, _) => Unplaced::NoTerminal,
        ("nothing_owed", _, _) => Unplaced::NothingAdmissible,
        (
            "conversation_elsewhere",
            _,
            Some((conversation, short, subagent_host::Running::Found(pid))),
        ) => Unplaced::ConversationElsewhere {
            conversation: conversation.clone(),
            short: short.clone(),
            pid: *pid,
        },
        ("conversation_unaskable", _, Some((conversation, short, _))) => {
            Unplaced::ConversationUnaskable {
                conversation: conversation.clone(),
                short: short.clone(),
            }
        }
        _ => Unplaced::Withheld {
            reason: reason.to_string(),
            because: because.to_string(),
        },
    }
}

/// What core said of a kept pane's draining, held for `run declare` to refuse
/// by; said once per session and reason rather than once a sweep.
fn note_draining(t: &Turn<'_>, drain: bool, because: &str) {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let Some((session, name)) = masters.get(project_id) else {
        return;
    };
    let said = drain.then(|| because.to_string());
    if masters.note_draining(project_id, &session, said) && drain {
        tracing::warn!(
            "[master] {slug}: {name} is kept and driven, and drains: {because}. This box refuses its new run declarations until core replaces it; `forge-runner master kill {slug}` replaces it now, ending whatever it is doing"
        );
    }
}

fn withhold(t: &Turn<'_>, reason: &str, because: &str) {
    match withheld_as(reason, because, t.runner, t.seen) {
        // Said where the box takes no new work at all, not once per project.
        why @ (Unplaced::Restarting { .. } | Unplaced::Draining { .. }) => {
            t.masters().note_unplaced(t.project_id(), why);
        }
        why => say_unplaced(t.masters(), t.project_id(), t.slug(), why),
    }
}

async fn leave(
    t: &Turn<'_>,
    ledger: &mut Option<Ledger>,
    reason: &str,
    because: &str,
    authority: &AuthoritySink,
    deaf: &DeafSink,
    found: &mut Found,
) {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let name = &t.seen.pane_name;
    match (reason, t.seen.adopted.as_ref()) {
        ("stood_down", _) => {
            let row = match &t.seen.standing {
                StandingRead::Known(s) => s.as_ref(),
                StandingRead::Unreadable(_) => None,
            };
            say_unplaced(
                masters,
                project_id,
                slug,
                stood_down_reason(row, slug, Some(name)),
            );
        }
        ("deaf", Some(adopted)) => {
            deaf.set(slug, name, DeafAct::LeftStanding(because.to_string()));
            record_stale(t, adopted, authority);
            tend(t, found).await;
        }
        // Priced amnesty: only a core older than the draining keep still
        // leaves an outdated pane; this arm goes once every core this runner
        // build serves keeps one instead.
        ("outdated", Some(_)) => {
            if masters.note_outdated(project_id, Some(because.to_string())) {
                tracing::warn!(
                    "[master] {slug}: {name} is left running and not nudged: {because}. Core replaces it on the first sweep that finds no run it holds still working, it at its prompt, and work for its successor; `forge-runner master kill {slug}` replaces it now, ending whatever it is doing"
                );
            }
            record_heard(t, ledger, authority).await;
            tend(t, found).await;
        }
        _ => say_unplaced(
            masters,
            project_id,
            slug,
            Unplaced::Withheld {
                reason: reason.to_string(),
                because: because.to_string(),
            },
        ),
    }
}

/// End an idle master's pane and close its session.
async fn retire(t: &Turn<'_>, because: &str) {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let Some((session_id, name)) = masters.get(project_id) else {
        tracing::warn!(
            "[master] {slug}: core retired this project's master ({because}) and this box serves no session for it, so nothing was ended"
        );
        return;
    };
    tracing::info!("[master] {slug}: core retires {name}: {because}");
    // Said, not swallowed: the row is closed either way, so a pane that
    // outlived its retirement is adopted again on the next sweep.
    if let Err(e) = terminal::kill(&name).await {
        tracing::warn!(
            "[master] {slug}: {name} was retired as idle and tmux would not end it: {e} — its row is closed all the same and the next sweep adopts whatever is still running under that name"
        );
    }
    let client = t.sw.client;
    end_master(
        client,
        masters,
        t.sw.tokens,
        project_id,
        &session_id,
        "idle, children done",
    )
    .await;
}

/// A pane this box cannot hear: the project has no working master, so the
/// registry says why, and the ledger records `stale`.
fn record_stale(t: &Turn<'_>, adopted: &Adopted, authority: &AuthoritySink) {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let (name, session) = (&t.seen.pane_name, &adopted.session.session_id);
    masters.note_unplaced(
        project_id,
        Unplaced::StaleCapability {
            session: session.clone(),
            pane: name.clone(),
        },
    );
    authority.set(
        name,
        adopted.incarnation.clone(),
        MasterAuthority::STALE,
        None,
    );
    if masters.note_capability(project_id, MasterAuthority::STALE) {
        tracing::error!(
            "[master] {slug}: the resident session {name} holds a capability for a session this box no longer has — core's session for it is {session}, nothing here ever minted a capability for that session, and a running pane cannot be handed one. Every declaration {name} makes is refused: `forge-runner master kill {slug}` ends it, and core places its successor where work waits. `forge-runner master status {slug}` says the same thing without this log."
        );
    }
}

/// Record what this box can say about a pane it serves, and carry the runs it
/// holds to the session it is served under where the box can hear it. Answers
/// whether it can.
async fn record_heard(
    t: &Turn<'_>,
    ledger: &mut Option<Ledger>,
    authority: &AuthoritySink,
) -> bool {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let Some(adopted) = t.seen.adopted.as_ref() else {
        return false;
    };
    let name = &t.seen.pane_name;
    match &adopted.capability {
        Capability::Stale => {
            record_stale(t, adopted, authority);
            return false;
        }
        Capability::Unknown(why) => {
            masters.clear_unplaced(project_id);
            authority.set(
                name,
                adopted.incarnation.clone(),
                MasterAuthority::UNKNOWN,
                Some(why),
            );
            if masters.note_capability(project_id, MasterAuthority::UNKNOWN) {
                tracing::warn!(
                    "[master] {slug}: cannot tell whether {name}'s capability is current: {why}. Saying nothing about it rather than calling it stale — an unreadable map is not evidence about any pane."
                );
            }
            return false;
        }
        Capability::Current => {
            if let Some(held) = masters.readopt(project_id, &adopted.session.session_id) {
                tracing::info!(
                    "[master] {slug}: core now serves {name} as session {} in place of {held}; the pane keeps the capability it was placed with, which names this project and pane rather than a session",
                    adopted.session.session_id
                );
            }
            masters.clear_unplaced(project_id);
            masters.note_capability(project_id, MasterAuthority::CURRENT);
            authority.set(
                name,
                adopted.incarnation.clone(),
                MasterAuthority::CURRENT,
                None,
            );
        }
    }
    let Some((successor, name)) = masters.get(project_id) else {
        return true;
    };
    let pane_pid = terminal::pane_pid(&name).await;
    let hosts = subagent_host::ProcHosts::system();
    if let Some(led) = ledger.as_mut() {
        carry_and_record(led, project_id, &name, &successor, pane_pid, &hosts, slug);
    }
    true
}

/// What a pane that is up owes core and the box-level account each sweep: the
/// dialog it is stopped on, and its account's last refusal.
async fn tend(t: &Turn<'_>, found: &mut Found) {
    let shared = t.sw.shared;
    report_pane_dialog(t.sw.client, shared.masters, shared.activity, t.project_id()).await;
    if let Some(said) = t
        .seen
        .last_said
        .as_ref()
        .filter(|d| master_limit::is_fresh(d, t.sw.now_unix))
    {
        found.account_said.push(said.clone());
    }
}

/// Open the pass core asked for, and type the nudge where `typed`: a pane just
/// placed was handed its brief, which is this pass's nudge.
async fn drive(t: &Turn<'_>, ledger: &mut Option<Ledger>, typed: bool) {
    let (masters, project_id) = (t.masters(), t.project_id());
    let prompts = masters
        .get(project_id)
        .and_then(|(s, _)| t.sw.shared.activity.get(&s))
        .map(|a| a.prompts);
    masters.note_nudged(project_id, t.seen.digest, prompts);
    let pass = NudgePass {
        client: t.sw.client,
        shared: *t.sw.shared,
        project_id,
        issue_key: master_pass::nudged_issue(&t.work.admissible, t.work.inbox.is_empty()),
    };
    pass.open(ledger, typed).await;
    if typed {
        let held = t.seen.held.as_ref();
        nudge_master(masters, project_id, t.slug(), held, &t.work.inbox).await;
    }
}

/// End the pane core replaces. `Some(ended_deaf)` where it is gone and its
/// successor may be placed; `None` where it is still up, which is said.
async fn end_for_replacement(
    t: &Turn<'_>,
    reason: &str,
    because: &str,
    authority: &AuthoritySink,
    deaf: &DeafSink,
) -> Option<bool> {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let name = &t.seen.pane_name;
    match (reason, t.seen.adopted.as_ref()) {
        ("outdated", _) => {
            if let Err(e) = terminal::kill(name).await {
                if masters.note_outdated(project_id, Some(format!("unkillable: {because}"))) {
                    tracing::error!(
                        "[master] {slug}: core replaces {name} ({because}) and tmux would not end it: {e}. It is left running and not nudged; `forge-runner master kill {slug}` ends it, and the next sweep places its successor"
                    );
                }
                return None;
            }
            tracing::info!(
                "[master] {slug}: core replaces {name}: {because}. It is ended and placed again this sweep, resuming its conversation under the build and plugins this box holds now"
            );
            match masters.get(project_id) {
                Some((session, _)) => {
                    let why = "outdated: replaced by a pane under the build this box runs";
                    end_master(t.sw.client, masters, t.sw.tokens, project_id, &session, why).await;
                }
                None => {
                    masters.forget(project_id);
                }
            }
            masters.note_outdated(project_id, None);
            Some(false)
        }
        ("deaf", Some(adopted)) => {
            let session = &adopted.session.session_id;
            if end_deaf_pane(name, slug, session, deaf).await {
                Some(true)
            } else {
                record_stale(t, adopted, authority);
                None
            }
        }
        _ => {
            say_unplaced(
                masters,
                project_id,
                slug,
                Unplaced::Withheld {
                    reason: reason.to_string(),
                    because: because.to_string(),
                },
            );
            None
        }
    }
}

/// Place the pane core placed, and do what a new pane owes: its runs, its
/// stand-down episode, a withdrawal where it was stood down meanwhile, and
/// the pass its brief opens.
async fn place(
    t: &Turn<'_>,
    ledger: &mut Option<Ledger>,
    placing: Placing,
    authority: &AuthoritySink,
    deaf: &DeafSink,
    found: &mut Found,
) {
    let (project_id, slug) = (t.project_id(), t.slug());
    let adopted = t.seen.adopted.as_ref().filter(|_| placing.ended_deaf);
    let session = match adopted {
        Some(a) => a.session.clone(),
        None => match register_master(t.sw, project_id, slug, &t.seen.pane_name).await {
            Some(s) => s,
            None => return,
        },
    };
    let inherited = inherited_for(ledger.as_ref(), project_id, slug);
    let lifted = match &t.seen.standing {
        StandingRead::Known(Some(s)) => lifted_from(s),
        _ => None,
    };
    let told = std::sync::atomic::AtomicBool::new(false);
    let started = std::sync::atomic::AtomicBool::new(false);
    let hosts = subagent_host::ProcHosts::system();
    let carry = Carryover {
        conversation: placing.resume.as_deref(),
        inherited: &inherited,
        lifted: lifted.as_ref(),
        stood_down_told: &told,
        started: &started,
        hosts: &hosts,
        inbox: &t.work.inbox,
    };
    let ports = CapabilityPorts {
        tokens: t.sw.tokens,
        authority,
        deaf,
    };
    let pane = place_pane(t, &session, &carry, placing.ended_deaf, &ports).await;
    let new = matches!(pane, PaneState::ColdStarted | PaneState::Resumed);
    if new && started.load(std::sync::atomic::Ordering::Relaxed) {
        placed(t, ledger, &inherited, pane == PaneState::Resumed, &hosts);
    }
    if pane == PaneState::Absent {
        return;
    }
    tend(t, found).await;
    if told.load(std::sync::atomic::Ordering::Relaxed) {
        stamp_told(ledger.as_ref(), project_id, slug, lifted.as_ref());
    }
    if !new {
        return;
    }
    let clear = withdrawn_if_stood_down(t, ledger).await;
    if clear == Some(false) {
        return;
    }
    if pane == PaneState::Resumed {
        owe_resume_choices(t, ledger);
    }
    // Driving a pane while unable to say whether the project is stood down is
    // the fail-open the standing read exists to close, so an unread one
    // forfeits the pass its brief would open.
    if placing.nudge && clear == Some(true) {
        drive(t, ledger, false).await;
    }
}

/// The runs a pane placed now inherits, read by project and boot so a pane
/// placed under a new session still answers for its predecessor's (ISS-1312).
fn inherited_for(ledger: Option<&Ledger>, project_id: &str, slug: &str) -> Vec<InheritedRun> {
    ledger
        .and_then(|led| {
            let boot = inheritance_boot(
                runner_core::inflight::boot_identity(),
                led,
                project_id,
                slug,
            )?;
            Some(inherited_runs(led, project_id, &boot))
        })
        .unwrap_or_default()
}

fn placed(
    t: &Turn<'_>,
    ledger: &mut Option<Ledger>,
    inherited: &[InheritedRun],
    resumed: bool,
    hosts: &dyn subagent_host::Hosts,
) {
    let (masters, project_id) = (t.masters(), t.project_id());
    if let Some(led) = ledger.as_ref() {
        note_placement(led, project_id, &t.seen.pane_name, t.resolved);
    }
    if let (Some(led), Some((successor, _))) = (ledger.as_mut(), masters.get(project_id)) {
        let now = agent_activity::now_ms();
        placed_again(led, inherited, &successor, resumed, now, t.slug(), hosts);
    }
}

fn stamp_told(ledger: Option<&Ledger>, project_id: &str, slug: &str, lifted: Option<&Lifted>) {
    let Some((led, lifted)) = ledger.zip(lifted) else {
        return;
    };
    if let Err(e) = led.note_standing_told(project_id, lifted.episode) {
        tracing::warn!(
            "[master] {slug}: cannot mark the lifted stand-down a pane has now been told about: {e} — the next pane placed will be told the same interval again"
        );
    }
}

/// A stand-down written while this turn was starting a pane: the owner's act
/// was on the record when the placement finished, so the pane this turn placed
/// is withdrawn rather than left running until the next pass. `Some(true)`
/// where nothing stands against it, `Some(false)` where it was withdrawn, and
/// `None` where the standing could not be read back, which forfeits the nudge.
async fn withdrawn_if_stood_down(t: &Turn<'_>, ledger: &mut Option<Ledger>) -> Option<bool> {
    let (masters, project_id, slug) = (t.masters(), t.project_id(), t.slug());
    let name = &t.seen.pane_name;
    let since = match read_standing(ledger.as_ref(), project_id) {
        StandingRead::Known(s) => s,
        StandingRead::Unreadable(detail) => {
            tracing::error!(
                "[master] {slug}: {name} was just placed and this box cannot read back whether its owner stood the project down ({detail}). It is NOT being withdrawn — ending a pane on an unreadable record would take work nobody decided to end — and it is NOT being nudged either. If it was stood down, `forge-runner master kill {slug}`."
            );
            return None;
        }
    };
    if !since.as_ref().is_some_and(MasterStanding::stands) {
        return Some(true);
    }
    tracing::error!(
        "[master] {slug}: {name} was stood down while this sweep was starting it — withdrawing the pane this sweep placed. `forge-runner master stand-up {slug}` puts the project back under this box's authority."
    );
    let mut left_running = None;
    if let Err(e) = terminal::kill(name).await {
        tracing::error!(
            "[master] {slug}: could not withdraw {name}: {e} — it is running against a stand-down and `forge-runner master kill {slug}` is what ends it"
        );
        left_running = Some(name.clone());
    }
    if let Some((session_id, _)) = masters.get(project_id) {
        let why = "stood down while this sweep was placing it";
        end_master(
            t.sw.client,
            masters,
            t.sw.tokens,
            project_id,
            &session_id,
            why,
        )
        .await;
    }
    let reason = stood_down_reason(since.as_ref(), slug, left_running.as_deref());
    say_unplaced(masters, project_id, slug, reason);
    Some(false)
}

fn owe_resume_choices(t: &Turn<'_>, ledger: &mut Option<Ledger>) {
    let (masters, slug) = (t.masters(), t.slug());
    let pane_boot = runner_core::inflight::boot_identity().unwrap_or_default();
    let (Some(led), Some((session_id, _))) = (ledger.as_mut(), masters.get(t.project_id())) else {
        return;
    };
    match led.owe_resume_choices(&session_id, &pane_boot) {
        Ok(0) => {}
        Ok(n) => tracing::info!(
            "[master] {slug}: resumed holding {n} run(s) — it must say what happens to each before declaring new work"
        ),
        Err(e) => tracing::warn!("[master] {slug}: cannot mark the runs this pane inherited: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runner() -> runners::MeRunner {
        serde_json::from_value(serde_json::json!({
            "projectId": "p",
            "runnerId": "r",
            "slug": "forge",
            "status": "draining",
        }))
        .expect("a runner row decodes")
    }

    fn seen(elsewhere: Option<subagent_host::Running>) -> Seen {
        Seen {
            standing: StandingRead::Known(None),
            pane_name: "forge-master-forge".into(),
            pane_alive: false,
            stored_conversation: Some("c1".into()),
            elsewhere: elsewhere.map(|r| ("c1".to_string(), Some("ab12".to_string()), r)),
            adopted: None,
            servers: None,
            restarting: None,
            held: None,
            last_said: None,
            digest: 0,
        }
    }

    #[test]
    fn a_withheld_reason_this_build_knows_is_said_in_its_own_records_words() {
        let r = runner();
        let found = subagent_host::Running::Found(42);
        assert!(matches!(
            withheld_as("conversation_elsewhere", "x", &r, &seen(Some(found))),
            Unplaced::ConversationElsewhere { pid: 42, .. }
        ));
        assert!(matches!(
            withheld_as("runner_not_accepting", "x", &r, &seen(None)),
            Unplaced::Draining { status } if status == "draining"
        ));
        assert!(matches!(
            withheld_as("nothing_owed", "x", &r, &seen(None)),
            Unplaced::NothingAdmissible
        ));
    }

    #[test]
    fn a_reason_it_does_not_know_is_said_as_core_said_it_rather_than_read_as_another() {
        let r = runner();
        let why = withheld_as("quota_exhausted", "the org is out of runs", &r, &seen(None));
        assert!(
            matches!(&why, Unplaced::Withheld { reason, because } if reason == "quota_exhausted" && because == "the org is out of runs"),
            "a reason core added after this build was mapped onto one this build knows"
        );
        assert!(
            matches!(
                withheld_as("restarting", "x", &r, &seen(None)),
                Unplaced::Withheld { .. }
            ),
            "a restart this box is not in was recorded as one"
        );
    }
}
