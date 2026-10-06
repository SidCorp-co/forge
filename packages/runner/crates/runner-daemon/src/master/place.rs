use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Placement {
    /// Adopt a live pane, and start one where there is none.
    AdoptOrStart,
    /// Adopt a live pane, and start nothing.
    AdoptOnly,
}

pub(crate) fn placement_for(
    admissible: &[AdmissibleIssue],
    inbox: &[UnansweredDocument],
) -> Placement {
    if admissible.is_empty() && inbox.is_empty() {
        Placement::AdoptOnly
    } else {
        Placement::AdoptOrStart
    }
}

/// What a pane this sweep places carries over from whatever stood before it:
/// the conversation it resumes, the runs that conversation holds, and the
/// stand-down its project has just come out of.
pub(crate) struct Carryover<'a> {
    pub(crate) conversation: Option<&'a str>,
    pub(crate) inherited: &'a [InheritedRun],
    /// Set only for a pane placed after a stand-down was lifted, so a resumed
    /// conversation is not told merely that it is master again (ISS-1118), and
    /// carrying the two reasons as well as the interval (ISS-1238).
    pub(crate) lifted: Option<&'a Lifted>,
    /// Raised when the brief carrying `lifted` actually reached a pane. The
    /// sweep stamps the lifted episode told only on this, because a pane that
    /// was adopted rather than started was sent no brief at all, and one whose
    /// brief failed to land was told nothing — stamping on either would spend
    /// the episode undelivered.
    pub(crate) stood_down_told: &'a std::sync::atomic::AtomicBool,
    /// Raised when this call started a pane process of its own, which is what
    /// proves the one before it gone: a pane found already up is somebody's
    /// running process, and its subagents with it.
    pub(crate) started: &'a std::sync::atomic::AtomicBool,
    /// The box's process table: where each inherited subagent runs, and what
    /// runs a conversation outside this box's panes.
    pub(crate) hosts: &'a dyn subagent_host::Hosts,
    pub(crate) slots: u32,
    /// What the project owes its master this sweep. A placed pane is typed no
    /// nudge (`types_nudge`), so its brief is the only place the pass it is
    /// placed for can be told what it owes.
    pub(crate) inbox: &'a [UnansweredDocument],
}

/// The brief a placed pane is sent: the standing prompt, what a resumed
/// conversation carries, the stand-down it comes out of, and what its first
/// pass owes.
pub(crate) fn placement_brief(
    standing: String,
    resumed: Option<String>,
    lifted: Option<String>,
    inbox: &[UnansweredDocument],
) -> String {
    let owed = master_inbox::inbox_line(inbox);
    let owed = if owed.is_empty() {
        owed
    } else {
        format!("\n## What this first pass owes\n\n{}\n", owed.trim_start())
    };
    format!(
        "{standing}{}{}{owed}",
        resumed.unwrap_or_default(),
        lifted.unwrap_or_default()
    )
}

/// The verdict `ensure_master` reached about the capability a pane holds, on
/// its way to somewhere a restart cannot erase it.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Authority {
    /// The pane it is about, by name and by which incarnation of that name was
    /// running: the name is derived from the slug, so every pane this project
    /// ever has carries it and the name alone identifies nothing.
    pub(crate) pane: String,
    pub(crate) incarnation: Option<String>,
    /// One of `MasterAuthority`'s three.
    pub(crate) verdict: &'static str,
    /// Why the verdict is `unknown`, and `None` on the other two.
    pub(crate) detail: Option<String>,
}

/// Where `ensure_master` leaves that verdict for the sweep to write down.
///
/// An out-parameter rather than a return value because `ensure_master` has ten
/// exits and three of them reach a verdict, and rather than the `Ledger`
/// itself because a `rusqlite::Connection` is not `Sync`: holding one across
/// an await inside this spawned future makes the future itself unspawnable.
/// The same shape `Carryover::stood_down_told` already uses for the same
/// reason.
#[derive(Default)]
pub(crate) struct AuthoritySink(pub(crate) Mutex<Option<Authority>>);

impl AuthoritySink {
    pub(crate) fn set(
        &self,
        pane: &str,
        incarnation: Option<String>,
        verdict: &'static str,
        detail: Option<&str>,
    ) {
        *self.0.lock().expect("authority sink poisoned") = Some(Authority {
            pane: pane.to_string(),
            incarnation,
            verdict,
            detail: detail.map(str::to_string),
        });
    }

