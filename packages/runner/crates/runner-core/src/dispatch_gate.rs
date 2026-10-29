//! Whether the work a master is about to hand to a subagent has been declared.
//!
//! The declaration has existed since ISS-1050 and nothing has ever required it.
//! A master that skipped it ran to completion and everything it handed out was
//! invisible: no reaping could reach it, the load count was short, and the work
//! was never offered again. Measured on sid-desk 2026-09-18 — ISS-335 stood 18
//! hours in-progress with nobody on it, ISS-324 seventeen, and ISS-357/ISS-360
//! ran start to finish leaving no record of who did them.
//!
//! This module holds the decision and nothing else: no socket, no ledger, no
//! transcript. `runner-daemon`'s `control` supplies the facts and carries the
//! answer back; `cmd/gate.rs` is the process a pane's own `PreToolUse` hook
//! runs.
//!
//! A declaration is promised to the tool call the gate let through, and other
//! `PreToolUse` hooks run beside this one: the forge plugin's brief gate
//! refuses a prompt `forge brief` did not print. A call one of them refused
//! started nothing, and its result says so in the master's own transcript,
//! flagged an error, before the next dispatch is made. That result, and not
//! a clock, is what passes the declaration to the next dispatch (ISS-737).
//! No hook fires for the refusal itself: measured with Claude Code 2.1.312,
//! a `PreToolUse` deny fires neither `PostToolUseFailure` nor
//! `PermissionDenied`, and `SubagentStart` names no tool call.
//!
//! The subject is a dispatch to a role this box's plugin copy actually ships,
//! and that is a definition rather than an approximation:
//! `assets/forge-master-skill.md` says a run IS "a subagent dispatched through
//! a shipped role". A master that hands real work through some other
//! `subagent_type` is outside this gate's reach, which is said out loud here
//! rather than absorbed.

use std::collections::BTreeSet;
use std::path::Path;

pub use crate::transcript_age::ToolCall;

pub const REFUSAL: &str =
    "Refused: nothing on this box has been told about the work you are handing out. \
Declare the run first with `forge-runner run declare`, then dispatch the same subagent again. \
A run you declared and decided not to use is closed with `forge-runner run close`, which frees the \
declaration for the next dispatch. Each verb's own `-h` says what it takes. \
Without that row this box holds no record of what you handed out, so if this pane dies the issues \
stay marked as being worked on with nobody working on them.";

#[derive(Debug, Default, Clone)]
pub struct Dispatch {
    /// Present when this tool call was made INSIDE a subagent rather than by the master.
    pub agent_id: Option<String>,
    /// The role the master is dispatching through.
    pub subagent_type: Option<String>,
    /// This tool call's own id, which is what a declaration is promised to.
    pub tool_use_id: Option<String>,
    /// The hook's `transcript_path`: the master's own conversation, where the
    /// call a declaration is promised to has its result written once it ends.
    pub transcript_path: Option<String>,
}

/// What the box knows when the question is asked.
pub struct Facts<'a> {
    /// The roles this box's plugin copies ship, or `None` where they could not be read.
    pub roles: Option<&'a BTreeSet<String>>,
    /// The run this master declared that no subagent has bound yet, if any.
    pub pending_run: Option<&'a str>,
    /// The tool call that pending run is already promised to, if any.
    pub promised_to: Option<&'a str>,
    /// What this dispatch's own conversation says about the call in
    /// `promised_to`, read only where that call is another one, or why it
    /// could not be read.
    pub promised_call: Option<Result<ToolCall, String>>,
}

/// Why a run promised to another tool call is not this one's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Elsewhere {
    /// That call is written and has no result yet, or is not written yet.
    InFlight,
    /// That call answered without an error, so the subagent it started takes the run.
    Started,
    /// Whether that call ended could not be read, and why.
    Unread(String),
}

/// What the gate answers.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Not this gate's subject: not a dispatch, not to a shipped role, or raised inside a child.
    NotOurs,
    /// A declaration covers it, and is now promised to this tool call.
    Covered {
        run_id: String,
    },
    /// The same tool call asked twice; the answer it already had stands.
    Replay {
        run_id: String,
    },
    /// A declaration covered another tool call, which ended in an error and
    /// so started no subagent — a sibling `PreToolUse` hook refused it — and
    /// is now promised to this one instead (ISS-737).
    Moved {
        run_id: String,
        from: String,
    },
    /// A declaration exists and is promised to another tool call that has
    /// not given it up.
    PromisedElsewhere {
        run_id: String,
        to: String,
        why: Elsewhere,
    },
    /// Nothing was declared for it.
    Undeclared,
    Unknown(&'static str),
}

