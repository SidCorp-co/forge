//! A master pane never waits in a dialog (ISS-1385).
//!
//! Nobody sits at a master pane. A question it opens there stops the pane, and
//! with it the project's board, while nothing on the tracker says anything is
//! waiting: on 2026-10-02 one master sat twelve hours on a dialog about four
//! issues whose rows still read `confirmed`. The owner's rule is that a
//! question the owner owes goes onto the issue, and the master carries on.
//!
//! This module holds the decision and the words of the refusal. `cmd/gate.rs`,
//! the `PreToolUse` hook every placed pane runs, supplies which tmux session
//! the call came from and prints the answer. The routes are the ones the
//! tracker accepts at each status, read with `forge advance <ref> --park <kind>
//! --owed` on 2026-10-05: a question park is refused past `confirmed`, and
//! `release-decision` is the park that moves those statuses to `waiting`.

use crate::daemon::terminal::MASTER_PREFIX;

/// The Claude Code tool that opens a question dialog in the pane.
pub const DIALOG_TOOL: &str = "AskUserQuestion";

/// The route for an issue at `open` or `confirmed`.
pub const ROUTE_OPEN: &str = "`forge record question <ref> --reading \"<reading -> outcome>\" --reading \"<reading -> outcome>\"`, then `forge advance <ref> --park question --why \"<why the work stopped>\" --needs \"<what would settle it>\"`";

/// The route for an issue from `approved` through `testing`.
pub const ROUTE_LATER: &str =
    "`forge advance <ref> --park release-decision --why \"<the question>\"`";

/// The route for a `draft`.
pub const ROUTE_DRAFT: &str = "`forge comment <ref> <question.md>`";

/// The rehearsal that writes nothing.
pub const ROUTE_REHEARSE: &str = "`forge advance <ref> --park <kind> --why \"<why>\" --owed`";

/// Every route the refusal names, which the forge-master skill names too.
pub const ROUTES: [&str; 4] = [ROUTE_OPEN, ROUTE_LATER, ROUTE_DRAFT, ROUTE_REHEARSE];

/// What a master pane is told when it opens a question dialog.
pub fn refusal() -> String {
    format!(
        "Refused: a master pane never waits in a dialog. Nobody is at this pane to answer it, and \
         an open dialog stops this pane and the project's board with it while nothing on the \
         tracker says anything is waiting. Put the question on the issue it is about, then carry \
         on with whatever else is admissible. At open or confirmed: {ROUTE_OPEN}, which moves the \
         issue to needs_info. From approved through testing, where a question park is refused: \
         {ROUTE_LATER}, which moves the issue to waiting. On a draft: {ROUTE_DRAFT}. \
         {ROUTE_REHEARSE} rehearses any park and writes nothing, saying what it would send or \
         what refuses it."
    )
}

/// Which pane a tool call came from, as far as the gate could read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Caller {
    /// Not on the runner's tmux server: a person's own session, never this
    /// rule's subject.
    NotOurs,
    /// A session on the runner's tmux server, by its tmux session name.
    Session(String),
    /// Whether it is on the runner's server, or which session it is, could
    /// not be read, and why.
    Unknown(String),
}

/// What the gate does with a dialog call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Let it through, and say nothing.
    Allow,
    /// Refuse it, with these words.
    Deny(String),
    /// Let it through, and leave a mark saying why the gate could not decide.
    AllowUndecided(String),
}

/// Whether `session` is the tmux session of a master pane.
pub fn is_master_session(session: &str) -> bool {
    session
        .strip_prefix(MASTER_PREFIX)
        .is_some_and(|rest| rest.starts_with('-'))
}

/// The answer to a call of `tool` from `caller`. Only the dialog tool is this
/// rule's subject, and only in a master pane: a job pane's run answers to its
/// own method, and a session off the runner's server is a person's.
pub fn decide(tool: &str, caller: &Caller) -> Verdict {
    if tool != DIALOG_TOOL {
        return Verdict::Allow;
    }
    match caller {
        Caller::NotOurs => Verdict::Allow,
        Caller::Session(name) if is_master_session(name) => Verdict::Deny(refusal()),
        Caller::Session(_) => Verdict::Allow,
        Caller::Unknown(why) => Verdict::AllowUndecided(format!(
            "an {DIALOG_TOOL} call was let through because whether it came from a master pane \
             could not be read ({why}); a master pane that opens one waits in it with nobody to \
             answer"
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SKILL: &str = crate::daemon::master_skill::ASSET;

    #[test]
    fn a_dialog_in_a_master_pane_is_refused_naming_every_route() {
        let Verdict::Deny(why) = decide(
            DIALOG_TOOL,
            &Caller::Session("forge-master-forge-dev".into()),
        ) else {
            panic!("a master pane's dialog is refused");
        };
        for route in ROUTES {
            assert!(why.contains(route), "`{route}` missing: {why}");
        }
        for status in [
            "At open or confirmed",
            "From approved through testing",
            "On a draft",
        ] {
            assert!(why.contains(status), "`{status}` missing: {why}");
        }
    }

    #[test]
    fn the_routes_are_the_ones_the_tracker_accepts_at_each_status() {
        assert!(ROUTE_OPEN.contains("--park question") && ROUTE_OPEN.contains("--needs"));
        assert!(ROUTE_OPEN.starts_with("`forge record question <ref>"));
        assert!(
            ROUTE_LATER.contains("--park release-decision") && !ROUTE_LATER.contains("--needs")
        );
        assert!(ROUTE_DRAFT.starts_with("`forge comment <ref>"));
        assert!(ROUTE_REHEARSE.ends_with("--owed`"));
    }

    #[test]
    fn a_dialog_off_the_runners_server_or_in_a_job_pane_is_allowed_unmarked() {
        assert_eq!(decide(DIALOG_TOOL, &Caller::NotOurs), Verdict::Allow);
        assert_eq!(
            decide(DIALOG_TOOL, &Caller::Session("forge-job-j42".into())),
            Verdict::Allow
        );
        assert_eq!(
            decide(DIALOG_TOOL, &Caller::Session("forge-session-host".into())),
            Verdict::Allow,
            "the keepalive session is no master"
        );
        assert_eq!(
            decide(DIALOG_TOOL, &Caller::Session("forge-masterful".into())),
            Verdict::Allow,
            "a name that only begins with the prefix is not a master pane"
        );
    }

    #[test]
    fn a_dialog_whose_caller_cannot_be_read_is_allowed_and_says_why() {
        match decide(
            DIALOG_TOOL,
            &Caller::Unknown("tmux did not say which session".into()),
        ) {
            Verdict::AllowUndecided(why) => {
                assert!(why.contains("tmux did not say which session"), "{why}");
                assert!(why.contains(DIALOG_TOOL), "{why}");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn every_other_tool_is_not_this_rules_subject() {
        for caller in [
            Caller::Session("forge-master-a".into()),
            Caller::Unknown("x".into()),
            Caller::NotOurs,
        ] {
            assert_eq!(decide("Bash", &caller), Verdict::Allow);
            assert_eq!(decide("Agent", &caller), Verdict::Allow);
        }
    }

    /// Criteria 12 and 13: the skill a master reads names every route the
    /// refusal names, so the two cannot drift apart.
    #[test]
    fn the_master_skill_names_the_rule_and_every_route_the_refusal_names() {
        let skill = crate::test_scratch::lf(SKILL);
        assert!(
            skill.contains("never waits in a pane dialog"),
            "the skill states the rule"
        );
        for route in ROUTES {
            assert!(
                skill.contains(route),
                "the forge-master skill no longer names `{route}`, which the gate's refusal names"
            );
        }
    }
}
