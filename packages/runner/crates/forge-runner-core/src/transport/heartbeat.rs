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

use super::CoreClient;
use crate::error::{Error, Result};
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
    pub gate: Option<crate::daemon::degraded::Condition>,
    /// `None` sends no `pool` key, which core reads as "changes nothing"; a list,
    /// even an empty one, is the box's whole picture. A record that exists and
    /// cannot be read is no picture, so it is `None`, never an empty list.
    pub pool: Option<Vec<crate::daemon::pool_reads::Condition>>,
}

impl Conditions {
    /// Both conditions off the files beside `config.toml`; nothing where there
    /// is no such directory to read.
    pub fn read(config_dir: Option<&std::path::Path>, now_ms: i64) -> Self {
        let Some(dir) = config_dir else {
            return Self::default();
        };
        Self {
            gate: Some(crate::daemon::degraded::report(dir, now_ms).degraded),
            pool: crate::daemon::pool_reads::report(dir, now_ms).ok(),
        }
    }
}

/// Core's reasons for refusing either condition while taking the heartbeat.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Refused {
    pub gate: Option<String>,
    pub pool: Option<String>,
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
    let url = client.url("/api/devices/heartbeat");
    // The RELEASED identity, not Cargo's — core compares a box against both halves,
    // and a box that answered with Cargo's number reported the same 0.17.0 as the
    // release while running seven commits of different code (ISS-1165).
    let body = heartbeat_body(
        crate::update::CURRENT_VERSION,
        crate::update::build_commit(),
        conditions,
    );
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("heartbeat request: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        return Err(Error::Other(format!("heartbeat failed: {}", resp.status())));
    }
    let parsed = resp
        .json::<HeartbeatResponse>()
        .await
        .map_err(|e| Error::Other(format!("heartbeat decode: {e}")))?;
    Ok((
        parsed.server_time.unwrap_or_default(),
        Refused {
            gate: gate_refusal(parsed.gate),
            pool: gate_refusal(parsed.pool),
        },
    ))
}

/// The gate object exactly as it rides on the heartbeat body, separated from
/// the request so the shape can be asserted without a server.
pub fn gate_body(gate: &crate::daemon::degraded::Condition) -> serde_json::Value {
    serde_json::json!({ "degraded": gate })
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
    let mut body = serde_json::json!({ "agentVersion": version });
    if let Some(commit) = commit {
        body["agentCommit"] = serde_json::Value::String(commit.to_string());
    }
    if let Some(gate) = &conditions.gate {
        body["gate"] = gate_body(gate);
    }
    if let Some(pool) = &conditions.pool {
        body["pool"] = pool_body(pool);
    }
    body
}

