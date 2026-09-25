//! One project's declared MCP servers, resolved: `GET /api/devices/me/mcp-servers`.
//!
//! Core owns the resolution — catalog shorthand expanded, integration sentinels
//! turned into specs with freshly rendered credentials — because the box holds
//! none of the keys that takes. What arrives here is what `claude` can be handed
//! verbatim, plus the names that were declared and could NOT be supplied.

use serde::Deserialize;
use serde_json::Value;
use std::time::Duration;

use super::CoreClient;
use crate::error::{Error, Result};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMcpServers {
    /// Name → full server spec, ready to write into an MCP config document.
    #[serde(default)]
    pub mcp_servers: serde_json::Map<String, Value>,
    /// The names in `mcp_servers`, as core resolved them.
    #[serde(default)]
    pub resolved_names: Vec<String>,
    #[serde(default)]
    pub dropped_names: Vec<String>,
}

impl ProjectMcpServers {
    /// Nothing to write and nothing to say — the shape a project that declares
    /// no servers has.
    pub fn is_empty(&self) -> bool {
        self.mcp_servers.is_empty() && self.dropped_names.is_empty()
    }
}

/// How long the read may take before it is a failed read. The client carries no
/// deadline of its own, and this read sits on the master sweep's path, so a
/// peer that accepts the connection and never answers would hold the sweep for
/// every project behind it. The pool's value, under the heartbeat's 30s.
pub const CALL_DEADLINE: Duration = Duration::from_secs(15);

pub async fn fetch(client: &CoreClient, project_id: &str) -> Result<ProjectMcpServers> {
    fetch_within(client, project_id, CALL_DEADLINE).await
}

/// [`fetch`], with the deadline a test can shorten.
///
/// Every answer but a success is a failed read, 404 included. A 404 used to be
/// read as a project declaring nothing, for a core older than the route; a
/// master started on that reading carried none of the servers the project did
/// declare, and nothing recorded why (ISS-1235). Core answers 403 for a box
/// not bound to the project, so a 404 here is a hop that does not serve the
/// route, and that is a read which did not happen.
pub async fn fetch_within(
    client: &CoreClient,
    project_id: &str,
    deadline: Duration,
) -> Result<ProjectMcpServers> {
    let url = client.url(&format!(
        "/api/devices/me/mcp-servers?projectId={project_id}"
    ));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "{ROUTE} request: {}",
                super::status::unanswered(&e, deadline)
            ))
        })?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let mut reason = super::status::refused(ROUTE, status, &text);
        if status == 401 {
            reason.push_str(" — the device token was refused; `forge-runner login`");
        }
        return Err(Error::Other(reason));
    }
    resp.json::<ProjectMcpServers>().await.map_err(|e| {
        Error::Other(format!(
            "{ROUTE} response: {}",
            super::status::unanswered(&e, deadline)
        ))
    })
}

