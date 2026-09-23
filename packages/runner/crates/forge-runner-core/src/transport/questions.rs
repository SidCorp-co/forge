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
    pub assumed: Option<serde_json::Value>,
    pub cost: Option<serde_json::Value>,
    pub sensitive: Option<bool>,
}

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
    if let Some(v) = req.answer_shape {
        body["answerShape"] = serde_json::json!(v);
    }
    if let Some(v) = req.needed {
        body["needed"] = serde_json::json!(v);
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
    let url = client.url(&format!("/api/devices/me/questions/{question_id}"));
    let resp = client
        .http()
        .get(&url)
        .query(&[("runId", run_id)])
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

    #[test]
    fn an_answer_from_core_decodes_every_field_the_box_acts_on() {
        let body = r#"{"answer":{"questionId":"q-1","optionId":"opt-b","answeredAt":"2026-09-08T10:00:00.000Z","answeredBy":"u-1","round":3}}"#;
        let parsed: AnswerReply = serde_json::from_str(body).expect("core's own shape must decode");
        let a = parsed.answer.expect("an answer was sent");
        assert_eq!(a.option_id.as_deref(), Some("opt-b"));
        assert_eq!(a.round, Some(3));
        assert_eq!(a.answered_by.as_deref(), Some("u-1"));
    }

    #[test]
    fn an_unanswered_question_decodes_as_none() {
        let parsed: AnswerReply = serde_json::from_str(r#"{"answer":null}"#).unwrap();
        assert!(parsed.answer.is_none());
    }

    #[test]
    fn an_answer_missing_its_stamps_still_decodes() {
        let parsed: AnswerReply =
            serde_json::from_str(r#"{"answer":{"questionId":"q","optionId":"o"}}"#).unwrap();
        let a = parsed.answer.unwrap();
        assert_eq!(a.option_id.as_deref(), Some("o"));
        assert_eq!(a.answered_at, None);
    }

    #[test]
    fn a_text_answer_decodes_with_no_option() {
        let body = r#"{"answer":{"questionId":"q-1","answerShape":"free_text","optionId":null,"text":"the second reading","answeredAt":"2026-09-13T10:00:00.000Z","answeredBy":"u-1","round":1}}"#;
        let parsed: AnswerReply = serde_json::from_str(body).expect("core's own shape must decode");
        let a = parsed.answer.expect("an answer was sent");
        assert_eq!(a.answer_shape.as_deref(), Some("free_text"));
        assert_eq!(a.option_id, None);
        assert_eq!(a.text.as_deref(), Some("the second reading"));
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

    #[tokio::test]
    async fn a_question_this_box_is_not_the_waiter_for_is_an_error_not_an_empty_answer() {
        let base = one_shot("404 Not Found", r#"{"error":"question"}"#).await;
        let client = CoreClient::new(base, "tok");
        let err = answer(&client, "q-1", "run-1")
            .await
            .expect_err("a 404 must not read as `not answered yet`");
        assert!(format!("{err}").contains("not registered"), "{err}");
    }

    #[tokio::test]
    async fn an_unanswered_question_on_a_live_route_reads_as_none() {
        let base = one_shot("200 OK", r#"{"answer":null}"#).await;
        let client = CoreClient::new(base, "tok");
        assert_eq!(answer(&client, "q-1", "run-1").await.unwrap(), None);
    }

    /// One request, one canned response, and the request line back — the only
    /// way to hold a claim about what reaches the server's query parser.
    async fn one_shot_capturing(
        status: &str,
        body: &str,
    ) -> (String, tokio::sync::oneshot::Receiver<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let resp = format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let (tx, rx) = tokio::sync::oneshot::channel();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
                let _ = sock.write_all(resp.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        (format!("http://{addr}"), rx)
    }

    /// A run identity is free text on core's side. Interpolated into the query
    /// string, `&` ends the parameter and `+` arrives as a space, so the waiter
    /// lookup misses a question this box really did ask.
    ///
    /// The expectations below are form-urlencoded, which is what the client's
    /// serializer emits and what core's router decodes: measured against hono,
    /// `runId=run%2B7` reads back as `run+7` and `runId=run+7` as `run 7`. So
    /// the round trip is exact, and core's side of it is held by
    /// `question-runner-wire-e2e.test.ts` rather than by this reading.
    #[tokio::test]
    async fn a_run_identity_carrying_query_syntax_reaches_the_server_unchanged() {
        for (run, encoded) in [
            ("run+7", "run%2B7"),
            ("run&7", "run%267"),
            ("run#7", "run%237"),
            ("run 7", "run+7"),
            ("run=7", "run%3D7"),
        ] {
            let (base, request) = one_shot_capturing("200 OK", r#"{"answer":null}"#).await;
            let client = CoreClient::new(base, "tok");
            answer(&client, "q-1", run).await.unwrap();
            let line = request.await.unwrap();
            let first = line.lines().next().unwrap_or_default().to_string();
            assert!(
                first.contains(&format!("runId={encoded}")),
                "`{run}` must reach the query parser as `{encoded}`: {first}"
            );
        }
    }

    #[tokio::test]
    async fn a_url_safe_run_identity_is_not_mangled_on_the_way_out() {
        let (base, request) = one_shot_capturing("200 OK", r#"{"answer":null}"#).await;
        let client = CoreClient::new(base, "tok");
        answer(&client, "q-1", "run-7").await.unwrap();
        let first = request
            .await
            .unwrap()
            .lines()
            .next()
            .unwrap_or("")
            .to_string();
        assert!(
            first.contains("/api/devices/me/questions/q-1?runId=run-7"),
            "{first}"
        );
    }

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
                answer_shape: None,
                options: serde_json::json!([]),
                recommended_option_id: "",
                needed: None,
                assumed: None,
                cost: None,
                sensitive: None,
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
