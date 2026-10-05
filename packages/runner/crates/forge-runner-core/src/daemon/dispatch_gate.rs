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
//! files. `daemon/control.rs` supplies the facts and carries the answer back;
//! `cmd/gate.rs` is the process a pane's own `PreToolUse` hook runs.
//!
//! The subject is a dispatch to a role this box's plugin copy actually ships,
//! and that is a definition rather than an approximation:
//! `assets/forge-master-skill.md` says a run IS "a subagent dispatched through
//! a shipped role". A master that hands real work through some other
//! `subagent_type` is outside this gate's reach, which is said out loud here
//! rather than absorbed.

use std::collections::BTreeSet;
use std::path::Path;

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
}

/// What the box knows when the question is asked.
pub struct Facts<'a> {
    /// The roles this box's plugin copies ship, or `None` where they could not be read.
    pub roles: Option<&'a BTreeSet<String>>,
    /// The run this master declared that no subagent has bound yet, if any.
    pub pending_run: Option<&'a str>,
    /// The tool call that pending run is already promised to, if any.
    pub promised_to: Option<&'a str>,
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
    if !roles.contains(role) {
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
        Some(_) => Verdict::Undeclared,
    }
}

/// Whether a subagent that just started under a master is the one that
/// master's pending declaration was made for, or why it is not.
///
/// A master starts subagents the box knows nothing about — a search, a review —
/// and before this the first of them to start took the binding meant for the
/// run (ISS-1378). Only a role this box ships does the work a declaration is
/// made for, and where the gate promised the run to a dispatch the promise
/// carries that dispatch's role. A master holds one unbound declaration at a
/// time and the gate refuses every shipped-role dispatch but the one it
/// promised, so while the gate works the only shipped-role start under a
/// promise is the promised one. The tool call itself cannot be matched here:
/// Claude Code writes the child's metadata naming it after this hook is
/// answered.
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
        return Err(format!(
            "the roles this box's plugin copy ships could not be read, so whether `{role}` is the \
             run's cannot be told and it is not taken for the run's"
        ));
    };
    if !roles.contains(role) {
        return Err(format!(
            "`{role}` is no role this box ships, so it is a helper of the master's and not the \
             run's"
        ));
    }
    match promised_role {
        Some(promised) if promised != role => Err(format!(
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
/// `<plugin>:<role>`. The file stem alone matched no dispatch Claude Code ever
/// made, so the gate passed every one of them as not its subject (ISS-1378:
/// 15 bindings and no promise in three days of the live journal).
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

    use crate::test_scratch::Scratch;

    fn roles() -> BTreeSet<String> {
        ["runner", "reviewer", "qa", "triage", "evaluator"]
            .into_iter()
            .map(|r| format!("forge:{r}"))
            .collect()
    }

    /// A plugin copy as the daemon syncs one: its manifest naming it, and a
    /// file per role.
    fn a_copy(at: &Path, name: Option<&str>, roles: &[&str]) {
        let plugin = at.join("plugin");
        std::fs::create_dir_all(plugin.join("agents")).expect("tree");
        std::fs::create_dir_all(plugin.join(".claude-plugin")).expect("tree");
        let manifest = match name {
            Some(n) => format!("{{\"name\": \"{n}\", \"version\": \"1\"}}"),
            None => "{\"version\": \"1\"}".to_string(),
        };
        std::fs::write(plugin.join(".claude-plugin/plugin.json"), manifest).expect("manifest");
        for role in roles {
            std::fs::write(plugin.join("agents").join(format!("{role}.md")), "---\n")
                .expect("agent");
        }
    }

    fn dispatch(role: &str, tool_use: &str) -> Dispatch {
        Dispatch {
            agent_id: None,
            subagent_type: Some(role.into()),
            tool_use_id: Some(tool_use.into()),
        }
    }

    fn facts<'a>(
        roles: Option<&'a BTreeSet<String>>,
        pending: Option<&'a str>,
        promised: Option<&'a str>,
    ) -> Facts<'a> {
        Facts {
            roles,
            pending_run: pending,
            promised_to: promised,
        }
    }

    /// Criterion 1. The whole of the issue in one assertion.
    #[test]
    fn a_dispatch_to_a_shipped_role_with_nothing_declared_is_refused() {
        let r = roles();
        assert_eq!(
            decide(
                &dispatch("forge:runner", "toolu_1"),
                &facts(Some(&r), None, None)
            ),
            Verdict::Undeclared
        );
    }

    /// Criteria 2, 3. The refusal is the deliverable, so both ways out are in it.
    #[test]
    fn the_refusal_names_both_the_declaration_and_the_close() {
        assert!(
            REFUSAL.contains("forge-runner run declare"),
            "a refusal that does not name the verb is the same silence in a louder font: {REFUSAL}"
        );
        assert!(
            REFUSAL.contains("forge-runner run close"),
            "a master holding a declaration it promised elsewhere cannot act on `declare` alone: {REFUSAL}"
        );
    }

    /// Criterion 4.
    #[test]
    fn a_dispatch_a_declaration_covers_goes_through() {
        let r = roles();
        assert_eq!(
            decide(
                &dispatch("forge:runner", "toolu_1"),
                &facts(Some(&r), Some("run-7"), None)
            ),
            Verdict::Covered {
                run_id: "run-7".into()
            }
        );
    }

    /// Criterion 5. One declaration, one dispatch.
    #[test]
    fn a_second_dispatch_cannot_ride_one_declaration() {
        let r = roles();
        let f = facts(Some(&r), Some("run-7"), Some("toolu_1"));
        assert_eq!(
            decide(&dispatch("forge:runner", "toolu_2"), &f),
            Verdict::Undeclared,
            "two subagents under one declared row is two units of work with one record"
        );
    }

    /// Criterion 6, within one boot.
    #[test]
    fn the_same_tool_call_asked_twice_gets_the_answer_it_already_had() {
        let r = roles();
        let f = facts(Some(&r), Some("run-7"), Some("toolu_1"));
        assert_eq!(
            decide(&dispatch("forge:runner", "toolu_1"), &f),
            Verdict::Replay {
                run_id: "run-7".into()
            }
        );
    }

    /// Criterion 8. A search helper is not a hand-off.
    #[test]
    fn a_subagent_type_this_box_ships_no_role_for_goes_through() {
        let r = roles();
        assert_eq!(
            decide(
                &dispatch("general-purpose", "toolu_1"),
                &facts(Some(&r), None, None)
            ),
            Verdict::NotOurs
        );
    }

    /// Criterion 9. A child's own tool call answers to its parent's declaration.
    #[test]
    fn a_tool_call_raised_inside_a_child_is_not_this_gates_subject() {
        let r = roles();
        let mut d = dispatch("forge:runner", "toolu_1");
        d.agent_id = Some("acf9b1721de184fa7".into());
        assert_eq!(decide(&d, &facts(Some(&r), None, None)), Verdict::NotOurs);
    }

    #[test]
    fn a_dispatch_with_no_tool_call_id_is_uncertain_rather_than_covered() {
        let r = roles();
        let mut d = dispatch("forge:runner", "toolu_1");
        d.tool_use_id = None;
        let v = decide(&d, &facts(Some(&r), Some("run-7"), None));
        assert!(
            matches!(v, Verdict::Unknown(_)),
            "an unreservable dispatch described as covered is a silent pass: {v:?}"
        );
    }

    #[test]
    fn a_dispatch_with_no_tool_call_id_is_still_refused_when_nothing_is_declared() {
        // The id is missing either way. What differs is whether the ledger KNOWS the answer: with
        // nothing declared it does, and a fact the box holds is not softened into uncertainty by a
        // payload that happens to be thin. This pins the id check BELOW the pending-run check --
        // hoisting it turns this refusal into an allow and every other test here stays green.
        let r = roles();
        let mut d = dispatch("forge:runner", "toolu_1");
        d.tool_use_id = None;
        let v = decide(&d, &facts(Some(&r), None, None));
        assert!(
            matches!(v, Verdict::Undeclared),
            "nothing declared is a fact this box holds, so it is refused whatever the payload carries: {v:?}"
        );
    }

    #[test]
    fn a_second_ride_on_one_declaration_is_uncertain_rather_than_refused_when_the_id_is_gone() {
        // A deliberate narrowing of the single-use refusal, named so it is not mistaken for an
        // oversight: with the promised id present and this dispatch carrying none, the box cannot
        // tell a replay whose id was stripped from a genuine second ride. It allows and marks, and
        // whichever child ends up unbound is denounced at SubagentStart instead.
        let r = roles();
        let mut d = dispatch("forge:runner", "toolu_1");
        d.tool_use_id = None;
        let v = decide(&d, &facts(Some(&r), Some("run-7"), Some("toolu_other")));
        assert!(
            matches!(v, Verdict::Unknown(_)),
            "a dispatch the box cannot match against the promise it holds is uncertain, not refused: {v:?}"
        );
    }

    #[test]
    fn a_role_set_that_could_not_be_read_is_unknown_and_not_no_match() {
        let v = decide(
            &dispatch("forge:runner", "toolu_1"),
            &facts(None, None, None),
        );
        assert!(
            matches!(v, Verdict::Unknown(_)),
            "an unreadable role set must be UNKNOWN, not a silent pass: {v:?}"
        );
        assert_ne!(v, Verdict::NotOurs);
    }

    /// Review F3, the classification itself — on every platform this crate builds for.
    ///
    /// This is the assertion that matters and it needs no filesystem: a stat that
    /// FAILED for any reason but absence leaves the inventory incomplete, and an
    /// incomplete inventory is indistinguishable from a complete one at every
    /// reader, so every role in the half that was not read would be classified
    /// `NotOurs` with no refusal, no mark and nothing said.
    #[test]
    fn a_stat_that_failed_is_never_read_as_an_absent_directory() {
        use std::io::ErrorKind;
        assert_eq!(
            agents_reach(Err(ErrorKind::PermissionDenied)),
            Agents::Unreadable,
            "a directory this box may not stat is not a directory that is not there"
        );
        assert_eq!(
            agents_reach(Err(ErrorKind::NotFound)),
            Agents::Absent,
            "absence IS knowledge: that marketplace ships no roles"
        );
        assert_eq!(
            agents_reach(Ok(false)),
            Agents::Absent,
            "a file where a directory belongs ships no roles"
        );
        assert_eq!(agents_reach(Ok(true)), Agents::Readable);
    }

    #[cfg(unix)]
    #[test]
    fn a_role_scan_that_could_not_finish_is_not_a_partial_answer() {
        let dir = Scratch::new("partialroles");
        a_copy(
            &dir.path().join("marketplaces/a__plugin"),
            Some("forge"),
            &["runner"],
        );

        // A second clone whose agents directory cannot even be STATTED, because
        // an ancestor of it is closed. This is the shape `is_dir()` alone reads
        // as "no agents directory here".
        std::fs::create_dir_all(dir.path().join("marketplaces/b__plugin/plugin/agents"))
            .expect("tree");
        let bad = dir.path().join("marketplaces/b__plugin/plugin");
        let mut perms = std::fs::metadata(&bad).expect("meta").permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o000);
        }
        std::fs::set_permissions(&bad, perms).expect("chmod");

        let found = shipped_roles(dir.path());
        // Restore before asserting, so a failure does not leave an unreadable tree.
        let mut perms = std::fs::metadata(&bad).expect("meta").permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            perms.set_mode(0o755);
        }
        let _ = std::fs::set_permissions(&bad, perms);

        assert_eq!(
            found, None,
            "a half-read inventory looks complete at every reader, and every role in the half \
             that was not read is then classified as not ours — silently"
        );
    }

    /// Criterion 10, the empty half: a directory that reads and holds nothing is not knowledge.
    #[test]
    fn a_marketplace_tree_with_no_agents_reads_as_unknown_rather_than_as_none() {
        let dir = Scratch::new("gatedecide-1");
        a_copy(
            &dir.path().join("marketplaces/some__plugin"),
            Some("forge"),
            &[],
        );
        assert_eq!(shipped_roles(dir.path()), None);
    }

    /// Criterion 10. The names come off the disk the daemon itself syncs.
    #[test]
    fn the_roles_are_read_from_the_plugin_copy_on_this_box() {
        let dir = Scratch::new("gatedecide-2");
        let copy = dir.path().join("marketplaces/sidcorp-co__forge-plugin");
        a_copy(
            &copy,
            Some("forge"),
            &["runner", "reviewer", "a-role-nobody-has-written-yet"],
        );
        std::fs::write(copy.join("plugin/agents/README.txt"), "not an agent").expect("readme");
        let found = shipped_roles(dir.path()).expect("roles");
        assert!(
            found.contains("forge:a-role-nobody-has-written-yet"),
            "{found:?}"
        );
        assert!(!found.iter().any(|r| r.contains("README")), "{found:?}");

        // and a role nobody has written yet is gated the moment the plugin ships it,
        // with no change to this binary.
        assert_eq!(
            decide(
                &dispatch("forge:a-role-nobody-has-written-yet", "toolu_1"),
                &facts(Some(&found), None, None)
            ),
            Verdict::Undeclared
        );
    }

    /// ISS-1378 criterion 6. Claude Code sends a plugin's role under the
    /// plugin's own name, and the bare file stem is what no dispatch carries.
    #[test]
    fn a_role_is_named_as_claude_code_sends_it_and_never_by_its_file_stem() {
        let dir = Scratch::new("gatedecide-ns");
        a_copy(
            &dir.path().join("marketplaces/sidcorp-co__forge-plugin"),
            Some("forge"),
            &["runner"],
        );
        let found = shipped_roles(dir.path()).expect("roles");
        assert_eq!(
            found.iter().map(String::as_str).collect::<Vec<_>>(),
            vec!["forge:runner"]
        );
        assert_eq!(
            decide(
                &dispatch("forge:runner", "toolu_1"),
                &facts(Some(&found), None, None)
            ),
            Verdict::Undeclared,
            "the dispatch Claude Code really makes, with nothing declared, is refused"
        );
        assert_eq!(
            decide(
                &dispatch("forge:runner", "toolu_1"),
                &facts(Some(&found), Some("run-7"), None)
            ),
            Verdict::Covered {
                run_id: "run-7".into()
            },
            "and one a declaration covers is promised"
        );
    }

    /// ISS-1378 criterion 7.
    #[test]
    fn a_copy_whose_manifest_names_no_plugin_leaves_the_inventory_unknown() {
        let dir = Scratch::new("gatedecide-noname");
        a_copy(
            &dir.path().join("marketplaces/a__plugin"),
            Some("forge"),
            &["runner"],
        );
        a_copy(
            &dir.path().join("marketplaces/b__plugin"),
            None,
            &["reviewer"],
        );
        assert_eq!(
            shipped_roles(dir.path()),
            None,
            "roles that cannot be named as Claude Code names them leave the inventory as \
             incomplete as a directory that could not be read, and a partial inventory reads \
             every role in the missing half as not ours"
        );
    }

    /// ISS-1378 criteria 1, 3, 4: the start decision.
    #[test]
    fn only_a_shipped_role_and_the_promised_one_claims_a_declared_run() {
        let r = roles();
        assert_eq!(claims_the_run(Some("forge:runner"), Some(&r), None), Ok(()));
        assert_eq!(
            claims_the_run(Some("forge:runner"), Some(&r), Some("forge:runner")),
            Ok(())
        );
        for helper in ["general-purpose", "Explore", "runner"] {
            let why = claims_the_run(Some(helper), Some(&r), None).expect_err(helper);
            assert!(why.contains("no role this box ships"), "{helper}: {why}");
        }
        let why = claims_the_run(Some("forge:reviewer"), Some(&r), Some("forge:runner"))
            .expect_err("another shipped role");
        assert!(
            why.contains("promised to a `forge:runner` dispatch"),
            "{why}"
        );
        let why = claims_the_run(None, Some(&r), None).expect_err("no type");
        assert!(why.contains("cannot be told"), "{why}");
        let why = claims_the_run(Some("forge:runner"), None, None).expect_err("no roles");
        assert!(why.contains("cannot be told"), "{why}");
    }
}
