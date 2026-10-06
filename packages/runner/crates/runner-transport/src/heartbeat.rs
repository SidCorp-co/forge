//! Device heartbeat: `POST /api/devices/heartbeat` (~every 30s).
//!
//! It also carries this box's declaration-gate condition. The heartbeat is the
//! carrier because the degraded case is DEFINED by the control socket or the
//! role list having failed, and neither is on this path — so it is up exactly
//! when the thing being reported is down (ISS-1192).
//!
//! It carries this box's pool reads for the same reason: a read answered 520 at
//! the gateway never reaches core, and this route answered normally around every
//! one measured (ISS-1234).

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;
use serde::Deserialize;

pub const INTERVAL_SECS: u64 = 30;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatResponse {
    #[serde(default)]
    server_time: Option<String>,
    #[serde(default)]
    gate: Option<GateAck>,
    #[serde(default)]
    pool: Option<GateAck>,
    #[serde(default)]
    binaries: Option<GateAck>,
    #[serde(default)]
    disk: Option<GateAck>,
}

/// What core says it did with the gate condition. A refusal is carried back
/// rather than swallowed: a box reporting into nothing and not knowing it is
/// the defect this report exists to end, arriving from inside the fix.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GateAck {
    #[serde(default)]
    accepted: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// What core said about the gate, separated from the request so the refusal
/// path can be asserted without a server.
fn gate_refusal(parsed: Option<GateAck>) -> Option<String> {
    parsed.and_then(|g| {
        if g.accepted {
            None
        } else {
            Some(g.reason.unwrap_or_else(|| "no reason given".to_string()))
        }
    })
}

/// What this box says about itself on every beat, read in one place so the
/// tick and a test build the same body.
#[derive(Debug, Default)]
pub struct Conditions {
    pub gate: Option<runner_proto::gate::Condition>,
    /// `None` sends no `pool` key, which core reads as "changes nothing"; a list,
    /// even an empty one, is the box's whole picture. A record that exists and
    /// cannot be read is no picture, so it is `None`, never an empty list.
    pub pool: Option<Vec<runner_proto::pool_read::Condition>>,
    /// Every binary a pane needs that this box cannot resolve now. `None` sends
    /// no `binaries` key, which core reads as "changes nothing"; a list, even an
    /// empty one, is the box's whole picture.
    pub binaries: Option<Vec<runner_proto::binaries::Missing>>,
    /// The permission dialogs this box answered for its panes, per project.
    /// Rides inside `gate`, and only when there is one to name: a core that
    /// predates it refuses the gate report by name rather than the heartbeat.
    pub dialogs: Vec<runner_proto::dialogs::Answered>,
    /// What each scratch root's filesystem had left at the last reading. `None`
    /// sends no `disk` key, which core reads as "changes nothing": a box that
    /// has not read yet says nothing rather than an empty picture.
    pub disk: Option<Vec<runner_proto::disk::Root>>,
}

/// Core's reasons for refusing either condition while taking the heartbeat.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refused {
    pub gate: Option<String>,
    pub pool: Option<String>,
    pub binaries: Option<String>,
    pub disk: Option<String>,
}

pub async fn beat(client: &CoreClient, conditions: &Conditions) -> Result<Refused> {
    beat_with(client, conditions)
        .await
        .map(|(_, refused)| refused)
}

/// Like [`beat`] but returns the core's `serverTime` so callers (e.g. `doctor`)
/// can prove core reachability with a concrete value. `401` maps to a clear
/// `UNAUTHORIZED` error so callers can prompt a re-login.
pub async fn beat_verbose(client: &CoreClient) -> Result<String> {
    beat_with(client, &Conditions::default())
        .await
        .map(|(time, _)| time)
}

async fn beat_with(client: &CoreClient, conditions: &Conditions) -> Result<(String, Refused)> {
    // The RELEASED identity, not Cargo's — core compares a box against both halves,
    // and a box that answered with Cargo's number reported the same 0.17.0 as the
    // release while running seven commits of different code (ISS-1165).
    let body = heartbeat_body(
        runner_update::CURRENT_VERSION,
        runner_update::build_commit(),
        conditions,
    );
    let req = client.post("/api/devices/heartbeat").json(&body);
    let parsed: HeartbeatResponse = status::fetch_within(req, "heartbeat", CALL_DEADLINE).await?;
    Ok((
        parsed.server_time.unwrap_or_default(),
        Refused {
            gate: gate_refusal(parsed.gate),
            pool: gate_refusal(parsed.pool),
            binaries: gate_refusal(parsed.binaries),
            disk: gate_refusal(parsed.disk),
        },
    ))
}

/// The gate object exactly as it rides on the heartbeat body, separated from
/// the request so the shape can be asserted without a server.
pub fn gate_body(
    gate: &runner_proto::gate::Condition,
    dialogs: &[runner_proto::dialogs::Answered],
) -> serde_json::Value {
    let mut body = serde_json::json!({ "degraded": gate });
    if !dialogs.is_empty() {
        body["dialogs"] = serde_json::json!(dialogs);
    }
    body
}

