//! What a project's issue threads owe a person a reply to.
//!
//! A `master.wake` with `source: "comment"` says only that a person spoke on
//! an issue; core's room has no buffer, so the sweep reads this state on every
//! pass and an owed comment is work for the master at any issue status, whether
//! or not its wake was heard. Core answers it from
//! `devices/comment-inbox-routes.ts`.

use super::channel_inbox::UnansweredDocument;
use super::CoreClient;
use crate::error::{Error, Result};
use serde::Deserialize;

/// The type an owed comment is carried under beside the channel's documents.
pub const ISSUE_COMMENT_TYPE: &str = "issue-comment";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedComment {
    issue_key: String,
    comment_id: String,
    #[serde(default)]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OwedResponse {
    items: Vec<OwedComment>,
}

impl OwedResponse {
    /// Each owed comment as one more piece of master work, named by its issue.
    fn into_work(self) -> Vec<UnansweredDocument> {
        self.items
            .into_iter()
            .map(|c| UnansweredDocument {
                id: c.comment_id,
                number: Some(c.issue_key),
                r#type: Some(ISSUE_COMMENT_TYPE.into()),
                from: c.status,
                overdue: false,
            })
            .collect()
    }
}

pub async fn unanswered(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let url = client.url(&format!(
        "/api/devices/me/comments/unanswered?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("comment inbox request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "comment inbox",
            code,
            &text,
        )));
    }
    let parsed: OwedResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("comment inbox decode: {e}")))?;
    Ok(parsed.into_work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owed_comment_is_work_named_by_its_issue() {
        let raw = serde_json::json!({
            "projectId": "p1", "count": 1,
            "items": [{ "issueId": "i1", "issueKey": "ISS-7", "status": "developed",
                        "commentId": "c1", "authorId": "u1", "createdAt": "2026-10-03T09:01:00Z" }]
        });
        let work = serde_json::from_value::<OwedResponse>(raw)
            .unwrap()
            .into_work();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id, "c1");
        assert_eq!(work[0].number.as_deref(), Some("ISS-7"));
        assert_eq!(work[0].r#type.as_deref(), Some(ISSUE_COMMENT_TYPE));
    }

    #[test]
    fn a_response_without_items_is_refused_rather_than_read_as_nothing_owed() {
        assert!(serde_json::from_value::<OwedResponse>(serde_json::json!({})).is_err());
    }

    #[tokio::test]
    async fn a_core_without_the_route_is_a_failed_read_naming_it() {
        let url = super::super::fake_core::serve_always("404 Not Found", "{}").await;
        let failed = unanswered(&CoreClient::new(url, "device-token"), "p1")
            .await
            .expect_err("a core that does not serve the inbox has not said nothing is owed");
        assert!(failed.to_string().contains("comment inbox"), "{failed}");
    }

    #[tokio::test]
    async fn a_served_inbox_reads_back_its_comments() {
        let url = super::super::fake_core::serve_always(
            "200 OK",
            r#"{"projectId":"p1","items":[{"issueKey":"ISS-9","commentId":"c9"}],"count":1}"#,
        )
        .await;
        let got = unanswered(&CoreClient::new(url, "device-token"), "p1")
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].number.as_deref(), Some("ISS-9"));
    }
}
