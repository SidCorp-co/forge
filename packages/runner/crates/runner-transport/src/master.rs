//! The master's own row in core: registration, liveness, and its ending.
//!
//! A master used to invent its own session id, so `jobs.held_by` pointed at
//! nothing and core had no record the process ever existed. These three calls
//! are what put it on the same rail chat and schedule already run on.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterSession {
    pub session_id: String,
    pub name: String,
}

pub async fn register(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
) -> Result<MasterSession> {
    register_within(client, project_id, name, max_job_panes, CALL_DEADLINE).await
}

/// [`register`], with the deadline a test can shorten.
pub async fn register_within(
    client: &CoreClient,
    project_id: &str,
    name: &str,
    max_job_panes: u32,
    deadline: Duration,
) -> Result<MasterSession> {
    let body = serde_json::json!({
        "projectId": project_id,
        "name": name,
        "maxJobPanes": max_job_panes,
    });
    let req = client.post("/api/devices/me/master-session").json(&body);
    status::fetch_within(req, "master-session", deadline).await
}

pub async fn close(client: &CoreClient, session_id: &str, reason: &str) -> Result<()> {
    let body = serde_json::json!({ "sessionId": session_id, "reason": reason });
    let req = client
        .post("/api/devices/me/master-session/close")
        .json(&body);
    status::send_within(req, "master-session", CALL_DEADLINE).await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PassError {
    Refused { code: String, detail: String },
    Unreached(String),
}

impl std::fmt::Display for PassError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused { code, detail } => write!(f, "{code}: {detail}"),
            Self::Unreached(said) => f.write_str(said),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
struct PassReply {
    pass: PassRow,
    #[serde(default)]
    because: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PassRow {
    id: String,
    #[serde(default)]
    close_reason: Option<String>,
    #[serde(default)]
    ended_at: Option<String>,
}

/// What the box holds about one open pass, for core to judge whether and how
/// it ended (`@forge/contracts/master-standing` `masterPassFactsSchema`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassFacts {
    /// `this_daemon`, `earlier_daemon`, `adopted` or `unrecorded`.
    pub opened_by: &'static str,
    pub served: bool,
    pub opened_ago_ms: u64,
    pub hooks: Option<PassHooks>,
    pub written_ago_ms: Option<u64>,
    pub dispatched: Vec<String>,
    pub record: PassRecord,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassHooks {
    pub turns_since_open: u64,
    pub turn_began_ago_ms: Option<u64>,
    /// `idle`, `working`, `awaiting_permission` or `awaiting_children`.
    pub doing: &'static str,
    pub last_event_ago_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassRecord {
    pub worked: bool,
    pub refusal: Option<PassRefusal>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PassRefusal {
    /// `usage_limit`, `rate_limit` or `auth`.
    pub reason: &'static str,
    pub detail: String,
}

/// What core answered a settle: the reason it closed the pass with, or `None`
/// where it still stands, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settled {
    pub closed: Option<String>,
    pub because: String,
}

pub async fn open_pass(
    client: &CoreClient,
    session_id: &str,
    verb: &str,
    issue_key: Option<&str>,
    trigger: &str,
) -> std::result::Result<String, PassError> {
    let body = serde_json::json!({
        "op": "open",
        "sessionId": session_id,
        "verb": verb,
        "issueKey": issue_key,
        "trigger": trigger,
    });
    pass_call(client, body).await.map(|r| r.pass.id)
}

/// Ask core whether the pass ended, from what this box holds about it; core
/// closes it where it did (`masters/pass-end.ts:passEnd`).
pub async fn settle_pass(
    client: &CoreClient,
    session_id: &str,
    pass_id: &str,
    facts: &PassFacts,
) -> std::result::Result<Settled, PassError> {
    let body = serde_json::json!({
        "op": "settle",
        "sessionId": session_id,
        "passId": pass_id,
        "facts": facts,
    });
    let reply = pass_call(client, body).await?;
    Ok(Settled {
        closed: reply
            .pass
            .ended_at
            .map(|_| reply.pass.close_reason.unwrap_or_default()),
        because: reply.because.unwrap_or_default(),
    })
}

async fn pass_call(
    client: &CoreClient,
    body: serde_json::Value,
) -> std::result::Result<PassReply, PassError> {
    const WHAT: &str = "master-session/pass";
    let resp = client
        .post("/api/devices/me/master-session/pass")
        .json(&body)
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            PassError::Unreached(format!(
                "{WHAT} request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    let code = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if (200..300).contains(&code) {
        return serde_json::from_str::<PassReply>(&text)
            .map_err(|e| PassError::Unreached(format!("{WHAT} decode: {e}")));
    }
    Err(pass_refusal(code, &text)
        .unwrap_or_else(|| PassError::Unreached(status::refused(WHAT, code, &text))))
}

pub(crate) fn pass_refusal(status: u16, text: &str) -> Option<PassError> {
    if !(400..500).contains(&status) || matches!(status, 401 | 408 | 429) {
        return None;
    }
    let body: serde_json::Value = serde_json::from_str(text).ok()?;
    let error = body.get("error").unwrap_or(&body);
    let code = error.get("code")?.as_str()?.to_string();
    let detail = error
        .get("refusals")
        .and_then(|r| r.get(0))
        .and_then(|r| r.get("detail"))
        .or_else(|| error.get("message"))
        .and_then(|d| d.as_str())
        .unwrap_or_default()
        .to_string();
    Some(PassError::Refused { code, detail })
}

/// Tell core the dialog this box read on a master's pane, or that none stands
/// (`None`). `dialog` is the text and where it was read: `pane` or `hooks`.
pub async fn report_dialog(
    client: &CoreClient,
    session_id: &str,
    dialog: Option<(&str, &str)>,
) -> Result<()> {
    let body = serde_json::json!({
        "sessionId": session_id,
        "dialog": dialog.map(|(text, source)| serde_json::json!({ "text": text, "source": source })),
    });
    let req = client
        .post("/api/devices/me/master-session/dialog")
        .json(&body);
    status::send_within(req, "master-session/dialog", CALL_DEADLINE).await?;
    Ok(())
}

pub async fn report_limit(
    client: &CoreClient,
    reason: &str,
    resets_in_seconds: Option<u64>,
    detail: &str,
) -> Result<()> {
    let mut body = serde_json::json!({ "reason": reason, "detail": detail });
    if let Some(secs) = resets_in_seconds {
        body["resetsInSeconds"] = serde_json::json!(secs);
    }
    let req = client.post("/api/devices/me/limit").json(&body);
    status::send_within(req, "me/limit", CALL_DEADLINE).await?;
    Ok(())
}

/// The newest decisive record this box read in its masters' conversations, as
/// it wrote it. Whether it is fresh, new to core, or a lifting is core's
/// (`devices/master-limit.ts:masterLimitAction`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LimitRecord {
    #[serde(rename_all = "camelCase")]
    Refused {
        /// Seconds since the record was written, by this box's clock.
        ago_seconds: i64,
        /// `usage_limit`, `rate_limit` or `auth`.
        reason: &'static str,
        resets_in_seconds: Option<u64>,
        detail: String,
    },
    #[serde(rename_all = "camelCase")]
    Worked {
        ago_seconds: i64,
    },
    Unreadable {
        slug: String,
    },
}

/// What core did with a [`LimitRecord`]: one of `reported`, `held`, `stale`,
/// `cleared`, `nothing` or `unreadable`.
#[derive(Debug, Clone, Deserialize)]
pub struct LimitOutcome {
    pub outcome: String,
}

pub async fn send_limit_record(client: &CoreClient, record: &LimitRecord) -> Result<LimitOutcome> {
    let req = client
        .post("/api/devices/me/limit/record")
        .json(&serde_json::json!({ "record": record }));
    status::fetch_within(req, "me/limit/record", CALL_DEADLINE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_settle_is_sent_in_the_shape_core_validates() {
        let facts = PassFacts {
            opened_by: "this_daemon",
            served: true,
            opened_ago_ms: 5,
            hooks: Some(PassHooks {
                turns_since_open: 1,
                turn_began_ago_ms: Some(4),
                doing: "idle",
                last_event_ago_ms: 1,
            }),
            written_ago_ms: None,
            dispatched: vec!["ISS-1".into()],
            record: PassRecord {
                worked: false,
                refusal: Some(PassRefusal {
                    reason: "usage_limit",
                    detail: "limit".into(),
                }),
            },
        };
        assert_eq!(
            serde_json::to_value(&facts).unwrap(),
            serde_json::json!({
                "openedBy": "this_daemon",
                "served": true,
                "openedAgoMs": 5,
                "hooks": { "turnsSinceOpen": 1, "turnBeganAgoMs": 4, "doing": "idle", "lastEventAgoMs": 1 },
                "writtenAgoMs": null,
                "dispatched": ["ISS-1"],
                "record": { "worked": false, "refusal": { "reason": "usage_limit", "detail": "limit" } }
            })
        );
    }
}

#[cfg(test)]
mod limit_record_tests {
    use super::*;

    #[test]
    fn a_record_is_sent_in_the_shape_core_validates() {
        let refused = LimitRecord::Refused {
            ago_seconds: 30,
            reason: "usage_limit",
            resets_in_seconds: Some(3600),
            detail: "capped".into(),
        };
        assert_eq!(
            serde_json::to_string(&refused).unwrap(),
            r#"{"kind":"refused","agoSeconds":30,"reason":"usage_limit","resetsInSeconds":3600,"detail":"capped"}"#
        );
        assert_eq!(
            serde_json::to_string(&LimitRecord::Worked { ago_seconds: 4 }).unwrap(),
            r#"{"kind":"worked","agoSeconds":4}"#
        );
        assert_eq!(
            serde_json::to_string(&LimitRecord::Unreadable { slug: "x".into() }).unwrap(),
            r#"{"kind":"unreadable","slug":"x"}"#
        );
    }
}
