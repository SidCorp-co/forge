//! A resident session's permission prompt, relayed to Forge for a person to allow or deny
//! (ISS-1268 B3, owner 2026-11-17: "never silent").
//!
//! Masters and room agents run as `claude --bg` sessions under bypass. A prompt that still appears
//! (Claude Code's dangerous-rm check, measured on 2.1.322) reaches the session's `PermissionRequest`
//! hook, which this box installs in the session's own settings. The hook asks Forge a question a
//! person answers in Approvals, waits for the answer for [`RELAY_WAIT`], and prints Claude Code's
//! decision. Past the wait it denies the call itself, by name, and ends the question so Forge tells
//! the project's admins: a hook that outlived its own `timeout` would leave the dialog standing with
//! nobody told (measured), so [`HOOK_TIMEOUT_SECS`] stands well past the wait.
//!
//! This module is what can be said without a network: the hook block a session's settings take, the
//! question asked, the decision printed. `forge-runner hook --relay` runs it.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::dialog_answer::Asked;

/// How long the relay waits for a person's answer before it denies the call itself.
pub const RELAY_WAIT: Duration = Duration::from_secs(300);

/// The hook's own `timeout` in the session's settings, in seconds: past it Claude Code stops waiting
/// on the hook and shows the dialog to nobody, so it stands a minute past [`RELAY_WAIT`] (measured
/// rule: at least the relay wait plus 30 s).
pub const HOOK_TIMEOUT_SECS: u64 = RELAY_WAIT.as_secs() + 60;

/// How often the relay reads the answer back.
pub const POLL: Duration = Duration::from_secs(2);

/// Set in a relayed session's environment: the project-wide `PermissionRequest` hook a checkout's
/// `settings.local.json` carries then answers nothing, so the relay's is the one decision.
pub const RELAY_ENV: (&str, &str) = ("FORGE_PERMISSION_RELAY", "1");

/// The option a person allows the call with, and the one they deny it with.
pub const ALLOW: &str = "allow";
pub const DENY: &str = "deny";

/// The longest a prompt's input is shown to the person deciding, in characters.
const INPUT_CHARS: usize = 1500;

/// One prompt as the hook received it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Prompt {
    /// Claude Code's conversation id.
    pub session_id: Option<String>,
    /// Claude Code's own id for this prompt.
    pub prompt_id: Option<String>,
    pub asked: Asked,
    /// The tool's whole input, pretty-printed and clipped, for the person deciding.
    pub input: String,
}

/// Read a `PermissionRequest` payload: `session_id, prompt_id, tool_name, tool_input, ...`
/// (measured on 2.1.322; it carries no reason text and no `tool_use_id`).
pub fn prompt_in(payload: &[u8]) -> Prompt {
    let asked = crate::dialog_answer::asked_in(payload);
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(payload) else {
        return Prompt {
            asked,
            ..Prompt::default()
        };
    };
    let text = |k: &str| {
        v.get(k)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let input = v
        .get("tool_input")
        .map(|i| serde_json::to_string_pretty(i).unwrap_or_default())
        .unwrap_or_default();
    Prompt {
        session_id: text("session_id"),
        prompt_id: text("prompt_id"),
        asked,
        input: clip_chars(&input, INPUT_CHARS),
    }
}

fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    format!("{}…", s.chars().take(max).collect::<String>())
}

/// What the person reads: the session, and what it asks to run.
pub fn question_text(session: &str, p: &Prompt) -> String {
    let tool = p.asked.tool.as_deref().unwrap_or("a tool call");
    let by = p
        .asked
        .agent_type
        .as_deref()
        .map(|t| format!(" (its subagent {t})"))
        .unwrap_or_default();
    match p.asked.what.as_deref() {
        Some(what) => format!(
            "{session}{by} stopped on a Claude Code permission prompt: {tool} `{what}`. Allow it, \
             or deny it (a note goes to the session as the reason)."
        ),
        None => format!(
            "{session}{by} stopped on a Claude Code permission prompt for {tool}. Allow it, or deny \
             it (a note goes to the session as the reason)."
        ),
    }
}

