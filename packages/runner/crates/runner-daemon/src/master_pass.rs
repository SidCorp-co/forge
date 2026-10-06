// one pass is one master turn, from the nudge that asks for it to the hook that reports the turn
// ended (design agent-run-standing rev 1, region master; ISS-107). The open pass is kept in the ledger so a
// daemon restart closes exactly the pass it opened, by the id core answered, and never another one.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use crate::master::Masters;
use runner_core::agent_activity::{Activities, Activity, Doing};
use runner_core::ledger::{Ledger, MasterPass};
use runner_platform::clock::now_secs;
use runner_transport::master::{self as master_api, PassError};
use runner_transport::CoreClient;

pub(crate) const NUDGE_VERB: &str = "dispatch";

/// A pass the runner opened before typing its nudge.
pub(crate) const BY_NUDGE: &str = "nudge";

/// A pass the runner opened for a turn it saw start with no nudge of its own:
/// a person typing at the pane, or the master taking up a task notification.
pub(crate) const UNPROMPTED: &str = "unprompted";

pub(crate) const TICK: Duration = Duration::from_secs(5);

pub(crate) const ADOPTED_FROM_CORE: &str = "core";

/// How long an open pass stands with nothing from its master — no hook and no
/// transcript write, children's included — before it is closed as abandoned.
/// The same 600s core's `SESSION_SILENCE_TIMEOUT_S` calls a master silent after.
pub(crate) const QUIET_BOUND_MS: i64 = 600_000;

static THIS_PROCESS: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub(crate) fn this_process() -> &'static str {
    THIS_PROCESS.as_str()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Judged {
    Open,
    TurnEnded,
    Abandoned(Abandoned),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Abandoned {
    Restarted,
    Orphaned,
    SessionGone,
    Quiet,
}

impl Abandoned {
    fn why(self) -> &'static str {
        match self {
            Self::Restarted => "opened by the daemon process before this one, so the hook counts its turn was measured against are gone and the turn can no longer be judged; closed as abandoned at the restart",
            Self::Orphaned => "core held it open with no record on this box (an open whose answer never arrived); closed as abandoned",
            Self::SessionGone => "its master session is no longer the one this box serves the project under; closed with the session",
            Self::Quiet => "abandoned: its master reported no hook and wrote no transcript for the quiet bound, so its turn can no longer be told from a pane idle at its prompt; it stops holding nudges",
        }
    }
}

/// Whether the turn `pass` covers has ended: a turn counted after the pass was
/// asked for, begun no earlier than the pass opened, and over. A task
/// notification turn that was already running when a nudge was typed ends
/// before the nudge's own prompt is taken, and is not the nudged turn.
pub(crate) fn turn_ended(seen: Option<&Activity>, pass: &MasterPass) -> bool {
    let Some(seen) = seen else {
        return false;
    };
    seen.turns > pass.turns_at_nudge.unwrap_or(0)
        && seen
            .turn_began_at
            .is_some_and(|began| began >= pass.opened_at.saturating_mul(1000))
        && matches!(seen.doing(), Doing::Idle | Doing::AwaitingChildren)
}

/// `now_ms` is the clock this judgement is made at, and `written_ms` the last
/// write to the conversation `seen` names, children's included.
pub(crate) fn judge(
    pass: &MasterPass,
    process: &str,
    live_session: Option<&str>,
    seen: Option<&Activity>,
    now_ms: i64,
    written_ms: Option<i64>,
) -> Judged {
    if pass.opened_by == ADOPTED_FROM_CORE {
        return Judged::Abandoned(Abandoned::Orphaned);
    }
    if pass.opened_by != process {
        return Judged::Abandoned(Abandoned::Restarted);
    }
    if live_session != Some(pass.session_id.as_str()) {
        return Judged::Abandoned(Abandoned::SessionGone);
    }
    if turn_ended(seen, pass) {
        return Judged::TurnEnded;
    }
    if quiet_past_bound(pass, seen, now_ms, written_ms) {
        return Judged::Abandoned(Abandoned::Quiet);
    }
    Judged::Open
}

