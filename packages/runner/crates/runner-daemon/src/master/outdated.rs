//! A resident master judged against the build and plugins this box would
//! place now, and replaced once it holds nothing (ISS-1379).

use super::*;

/// Judge the project's resident pane against what this box would place now,
/// and act on an outdated one: end it where it holds no run and no turn and
/// there is work for a successor, which the placement after this call then
/// starts resuming the same conversation; leave it running otherwise, and say
/// once why (ISS-1379). Answers whether an outdated pane was left running, so
/// the sweep does not nudge it.
#[expect(
    clippy::too_many_arguments,
    reason = "each argument is one daemon registry the verdict reads; a struct carrying them would only rename the list"
)]
pub(crate) async fn outdated_resident(
    client: &CoreClient,
    masters: &Arc<Masters>,
    ledger: &mut Option<Ledger>,
    tokens: Option<&session_tokens::SessionTokens>,
    activity: &agent_activity::Activities,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
    project_id: &str,
    placement: Placement,
) -> bool {
    let slug = &resolved.slug;
    if !terminal::alive(pane_name).await {
        return false;
    }
    let Some(found) = ledger.as_ref().and_then(|led| {
        judge_resident(
            led, masters, activity, pane_name, resolved, project_id, placement, None,
        )
    }) else {
        return false;
    };
    let Outdated { why, act, session } = found;
    match act {
        OutdatedAct::Replace => {
            if let Err(e) = terminal::kill(pane_name).await {
                if masters.note_outdated(project_id, Some(format!("unkillable: {why}"))) {
                    tracing::error!(
                        "[master] {slug}: {pane_name} is outdated ({why}) and holds no run and no turn, and tmux would not end it: {e}. It is left running and not nudged; `forge-runner master kill {slug}` ends it, and the next sweep places its successor"
                    );
                }
                return true;
            }
            tracing::info!(
                "[master] {slug}: {pane_name} is outdated ({why}) and holds no run and no turn, so it is ended and placed again this sweep, resuming its conversation under the build and plugins this box holds now"
            );
            match session.as_deref() {
                Some(session) => {
                    end_master(
                        client,
                        masters,
                        tokens,
                        project_id,
                        session,
                        "outdated: replaced by a pane under the build this box runs",
                    )
                    .await
                }
                None => {
                    masters.forget(project_id);
                }
            }
            masters.note_outdated(project_id, None);
            false
        }
        OutdatedAct::Leave(reason) => {
            if masters.note_outdated(project_id, Some(format!("{why} / {reason}"))) {
                tracing::warn!(
                    "[master] {slug}: {pane_name} is outdated ({why}) and is left running, not nudged: {reason}. It is replaced on the first sweep that finds it holding no run, at its prompt, with work for its successor; `forge-runner master kill {slug}` replaces it now, ending whatever it is doing"
                );
            }
            true
        }
    }
}

/// A resident pane judged outdated: why, what to do about it, and the session
/// it answers to.
pub(crate) struct Outdated {
    why: String,
    act: OutdatedAct,
    session: Option<String>,
}

/// The judgement [`outdated_resident`] acts on, read off the ledger without
/// awaiting anything. `None` for a pane that is current or cannot be judged;
/// the ledger's `outdated` column is written to match either way.
/// `home` is where the successor's `--resume` would look for the transcript,
/// `None` for this user's own, which is where it looks in production.
#[expect(
    clippy::too_many_arguments,
    reason = "each argument is one daemon registry the verdict reads; a struct carrying them would only rename the list"
)]
pub(crate) fn judge_resident(
    led: &Ledger,
    masters: &Masters,
    activity: &agent_activity::Activities,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
    project_id: &str,
    placement: Placement,
    home: Option<&std::path::Path>,
) -> Option<Outdated> {
    let slug = &resolved.slug;
    let row = match led.master_for_project(project_id) {
        Ok(row) => row,
        Err(e) => {
            tracing::warn!(
                "[master] {slug}: cannot read {pane_name}'s placement back from the ledger ({e}), so whether it is outdated is not judged this sweep"
            );
            return None;
        }
    };
    let now = master_build::Standing::this_box(&resolved.repo_path);
    let why = match master_build::judge(row.as_ref(), &now) {
        Judged::Current => {
            if row.as_ref().is_some_and(|r| r.outdated.is_some()) {
                let _ = led.note_master_outdated(project_id, None);
            }
            masters.note_outdated(project_id, None);
            return None;
        }
        Judged::Outdated(why) => why,
    };
    if row.as_ref().and_then(|r| r.outdated.as_deref()) != Some(why.as_str()) {
        if let Err(e) = led.note_master_outdated(project_id, Some(&why)) {
            tracing::warn!(
                "[master] {slug}: {pane_name} is outdated ({why}) and the verdict could not be written for `forge-runner top`: {e}"
            );
        }
    }
    let served = masters.get(project_id).map(|(session, _)| session);
    let recorded = row.as_ref().and_then(|r| r.session_id.clone());
    let holding = match (served.as_deref(), recorded.as_deref()) {
        (Some(served), Some(recorded)) if served != recorded => Holding::Unknown(format!(
            "its ledger row names session {recorded} and this box serves it as {served}, so the runs either one names are not all it holds; the sweep writes the row before it judges again"
        )),
        _ => master_exit::holding(led, row.as_ref())
            .unwrap_or_else(|e| {
                Holding::Unknown(format!(
                    "the ledger could not be read ({e}), so which runs it holds is not known"
                ))
            }),
    };
    let session = served.or(recorded);
    let seen = session.as_deref().and_then(|s| activity.get(s));
    let transcript = seen
        .as_ref()
        .and_then(|a| a.transcript.clone())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            row.as_ref()
                .and_then(|r| r.conversation_id.as_deref())
                .and_then(|c| transcript_at(home, &resolved.repo_path, c))
        });
    let turn = turn_of(seen.as_ref(), transcript.as_deref());
    Some(Outdated {
        why,
        act: outdated_act(
            placement,
            &holding,
            &turn,
            unresumable(
                home,
                &resolved.repo_path,
                row.as_ref().and_then(|r| r.conversation_id.as_deref()),
            )
            .as_deref(),
        ),
        session,
    })
}

