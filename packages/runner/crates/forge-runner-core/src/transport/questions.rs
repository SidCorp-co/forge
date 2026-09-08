/*
 * Asking core a question, and reading its answer back.
 *
 * Both halves are declarations rather than calls: `ask` returns as soon as core
 * has the row, and `answer` is a read the box repeats. Nothing here waits for a
 * human, because a session that waits is a session holding a slot.
 */

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::transport::CoreClient;

/// What a human chose, once they have.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Answer {
    pub question_id: String,
    pub option_id: String,
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
    pub options: serde_json::Value,
    pub recommended_option_id: &'a str,
    pub assumed: Option<serde_json::Value>,
    pub cost: Option<serde_json::Value>,
}

/// Tell core about a question this box has ALREADY recorded locally.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `POST /me/questions` is the other half: it takes the id rather than allocating one, and registers this run as a waiter when `runId` is sent.
// cm:guard the id travels UP and is never read back as authoritative: the box has already written its own half in one local transaction before this call, so an id core allocated would make the two halves unjoinable across the window where the box has parked and core has not heard (ISS-964 criterion 10).
// cm:guard `runId` is required by this client although the route treats it as optional, because a question that registers no waiter is one no answer can be routed back to — the box would ask and then have nowhere to hear (ISS-964 criterion 12).
pub async fn ask(client: &CoreClient, req: Ask<'_>) -> Result<String> {
    let url = client.url("/api/devices/me/questions");
    let mut body = serde_json::json!({
        "id": req.id,
        "projectId": req.project_id,
        "runId": req.run_id,
        "prompt": req.prompt,
        "blockerKind": req.blocker_kind,
        "options": req.options,
        "recommendedOptionId": req.recommended_option_id,
    });
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
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("question ask: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("question ask: {status}: {text}")));
    }
    let parsed: AskReply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("question ask decode: {e}")))?;
    Ok(parsed.question_id)
}

/// Read the answer back, or `None` while there is not one.
// cm:edge contract -> packages/core/src/devices/pool-routes.ts — `GET /me/questions/:questionId` answers only a device registered as this run's waiter, so `run_id` is part of the address rather than a filter.
// cm:guard `None` is UNANSWERED and a 404 is NOT THIS BOX'S QUESTION, and collapsing the two would turn somebody else's question into an eternal wait. The pull is the delivery: an episode spent entirely with the websocket down costs latency and nothing else, which is the only thing criterion 12 permits to be lost.
pub async fn answer(
    client: &CoreClient,
    question_id: &str,
    run_id: &str,
) -> Result<Option<Answer>> {
    let url = client.url(&format!(
        "/api/devices/me/questions/{question_id}?runId={run_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("question read: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Err(Error::Other(format!(
            "question read: {question_id} is not registered to this box for run {run_id}"
        )));
    }
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(format!("question read: {status}: {text}")));
    }
    let parsed: AnswerReply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("question read decode: {e}")))?;
    Ok(parsed.answer)
}

#[cfg(test)]
mod tests {
    use super::*;

    // cm:guard decoded from a LITERAL body rather than round-tripped through the Rust type, because the claim is about core's shape: `camelCase` renames VARIANTS and not fields, so a missing `rename_all` here does not fail the decode — every field silently arrives as its default and an answered question reads as unanswered forever.
    #[test]
    fn an_answer_from_core_decodes_every_field_the_box_acts_on() {
        let body = r#"{"answer":{"questionId":"q-1","optionId":"opt-b","answeredAt":"2026-09-08T10:00:00.000Z","answeredBy":"u-1","round":3}}"#;
        let parsed: AnswerReply = serde_json::from_str(body).expect("core's own shape must decode");
        let a = parsed.answer.expect("an answer was sent");
        assert_eq!(a.option_id, "opt-b");
        assert_eq!(a.round, Some(3));
        assert_eq!(a.answered_by.as_deref(), Some("u-1"));
    }

