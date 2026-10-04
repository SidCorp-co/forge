//! A project's ecosystem channel as master work (ISS-38).
//!
//! Two halves. The wake: `master.wake` names what fired it, and this box keeps
//! that name rather than reducing the frame to its project, refusing a source
//! it does not know by name. The state: what the channel owes a reply to is
//! read from core on every sweep, so a document is admissible work for the
//! master even with an empty backlog and even when its wake was coalesced or
//! lost on a reconnect.

use crate::transport::channel_inbox::{UnansweredDocument, BUILDER_RUN_TYPE};
use crate::transport::comment_inbox::ISSUE_COMMENT_TYPE;

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
                other => Err(format!(
                    "source {other:?} is not one this runner reads (issue, answer, channel, ecosystem_build, workflow_design, comment)"
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
    let (runs, docs): (Vec<&UnansweredDocument>, Vec<&UnansweredDocument>) = inbox
        .into_iter()
        .partition(|d| d.r#type.as_deref() == Some(BUILDER_RUN_TYPE));
    let mut line = String::new();
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
