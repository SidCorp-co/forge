//! The agent that makes a workspace usable, before the stage agent sees it.
//!
//! A stage lands in whatever state the box left the checkout in. Until 0.7.5 a
//! bad state failed the job pre-claim, which a retry could not change: one wrong
//! branch on ubuntu5 (anhome, 2026-08-15) became 4 identical 7-second failures
//! over 8h; a dangling `core.hooksPath` failed 105 sidpeak jobs in one week, each
//! needing the same `pnpm install`. 0.7.5 turned that into a prompt notice, which
//! moved the repair onto the stage agent — the expensive model, mid-task, with
//! the issue's own work to do.
//!
//! This runs the repair FIRST, in its own cheap process: one `claude` with no MCP
//! config, one job (make the workspace usable), then it exits and the stage agent
//! starts on a clean tree. It is not a pipeline stage — no job row, no dispatch
//! gate, no runner slot — so it cannot become another place a run gets stuck.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;

use crate::runner::process::{build_command, graceful_kill};

/// Cheap tier on purpose: this reads `git status`, runs an install command and
/// reports. Every token it spends is a token the stage model does not have to.
const SETUP_MODEL: &str = "haiku";

/// Hard cap on the repair. Generous for a cold `pnpm install` on a large repo,
/// far below any stage's own budget.
const SETUP_TIMEOUT: Duration = Duration::from_secs(600);

/// Keeps a runaway summary out of the stage's prompt and the job_event.
const MAX_SUMMARY_CHARS: usize = 4000;

/// What the setup agent did, as the stage agent and the server are told it.
#[derive(Debug, Clone)]
pub struct SetupOutcome {
    /// The agent's own account of what it changed and what it left alone.
    pub summary: String,
    /// True when the process exited 0. False still carries a summary — a repair
    /// that failed halfway is exactly what the stage must be told about.
    pub ok: bool,
}

/// Prose the agent must obey whatever the project declares. Kept here rather
/// than in the project's own procedure because it is not the project's call.
// cm:guard the stash line is the whole safety story. The owner accepted losing uncommitted work (2026-08-18), and `git checkout --force` would deliver exactly that — irreversibly. A labelled stash loses it from the tree and keeps it recoverable, so an agent that guesses wrong costs a `git stash pop` instead of someone's afternoon. One tree on ubuntu5 held 173 staged files.
// cm:guard never grant this agent the Forge MCP. It runs with no `--mcp-config`, so it cannot touch issues, statuses or skills — a repair agent that can move an issue is a second, unaudited writer on the pipeline's state, and this one is a cheap model with no issue context.
const RULES: &str = "\
You are the setup step for an automated pipeline job. You are NOT doing the issue's work — \
another agent runs immediately after you and does that. Your only job is to leave this \
workspace in a state where it can build, test and commit.\n\
\n\
Rules:\n\
- Uncommitted work in the tree is not yours. If it blocks you, `git stash push -u -m \
forge-setup` it — never `git checkout --force`, `git reset --hard` or `git clean` it away.\n\
- Do not create, amend or push commits. Do not touch any branch other than to check out the \
one you were told to be on.\n\
- Do not start long-running processes (dev servers, watchers). Install and configure only.\n\
- If you cannot fix something, stop and say so plainly. A clear report beats a guess.\n\
\n\
End your reply with a section `WHAT I DID:` listing each command you ran and its outcome, then \
`PROCEDURE:` with the minimal ordered steps that would set this repo up from a fresh clone — \
only steps you actually ran and saw succeed, or `unknown` if you could not establish one.";

