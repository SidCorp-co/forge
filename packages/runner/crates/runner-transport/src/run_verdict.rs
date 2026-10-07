//! POST `/me/run-sessions/verdict`: what core decides about one run the box
//! ledger still holds open (ADR 0009, What core takes over: Recovery verdict).
//!
//! The box sends the facts only the machine holds and does what the answer
//! says. There is no local answer to fall back to: a verdict core does not give,
//! or gives in a shape this build does not know, ends, closes and releases
//! nothing.

use serde::{Deserialize, Serialize};

use super::{status, CoreClient, CALL_DEADLINE};
use runner_platform::error::Result;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub issue_keys: Vec<String>,
    pub parked_on_human: bool,
    /// `alive`, `gone`, `unknown` or `unanswered`.
    pub master: &'static str,
    pub live_master_in_project: bool,
    pub this_boot: bool,
    /// The boot the run was declared under is known to have ended: this box
    /// read its own boot and the run's, and they differ.
    pub boot_ended: bool,
    pub bound: bool,
    /// `none`, `alive` or `gone`.
    pub process: &'static str,
    pub ledger_dead: bool,
    /// `not_read`, `alive`, `gone` or `unreadable`.
    pub host: &'static str,
    /// `pane_gone`, `pane_started` or `process_gone`.
    pub host_ended: Option<&'static str>,
    pub ended: bool,
    pub declared_ago_ms: u64,
    pub checkout_gone: Option<bool>,
    pub has_session: bool,
    pub activity: Option<Activity>,
    pub session_over_for_ms: Option<u64>,
    pub subagent: Subagent,
    pub transcript: Transcript,
    pub release_decided: bool,
    pub release_refused: bool,
    pub close: Option<CloseMarks>,
}

/// What a subagent's own evidence says, with no bound: one of core's
/// `RUN_SUBAGENT_EVIDENCE`, and its silence in ms.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subagent {
    pub kind: &'static str,
    pub silent_ms: Option<u64>,
}

impl From<(&'static str, Option<u64>)> for Subagent {
    fn from((kind, silent_ms): (&'static str, Option<u64>)) -> Self {
        Self { kind, silent_ms }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    /// `working`, `awaiting_permission`, `awaiting_children` or `idle`.
    pub doing: &'static str,
    pub last_event_ago_ms: u64,
    pub written_ago_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Transcript {
    None,
    Unreadable,
    Written { ago_ms: u64 },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseMarks {
    pub session_terminal: bool,
    pub checkout_returned: bool,
    pub leases_returned: usize,
    pub leases_total: usize,
}

/// What a release says first, once.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {
    Unanswered {
        #[serde(rename = "overMs")]
        over_ms: i64,
    },
    Host {
        how: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Release {
    pub reason: String,
    pub notice: Option<Notice>,
}

/// What core decided. An act this build does not know fails to decode, so a
/// verdict it cannot read is never taken for one it can.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "act", rename_all = "snake_case")]
pub enum Verdict {
    /// The box holds the run: beat its session, move a parked run onto the
    /// project's live master, say once why a finished-looking subagent is kept.
    Keep {
        beat: bool,
        reparent: bool,
        #[serde(rename = "sayKept")]
        say_kept: bool,
        because: String,
    },
    /// The run's agent is over: end its process and close its session.
    Exit { cause: String, because: String },
    /// The run is orphaned: end it in the ledger first where `end` names why,
    /// run its close loop, and ask again with the marks read back.
    Close {
        end: Option<String>,
        because: String,
    },
    /// What the close loop left owed.
    Settle {
        release: Option<Release>,
        #[serde(rename = "deathReport")]
        death_report: bool,
        standing: Option<String>,
        #[serde(rename = "releaseAfterMinutes")]
        release_after_minutes: u64,
        because: String,
    },
}

pub async fn verdict(
    client: &CoreClient,
    project_id: Option<&str>,
    facts: &Facts,
) -> Result<Verdict> {
    let body = serde_json::json!({ "projectId": project_id, "facts": facts });
    let req = client
        .post("/api/devices/me/run-sessions/verdict")
        .json(&body);
    status::fetch_within(req, "run-sessions/verdict", CALL_DEADLINE).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_act_this_build_does_not_know_is_refused_rather_than_read_as_another() {
        let settle: Verdict = serde_json::from_str(
            r#"{"act":"settle","release":{"reason":"r","notice":{"kind":"host","how":"pane_gone"}},"deathReport":false,"standing":null,"releaseAfterMinutes":60,"because":"b"}"#,
        )
        .expect("settle decodes");
        assert_eq!(
            settle,
            Verdict::Settle {
                release: Some(Release {
                    reason: "r".into(),
                    notice: Some(Notice::Host {
                        how: "pane_gone".into()
                    }),
                }),
                death_report: false,
                standing: None,
                release_after_minutes: 60,
                because: "b".into(),
            }
        );
        assert!(
            serde_json::from_str::<Verdict>(r#"{"act":"adopt","because":"x"}"#).is_err(),
            "an act core added after this build was decoded as one this build acts on"
        );
    }

    #[test]
    fn facts_are_sent_in_the_shape_core_validates() {
        let t = serde_json::to_value(Transcript::Written { ago_ms: 5 }).unwrap();
        assert_eq!(t, serde_json::json!({ "kind": "written", "agoMs": 5 }));
        let none = serde_json::to_value(Transcript::None).unwrap();
        assert_eq!(none, serde_json::json!({ "kind": "none" }));
    }
}