/// Whether nothing has come from the pass's master — no hook, no transcript
/// write, nothing since the pass opened — for [`QUIET_BOUND_MS`]. A pane
/// stopped on a question a person owes is waiting, not quiet: the nudge the
/// pass would stop holding would be typed into that dialog.
fn quiet_past_bound(
    pass: &MasterPass,
    seen: Option<&Activity>,
    now_ms: i64,
    written_ms: Option<i64>,
) -> bool {
    if seen.is_some_and(|s| s.doing() == Doing::AwaitingPermission) {
        return false;
    }
    let last_life = [
        Some(pass.opened_at.saturating_mul(1000)),
        seen.map(|s| s.last_event_at),
        written_ms,
    ]
    .into_iter()
    .flatten()
    .max()
    .unwrap_or(i64::MAX);
    now_ms.saturating_sub(last_life) >= QUIET_BOUND_MS
}

pub(crate) fn nudged_issue(
    admissible: &[runner_transport::admissible::AdmissibleIssue],
    inbox_empty: bool,
) -> Option<&str> {
    match admissible {
        [only] if inbox_empty => only.issue_key.as_deref(),
        _ => None,
    }
}

// contract -> packages/core/src/masters/rules.ts — passAlreadyOpenRefusal names the open pass as
// `id <uuid>` in its detail, and that is the only place core says which pass it holds open
pub(crate) fn named_pass_id(detail: &str) -> Option<String> {
    let mut words = detail.split_whitespace();
    while let Some(word) = words.next() {
        if word != "id" {
            continue;
        }
        let candidate = words
            .next()?
            .trim_end_matches(|c: char| !c.is_ascii_hexdigit());
        if uuid::Uuid::parse_str(candidate).is_ok() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// What the conversation's own records say about the turn a pass covers.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TurnRecord {
    /// The account answered at least once at or after the pass opened.
    pub worked: bool,
    /// The newest refusal the account wrote at or after the pass opened.
    pub refusal: Option<(&'static str, String)>,
}

/// Every decisive record in `tail` dated at or after `opened_at`, folded into
/// whether the turn ran and the newest refusal it met. Each line is read as a
/// tail of its own, so a refusal written AFTER real work is seen beside it
/// rather than in its place.
pub(crate) fn turn_since(tail: &str, opened_at: i64, now_unix: i64) -> TurnRecord {
    let mut turn = TurnRecord::default();
    for line in tail.lines().rev() {
        let Some(d) = crate::master_limit::newest_record(line, now_unix) else {
            continue;
        };
        if d.at < opened_at {
            continue;
        }
        match d.verdict {
            crate::master_limit::Verdict::Worked => turn.worked = true,
            crate::master_limit::Verdict::Refused(r) if turn.refusal.is_none() => {
                turn.refusal = Some((r.reason.wire(), r.detail));
            }
            _ => {}
        }
    }
    turn
}

/// The refusal a pass closes with: only one inside which nothing ran — no
/// answer from the account and no run declared in the ledger. A refusal met
/// after work is the end of a turn that ran, and the pass closes as one.
pub(crate) fn refused_pass(
    turn: &TurnRecord,
    dispatched: &[String],
) -> Option<(&'static str, String)> {
    if turn.worked || !dispatched.is_empty() {
        return None;
    }
    turn.refusal.clone()
}

/// When the conversation `seen` names was last written, children's included.
pub(crate) fn written_ms(seen: Option<&Activity>) -> Option<i64> {
    let path = seen.and_then(|s| s.transcript.as_deref())?;
    runner_core::transcript_age::last_written(std::path::Path::new(path))
}

fn turn_of(seen: Option<&Activity>, opened_at: i64) -> TurnRecord {
    let Some(path) = seen.and_then(|s| s.transcript.as_deref()) else {
        return TurnRecord::default();
    };
    let Some(tail) = crate::master_limit::read_tail(std::path::Path::new(path)) else {
        return TurnRecord::default();
    };
    turn_since(&tail, opened_at, crate::master_limit::now_unix())
}

async fn settle(
    client: &CoreClient,
    led: &mut Ledger,
    pass: &MasterPass,
    why: &str,
    turn: &TurnRecord,
) -> bool {
    let dispatched = match led.issues_declared_since(&pass.session_id, pass.opened_at) {
        Ok(keys) => keys,
        Err(e) => {
            tracing::warn!(
                "[master] {}: cannot read which runs pass {} declared ({e}) — it is not closed this tick, so its dispatched list is not sent empty",
                pass.project_id,
                pass.pass_id
            );
            return false;
        }
    };
    let refused = refused_pass(turn, &dispatched);
    let refused_ref = refused.as_ref().map(|(r, d)| (*r, d.as_str()));
    let gone = match master_api::close_pass(
        client,
        &pass.session_id,
        &pass.pass_id,
        &dispatched,
        refused_ref,
    )
    .await
    {
        Ok(_) => {
            match refused_ref {
                Some((reason, detail)) => tracing::warn!(
                    "[master] {}: pass {} ({}) closed refused ({reason}: {detail}) — its turn did not run",
                    pass.project_id,
                    pass.pass_id,
                    pass.verb
                ),
                None => match &turn.refusal {
                    Some((reason, detail)) => tracing::warn!(
                        "[master] {}: pass {} ({}) closed, {} issue(s) dispatched — its turn ran and then met a refusal ({reason}: {detail}); {why}",
                        pass.project_id,
                        pass.pass_id,
                        pass.verb,
                        dispatched.len()
                    ),
                    None => tracing::info!(
                        "[master] {}: pass {} ({}) closed, {} issue(s) dispatched — {why}",
                        pass.project_id,
                        pass.pass_id,
                        pass.verb,
                        dispatched.len()
                    ),
                },
            }
            true
        }
        Err(PassError::Refused { code, detail }) => {
            tracing::warn!(
                "[master] {}: closing pass {} was refused {code}: {detail} — not retried, and this box keeps no record of the pass from here",
                pass.project_id,
                pass.pass_id
            );
            true
        }
        Err(PassError::Unreached(e)) => {
            tracing::warn!(
                "[master] {}: could not close pass {}: {e} — kept, and the next tick closes the same pass by its id",
                pass.project_id,
                pass.pass_id
            );
            false
        }
    };
    if gone {
        if let Err(e) = led.closed_master_pass(&pass.pass_id) {
            tracing::error!(
                "[master] {}: pass {} is settled at core and this box could not drop its record ({e}); the next tick closes it again and core answers MASTER_PASS_NOT_OPEN",
                pass.project_id,
                pass.pass_id
            );
        }
    }
    gone
}

pub(crate) async fn reconcile(
    client: &CoreClient,
    masters: &Arc<Masters>,
    activity: &Activities,
    led: &mut Ledger,
    process: &str,
    only: Option<&str>,
) {
    // Unprompted passes open first, so a turn that began and ended between two
    // ticks is opened and closed by this same reconcile rather than missed.
    for (project_id, session_id) in masters.live_sessions() {
        if only.is_some_and(|id| id != project_id) {
            continue;
        }
        open_unprompted(
            client,
            masters,
            activity,
            led,
            process,
            &project_id,
            &session_id,
        )
        .await;
    }
    let passes = match led.master_passes() {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!("[master] cannot read the open master passes from the ledger: {e}");
            return;
        }
    };
    for pass in passes
        .iter()
        .filter(|p| only.is_none_or(|id| p.project_id == id))
    {
        let live = masters.live_for_project(&pass.project_id).map(|(s, _)| s);
        let seen = activity.get(&pass.session_id);
        let written = written_ms(seen.as_ref());
        let now = runner_core::agent_activity::now_ms();
        let settled = match judge(pass, process, live.as_deref(), seen.as_ref(), now, written) {
            Judged::Open => false,
            Judged::TurnEnded => {
                let turn = turn_of(seen.as_ref(), pass.opened_at);
                settle(client, led, pass, "the turn it covers has ended", &turn).await
            }
            Judged::Abandoned(a) => {
                if a == Abandoned::Quiet {
                    tracing::warn!(
                        "[master] {}: pass {} ({}) abandoned — nothing from its master for {}s, so it no longer holds this project's nudges",
                        pass.project_id,
                        pass.pass_id,
                        pass.verb,
                        QUIET_BOUND_MS / 1000
                    );
                }
                settle(client, led, pass, a.why(), &TurnRecord::default()).await
            }
        };
        if settled {
            if let Some(seen) = seen.as_ref() {
                masters.note_turns_settled(&pass.project_id, &pass.session_id, seen.turns);
            }
        }
    }
}

/// An unprompted pass's start: the turn count before its turn and the unix
/// second that turn began.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct UnpromptedTurn {
    pub turns_before: u64,
    pub started_at: i64,
}

