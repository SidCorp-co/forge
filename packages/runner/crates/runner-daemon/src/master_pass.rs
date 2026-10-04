// cm:why one pass is one master turn, from the nudge that asks for it to the hook that reports the turn
// ended (design agent-run-standing rev 1, region master; ISS-107). The open pass is kept in the ledger so a
// daemon restart closes exactly the pass it opened, by the id core answered, and never another one.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use crate::master::Masters;
use runner_core::agent_activity::{Activities, Activity, Doing};
use runner_core::ledger::{Ledger, MasterPass};
use runner_transport::master::{self as master_api, PassError};
use runner_transport::CoreClient;

pub(crate) const NUDGE_VERB: &str = "dispatch";

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

async fn settle(client: &CoreClient, led: &mut Ledger, pass: &MasterPass, why: &str) -> bool {
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
    let gone = match master_api::close_pass(client, &pass.session_id, &pass.pass_id, &dispatched)
        .await
    {
        Ok(_) => {
            tracing::info!(
                "[master] {}: pass {} ({}) closed, {} issue(s) dispatched — {why}",
                pass.project_id,
                pass.pass_id,
                pass.verb,
                dispatched.len()
            );
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
        match judge(pass, process, live.as_deref(), seen.as_ref()) {
            Judged::Open => {}
            Judged::TurnEnded => {
                settle(client, led, pass, "the turn its nudge started has ended").await;
            }
            Judged::Abandoned(a) => {
                settle(client, led, pass, a.why()).await;
            }
        }
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
    let opened =
        master_api::open_pass(client, nudged.session_id, NUDGE_VERB, nudged.issue_key).await;
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
                    master_api::close_pass(client, &row.session_id, &row.pass_id, &[]).await
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

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}