/// Whether a nudge this sweep claimed is typed into the pane.
///
/// A pane this sweep placed was handed its brief moments before, and the brief
/// is its nudge for this work: it is claimed as one, so the next nudge is
/// judged against it, and is not typed. Typed as well, the nudge reached the
/// composer some tens of milliseconds after the brief's Enter, before Claude
/// Code had taken the pasted brief in, read the brief as unsent text and was
/// refused — four of five panes re-placed on 2026-10-01, each of whose
/// transcripts records the brief submitted just after the refusal.
pub(crate) fn types_nudge(pane: PaneState, claimed: bool) -> bool {
    claimed && !matches!(pane, PaneState::ColdStarted | PaneState::Resumed)
}

/// Where a lead's turn stands, as far as this box can tell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TurnRead {
    /// Affirmatively over: its hooks said so, or, unheard, its transcript did.
    Ended,
    /// Not over, and what says so.
    InTurn(&'static str),
    /// Nothing could be read.
    Unknown,
}

/// A lead's turn, from its hooks where this daemon has heard them and from its
/// transcript where it has not — every pane an update handed over is unheard
/// until its next hook.
pub(crate) fn turn_of(
    seen: Option<&agent_activity::Activity>,
    transcript: Option<&std::path::Path>,
) -> TurnRead {
    use agent_activity::Doing;
    match seen.map(agent_activity::Activity::doing) {
        Some(Doing::Idle) => TurnRead::Ended,
        Some(Doing::Working) => TurnRead::InTurn("its hooks say a turn is running"),
        Some(Doing::AwaitingPermission) => TurnRead::InTurn("it is stopped on a permission prompt"),
        Some(Doing::AwaitingChildren) => {
            TurnRead::InTurn("a subagent it started has not reported its end")
        }
        None => match transcript.and_then(runner_core::transcript_age::lead_turn_ended) {
            Some(true) => TurnRead::Ended,
            Some(false) => TurnRead::InTurn(
                "this box has not heard its hooks since it started, and its transcript's newest entry is not a turn's end",
            ),
            None => TurnRead::Unknown,
        },
    }
}

/// What a sweep does about a pane judged outdated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OutdatedAct {
    /// End it, and let this sweep's placement start its successor.
    Replace,
    /// Leave it running, for the reason named.
    Leave(String),
}

/// Replace only a pane that holds nothing, has affirmatively ended its turn,
/// has work waiting for its successor, and has a conversation its successor
/// can resume. Each other case leaves it, and every reason that holds is
/// named, not only the first: a pane left for having no admissible work that
/// also holds four runs is left for both (judge r2's wording note).
pub(crate) fn outdated_act(
    placement: Placement,
    holding: &Holding,
    turn: &TurnRead,
    unresumable: Option<&str>,
) -> OutdatedAct {
    let mut left: Vec<String> = Vec::new();
    if placement == Placement::AdoptOnly {
        left.push(
            "its project has no admissible work, so a successor would have nothing to take up"
                .into(),
        );
    }
    match holding {
        Holding::Nothing => {}
        Holding::These(runs) => {
            let names = runs
                .iter()
                .map(|r| format!("{} ({})", r.run_id, r.issues.join(", ")))
                .collect::<Vec<_>>()
                .join("; ");
            left.push(format!("it holds {} open run(s): {names}", runs.len()));
        }
        // Each one already says that which runs it holds is not known, and
        // why; a prefix saying so again read the sentence twice.
        Holding::Unknown(why) => left.push(why.clone()),
    }
    match turn {
        TurnRead::Ended => {}
        TurnRead::InTurn(what) => left.push((*what).to_string()),
        TurnRead::Unknown => left
            .push("neither its hooks nor its transcript can say whether its turn is over".into()),
    }
    if let Some(why) = unresumable {
        left.push(why.to_string());
    }
    if left.is_empty() {
        OutdatedAct::Replace
    } else {
        OutdatedAct::Leave(left.join("; "))
    }
}

/// Record that this sweep placed `pane_name` under this box's build and
/// plugins, which is what a later build judges it outdated against.
pub(crate) fn note_placement(
    led: &Ledger,
    project_id: &str,
    pane_name: &str,
    resolved: &crate::dispatch::Resolved,
) {
    let now = master_build::Standing::this_box(&resolved.repo_path);
    let boot = runner_core::inflight::boot_identity().unwrap_or_default();
    if let Err(e) = led.note_master_placed(
        project_id,
        pane_name,
        &boot,
        &now.build,
        now.plugins.as_deref(),
    ) {
        tracing::warn!(
            "[master] {}: {pane_name} was placed and the build it was placed under could not be recorded ({e}); the next build will read it as outdated",
            resolved.slug
        );
    }
}
