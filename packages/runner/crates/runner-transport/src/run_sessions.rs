/*
 * Telling core a run session exists, and that it is still held.
 */

use serde::Deserialize;

use crate::agent_sessions::{patch_session, SessionPatch};
use crate::{status, CoreClient};
use runner_platform::error::{Error, Result};

/// What core's run-session routes accept, as `run-session-routes.ts`'s
/// `runSessionBodySchema` and `closeBodySchema` state it.
///
/// A payload built past one of these earns a `400` naming the field, and that
/// refusal is terminal for the bytes that earned it, so the caps are built to
/// here rather than discovered downstream an hour and forty-seven minutes
/// later (ISS-1284). Whether 16 is the right number is core's question, not
/// this module's; what this module owes is a payload that obeys whatever
/// number core states.
pub const MAX_ISSUE_KEYS: usize = 16;
pub const MAX_NAME_CODE_UNITS: usize = 60;
pub const MAX_DETAIL_CODE_UNITS: usize = 500;

/// `text` cut to `max` of the units core counts.
///
/// Core's `utf16String` reads JavaScript's `String.length`, which counts UTF-16
/// code units, and a `chars()` count agrees with it only until the first character
/// outside the basic plane — at which point a string this side calls short is
/// one core refuses. A cut is marked, because a detail silently shortened
/// reads afterwards as a detail somebody wrote that way.
pub fn fit(text: &str, max: usize) -> String {
    if text.encode_utf16().count() <= max {
        return text.to_string();
    }
    if max == 0 {
        return String::new();
    }
    let room = max - '\u{2026}'.len_utf16();
    let mut out = String::new();
    let mut units = 0usize;
    for c in text.chars() {
        if units + c.len_utf16() > room {
            break;
        }
        out.push(c);
        units += c.len_utf16();
    }
    out.push('\u{2026}');
    out
}

/// The name a run carries at core: the keys it was declared over, as many as
/// fit, and then how many did not.
///
/// The name is this box's own label — `forge-runner run declare` takes no name
/// option, and the daemon composes one from the keys — while the keys are the
/// run's own. So the label is what gives way when the two cannot both fit, and
/// it says by how much rather than going quiet. Eight full keys already cross
/// 60 units, which is what turned five ordinary declarations into five
/// permanent retry loops on one project in fifty minutes (ISS-1284).
///
/// An empty slice names an empty run and gets an empty name, which core
/// refuses by `min(1)`. That is the honest answer and not a gap:
/// `open_declared_runs` refuses a run carrying no issues before it reaches
/// here, and a name invented for one would be this box naming a run after
/// nothing.
pub fn session_name(keys: &[String]) -> String {
    // A set that fits whole is carried whole. The greedy pass below weighs each
    // key against the `+N more` tail it would leave behind it, and for keys
    // shorter than that tail — a project whose issues are declared as bare
    // numbers — the tail can cost more than the keys it stands for, so a set
    // that fits would come back short. No declaration this box accepts reaches
    // that today, and a builder whose answer depends on a cap enforced
    // somewhere else is one that breaks the day that cap moves.
    let whole = keys.join("+");
    if whole.encode_utf16().count() <= MAX_NAME_CODE_UNITS {
        return whole;
    }
    let mut name = String::new();
    let mut taken = 0usize;
    for (i, key) in keys.iter().enumerate() {
        let left = keys.len() - i - 1;
        let tail = if left == 0 {
            String::new()
        } else {
            format!("+{left} more")
        };
        let sep = if name.is_empty() { "" } else { "+" };
        let would = name.encode_utf16().count()
            + sep.encode_utf16().count()
            + key.encode_utf16().count()
            + tail.encode_utf16().count();
        if would > MAX_NAME_CODE_UNITS {
            break;
        }
        name.push_str(sep);
        name.push_str(key);
        taken += 1;
    }
    // Nothing fit beside a count, which takes a single key longer than the
    // whole name is allowed to be. The run still needs a name core will accept,
    // so the keys are cut and the cut is marked.
    if taken == 0 {
        return fit(&whole, MAX_NAME_CODE_UNITS);
    }
    let left = keys.len() - taken;
    if left > 0 {
        name.push_str(&format!("+{left} more"));
    }
    name
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenReply {
    session_id: String,
    run_id: String,
}

pub async fn open(
    client: &CoreClient,
    project_id: &str,
    run_id: &str,
    issue_keys: &[String],
    name: &str,
    gate: Option<&runner_proto::gate::Condition>,
) -> Result<(String, String)> {
    let mut body = serde_json::json!({
        "projectId": project_id,
        "runId": run_id,
        "issueKeys": issue_keys,
        "name": name,
    });
    // What was true THEN. The device's own report says what is true now, and a
    // window that has rolled over cannot answer "was the gate deciding while
    // this ran" for a run that ended weeks ago (ISS-1192).
    if let Some(gate) = gate {
        body["gate"] = serde_json::to_value(gate).unwrap_or(serde_json::Value::Null);
    }
    let req = client.post("/api/devices/me/run-sessions").json(&body);
    let resp = status::sent(req, "run-session open").await?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // Classified rather than flattened: the sweep behind this call re-sends
        // a payload nothing between attempts changes, so it has to be able to
        // tell a refusal of the bytes from a refusal of the moment (ISS-1284).
        return Err(status::refusal("run-session open", code, &text));
    }
    let parsed: OpenReply = status::decode(resp, "run-session open").await?;
    Ok((parsed.session_id, parsed.run_id))
}

