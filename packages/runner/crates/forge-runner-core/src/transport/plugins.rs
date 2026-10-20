//! Server-designated plugins: `GET /api/devices/me/plugins`.
//!
//! The server resolves the UNION of the plugin designations of every project this device is bound
//! to (`projects.agent_config.plugins`), because a Claude Code plugin installs at device scope —
//! one install serves every job. The local `[plugins]` block in
//! config.toml stays authoritative for whether the sweep runs at all, so an operator keeps a kill
//! switch that no server-side change can flip.

use serde::Deserialize;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignatedPlugin {
    pub marketplace: String,
    pub name: String,
    #[serde(default)]
    pub pinned_ref: Option<String>,
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// Slugs of the bound projects that asked for it — logged, so an operator can see why a
    /// plugin appeared on this device without reading the server's DB.
    #[serde(default)]
    pub projects: Vec<String>,
    /// Present when bound projects pinned different SHAs; the server then sends no pin rather
    /// than silently picking one.
    #[serde(default)]
    pub pinned_ref_conflict: Option<Vec<String>>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
struct MePluginsResponse {
    #[serde(default)]
    plugins: Vec<DesignatedPlugin>,
}

pub async fn list_designated(client: &CoreClient) -> Result<Vec<DesignatedPlugin>> {
    let url = client.url("/api/devices/me/plugins");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("me/plugins request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    // A core that predates this route designates nothing, which is what an empty list says; any
    // other 404 is a refusal like the rest, read by its code and never by its status alone.
    if resp.status().as_u16() == 404 {
        let text = resp.text().await.unwrap_or_default();
        if super::status::route_absent(404, &text) {
            return Ok(Vec::new());
        }
        return Err(Error::Other(super::status::refused(
            "me/plugins",
            404,
            &text,
        )));
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "me/plugins",
            code,
            &text,
        )));
    }
    resp.json::<MePluginsResponse>()
        .await
        .map(|r| r.plugins)
        .map_err(|e| Error::Other(format!("me/plugins decode: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake_core;

    /// ISS-1421 r16 — every 404 read alike: an empty list for any of them. A
    /// core that predates the route designates nothing; any other 404 is a
    /// refusal, told apart by its code.
    #[tokio::test]
    async fn only_a_route_core_does_not_serve_reads_as_no_plugins() {
        let absent = fake_core::serve_always(
            "404 Not Found",
            r#"{"code":"ROUTE_ABSENT","message":"No route answers GET /api/devices/me/plugins."}"#,
        )
        .await;
        let none = list_designated(&CoreClient::new(absent, "tok"))
            .await
            .expect("a core without the route designates nothing");
        assert!(none.is_empty());

        let other = fake_core::serve_always(
            "404 Not Found",
            r#"{"code":"NOT_FOUND","message":"No device has this token."}"#,
        )
        .await;
        let err = list_designated(&CoreClient::new(other, "tok"))
            .await
            .expect_err("a 404 that is not a missing route is a refusal");
        assert!(format!("{err}").contains("404"), "{err}");
    }
}
