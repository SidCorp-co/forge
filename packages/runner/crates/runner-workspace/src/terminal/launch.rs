//! The command line a pane's agent is started with.

use super::shell_quote;

pub fn pane_argv(mcp_config: Option<&std::path::Path>, resume: Option<&str>) -> Vec<String> {
    job_argv(mcp_config, resume, None, &[], None)
}

/// [`pane_argv`] for a job: the model and the tools its policy state names, and the brief at
/// `first_turn` as the agent's launch prompt.
///
/// A brief typed at the prompt by paste reaches the model as pasted content, which it treats as
/// data no instruction stands behind: every release job from dev.26 on answered that the pasted
/// brief could not authorize its own push, tag and deploy, and waited. A launch prompt is the
/// session's own first user turn, the way `claude "…"` typed by a person is. It is read from a
/// file at exec time because a 15 KB brief inside the command tmux carries crosses tmux's message
/// size, while one argument may be 128 KB on Linux; a brief that cannot be read ends the pane
/// rather than starting an agent with nothing to do. `--` closes `--disallowed-tools`, whose
/// variadic list would otherwise take the brief as one more tool.
///
/// Each denied pattern is its own argument: a pattern may hold a space (`Bash(git push:*)`), and a
/// list joined into one argument would be split by the CLI where the policy wrote one entry.
// contract -> packages/core/src/project-config/schema.ts:TOOL_PATTERN — every entry core
// hands here passed that grammar, which is the one `--disallowed-tools` reads; `--disallowed-tools`
// narrows the tool SET even under `bypassPermissions` (claude_code.rs says where that was verified).
pub fn job_argv(
    mcp_config: Option<&std::path::Path>,
    resume: Option<&str>,
    model: Option<&str>,
    denied_tools: &[String],
    first_turn: Option<&std::path::Path>,
) -> Vec<String> {
    let bin = shell_quote(runner_platform::process::resolve_claude_bin());
    let mut line = first_turn.map(first_turn_prelude).unwrap_or_default();
    line.push_str(&format!(
        "unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions"
    ));
    if let Some(model) = model.filter(|m| !m.is_empty()) {
        line.push_str(&format!(" --model {}", shell_quote(model)));
    }
    if !denied_tools.is_empty() {
        line.push_str(" --disallowed-tools");
        for tool in denied_tools {
            line.push_str(&format!(" {}", shell_quote(tool)));
        }
    }
    if let Some(path) = mcp_config {
        line.push_str(&format!(
            " --mcp-config {}",
            shell_quote(&path.to_string_lossy())
        ));
    }
    if let Some(id) = resume.filter(|s| !s.is_empty()) {
        line.push_str(&format!(" --resume {}", shell_quote(id)));
    }
    if first_turn.is_some() {
        line.push_str(" -- \"$p\"");
    }
    vec!["sh".into(), "-c".into(), line]
}

/// The shell that reads a job's brief into `$p` and removes the file, or ends the pane naming the
/// file where it cannot.
pub fn first_turn_prelude(path: &std::path::Path) -> String {
    let file = shell_quote(&path.to_string_lossy());
    format!(
        "p=$(cat -- {file}) && [ -n \"$p\" ] || {{ echo {why} >&2; exit 66; }}; rm -f -- {file}; ",
        why = shell_quote(&format!(
            "forge-runner: the job brief {} could not be read, so no agent was started",
            path.display()
        ))
    )
}
