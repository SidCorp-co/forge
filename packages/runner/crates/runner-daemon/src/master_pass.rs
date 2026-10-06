// cm:why one pass is one master turn, from the nudge that asks for it to the hook that reports the turn
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
}

impl Abandoned {
    fn why(self) -> &'static str {
        match self {
            Self::Restarted => "opened by the daemon process before this one, so the hook counts its turn was measured against are gone and the turn can no longer be judged; closed as abandoned at the restart",
            Self::Orphaned => "core held it open with no record on this box (an open whose answer never arrived); closed as abandoned",
            Self::SessionGone => "its master session is no longer the one this box serves the project under; closed with the session",
        }
    }
}

pub(crate) fn turn_ended(seen: Option<&Activity>, prompts_at_nudge: Option<u64>) -> bool {
    let Some(seen) = seen else {
        return false;
    };
    seen.prompts > prompts_at_nudge.unwrap_or(0)
        && matches!(seen.doing(), Doing::Idle | Doing::AwaitingChildren)
}

pub(crate) fn judge(
    pass: &MasterPass,
    process: &str,
    live_session: Option<&str>,
    seen: Option<&Activity>,
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
    if turn_ended(seen, pass.prompts_at_nudge) {
        return Judged::TurnEnded;
    }
    Judged::Open
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

// cm:edge contract -> packages/core/src/masters/rules.ts — passAlreadyOpenRefusal names the open pass as
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

/// The refusal the master's account wrote for a turn started at or after
/// `opened_at`, read off the conversation's own records: a pass whose turn was
/// refused before it ran is closed refused, never as an idle pass.
pub(crate) fn refusal_since(
    newest: Option<&crate::master_limit::Decisive>,
    opened_at: i64,
) -> Option<(&'static str, String)> {
    let d = newest?;
    if d.at < opened_at {
        return None;
    }
    match &d.verdict {
        crate::master_limit::Verdict::Refused(r) => Some((r.reason.wire(), r.detail.clone())),
        _ => None,
    }
}

fn refusal_of(seen: Option<&Activity>, opened_at: i64) -> Option<(&'static str, String)> {
    let path = seen?.transcript.as_deref()?;
    let tail = crate::master_limit::read_tail(std::path::Path::new(path))?;
    let newest = crate::master_limit::newest_record(&tail, crate::master_limit::now_unix());
    refusal_since(newest.as_ref(), opened_at)
}

async fn settle(
    client: &CoreClient,
    led: &mut Ledger,
    pass: &MasterPass,
    why: &str,
    refused: Option<(&'static str, String)>,
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
                None => tracing::info!(
                    "[master] {}: pass {} ({}) closed, {} issue(s) dispatched — {why}",
                    pass.project_id,
                    pass.pass_id,
                    pass.verb,
                    dispatched.len()
                ),
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
        let settled = match judge(pass, process, live.as_deref(), seen.as_ref()) {
            Judged::Open => false,
            Judged::TurnEnded => {
                let refused = refusal_of(seen.as_ref(), pass.opened_at);
                settle(client, led, pass, "the turn it covers has ended", refused).await
            }
            Judged::Abandoned(a) => settle(client, led, pass, a.why(), None).await,
        };
        if settled {
            if let Some(seen) = seen.as_ref() {
                masters.note_prompts_settled(&pass.project_id, &pass.session_id, seen.prompts);
            }
        }
    }
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
}

/// The prompt count to record as an unprompted pass's start, where `seen`
/// shows a turn running that no open pass covers and that began after the
/// last pass settled. `None` otherwise.
pub(crate) fn unprompted_turn(
    pass_open: bool,
    seen: Option<&Activity>,
    settled_at: Option<u64>,
) -> Option<u64> {
    if pass_open {
        return None;
    }
    let seen = seen?;
    if !matches!(seen.doing(), Doing::Working | Doing::AwaitingPermission) {
        return None;
    }
    (seen.prompts > settled_at.unwrap_or(0)).then(|| seen.prompts.saturating_sub(1))
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
    let Some(prompts) = unprompted_turn(
        pass_open,
        seen.as_ref(),
        masters.prompts_settled(project_id, session_id),
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
                opened_at: now_secs(),
                opened_by: process.to_string(),
                prompts_at_nudge: Some(prompts),
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
            masters.note_prompts_settled(project_id, session_id, prompts + 1);
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
    pub prompts: Option<u64>,
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
            if let Err(e) = led.renudge_master_pass(&open.pass_id, nudged.prompts) {
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
                prompts_at_nudge: nudged.prompts,
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
        prompts_at_nudge: None,
    };
    if let Err(e) = led.open_master_pass(&row) {
        tracing::warn!(
            "[master] {}: cannot record pass {} that core holds open ({e}), so nothing here closes it",
            row.project_id,
            row.pass_id
        );
    }
}
