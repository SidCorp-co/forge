//! What fired a `master.wake` (ISS-38). This box keeps that name rather than
//! reducing the frame to its project, refusing a source it does not know by
//! name. The wake only makes a sweep come sooner: what the project owes its
//! master is read by core on every verdict (`masters/owed.ts`), so a wake that
//! was coalesced or lost on a reconnect loses nothing.

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
    /// a return hands the drawing back to the issue it was drawn under, or, with no live issue, to
    /// the master, whose verdict core answers with it named.
    WorkflowDesign,
    /// A person commented on one of the project's issues, at whatever status it stands.
    Comment,
    /// A requirement was agreed, or re-agreed at a new head, and the master owes its breakdown; or
    /// an agent-written revision was returned, and the master owes its revise.
    Requirement,
    /// Feedback was filed, at whatever severity.
    Feedback,
}

impl WakeSource {
    /// The source `data` names, or why it is refused.
    pub fn of_frame(data: &serde_json::Value) -> Result<Self, String> {
        match data.get("source") {
            None => Err("it names no source (issue, answer, channel, ecosystem_build, workflow_design, comment, requirement, feedback)".to_string()),
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
        }
    }
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
    fn a_wake_naming_no_source_is_refused_by_name() {
        let refused = WakeSource::of_frame(&serde_json::json!({ "projectId": "p" }))
            .expect_err("a frame with no source was read as a wake");
        assert!(refused.contains("names no source"), "{refused}");
    }

    #[test]
    fn a_feedback_wake_is_read_by_its_name() {
        let source = WakeSource::of_frame(&serde_json::json!({ "source": "feedback" })).unwrap();
        assert_eq!(source, WakeSource::Feedback);
        assert_eq!(source.label(), "feedback");
    }
}