/// The two options, in core's option shape: allowing is a project admin's, denying any writer's.
/// Each binds to this one call, named by its fingerprint ([`fingerprint`]).
pub fn options(p: &Prompt) -> serde_json::Value {
    let fp = fingerprint(p);
    serde_json::json!([
        { "id": ALLOW, "label": "Allow", "authority": "admin", "bindsTo": "this_call", "executedBy": "agent", "fingerprint": fp },
        { "id": DENY, "label": "Deny", "authority": "writer", "bindsTo": "this_call", "executedBy": "agent", "fingerprint": fp },
    ])
}

/// The one call an answer binds to: the session, Claude Code's prompt id, the tool and what it
/// names. The prompt id alone is the turn's, shared by every prompt in it (measured on 2.1.322:
/// two dangerous-rm prompts of one turn carried one `prompt_id`), so an allow names this call,
/// never the next one.
pub fn fingerprint(p: &Prompt) -> String {
    format!(
        "permission-prompt:{}:{}:{}:{}",
        p.session_id.as_deref().unwrap_or("-"),
        p.prompt_id.as_deref().unwrap_or("-"),
        p.asked.tool.as_deref().unwrap_or("-"),
        p.asked.what.as_deref().unwrap_or("-")
    )
}

/// Where a relay waiting on a person marks its session, under the box's config dir: the
/// roster reads `waiting` / `permission prompt` the whole time the hook waits (measured on
/// 2.1.322), and the watcher must leave a prompt the relay holds to the relay.
pub fn inflight_path(config_dir: &Path, session_id: &str) -> PathBuf {
    let safe: String = session_id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    config_dir
        .join("relay-inflight")
        .join(format!("{safe}.json"))
}

/// Mark `session_id`'s prompt as held by a relay until [`clear_inflight`].
pub fn mark_inflight(config_dir: &Path, session_id: &str, question: &str) {
    let path = inflight_path(config_dir, session_id);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(
        &path,
        serde_json::json!({ "question": question, "pid": std::process::id() }).to_string(),
    );
}

pub fn clear_inflight(config_dir: &Path, session_id: &str) {
    let _ = std::fs::remove_file(inflight_path(config_dir, session_id));
}

/// Whether a relay holds `session_id`'s prompt now: marked, and marked within the hook's own
/// timeout, past which Claude Code has stopped waiting on it whatever the mark says.
pub fn inflight(config_dir: &Path, session_id: &str) -> bool {
    std::fs::metadata(inflight_path(config_dir, session_id))
        .and_then(|m| m.modified())
        .ok()
        .and_then(|at| at.elapsed().ok())
        .is_some_and(|age| age.as_secs() < HOOK_TIMEOUT_SECS)
}

/// What core's `permissionPrompt` field carries.
pub fn origin(session: &str, p: &Prompt) -> serde_json::Value {
    serde_json::json!({
        "session": session,
        "tool": p.asked.tool.as_deref().unwrap_or("unknown tool"),
        "promptId": p.prompt_id,
    })
}

/// The run identity the box registers as the question's waiter: one per prompt.
pub fn waiter(p: &Prompt, question_id: &str) -> String {
    format!(
        "permission-relay:{}:{question_id}",
        p.session_id.as_deref().unwrap_or("unknown-session")
    )
}

/// What the relay decided, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// A person allowed it.
    Allowed { by: Option<String> },
    /// A person denied it, with what they said.
    Denied {
        by: Option<String>,
        note: Option<String>,
    },
    /// Nobody answered within the wait: the box denied it.
    TimedOut { waited: Duration },
    /// The prompt could not be asked at all, so nobody could answer it: the box denied it.
    Unasked { why: String },
}

impl Decision {
    /// From a person's answer: the option they chose and what they said with it. An option that is
    /// neither is read as no answer and refused, never as an allow.
    pub fn of_answer(
        option: Option<&str>,
        by: Option<String>,
        note: Option<String>,
    ) -> Option<Self> {
        match option {
            Some(ALLOW) => Some(Decision::Allowed { by }),
            Some(DENY) => Some(Decision::Denied { by, note }),
            _ => None,
        }
    }

