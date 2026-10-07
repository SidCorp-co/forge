use super::*;

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
    /// Filled when this call started a pane: what it was handed, for the
    /// ledger to report against what a later sweep would hand one.
    pub(crate) placed_with: &'a Mutex<Option<master_build::Inputs>>,
    /// The box's process table: where each inherited subagent runs, and what
    /// runs a conversation outside this box's panes.
    pub(crate) hosts: &'a dyn subagent_host::Hosts,
    /// What the project owes its master this sweep. A placed pane is typed no
    /// nudge, so its brief is the only place the pass it is placed for can be
    /// told what it owes.
    pub(crate) owed: &'a str,
}

impl Carryover<'_> {
    /// Say whether this call started a pane, and, where it did, what it was
    /// handed.
    fn note_started(&self, started: bool, with: master_build::Inputs) {
        self.started
            .store(started, std::sync::atomic::Ordering::Relaxed);
        if started {
            *self.placed_with.lock().expect("placement sink poisoned") = Some(with);
        }
    }
}

/// The brief a placed pane is sent: the standing prompt, what a resumed
/// conversation carries, the stand-down it comes out of, and what its first
/// pass owes.
pub(crate) fn placement_brief(
    standing: String,
    resumed: Option<String>,
    lifted: Option<String>,
    owed: &str,
) -> String {
    let owed = if owed.is_empty() {
        String::new()
    } else {
        format!("\n## What this first pass owes\n\n{}\n", owed.trim_start())
    };
    format!(
        "{standing}{}{}{owed}",
        resumed.unwrap_or_default(),
        lifted.unwrap_or_default()
    )
}

/// What this box found about the capability a pane holds, on its way to
/// somewhere a restart cannot erase it.
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

/// Where a project's turn leaves that finding for the sweep to write down.
///
/// An out-parameter rather than the `Ledger` itself because a
/// `rusqlite::Connection` is not `Sync`: holding one across an await inside
/// this spawned future makes the future itself unspawnable. The same shape
/// `Carryover::stood_down_told` already uses for the same reason.
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

/// A pane's start, prepared: the environment it runs in and the MCP config it
/// declares, with the names that config carries.
pub(crate) struct Prepared {
    env: Vec<(String, String)>,
    mcp_config: Option<std::path::PathBuf>,
    /// What the pane is handed, read before its capability token is added.
    standing: master_build::Inputs,
}

/// Open the pane core placed, resuming `carry.conversation` or cold. The
/// verdict was core's; every refusal here is a step the box could not take,
/// said by name, and none of them is a judgement about whether to place.
pub(crate) async fn place_pane(
    t: &Turn<'_>,
    session: &master_api::MasterSession,
    carry: &Carryover<'_>,
    ended_deaf: bool,
    ports: &CapabilityPorts<'_>,
) -> PaneState {
    let (masters, project_id) = (t.sw.shared.masters, t.runner.project_id.as_str());
    let (resolved, name) = (t.resolved, t.seen.pane_name.as_str());
    let asked = match &t.seen.servers {
        Some(read) => read.clone(),
        None => project_mcp_servers(t.sw.client, project_id).await,
    };
    let prepared = match prepare_pane(project_id, resolved, &asked) {
        Ok(p) => p,
        Err(why) => {
            say_unplaced(masters, project_id, &resolved.slug, why);
            return PaneState::Absent;
        }
    };
    let mut env = prepared.env;
    let standing = prepared.standing;
    if let Err(why) = mint_into(
        &mut env,
        ports.tokens,
        session,
        project_id,
        &resolved.slug,
        name,
    ) {
        say_unplaced(masters, project_id, &resolved.slug, why);
        return PaneState::Absent;
    }
    let resume = carry.conversation;
    let transcript = transcript_path(&resolved.slug);
    let output_from = transcript
        .as_deref()
        .map(|p| std::fs::metadata(p).map_or(0, |m| m.len()));
    let argv = terminal::pane_argv(prepared.mcp_config.as_deref(), resume);
    let started = terminal::ensure(
        name,
        &resolved.repo_path,
        &argv,
        &env,
        transcript.as_deref(),
    )
    .await;
    let started = match started {
        Ok(started) => started,
        Err(e) => {
            unstarted(
                masters,
                project_id,
                &resolved.slug,
                ports.tokens,
                session,
                format!("could not start {name}: {e}"),
            );
            return PaneState::Absent;
        }
    };
    if replacement_of(ended_deaf, started) == Replacement::DeafPaneSurvived {
        let slug = &resolved.slug;
        return deaf_pane_outlived_its_kill(
            masters,
            project_id,
            slug,
            name,
            &session.session_id,
            ports,
        )
        .await;
    }
    tracing::info!(
        "[master] {}: resident session {name} {} in {} — `{}` to watch it",
        resolved.slug,
        match (started, resume) {
            (false, _) => "was already up, and this pass started nothing".to_string(),
            (true, Some(id)) => format!("resumed from conversation {id}"),
            (true, None) => "cold-started".to_string(),
        },
        resolved.repo_path.display(),
        terminal::attach_command(name)
    );
    mark_placed(
        masters,
        project_id,
        session,
        started.then(|| transcript.clone().zip(output_from)),
    );
    carry.note_started(started, standing);
    // A pane is up. Where this call ended a deaf one on its way here, that is
    // the moment its account becomes a replacement rather than an ending.
    ports.deaf.placed();
    ports.authority.set(
        name,
        terminal::incarnation(name).await,
        MasterAuthority::CURRENT,
        None,
    );
    brief_pane(t, carry, prepared.mcp_config.as_deref(), started).await;
    match resume {
        Some(_) => PaneState::Resumed,
        None => PaneState::ColdStarted,
    }
}

