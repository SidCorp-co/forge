//! Runner assignment discovery + self-service repo-path update (ISS-271).
//!
//! - `list_me` — `GET /api/devices/me/runners`: which projects this device is
//!   bound to, with the server-side repo path/branch.
//! - `patch_runner` — `PATCH /api/devices/me/runners/:runnerId`: push this
//!   device's repo path/branch back to the server so web and CLI write the
//!   same source-of-truth field.

use std::time::Duration;

use super::{status, CoreClient, CALL_DEADLINE};
use crate::error::{Error, Result};
use serde::{Deserialize, Deserializer};

/// One `(device × project)` assignment as returned by `/me/runners`. Field
/// casing mirrors the core JSON (camelCase) — keep in lockstep with the
/// `MeRunnerAssignment` contract DTO in `packages/contracts`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeRunner {
    pub project_id: String,
    pub runner_id: String,
    pub slug: String,
    pub base_branch: Option<String>,
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub status: String,
    /// Prose from `projects.workspace_setup`: how to bring this repo's workspace
    /// to a state a stage can build, test and commit in. `None` on an older core
    /// or an undeclared project — the setup agent then derives it from the repo,
    /// which is the expensive path this field exists to retire.
    #[serde(default)]
    pub workspace_setup: Option<String>,
    #[serde(default)]
    pub master_policy: Option<String>,
    #[serde(default, deserialize_with = "lenient_seconds")]
    pub rate_limited_for_seconds: Option<u64>,
    /// Why core limited this runner (`usage_limit`, `auth`, …). Reported in the
    /// pass log so an operator can tell a 5-hour window from a dead credential.
    #[serde(default)]
    pub limit_reason: Option<String>,
}

/// List the projects this device is assigned to. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
///
/// This is the first call the master sweep makes, so a peer that accepts the
/// connection and never answers stopped the sweep for every project behind it
/// — no pool read, no registration, nothing recorded (ISS-1233).
pub async fn list_me(client: &CoreClient) -> Result<Vec<MeRunner>> {
    list_me_within(client, CALL_DEADLINE).await
}

/// [`list_me`], with the deadline a test can shorten.
pub async fn list_me_within(client: &CoreClient, deadline: Duration) -> Result<Vec<MeRunner>> {
    let url = client.url("/api/devices/me/runners");
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .timeout(deadline)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "me/runners request: {}",
                status::unanswered(&e, deadline)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("me/runners", code, &text)));
    }
    resp.json::<Vec<MeRunner>>()
        .await
        .map_err(|e| Error::Other(format!("me/runners decode: {e}")))
}

