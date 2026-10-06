//! POST `/me/master-session/verdict`: what core decides about one project's
//! resident master (ADR 0009, What core takes over: Placement and Retirement).
//!
//! The box sends the facts only the machine holds and does what the answer
//! says. There is no local answer to fall back to: a verdict core does not give,
//! or gives in a shape this build does not know, places, ends and nudges nothing.

use serde::{Deserialize, Serialize};

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub restarting: Option<String>,
    pub terminal: bool,
    /// `proceed`, `stood_down` or `unreadable`.
    pub standing: &'static str,
    /// `absent` or `alive`.
    pub pane: &'static str,
    /// `current`, `stale` or `unknown`; `None` where no pane is up or it was
    /// not registered.
    pub capability: Option<&'static str>,
    /// `None` where no pane is up and the declaration was not read.
    pub servers_readable: Option<bool>,
    pub work: Work,
    pub conversation: Conversation,
    pub outdated: Option<String>,
    pub holding: Holding,
    pub turn: Turn,
    pub idle: Idle,
    pub limit: Limit,
    pub nudge: NudgeFacts,
}

/// What the pane's own conversation and hooks say about its account's last
/// refusal; whether that holds the pane is core's.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    pub refusal: Option<LimitRefusal>,
    /// `same`, `other` or `unheard`.
    pub hooks: &'static str,
    pub turn_started_ago_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitRefusal {
    /// `usage_limit`, `rate_limit` or `auth`.
    pub reason: &'static str,
    pub ago_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Work {
    pub admissible: usize,
    pub owed: usize,
    pub pool_waits: bool,
    pub job_panes: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: Option<String>,
    /// `present`, `absent` or `unlocatable`.
    pub transcript: &'static str,
    /// `none`, `running` or `unreadable`.
    pub elsewhere: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Holding {
    Nothing,
    These { runs: Vec<HeldRun> },
    Unknown { why: String },
}

/// A run the pane holds, and what its subagent's own evidence says.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeldRun {
    pub name: String,
    pub subagent: super::run_verdict::Subagent,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Turn {
    Ended,
    InTurn { what: String },
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Idle {
    pub no_work_for_seconds: Option<u64>,
    pub pane: Option<IdlePane>,
    pub children: Children,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdlePane {
    /// `idle`, `working`, `awaiting_permission` or `awaiting_children`.
    pub doing: &'static str,
    pub last_event: String,
    pub last_event_ago_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Children {
    pub total: usize,
    pub unfinished: Vec<String>,
    pub last_closed_ago_seconds: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NudgeFacts {
    pub digest: String,
    pub last: Option<LastNudge>,
    /// One of core's `MASTER_SINCE_NUDGE`.
    pub since: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastNudge {
    pub digest: String,
    pub ago_seconds: u64,
}

/// What core decided. Each reason is kept as core's own word: the box maps the
/// ones it records and says the rest as core said them.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "act", rename_all = "snake_case")]
pub enum Verdict {
    /// Place nothing, end nothing, nudge nothing.
    Withhold { reason: String, because: String },
    /// Start a pane, resuming `resume` or cold; `nudge` opens a pass for its brief.
    Place {
        resume: Option<String>,
        nudge: bool,
        because: String,
    },
    /// End the standing pane, then place its successor as `Place` does.
    Replace {
        reason: String,
        resume: Option<String>,
        nudge: bool,
        because: String,
    },
    /// End the pane and close its session: it is idle.
    Retire { because: String },
    /// The pane stays up and is not driven.
    Leave { reason: String, because: String },
    /// The pane is this project's master; type a nudge into it or not.
    /// `drain`: it is outdated and its replacement waits on the runs it holds,
    /// so the box admits no new run declaration from it until they run out.
    /// Absent from a core older than the field, which never drains.
    Keep {
        nudge: bool,
        #[serde(default)]
        drain: bool,
        because: String,
    },
}

pub async fn verdict(
    client: &CoreClient,
    project_id: &str,
    runner_id: &str,
    facts: &Facts,
) -> Result<Verdict> {
    let body = serde_json::json!({
        "projectId": project_id,
        "runnerId": runner_id,
        "facts": facts,
    });
    let req = client
        .post("/api/devices/me/master-session/verdict")
        .json(&body);
    status::fetch_within(req, "master-session/verdict", CALL_DEADLINE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_act_this_build_does_not_know_is_refused_rather_than_read_as_another() {
        let known: Verdict =
            serde_json::from_str(r#"{"act":"keep","nudge":true,"because":"work changed"}"#)
                .expect("keep decodes");
        assert_eq!(
            known,
            Verdict::Keep {
                nudge: true,
                drain: false,
                because: "work changed".into()
            }
        );
        let draining: Verdict = serde_json::from_str(
            r#"{"act":"keep","nudge":false,"drain":true,"because":"outdated"}"#,
        )
        .expect("a draining keep decodes");
        assert!(matches!(draining, Verdict::Keep { drain: true, .. }));
        assert!(
            serde_json::from_str::<Verdict>(r#"{"act":"adopt","because":"x"}"#).is_err(),
            "an act core added after this build was decoded as one this build acts on"
        );
    }

    #[test]
    fn facts_are_sent_in_the_shape_core_validates() {
        let holding = serde_json::to_value(Holding::These {
            runs: vec![HeldRun {
                name: "r1".into(),
                subagent: ("turn_ended", Some(5)).into(),
            }],
        })
        .unwrap();
        assert_eq!(
            holding,
            serde_json::json!({ "kind": "these", "runs": [
                { "name": "r1", "subagent": { "kind": "turn_ended", "silentMs": 5 } }
            ] })
        );
        let turn = serde_json::to_value(Turn::InTurn {
            what: "busy".into(),
        })
        .unwrap();
        assert_eq!(
            turn,
            serde_json::json!({ "kind": "in_turn", "what": "busy" })
        );
    }
}