/// The pool object exactly as it rides on the heartbeat body.
pub fn pool_body(pool: &[crate::daemon::pool_reads::Condition]) -> serde_json::Value {
    serde_json::json!({ "projects": pool })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::degraded::{condition, Kind, Mark, Run, Source, Tally};

    /// The fixture both sides read. A Rust test writes against it and
    /// `packages/core/src/devices/gate-report.test.ts` parses the same bytes,
    /// so a shape change on either side fails a test rather than quietly
    /// parting the producer from the consumer (ISS-1192, criterion 12).
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/devices/gate-report.fixture.json"
    );

    const NOW: i64 = 1_790_236_800_000;
    const HOUR: i64 = 60 * 60 * 1000;

    /// The planted tally the fixture is of: 24 marks over four hours, all one
    /// reason, newest four minutes ago — a rate of 144/day, which is failing
    /// open by every one of the three bounds.
    fn planted() -> Tally {
        let last_at = NOW - 4 * 60_000;
        Tally {
            count: 24,
            by_reason: [("the daemon's control socket is not there".to_string(), 24)]
                .into_iter()
                .collect(),
            last: Some(crate::daemon::degraded::Last {
                detail: "the daemon's control socket is not there".into(),
                source: Some("hook".into()),
                run_unknown: Some("the hook holds no registry of declared runs".into()),
                role: Some("forge:runner".into()),
                ..crate::daemon::degraded::Last::default()
            }),
            last_at: Some(last_at),
            first_at: Some(last_at - 4 * HOUR),
            trimmed: false,
        }
    }

    fn decoded(body: &str) -> HeartbeatResponse {
        serde_json::from_str(body).expect("a heartbeat response")
    }

    /// Criterion 25. A box told its report was refused has to be able to say
    /// so; a box that goes on reporting into nothing and never learns is the
    /// silence this whole record exists to end.
    #[test]
    fn a_refused_gate_comes_back_with_cores_reason_for_refusing_it() {
        let r = decoded(
            r#"{"ok":true,"serverTime":"t","gate":{"accepted":false,"reason":"gate.degraded.verdict: bad enum"}}"#,
        );
        assert_eq!(
            gate_refusal(r.gate).as_deref(),
            Some("gate.degraded.verdict: bad enum")
        );
    }

    #[test]
    fn a_refusal_with_no_reason_still_reads_as_a_refusal() {
        let r = decoded(r#"{"serverTime":"t","gate":{"accepted":false}}"#);
        assert_eq!(gate_refusal(r.gate).as_deref(), Some("no reason given"));
    }

    #[test]
    fn an_accepted_gate_and_a_core_that_said_nothing_both_read_as_no_refusal() {
        assert_eq!(
            gate_refusal(decoded(r#"{"gate":{"accepted":true}}"#).gate),
            None
        );
        assert_eq!(gate_refusal(decoded(r#"{"serverTime":"t"}"#).gate), None);
    }

    /// Criterion 13. The condition rides on the heartbeat the box already beats,
    /// and a box with nothing to say sends no gate key at all rather than an
    /// empty one — which core reads as "changes nothing", not as "all clear".
    #[test]
    fn the_heartbeat_carries_the_gate_where_there_is_one_and_no_key_where_there_is_not() {
        let gate = condition(&planted(), NOW);
        let with = heartbeat_body(
            "0.17.17",
            Some("a67ad6ed4"),
            &Conditions {
                gate: Some(gate.clone()),
                pool: None,
            },
        );
        assert_eq!(with["agentVersion"], "0.17.17");
        assert_eq!(with["gate"], gate_body(&gate));

        let without = heartbeat_body("0.17.17", Some("a67ad6ed4"), &Conditions::default());
        assert!(
            without.get("gate").is_none(),
            "an absent gate is not an empty one: {without}"
        );
        assert_eq!(without["agentVersion"], "0.17.17");
    }

    fn fixture() -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(FIXTURE).expect("the fixture both languages read"),
        )
        .expect("the fixture is json")
    }

    #[test]
    fn the_gate_body_on_the_wire_is_the_fixture_both_sides_read() {
        let body = gate_body(&condition(&planted(), NOW));
        let on_disk = fixture();
        assert_eq!(
            body["degraded"], on_disk["degraded"],
            "the box's heartbeat body and the fixture core's tests parse have parted; \
             regenerate the fixture and read what moved before you do"
        );
    }

    /// Consult F1. Core declares a ceiling on every string and on how many
    /// reasons a condition may carry, and refuses the WHOLE report past it. The
    /// producer's bounds and the consumer's are one number each, written once in
    /// the fixture, so a change on either side fails here instead of silencing a
    /// box exactly when it has most to say.
    #[test]
    fn the_wire_bounds_the_fixture_states_are_the_ones_this_box_emits() {
        use crate::daemon::degraded::{MAX_REASONS, WIRE_UNITS_CEILING};
        let wire = fixture()["wire"].clone();
        assert_eq!(
            wire["maxReasons"].as_u64(),
            Some(MAX_REASONS as u64),
            "packages/core/src/devices/gate-report.ts reads this number as its own ceiling"
        );
        assert_eq!(wire["units"].as_u64(), Some(WIRE_UNITS_CEILING as u64));
    }

    /// The same derivation over a real marks file, so the fixture is not a
    /// shape somebody wrote by hand that the writer never produces.
    #[test]
    fn a_planted_marks_file_yields_the_same_verdict_and_rate() {
        let dir = crate::test_scratch::Scratch::new("gate-body");
        for _ in 0..24 {
            crate::daemon::degraded::mark(
                &dir,
                &Mark::new(
                    Kind::Degraded,
                    Source::Hook,
                    "the daemon's control socket is not there",
                    Run::Unknown("the hook holds no registry of declared runs"),
                ),
            );
        }
        let (degraded, _) = crate::daemon::degraded::tally(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(degraded.count, 24);
        assert_eq!(
            degraded.by_reason,
            planted().by_reason,
            "the fixture's breakdown must be one the writer actually produces"
        );
    }

    // ---- ISS-1234: the pool reads ride the same beat ----

    /// The fixture core's `pool-read-report.test.ts` parses. Same bytes on both
    /// sides, so a shape change fails a test rather than parting producer and
    /// consumer.
    const POOL_FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/devices/pool-read-report.fixture.json"
    );

    pub(crate) const BLIND_PROJECT: &str = "68567cd4-0000-4000-8000-000000000001";
    pub(crate) const INTERMITTENT_PROJECT: &str = "2126d65a-d732-483b-a0ff-eb74fd88c53f";

    fn scratch(name: &str) -> crate::test_scratch::Scratch {
        crate::test_scratch::Scratch::new(&format!("pool-body-{name}"))
    }

    /// The planted record the fixture is of: one project blind on 525 for three
    /// passes, one that failed 520 once and read again the pass after — the
    /// shape of every occurrence measured on ISS-1234.
    fn planted_pool(dir: &std::path::Path) {
        use crate::daemon::pool_jobs::Took;
        use crate::transport::pool::ReadFailure;
        let f = |status: u16, reason: &str| {
            Took::Unread(ReadFailure {
                status: Some(status),
                reason: reason.to_string(),
            })
        };
        let t525 = f(
            525,
            "pool 525 (gateway: the TLS handshake with the origin failed): <!DOCTYPE html>",
        );
        let t520 = f(
            520,
            "pool 520 (gateway: the origin returned an unknown error): <!DOCTYPE html>",
        );
        let note = crate::daemon::pool_reads::note;
        note(dir, INTERMITTENT_PROJECT, &t520, NOW - 60 * 60_000);
        note(
            dir,
            INTERMITTENT_PROJECT,
            &Took::NothingClaimable,
            NOW - 60 * 60_000 + 10_000,
        );
        for i in 0..3 {
            note(dir, BLIND_PROJECT, &t525, NOW - 30_000 + i * 10_000);
        }
    }

    fn pool_fixture() -> serde_json::Value {
        serde_json::from_str(
            &std::fs::read_to_string(POOL_FIXTURE).expect("the pool fixture both languages read"),
        )
        .expect("the pool fixture is json")
    }

    /// Criterion 13. The body a box builds from a real record is the fixture.
    #[test]
    fn the_pool_body_on_the_wire_is_the_fixture_both_sides_read() {
        let dir = scratch("fixture");
        planted_pool(&dir);
        let conditions = Conditions::read(Some(&dir), NOW);
        let body = heartbeat_body("0.17.18", None, &conditions);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            body["pool"],
            pool_fixture()["pool"],
            "the box's pool body and the fixture core's tests parse have parted; \
             regenerate the fixture and read what moved before you do:\n{}",
            serde_json::to_string_pretty(&body["pool"]).unwrap()
        );
    }

    #[test]
    fn the_pool_bounds_the_fixture_states_are_the_ones_this_box_emits() {
        use crate::daemon::degraded::WIRE_UNITS_CEILING;
        use crate::daemon::pool_reads::MAX_PROJECTS;
        let wire = pool_fixture()["wire"].clone();
        assert_eq!(wire["maxProjects"].as_u64(), Some(MAX_PROJECTS as u64));
        assert_eq!(wire["units"].as_u64(), Some(WIRE_UNITS_CEILING as u64));
    }

    /// Criterion 13: a box with a config directory sends its whole picture,
    /// an empty list included, because an omitted project is how core learns
    /// it read cleanly; a box with none sends no key and changes nothing.
    #[test]
    fn a_clean_box_sends_an_empty_list_and_a_box_with_no_record_sends_no_key() {
        let dir = scratch("clean");
        let clean = heartbeat_body("0.17.18", None, &Conditions::read(Some(&dir), NOW));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(clean["pool"], serde_json::json!({ "projects": [] }));
        let none = heartbeat_body("0.17.18", None, &Conditions::read(None, NOW));
        assert!(none.get("pool").is_none(), "{none}");
        assert!(none.get("gate").is_none(), "{none}");
    }

    /// A record that exists and cannot be read is not a clean box. Sent as an
    /// empty list it would clear at core every condition the box had reported,
    /// so the beat carries no `pool` key and core keeps what it stored.
    #[test]
    fn a_record_that_cannot_be_read_sends_no_pool_key() {
        let dir = scratch("corrupt");
        planted_pool(&dir);
        let path = crate::daemon::pool_reads::path(&dir);
        std::fs::write(&path, "{\"projects\":{\"68567cd4").unwrap();
        let corrupt = heartbeat_body("0.17.18", None, &Conditions::read(Some(&dir), NOW));
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let unopenable = heartbeat_body("0.17.18", None, &Conditions::read(Some(&dir), NOW));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(corrupt.get("pool").is_none(), "a corrupt record: {corrupt}");
        assert!(
            corrupt.get("gate").is_some(),
            "the gate still rides: {corrupt}"
        );
        assert!(
            unopenable.get("pool").is_none(),
            "an unopenable record: {unopenable}"
        );
    }

    /// Criterion 18, the reading half: core's refusal of the pool report comes
    /// back apart from the gate's.
    #[test]
    fn a_refused_pool_report_comes_back_with_cores_reason() {
        let r = decoded(
            r#"{"ok":true,"gate":{"accepted":true},"pool":{"accepted":false,"reason":"pool.projects.0.verdict: bad enum"}}"#,
        );
        assert_eq!(gate_refusal(r.gate), None);
        assert_eq!(
            gate_refusal(r.pool).as_deref(),
            Some("pool.projects.0.verdict: bad enum")
        );
    }
}
