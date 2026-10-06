//! Which of a project's agreed requirements owe its master a breakdown, and
//! which returned revisions owe it a revise.
//!
//! A `master.wake` with `source: "requirement"` says only that a requirement
//! was agreed; core's room has no buffer, so the sweep reads this state on
//! every pass and an agreed requirement is master work whether or not its wake
//! was heard. One past its breakdown SLA is carried as overdue, so a stalled
//! requirement is shown on the next pass. Core answers it from
//! `requirements/device-owed-routes.ts`.

use crate::channel_inbox::UnansweredDocument;
use crate::CoreClient;
use runner_platform::error::Result;
use serde::Deserialize;

/// The type an owed breakdown is carried under beside the channel's documents.
pub const REQUIREMENT_BREAKDOWN_TYPE: &str = "requirement-breakdown";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedBreakdown {
    requirement_id: String,
    key: String,
    #[serde(default)]
    overdue: bool,
}

#[derive(Debug, Deserialize)]
struct OwedResponse {
    items: Vec<OwedBreakdown>,
}

impl OwedResponse {
    fn into_work(self) -> Vec<UnansweredDocument> {
        self.items
            .into_iter()
            .map(|r| UnansweredDocument {
                id: r.requirement_id,
                number: Some(r.key),
                r#type: Some(REQUIREMENT_BREAKDOWN_TYPE.into()),
                from: None,
                overdue: r.overdue,
            })
            .collect()
    }
}

pub async fn owed(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let path = format!("/api/devices/me/requirements/owed?projectId={project_id}");
    let parsed: OwedResponse = crate::status::fetch(client.get(&path), "requirement inbox").await?;
    Ok(parsed.into_work())
}

/// The type a returned revision owed a revise is carried under.
pub const REQUIREMENT_REVISION_TYPE: &str = "requirement-revision";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReturnedRevision {
    requirement_id: String,
    key: String,
    revision: u32,
}

#[derive(Debug, Deserialize)]
struct ReturnedResponse {
    items: Vec<ReturnedRevision>,
}

impl ReturnedResponse {
    fn into_work(self) -> Vec<UnansweredDocument> {
        self.items
            .into_iter()
            .map(|r| UnansweredDocument {
                id: format!("{}#r{}", r.requirement_id, r.revision),
                number: Some(format!("{} r{}", r.key, r.revision)),
                r#type: Some(REQUIREMENT_REVISION_TYPE.into()),
                from: None,
                overdue: false,
            })
            .collect()
    }
}

/// Which agent-written revisions a signer returned, owed a revise by this
/// project's master; `requirement.returned` wakes it, and core answers it from
/// `requirements/owed-revisions.ts`.
pub async fn returned(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let path = format!("/api/devices/me/requirements/returned?projectId={project_id}");
    let parsed: ReturnedResponse =
        crate::status::fetch(client.get(&path), "returned requirement inbox").await?;
    Ok(parsed.into_work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_overdue_breakdown_is_carried_as_overdue_under_its_key() {
        let parsed: OwedResponse = serde_json::from_str(
            r#"{"projectId":"p","items":[{"requirementId":"r1","key":"REQ-3","title":"t","revision":2,"dueAt":"2026-10-01T00:00:00Z","overdue":true}],"count":1}"#,
        )
        .unwrap();
        let work = parsed.into_work();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].number.as_deref(), Some("REQ-3"));
        assert_eq!(work[0].r#type.as_deref(), Some(REQUIREMENT_BREAKDOWN_TYPE));
        assert!(work[0].overdue);
    }

    #[test]
    fn a_returned_revision_is_carried_under_its_key_and_revision() {
        let parsed: ReturnedResponse = serde_json::from_str(
            r#"{"projectId":"p","items":[{"requirementId":"r1","key":"REQ-2","title":"t","revision":3,"reason":"why"}],"count":1}"#,
        )
        .unwrap();
        let work = parsed.into_work();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id, "r1#r3");
        assert_eq!(work[0].number.as_deref(), Some("REQ-2 r3"));
        assert_eq!(work[0].r#type.as_deref(), Some(REQUIREMENT_REVISION_TYPE));
    }
}