pub fn decide(d: &Dispatch, f: &Facts<'_>) -> Verdict {
    if d.agent_id.is_some() {
        return Verdict::NotOurs;
    }
    let Some(role) = d.subagent_type.as_deref() else {
        return Verdict::NotOurs;
    };
    let Some(roles) = f.roles else {
        return Verdict::Unknown("the roles this box's plugin copy ships could not be read");
    };
    if shipped(roles, role).is_none() {
        return Verdict::NotOurs;
    }
    let Some(run_id) = f.pending_run else {
        return Verdict::Undeclared;
    };
    if d.tool_use_id.is_none() {
        return Verdict::Unknown(
            "this dispatch carries no tool call id, so no declaration can be promised to it",
        );
    }
    match f.promised_to {
        None => Verdict::Covered {
            run_id: run_id.to_string(),
        },
        Some(t) if Some(t) == d.tool_use_id.as_deref() => Verdict::Replay {
            run_id: run_id.to_string(),
        },
        Some(t) => {
            let why = match &f.promised_call {
                Some(Ok(ToolCall::Failed)) => {
                    return Verdict::Moved {
                        run_id: run_id.to_string(),
                        from: t.to_string(),
                    }
                }
                Some(Ok(ToolCall::Answered)) => Elsewhere::Started,
                Some(Ok(ToolCall::Unanswered | ToolCall::Unseen)) => Elsewhere::InFlight,
                Some(Err(why)) => Elsewhere::Unread(why.clone()),
                None => Elsewhere::Unread(
                    "nothing read this dispatch's conversation for that call".to_string(),
                ),
            };
            Verdict::PromisedElsewhere {
                run_id: run_id.to_string(),
                to: t.to_string(),
                why,
            }
        }
    }
}

/// The refusal for a dispatch whose master's declaration is promised to
/// another tool call: which run, which call, whether that call is still in
/// flight, and what to do. It never says nothing was declared, because
/// something was (ISS-737).
pub fn promised_elsewhere(run_id: &str, to: &str, why: &Elsewhere) -> String {
    let head = format!(
        "Refused: run {run_id} is declared on this box and is promised to tool call {to}, an \
         earlier dispatch of yours. One declaration covers one subagent."
    );
    let tail = match why {
        Elsewhere::InFlight => format!(
            "That call is still in flight: this conversation holds no result for it yet, as with \
             a second dispatch in the same message. Dispatch this one again in a message of its \
             own once that call has answered. If that call is refused, run {run_id} passes to the \
             next dispatch by itself. If it starts its subagent, that subagent takes run \
             {run_id}, so declare a run of this hand-off's own with `forge-runner run declare` \
             first."
        ),
        Elsewhere::Started => format!(
            "That call answered without an error, so it started a subagent, which takes run \
             {run_id}. This hand-off is a second subagent: declare a run of its own with \
             `forge-runner run declare`, then dispatch it again."
        ),
        Elsewhere::Unread(cause) => format!(
            "Whether that call has ended could not be read ({cause}). If it was refused and \
             started nothing, `forge-runner run close {run_id}` frees the declaration; declare \
             again with `forge-runner run declare`, then dispatch."
        ),
    };
    format!("{head} {tail}")
}

/// The role in `roles` that `name` is, by the one rule every reader here
/// matches a role by: `roles` holds `<plugin>:<role>`, the name Claude Code
/// sends (`forge:runner`), and a bare `runner` is that same role in whichever
/// copy ships it. Before it, the inventory held the bare stem and Claude Code
/// sent the namespaced name, so no dispatch Claude Code ever made matched and
/// the gate passed every one of them as not its subject (ISS-1378).
pub fn shipped<'r>(roles: &'r BTreeSet<String>, name: &str) -> Option<&'r String> {
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    roles.iter().find(|r| {
        *r == name || (!name.contains(':') && r.rsplit_once(':').map(|(_, s)| s) == Some(name))
    })
}