/// The start to record for an unprompted pass, where `seen` shows a turn begun
/// after the last pass settled that no open pass covers — whether its turn
/// still runs or has already ended, so a turn shorter than a tick is recorded
/// too, and whether a prompt began it or a task notification did. `None`
/// otherwise.
pub(crate) fn unprompted_turn(
    pass_open: bool,
    seen: Option<&Activity>,
    settled_at: Option<u64>,
) -> Option<UnpromptedTurn> {
    if pass_open {
        return None;
    }
    let seen = seen?;
    if seen.turns <= settled_at.unwrap_or(0) {
        return None;
    }
    // `turns` and `turn_began_at` are written together, so a count above zero
    // always carries its time.
    let began_ms = seen.turn_began_at?;
    Some(UnpromptedTurn {
        turns_before: seen.turns.saturating_sub(1),
        started_at: began_ms.div_euclid(1000),
    })
}

/// Open a pass for a turn the master started without a nudge from this box,
/// so `masters/passes` records every turn, not only the ones it asked for.
async fn open_unprompted(
    client: &CoreClient,
    masters: &Arc<Masters>,
    activity: &Activities,
    led: &mut Ledger,
    process: &str,
    project_id: &str,
    session_id: &str,
) {
    let pass_open = match led.master_pass_for(project_id) {
        Ok(open) => open.is_some(),
        Err(_) => return,
    };
    let seen = activity.get(session_id);
    let Some(turn) = unprompted_turn(
        pass_open,
        seen.as_ref(),
        masters.turns_settled(project_id, session_id),
    ) else {
        return;
    };
    match master_api::open_pass(client, session_id, NUDGE_VERB, None, UNPROMPTED).await {
        Ok(pass_id) => {
            let row = MasterPass {
                project_id: project_id.to_string(),
                session_id: session_id.to_string(),
                pass_id,
                verb: NUDGE_VERB.to_string(),
                issue_key: None,
                opened_at: turn.started_at,
                opened_by: process.to_string(),
                turns_at_nudge: Some(turn.turns_before),
            };
            if let Err(e) = led.open_master_pass(&row) {
                tracing::error!(
                    "[master] {project_id}: core opened unprompted pass {} and this box could not record it ({e}); closing it now",
                    row.pass_id
                );
                let _ = master_api::close_pass(client, session_id, &row.pass_id, &[], None).await;
                return;
            }
            tracing::info!(
                "[master] {project_id}: pass {} opened for a turn this box did not nudge (a person at the pane, or a task notification)",
                row.pass_id
            );
        }
        Err(PassError::Refused { code, detail }) => {
            // Settled as seen so the same turn is not asked about every tick.
            masters.note_turns_settled(project_id, session_id, turn.turns_before + 1);
            tracing::warn!(
                "[master] {project_id}: opening an unprompted pass was refused {code}: {detail}"
            );
        }
        Err(PassError::Unreached(e)) => tracing::warn!(
            "[master] {project_id}: could not open an unprompted pass: {e} — the next tick asks again"
        ),
    }
}