    pub(crate) fn take(&self) -> Option<Authority> {
        self.0.lock().expect("authority sink poisoned").take()
    }
}

#[expect(
    clippy::too_many_lines,
    reason = "master placement, which core takes over per ADR 0009 What core takes over: Placement; deleted rather than split once core answers it (ISS-218 amnesty)"
)]
pub(crate) async fn ensure_master(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    resolved: &crate::dispatch::Resolved,
    carry: &Carryover<'_>,
    placement: Placement,
    ports: &CapabilityPorts<'_>,
) -> PaneState {
    let tokens = ports.tokens;
    let stored_conversation = carry.conversation;
    let inherited = carry.inherited;
    let name = terminal::session_name(terminal::MASTER_PREFIX, &resolved.slug);
    if !terminal::available() {
        tracing::error!(
            "[master] {}: tmux is not installed on this box — no master will run for it; install tmux (`forge-runner doctor` checks for it)",
            resolved.slug
        );
        say_unplaced(masters, project_id, &resolved.slug, Unplaced::NoTerminal);
        return PaneState::Absent;
    }

    if placement == Placement::AdoptOnly && !terminal::alive(&name).await {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    let session = match master_api::register(client, project_id, &name, carry.slots).await {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("[master] {}: cannot register with core: {e}", resolved.slug);
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::RegisterFailed {
                    detail: e.to_string(),
                },
            );
            return PaneState::Absent;
        }
    };

    let asked = project_mcp_servers(client, project_id).await;

    // Whether the placement path below is a REPLACEMENT or an ordinary cold
    // start, which is the difference between `terminal::ensure` starting
    // nothing because the box is already served and starting nothing because
    // the pane this call ended is still standing (ISS-1208, criterion 7).
    let mut ended_a_deaf_pane = false;
    if terminal::alive(&name).await {
        if let Err(e) = &asked {
            tracing::warn!(
                "[master] {}: could not read this project's declared MCP servers from core ({e}), so whether {name} carries them is not known this sweep",
                resolved.slug
            );
        }
        report_stale_pane_config(
            masters,
            project_id,
            &name,
            &resolved.slug,
            asked.as_ref().ok(),
        );
        if masters.get(project_id).is_none() {
            tracing::info!(
                "[master] {}: adopting the resident session {name}",
                resolved.slug
            );
            remember(masters, project_id, &session);
        }
        let pane_now = terminal::incarnation(&name).await;
        let verdict = verdict_over_unwithdrawn(
            capability_of(tokens, &session.session_id, project_id, &name),
            masters.unwithdrawn_for(project_id).as_deref(),
            &session.session_id,
        );
        let act = replacement_gate(capability_act(&verdict, placement), asked.is_ok());
        if let CapabilityAct::LeaveDeaf(why) = act {
            ports.deaf.set(
                &resolved.slug,
                &name,
                DeafAct::LeftStanding(why.to_string()),
            );
        }
        // A pane this box has proved it can never hear again is ended here and
        // this function does NOT return: everything below the adopt branch is
        // the placement path, and falling into it is how the replacement comes
        // to hold a capability minted for the session registered moments ago.
        //
        // This is the one carve-out from the rule stated at the stand-down
        // withdrawal, where a pane this daemon merely adopted is left for
        // whoever owns it. ISS-933 took this daemon out of killing masters on a
        // timer; it did not decide this case, which ISS-1099 left open by name
        // and ISS-1208 closes — a master that cannot be heard is not a master,
        // and the operator who ends it adds no judgement this box does not
        // already hold.
        ended_a_deaf_pane = act == CapabilityAct::Replace
            && end_deaf_pane(&name, &resolved.slug, &session.session_id, ports.deaf).await;
        if !ended_a_deaf_pane {
            return match verdict {
                Capability::Current => {
                    if let Some(held) = masters.readopt(project_id, &session.session_id) {
                        tracing::info!(
                            "[master] {}: core now serves {name} as session {} in place of {held}. The pane keeps the capability it was placed with, which names this project and this pane rather than a session, so it is not ended; this box serves it under the new session from now on",
                            resolved.slug,
                            session.session_id
                        );
                    }
                    masters.clear_unplaced(project_id);
                    masters.note_capability(project_id, MasterAuthority::CURRENT);
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::CURRENT, None);
                    PaneState::Adopted
                }
                Capability::Stale => {
                    // NOT `clear_unplaced`. The pane is up and this box cannot hear
                    // it, so the project has no working master and the registry has
                    // to say so — clearing it here erased the one record of why, at
                    // the moment the daemon learned it.
                    //
                    // `note_unplaced` and not `say_unplaced`, because the error
                    // below already carries this state to the journal and says more
                    // about it than the generic line would. Recording it twice is
                    // two entries for one event and a reader who cannot tell
                    // whether it happened once.
                    masters.note_unplaced(
                        project_id,
                        Unplaced::StaleCapability {
                            session: session.session_id.clone(),
                            pane: name.clone(),
                        },
                    );
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::STALE, None);
                    if masters.note_capability(project_id, MasterAuthority::STALE) {
                        tracing::error!(
                            "[master] {}: the resident session {name} holds a capability for a session this box no longer has — core's session for it is {}, nothing here ever minted a capability for that session, and a running pane cannot be handed one. Every declaration {name} makes is refused and nothing this daemon does changes that: `forge-runner master kill {}`, which reaches the tmux server masters actually run on where a bare `tmux kill-session` does not, and which is what lets a master carrying the current capability be placed — placement itself still answers to the same gates as any other. It is not being nudged while it stands like this. `forge-runner master status {}` says the same thing without this log.",
                            resolved.slug,
                            session.session_id,
                            resolved.slug,
                            resolved.slug
                        );
                    }
                    PaneState::StaleCapability
                }
                Capability::Unknown(why) => {
                    masters.clear_unplaced(project_id);
                    ports
                        .authority
                        .set(&name, pane_now, MasterAuthority::UNKNOWN, Some(&why));
                    if masters.note_capability(project_id, MasterAuthority::UNKNOWN) {
                        tracing::warn!(
                            "[master] {}: cannot tell whether {name}'s capability is current: {why}. Saying nothing about it rather than calling it stale — an unreadable map is not evidence about any pane.",
                            resolved.slug
                        );
                    }
                    PaneState::Adopted
                }
            };
        }
    }

    if placement == Placement::AdoptOnly {
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::NothingAdmissible,
        );
        return PaneState::Absent;
    }

    // The last pane placed here exited because Claude Code runs this
    // conversation as a background session. Another would exit the same way,
    // so none is placed while a process on this box still names it, or while
    // this box cannot read whether one does; once the whole table reads that
    // none does, the session has ended and a pane resuming it can run
    // (ISS-1312, F1).
    if let Some(conversation) = masters
        .elsewhere(project_id)
        .filter(|c| stored_conversation == Some(c.as_str()))
    {
        let short = masters.elsewhere_short(project_id);
        match carry.hosts.running(&conversation) {
            subagent_host::Running::Found(pid) => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::ConversationElsewhere {
                        conversation,
                        short,
                        pid,
                    },
                );
                return PaneState::Absent;
            }
            subagent_host::Running::Unreadable => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::ConversationUnaskable {
                        conversation,
                        short,
                    },
                );
                return PaneState::Absent;
            }
            subagent_host::Running::Absent => {
                tracing::info!(
                    "[master] {}: no process on this box names conversation {conversation} any more, so its background session has ended and a pane resuming it is placed",
                    resolved.slug
                );
                masters.clear_elsewhere(project_id);
            }
        }
    }

    // Before anything is installed or minted: a pane that will not be started
    // leaves no capability behind it and nothing to withdraw.
    let declared = match servers_for_start(&asked) {
        Ok(declared) => declared,
        Err(why) => {
            say_unplaced(masters, project_id, &resolved.slug, why);
            return PaneState::Absent;
        }
    };

    if let Err(e) = install_skill(
        &resolved.repo_path,
        &resolved.slug,
        runner_platform::config::config_dir().as_deref(),
    ) {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        say_unplaced(
            masters,
            project_id,
            &resolved.slug,
            Unplaced::SkillMissing { detail: e },
        );
        return PaneState::Absent;
    }

    install_hooks_logged(&resolved.repo_path, &resolved.slug);

    runner_workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);

    let transcript = transcript_path(&resolved.slug);
    let mut env = terminal::pane_env(project_id, &resolved.slug);
    env.extend(cli_borrow_env(&resolved.slug));
    let mcp_config = match runner_workspace::mcp::config::write_session(
        &resolved.slug,
        &declared.mcp_servers,
    ) {
        Ok(path) => path,
        Err(e) => {
            let cleared = runner_workspace::mcp::config::clear_session(&resolved.slug);
            match (
                launch_record(false, cleared.is_ok(), !declared.mcp_servers.is_empty()),
                &cleared,
            ) {
                (LaunchRecord::Lying, Err(ce)) => {
                    say_unplaced(
                        masters,
                        project_id,
                        &resolved.slug,
                        Unplaced::ServersUnwritable {
                            detail: format!(
                                "{e}; the previous config could not be removed either ({ce}), and it still claims servers a pane started now would not carry"
                            ),
                            dir: runner_workspace::mcp::config::session_dir(),
                        },
                    );
                    return PaneState::Absent;
                }
                (LaunchRecord::Withheld, _) => {
                    say_unplaced(
                        masters,
                        project_id,
                        &resolved.slug,
                        Unplaced::ServersUnwritable {
                            detail: format!(
                                "{e}; declared: {}",
                                declared.resolved_names.join(", ")
                            ),
                            dir: runner_workspace::mcp::config::session_dir(),
                        },
                    );
                    return PaneState::Absent;
                }
                _ => {
                    tracing::warn!(
                        "[master] {}: could not write the pane's MCP config ({e}); the project declares no servers, so the pane is started with none",
                        resolved.slug
                    );
                    None
                }
            }
        }
    };
    if let Some(path) = mcp_config.as_deref() {
        tracing::info!(
            "[master] {}: pane declares {} from {}",
            resolved.slug,
            declared.resolved_names.join(", "),
            path.display()
        );
    }
    // The mint is the last refusal before the pane. Every refusal above it
    // leaves no capability behind; one below it has to withdraw what it minted.
    match tokens {
        Some(store) => match store.mint(&session.session_id, project_id, &resolved.slug, &name) {
            Ok(token) => env.push((session_tokens::TOKEN_ENV.to_string(), token)),
            Err(e) => {
                say_unplaced(
                    masters,
                    project_id,
                    &resolved.slug,
                    Unplaced::CapabilityUnminted {
                        detail: e.to_string(),
                    },
                );
                return PaneState::Absent;
            }
        },
        None => {
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::CapabilityUnminted {
                    detail: "this box cannot resolve where its control token map lives".into(),
                },
            );
            return PaneState::Absent;
        }
    }
    let resume = resume_for(&resolved.slug, &resolved.repo_path, stored_conversation);
    let output_from = transcript
        .as_deref()
        .map(|p| std::fs::metadata(p).map_or(0, |m| m.len()));
    let started = match terminal::ensure(
        &name,
        &resolved.repo_path,
        &terminal::pane_argv(mcp_config.as_deref(), resume.as_deref()),
        &env,
        transcript.as_deref(),
    )
    .await
    {
        Ok(started) => started,
        Err(e) => {
            let detail = format!("could not start {name}: {e}");
            // No pane holds the capability minted for it, so it is taken back
            // rather than left in the map as proof of a pane that never started.
            let withdrawn = withdraw_unplaced_mint(tokens, &session.session_id);
            masters.note_unwithdrawn(
                project_id,
                withdrawn
                    .as_ref()
                    .err()
                    .map(|_| session.session_id.as_str()),
            );
            if let Err(why) = withdrawn {
                tracing::error!(
                    "[master] {}: the capability minted for {} could NOT be withdrawn: {why}",
                    resolved.slug,
                    session.session_id
                );
            }
            say_unplaced(
                masters,
                project_id,
                &resolved.slug,
                Unplaced::PaneUnstarted { detail },
            );
            return PaneState::Absent;
        }
    };
    if replacement_of(ended_a_deaf_pane, started) == Replacement::DeafPaneSurvived {
        return deaf_pane_outlived_its_kill(
            masters,
            project_id,
            &resolved.slug,
            &name,
            &session.session_id,
            ports,
        )
        .await;
    }
    tracing::info!(
        "[master] {}: resident session {name} {} in {} — `{}` to watch it",
        resolved.slug,
        match (started, resume.as_deref()) {
            (false, _) => "was already up, and this pass started nothing".to_string(),
            (true, Some(id)) => format!("resumed from conversation {id}"),
            (true, None) => "cold-started".to_string(),
        },
        resolved.repo_path.display(),
        terminal::attach_command(&name)
    );
    remember(masters, project_id, &session);
    masters.clear_unplaced(project_id);
    if started {
        masters.note_placed(project_id, transcript.clone().zip(output_from));
    }
    carry
        .started
        .store(started, std::sync::atomic::Ordering::Relaxed);
    // A pane is up. Where this call ended a deaf one on its way here, that is
    // the moment its account becomes a replacement rather than an ending; every
    // return between the kill and this line leaves it reading `ended`, which is
    // what was true (ISS-1208).
    ports.deaf.placed();
    // And a pane is up carrying this session's capability, so the entry in the
    // map is one a live pane holds rather than the residue of a placement that
    // placed nothing. Held only while that is in doubt, or one failed
    // withdrawal refuses this project for ever.
    masters.note_unwithdrawn(project_id, None);
    // A pane this sweep started carries a capability minted for this very
    // session moments ago, so the verdict is not in doubt. It is written all the
    // same: the record has to say `current` for a replaced pane, or an operator
    // who killed a stale one reads the old verdict back and concludes the kill
    // did nothing.
    masters.note_capability(project_id, MasterAuthority::CURRENT);
    ports.authority.set(
        &name,
        terminal::incarnation(&name).await,
        MasterAuthority::CURRENT,
        None,
    );

    let reach =
        runner_workspace::mcp::config::pane_reach(&resolved.repo_path, mcp_config.as_deref());
    match reach.forge() {
        runner_workspace::mcp::config::ForgeReach::Declared => {
            tracing::info!("[master] {}: pane {}", resolved.slug, reach.verdict())
        }
        _ => tracing::warn!(
            "[master] {}: pane {} — the pane is told this in its own brief, which is the only \
surface it reads",
            resolved.slug,
            reach.verdict()
        ),
    }
    let brief = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &reach,
    );
    let brief = placement_brief(
        brief,
        resume
            .as_deref()
            .map(|conv| resumed_brief(conv, inherited, started, carry.hosts)),
        carry.lifted.map(stood_up_brief),
        carry.inbox,
    );
    match terminal::brief_new_pane(&name, &brief).await {
        Ok(()) => {
            let carried = carry.lifted.is_some();
            let order = std::sync::atomic::Ordering::Relaxed;
            carry.stood_down_told.store(carried, order);
        }
        // A pane that exited before its brief reached it is reported by the
        // sweep that reads it gone, with why, as a failed nudge is: a warning
        // here too was the line sid-desk's journal carried once per placement
        // beside the exit (ISS-1343 criterion 8).
        Err(e) if recovery_ports::pane_presence(&name).await == recovery::MasterPresence::Gone => {
            tracing::debug!(
                "[master] {}: {name} exited before its brief reached it ({e}); the sweep that reads it gone says why",
                resolved.slug
            );
        }
        Err(e) => tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug),
    }
    match resume {
        Some(_) => PaneState::Resumed,
        None => PaneState::ColdStarted,
    }
}

