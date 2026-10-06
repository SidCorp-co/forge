use super::*;

/// One nudge, and the evidence a later sweep judges it by.
#[derive(Debug, Clone)]
pub(crate) struct Nudge {
    /// Core's digest of the work the nudge was about, echoed back to it.
    pub(crate) digest: String,
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

/// Paste the line core composed into this project's master, saying core's
/// reason for it. A pane parked behind its account limit is asked with the
/// same line, which submits straight through Claude Code's armed
/// wait-for-reset (captured 2026-09-24: `Usage limit reached again after you
/// continued`), so no key is sent ahead of it.
pub(crate) async fn nudge_master(
    masters: &Arc<Masters>,
    project_id: &str,
    slug: &str,
    because: &str,
    line: &str,
) {
    let Some((_, name)) = masters.get(project_id) else {
        return;
    };
    tracing::info!("[master] {slug}: nudging {name}: {because}");
    if let Err(e) = terminal::send_line(&name, line).await {
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

    /// FB-82, dev 2026-10-06: forge-master-forge was resumed at 14:51:43 and
    /// handed its brief, and the same sweep claimed a nudge it never typed. The
    /// brief's turn ended at 14:55:16; its pass stood open past 15:56 and held
    /// six newly admitted issues' nudge behind it. Whether the next nudge is
    /// owed once it closes is core's (`masters/verdict.ts:nudgeDue`), and so is
    /// whether it closed (`masters/pass-end.ts:passEnd`).
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
        let heard = master_pass::Heard {
            live_session: Some("s"),
            seen: Some(&stopped),
            written_ms: None,
        };
        let facts = master_pass::pass_facts(
            &row,
            "me",
            heard,
            (T0 + 209) * 1000,
            Vec::new(),
            &master_pass::TurnRecord::default(),
        );
        let hooks = facts.hooks.expect("the pane's hooks were not reported");
        assert_eq!(
            hooks.turns_since_open, 1,
            "a nudge that was never typed moved the pass past the brief's turn, so the pane's Stop reports no turn for core to close it on"
        );
        assert!(hooks
            .turn_began_ago_ms
            .is_some_and(|b| b <= facts.opened_ago_ms));
        assert_eq!(hooks.doing, "idle");
    }
}
