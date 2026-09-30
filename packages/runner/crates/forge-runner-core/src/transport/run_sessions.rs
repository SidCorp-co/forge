/*
 * Telling core a run session exists, and that it is still held.
 */

use serde::Deserialize;

use crate::error::{Error, Result};
use crate::transport::agent_sessions::{patch_session, SessionPatch};
use crate::transport::CoreClient;

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
    gate: Option<&crate::daemon::degraded::Condition>,
) -> Result<(String, String)> {
    let url = client.url("/api/devices/me/run-sessions");
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
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session open: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        // Classified rather than flattened: the sweep behind this call re-sends
        // a payload nothing between attempts changes, so it has to be able to
        // tell a refusal of the bytes from a refusal of the moment (ISS-1284).
        return Err(super::status::refusal("run-session open", code, &text));
    }
    let parsed: OpenReply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("run-session open decode: {e}")))?;
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
    let url = client.url(&format!("/api/devices/me/run-sessions/{session_id}/close"));
    let mut body = serde_json::json!({ "outcome": outcome.wire() });
    if let Some(d) = detail {
        body["detail"] = serde_json::Value::String(d.to_string());
    }
    if let Some(cp) = checkpoint {
        body["checkpoint"] = cp;
    }
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&body)
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session close: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Ok(());
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "run-session close",
            code,
            &text,
        )));
    }
    Ok(())
}

pub async fn report_resume_choice(
    client: &CoreClient,
    session_id: &str,
    choice: serde_json::Value,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/run-sessions/{session_id}/resume-choice"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&choice)
        .send()
        .await
        .map_err(|e| Error::Other(format!("resume-choice report: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "resume-choice report",
            code,
            &text,
        )));
    }
    Ok(())
}

pub async fn report_held_worktree(
    client: &CoreClient,
    session_id: &str,
    held: serde_json::Value,
) -> Result<()> {
    let url = client.url(&format!(
        "/api/devices/me/run-sessions/{session_id}/held-worktree"
    ));
    let resp = client
        .http()
        .post(&url)
        .bearer_auth(client.device_token())
        .json(&held)
        .send()
        .await
        .map_err(|e| Error::Other(format!("held-worktree report: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "held-worktree report",
            code,
            &text,
        )));
    }
    Ok(())
}

pub async fn is_terminal(client: &CoreClient, session_id: &str) -> Result<bool> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Reply {
        session_terminal: bool,
    }
    let url = client.url(&format!("/api/devices/me/run-sessions/{session_id}"));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("run-session state: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    if resp.status().as_u16() == 404 {
        return Ok(true);
    }
    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "run-session state",
            code,
            &text,
        )));
    }
    let parsed: Reply = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("run-session state decode: {e}")))?;
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
    pub held: bool,
    pub held_by_this_device: bool,
    /// The issue itself has reached a terminal status at core. `None` is *not
    /// known to be over* — an older core that does not send the field, or a key
    /// that reaches no issue — and a box reads it as the run carrying on
    /// (ISS-1245).
    #[serde(default)]
    pub issue_over: Option<bool>,
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
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let code = parsed.get("code")?.as_str()?;
    NO_LEASE_STANDS_UNDER_KEY
        .into_iter()
        .find(|known| *known == code)
}

pub async fn lease_state(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<LeaseState> {
    let url = client.url(&lease_path(project_id, issue_key));
    let resp = client
        .http()
        .get(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("issue-lease read: {e}")))?;
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
                held: false,
                held_by_this_device: false,
                issue_over: None,
            });
        }
        return Err(Error::Other(super::status::refused(
            "issue-lease read",
            status_code,
            &text,
        )));
    }
    let parsed: LeaseState = resp
        .json()
        .await
        .map_err(|e| Error::Other(format!("issue-lease decode: {e}")))?;
    Ok(parsed)
}

