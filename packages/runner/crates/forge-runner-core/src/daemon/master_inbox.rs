//! A project's ecosystem channel as master work (ISS-38).
//!
//! Two halves. The wake: `master.wake` names what fired it, and this box keeps
//! that name rather than reducing the frame to its project, refusing a source
//! it does not know by name. The state: what the channel owes a reply to is
//! read from core on every sweep, so a document is admissible work for the
//! master even with an empty backlog and even when its wake was coalesced or
//! lost on a reconnect.

use crate::transport::channel_inbox::{UnansweredDocument, BUILDER_RUN_TYPE};

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
                other => Err(format!(
                    "source {other:?} is not one this runner reads (issue, answer, channel, ecosystem_build)"
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

/// The sentence a nudge carries when the channel or a builder run owes something, empty when nothing is owed.
pub fn inbox_line(inbox: &[UnansweredDocument]) -> String {
    let (runs, docs): (Vec<&UnansweredDocument>, Vec<&UnansweredDocument>) = inbox
        .iter()
        .partition(|d| d.r#type.as_deref() == Some(BUILDER_RUN_TYPE));
    let mut line = String::new();
    if !docs.is_empty() {
        let numbers: Vec<&str> = docs
            .iter()
            .map(|d| d.number.as_deref().unwrap_or(d.id.as_str()))
            .collect();
        line.push_str(&format!(
            " The ecosystem channel owes {} repl{} ({}): `forge_channel action=unanswered` lists them, and `forge_guide get ecosystem-inbox` is how to work them.",
            docs.len(),
            if docs.len() == 1 { "y" } else { "ies" },
            numbers.join(", ")
        ));
    }
    if !runs.is_empty() {
        let ids: Vec<&str> = runs.iter().map(|d| d.id.as_str()).collect();
        line.push_str(&format!(
            " {} ecosystem builder run{} open ({}): `forge_ecosystem action=builder_runs` lists them, and `forge_guide get ecosystem-inbox` is how to work one.",
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

    fn doc(id: &str, number: &str) -> UnansweredDocument {
        UnansweredDocument {
            id: id.into(),
            number: Some(number.into()),
            r#type: None,
            from: None,
            overdue: false,
        }
    }

    #[test]
    fn each_known_source_reads_as_itself() {
        for (name, want) in [
            ("issue", WakeSource::Issue),
            ("answer", WakeSource::Answer),
            ("channel", WakeSource::Channel),
            ("ecosystem_build", WakeSource::EcosystemBuild),
        ] {
            let got =
                WakeSource::of_frame(&serde_json::json!({ "projectId": "p", "source": name }));
            assert_eq!(got, Ok(want));
            assert_eq!(want.label(), name);
        }
    }

    #[test]
    fn a_frame_from_a_core_before_sources_is_unstated_not_refused() {
        assert_eq!(
            WakeSource::of_frame(&serde_json::json!({ "projectId": "p", "issueId": "i" })),
            Ok(WakeSource::Unstated)
        );
    }

    #[test]
    fn an_unknown_source_is_refused_by_its_name() {
        let why =
            WakeSource::of_frame(&serde_json::json!({ "projectId": "p", "source": "billing" }))
                .unwrap_err();
        assert!(why.contains("\"billing\""), "{why}");
        let why = WakeSource::of_frame(&serde_json::json!({ "source": 7 })).unwrap_err();
        assert!(why.contains("not a string"), "{why}");
    }

    #[test]
    fn an_empty_inbox_leaves_the_issue_digest_as_it_was() {
        assert_eq!(inbox_digest(&[]), 0);
        assert_ne!(inbox_digest(&[doc("d1", "FP-CR-1")]), 0);
    }

    #[test]
    fn the_digest_moves_when_a_document_arrives_and_not_when_the_order_does() {
        let one = inbox_digest(&[doc("d1", "FP-CR-1")]);
        let two = inbox_digest(&[doc("d1", "FP-CR-1"), doc("d2", "FP-RFI-1")]);
        assert_ne!(one, two);
        assert_eq!(
            two,
            inbox_digest(&[doc("d2", "FP-RFI-1"), doc("d1", "FP-CR-1")])
        );
    }

    #[test]
    fn the_nudge_names_the_documents_and_the_guide() {
        assert_eq!(inbox_line(&[]), "");
        let line = inbox_line(&[doc("d1", "FP-CR-1"), doc("d2", "FP-RFI-1")]);
        assert!(line.contains("2 replies (FP-CR-1, FP-RFI-1)"), "{line}");
        assert!(line.contains("ecosystem-inbox"), "{line}");
        assert!(inbox_line(&[doc("d1", "FP-CR-1")]).contains("1 reply ("));
    }

    #[test]
    fn an_open_builder_run_is_named_apart_from_the_documents() {
        let run = UnansweredDocument {
            id: "r1".into(),
            number: None,
            r#type: Some(BUILDER_RUN_TYPE.into()),
            from: Some("e1".into()),
            overdue: false,
        };
        let line = inbox_line(&[doc("d1", "FP-CR-1"), run.clone()]);
        assert!(line.contains("owes 1 reply (FP-CR-1)"), "{line}");
        assert!(
            line.contains("1 ecosystem builder run is open (r1)"),
            "{line}"
        );
        let alone = inbox_line(&[run]);
        assert!(!alone.contains("channel owes"), "{alone}");
        assert!(alone.contains("builder_runs"), "{alone}");
    }
}