/// Assemble the agent's prompt: the live findings, the branch it must end on,
/// and the project's declared procedure when there is one.
///
/// `procedure` is `projects.workspace_setup` — prose, never executed as a command
/// list, so a project admin's text cannot become a shell line on the box.
// cm:edge contract -> packages/core/src/db/schema.ts — `projects.workspace_setup` is the source of `procedure`; it reaches here via `/me/runners` and this is its only consumer
pub fn build_prompt(findings: &[String], base_branch: Option<&str>, procedure: Option<&str>) -> String {
    let mut out = String::from(RULES);
    out.push_str("\n\n## What is wrong right now\n");
    for f in findings {
        out.push_str("- ");
        out.push_str(f);
        out.push('\n');
    }
    if let Some(base) = base_branch {
        out.push_str(&format!(
            "\nThis job must run against `{base}`. The tree should end up on `{base}`, \
fast-forwarded to `origin/{base}`.\n"
        ));
    }
    match procedure.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => {
            out.push_str("\n## This project's setup procedure\n");
            out.push_str("Declared by whoever knows this repo. Follow it; do not invent your own.\n\n");
            out.push_str(p);
            out.push('\n');
        }
        // cm:guard say "derive it" and say why the PROCEDURE section is then load-bearing: this branch is the expensive one, and the only thing that stops the next job paying it again is the stage agent recording what worked (`forge_projects.update` `workspaceSetup`). Drop the derive-and-report instruction and the setting stays empty forever.
        None => out.push_str(
            "\n## This project's setup procedure\n\
None is declared. Work it out from the repo itself — the lockfile names the package manager, \
the toolchain files name the runtime — and report it under `PROCEDURE:` so the next job does \
not have to work it out again.\n",
        ),
    }
    out
}

/// Run the repair in `repo_path` and return what it reports.
///
/// Never returns `Err`: a setup agent that could not run is a fact the caller
/// puts in the stage's prompt, not a reason to fail a claimed job.
pub async fn run(
    repo_path: &Path,
    findings: &[String],
    base_branch: Option<&str>,
    procedure: Option<&str>,
) -> SetupOutcome {
    let prompt = build_prompt(findings, base_branch, procedure);
    let args: Vec<String> = vec![
        "--model".into(),
        SETUP_MODEL.into(),
        "--permission-mode".into(),
        "bypassPermissions".into(),
        // No `--mcp-config`: this agent gets no Forge tools at all. `--strict`
        // additionally stops the provisioned repo's own `.mcp.json` loading.
        "--strict-mcp-config".into(),
        "-p".into(),
        prompt,
    ];

    let mut child = match build_command(&args, &repo_path.to_string_lossy())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return SetupOutcome {
                summary: format!("setup agent could not start: {e}"),
                ok: false,
            }
        }
    };

    let mut stdout = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout).await;
    }
    let status = match tokio::time::timeout(SETUP_TIMEOUT, child.wait()).await {
        Ok(Ok(s)) => Some(s),
        Ok(Err(_)) => None,
        Err(_) => {
            graceful_kill(&mut child).await;
            return SetupOutcome {
                summary: format!(
                    "setup agent timed out after {}s and was killed; the workspace is in whatever state it reached",
                    SETUP_TIMEOUT.as_secs()
                ),
                ok: false,
            };
        }
    };

    let summary: String = stdout.trim().chars().take(MAX_SUMMARY_CHARS).collect();
    let ok = status.map(|s| s.success()).unwrap_or(false);
    SetupOutcome {
        summary: if summary.is_empty() {
            "setup agent produced no output".to_string()
        } else {
            summary
        },
        ok,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn declared_procedure_is_quoted_and_the_agent_is_told_not_to_invent_one() {
        let p = build_prompt(
            &["`core.hooksPath` is set to `.husky`, which does not exist".into()],
            Some("develop"),
            Some("pnpm install --frozen-lockfile\npnpm prepare"),
        );
        assert!(p.contains("pnpm install --frozen-lockfile"));
        assert!(p.contains("do not invent your own"));
        assert!(!p.contains("None is declared"));
        assert!(p.contains("origin/develop"));
    }

    #[test]
    fn an_absent_procedure_asks_for_one_back() {
        let p = build_prompt(&["tree has uncommitted changes".into()], Some("main"), None);
        assert!(p.contains("None is declared"));
        assert!(p.contains("PROCEDURE:"));
    }

    /// Whitespace-only prose is the same as none — a project that once had a
    /// procedure and had it cleared must not send the agent an empty section it
    /// is told to follow rather than replace.
    #[test]
    fn blank_procedure_counts_as_absent() {
        let p = build_prompt(&["x".into()], None, Some("   \n  "));
        assert!(p.contains("None is declared"));
    }

    #[test]
    fn the_destructive_git_commands_are_named_as_forbidden() {
        let p = build_prompt(&["x".into()], None, None);
        for banned in ["checkout --force", "reset --hard", "git clean"] {
            assert!(p.contains(banned), "the rules must name `{banned}`");
        }
        assert!(p.contains("forge-setup"));
    }
}
