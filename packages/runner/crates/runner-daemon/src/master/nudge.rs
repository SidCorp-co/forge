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

pub(crate) fn retry_owed(since: SinceNudge) -> bool {
    match since {
        SinceNudge::Unreported | SinceNudge::NoTurn | SinceNudge::Failed => true,
        SinceNudge::Working | SinceNudge::AwaitingPermission | SinceNudge::Ran => false,
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

/// Whether this master is owed a nudge now.
///
/// `held` is a master whose account refused its last turn for capacity. What
/// its hooks say about that turn is no evidence the pass happened: a refused
/// turn ends like one that ran, and the runs it dispatched die on the same
/// limit without reporting their end, which reads as a pass still working. So a
/// held master is asked again every refresh window whatever `since` says —
/// capacity an operator restores out of band is seen only by a turn that tries
/// (ISS-1248). The window binds it even when the work changed: every turn it is
/// sent is refused until capacity returns, and the set a held master is asked
/// over can swing every sweep while its own cut-short runs come and go.
pub(crate) fn nudge_due(
    prev: Option<Nudge>,
    digest: u64,
    now: Instant,
    since: SinceNudge,
    held: bool,
) -> bool {
    let window_passed = |last: Nudge| now.saturating_duration_since(last.at) >= NUDGE_REFRESH;
    match prev {
        None => true,
        Some(last) if held => window_passed(last),
        Some(last) if last.digest != digest => true,
        Some(last) => window_passed(last) && retry_owed(since),
    }
}

/// The capacity refusal this master's pane is sitting behind, if any.
///
/// `newest` is the newest decisive record in the conversation `conversation`
/// names. It holds the pane when it is a quota refusal and the pane's own hooks
/// contradict neither half of that reading: they name no other conversation,
/// and they report no turn begun after the refusal was written. Hooks that have
/// reported nothing veto nothing — a daemon that has just adopted a pane has
/// heard nothing from it yet, and that pane is exactly the one left parked.
pub(crate) fn held_by_limit(
    newest: Option<&master_limit::Decisive>,
    conversation: Option<&str>,
    seen: Option<&agent_activity::Activity>,
) -> Option<master_limit::Refusal> {
    let newest = newest?;
    let refusal = master_limit::quota_refusal(newest)?;
    if let Some(seen) = seen {
        if let (Some(heard), Some(read)) = (seen.conversation.as_deref(), conversation) {
            if heard != read {
                return None;
            }
        }
        let refused_at_ms = newest.at * 1000 + i64::from(newest.millis);
        if seen.turn_started_at.is_some_and(|t| t > refused_at_ms) {
            return None;
        }
    }
    Some(refusal.clone())
}

/// Whether this master is a candidate for a nudge at all this sweep.
///
/// A pass the account refused is one the master still owes itself, and the
/// runs that pass dispatched hold their issues out of the admissible set while
/// they stand — so an empty set is no reason to leave a refused master unasked.
pub(crate) fn asked_this_sweep(
    admissible: &[AdmissibleIssue],
    inbox: &[UnansweredDocument],
    held: Option<&master_limit::Refusal>,
) -> bool {
    !admissible.is_empty() || !inbox.is_empty() || held.is_some()
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
    owed
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
                    "[master] {slug}: cannot read which feedback items owe a triage ({why}) — this pass is decided without them, and high or critical feedback is not triaged until the read succeeds"
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
    pub(crate) async fn open(&self, ledger: &mut Option<Ledger>) {
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
        };
        let process = master_pass::this_process();
        let activity = self.shared.activity;
        master_pass::open_for_nudge(self.client, masters, activity, led, process, &nudged).await;
    }
}

/// Paste one nudge into this project's master. `held` is the capacity refusal
/// the pane is parked behind, when that is why it is being asked; the nudge is
/// the same line either way, and it submits straight through Claude Code's
/// armed wait-for-reset (captured 2026-09-24: `Usage limit reached again after
/// you continued`), so no key is sent ahead of it.
pub(crate) async fn nudge_master(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    held: Option<&master_limit::Refusal>,
    inbox: &[UnansweredDocument],
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    match held {
        Some(refusal) => tracing::warn!("{}", limit_reask_line(slug, &name, refusal)),
        None if inbox.is_empty() => {
            tracing::info!("[master] {slug}: admissible work — nudging {name}")
        }
        None => tracing::info!(
            "[master] {slug}: {} item(s) owed from the channel, issue threads, requirements or feedback — nudging {name}",
            inbox.len()
        ),
    }
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
    fn untriaged_feedback_alone_owes_the_master_a_pass_that_names_it() {
        let owed = [UnansweredDocument {
            id: "f2".into(),
            number: Some("FB-2".into()),
            r#type: Some(FEEDBACK_TRIAGE_TYPE.into()),
            from: None,
            overdue: false,
        }];
        assert!(asked_this_sweep(&[], &owed, None));
        assert!(nudge(&owed).contains("feedback item owes a triage (FB-2)"));
        assert!(!asked_this_sweep(&[], &[], None));
    }
}