/// Push this device's repo path/branch for one runner row up to the server.
/// `repo_path`/`branch` of `None` are omitted (left unchanged server-side).
pub async fn patch_runner(
    client: &CoreClient,
    runner_id: &str,
    repo_path: Option<&str>,
    branch: Option<&str>,
) -> Result<()> {
    let url = client.url(&format!("/api/devices/me/runners/{runner_id}"));
    let mut body = serde_json::Map::new();
    if let Some(p) = repo_path {
        body.insert("repoPath".into(), serde_json::Value::String(p.to_string()));
    }
    if let Some(b) = branch {
        body.insert("branch".into(), serde_json::Value::String(b.to_string()));
    }
    let resp = client
        .http()
        .patch(&url)
        .bearer_auth(client.device_token())
        .json(&serde_json::Value::Object(body))
        .timeout(CALL_DEADLINE)
        .send()
        .await
        .map_err(|e| {
            Error::Other(format!(
                "patch runner request: {}",
                status::unanswered(&e, CALL_DEADLINE)
            ))
        })?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(status::refused("patch runner", code, &text)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, String::from("tok"))
    }

    /// A core answering one status with one body of the caller's choosing.
    async fn refusing(status: &'static str, body: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = sock.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        });
        format!("http://{addr}")
    }

    /// Criteria 5 and 6. `me/runners failed: 502 Bad Gateway: <html>` is the
    /// line ISS-1233 was filed carrying, from the read that opens the master
    /// sweep. The page is a page and the code is named.
    #[tokio::test]
    async fn a_gateway_refusing_this_boxs_projects_is_named_and_its_page_is_not_pasted() {
        let page = "<!DOCTYPE html><html><head><title>forge-beta-api.sidcorp.co | 502: Bad gateway</title></head><body>error code: 502</body></html>";
        let said = list_me(&client(refusing("502 Bad Gateway", page).await))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            said,
            "me/runners 502 Bad Gateway: an HTML page titled \"forge-beta-api.sidcorp.co | 502: Bad gateway\""
        );
        assert!(!said.contains('<'), "no markup reaches an operator: {said}");
    }

    #[tokio::test]
    async fn a_gateway_code_on_this_read_says_what_it_means() {
        let said = list_me(&client(refusing("520 ", "error code: 520").await))
            .await
            .unwrap_err()
            .to_string();
        assert_eq!(
            said,
            "me/runners 520 (gateway: the origin returned an unknown error): error code: 520"
        );
    }

    /// Criteria 8 and 9. This read is the first call the sweep makes, so a peer
    /// that accepts and never answers stopped every project behind it — no pool
    /// read, no registration, and nothing recorded to say so.
    #[tokio::test]
    async fn a_core_that_accepts_and_never_answers_ends_this_read_at_the_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (stop, hold) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let accepted = listener.accept().await;
            let _ = hold.await;
            drop(accepted);
        });
        let said = tokio::time::timeout(
            Duration::from_secs(5),
            list_me_within(
                &client(format!("http://{addr}")),
                Duration::from_millis(150),
            ),
        )
        .await
        .expect("the call returns rather than hanging")
        .unwrap_err()
        .to_string();
        assert_eq!(said, "me/runners request: timed out after 150ms");
        drop(stop);
    }

    #[test]
    fn this_read_carries_the_deadline_every_core_call_does() {
        assert_eq!(CALL_DEADLINE, super::super::CALL_DEADLINE);
        assert!(CALL_DEADLINE < Duration::from_secs(30));
    }

    /// A core that predates `masterPolicy` leaves the master on the skill's own
    /// defaults, which is what every project ran before ISS-929.
    #[test]
    fn master_policy_absent_deserializes_to_none() {
        let json = r#"{"projectId":"p1","runnerId":"r1","slug":"app","baseBranch":"main",
                       "repoPath":"/srv/app","branch":null,"status":"online"}"#;
        let parsed: MeRunner = serde_json::from_str(json).expect("older core payload must parse");
        assert_eq!(parsed.master_policy, None);
    }

    #[test]
    fn master_policy_is_read_when_core_sends_it() {
        let json = r#"{"projectId":"p1","runnerId":"r1","slug":"app","baseBranch":"main",
                       "repoPath":"/srv/app","branch":null,"status":"online",
                       "masterPolicy":"Budget: 5 sessions."}"#;
        let parsed: MeRunner = serde_json::from_str(json).expect("payload must parse");
        assert_eq!(parsed.master_policy.as_deref(), Some("Budget: 5 sessions."));
    }

    #[test]
    fn an_unknown_field_from_core_is_ignored_rather_than_fatal() {
        let json = r#"{"projectId":"p1","runnerId":"r1","slug":"store","baseBranch":null,
                       "repoPath":"/srv/store","branch":null,"status":"online","kind":"website"}"#;
        let parsed: MeRunner = serde_json::from_str(json).expect("payload must parse");
        assert_eq!(parsed.slug, "store");
    }
}

fn lenient_seconds<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<Option<u64>, D::Error> {
    let raw = serde_json::Value::deserialize(d)?;
    Ok(match raw {
        serde_json::Value::Number(n) => {
            n.as_u64().or_else(|| n.as_f64().map(|f| f.max(0.0) as u64))
        }
        serde_json::Value::String(s) => s.parse::<u64>().ok(),
        _ => None,
    })
}

#[cfg(test)]
mod limit_field_tests {
    use super::*;

    fn one(json: &str) -> Vec<MeRunner> {
        serde_json::from_str(json).expect("a runner list must survive any limit shape")
    }

    const BASE: &str = r#""projectId":"p","runnerId":"r","slug":"s","status":"online""#;

    #[test]
    fn no_shape_of_the_limit_field_can_stop_the_box() {
        for shape in [
            "3600", "\"3600\"", "null", "true", "-5", "3600.7", "\"soon\"",
        ] {
            let json = format!("[{{{BASE},\"rateLimitedForSeconds\":{shape}}}]");
            assert_eq!(one(&json).len(), 1, "shape {shape} killed the list");
        }
    }

    #[test]
    fn a_core_that_omits_the_field_still_parses() {
        let r = one(&format!("[{{{BASE}}}]"));
        assert_eq!(r[0].rate_limited_for_seconds, None);
    }

    #[test]
    fn a_number_and_its_string_form_mean_the_same_wait() {
        let n = one(&format!("[{{{BASE},\"rateLimitedForSeconds\":3600}}]"));
        let t = one(&format!("[{{{BASE},\"rateLimitedForSeconds\":\"3600\"}}]"));
        assert_eq!(n[0].rate_limited_for_seconds, Some(3600));
        assert_eq!(t[0].rate_limited_for_seconds, n[0].rate_limited_for_seconds);
    }
}
