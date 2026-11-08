//! What a channel agent's pane is started from (ISS-946): the confined command, the Claude Code
//! flags an interactive session takes in place of the headless stream, and the settings that
//! carry its turn ends to the box.
//!
//! The confined command is the one the headless chat host runs (`claude_code::SessionCommand`),
//! so bwrap, the egress bridge and the environment built from a list are the same. tmux, not this
//! daemon, is the pane's parent, so the environment cannot be set on a child: it is written with
//! the command to a launch file only this user reads, and `forge-runner chat-pane-exec` reads it,
//! removes it, takes the sandbox's ceilings and execs.
//!
//! Permissions: the headless session runs `bypassPermissions` inside the sandbox. A pane does not:
//! it runs `dontAsk`, which denies any tool not on its allow list instead of prompting, since
//! nobody answers a prompt in a pane a stranger's message drives. The allow list is every tool the
//! headless session reaches — the built-in ones and each MCP server it was handed — so the pane
//! can do what the headless session did and no more, and a tool outside it is refused, never asked.

use std::path::{Path, PathBuf};

pub use runner_core::chat_pane_launch::{read_and_remove, write, Launch};

/// How the pane's Claude Code session is named: a new one under an id the box chose, so the
/// box knows its transcript before the first line, or one resumed by the id core keeps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionStart {
    New(String),
    Resume(String),
}

impl SessionStart {
    pub fn id(&self) -> &str {
        match self {
            Self::New(id) | Self::Resume(id) => id,
        }
    }
}

/// The built-in tools a headless chat session reaches under `bypassPermissions`, which a pane's
/// `dontAsk` allows by name.
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

/// The `--settings` a pane takes: its allow list, and the `Stop`, `UserPromptSubmit` and
/// status-line commands that append to `events` through `runner_exe`.
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
        "permissions": { "allow": allow, "defaultMode": "dontAsk" },
        "hooks": { "Stop": hook("Stop"), "UserPromptSubmit": hook("UserPromptSubmit") },
        "statusLine": {
            "type": "command",
            "command": command(runner_core::chat_pane_events::STATUS_LINE),
        },
    })
}

/// The MCP servers the config at `path` names, which the pane's allow list admits.
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

/// What the pane's Claude Code is started with: interactive, `dontAsk` with `settings`, the
/// session's MCP config alone, and the first turn as its launch prompt — a turn typed by paste
/// reaches the model as pasted content, a launch prompt as the session's own first user turn.
pub struct PaneArgs<'a> {
    pub settings: &'a serde_json::Value,
    pub system_prompt: Option<&'a str>,
    pub model: Option<&'a str>,
    pub mcp_config: &'a Path,
    pub session: &'a SessionStart,
    pub first_turn: &'a str,
}

impl PaneArgs<'_> {
    pub fn argv(&self) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "--permission-mode".into(),
            "dontAsk".into(),
            "--settings".into(),
            self.settings.to_string(),
        ];
        if let Some(sp) = self.system_prompt.filter(|s| !s.is_empty()) {
            args.push("--append-system-prompt".into());
            args.push(sp.into());
        }
        if let Some(model) = self.model.filter(|s| !s.is_empty()) {
            args.push("--model".into());
            args.push(model.into());
        }
        args.push("--mcp-config".into());
        args.push(self.mcp_config.to_string_lossy().into_owned());
        args.push("--strict-mcp-config".into());
        match self.session {
            SessionStart::New(id) => {
                args.push("--session-id".into());
                args.push(id.clone());
            }
            SessionStart::Resume(id) => {
                args.push("--resume".into());
                args.push(id.clone());
            }
        }
        args.push("--".into());
        args.push(self.first_turn.into());
        args
    }
}

/// Where a pane's hook events are appended: under Claude Code's own config directory, which the
/// chat sandbox already binds writable (`claude_code::confine::chat_sandbox`), so no new path is
/// opened into it.
pub fn events_dir(claude_dir: &Path, pane: &str) -> PathBuf {
    claude_dir.join("forge-chat-panes").join(pane)
}

/// Claude Code's config directory as the chat sandbox names it.
pub fn claude_dir() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pane_runs_dont_ask_never_bypass_and_its_hooks_append_to_the_events_file() {
        let s = settings(
            Path::new("/opt/forge-runner"),
            Path::new("/h/.claude/forge-chat-panes/forge-chat-p/events.jsonl"),
            &["forge".into()],
        );
        let args = PaneArgs {
            settings: &s,
            system_prompt: Some("be kind"),
            model: Some("sonnet"),
            mcp_config: Path::new("/m/mcp.json"),
            session: &SessionStart::New("abc".into()),
            first_turn: "hello",
        }
        .argv();
        assert!(
            !args.iter().any(|a| a.contains("bypassPermissions")),
            "{args:?}"
        );
        assert_eq!(args[..2], ["--permission-mode", "dontAsk"]);
        assert_eq!(args[args.len() - 2..], ["--", "hello"]);
        assert!(
            args.windows(2).any(|w| w == ["--session-id", "abc"]),
            "{args:?}"
        );
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(
            s["hooks"]["Stop"][0]["hooks"][0]["command"],
            "'/opt/forge-runner' hook --event Stop --chat-pane-events \
             '/h/.claude/forge-chat-panes/forge-chat-p/events.jsonl'"
        );
        assert!(s["statusLine"]["command"]
            .as_str()
            .unwrap()
            .contains("--event StatusLine"));
        let allow = s["permissions"]["allow"].as_array().unwrap();
        assert!(allow.contains(&"mcp__forge".into()) && allow.contains(&"Bash".into()));
    }

    #[test]
    fn a_resumed_pane_resumes_by_the_id_core_keeps() {
        let s = serde_json::json!({});
        let args = PaneArgs {
            settings: &s,
            system_prompt: None,
            model: None,
            mcp_config: Path::new("/m.json"),
            session: &SessionStart::Resume("r1".into()),
            first_turn: "next",
        }
        .argv();
        assert!(args.windows(2).any(|w| w == ["--resume", "r1"]), "{args:?}");
        assert!(!args.iter().any(|a| a == "--session-id"));
    }
}