pub(crate) struct Nudged<'a> {
    pub project_id: &'a str,
    pub session_id: &'a str,
    pub issue_key: Option<&'a str>,
    pub turns: Option<u64>,
    /// Whether this nudge is typed into the pane. A pane placed this sweep is
    /// handed its brief instead, and the brief's turn is already running.
    pub typed: bool,
}

/// The turn count an open pass's start moves to for `nudged`, or `None` where
/// it stays where it is.
///
/// Only a typed nudge begins a turn after the one the pass already covers. A
/// placement's brief IS that turn: moved to the count that already includes
/// it, the pass waits for a turn nothing will start, and the pane's Stop
/// closes nothing (FB-82, dev 2026-10-06).
pub(crate) fn start_after_nudge(nudged: &Nudged<'_>) -> Option<Option<u64>> {
    nudged.typed.then_some(nudged.turns)
}

/// Move the start of the pass already open to this nudge, where the nudge
/// begins a turn after the one that pass covers.
fn move_open_pass(led: &Ledger, open: &MasterPass, nudged: &Nudged<'_>) {
    let Some(turns) = start_after_nudge(nudged) else {
        tracing::debug!(
            "[master] {}: pass {} covers the brief this pane was handed, which is this claim's nudge, so its start stays",
            nudged.project_id,
            open.pass_id
        );
        return;
    };
    if let Err(e) = led.renudge_master_pass(&open.pass_id, turns) {
        tracing::warn!(
            "[master] {}: cannot move pass {}'s start to this nudge ({e}); it closes on the turn the earlier nudge started",
            nudged.project_id,
            open.pass_id
        );
    }
    tracing::debug!(
        "[master] {}: pass {} is still open, so this nudge asks for the turn it already covers",
        nudged.project_id,
        open.pass_id
    );
}

