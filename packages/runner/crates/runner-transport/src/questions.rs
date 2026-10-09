/*
 * Asking core a question, and reading its answer back.
 *
 * Both halves are declarations rather than calls: `ask` returns as soon as core
 * has the row, and `answer` is a read the box repeats. Nothing here waits for a
 * human, because a session that waits is a session holding a slot.
 */

use serde::Deserialize;

use crate::{status, CoreClient};
use runner_platform::error::{Error, Result};

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub question_id: String,
    #[serde(default)]
    pub answer_shape: Option<String>,
    #[serde(default)]
    pub option_id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    pub answered_at: Option<String>,
    pub answered_by: Option<String>,
    pub round: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AnswerReply {
    answer: Option<Answer>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AskReply {
    question_id: String,
}

/// What the box knows when it asks. `id` is minted HERE.
#[derive(Debug, Clone)]
pub struct Ask<'a> {
    pub id: &'a str,
    pub project_id: &'a str,
    pub run_id: &'a str,
    pub issue_id: Option<&'a str>,
    pub agent_session_id: Option<&'a str>,
    pub prompt: &'a str,
    pub blocker_kind: &'a str,
    /// `None` means a choice round, which is what every box asked for before ISS-996.
    pub answer_shape: Option<&'a str>,
    pub options: serde_json::Value,
    pub recommended_option_id: &'a str,
    pub needed: Option<&'a str>,
    /// A free-text round's recommended answer; core refuses one asked of a person without it.
    pub recommended: Option<&'a str>,
    pub assumed: Option<serde_json::Value>,
    pub cost: Option<serde_json::Value>,
    pub sensitive: Option<bool>,
}

pub async fn ask(client: &CoreClient, req: Ask<'_>) -> Result<String> {
    let mut body = serde_json::json!({
        "id": req.id,
        "projectId": req.project_id,
        "runId": req.run_id,
        "prompt": req.prompt,
        "blockerKind": req.blocker_kind,
        "options": req.options,
        "recommendedOptionId": req.recommended_option_id,
    });
    if let Some(v) = req.answer_shape {
        body["answerShape"] = serde_json::json!(v);
    }
    if let Some(v) = req.needed {
        body["needed"] = serde_json::json!(v);
    }
    if let Some(v) = req.recommended {
        body["recommended"] = serde_json::json!(v);
    }
    if let Some(v) = req.issue_id {
        body["issueId"] = serde_json::json!(v);
    }
    if let Some(v) = req.agent_session_id {
        body["agentSessionId"] = serde_json::json!(v);
    }
    if let Some(v) = req.assumed {
        body["assumed"] = v;
    }
    if let Some(v) = req.cost {
        body["cost"] = v;
    }
    if req.sensitive == Some(true) {
        body["sensitive"] = serde_json::json!(true);
    }
    let resp = status::sent(
        client.post("/api/devices/me/questions").json(&body),
        "question ask",
    )
    .await?;
    let resp = status::checked(resp, "question ask").await?;
    let parsed: AskReply = status::decode(resp, "question ask").await?;
    Ok(parsed.question_id)
}

/// `run_id` goes through the client's own query serializer rather than into the
/// string. A run identity is free text on core's side, so one carrying `+`, `&`,
/// `#` or a space interpolated straight in reaches the server as a different
/// value — `+` as a space, `&` as the end of the parameter — and the waiter
/// lookup misses. That is a read-back that fails for a question this box really
/// did ask, which is the silence this whole path exists to end (ISS-1210).
pub async fn answer(
    client: &CoreClient,
    question_id: &str,
    run_id: &str,
) -> Result<Option<Answer>> {
    let path = format!("/api/devices/me/questions/{question_id}");
    let req = client.get(&path).query(&[("runId", run_id)]);
    let resp = status::sent(req, "question read").await?;
    if resp.status().as_u16() == 404 {
        return Err(Error::Other(format!(
            "question read: {question_id} is not registered to this box for run {run_id}"
        )));
    }
    let resp = status::checked(resp, "question read").await?;
    let parsed: AnswerReply = status::decode(resp, "question read").await?;
    Ok(parsed.answer)
}