    pub fn allows(&self) -> bool {
        matches!(self, Decision::Allowed { .. })
    }

    /// The reason the session's model is told on a deny.
    pub fn message(&self) -> Option<String> {
        match self {
            Decision::Allowed { .. } => None,
            Decision::Denied { note, .. } => Some(match note.as_deref().map(str::trim) {
                Some(n) if !n.is_empty() => format!("Denied from Forge by a person: {n}"),
                _ => "Denied from Forge by a person. Do not repeat the same call; find another way or report it.".into(),
            }),
            Decision::TimedOut { waited } => Some(format!(
                "[PERMISSION_RELAY_TIMEOUT] This permission prompt was relayed to Forge and nobody \
                 allowed or denied it within {} s, so the Forge runner denied it. The project's admins \
                 were told. Do not repeat the same call; carry on without it, or ask for it on Forge.",
                waited.as_secs()
            )),
            Decision::Unasked { why } => Some(format!(
                "[PERMISSION_RELAY_UNASKED] This permission prompt could not be relayed to Forge \
                 ({why}), so nobody could allow it and the Forge runner denied it. Do not repeat the \
                 same call; carry on without it, or ask for it on Forge."
            )),
        }
    }

    /// One line for the box's record: `allowed Bash: rm -rf x`, `denied at timeout Bash: ...`.
    pub fn record_line(&self, asked: &Asked) -> String {
        let verb = match self {
            Decision::Allowed { .. } => "allowed from Forge",
            Decision::Denied { .. } => "denied from Forge",
            Decision::TimedOut { .. } => "denied at the relay timeout",
            Decision::Unasked { .. } => "denied, not relayed",
        };
        let tool = asked.tool.as_deref().unwrap_or("a tool call");
        crate::degraded::clip(&match asked.what.as_deref() {
            Some(what) => format!("{verb} {tool}: {what}"),
            None => format!("{verb} {tool}"),
        })
    }
}

/// Claude Code's `PermissionRequest` decision, as the hook prints it: `allow`, or `deny` with the
/// reason the model reads and the turn carried on (`interrupt: false`).
pub fn output(d: &Decision) -> String {
    let decision = match d.message() {
        None => serde_json::json!({ "behavior": "allow" }),
        Some(message) => serde_json::json!({
            "behavior": "deny",
            "message": message,
            "interrupt": false,
        }),
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        }
    })
    .to_string()
}

/// The canary's relay (ISS-1268 C1 checks 4 and 5): the same hook, answered from files in this
/// directory instead of Forge, so a candidate Claude Code is judged on the hook contract alone.
/// `req-<id>.json` is what was asked, `dec-<id>.json` (`{"option", "note"}`) the canary's answer,
/// `expired-<id>.json` the relay ending it at its timeout.
pub const CANARY_DIR_ENV: &str = "FORGE_RELAY_CANARY_DIR";
/// The canary's own relay wait, in seconds; read only together with [`CANARY_DIR_ENV`].
pub const CANARY_WAIT_ENV: &str = "FORGE_RELAY_CANARY_WAIT_SECS";

fn quote(s: &str, posix: bool) -> String {
    if posix {
        format!("'{}'", s.replace('\'', r"'\''"))
    } else {
        format!("\"{s}\"")
    }
}

/// The `hooks` block a resident session's settings take: every `PermissionRequest` goes to
/// `forge-runner hook --relay`, which reaches this box's own config through `config_dir`.
pub fn hooks_block(exe: &str, config_dir: Option<&str>, posix: bool) -> serde_json::Value {
    let env = match config_dir {
        Some(dir) if posix => format!(
            "{}={} ",
            runner_platform::config::CONFIG_DIR_ENV,
            quote(dir, posix)
        ),
        _ => String::new(),
    };
    block(format!(
        "{env}{} hook --event PermissionRequest --relay",
        quote(exe, posix)
    ))
}