pub(crate) async fn open_for_nudge(
    client: &CoreClient,
    masters: &Arc<Masters>,
    activity: &Activities,
    led: &mut Ledger,
    process: &str,
    nudged: &Nudged<'_>,
) {
    reconcile(
        client,
        masters,
        activity,
        led,
        process,
        Some(nudged.project_id),
    )
    .await;
    match led.master_pass_for(nudged.project_id) {
        Ok(Some(open)) => {
            move_open_pass(led, &open, nudged);
            return;
        }
        Ok(None) => {}
        Err(e) => {
            tracing::warn!(
                "[master] {}: cannot read this project's open pass from the ledger ({e}); no pass is opened, so this nudge's turn runs in none",
                nudged.project_id
            );
            return;
        }
    }
    let opened = master_api::open_pass(
        client,
        nudged.session_id,
        NUDGE_VERB,
        nudged.issue_key,
        BY_NUDGE,
    )
    .await;
    match opened {
        Ok(pass_id) => {
            let row = MasterPass {
                project_id: nudged.project_id.to_string(),
                session_id: nudged.session_id.to_string(),
                pass_id,
                verb: NUDGE_VERB.to_string(),
                issue_key: nudged.issue_key.map(str::to_string),
                opened_at: now_secs(),
                opened_by: process.to_string(),
                turns_at_nudge: nudged.turns,
            };
            if let Err(e) = led.open_master_pass(&row) {
                tracing::error!(
                    "[master] {}: core opened pass {} and this box could not record it ({e}); closing it now rather than leaving a pass open that nothing here would close",
                    row.project_id,
                    row.pass_id
                );
                if let Err(e) =
                    master_api::close_pass(client, &row.session_id, &row.pass_id, &[], None).await
                {
                    tracing::error!(
                        "[master] {}: pass {} could not be closed either: {e} — the next open is refused MASTER_PASS_ALREADY_OPEN and adopted from there",
                        row.project_id,
                        row.pass_id
                    );
                }
                return;
            }
            tracing::info!(
                "[master] {}: pass {} ({}{}) opened before the nudge",
                row.project_id,
                row.pass_id,
                row.verb,
                row.issue_key
                    .as_deref()
                    .map(|k| format!(" on {k}"))
                    .unwrap_or_default()
            );
        }
        Err(PassError::Refused { code, detail }) => {
            tracing::warn!(
                "[master] {}: opening a pass was refused {code}: {detail} — not retried; this nudge's turn runs in no pass",
                nudged.project_id
            );
            if code == "MASTER_PASS_ALREADY_OPEN" {
                adopt_orphan(led, nudged, &detail);
            }
        }
        Err(PassError::Unreached(e)) => tracing::warn!(
            "[master] {}: could not open a pass: {e} — this nudge's turn runs in no pass, and the next nudge opens one",
            nudged.project_id
        ),
    }
}

