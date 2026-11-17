//! What a channel agent's background session is started with (ISS-946, ISS-1268 BR): the
//! settings that carry its turn ends to the box, and the tools it may use.
//!
//! Permissions: the headless session runs `bypassPermissions` inside the sandbox. A room agent's
//! background session does not: it runs `dontAsk`, which denies any tool not on its allow list
//! instead of prompting, since nobody answers a prompt a stranger's message drives (measured in a
//! room on 2.1.322: `WebSearch`, off the list, was denied with no dialog, `br/a2b.listpeers.log`).
//! The allow list is every tool the headless session reaches — the built-in ones and each MCP
//! server it was handed — so the session can do what the headless session did and no more.

use std::path::Path;

/// How the session's conversation starts: a new one, whose id the room's roster names once it is
/// started, or one resumed by the id core keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New,
    Resume(String),
}

/// The built-in tools a headless chat session reaches under `bypassPermissions`, which a room
/// agent's `dontAsk` allows by name.
pub const BUILT_IN_TOOLS: &[&str] = &[
    "Bash",
    "Read",
    "Edit",
    "Write",
    "MultiEdit",
    "Glob",
    "Grep",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "TodoWrite",
    "Task",
    "Agent",
    "Skill",
];

/// The permission mode a room agent's session runs in.
pub const PERMISSION_MODE: &str = "dontAsk";

/// The settings a room agent's session reads: its allow list; the `Stop`, `UserPromptSubmit` and
/// status-line commands that append to `events` through `runner_exe`; no worktree of its own.
pub fn settings(runner_exe: &Path, events: &Path, mcp_servers: &[String]) -> serde_json::Value {
    let quote = |p: &Path| runner_workspace::terminal::shell_quote(&p.to_string_lossy());
    let command = |event: &str| {
        format!(
            "{} hook --event {event} --chat-pane-events {}",
            quote(runner_exe),
            quote(events)
        )
    };
    let hook = |event: &str| serde_json::json!([{ "hooks": [{ "type": "command", "command": command(event) }] }]);
    let mut allow: Vec<String> = BUILT_IN_TOOLS.iter().map(|t| (*t).to_string()).collect();
    allow.extend(mcp_servers.iter().map(|s| format!("mcp__{s}")));
    serde_json::json!({
        "permissions": { "allow": allow, "defaultMode": PERMISSION_MODE },
        "worktree": { "bgIsolation": "none" },
        // the install is the runner's to move (ISS-1268 C1)
        "env": { "DISABLE_AUTOUPDATER": "1" },
        "hooks": { "Stop": hook("Stop"), "UserPromptSubmit": hook("UserPromptSubmit") },
        "statusLine": {
            "type": "command",
            "command": command(runner_core::chat_pane_events::STATUS_LINE),
        },
    })
}

/// The MCP servers the config at `path` names, which the session's allow list admits.
pub fn mcp_servers_in(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read(path) else {
        return Vec::new();
    };
    serde_json::from_slice::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("mcpServers").and_then(|m| m.as_object()).cloned())
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_room_agent_runs_dont_ask_and_its_hooks_append_to_the_events_file() {
        let s = settings(
            Path::new("/opt/forge-runner"),
            Path::new("/r/claude/forge-chat-events/forge-chat-p.jsonl"),
            &["forge".into()],
        );
        assert_eq!(s["permissions"]["defaultMode"], "dontAsk");
        assert!(!s.to_string().contains("bypassPermissions"), "{s}");
        assert_eq!(
            s["hooks"]["Stop"][0]["hooks"][0]["command"],
            "'/opt/forge-runner' hook --event Stop --chat-pane-events \
             '/r/claude/forge-chat-events/forge-chat-p.jsonl'"
        );
        assert!(s["statusLine"]["command"]
            .as_str()
            .unwrap()
            .contains("--event StatusLine"));
        let allow = s["permissions"]["allow"].as_array().unwrap();
        assert!(allow.contains(&"mcp__forge".into()) && allow.contains(&"Bash".into()));
        assert_eq!(s["env"]["DISABLE_AUTOUPDATER"], "1");
    }
}