/// Everything a pane needs before its capability is minted: the declared
/// servers, the skill, the hooks, the trust, its environment and its MCP
/// config. A pane that will not be started leaves no capability behind it.
fn prepare_pane(
    project_id: &str,
    resolved: &crate::dispatch::Resolved,
    asked: &ServersRead,
) -> std::result::Result<Prepared, Unplaced> {
    let declared = servers_for_start(asked)?;
    install_skill(
        &resolved.repo_path,
        &resolved.slug,
        runner_platform::config::config_dir().as_deref(),
    )
    .map_err(|e| {
        tracing::error!(
            "[master] {}: could not install the forge-master skill into {}: {e} — not starting a master",
            resolved.slug,
            resolved.repo_path.display()
        );
        Unplaced::SkillMissing { detail: e }
    })?;
    install_hooks_logged(&resolved.repo_path, &resolved.slug);
    runner_workspace::trust::pre_trust_logged(&resolved.repo_path, &resolved.slug);
    let mut env = terminal::pane_env(project_id, &resolved.slug);
    env.extend(cli_borrow_env(&resolved.slug));
    let standing = master_build::Inputs::of(&master_build::Handed {
        slug: &resolved.slug,
        repo: &resolved.repo_path,
        env: &env,
        servers: Some(&declared.mcp_servers),
    });
    let mcp_config = write_pane_mcp(&resolved.slug, declared)?;
    if let Some(path) = mcp_config.as_deref() {
        tracing::info!(
            "[master] {}: pane declares {} from {}",
            resolved.slug,
            declared.resolved_names.join(", "),
            path.display()
        );
    }
    Ok(Prepared {
        env,
        mcp_config,
        standing,
    })
}

/// The MCP config a pane is started with, or why none may be: a project that
/// declares servers is never handed a pane carrying none of them.
fn write_pane_mcp(
    slug: &str,
    declared: &mcp_servers::ProjectMcpServers,
) -> std::result::Result<Option<std::path::PathBuf>, Unplaced> {
    let e = match runner_workspace::mcp::config::write_session(slug, &declared.mcp_servers) {
        Ok(path) => return Ok(path),
        Err(e) => e,
    };
    let cleared = runner_workspace::mcp::config::clear_session(slug);
    let dir = runner_workspace::mcp::config::session_dir();
    match (launch_record(false, cleared.is_ok(), !declared.mcp_servers.is_empty()), &cleared) {
        (LaunchRecord::Lying, Err(ce)) => Err(Unplaced::ServersUnwritable {
            detail: format!(
                "{e}; the previous config could not be removed either ({ce}), and it still claims servers a pane started now would not carry"
            ),
            dir,
        }),
        (LaunchRecord::Withheld, _) => Err(Unplaced::ServersUnwritable {
            detail: format!("{e}; declared: {}", declared.resolved_names.join(", ")),
            dir,
        }),
        _ => {
            tracing::warn!(
                "[master] {slug}: could not write the pane's MCP config ({e}); the project declares no servers, so the pane is started with none"
            );
            Ok(None)
        }
    }
}