fn adopt_orphan(led: &mut Ledger, nudged: &Nudged<'_>, detail: &str) {
    let Some(pass_id) = named_pass_id(detail) else {
        tracing::warn!(
            "[master] {}: core named no pass id this box can read in that refusal, so the pass it holds open stays open until the session ends",
            nudged.project_id
        );
        return;
    };
    let row = MasterPass {
        project_id: nudged.project_id.to_string(),
        session_id: nudged.session_id.to_string(),
        pass_id,
        verb: NUDGE_VERB.to_string(),
        issue_key: None,
        opened_at: now_secs(),
        opened_by: ADOPTED_FROM_CORE.to_string(),
        turns_at_nudge: None,
    };
    if let Err(e) = led.open_master_pass(&row) {
        tracing::warn!(
            "[master] {}: cannot record pass {} that core holds open ({e}), so nothing here closes it",
            row.project_id,
            row.pass_id
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use runner_core::agent_activity::{Event, Report};

    // 2026-10-06T10:00:00Z
    const T0: i64 = 1_791_280_800;

    fn worked(at: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{at}","uuid":"w","message":{{"model":"claude-opus-5-5","content":[]}}}}"#
        )
    }

    fn limit(at: &str) -> String {
        format!(
            r#"{{"type":"assistant","isApiErrorMessage":true,"apiErrorStatus":429,"error":"rate_limit","timestamp":"{at}","uuid":"r","message":{{"model":"<synthetic>","content":[{{"type":"text","text":"You've hit your limit"}}]}},"quotaLimits":{{"status":"rejected","resetsAt":{}}}}}"#,
            T0 + 3600
        )
    }

    fn pass_from(opened_at: i64, turns_at_nudge: u64) -> MasterPass {
        MasterPass {
            project_id: "p".into(),
            session_id: "s".into(),
            pass_id: "x".into(),
            verb: NUDGE_VERB.into(),
            issue_key: None,
            opened_at,
            opened_by: "me".into(),
            turns_at_nudge: Some(turns_at_nudge),
        }
    }

    #[test]
    fn a_pass_whose_master_is_quiet_past_the_bound_is_abandoned() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000);
        let idle = report(&a, Event::Stopped, (T0 + 200) * 1000);
        // A pass waiting on a turn nothing starts: the nudge it waits on never came.
        let row = pass_from(T0, 1);
        let quiet_from = (T0 + 200) * 1000;
        assert_eq!(
            judge(
                &row,
                "me",
                Some("s"),
                Some(&idle),
                quiet_from + QUIET_BOUND_MS - 1,
                None
            ),
            Judged::Open
        );
        assert_eq!(
            judge(
                &row,
                "me",
                Some("s"),
                Some(&idle),
                quiet_from + QUIET_BOUND_MS,
                None
            ),
            Judged::Abandoned(Abandoned::Quiet),
            "a pass whose master said nothing for the bound still held its nudges"
        );
        // A transcript still being written is a master still working.
        assert_eq!(
            judge(
                &row,
                "me",
                Some("s"),
                Some(&idle),
                quiet_from + QUIET_BOUND_MS,
                Some(quiet_from + 1),
            ),
            Judged::Open
        );
        // A session that never reported is measured from the pass's own open.
        assert_eq!(
            judge(
                &row,
                "me",
                Some("s"),
                None,
                T0 * 1000 + QUIET_BOUND_MS,
                None
            ),
            Judged::Abandoned(Abandoned::Quiet)
        );
        // A pane stopped on a person's question is waiting on that person.
        let asked = report(&a, Event::PermissionRequested, (T0 + 300) * 1000);
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&asked), i64::MAX, None),
            Judged::Open
        );
        // An ended turn is closed as one, whatever the clock says.
        let ended = pass_from(T0, 0);
        assert_eq!(
            judge(&ended, "me", Some("s"), Some(&idle), i64::MAX, None),
            Judged::TurnEnded
        );
    }

    fn report(a: &Activities, event: Event, at_ms: i64) -> Activity {
        a.record(
            "s",
            Report {
                event,
                at: at_ms,
                subject: None,
                conversation: Some("c"),
                transcript: None,
            },
        )
    }

    #[test]
    fn a_429_after_work_in_the_same_pass_closes_it_as_ran() {
        let tail = [
            worked("2026-10-06T10:00:10Z"),
            limit("2026-10-06T10:00:20Z"),
        ]
        .join("\n");
        let turn = turn_since(&tail, T0, T0 + 30);
        assert!(turn.worked);
        assert_eq!(turn.refusal.as_ref().map(|r| r.0), Some("usage_limit"));
        assert_eq!(
            refused_pass(&turn, &[]),
            None,
            "a pass whose turn ran was closed refused"
        );
    }

    #[test]
    fn a_429_after_a_ledger_dispatch_closes_the_pass_as_ran() {
        let tail = limit("2026-10-06T10:00:20Z");
        let turn = turn_since(&tail, T0, T0 + 30);
        let dispatched = vec!["ISS-A".to_string(), "ISS-B".to_string()];
        assert_eq!(
            refused_pass(&turn, &dispatched),
            None,
            "a pass that declared runs was closed refused"
        );
    }

    #[test]
    fn a_turn_refused_before_anything_ran_closes_refused() {
        let tail = [
            worked("2026-10-06T09:59:00Z"),
            limit("2026-10-06T10:00:02Z"),
        ]
        .join("\n");
        let turn = turn_since(&tail, T0, T0 + 30);
        assert!(
            !turn.worked,
            "work from before the pass was counted inside it"
        );
        assert_eq!(refused_pass(&turn, &[]).map(|r| r.0), Some("usage_limit"));
    }

    #[test]
    fn a_refusal_from_before_the_pass_opened_is_not_its_own() {
        let tail = limit("2026-10-06T09:59:59Z");
        let turn = turn_since(&tail, T0, T0 + 30);
        assert_eq!(turn, TurnRecord::default());
        assert_eq!(refused_pass(&turn, &[]), None);
    }

    #[test]
    fn a_turn_that_ended_before_the_tick_still_opens_an_unprompted_pass() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000 + 250);
        let seen = report(&a, Event::Stopped, T0 * 1000 + 2000);
        assert_eq!(seen.doing(), Doing::Idle);
        assert_eq!(
            unprompted_turn(false, Some(&seen), None),
            Some(UnpromptedTurn {
                turns_before: 0,
                started_at: T0
            }),
            "a turn shorter than one tick got no pass"
        );
    }

    #[test]
    fn an_unprompted_pass_opens_at_the_prompt_not_when_the_tick_noticed() {
        let a = Activities::new();
        let seen = report(&a, Event::PromptSubmitted, (T0 - 4) * 1000);
        let turn = unprompted_turn(false, Some(&seen), None).expect("a running turn opens a pass");
        assert_eq!(turn.started_at, T0 - 4);
        // The refusal that turn met two seconds in is inside the pass it opened.
        let tail = limit("2026-10-06T09:59:58Z");
        let met = turn_since(&tail, turn.started_at, T0);
        assert_eq!(refused_pass(&met, &[]).map(|r| r.0), Some("usage_limit"));
    }

    #[test]
    fn a_settled_turn_or_an_open_pass_opens_no_unprompted_pass() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000);
        let seen = report(&a, Event::Stopped, T0 * 1000 + 1000);
        assert_eq!(unprompted_turn(false, Some(&seen), Some(1)), None);
        assert_eq!(unprompted_turn(true, Some(&seen), None), None);
        assert_eq!(unprompted_turn(false, None, None), None);
    }

    #[test]
    fn a_task_notification_turn_with_no_prompt_hook_opens_an_unprompted_pass() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000);
        report(&a, Event::Stopped, T0 * 1000 + 1000);
        let seen = report(&a, Event::Stopped, (T0 + 60) * 1000);
        let turn = unprompted_turn(false, Some(&seen), Some(1)).expect(
            "a turn the master took up from a task notification, which fires no UserPromptSubmit, opened no pass",
        );
        assert_eq!(
            turn,
            UnpromptedTurn {
                turns_before: 1,
                started_at: T0 + 1
            }
        );
        let row = MasterPass {
            project_id: "p".into(),
            session_id: "s".into(),
            pass_id: "x".into(),
            verb: NUDGE_VERB.into(),
            issue_key: None,
            opened_at: turn.started_at,
            opened_by: "me".into(),
            turns_at_nudge: Some(turn.turns_before),
        };
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&seen), 0, None),
            Judged::TurnEnded
        );
    }

    #[test]
    fn a_notification_turn_running_when_the_nudge_was_typed_does_not_close_its_pass() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000);
        report(&a, Event::Stopped, (T0 + 10) * 1000);
        let mut row = MasterPass {
            project_id: "p".into(),
            session_id: "s".into(),
            pass_id: "x".into(),
            verb: NUDGE_VERB.into(),
            issue_key: None,
            opened_at: T0 + 30,
            opened_by: "me".into(),
            turns_at_nudge: Some(1),
        };
        let notified = report(&a, Event::Stopped, (T0 + 40) * 1000);
        assert_eq!(notified.turns, 2);
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&notified), 0, None),
            Judged::Open,
            "the nudge's pass closed on a turn that began before it was typed"
        );
        report(&a, Event::PromptSubmitted, (T0 + 41) * 1000);
        let nudged = report(&a, Event::Stopped, (T0 + 50) * 1000);
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&nudged), 0, None),
            Judged::TurnEnded
        );
        row.opened_at = T0 + 60;
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&nudged), 0, None),
            Judged::Open
        );
    }

    #[test]
    fn a_short_unprompted_pass_is_judged_ended_in_the_reconcile_that_opened_it() {
        let a = Activities::new();
        report(&a, Event::PromptSubmitted, T0 * 1000);
        let seen = report(&a, Event::Stopped, T0 * 1000 + 1500);
        let turn = unprompted_turn(false, Some(&seen), None)
            .expect("a turn shorter than one tick got no pass");
        let row = MasterPass {
            project_id: "p".into(),
            session_id: "s".into(),
            pass_id: "x".into(),
            verb: NUDGE_VERB.into(),
            issue_key: None,
            opened_at: turn.started_at,
            opened_by: "me".into(),
            turns_at_nudge: Some(turn.turns_before),
        };
        assert_eq!(
            judge(&row, "me", Some("s"), Some(&seen), 0, None),
            Judged::TurnEnded
        );
    }
}