/// The canary's hook block: the relay answered from `dir`, waiting `wait` (posix only: the canary
/// runs where the box's sessions do).
pub fn canary_hooks_block(exe: &str, dir: &str, wait: Duration) -> serde_json::Value {
    block(format!(
        "{CANARY_DIR_ENV}={} {CANARY_WAIT_ENV}={} {} hook --event PermissionRequest --relay",
        quote(dir, true),
        wait.as_secs(),
        quote(exe, true)
    ))
}

fn block(command: String) -> serde_json::Value {
    serde_json::json!({
        "PermissionRequest": [{
            "matcher": "*",
            "hooks": [{
                "type": "command",
                "command": command,
                "timeout": HOOK_TIMEOUT_SECS,
            }]
        }]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dangerous-rm prompt as 2.1.322 handed it to the hook (ISS-1268 probe3 hooklog).
    const RM: &[u8] = br#"{"session_id":"s-1","transcript_path":"/t.jsonl","cwd":"/w","prompt_id":"p-9",
        "permission_mode":"bypassPermissions","hook_event_name":"PermissionRequest","tool_name":"Bash",
        "tool_input":{"command":"rm -rf $D/nodes","description":"clean"},"permission_suggestions":[]}"#;

    #[test]
    fn a_prompt_is_read_with_its_session_prompt_and_input() {
        let p = prompt_in(RM);
        assert_eq!(p.session_id.as_deref(), Some("s-1"));
        assert_eq!(p.prompt_id.as_deref(), Some("p-9"));
        assert_eq!(p.asked.tool.as_deref(), Some("Bash"));
        assert!(p.input.contains("rm -rf $D/nodes"), "{}", p.input);
        let q = question_text("forge-master-x", &p);
        assert!(
            q.starts_with("forge-master-x") && q.contains("`rm -rf $D/nodes`"),
            "{q}"
        );
        assert_eq!(
            options(&p)[0]["fingerprint"],
            "permission-prompt:s-1:p-9:Bash:rm -rf $D/nodes"
        );
        let o = origin("forge-master-x", &p);
        assert_eq!(o["session"], "forge-master-x");
        assert_eq!(o["tool"], "Bash");
        assert_eq!(o["promptId"], "p-9");
    }

    #[test]
    fn an_allow_and_a_deny_print_claude_code_s_decision_shape() {
        let allow = Decision::of_answer(Some(ALLOW), Some("u".into()), None).unwrap();
        let v: serde_json::Value = serde_json::from_str(&output(&allow)).unwrap();
        assert_eq!(
            v["hookSpecificOutput"]["hookEventName"],
            "PermissionRequest"
        );
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "allow");
        assert!(v["hookSpecificOutput"]["decision"].get("message").is_none());

        let deny = Decision::of_answer(Some(DENY), None, Some("use trash instead".into())).unwrap();
        let v: serde_json::Value = serde_json::from_str(&output(&deny)).unwrap();
        assert_eq!(v["hookSpecificOutput"]["decision"]["behavior"], "deny");
        assert_eq!(v["hookSpecificOutput"]["decision"]["interrupt"], false);
        assert!(v["hookSpecificOutput"]["decision"]["message"]
            .as_str()
            .unwrap()
            .ends_with("use trash instead"));
        assert_eq!(
            Decision::of_answer(Some("maybe"), None, None),
            None,
            "an option that is neither was read as an answer"
        );
    }

    #[test]
    fn a_timeout_denies_by_name_and_the_hook_outlives_the_wait() {
        let d = Decision::TimedOut { waited: RELAY_WAIT };
        assert!(!d.allows());
        let m = d.message().unwrap();
        assert!(
            m.starts_with("[PERMISSION_RELAY_TIMEOUT]") && m.contains("300 s"),
            "{m}"
        );
        assert!(HOOK_TIMEOUT_SECS >= RELAY_WAIT.as_secs() + 30);
        let block = hooks_block("/opt/forge-runner", Some("/r/cfg"), true);
        let hook = &block["PermissionRequest"][0]["hooks"][0];
        assert_eq!(hook["timeout"], HOOK_TIMEOUT_SECS);
        assert_eq!(
            hook["command"],
            "FORGE_RUNNER_CONFIG_DIR='/r/cfg' '/opt/forge-runner' hook --event PermissionRequest --relay"
        );
    }
}
