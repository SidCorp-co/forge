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

pub fn shipped_roles(config_dir: &Path) -> Option<BTreeSet<String>> {
    let mut out = BTreeSet::new();
    for clone in std::fs::read_dir(config_dir.join("marketplaces")).ok()? {
        // A directory entry this box could not read leaves the inventory
        // incomplete, and an incomplete inventory is indistinguishable from a
        // complete one at every reader.
        let clone = clone.ok()?;
        let agents = clone.path().join("plugin").join("agents");
        match agents_reach(
            std::fs::metadata(&agents)
                .map(|m| m.is_dir())
                .map_err(|e| e.kind()),
        ) {
            Agents::Absent => continue,
            Agents::Unreadable => return None,
            Agents::Readable => {}
        }
        for agent in std::fs::read_dir(agents).ok()? {
            let path = agent.ok()?.path();
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                out.insert(stem.to_string());
            }
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}
