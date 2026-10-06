//! Which of a project's feedback items owe its master a triage.
//!
//! A `master.wake` with `source: "feedback"` says only that a high or critical
//! item was filed; core's room has no buffer, so the sweep reads this state on
//! every pass and an untriaged item is master work whether or not its wake was
//! heard. Which items are owed — the severities, the statuses, an open
//! clarification waiting on the reporter — is core's answer, from
//! `feedback/device-owed-routes.ts`; this box carries it and decides none of it.

use crate::channel_inbox::UnansweredDocument;
use crate::CoreClient;
use runner_platform::error::Result;
use serde::Deserialize;

/// The type an owed triage is carried under beside the channel's documents.
pub const FEEDBACK_TRIAGE_TYPE: &str = "feedback-triage";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwedTriage {
    feedback_id: String,
    key: String,
}

#[derive(Debug, Deserialize)]
struct OwedResponse {
    items: Vec<OwedTriage>,
}

impl OwedResponse {
    fn into_work(self) -> Vec<UnansweredDocument> {
        self.items
            .into_iter()
            .map(|f| UnansweredDocument {
                id: f.feedback_id,
                number: Some(f.key),
                r#type: Some(FEEDBACK_TRIAGE_TYPE.into()),
                from: None,
                overdue: false,
            })
            .collect()
    }
}

pub async fn owed(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let path = format!("/api/devices/me/feedback/owed?projectId={project_id}");
    let parsed: OwedResponse = crate::status::fetch(client.get(&path), "feedback inbox").await?;
    Ok(parsed.into_work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_owed_triage_is_carried_under_its_key() {
        let parsed: OwedResponse = serde_json::from_str(
            r#"{"projectId":"p","items":[{"feedbackId":"f2","key":"FB-2","title":"t","severity":"high","status":"new"}],"count":1}"#,
        )
        .unwrap();
        let work = parsed.into_work();
        assert_eq!(work.len(), 1);
        assert_eq!(work[0].id, "f2");
        assert_eq!(work[0].number.as_deref(), Some("FB-2"));
        assert_eq!(work[0].r#type.as_deref(), Some(FEEDBACK_TRIAGE_TYPE));
    }
}