/// The whole body, built where it can be read without a server. Only the
/// degraded half of the gate travels: `undeclared` shares the box's file, is a
/// different fact with its own treatment owed, and sending it with nothing
/// reading it would be the unread counter this ends (ISS-1192).
pub(crate) fn heartbeat_body(
    version: &str,
    commit: Option<&str>,
    conditions: &Conditions,
) -> serde_json::Value {
    let mut body = serde_json::json!({
        "agentVersion": version,
        // A session handed a `forgeToken` on `agent:start` runs under it (ISS-17), and so does
        // a follow-up handed one on `agent:send` (ISS-27); core picks only a box that says so
        // for a turn that answers a person.
        "capabilities": { "turnCredential": true, "followUpCredential": true },
    });
    if let Some(commit) = commit {
        body["agentCommit"] = serde_json::Value::String(commit.to_string());
    }
    if let Some(gate) = &conditions.gate {
        body["gate"] = gate_body(gate, &conditions.dialogs);
    }
    if let Some(pool) = &conditions.pool {
        body["pool"] = pool_body(pool);
    }
    if let Some(missing) = &conditions.binaries {
        body["binaries"] = serde_json::json!({ "missing": missing });
    }
    if let Some(roots) = &conditions.disk {
        body["disk"] = serde_json::json!({ "roots": roots });
    }
    body
}

/// The pool object exactly as it rides on the heartbeat body.
pub fn pool_body(pool: &[runner_proto::pool_read::Condition]) -> serde_json::Value {
    serde_json::json!({ "projects": pool })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binary_the_box_cannot_resolve_rides_on_the_beat() {
        let conditions = Conditions {
            binaries: Some(vec![runner_proto::binaries::Missing::new(
                "node",
                "no `node` resolves".into(),
            )]),
            ..Conditions::default()
        };
        let body = heartbeat_body("1.0.0", None, &conditions);
        assert_eq!(
            body["binaries"],
            serde_json::json!({ "missing": [{ "name": "node", "detail": "no `node` resolves" }] })
        );
        let clear = Conditions {
            binaries: Some(Vec::new()),
            ..Conditions::default()
        };
        assert_eq!(
            heartbeat_body("1.0.0", None, &clear)["binaries"],
            serde_json::json!({ "missing": [] }),
            "a box that resolves everything sent no picture, so a fixed box kept its old report"
        );
        assert!(heartbeat_body("1.0.0", None, &Conditions::default())
            .get("binaries")
            .is_none());
    }

    #[test]
    fn an_answered_dialog_rides_inside_the_gate_only_when_there_is_one() {
        let gate = clear_gate();
        let quiet = Conditions {
            gate: Some(gate.clone()),
            ..Conditions::default()
        };
        assert!(heartbeat_body("1.0.0", None, &quiet)["gate"]
            .get("dialogs")
            .is_none());
        let answered = Conditions {
            gate: Some(gate),
            dialogs: vec![runner_proto::dialogs::Answered {
                project_id: Some("p".into()),
                count: 2,
                count_is_floor: false,
                first_at: Some(1),
                last_at: Some(2),
                last: Some("denied Bash: rm -rf x".into()),
                last_agent: None,
            }],
            ..Conditions::default()
        };
        assert_eq!(
            heartbeat_body("1.0.0", None, &answered)["gate"]["dialogs"],
            serde_json::json!([{ "projectId": "p", "count": 2, "countIsFloor": false,
                "firstAt": 1, "lastAt": 2, "last": "denied Bash: rm -rf x", "lastAgent": null }])
        );
    }

    fn clear_gate() -> runner_proto::gate::Condition {
        runner_proto::gate::Condition {
            verdict: runner_proto::gate::Verdict::Clear,
            count: 0,
            trimmed: false,
            first_at: None,
            last_at: None,
            window_ms: None,
            per_day: None,
            since_last_ms: None,
            last: None,
            by_reason: Vec::new(),
        }
    }

    #[test]
    fn a_disk_reading_rides_on_the_beat_and_core_refusing_it_is_carried_back() {
        let conditions = Conditions {
            disk: Some(vec![runner_proto::disk::Root::new(
                "/tmp",
                runner_proto::disk::Reading::Refused {
                    refused: "statvfs on /tmp answered EIO".into(),
                },
            )]),
            ..Conditions::default()
        };
        assert_eq!(
            heartbeat_body("1.0.0", None, &conditions)["disk"],
            serde_json::json!({ "roots": [{ "root": "/tmp", "refused": "statvfs on /tmp answered EIO" }] })
        );
        assert!(heartbeat_body("1.0.0", None, &Conditions::default())
            .get("disk")
            .is_none());
        let parsed: HeartbeatResponse = serde_json::from_value(serde_json::json!({
            "disk": { "accepted": false, "reason": "disk.roots: too many" }
        }))
        .unwrap();
        assert_eq!(
            gate_refusal(parsed.disk).as_deref(),
            Some("disk.roots: too many")
        );
    }

    #[test]
    fn core_refusing_the_binary_report_is_carried_back() {
        let parsed: HeartbeatResponse = serde_json::from_value(serde_json::json!({
            "binaries": { "accepted": false, "reason": "binaries.missing: too many" }
        }))
        .unwrap();
        assert_eq!(
            gate_refusal(parsed.binaries).as_deref(),
            Some("binaries.missing: too many")
        );
    }
}