/// The owner's veto for one project: what the ledger says, whether a pane
/// contradicts it, and the report where one does.
///
/// Called from both branches of the sweep's per-project loop. A runner that
/// takes no new work is a reason to place nothing; it is not a reason to stop
/// looking, and a pane running against a stand-down on a `draining` box was
/// reported by no daemon at all before this (ISS-1118 criterion 4). The read
/// is the local ledger's, so the branch that asks core nothing still pays
/// nothing.
///
/// `None` where the standing could not be read: the caller places nothing, and
/// the reason is already recorded.
///
/// Takes the read rather than the ledger, because a `Ledger` held across the
/// `terminal::alive` await below makes this future non-`Send` and the daemon
/// spawns it.
pub(crate) async fn standing_verdict(
    masters: &Arc<Masters>,
    read: StandingRead,
    project_id: &str,
    slug: &str,
) -> Option<(Placed, Option<MasterStanding>)> {
    let standing = match read {
        StandingRead::Known(s) => s,
        StandingRead::Unreadable(detail) => {
            say_unplaced(
                masters,
                project_id,
                slug,
                Unplaced::StandingUnreadable { detail },
            );
            return None;
        }
    };
    let stands = standing.as_ref().is_some_and(MasterStanding::stands);
    // The pane is only looked for where something might contradict it: a
    // project nobody stood down answers `Proceed` either way, and asking tmux
    // about every project on every sweep buys that answer nothing.
    let pane_name = terminal::session_name(terminal::MASTER_PREFIX, slug);
    let pane_alive = stands && terminal::alive(&pane_name).await;
    let placed = placement_under(standing.as_ref(), pane_alive);
    if placed == Placed::Contradicted {
        say_unplaced(
            masters,
            project_id,
            slug,
            stood_down_reason(standing.as_ref(), slug, Some(&pane_name)),
        );
    }
    Some((placed, standing))
}

