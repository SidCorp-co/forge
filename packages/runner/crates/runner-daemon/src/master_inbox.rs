//! A project's ecosystem channel as master work (ISS-38).
//!
//! Two halves. The wake: `master.wake` names what fired it, and this box keeps
//! that name rather than reducing the frame to its project, refusing a source
//! it does not know by name. The state: what the channel owes a reply to is
//! read from core on every sweep, so a document is admissible work for the
//! master even with an empty backlog and even when its wake was coalesced or
//! lost on a reconnect.

use runner_transport::channel_inbox::{UnansweredDocument, BUILDER_RUN_TYPE};
use runner_transport::comment_inbox::ISSUE_COMMENT_TYPE;
use runner_transport::requirement_inbox::REQUIREMENT_BREAKDOWN_TYPE;

/// What fired a `master.wake`, as core's `ws/master-wake.ts:MASTER_WAKE_SOURCES` names it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WakeSource {
    /// An issue arrived at, or returned to, a status a master looks at.
    Issue,
    /// A question this project was waiting on was answered.
    Answer,
    /// The project's ecosystem channel moved: a document published to it, or a hold.
    Channel,
    /// A builder run was opened for the project, by a join or a push (ISS-39).
    EcosystemBuild,
    /// The approver decided a workflow design the project proposed: an approve unblocks its builds,
    /// a return hands the drawing back to the issue it was drawn under.
    WorkflowDesign,
    /// A person commented on one of the project's issues, at whatever status it stands.
    Comment,
    /// A requirement was agreed, or re-agreed at a new head, and the master owes its breakdown.
    Requirement,
    /// Feedback was filed at high or critical severity.
    Feedback,
    /// A frame naming no source.
    ///
    /// Priced amnesty: a core that predates ISS-38 stamps none on its issue and
    /// answer wakes, so absence is read as the backlog wake it was then. It
    /// ends once every core this runner pairs with sends a source; a channel
    /// wake has carried one since it was introduced.
    Unstated,
}

impl WakeSource {
    /// The source `data` names, or why it is refused.
    pub fn of_frame(data: &serde_json::Value) -> Result<Self, String> {
        match data.get("source") {
            None => Ok(WakeSource::Unstated),
            Some(serde_json::Value::String(s)) => match s.as_str() {
                "issue" => Ok(WakeSource::Issue),
                "answer" => Ok(WakeSource::Answer),
                "channel" => Ok(WakeSource::Channel),
                "ecosystem_build" => Ok(WakeSource::EcosystemBuild),
                "workflow_design" => Ok(WakeSource::WorkflowDesign),
                "comment" => Ok(WakeSource::Comment),
                "requirement" => Ok(WakeSource::Requirement),
                "feedback" => Ok(WakeSource::Feedback),
                other => Err(format!(
                    "source {other:?} is not one this runner reads (issue, answer, channel, ecosystem_build, workflow_design, comment, requirement, feedback)"
                )),
            },
            Some(other) => Err(format!("source {other} is not a string")),
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            WakeSource::Issue => "issue",
            WakeSource::Answer => "answer",
            WakeSource::Channel => "channel",
            WakeSource::EcosystemBuild => "ecosystem_build",
            WakeSource::WorkflowDesign => "workflow_design",
            WakeSource::Comment => "comment",
            WakeSource::Requirement => "requirement",
            WakeSource::Feedback => "feedback",
            WakeSource::Unstated => "source unstated",
        }
    }
}

/// A digest of the documents owed, `0` for none, so a set of issues alone hashes as it always has.
pub fn inbox_digest(inbox: &[UnansweredDocument]) -> u64 {
    use std::hash::{Hash, Hasher};
    if inbox.is_empty() {
        return 0;
    }
    let mut ids: Vec<&str> = inbox.iter().map(|d| d.id.as_str()).collect();
    ids.sort_unstable();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    "channel".hash(&mut h);
    for id in ids {
        id.hash(&mut h);
    }
    h.finish()
}