/// The route as every failure of it is named.
const ROUTE: &str = "me/mcp-servers";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake_core;

    const GATEWAY_PAGE: &str = "<!DOCTYPE html>\n<html>\n<head><title>origin error</title></head>\n<body>error code: 520</body>\n</html>";

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, "device-token")
    }

    async fn failed(status: &'static str, body: &'static str) -> String {
        let url = fake_core::serve_always(status, body).await;
        fetch(&client(url), "p1")
            .await
            .expect_err("a non-success answer is a failed read")
            .to_string()
    }

    /// ISS-1235, the two measured codes: each reads as its own fault, carrying
    /// the route, and the gateway's whole page is folded to one line.
    #[tokio::test]
    async fn a_gateway_answer_is_a_failed_read_naming_the_route_and_its_own_status() {
        let origin = failed("520 Origin Error", GATEWAY_PAGE).await;
        let handshake = failed("525 Handshake", GATEWAY_PAGE).await;
        assert!(
            origin
                .starts_with("me/mcp-servers 520 (gateway: the origin returned an unknown error)"),
            "{origin}"
        );
        assert!(
            handshake.starts_with(
                "me/mcp-servers 525 (gateway: the TLS handshake with the origin failed)"
            ),
            "{handshake}"
        );
        for line in [&origin, &handshake] {
            assert!(!line.contains("unknown status code"), "{line}");
            assert!(!line.contains('\n'), "one line: {line}");
        }
    }

    /// A 404 is a read that did not happen, never a project that declares
    /// nothing: read as empty, it started a master with none of the servers the
    /// project did declare.
    #[tokio::test]
    async fn a_404_is_a_failed_read_and_never_the_empty_declaration() {
        assert_eq!(
            failed("404 Not Found", "").await,
            "me/mcp-servers 404 Not Found"
        );
    }

    #[tokio::test]
    async fn a_refused_token_is_named_with_the_way_out() {
        let line = failed("401 Unauthorized", "{}").await;
        assert!(
            line.starts_with("me/mcp-servers 401 Unauthorized: {}"),
            "{line}"
        );
        assert!(line.contains("`forge-runner login`"), "{line}");
    }

    /// Criterion 5: a peer that accepts and never answers fails at the deadline
    /// instead of holding the master sweep behind it.
    #[tokio::test]
    async fn a_read_the_peer_never_answers_fails_at_its_deadline() {
        let url = fake_core::serve_silent().await;
        let e = tokio::time::timeout(
            Duration::from_secs(10),
            fetch_within(&client(url), "p1", Duration::from_millis(300)),
        )
        .await
        .expect("a silent peer held the read past its deadline")
        .expect_err("no answer is a failed read, not a declaration");
        assert_eq!(
            e.to_string(),
            "me/mcp-servers request: timed out after 300ms"
        );
    }

    #[test]
    fn the_production_deadline_is_fifteen_seconds() {
        assert_eq!(CALL_DEADLINE, Duration::from_secs(15));
    }

    #[tokio::test]
    async fn a_read_nobody_answers_names_the_cause_and_not_the_url() {
        let e = fetch(&client("http://127.0.0.1:1".to_string()), "p1")
            .await
            .expect_err("a refused connection is a failed read")
            .to_string();
        assert!(
            e.starts_with("me/mcp-servers request: could not connect: "),
            "{e}"
        );
        assert!(!e.contains("projectId="), "the url is not the cause: {e}");
    }

    #[tokio::test]
    async fn a_success_is_the_declaration() {
        let url = fake_core::serve_always(
            "200 OK",
            r#"{"mcpServers":{"playwright":{"type":"stdio"}},"resolvedNames":["playwright"],"droppedNames":[]}"#,
        )
        .await;
        let found = fetch(&client(url), "p1").await.expect("a 200 is read");
        assert_eq!(found.resolved_names, vec!["playwright".to_string()]);
    }

    #[tokio::test]
    async fn a_success_whose_body_does_not_decode_is_a_failed_read() {
        let url = fake_core::serve_always("200 OK", "not json").await;
        let e = fetch(&client(url), "p1").await.unwrap_err().to_string();
        assert!(e.starts_with("me/mcp-servers response: "), "{e}");
    }

    #[test]
    fn a_response_missing_every_field_is_the_empty_shape() {
        let parsed: ProjectMcpServers = serde_json::from_str("{}").unwrap();
        assert!(parsed.is_empty());
        assert!(parsed.dropped_names.is_empty());
        assert!(parsed.resolved_names.is_empty());
    }

    #[test]
    fn the_camel_case_wire_names_decode_into_the_snake_case_fields() {
        let parsed: ProjectMcpServers = serde_json::from_str(
            r#"{"mcpServers":{"playwright":{"type":"stdio","command":"npx"}},
                "resolvedNames":["playwright"],"droppedNames":["epodsystem"]}"#,
        )
        .unwrap();
        assert_eq!(parsed.mcp_servers["playwright"]["command"], "npx");
        assert_eq!(parsed.resolved_names, vec!["playwright".to_string()]);
        assert_eq!(parsed.dropped_names, vec!["epodsystem".to_string()]);
        assert!(!parsed.is_empty());
    }

    /// A project that declares a sentinel nothing can supply has no servers to
    /// write and something to say, so it is NOT the empty shape.
    #[test]
    fn a_project_whose_only_declaration_dropped_is_not_empty() {
        let parsed: ProjectMcpServers =
            serde_json::from_str(r#"{"mcpServers":{},"droppedNames":["epodsystem"]}"#).unwrap();
        assert!(!parsed.is_empty());
    }
}
