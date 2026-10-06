//! The box's answer to a permission dialog in a pane it placed.
//!
//! Nobody watches a pane the daemon placed. A permission dialog there holds the
//! pane, and every run working inside it, until a person happens by: forge-
//! master-hop stood ~46 minutes on 2026-10-05 and ~24 on 2026-10-07 at Claude
//! Code's "this shell -c script runs rm and could not be checked", raised by a
//! subagent under bypass permissions. So the pane's `PermissionRequest` hook
//! answers it, always with a deny that tells the agent how to rephrase. It
//! never allows: what the dialog guards is the person's to grant, and the box
//! is not that person.
//!
//! Each answer is a line beside `config.toml`, and the heartbeat carries the
//! count per project to core, so `masters/standing` says how often the box
//! answered and what it answered last.

use std::path::{Path, PathBuf};

use runner_proto::dialogs::{Answered, WIRE_PROJECTS};

use crate::degraded::{append_bounded, clip, MAX_LINES};

/// What the agent is told in place of the dialog.
pub const REPHRASE: &str = "The Forge runner answered this permission dialog for you: denied. \
Nobody watches this pane, so a dialog would hold it, and every run working in it, until a person \
came by. Do not repeat the same call. Rephrase it so it needs no permission: run plain commands \
one at a time with literal absolute paths; no `bash -c` or `sh -c` wrapper, no multi-line script, \
no loop around `rm`; to empty or replace a file, write it with `>` instead of deleting it; never \
delete anything outside your worktree or scratchpad. If the step cannot be done without a person, \
stop it and say so in your report.";

/// The longest a command is quoted in a reason, in characters.
const WHAT_CHARS: usize = 160;

/// What a `PermissionRequest` payload asked for, as far as it can be read.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Asked {
    pub tool: Option<String>,
    /// The command, path or URL the call names, on one line and clipped.
    pub what: Option<String>,
    /// The subagent that asked; `None` where the pane's lead asked.
    pub agent: Option<String>,
    pub agent_type: Option<String>,
}

/// Read a `PermissionRequest` payload. One that cannot be read is still a
/// dialog standing in the pane, so it is answered all the same, naming nothing.
pub fn asked_in(payload: &[u8]) -> Asked {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Asked::default();
    };
    let text = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let input = v.get("tool_input");
    let what = ["command", "file_path", "notebook_path", "url", "path"]
        .iter()
        .find_map(|k| {
            input
                .and_then(|i| i.get(*k))
                .and_then(serde_json::Value::as_str)
        })
        .map(one_line);
    Asked {
        tool: text("tool_name"),
        what,
        agent: text("agent_id"),
        agent_type: text("agent_type"),
    }
}

fn one_line(s: &str) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= WHAT_CHARS {
        return flat;
    }
    let kept: String = flat.chars().take(WHAT_CHARS).collect();
    format!("{kept}…")
}

/// The answer as a person reads it: `denied Bash: rm -rf nodes/*`.
pub fn reason(a: &Asked) -> String {
    let tool = a.tool.as_deref().unwrap_or("a tool call");
    match a.what.as_deref() {
        Some(what) => clip(&format!("denied {tool}: {what}")),
        None => clip(&format!("denied {tool}")),
    }
}

/// The hook's stdout: Claude Code's `PermissionRequest` decision, a deny that
/// lets the agent carry on (`interrupt: false`) with [`REPHRASE`] as its reason.
pub fn deny_output() -> String {
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": {
                "behavior": "deny",
                "message": REPHRASE,
                "interrupt": false,
            }
        }
    })
    .to_string()
}

/// `<config dir>/dialog-answers.jsonl`.
pub fn answers_path(config_dir: &Path) -> PathBuf {
    config_dir.join("dialog-answers.jsonl")
}

/// Record one answer. `project` is the pane's own `$FORGE_PROJECT_ID`.
pub fn record(config_dir: &Path, at: i64, project: Option<&str>, a: &Asked) {
    let mut line = serde_json::json!({ "at": at, "reason": reason(a) });
    for (key, value) in [
        ("project", project),
        ("tool", a.tool.as_deref()),
        ("agent", a.agent.as_deref()),
        ("agentType", a.agent_type.as_deref()),
    ] {
        if let Some(v) = value {
            line[key] = serde_json::Value::String(v.to_string());
        }
    }
    append_bounded(&answers_path(config_dir), &line.to_string());
}