pub async fn beat(client: &CoreClient, session_id: &str) -> Result<()> {
    patch_session(
        client,
        session_id,
        &SessionPatch {
            status: Some("running".into()),
            ..Default::default()
        },
    )
    .await
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ended,
    KilledIdle,
    Died,
}

impl Outcome {
    fn wire(self) -> &'static str {
        match self {
            Outcome::Ended => "ended",
            Outcome::KilledIdle => "killed_idle",
            Outcome::Died => "died",
        }
    }
}

pub async fn close(
    client: &CoreClient,
    session_id: &str,
    outcome: Outcome,
    detail: Option<&str>,
    checkpoint: Option<serde_json::Value>,
) -> Result<()> {
    let path = format!("/api/devices/me/run-sessions/{session_id}/close");
    let mut body = serde_json::json!({ "outcome": outcome.wire() });
    if let Some(d) = detail {
        body["detail"] = serde_json::Value::String(d.to_string());
    }
    if let Some(cp) = checkpoint {
        body["checkpoint"] = cp;
    }
    let resp = status::sent(client.post(&path).json(&body), "run-session close").await?;
    if resp.status().as_u16() == 404 {
        return no_such_session(resp, "run-session close").await;
    }
    status::checked(resp, "run-session close").await?;
    Ok(())
}

/// The message core's `notFound('run session')` carries, under code
/// `NOT_FOUND`: this device holds no run session by that id.
const NO_SUCH_SESSION: &str = "run session not found";

/// `Ok` where a 404 is core saying this device holds no such run session, and
/// an error naming the reply otherwise. Read by code and message, never by
/// status: a 404 an edge or proxy answers for an unrouted path during a deploy
/// says nothing about the session, and reading it as "no such session" stops
/// the box from ever sending the close again while core's session stays open.
async fn no_such_session(resp: reqwest::Response, what: &str) -> Result<()> {
    let text = resp.text().await.unwrap_or_default();
    let parsed: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    let field = |name: &str| {
        parsed.as_ref().and_then(|v| {
            v.pointer(&format!("/error/{name}"))
                .or_else(|| v.get(name))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
    };
    if field("code").as_deref() == Some("NOT_FOUND")
        && field("message").as_deref() == Some(NO_SUCH_SESSION)
    {
        return Ok(());
    }
    Err(Error::Other(status::refused(what, 404, &text)))
}

pub async fn report_resume_choice(
    client: &CoreClient,
    session_id: &str,
    choice: serde_json::Value,
) -> Result<()> {
    let path = format!("/api/devices/me/run-sessions/{session_id}/resume-choice");
    let resp = status::sent(client.post(&path).json(&choice), "resume-choice report").await?;
    status::checked(resp, "resume-choice report").await?;
    Ok(())
}

pub async fn report_held_worktree(
    client: &CoreClient,
    session_id: &str,
    held: serde_json::Value,
) -> Result<()> {
    let path = format!("/api/devices/me/run-sessions/{session_id}/held-worktree");
    let resp = status::sent(client.post(&path).json(&held), "held-worktree report").await?;
    status::checked(resp, "held-worktree report").await?;
    Ok(())
}

pub async fn is_terminal(client: &CoreClient, session_id: &str) -> Result<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        session_terminal: bool,
    }
    let path = format!("/api/devices/me/run-sessions/{session_id}");
    let resp = status::sent(client.get(&path), "run-session state").await?;
    if resp.status().as_u16() == 404 {
        return no_such_session(resp, "run-session state")
            .await
            .map(|()| true);
    }
    let resp = status::checked(resp, "run-session state").await?;
    let parsed: Reply = status::decode(resp, "run-session state").await?;
    Ok(parsed.session_terminal)
}

