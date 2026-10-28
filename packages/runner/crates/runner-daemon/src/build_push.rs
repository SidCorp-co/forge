//! `build.push`: core asks this box to commit what a support room's session changed in the room's
//! working copy and push it (REQ-75 r5 BC-27), after a confirmer the room's grant names confirmed
//! the build in the room. The rules a build keeps are `runner_agent::support_build`'s; this reads
//! the frame and answers it.

use runner_agent::chat_checkout::working_copy;
use runner_agent::support_build::{push, BuildRequest};
use runner_platform::config::Config;
use runner_transport::CoreClient;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::checkout_frame::{serve, Channel, Frame};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BuildPushFrame {
    request_id: String,
    project_id: String,
    build_key: String,
    base: String,
    branch: String,
    title: String,
    body: String,
    #[serde(default)]
    runner_id: Option<String>,
}

impl Frame for BuildPushFrame {
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
        Channel::SupportBuild,
        data,
        async |frame: &BuildPushFrame| {
            let cfg =
                Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
            if !cfg
                .bindings
                .values()
                .any(|b| b.project_id.as_deref() == Some(frame.project_id.as_str()))
            {
                return Err(format!(
                    "this box binds no checkout to project {}, so it builds nothing for it",
                    frame.project_id
                ));
            }
            if !key_ok(&frame.build_key) {
                return Err(format!(
                    "{:?} is not a working copy's key: letters, digits and -, 1 to 64",
                    frame.build_key
                ));
            }
            let base_dir = runner_platform::config::base_dir()
                .map_err(|e| format!("this box cannot name its working copies' folder: {e}"))?;
            let wc = working_copy(&base_dir, &frame.build_key);
            let built = push(&BuildRequest {
                working_copy: &wc,
                base: &frame.base,
                branch: &frame.branch,
                title: &frame.title,
                body: &frame.body,
            })
            .await?;
            Ok(json!({
                "projectId": frame.project_id,
                "branch": built.branch,
                "base": built.base,
                "sha": built.sha,
                "files": built.files,
            }))
        },
    )
    .await;
}

fn key_ok(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_never_names_a_path_out_of_the_working_copies() {
        assert!(key_ok("f5f1e7ef-0f00-40ae-bd3e-0180094dc338"));
        for bad in ["", "../x", "a/b", "a b", &"x".repeat(65)] {
            assert!(!key_ok(bad), "{bad:?}");
        }
    }

    #[test]
    fn the_frame_core_sends_decodes() {
        let f: BuildPushFrame = serde_json::from_value(json!({
            "requestId": "r1", "projectId": "p1", "buildKey": "room-1", "base": "dev",
            "branch": "fix/x1", "title": "t", "body": "b"
        }))
        .unwrap();
        assert_eq!(f.branch, "fix/x1");
        assert_eq!(f.request_id(), "r1");
    }
}
