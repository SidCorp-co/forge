//! What a project's issue threads owe a person a reply to.
//!
//! A `master.wake` with `source: "comment"` says only that a person spoke on
//! an issue; core's room has no buffer, so the sweep reads this state on every
//! pass and an owed comment is work for the master at any issue status, whether
//! or not its wake was heard. Core answers it from
//! `devices/comment-inbox-routes.ts`.

use crate::channel_inbox::UnansweredDocument;
use crate::CoreClient;
use runner_platform::error::Result;
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
    let path = format!("/api/devices/me/comments/unanswered?projectId={project_id}");
    let parsed: OwedResponse = crate::status::fetch(client.get(&path), "comment inbox").await?;
    Ok(parsed.into_work())
}
