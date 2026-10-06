//! Which of a project's returned designs owe its master a revision.
//!
//! A `master.wake` with `source: "workflow_design"` says only that an approver
//! decided a design; core's room has no buffer, so the sweep reads this state
//! on every pass and a returned design is master work whether or not its wake
//! was heard. Which returns are owed — those no live issue carries, until the
//! next revision is proposed — is core's answer, from
//! `workflows/device-owed-routes.ts`; this box carries it and decides none of it.

use crate::channel_inbox::UnansweredDocument;
use crate::CoreClient;
use runner_platform::error::Result;
use serde::Deserialize;

/// The type an owed design revision is carried under beside the channel's documents.
pub const DESIGN_REVISION_TYPE: &str = "design-revision";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedRevision {
    workflow_id: String,
    flow: String,
    revision: u32,
}

#[derive(Debug, Deserialize)]
struct OwedResponse {
    items: Vec<OwedRevision>,
}

impl OwedResponse {
    fn into_work(self) -> Vec<UnansweredDocument> {
        self.items
            .into_iter()
            .map(|d| UnansweredDocument {
                id: d.workflow_id,
                number: Some(format!("{} r{}", d.flow, d.revision)),
                r#type: Some(DESIGN_REVISION_TYPE.into()),
                from: None,
                overdue: false,
            })
            .collect()
    }
}

pub async fn owed(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let path = format!("/api/devices/me/designs/owed?projectId={project_id}");
    let parsed: OwedResponse = crate::status::fetch(client.get(&path), "design inbox").await?;
    Ok(parsed.into_work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owed_revision_is_carried_under_its_flow_and_returned_revision() {
        let parsed: OwedResponse = serde_json::from_str(
            r#"{"projectId":"p","items":[{"workflowId":"w1","flow":"catalog-context","revision":1,"reason":"r","returnedAt":"2026-10-06T15:32:35Z"}],"count":1}"#,
        )
        .unwrap();
        let work = parsed.into_work();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id, "w1");
        assert_eq!(work[0].number.as_deref(), Some("catalog-context r1"));
        assert_eq!(work[0].r#type.as_deref(), Some(DESIGN_REVISION_TYPE));
    }
}