/// Whether a subagent that just started under a master is the one that
/// master's pending declaration was made for, or why it is not.
///
/// A master starts subagents the box knows nothing about — a search, a review —
/// and the first of them to start used to take the binding meant for the run
/// (ISS-1378). Only a role this box ships does the work a declaration is made
/// for, and where the gate promised the run to a dispatch the promise carries
/// that dispatch's role. With the inventory unread, the role the promised
/// dispatch named is still the run's (ISS-1390): the gate let it through and
/// promised the run to it.
pub fn claims_the_run(
    agent_type: Option<&str>,
    roles: Option<&BTreeSet<String>>,
    promised_role: Option<&str>,
) -> Result<(), String> {
    let Some(role) = agent_type else {
        return Err(
            "its hook named no agent type, so which agent is the run's cannot be told and it is \
             not taken for the run's"
                .to_string(),
        );
    };
    let Some(roles) = roles else {
        if promised_role == Some(role) {
            return Ok(());
        }
        return Err(format!(
            "the roles this box's plugin copy ships could not be read and no dispatch naming \
             `{role}` was promised the run, so whether `{role}` is the run's cannot be told and it \
             is not taken for the run's"
        ));
    };
    let Some(is) = shipped(roles, role) else {
        return Err(format!(
            "`{role}` is no role this box ships, so it is a helper of the master's and not the \
             run's"
        ));
    };
    match promised_role {
        Some(promised) if shipped(roles, promised) != Some(is) => Err(format!(
            "the run was promised to a `{promised}` dispatch and this subagent started as `{role}`"
        )),
        _ => Ok(()),
    }
}

/// What a stat of one marketplace's `plugin/agents` established about it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Agents {
    /// That marketplace ships no roles, and that IS knowledge. `codemap` is one
    /// of them on this box.
    Absent,
    /// A directory whose role files can be listed.
    Readable,
    /// This box could not find out, so the inventory cannot be completed.
    Unreadable,
}

pub(crate) fn agents_reach(stat: Result<bool, std::io::ErrorKind>) -> Agents {
    match stat {
        Err(std::io::ErrorKind::NotFound) => Agents::Absent,
        Err(_) => Agents::Unreadable,
        Ok(false) => Agents::Absent,
        Ok(true) => Agents::Readable,
    }
}