    // cm:guard `null` is the ordinary state of a question and must decode to `None`, not to an error: this read runs on every pass while a human has not chosen, so a decode failure here would turn every unanswered question into a fault the box reports.
    #[test]
    fn an_unanswered_question_decodes_as_none() {
        let parsed: AnswerReply = serde_json::from_str(r#"{"answer":null}"#).unwrap();
        assert!(parsed.answer.is_none());
    }

    // cm:guard a step that carries no `answeredAt`/`answeredBy` still decodes, because the two are stamped by whoever answered and a machine answer may carry neither. Requiring them would make the box refuse the answers it can act on soonest.
    #[test]
    fn an_answer_missing_its_stamps_still_decodes() {
        let parsed: AnswerReply =
            serde_json::from_str(r#"{"answer":{"questionId":"q","optionId":"o"}}"#).unwrap();
        let a = parsed.answer.unwrap();
        assert_eq!(a.option_id, "o");
        assert_eq!(a.answered_at, None);
    }

    #[test]
    fn the_ask_reply_carries_the_id_core_echoes() {
        let parsed: AskReply = serde_json::from_str(r#"{"questionId":"q-9"}"#).unwrap();
        assert_eq!(parsed.question_id, "q-9");
    }

    /// One request, one canned response, then gone. Enough to hold a claim
    /// about a STATUS CODE, which no decode test can reach.
    async fn one_shot(status: &str, body: &str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        format!("http://{addr}")
    }

    // cm:guard the falsifying case for the 404 rule, and only a real status code can carry it: `answer: null` is UNANSWERED and a 404 is NOT THIS BOX'S QUESTION. Collapse them and a question registered to another box reads as one this box is still waiting for, forever, with nothing anywhere saying why (ISS-964 criterion 12).
    #[tokio::test]
    async fn a_question_this_box_is_not_the_waiter_for_is_an_error_not_an_empty_answer() {
        let base = one_shot("404 Not Found", r#"{"error":"question"}"#).await;
        let client = CoreClient::new(base, "tok");
        let err = answer(&client, "q-1", "run-1")
            .await
            .expect_err("a 404 must not read as `not answered yet`");
        assert!(format!("{err}").contains("not registered"), "{err}");
    }

    // cm:guard the pair of the case above: the SAME call on a 200 carrying `null` must be `None`, because that is the state the box polls through while a human has not chosen.
    #[tokio::test]
    async fn an_unanswered_question_on_a_live_route_reads_as_none() {
        let base = one_shot("200 OK", r#"{"answer":null}"#).await;
        let client = CoreClient::new(base, "tok");
        assert_eq!(answer(&client, "q-1", "run-1").await.unwrap(), None);
    }

    // cm:guard a 401 is `Unauthorized` and NOT a generic failure, because that is the one outcome the caller must react to by re-authenticating rather than by retrying the same token (`transport/runners.rs` holds the same rule).
    #[tokio::test]
    async fn an_expired_credential_is_reported_as_unauthorized() {
        let base = one_shot("401 Unauthorized", r#"{"error":"nope"}"#).await;
        let client = CoreClient::new(base, "tok");
        assert!(matches!(
            answer(&client, "q-1", "run-1").await,
            Err(Error::Unauthorized)
        ));
    }

    #[tokio::test]
    async fn an_ask_that_core_refuses_names_the_status_and_the_body() {
        let base = one_shot("400 Bad Request", r#"{"error":"prompt required"}"#).await;
        let client = CoreClient::new(base, "tok");
        let err = ask(
            &client,
            Ask {
                id: "q-1",
                project_id: "p-1",
                run_id: "run-1",
                issue_id: None,
                agent_session_id: None,
                prompt: "",
                blocker_kind: "human",
                options: serde_json::json!([]),
                recommended_option_id: "",
                assumed: None,
                cost: None,
            },
        )
        .await
        .expect_err("a refusal must reach the caller");
        let text = format!("{err}");
        assert!(
            text.contains("400") && text.contains("prompt required"),
            "{text}"
        );
    }
}
