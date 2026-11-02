//! The files a person attaches to a chat turn (ISS-499): downloaded to a temp dir of the turn's
//! own, pointed at from the prompt, and removed once the turn ends.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use uuid::Uuid;

use runner_transport::CoreClient;

/// A file attached to a chat turn (ISS-499). Core sends these on the
/// `agent:start` / `agent:send` frame; `url` is a core-relative download path
/// the runner pulls with its device token (the download route is auth-gated).
#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AttachmentRef {
    id: String,
    name: String,
    url: String,
}

/// Download a turn's attachments to a fresh temp dir, authenticated with the
/// runner's device token (the download route is auth-gated — `WebFetch` can't
/// pull anonymously). Returns `(staged_dir, local_paths)`. Best-effort: a file
/// that fails to download is logged and skipped, never fatal to the turn.
pub(crate) async fn stage_attachments(
    client: &CoreClient,
    session_id: &str,
    refs: &[AttachmentRef],
) -> Option<(PathBuf, Vec<PathBuf>)> {
    if refs.is_empty() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("forge-attach-{session_id}-{}", Uuid::new_v4()));
    if let Err(e) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!("[chat {session_id}] attach: mkdir failed: {e}");
        return None;
    }
    let mut paths: Vec<PathBuf> = Vec::new();
    for att in refs {
        let url = client.url(&att.url);
        let bytes = match client
            .http()
            .get(&url)
            .bearer_auth(client.device_token())
            .timeout(runner_transport::LONG_DEADLINE)
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => match r.bytes().await {
                Ok(b) => b,
                Err(e) => {
                    tracing::warn!("[chat {session_id}] attach {}: read body: {e}", att.name);
                    continue;
                }
            },
            Ok(r) => {
                tracing::warn!(
                    "[chat {session_id}] attach {}: http {}",
                    att.name,
                    r.status()
                );
                continue;
            }
            Err(e) => {
                tracing::warn!("[chat {session_id}] attach {}: {e}", att.name);
                continue;
            }
        };
        // Keep the original extension (claude infers image type from it) and
        // prefix with a short id slice so same-named files don't collide.
        let safe = att.name.replace(['/', '\\'], "_");
        let prefix = &att.id[..att.id.len().min(8)];
        let path = dir.join(format!("{prefix}_{safe}"));
        if let Err(e) = tokio::fs::write(&path, &bytes).await {
            tracing::warn!("[chat {session_id}] attach {}: write: {e}", att.name);
            continue;
        }
        paths.push(path);
    }
    if paths.is_empty() {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return None;
    }
    Some((dir, paths))
}

/// Append a trailing section to the prompt pointing claude at the local files,
/// so it `Read`s them (image vision + text/PDF) within the turn. When the user
/// sent files with no caption (files-only turn), seed a default instruction so
/// claude has something to act on instead of an empty prompt.
pub(crate) fn augment_prompt(prompt: &str, paths: &[PathBuf]) -> String {
    let mut out = if prompt.trim().is_empty() {
        String::from("The user attached the following file(s) with no message. Look at each and describe / summarize its contents.")
    } else {
        String::from(prompt)
    };
    out.push_str(
        "\n\n[Attached files — read each with the Read tool; these are local paths on this machine]\n",
    );
    for p in paths {
        out.push_str("- ");
        out.push_str(&p.to_string_lossy());
        out.push('\n');
    }
    out
}

/// Remove a turn's staged-attachment temp dir (best-effort).
pub(crate) async fn cleanup_attachments(dir: Option<&Path>) {
    if let Some(dir) = dir {
        if let Err(e) = tokio::fs::remove_dir_all(dir).await {
            tracing::debug!("[chat] attach cleanup {}: {e}", dir.display());
        }
    }
}
