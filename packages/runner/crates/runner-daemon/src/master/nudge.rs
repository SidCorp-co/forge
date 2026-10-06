use super::*;

/// One nudge, and the evidence a later sweep judges it by.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Nudge {
    pub(crate) digest: u64,
    pub(crate) at: Instant,
    /// The master's submitted-prompt count at the moment it was nudged, or `None`
    /// where the session had never reported to `agent_activity` at all. A later
    /// count strictly above this one is the proof that a turn BEGAN after the
    /// nudge, which is the only thing that makes the nudge answered.
    pub(crate) prompts: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SinceNudge {
    Unreported,
    /// Not one prompt submitted since the nudge: it is sitting in a composer, or
    /// the pane never ran it.
    NoTurn,
    /// A turn began after the nudge and is still running, or a child of it is.
    Working,
    /// A turn began after the nudge and stopped on a question a human owes.
    AwaitingPermission,
    /// A turn began after the nudge and ended on an API or model error.
    Failed,
    /// A turn began after the nudge and ended.
    Ran,
}

/// Read the evidence for one master, off what that session reported.
pub(crate) fn since_nudge(
    seen: Option<&agent_activity::Activity>,
    sent_at: Option<u64>,
) -> SinceNudge {
    let (Some(now), Some(then)) = (seen, sent_at) else {
        return SinceNudge::Unreported;
    };
    if now.prompts <= then {
        return SinceNudge::NoTurn;
    }
    match now.doing() {
        // A master's children are its dispatched runs, and the next nudge's own
        // prompt clears any whose end was lost, so for a master a lead that
        // ended over them is still work in flight.
        agent_activity::Doing::Working | agent_activity::Doing::AwaitingChildren => {
            SinceNudge::Working
        }
        agent_activity::Doing::AwaitingPermission => SinceNudge::AwaitingPermission,
        agent_activity::Doing::Idle => {
            if now.turn_ended_failed {
                SinceNudge::Failed
            } else {
                SinceNudge::Ran
            }
        }
    }
}

pub(crate) fn work_digest(admissible: &[AdmissibleIssue]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut lines: Vec<String> = Vec::with_capacity(admissible.len());
    for a in admissible {
        let mut rels: Vec<String> = a
            .relations
            .iter()
            .filter(|r| r.kind == DISPATCH_GATING_KIND)
            .map(|r| {
                format!(
                    "{}|{}",
                    r.depends_on_key.as_deref().unwrap_or(""),
                    r.blocker_status.as_deref().unwrap_or(""),
                )
            })
            .collect();
        rels.sort_unstable();
        lines.push(format!(
            "issue:{}|{}|{}",
            a.issue_id,
            a.status,
            rels.join(";")
        ));
    }
    lines.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for line in lines {
        line.hash(&mut h);
    }
    h.finish()
}

pub(crate) fn nudge(inbox: &[UnansweredDocument]) -> String {
    format!(
        "Pass. Hand it to the dispatch skill, and say what you dispatched and why you did not dispatch the rest.{}",
        master_inbox::inbox_line(inbox)
    )
}

/// What this project's channel and issue threads owe, as core answers them this sweep.
///
/// Each read that fails is said once per cause and counts as nothing owed for
/// this pass only: the issues the sweep already read still decide it, and the
/// next sweep reads again. A failure is never cached as an empty inbox, and one
/// read failing never hides what the other found.
pub(crate) async fn read_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    let mut owed = read_channel_inbox(client, masters, project_id, slug).await;
    owed.extend(read_comment_inbox(client, masters, project_id, slug).await);
    owed.extend(read_requirement_inbox(client, masters, project_id, slug).await);
    owed.extend(read_feedback_inbox(client, masters, project_id, slug).await);
    owed.extend(owed_or_said(
        masters,
        slug,
        &format!("{project_id}#designs"),
        "design",
        "which returned designs owe a revision",
        "a returned design is not revised",
        design_inbox::owed(client, project_id).await,
    ));
    owed.extend(owed_or_said(
        masters,
        slug,
        &format!("{project_id}#returned-requirements"),
        "returned requirement",
        "which returned requirement revisions owe a revise",
        "a returned revision is not revised",
        requirement_inbox::returned(client, project_id).await,
    ));
    owed
}