/// Put the verdict this sweep reached about a pane's authority where a restart
/// cannot take it, and where a process other than this daemon can read it.
///
/// The registry holds the same answer and dies with the daemon; the journal
/// holds it and has to be read. This is the copy `forge-runner master status`
/// prints, which is the surface an operator reaches for when a project has
/// stopped (ISS-1099).
pub(crate) fn write_authority(
    ledger: Option<&Ledger>,
    project_id: &str,
    slug: &str,
    said: &Authority,
) {
    let Some(led) = ledger else {
        return;
    };
    if let Err(e) = led.note_master_authority(
        project_id,
        slug,
        (&said.pane, said.incarnation.as_deref()),
        said.verdict,
        said.detail.as_deref(),
    ) {
        tracing::warn!(
            "[master] {slug}: cannot record that {}'s capability is {}: {e} — `forge-runner master status {slug}` will not say it, and the daemon log is then the only account of it",
            said.pane,
            said.verdict
        );
    }
}

/// Say why a project got no pane, once per change of reason and at the level
/// the reason earns.
///
/// The de-duplication is `note_unplaced`'s, which is keyed on `reg.unplaced`
/// and asks nothing of `reg.live`. That distinction is the whole of ISS-1118
/// criterion 4: `reg.live` holds the panes THIS process placed, so a report
/// gated on it is unreachable on a daemon that has just started — and a
/// stood-down project never reaches `ensure_master`, so it is in `reg.live` on
/// no daemon at all once one restarts.
pub(crate) fn say_unplaced(masters: &Arc<Masters>, project_id: &str, slug: &str, why: Unplaced) {
    if !masters.note_unplaced(project_id, why.clone()) {
        return;
    }
    let lead = why.lead();
    if why.is_error() {
        tracing::error!("[master] {slug}: {lead} — {why}");
    } else {
        tracing::warn!("[master] {slug}: {lead} — {why}");
    }
}