/// What the record holds, per project, newest-answered first, at most
/// [`WIRE_PROJECTS`] of them.
pub fn report(config_dir: &Path) -> Vec<Answered> {
    let Ok(body) = std::fs::read_to_string(answers_path(config_dir)) else {
        return Vec::new();
    };
    let floor = body.lines().count() >= MAX_LINES / 2;
    let mut by_project: Vec<Answered> = Vec::new();
    for line in body.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let text = |k: &str| {
            v.get(k)
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        };
        let project = text("project");
        let at = v.get("at").and_then(serde_json::Value::as_i64);
        let i = match by_project.iter().position(|p| p.project_id == project) {
            Some(i) => i,
            None => {
                by_project.push(Answered {
                    project_id: project,
                    count: 0,
                    count_is_floor: floor,
                    first_at: at,
                    last_at: None,
                    last: None,
                    last_agent: None,
                });
                by_project.len() - 1
            }
        };
        let p = &mut by_project[i];
        p.count += 1;
        p.last_at = at;
        p.last = text("reason").map(|r| clip(&r));
        p.last_agent = text("agent").map(|r| clip(&r));
    }
    by_project.sort_by_key(|p| std::cmp::Reverse(p.last_at));
    by_project.truncate(WIRE_PROJECTS);
    by_project
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `PermissionRequest` input exactly as Claude Code's hooks reference
    /// prints it (code.claude.com/docs/en/hooks, "PermissionRequest input"),
    /// with the `agent_id`/`agent_type` a subagent's call carries.
    const DOC_PAYLOAD: &str = r#"{
      "session_id": "abc123",
      "transcript_path": "/Users/x/.claude/projects/p/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl",
      "cwd": "/Users/x",
      "permission_mode": "bypassPermissions",
      "hook_event_name": "PermissionRequest",
      "tool_name": "Bash",
      "tool_input": {
        "command": "bash -c '\n  for n in 1 2; do\n    rm -f $S/out-$n.json\n  done'",
        "description": "Fetch the API pages"
      },
      "permission_suggestions": [
        { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "rm -rf node_modules" }],
          "behavior": "allow", "destination": "localSettings" }
      ],
      "agent_id": "a1b2c3",
      "agent_type": "forge:runner"
    }"#;

    #[test]
    fn a_permission_request_is_answered_with_a_deny_that_says_how_to_rephrase() {
        let out: serde_json::Value = serde_json::from_str(&deny_output()).unwrap();
        let decision = &out["hookSpecificOutput"]["decision"];
        assert_eq!(
            out["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(decision["behavior"], "deny", "the box never allows");
        assert_eq!(
            decision["interrupt"], false,
            "the agent carries on and rephrases"
        );
        let message = decision["message"].as_str().unwrap();
        for must in ["bash -c", "absolute paths", "`>`", "worktree or scratchpad"] {
            assert!(
                message.contains(must),
                "the rephrase names {must}: {message}"
            );
        }
        assert!(out["hookSpecificOutput"]["decision"]
            .get("updatedInput")
            .is_none());
    }

    #[test]
    fn what_a_subagent_asked_is_read_off_the_documented_payload() {
        let a = asked_in(DOC_PAYLOAD.as_bytes());
        assert_eq!(a.tool.as_deref(), Some("Bash"));
        assert_eq!(a.agent.as_deref(), Some("a1b2c3"));
        assert_eq!(a.agent_type.as_deref(), Some("forge:runner"));
        assert_eq!(
            reason(&a),
            "denied Bash: bash -c ' for n in 1 2; do rm -f $S/out-$n.json done'"
        );
    }

    #[test]
    fn an_unreadable_payload_is_still_answered_and_names_nothing() {
        let a = asked_in(b"not json");
        assert_eq!(a, Asked::default());
        assert_eq!(reason(&a), "denied a tool call");
        let long = asked_in(
            serde_json::json!({ "tool_name": "Bash", "tool_input": { "command": "x".repeat(500) } })
                .to_string()
                .as_bytes(),
        );
        assert_eq!(long.what.unwrap().chars().count(), WHAT_CHARS + 1);
    }

    #[test]
    fn answers_are_counted_per_project_newest_first() {
        let dir = std::env::temp_dir().join(format!(
            "forge-dialog-answers-{}-{}",
            std::process::id(),
            crate::agent_activity::now_ms()
        ));
        assert!(report(&dir).is_empty(), "no record is no answers");
        let asked = asked_in(DOC_PAYLOAD.as_bytes());
        record(&dir, 1_000, Some("p1"), &asked);
        record(&dir, 2_000, Some("p2"), &Asked::default());
        record(&dir, 3_000, Some("p1"), &asked);
        let got = report(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].project_id.as_deref(), Some("p1"));
        assert_eq!(
            (got[0].count, got[0].first_at, got[0].last_at),
            (2, Some(1_000), Some(3_000))
        );
        assert_eq!(got[0].last_agent.as_deref(), Some("a1b2c3"));
        assert!(got[0]
            .last
            .as_deref()
            .unwrap()
            .starts_with("denied Bash: bash -c"));
        assert_eq!(got[1].last.as_deref(), Some("denied a tool call"));
        assert!(!got[0].count_is_floor);
    }
}