/// What core says about one issue's lease, as this box sees it.
///
/// Two booleans because they are two questions (ISS-1109). `held` is the
/// fleet-wide fact — any box, not only this one. `held_by_this_device` is what
/// a close loop asking "have I given this back" means, and reading the first
/// under the second's name is what let two boxes hold one issue.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseState {
    pub held_by_this_device: bool,
    /// The issue itself has reached a terminal status at core. `None` is *not
    /// known to be over* — a key that reaches no issue — and a box reads it as
    /// the run carrying on
    /// (ISS-1245).
    #[serde(default)]
    pub issue_over: Option<bool>,
    /// The issue is over or parked (`needs_info`, `on_hold`), so no run works
    /// it now. `None` as for `issue_over`.
    #[serde(default)]
    pub issue_resting: Option<bool>,
}

/// Where one lease lives, named by the project it was taken for.
///
/// `issue_leases` is keyed `(project_id, issue_key)` and `iss_seq` restarts per
/// project, so a box serving two of them holds two rows under one key. Core
/// refuses a give-back it cannot narrow to one, and this is how the run says
/// which it means (ISS-1139).
pub(crate) fn lease_path(project_id: Option<&str>, issue_key: &str) -> String {
    match project_id {
        Some(p) => format!("/api/devices/me/issue-leases/{issue_key}?projectId={p}"),
        None => format!("/api/devices/me/issue-leases/{issue_key}"),
    }
}

/// Core's codes for a key under which no lease of any box can stand.
///
/// A lease call carries the key the pool handed the box, and core resolves it
/// against the project whose prefix it names. Two of its refusals settle the
/// key itself: a shape that is no issue reference, which the store keys nothing
/// by, and a prefix no project answers to — the state a deleted project leaves,
/// where `issue_prefix_aliases` keeps the row with a null project and the
/// cascade on `issue_leases.project_id` has already taken every lease that
/// project held. No lease could have opened under either shape in the first
/// place — `openRunSession` parses every key against the prefixes its project
/// holds and refuses the open otherwise — so `not held` is the fact. An error
/// in its place is a refusal the box cannot clear, and the loop marks returned only
/// on `Ok(true)`, so the run keeps its master waiting for ever (ISS-1139).
///
/// `ISSUE_LEASE_KEY_PROJECT_MISMATCH` is not one of them: the two identities in
/// that request disagree and a lease may stand under either, so `not held`
/// there is a guess wearing the shape of a fact.
const NO_LEASE_STANDS_UNDER_KEY: [&str; 2] =
    ["ISSUE_LEASE_KEY_SHAPE", "ISSUE_LEASE_KEY_UNKNOWN_PREFIX"];

/// The code core named, where it is one of those two.
///
/// Read by code and never by status: a bare `404` from a core that does not
/// serve this route says nothing about any lease, and reading that as `not
/// held` marks a lease returned while it is still standing.
fn no_lease_stands_under_key(body: &str) -> Option<&'static str> {
    let code = status::refusal_code(body)?;
    NO_LEASE_STANDS_UNDER_KEY
        .into_iter()
        .find(|known| *known == code)
}

pub async fn lease_state(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<LeaseState> {
    let req = client.get(&lease_path(project_id, issue_key));
    let resp = status::sent(req, "issue-lease read").await?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let status_code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        if let Some(code) = no_lease_stands_under_key(&text) {
            tracing::warn!(
                "[lease] read {issue_key}: core answers {code}; no lease stands under that key, so this box holds none"
            );
            return Ok(LeaseState {
                held_by_this_device: false,
                issue_over: None,
                issue_resting: None,
            });
        }
        return Err(Error::Other(status::refused(
            "issue-lease read",
            status_code,
            &text,
        )));
    }
    status::decode(resp, "issue-lease").await
}

pub async fn release_lease(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<()> {
    let req = client.delete(&lease_path(project_id, issue_key));
    let resp = status::sent(req, "issue-lease release").await?;
    // A 404 is core saying this box holds no such lease, which is the state the
    // release was asking for; `is_returned` reads it back either way. Anything
    // else — a 409 core could not narrow to one project among them — is an
    // error, because retrying it unchanged never resolves (ISS-1139).
    if resp.status().as_u16() != 404 {
        status::checked(resp, "issue-lease release").await?;
    }
    Ok(())
}
