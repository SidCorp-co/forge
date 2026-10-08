//! `compute.run`: core hands this box one computation's script and the frames it reads
//! (REQ-32 BC-14).
//!
//! Core chose this box because its heartbeat said it confines a script, and decided the limits;
//! this runs the script in its own sandbox (`runner_platform::confine::compute`) and answers what
//! it did, or why it could not run it. Core reads the output as frames.

use runner_platform::confine::compute::{self, Request};
use runner_transport::CoreClient;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::checkout_frame::{serve, Channel, Frame};

/// The most of an error core takes back; past it the answer would be refused and core wait it out.
const ERROR_CAP: usize = 1900;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ComputeFrame {
    request_id: String,
    project_id: String,
    #[serde(default)]
    runner_id: Option<String>,
    #[serde(flatten)]
    request: Request,
}

impl Frame for ComputeFrame {
    fn request_id(&self) -> &str {
        &self.request_id
    }
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn runner_id(&self) -> Option<&str> {
        self.runner_id.as_deref()
    }
}

pub(crate) async fn handle(client: &CoreClient, data: Value) {
    serve(
        client,
        Channel::Compute,
        data,
        async |frame: &ComputeFrame| {
            tracing::info!(
                "[compute] project={} request={}: running a {:?} script confined",
                frame.project_id,
                frame.request_id,
                frame.request.language
            );
            let answer = compute::run(&frame.request).await.map_err(capped)?;
            let mut body = serde_json::to_value(&answer).map_err(|e| e.to_string())?;
            body["projectId"] = json!(frame.project_id);
            Ok(body)
        },
    )
    .await;
}

fn capped(error: String) -> String {
    if error.len() <= ERROR_CAP {
        return error;
    }
    let mut end = ERROR_CAP;
    while !error.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &error[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_request_this_box_refuses_is_answered_under_its_id_naming_why() {
        let (client, seen) = crate::checkout_frame::tests::fake_core().await;
        handle(
            &client,
            json!({
                "requestId": "r-9",
                "projectId": "p-9",
                "language": "bash",
                "script": "true",
                "inputs": [],
                "limits": { "wallMs": 0, "cpu": 1, "memoryMb": 512, "outputBytes": 1000 }
            }),
        )
        .await;
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!(seen[0].0, "/api/devices/me/compute-runs/r-9");
        let body: Value = serde_json::from_str(&seen[0].1).unwrap();
        assert_eq!(
            body,
            json!({
                "projectId": "p-9",
                "error": "this box refuses the request: limits.wallMs 0 is outside 1..=120000"
            })
        );
    }

    #[tokio::test]
    async fn a_frame_this_build_cannot_read_is_answered_naming_the_field() {
        let (client, seen) = crate::checkout_frame::tests::fake_core().await;
        handle(
            &client,
            json!({ "requestId": "r-8", "projectId": "p-8", "language": "ruby", "script": "1" }),
        )
        .await;
        let seen = seen.lock().unwrap().clone();
        let body: Value = serde_json::from_str(&seen[0].1).unwrap();
        let error = body["error"].as_str().unwrap();
        assert!(
            error.starts_with("the compute.run frame could not be decoded by forge-runner "),
            "{error}"
        );
        assert!(error.contains("ruby"), "{error}");
    }

    #[test]
    fn a_long_error_is_cut_on_a_character_boundary() {
        let long = "é".repeat(2000);
        let cut = capped(long);
        assert!(cut.len() <= ERROR_CAP + "…".len(), "{}", cut.len());
        assert!(cut.ends_with('…'));
    }
}
