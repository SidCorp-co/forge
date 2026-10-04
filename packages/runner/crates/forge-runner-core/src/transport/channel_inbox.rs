//! What a project's ecosystem channel owes a reply to (ISS-38).
//!
//! A `master.wake` with `source: "channel"` says only that the channel moved;
//! core's room has no buffer, so the sweep reads this state on every pass and
//! a document is work for the master whether or not its wake was heard. Core
//! answers it from `ecosystem/device-channel-inbox-routes.ts`.

use super::CoreClient;
use crate::error::{Error, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UnansweredDocument {
    pub id: String,
    #[serde(default)]
    pub number: Option<String>,
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub overdue: bool,
}

/// The type an open builder run is carried under beside the channel's documents (ISS-39).
pub const BUILDER_RUN_TYPE: &str = "builder-run";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenBuilderRun {
    id: String,
    ecosystem: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UnansweredResponse {
    items: Vec<UnansweredDocument>,
    /// Priced amnesty: a core before ISS-39 sends no `builderRuns`, read as none
    /// open; it ends once every paired core serves it.
    #[serde(default)]
    builder_runs: Vec<OpenBuilderRun>,
}

impl UnansweredResponse {
    /// The channel's documents, then each open builder run as one more piece of master work.
    fn into_work(self) -> Vec<UnansweredDocument> {
        let runs = self.builder_runs.into_iter().map(|r| UnansweredDocument {
            id: r.id,
            number: None,
            r#type: Some(BUILDER_RUN_TYPE.into()),
            from: Some(r.ecosystem),
            overdue: false,
        });
        self.items.into_iter().chain(runs).collect()
    }
}

pub async fn unanswered(client: &CoreClient, project_id: &str) -> Result<Vec<UnansweredDocument>> {
    let url = client.url(&format!(
        "/api/devices/me/channel/unanswered?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("channel inbox request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "channel inbox",
            code,
            &text,
        )));
    }
    let parsed: UnansweredResponse = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("channel inbox decode: {e}")))?;
    Ok(parsed.into_work())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_document_keeps_its_number_and_ignores_fields_core_adds_later() {
        let raw = serde_json::json!({
            "items": [{ "id": "d1", "number": "FP-CR-1", "type": "change-request",
                        "from": "p2", "overdue": true, "subjectAddedLater": "x" }]
        });
        let parsed: UnansweredResponse = serde_json::from_value(raw).unwrap();
        assert_eq!(parsed.items[0].number.as_deref(), Some("FP-CR-1"));
        assert!(parsed.items[0].overdue);
    }

    #[test]
    fn a_response_without_items_is_refused_rather_than_read_as_nothing_owed() {
        let parsed: std::result::Result<UnansweredResponse, _> =
            serde_json::from_value(serde_json::json!({}));
        assert!(
            parsed.is_err(),
            "an answer that does not say what is owed must not read as an empty inbox"
        );
    }

    #[test]
    fn an_open_builder_run_is_master_work_beside_the_documents() {
        let raw = serde_json::json!({
            "items": [{ "id": "d1", "number": "FP-CR-1" }],
            "builderRuns": [{ "id": "r1", "ecosystem": "e1", "trigger": { "kind": "joined" } }]
        });
        let work = serde_json::from_value::<UnansweredResponse>(raw)
            .unwrap()
            .into_work();
        assert_eq!(work.len(), 2);
        assert_eq!(work[1].id, "r1");
        assert_eq!(work[1].r#type.as_deref(), Some(BUILDER_RUN_TYPE));
    }

    #[tokio::test]
    async fn a_core_without_the_route_is_a_failed_read_naming_it() {
        let url = super::super::fake_core::serve_always("404 Not Found", "{}").await;
        let failed = unanswered(&CoreClient::new(url, "device-token"), "p1")
            .await
            .expect_err("a core that does not serve the inbox has not said nothing is owed");
        assert!(failed.to_string().contains("channel inbox"), "{failed}");
    }

    #[tokio::test]
    async fn a_served_inbox_reads_back_its_documents() {
        let url = super::super::fake_core::serve_always(
            "200 OK",
            r#"{"projectId":"p1","items":[{"id":"d1","number":"FP-RFI-2"}],"count":1}"#,
        )
        .await;
        let got = unanswered(&CoreClient::new(url, "device-token"), "p1")
            .await
            .unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].number.as_deref(), Some("FP-RFI-2"));
    }
}