/// The sentence a nudge carries when the channel, a builder run or an issue thread owes something, empty when nothing is owed.
pub fn inbox_line(inbox: &[UnansweredDocument]) -> String {
    let (comments, inbox): (Vec<&UnansweredDocument>, Vec<&UnansweredDocument>) = inbox
        .iter()
        .partition(|d| d.r#type.as_deref() == Some(ISSUE_COMMENT_TYPE));
    let (breakdowns, inbox): (Vec<&UnansweredDocument>, Vec<&UnansweredDocument>) = inbox
        .into_iter()
        .partition(|d| d.r#type.as_deref() == Some(REQUIREMENT_BREAKDOWN_TYPE));
    let (runs, docs): (Vec<&UnansweredDocument>, Vec<&UnansweredDocument>) = inbox
        .into_iter()
        .partition(|d| d.r#type.as_deref() == Some(BUILDER_RUN_TYPE));
    let mut line = String::new();
    if !breakdowns.is_empty() {
        let keys: Vec<String> = breakdowns
            .iter()
            .map(|d| {
                let key = d.number.as_deref().unwrap_or(d.id.as_str());
                if d.overdue {
                    format!("{key} overdue")
                } else {
                    key.to_string()
                }
            })
            .collect();
        line.push_str(&format!(
            " {} agreed requirement{} no breakdown yet ({}): read each (`forge-runner api projects/<id>/requirements/<key>`) and propose its breakdown as a suggestion; an overdue one is past its breakdown SLA.",
            breakdowns.len(),
            if breakdowns.len() == 1 { " has" } else { "s have" },
            keys.join(", ")
        ));
    }
    if !comments.is_empty() {
        // Core clears an owed question only on a reply threaded under it (`devices/comment-inbox.ts`),
        // so each is named with the comment id the reply's `parentId` takes.
        let keys: Vec<String> = comments
            .iter()
            .map(|d| match d.number.as_deref() {
                Some(key) => format!("{key} comment {}", d.id),
                None => d.id.clone(),
            })
            .collect();
        line.push_str(&format!(
            " A person is owed a reply on {} issue{} ({}): read each thread (`forge-runner api issues/<id>/comments`), reply to that comment in its thread (`forge-runner api issues/<id>/comments -X POST` with `parentId` set to the comment id), and move the issue when the comment asks for it; only a threaded reply clears it, a top-level comment does not.",
            comments.len(),
            if comments.len() == 1 { "" } else { "s" },
            keys.join(", ")
        ));
    }
    if !docs.is_empty() {
        let numbers: Vec<&str> = docs
            .iter()
            .map(|d| d.number.as_deref().unwrap_or(d.id.as_str()))
            .collect();
        line.push_str(&format!(
            " The ecosystem channel owes {} repl{} ({}): `forge_channel action=unanswered` lists them, and `forge-runner api guides/ecosystem-inbox.md` is how to work them.",
            docs.len(),
            if docs.len() == 1 { "y" } else { "ies" },
            numbers.join(", ")
        ));
    }
    if !runs.is_empty() {
        let ids: Vec<&str> = runs.iter().map(|d| d.id.as_str()).collect();
        line.push_str(&format!(
            " {} ecosystem builder run{} open ({}): `forge_ecosystem action=builder_runs` lists them, and `forge-runner api guides/ecosystem-inbox.md` is how to work one.",
            runs.len(),
            if runs.len() == 1 { " is" } else { "s are" },
            ids.join(", ")
        ));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_requirement_wake_is_read_by_its_name() {
        let source = WakeSource::of_frame(&serde_json::json!({ "source": "requirement" })).unwrap();
        assert_eq!(source, WakeSource::Requirement);
        assert_eq!(source.label(), "requirement");
    }

    #[test]
    fn a_feedback_wake_is_read_by_its_name() {
        let source = WakeSource::of_frame(&serde_json::json!({ "source": "feedback" })).unwrap();
        assert_eq!(source, WakeSource::Feedback);
        assert_eq!(source.label(), "feedback");
    }

    #[test]
    fn an_owed_breakdown_is_named_on_the_pass_and_an_overdue_one_says_so() {
        let doc = |key: &str, overdue: bool| UnansweredDocument {
            id: format!("id-{key}"),
            number: Some(key.into()),
            r#type: Some(REQUIREMENT_BREAKDOWN_TYPE.into()),
            from: None,
            overdue,
        };
        let line = inbox_line(&[doc("REQ-3", true), doc("REQ-4", false)]);
        assert!(
            line.contains("2 agreed requirements have no breakdown yet (REQ-3 overdue, REQ-4)"),
            "{line}"
        );
        assert!(!line.contains("ecosystem channel"), "{line}");
    }
}