/// The name a plugin copy's manifest gives it, which Claude Code puts in
/// front of every role that copy ships: `forge:runner`, never `runner`.
fn plugin_name(plugin: &Path) -> Option<String> {
    let text = std::fs::read_to_string(plugin.join(".claude-plugin").join("plugin.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&text).ok()?;
    doc.get("name")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
}

/// Every role this box's plugin copies ship, by the name Claude Code sends:
/// `<plugin>:<role>`. Match a name against it with [`shipped`].
pub fn shipped_roles(config_dir: &Path) -> Option<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for clone in std::fs::read_dir(config_dir.join("marketplaces")).ok()? {
        // A directory entry this box could not read leaves the inventory
        // incomplete, and an incomplete inventory is indistinguishable from a
        // complete one at every reader.
        let clone = clone.ok()?;
        let plugin = clone.path().join("plugin");
        let agents = plugin.join("agents");
        match agents_reach(
            std::fs::metadata(&agents)
                .map(|m| m.is_dir())
                .map_err(|e| e.kind()),
        ) {
            Agents::Absent => continue,
            Agents::Unreadable => return None,
            Agents::Readable => {}
        }
        // A copy whose roles cannot be named as Claude Code names them leaves
        // the inventory as incomplete as one whose directory could not be read.
        let name = plugin_name(&plugin)?;
        for agent in std::fs::read_dir(agents).ok()? {
            let path = agent.ok()?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.insert(format!("{name}:{stem}"));
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roles() -> BTreeSet<String> {
        ["forge:runner", "forge:reviewer"]
            .into_iter()
            .map(str::to_string)
            .collect()
    }

    fn asked(tool_use: &str) -> Dispatch {
        Dispatch {
            subagent_type: Some("forge:runner".into()),
            tool_use_id: Some(tool_use.into()),
            ..Dispatch::default()
        }
    }

    fn facts<'a>(
        roles: &'a BTreeSet<String>,
        pending: Option<&'a str>,
        to: Option<&'a str>,
        call: Option<Result<ToolCall, String>>,
    ) -> Facts<'a> {
        Facts {
            roles: Some(roles),
            pending_run: pending,
            promised_to: to,
            promised_call: call,
        }
    }

    /// ISS-737: a run promised to a call that ended in an error passes to the
    /// next; any other state of that call keeps it, and is named.
    #[test]
    fn a_run_promised_elsewhere_moves_only_off_a_call_that_ended_in_an_error() {
        let r = roles();
        let run = Some("run-1");
        assert_eq!(
            decide(
                &asked("t2"),
                &facts(&r, run, Some("t1"), Some(Ok(ToolCall::Failed)))
            ),
            Verdict::Moved {
                run_id: "run-1".into(),
                from: "t1".into()
            }
        );
        for (call, why) in [
            (Some(Ok(ToolCall::Unanswered)), Elsewhere::InFlight),
            (Some(Ok(ToolCall::Unseen)), Elsewhere::InFlight),
            (Some(Ok(ToolCall::Answered)), Elsewhere::Started),
            (
                Some(Err("unread".to_string())),
                Elsewhere::Unread("unread".into()),
            ),
        ] {
            assert_eq!(
                decide(&asked("t2"), &facts(&r, run, Some("t1"), call)),
                Verdict::PromisedElsewhere {
                    run_id: "run-1".into(),
                    to: "t1".into(),
                    why
                }
            );
        }
        assert_eq!(
            decide(&asked("t1"), &facts(&r, run, Some("t1"), None)),
            Verdict::Replay {
                run_id: "run-1".into()
            },
            "the call a run is promised to, asked again, is a replay"
        );
        assert_eq!(
            decide(
                &asked("t2"),
                &facts(&r, None, None, Some(Ok(ToolCall::Failed)))
            ),
            Verdict::Undeclared
        );
    }

    #[test]
    fn a_refusal_for_a_run_promised_elsewhere_names_the_run_the_call_and_the_way_out() {
        for why in [
            Elsewhere::InFlight,
            Elsewhere::Started,
            Elsewhere::Unread("no transcript".into()),
        ] {
            let said = promised_elsewhere("run-1", "toolu_1", &why);
            assert!(
                said.contains("run run-1") && said.contains("toolu_1"),
                "{said}"
            );
            assert!(said.contains("forge-runner run "), "{said}");
            assert!(
                !said.contains("nothing on this box has been told"),
                "{said}"
            );
        }
        assert!(promised_elsewhere("r", "t", &Elsewhere::InFlight).contains("in flight"));
    }

    #[test]
    fn a_role_matches_by_its_namespaced_name_and_by_its_bare_one() {
        let r = roles();
        assert_eq!(
            shipped(&r, "forge:runner").map(String::as_str),
            Some("forge:runner")
        );
        assert_eq!(
            shipped(&r, "runner").map(String::as_str),
            Some("forge:runner")
        );
        assert_eq!(
            shipped(&r, "other:runner"),
            None,
            "another plugin's role is not this one"
        );
        assert_eq!(shipped(&r, "Explore"), None);
        assert_eq!(shipped(&r, ""), None);
    }

    #[test]
    fn the_inventory_names_each_role_as_claude_code_does_and_a_nameless_copy_leaves_it_unread() {
        let dir = std::env::temp_dir().join(format!(
            "forge-gate-{}-{}",
            std::process::id(),
            crate::agent_activity::now_ms()
        ));
        let plugin = dir.join("marketplaces/a/plugin");
        std::fs::create_dir_all(plugin.join("agents")).unwrap();
        std::fs::create_dir_all(plugin.join(".claude-plugin")).unwrap();
        std::fs::write(plugin.join("agents/runner.md"), "---\n").unwrap();
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"version":"1"}"#,
        )
        .unwrap();
        assert_eq!(
            shipped_roles(&dir),
            None,
            "a copy no manifest names is not an inventory"
        );
        std::fs::write(
            plugin.join(".claude-plugin/plugin.json"),
            r#"{"name":"forge"}"#,
        )
        .unwrap();
        assert_eq!(
            shipped_roles(&dir),
            Some(["forge:runner".to_string()].into_iter().collect())
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_a_shipped_role_the_run_was_promised_to_claims_it() {
        let r = roles();
        assert_eq!(claims_the_run(Some("forge:runner"), Some(&r), None), Ok(()));
        assert_eq!(
            claims_the_run(Some("runner"), Some(&r), Some("forge:runner")),
            Ok(())
        );
        let why = claims_the_run(Some("Explore"), Some(&r), None).expect_err("a helper");
        assert!(why.contains("helper"), "{why}");
        let why = claims_the_run(Some("forge:reviewer"), Some(&r), Some("forge:runner"))
            .expect_err("another role than promised");
        assert!(why.contains("promised to a `forge:runner`"), "{why}");
        assert!(claims_the_run(None, Some(&r), None).is_err());
        assert_eq!(
            claims_the_run(Some("forge:runner"), None, Some("forge:runner")),
            Ok(()),
            "with no inventory, the role the promised dispatch named is the run's"
        );
        let why = claims_the_run(Some("forge:runner"), None, None).expect_err("nothing promised");
        assert!(why.contains("cannot be told"), "{why}");
    }
}