pub async fn release_lease(
    client: &CoreClient,
    project_id: Option<&str>,
    issue_key: &str,
) -> Result<()> {
    let url = client.url(&lease_path(project_id, issue_key));
    let resp = client
        .http()
        .delete(&url)
        .bearer_auth(client.device_token())
        .send()
        .await
        .map_err(|e| Error::Other(format!("issue-lease release: {e}")))?;
    if resp.status().as_u16() == 401 {
        return Err(Error::Unauthorized);
    }
    // A 404 is core saying this box holds no such lease, which is the state the
    // release was asking for; `is_returned` reads it back either way. Anything
    // else — a 409 core could not narrow to one project among them — is an
    // error, because retrying it unchanged never resolves (ISS-1139).
    if !resp.status().is_success() && resp.status().as_u16() != 404 {
        let code = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        return Err(Error::Other(super::status::refused(
            "issue-lease release",
            code,
            &text,
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::fake_core;

    static RECOVERY_PORTS: std::sync::LazyLock<&str> = std::sync::LazyLock::new(|| {
        crate::test_scratch::lf(include_str!("../daemon/recovery_ports.rs"))
    });

    fn client(url: String) -> CoreClient {
        CoreClient::new(url, String::from("tok"))
    }

    #[test]
    fn a_lease_carries_the_fleet_answer_and_this_box_answer_separately() {
        let state: LeaseState = serde_json::from_str(
            r#"{"held":true,"heldByThisDevice":false,"holder":{"deviceId":"d1"}}"#,
        )
        .expect("core sends camelCase and an extra holder object the runner does not read");

        assert!(
            state.held,
            "another box holding the issue is the fleet answer"
        );
        assert!(
            !state.held_by_this_device,
            "a box that reads the fleet answer as its own never marks its lease returned, and the run never closes"
        );
    }

    #[test]
    fn a_lease_call_names_the_project_the_lease_was_taken_for() {
        assert_eq!(
            lease_path(Some("proj-1"), "ISS-880"),
            "/api/devices/me/issue-leases/ISS-880?projectId=proj-1",
            "a box serving two projects holds two rows under one key, and core refuses a give-back that names neither"
        );
        assert_eq!(
            lease_path(None, "ISS-880"),
            "/api/devices/me/issue-leases/ISS-880",
            "a run whose ledger row carries no project still asks, and core narrows by the device alone"
        );
    }

    /// ISS-1245 — an answer with no such field is *not known to be over*.
    ///
    /// Core and the runner ship on different clocks, and a box running ahead of
    /// its core must read the silence as the run carrying on rather than as the
    /// issue being live or over. `false` here would be a claim nothing made.
    #[test]
    fn an_answer_that_names_no_issue_status_leaves_it_unknown() {
        let state: LeaseState =
            serde_json::from_str(r#"{"held":true,"heldByThisDevice":true,"holder":null}"#)
                .expect("a core that does not send the field still answers the lease question");

        assert_eq!(
            state.issue_over, None,
            "an older core says nothing about the issue, and a box that reads that as an answer              closes a run on evidence nobody gave it"
        );
    }

    #[test]
    fn an_over_issue_is_carried_back_on_the_lease_answer() {
        let state: LeaseState = serde_json::from_str(
            r#"{"held":false,"heldByThisDevice":false,"holder":null,"issueOver":true}"#,
        )
        .expect("the field rides on the call the close loop already makes");

        assert_eq!(
            state.issue_over,
            Some(true),
            "and it is answered off the ISSUE, so a lease core already freed still carries it"
        );
    }

    #[test]
    fn a_free_lease_reads_free_on_both_questions() {
        let state: LeaseState =
            serde_json::from_str(r#"{"held":false,"heldByThisDevice":false,"holder":null}"#)
                .expect("a free lease decodes with a null holder");

        assert!(!state.held);
        assert!(!state.held_by_this_device);
    }

    /// ISS-1139 — a key core resolves to no project must not wedge the close loop.
    ///
    /// A project is hard-deleted, its prefix stays spent, and core answers the
    /// read `404 ISSUE_LEASE_KEY_UNKNOWN_PREFIX` for as long as that row
    /// stands — which is for ever. Turning it into an `Err` leaves
    /// `is_returned` unanswerable, `CloseState::is_closed` false and the master
    /// waiting on a run that can never close. No lease survives the cascade on
    /// `issue_leases.project_id`, so `held: false` is the fact and not a
    /// softened refusal.
    #[tokio::test]
    async fn a_key_that_reaches_no_project_reads_as_no_lease() {
        let url = fake_core::serve_always("404 Not Found", fake_core::UNKNOWN_PREFIX).await;

        let state = lease_state(&client(url), Some("proj-1"), "FD-880")
            .await
            .expect("a key core resolves to no project reaches no lease, which answers the read");

        assert!(
            !state.held_by_this_device,
            "the close loop marks a lease returned only on Ok(true), so an Err here is a run that never closes"
        );
        assert!(!state.held);
    }

    #[tokio::test]
    async fn a_key_core_cannot_parse_reads_as_no_lease() {
        let url = fake_core::serve_always("400 Bad Request", fake_core::KEY_SHAPE).await;

        let state = lease_state(&client(url), Some("proj-1"), "ISS-x")
            .await
            .expect("the store keys every lease by a canonical reference, so a key that is none reaches nothing");

        assert!(!state.held_by_this_device);
    }

    #[tokio::test]
    async fn a_404_that_is_not_about_the_key_is_still_an_error() {
        let url = fake_core::serve_always("404 Not Found", fake_core::ROUTE_ABSENT).await;

        lease_state(&client(url), Some("proj-1"), "ISS-880")
            .await
            .expect_err(
                "a route core does not serve says nothing about any lease, and reading it as `not held` marks one returned that is still standing",
            );
    }

    #[tokio::test]
    async fn a_key_naming_two_projects_at_once_is_still_an_error() {
        let url = fake_core::serve_always("400 Bad Request", fake_core::PROJECT_MISMATCH).await;

        lease_state(&client(url), Some("p-1"), "FD-880")
            .await
            .expect_err(
                "the two identities disagree and a lease may stand under either, so `held: false` would be a guess dressed as a fact",
            );
    }

    /// ISS-1139 — a release core could not narrow carries its way out.
    ///
    /// The close loop logs what this error says, so the sentence naming
    /// `?projectId=` is the whole of what an operator has to act on.
    #[tokio::test]
    async fn a_release_core_could_not_narrow_names_the_way_out_in_its_error() {
        let url = fake_core::serve_always("409 Conflict", fake_core::AMBIGUOUS).await;

        let err = release_lease(&client(url), None, "ISS-880")
            .await
            .expect_err("a box holding one key in two projects gave nothing back");

        assert!(
            format!("{err}").contains("projectId"),
            "an error that drops the way out leaves the operator a run that will not close and no act to take: {err}"
        );
    }

    #[test]
    fn the_close_loop_asks_whether_this_box_gave_it_back() {
        assert!(
            RECOVERY_PORTS.contains("held_by_this_device"),
            "is_returned reading `held` would wedge this box's close loop on an issue another box legitimately holds (ISS-1109)"
        );
    }

    fn keys(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("ISS-{}", 1000 + i)).collect()
    }

    /// Criterion 8, at the extreme the contract allows: the most keys a
    /// declaration may legally carry, each as long as `is_issue_key` permits.
    #[test]
    fn no_legal_declaration_can_build_a_name_core_refuses() {
        let longest: Vec<String> = (0..MAX_ISSUE_KEYS)
            .map(|i| format!("ABCDEF-{}", 1_000_000_000u64 + i as u64))
            .collect();
        for set in [keys(1), keys(2), keys(8), keys(MAX_ISSUE_KEYS), longest] {
            let name = session_name(&set);
            assert!(
                name.encode_utf16().count() <= MAX_NAME_CODE_UNITS,
                "{} keys built a {}-unit name: {name}",
                set.len(),
                name.encode_utf16().count()
            );
            assert!(!name.is_empty(), "core refuses an empty name too");
        }
    }

    /// Criterion 10 where the tail costs more than the keys. Thirty one-character
    /// keys join to 59 units and fit; weighed one at a time against the
    /// `+N more` they would leave, three of them would have been dropped to
    /// make room for a count of three. Unreachable through `run_declare`, and
    /// the property is the function's rather than the cap's.
    #[test]
    fn a_set_that_fits_whole_is_never_shortened_to_make_room_for_its_own_count() {
        let tiny: Vec<String> = (0..30)
            .map(|i| ((b'a' + i % 26) as char).to_string())
            .collect();
        let name = session_name(&tiny);
        assert_eq!(name, tiny.join("+"));
        assert_eq!(name.encode_utf16().count(), 59);
        assert!(!name.contains(" more"), "nothing was left out: {name}");
    }

    /// Criterion 10. The keys that fit are carried whole — a name that drops
    /// one it had room for is a label nobody can match back to its run.
    #[test]
    fn a_name_whose_keys_all_fit_carries_every_one_of_them() {
        assert_eq!(session_name(&keys(1)), "ISS-1000");
        assert_eq!(
            session_name(&keys(6)),
            "ISS-1000+ISS-1001+ISS-1002+ISS-1003+ISS-1004+ISS-1005"
        );
        assert_eq!(
            session_name(&keys(6)).encode_utf16().count(),
            53,
            "six keys is the widest whole set here, and it is under the cap"
        );
    }

    /// Criterion 9. What it could not carry is said, not dropped in silence.
    #[test]
    fn a_name_that_could_not_carry_every_key_says_how_many_it_left() {
        let name = session_name(&keys(10));
        assert!(
            name.ends_with("+4 more"),
            "ten keys, six carried, and the name has to account for the other four: {name}"
        );
        assert!(name.starts_with("ISS-1000+ISS-1001"));
        assert!(name.encode_utf16().count() <= MAX_NAME_CODE_UNITS);
        let count: usize = name
            .rsplit('+')
            .next()
            .and_then(|t| t.trim_end_matches(" more").parse().ok())
            .expect("the tail is a count");
        let carried = name.matches("ISS-").count();
        assert_eq!(
            carried + count,
            10,
            "every key is either carried or counted"
        );
    }

    /// Criterion 8 at the other extreme: one key longer than the whole name is
    /// allowed to be. Unreachable through `run_declare`, which caps a key at
    /// 17 characters, and still total here — a name builder that can panic or
    /// return something core refuses is a second way to wedge a run.
    #[test]
    fn one_key_too_long_for_any_name_is_cut_rather_than_refused() {
        let name = session_name(&[format!("ISS-{}", "9".repeat(200))]);
        assert!(name.encode_utf16().count() <= MAX_NAME_CODE_UNITS);
        assert!(name.ends_with('\u{2026}'), "the cut is marked: {name}");
    }

    #[test]
    fn a_name_outside_the_basic_plane_is_measured_the_way_core_measures_it() {
        let key = "\u{1d518}".repeat(12);
        let set = vec![key.clone(), key.clone(), key.clone()];
        assert_eq!(set.join("+").chars().count(), 38);
        let name = session_name(&set);
        assert!(
            name.encode_utf16().count() <= MAX_NAME_CODE_UNITS,
            "{} units passed a {MAX_NAME_CODE_UNITS}-unit cap: {name}",
            name.encode_utf16().count()
        );
        assert_eq!(name, format!("{key}+{key}+1 more"));
    }

    /// Criterion 18, on both sides of the boundary and on it.
    #[test]
    fn a_detail_within_the_cap_reaches_core_unchanged() {
        for n in [0usize, 1, MAX_DETAIL_CODE_UNITS - 1, MAX_DETAIL_CODE_UNITS] {
            let said = "r".repeat(n);
            assert_eq!(fit(&said, MAX_DETAIL_CODE_UNITS), said, "{n} units");
        }
    }

    /// Criteria 15 and 19. One unit over the cap is cut, the cut is visible,
    /// and what survives is the longest prefix that fits beside the mark.
    #[test]
    fn a_detail_over_the_cap_keeps_the_longest_prefix_that_fits_and_says_it_was_cut() {
        let said = "r".repeat(MAX_DETAIL_CODE_UNITS + 1);
        let cut = fit(&said, MAX_DETAIL_CODE_UNITS);
        assert_eq!(cut.encode_utf16().count(), MAX_DETAIL_CODE_UNITS);
        assert!(cut.ends_with('\u{2026}'));
        assert_eq!(
            cut.trim_end_matches('\u{2026}'),
            "r".repeat(MAX_DETAIL_CODE_UNITS - 1),
            "one unit goes to the mark and every other one is the operator's own text"
        );
    }

    /// Criterion 19 where a `chars()` count and core's count disagree. Each
    /// emoji is two UTF-16 units, so 260 of them are 520 to core and 260 to a
    /// naive cut — and a cut landing inside a surrogate pair is not a string
    /// at all.
    #[test]
    fn a_cut_outside_the_basic_plane_is_measured_the_way_core_measures_it() {
        let said = "\u{1f9ff}".repeat(260);
        assert_eq!(said.chars().count(), 260);
        assert_eq!(said.encode_utf16().count(), 520);
        let cut = fit(&said, MAX_DETAIL_CODE_UNITS);
        assert!(
            cut.encode_utf16().count() <= MAX_DETAIL_CODE_UNITS,
            "{} units survived a 500-unit cap",
            cut.encode_utf16().count()
        );
        assert_eq!(
            cut.chars().filter(|c| *c == '\u{1f9ff}').count(),
            249,
            "499 units of room, two units a character, so 249 whole characters and no half of one"
        );
        assert!(cut.ends_with('\u{2026}'));
    }
}
