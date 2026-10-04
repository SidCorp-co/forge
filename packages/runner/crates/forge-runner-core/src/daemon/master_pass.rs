// cm:why one pass is one master turn, from the nudge that asks for it to the hook that reports the turn
// ended (design agent-run-standing rev 1, region master; ISS-107). The open pass is kept in the ledger so a
// daemon restart closes exactly the pass it opened, by the id core answered, and never another one.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use crate::daemon::agent_activity::{Activities, Activity, Doing};
use crate::daemon::master::Masters;
use crate::runner::ledger::{Ledger, MasterPass};
use crate::transport::master::{self as master_api, PassError};
use crate::transport::CoreClient;

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
    admissible: &[crate::transport::admissible::AdmissibleIssue],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::agent_activity::{Event, Report};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    const PASS_A: &str = "aaaaaaaa-0000-4000-8000-000000000001";
    const PASS_B: &str = "bbbbbbbb-0000-4000-8000-000000000002";

    fn lead(event: Event, at: i64) -> Report<'static> {
        Report {
            event,
            at,
            subject: None,
            conversation: None,
            transcript: None,
        }
    }

    fn pass(id: &str, by: &str, prompts: Option<u64>) -> MasterPass {
        MasterPass {
            project_id: "proj-1".into(),
            session_id: "sess-1".into(),
            pass_id: id.into(),
            verb: NUDGE_VERB.into(),
            issue_key: None,
            opened_at: 0,
            opened_by: by.into(),
            prompts_at_nudge: prompts,
        }
    }

    type Seen = Arc<Mutex<Vec<(String, serde_json::Value)>>>;

    async fn core(answers: &'static [(&'static str, &'static str)]) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen: Seen = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            let mut n = 0usize;
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 16384];
                let read = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..read]).into_owned();
                let line = req.lines().next().unwrap_or_default().to_string();
                let body = req.split("\r\n\r\n").nth(1).unwrap_or("null");
                log.lock().unwrap().push((
                    line,
                    serde_json::from_str(body).unwrap_or(serde_json::Value::Null),
                ));
                let (status, text) = answers[n.min(answers.len() - 1)];
                n += 1;
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
                    text.len()
                );
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (format!("http://{addr}"), seen)
    }

    const CLOSED_A: &str = r#"{"pass":{"id":"aaaaaaaa-0000-4000-8000-000000000001","sessionId":"sess-1","verb":"dispatch","startedAt":"2026-10-04T08:00:00.000Z","issueKey":null,"endedAt":"2026-10-04T08:01:00.000Z","dispatched":[],"skipped":[],"parked":[]}}"#;
    const OPENED_B: &str = r#"{"pass":{"id":"bbbbbbbb-0000-4000-8000-000000000002","sessionId":"sess-1","verb":"dispatch","startedAt":"2026-10-04T08:02:00.000Z","issueKey":"ISS-7"}}"#;

    fn live_master() -> Arc<Masters> {
        let masters = Arc::new(Masters::new());
        masters.remember_for_test("proj-1", "sess-1", "forge-master-proj");
        masters
    }

    #[test]
    fn a_pass_ends_with_the_turn_its_nudge_started_and_not_before() {
        let acts = Activities::new();
        assert!(
            !turn_ended(None, Some(0)),
            "a session that never reported has not ended a turn"
        );
        acts.record("s", lead(Event::Stopped, 1));
        assert!(
            !turn_ended(acts.get("s").as_ref(), Some(0)),
            "a stop with no prompt after the nudge is the turn before it"
        );
        acts.record("s", lead(Event::PromptSubmitted, 2));
        assert!(
            !turn_ended(acts.get("s").as_ref(), Some(0)),
            "the turn is running"
        );
        acts.record("s", lead(Event::PermissionRequested, 3));
        assert!(
            !turn_ended(acts.get("s").as_ref(), Some(0)),
            "a turn stopped on a question has not ended"
        );
        acts.record("s", lead(Event::Stopped, 4));
        assert!(
            turn_ended(acts.get("s").as_ref(), Some(0)),
            "the turn ended"
        );
        assert!(
            !turn_ended(acts.get("s").as_ref(), Some(1)),
            "a re-nudge moves the start: the turn already counted is not the one it asked for"
        );
        acts.record("s", lead(Event::PromptSubmitted, 5));
        acts.record(
            "s",
            Report {
                event: Event::SubagentStarted,
                at: 6,
                subject: Some("child"),
                conversation: None,
                transcript: None,
            },
        );
        acts.record("s", lead(Event::StoppedFailed, 7));
        assert!(
            turn_ended(acts.get("s").as_ref(), Some(1)),
            "the lead's stop ends the turn even with a dispatched child still out, and a failed turn ends it too"
        );
    }

    #[test]
    fn a_pass_another_process_opened_is_abandoned_whatever_its_hooks_say() {
        let acts = Activities::new();
        acts.record("sess-1", lead(Event::PromptSubmitted, 1));
        let p = pass(PASS_A, "an-earlier-daemon", Some(0));
        assert_eq!(
            judge(
                &p,
                "this-daemon",
                Some("sess-1"),
                acts.get("sess-1").as_ref()
            ),
            Judged::Abandoned(Abandoned::Restarted)
        );
        let mine = pass(PASS_A, "this-daemon", Some(0));
        assert_eq!(
            judge(
                &mine,
                "this-daemon",
                Some("sess-1"),
                acts.get("sess-1").as_ref()
            ),
            Judged::Open
        );
        assert_eq!(
            judge(&mine, "this-daemon", Some("sess-2"), None),
            Judged::Abandoned(Abandoned::SessionGone)
        );
        assert_eq!(
            judge(&mine, "this-daemon", None, None),
            Judged::Abandoned(Abandoned::SessionGone)
        );
        assert_eq!(
            judge(
                &pass(PASS_A, ADOPTED_FROM_CORE, None),
                "this-daemon",
                Some("sess-1"),
                None
            ),
            Judged::Abandoned(Abandoned::Orphaned)
        );
    }

    #[test]
    fn the_pass_core_holds_open_is_read_from_its_refusal_and_nothing_else_is() {
        assert_eq!(
            named_pass_id("this master already has the dispatch pass started 2026-10-04T08:22:15.048Z on ISS-1 open, id c9d772dd-fae2-43c0-b9d6-65f367e9127d; close it before opening the next"),
            Some("c9d772dd-fae2-43c0-b9d6-65f367e9127d".into())
        );
        assert_eq!(named_pass_id("the pass open now has id p2."), None);
        assert_eq!(named_pass_id("no id at all"), None);
    }

    #[test]
    fn only_a_pass_about_one_issue_names_it() {
        let one: Vec<crate::transport::admissible::AdmissibleIssue> = serde_json::from_value(
            serde_json::json!([{ "issueId": "i1", "issueKey": "ISS-7", "status": "open" }]),
        )
        .unwrap();
        assert_eq!(nudged_issue(&one, true), Some("ISS-7"));
        assert_eq!(
            nudged_issue(&one, false),
            None,
            "an owed reply is in the pass too"
        );
        let two: Vec<crate::transport::admissible::AdmissibleIssue> = serde_json::from_value(
            serde_json::json!([{ "issueId": "i1", "issueKey": "ISS-7", "status": "open" }, { "issueId": "i2", "issueKey": "ISS-8", "status": "open" }]),
        )
        .unwrap();
        assert_eq!(nudged_issue(&two, true), None);
    }

    #[tokio::test]
    async fn a_restart_closes_the_pass_it_persisted_by_that_pass_id_and_drops_the_record() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.open_master_pass(&pass(PASS_A, "an-earlier-daemon", Some(3)))
            .unwrap();
        let (url, seen) = core(&[("200 OK", CLOSED_A)]).await;
        let client = CoreClient::new(url, "tok");
        reconcile(
            &client,
            &live_master(),
            &Activities::new(),
            &mut led,
            this_process(),
            None,
        )
        .await;
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 1, "one close and nothing else: {calls:?}");
        assert!(calls[0]
            .0
            .starts_with("POST /api/devices/me/master-session/pass "));
        assert_eq!(calls[0].1["op"], "close");
        assert_eq!(
            calls[0].1["passId"], PASS_A,
            "the close names the pass this box persisted, never whichever is open now"
        );
        assert_eq!(calls[0].1["sessionId"], "sess-1");
        assert!(
            led.master_passes().unwrap().is_empty(),
            "the record is dropped once core settles it"
        );
    }

    #[tokio::test]
    async fn a_close_core_cannot_be_reached_for_is_kept_and_a_refused_one_is_never_retried() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.open_master_pass(&pass(PASS_A, "an-earlier-daemon", None))
            .unwrap();
        let (url, seen) = core(&[
            ("503 Service Unavailable", "no available server"),
            ("422 Unprocessable Entity", r#"{"error":{"code":"MASTER_PASS_NOT_OPEN","refusals":[{"code":"MASTER_PASS_NOT_OPEN","path":"/passId","detail":"a closed pass is final, so this close changed nothing."}]}}"#),
        ])
        .await;
        let client = CoreClient::new(url, "tok");
        let masters = live_master();
        reconcile(
            &client,
            &masters,
            &Activities::new(),
            &mut led,
            this_process(),
            None,
        )
        .await;
        assert_eq!(
            led.master_passes().unwrap().len(),
            1,
            "an unreached core keeps the record"
        );
        reconcile(
            &client,
            &masters,
            &Activities::new(),
            &mut led,
            this_process(),
            None,
        )
        .await;
        assert!(
            led.master_passes().unwrap().is_empty(),
            "a refusal by name ends it"
        );
        reconcile(
            &client,
            &masters,
            &Activities::new(),
            &mut led,
            this_process(),
            None,
        )
        .await;
        let calls = seen.lock().unwrap().clone();
        assert_eq!(
            calls.len(),
            2,
            "the refused close is not sent again: {calls:?}"
        );
        assert!(calls.iter().all(|(_, b)| b["passId"] == PASS_A));
    }

    #[tokio::test]
    async fn a_nudge_closes_the_ended_pass_by_its_id_before_it_opens_the_next() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.open_master_pass(&pass(PASS_A, this_process(), Some(0)))
            .unwrap();
        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: "run-1".into(),
            project_id: "proj-1".into(),
            master_session_id: "sess-1".into(),
            worktree_path: "/w/run-1".into(),
            boot_id: "boot-a".into(),
            issue_keys: vec!["ISS-5".into()],
        })
        .unwrap();
        let acts = Activities::new();
        acts.record("sess-1", lead(Event::PromptSubmitted, 1));
        acts.record("sess-1", lead(Event::Stopped, 2));
        let (url, seen) = core(&[("200 OK", CLOSED_A), ("201 Created", OPENED_B)]).await;
        let client = CoreClient::new(url, "tok");
        open_for_nudge(
            &client,
            &live_master(),
            &acts,
            &mut led,
            this_process(),
            &Nudged {
                project_id: "proj-1",
                session_id: "sess-1",
                issue_key: Some("ISS-7"),
                prompts: Some(1),
            },
        )
        .await;
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(calls[0].1["op"], "close");
        assert_eq!(calls[0].1["passId"], PASS_A);
        assert_eq!(calls[0].1["dispatched"], serde_json::json!(["ISS-5"]));
        assert_eq!(calls[1].1["op"], "open");
        assert_eq!(calls[1].1["verb"], NUDGE_VERB);
        assert_eq!(calls[1].1["issueKey"], "ISS-7");
        let open = led
            .master_pass_for("proj-1")
            .unwrap()
            .expect("the new pass is recorded");
        assert_eq!(open.pass_id, PASS_B);
        assert_eq!(open.prompts_at_nudge, Some(1));
        assert_eq!(open.opened_by, this_process());
    }

    #[tokio::test]
    async fn a_nudge_while_the_turn_runs_keeps_the_pass_and_opens_none() {
        let mut led = Ledger::open_in_memory().unwrap();
        led.open_master_pass(&pass(PASS_A, this_process(), Some(0)))
            .unwrap();
        let acts = Activities::new();
        acts.record("sess-1", lead(Event::PromptSubmitted, 1));
        let (url, seen) = core(&[("201 Created", OPENED_B)]).await;
        open_for_nudge(
            &CoreClient::new(url, "tok"),
            &live_master(),
            &acts,
            &mut led,
            this_process(),
            &Nudged {
                project_id: "proj-1",
                session_id: "sess-1",
                issue_key: None,
                prompts: Some(1),
            },
        )
        .await;
        assert!(seen.lock().unwrap().is_empty(), "core is asked nothing");
        let open = led.master_pass_for("proj-1").unwrap().unwrap();
        assert_eq!(open.pass_id, PASS_A);
        assert_eq!(
            open.prompts_at_nudge,
            Some(1),
            "the pass now ends with the turn this nudge asks for"
        );
    }

    #[tokio::test]
    async fn an_open_refused_already_open_is_not_retried_and_the_pass_core_named_is_closed_next() {
        let mut led = Ledger::open_in_memory().unwrap();
        let (url, seen) = core(&[
            ("422 Unprocessable Entity", r#"{"error":{"code":"MASTER_PASS_ALREADY_OPEN","refusals":[{"code":"MASTER_PASS_ALREADY_OPEN","path":"/op","detail":"this master already has the dispatch pass started 2026-10-04T08:00:00.000Z open, id aaaaaaaa-0000-4000-8000-000000000001; close it before opening the next"}]}}"#),
            ("200 OK", CLOSED_A),
        ])
        .await;
        let client = CoreClient::new(url, "tok");
        let masters = live_master();
        let nudged = Nudged {
            project_id: "proj-1",
            session_id: "sess-1",
            issue_key: None,
            prompts: None,
        };
        open_for_nudge(
            &client,
            &masters,
            &Activities::new(),
            &mut led,
            this_process(),
            &nudged,
        )
        .await;
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "the refused open is sent once"
        );
        let adopted = led
            .master_pass_for("proj-1")
            .unwrap()
            .expect("the orphan is recorded");
        assert_eq!(adopted.pass_id, PASS_A);
        reconcile(
            &client,
            &masters,
            &Activities::new(),
            &mut led,
            this_process(),
            None,
        )
        .await;
        let calls = seen.lock().unwrap().clone();
        assert_eq!(calls.len(), 2, "{calls:?}");
        assert_eq!(calls[1].1["op"], "close");
        assert_eq!(calls[1].1["passId"], PASS_A);
        assert!(led.master_passes().unwrap().is_empty());
    }

    fn sweep_source() -> &'static str {
        crate::test_scratch::lf(include_str!("master.rs"))
            .split("\n#[cfg(test)]")
            .next()
            .unwrap()
    }

    #[test]
    fn the_sweep_opens_the_pass_before_it_sends_the_nudge_and_only_there() {
        let production = sweep_source();
        let open = production
            .find("pass.open(ledger).await;")
            .expect("the sweep opens a pass for the nudge it claimed");
        let nudge = production
            .find("nudge_master(masters, &runner.project_id")
            .expect("the sweep nudges");
        assert!(open < nudge, "the pass opens before the prompt is sent");
        assert_eq!(
            production.matches("master_pass::open_for_nudge(").count(),
            1
        );
    }

    #[test]
    fn every_registration_declares_the_configured_slots() {
        let production = sweep_source();
        assert!(production.contains("slots: cfg.runner.max_job_panes.max(1),"));
        assert!(production.contains("master_api::register(client, project_id, &name, carry.slots)"));
        assert_eq!(production.matches("master_api::register(").count(), 1);
    }

    #[test]
    fn the_pass_tick_never_restarts_the_sweeps_wait() {
        let production = sweep_source();
        let run = production
            .split("\npub async fn run(")
            .nth(1)
            .and_then(|r| r.split("\n}\n").next())
            .expect("the master loop is findable");
        assert!(
            run.contains("passes.tick()"),
            "the loop ticks the passes beside the sweep"
        );
        assert!(
            !run.contains("_ = tokio::time::sleep(delay) =>"),
            "a sleep built inside select! starts over each time the 5 s tick re-enters the loop, so the 30 s sweep never fires"
        );
        assert!(run.contains("tokio::pin!(sweep_due);"));
        assert_eq!(
            run.matches("sweep_due.as_mut().reset(").count(),
            2,
            "both the timed and the woken sweep set the next deadline"
        );
    }
}
