//! The command line a pane's agent is started with.

use super::shell_quote;
use crate::plugin_source::PluginLaunch;

/// The launch a master pane takes. `plugins` is the checkout this runner loads its plugins from
/// (`crate::plugin_source`), empty where it loads the registered ones.
pub fn pane_argv(
    mcp_config: Option<&std::path::Path>,
    resume: Option<&str>,
    plugins: &PluginLaunch,
) -> Vec<String> {
    job_argv(mcp_config, resume, None, &[], None, plugins)
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
    plugins: &PluginLaunch,
) -> Vec<String> {
    let bin = shell_quote(runner_platform::process::resolve_claude_bin());
    let mut line = first_turn.map(first_turn_prelude).unwrap_or_default();
    line.push_str(&format!(
        "unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions"
    ));
    for arg in plugins.args(false) {
        line.push_str(&format!(" {}", shell_quote(&arg)));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn checkout_launch() -> PluginLaunch {
        PluginLaunch {
            dirs: vec![std::path::PathBuf::from("/co/forge plugin")],
            disabled: vec!["forge@forge-local".into()],
        }
    }

    /// What the shell hands `claude` for `line`: the line run with `printf` in place of the binary.
    fn argv_the_shell_reads(line: &str) -> Vec<String> {
        let bin = shell_quote(runner_platform::process::resolve_claude_bin());
        let exec = format!("unset CLAUDECODE; exec {bin}");
        assert!(line.starts_with(&exec), "{line}");
        let printed = line.replacen(&exec, "printf '%s\\n'", 1);
        let out = std::process::Command::new("sh")
            .args(["-c", &printed])
            .output()
            .unwrap();
        String::from_utf8(out.stdout)
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn a_runner_with_no_plugin_checkout_launches_a_pane_exactly_as_before() {
        let mcp = std::path::Path::new("/box/mcp.json");
        let line = pane_argv(Some(mcp), Some("abc"), &PluginLaunch::default())
            .pop()
            .unwrap();
        let bin = shell_quote(runner_platform::process::resolve_claude_bin());
        assert_eq!(
            line,
            format!(
                "unset CLAUDECODE; exec {bin} --permission-mode bypassPermissions --mcp-config \
                 '/box/mcp.json' --resume 'abc'"
            )
        );
    }

    #[test]
    fn a_runner_with_a_plugin_checkout_hands_the_pane_its_directory_and_turns_the_registered_one_off(
    ) {
        let line = job_argv(None, None, Some("opus"), &[], None, &checkout_launch())
            .pop()
            .unwrap();
        assert_eq!(
            argv_the_shell_reads(&line),
            vec![
                "--permission-mode",
                "bypassPermissions",
                "--plugin-dir",
                "/co/forge plugin",
                "--settings",
                r#"{"enabledPlugins":{"forge@forge-local":false}}"#,
                "--model",
                "opus",
            ]
        );
    }
}