pub(crate) fn remember(
    masters: &Arc<Masters>,
    project_id: &str,
    session: &master_api::MasterSession,
) {
    masters.remember(
        project_id,
        MasterState {
            session_id: session.session_id.clone(),
            name: session.name.clone(),
            last_work: Instant::now(),
            last_nudge: None,
            mcp_stale_reported: false,
        },
    );
}

#[cfg(test)]
mod placement_brief_tests {
    use super::*;
    use runner_transport::feedback_inbox::FEEDBACK_TRIAGE_TYPE;

    #[test]
    fn a_pane_placed_for_owed_feedback_is_told_which_item_its_first_pass_owes() {
        let owed = [UnansweredDocument {
            id: "f1".into(),
            number: Some("FB-1".into()),
            r#type: Some(FEEDBACK_TRIAGE_TYPE.into()),
            from: None,
            overdue: false,
        }];
        let brief = placement_brief("standing\n".into(), Some("resumed\n".into()), None, &owed);
        assert!(
            brief.contains("1 feedback item owes a triage (FB-1)"),
            "the placement brief names no owed item, so the pass it places triages nothing: {brief}"
        );
        assert!(brief.starts_with("standing\nresumed\n"), "{brief}");
        let quiet = placement_brief("standing\n".into(), None, None, &[]);
        assert_eq!(quiet, "standing\n");
    }
}