/// The mint is the last refusal before the pane. Every refusal above it leaves
/// no capability behind; one below it has to withdraw what it minted.
fn mint_into(
    env: &mut Vec<(String, String)>,
    tokens: Option<&session_tokens::SessionTokens>,
    session: &master_api::MasterSession,
    project_id: &str,
    slug: &str,
    name: &str,
) -> std::result::Result<(), Unplaced> {
    let Some(store) = tokens else {
        return Err(Unplaced::CapabilityUnminted {
            detail: "this box cannot resolve where its control token map lives".into(),
        });
    };
    let token = store
        .mint(&session.session_id, project_id, slug, name)
        .map_err(|e| Unplaced::CapabilityUnminted {
            detail: e.to_string(),
        })?;
    env.push((session_tokens::TOKEN_ENV.to_string(), token));
    Ok(())
}

/// tmux did not start the pane: no pane holds the capability minted for it, so
/// it is taken back rather than left in the map as proof of a pane that never
/// started.
fn unstarted(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    tokens: Option<&session_tokens::SessionTokens>,
    session: &master_api::MasterSession,
    detail: String,
) {
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
            "[master] {slug}: the capability minted for {} could NOT be withdrawn: {why}",
            session.session_id
        );
    }
    say_unplaced(
        masters,
        project_id,
        slug,
        Unplaced::PaneUnstarted { detail },
    );
}

/// A pane is up carrying this session's capability: the registry serves it,
/// nothing stands against the project, and the map entry is one a live pane
/// holds. The verdict is written `current` all the same, so an operator who
/// killed a stale pane reads the kill as having done something.
fn mark_placed(
    masters: &Arc<Masters>,
    project_id: &str,
    session: &master_api::MasterSession,
    output: Option<Option<(std::path::PathBuf, u64)>>,
) {
    remember(masters, project_id, session);
    masters.clear_unplaced(project_id);
    if let Some(output) = output {
        masters.note_placed(project_id, output);
    }
    masters.note_unwithdrawn(project_id, None);
    masters.note_capability(project_id, MasterAuthority::CURRENT);
}

/// Hand a placed pane its brief: the standing prompt, what a resumed
/// conversation carries, the stand-down it comes out of, and what its first
/// pass owes.
async fn brief_pane(
    t: &Turn<'_>,
    carry: &Carryover<'_>,
    mcp_config: Option<&std::path::Path>,
    started: bool,
) {
    let (resolved, name) = (t.resolved, t.seen.pane_name.as_str());
    let reach = runner_workspace::mcp::config::pane_reach(&resolved.repo_path, mcp_config);
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
    let standing = standing_prompt(
        &resolved.slug,
        resolved.base_branch.as_deref(),
        resolved.master_policy.as_deref(),
        &reach,
    );
    let brief = placement_brief(
        standing,
        carry
            .conversation
            .map(|conv| resumed_brief(conv, carry.inherited, started, carry.hosts)),
        carry.lifted.map(stood_up_brief),
        carry.owed,
    );
    match terminal::brief_new_pane(name, &brief).await {
        Ok(()) => {
            let carried = carry.lifted.is_some();
            carry
                .stood_down_told
                .store(carried, std::sync::atomic::Ordering::Relaxed);
        }
        // A pane that exited before its brief reached it is reported by the
        // sweep that reads it gone, with why (ISS-1343 criterion 8).
        Err(e) if recovery_ports::pane_presence(name).await == recovery::MasterPresence::Gone => {
            tracing::debug!(
                "[master] {}: {name} exited before its brief reached it ({e}); the sweep that reads it gone says why",
                resolved.slug
            );
        }
        Err(e) => tracing::warn!("[master] {}: could not brief {name}: {e}", resolved.slug),
    }
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
/// stood-down project is never placed, so it is in `reg.live` on no daemon at
/// all once one restarts.
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

    #[test]
    fn a_pane_placed_for_owed_work_is_told_what_its_first_pass_owes() {
        let owed = " 1 feedback item owes a triage (FB-1): read it.";
        let brief = placement_brief("standing\n".into(), Some("resumed\n".into()), None, owed);
        assert!(
            brief.contains("## What this first pass owes\n\n1 feedback item owes a triage (FB-1)"),
            "the placement brief names no owed item, so the pass it places triages nothing: {brief}"
        );
        assert!(brief.starts_with("standing\nresumed\n"), "{brief}");
        let quiet = placement_brief("standing\n".into(), None, None, "");
        assert_eq!(quiet, "standing\n");
    }
}