/// What one inbox read answered, or nothing for this pass with its failure said
/// once per cause and its recovery once, keyed by `key`.
fn owed_or_said(
    masters: &Arc<Masters>,
    slug: &str,
    key: &str,
    inbox: &str,
    what: &str,
    until: &str,
    read: runner_platform::error::Result<Vec<UnansweredDocument>>,
) -> Vec<UnansweredDocument> {
    match read {
        Ok(owed) => {
            if masters.note_inbox_read(key, None) {
                tracing::info!("[master] {slug}: the {inbox} inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(key, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read {what} ({why}) — this pass is decided without them, and {until} until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

/// Which feedback items owe this project's master a triage, as core answers it.
pub(crate) async fn read_feedback_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    let key = format!("{project_id}#feedback");
    match feedback_inbox::owed(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(&key, None) {
                tracing::info!("[master] {slug}: the feedback inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(&key, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read which feedback items owe a triage ({why}) — this pass is decided without them, and no filed feedback is triaged until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

/// Which agreed requirements owe this project's master a breakdown, due or overdue.
pub(crate) async fn read_requirement_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    let key = format!("{project_id}#requirements");
    match requirement_inbox::owed(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(&key, None) {
                tracing::info!("[master] {slug}: the requirement inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(&key, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read which agreed requirements owe a breakdown ({why}) — this pass is decided without them, and an agreed requirement is not broken down until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

/// What a person is owed a reply to on this project's issues, at any status.
pub(crate) async fn read_comment_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    // Keyed apart from the channel read, so each failure is said once and each recovery once.
    let key = format!("{project_id}#comments");
    match comment_inbox::unanswered(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(&key, None) {
                tracing::info!("[master] {slug}: the comment inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(&key, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read which issue comments a person is owed a reply to ({why}) — this pass is decided without them, and a comment waiting for a reply is not seen until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

pub(crate) async fn read_channel_inbox(
    client: &CoreClient,
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
) -> Vec<UnansweredDocument> {
    match channel_inbox::unanswered(client, project_id).await {
        Ok(owed) => {
            if masters.note_inbox_read(project_id, None) {
                tracing::info!("[master] {slug}: the channel inbox reads again");
            }
            owed
        }
        Err(e) => {
            let why = e.to_string();
            if masters.note_inbox_read(project_id, Some(why.clone())) {
                tracing::warn!(
                    "[master] {slug}: cannot read what the ecosystem channel owes ({why}) — this pass is decided by its issues alone, and a document waiting for a reply is not seen until the read succeeds"
                );
            }
            Vec::new()
        }
    }
}

pub(crate) struct NudgePass<'a> {
    pub(crate) client: &'a CoreClient,
    pub(crate) shared: SweepShared<'a>,
    pub(crate) project_id: &'a str,
    pub(crate) issue_key: Option<&'a str>,
}

impl NudgePass<'_> {
    /// `typed` is whether the claimed nudge is typed into the pane, or is the
    /// brief a pane placed this sweep was already handed.
    pub(crate) async fn open(&self, ledger: &mut Option<Ledger>, typed: bool) {
        let masters = self.shared.masters;
        let (Some(led), Some((session_id, _))) = (ledger.as_mut(), masters.get(self.project_id))
        else {
            return;
        };
        let nudged = master_pass::Nudged {
            project_id: self.project_id,
            session_id: &session_id,
            issue_key: self.issue_key,
            turns: self.shared.activity.get(&session_id).map(|a| a.turns),
            typed,
        };
        let process = master_pass::this_process();
        let activity = self.shared.activity;
        master_pass::open_for_nudge(self.client, masters, activity, led, process, &nudged).await;
    }
}

/// Paste one nudge into this project's master, saying core's reason for it.
/// A pane parked behind its account limit is asked with the same line, which
/// submits straight through Claude Code's armed wait-for-reset (captured
/// 2026-09-24: `Usage limit reached again after you continued`), so no key is
/// sent ahead of it.
pub(crate) async fn nudge_master(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    because: &str,
    inbox: &[UnansweredDocument],
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: nudging {name}: {because}");
    if let Err(e) = terminal::send_line(&name, &nudge(inbox)).await {
        // A pane that exited before the nudge reached it is reported by the
        // sweep that reads it gone, with why; a warning here too would be the
        // second line per placement ISS-1343 counted on sid-desk.
        if recovery_ports::pane_presence(&name).await == recovery::MasterPresence::Gone {
            tracing::debug!(
                "[master] {slug}: {name} exited before the nudge reached it ({e}); the sweep that reads it gone says why"
            );
        } else {
            tracing::warn!("[master] {slug}: could not nudge {name}: {e}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_transport::feedback_inbox::FEEDBACK_TRIAGE_TYPE;

    #[test]
    fn a_nudge_for_untriaged_feedback_names_it() {
        let owed = [UnansweredDocument {
            id: "f2".into(),
            number: Some("FB-2".into()),
            r#type: Some(FEEDBACK_TRIAGE_TYPE.into()),
            from: None,
            overdue: false,
        }];
        assert!(nudge(&owed).contains("feedback item owes a triage (FB-2)"));
    }

    /// FB-82, dev 2026-10-06: forge-master-forge was resumed at 14:51:43 and
    /// handed its brief, and the same sweep claimed a nudge it never typed. The
    /// brief's turn ended at 14:55:16; its pass stood open past 15:56 and held
    /// six newly admitted issues' nudge behind it. Whether the next nudge is
    /// owed once it closes is core's (`masters/verdict.ts:nudgeDue`).
    #[test]
    fn a_resumed_panes_brief_turn_closes_its_pass() {
        use runner_core::agent_activity::{Activities, Event, Report};
        use runner_core::ledger::MasterPass;
        const T0: i64 = 1_791_298_308;
        let a = Activities::new();
        let hook = |event, at_ms| {
            a.record(
                "s",
                Report {
                    event,
                    at: at_ms,
                    subject: None,
                    conversation: Some("6d1fb615"),
                    transcript: None,
                },
            )
        };
        let briefed = hook(Event::PromptSubmitted, T0 * 1000 + 349);
        let turn = master_pass::unprompted_turn(false, Some(&briefed), None)
            .expect("the brief's turn got no pass");
        let mut row = MasterPass {
            project_id: "p".into(),
            session_id: "s".into(),
            pass_id: "d6a0f8c9".into(),
            verb: master_pass::NUDGE_VERB.into(),
            issue_key: None,
            opened_at: turn.started_at,
            opened_by: "me".into(),
            turns_at_nudge: Some(turn.turns_before),
        };
        let claimed = master_pass::Nudged {
            project_id: "p",
            session_id: "s",
            issue_key: None,
            turns: Some(briefed.turns),
            typed: false,
        };
        if let Some(turns) = master_pass::start_after_nudge(&claimed) {
            row.turns_at_nudge = turns;
        }
        let stopped = hook(Event::Stopped, (T0 + 208) * 1000);
        assert_eq!(
            master_pass::judge(&row, "me", Some("s"), Some(&stopped), 0, None),
            master_pass::Judged::TurnEnded,
            "a nudge that was never typed moved the pass past the brief's turn, so the pane's Stop closed nothing"
        );
    }
}
