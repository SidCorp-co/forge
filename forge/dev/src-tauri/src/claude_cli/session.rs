use super::log;
use super::mcp::write_mcp_config;
use super::spawn::to_wsl_path;
use super::worktree;
use serde::Deserialize;
use tokio::process::Command;

#[derive(Debug, Deserialize)]
pub struct SelectedIssue {
    #[serde(rename = "documentId")]
    pub document_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    pub priority: String,
    #[serde(rename = "acceptanceCriteria")]
    pub acceptance_criteria: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
pub struct SelectedTask {
    #[serde(rename = "documentId")]
    pub document_id: String,
    pub title: String,
    pub description: Option<String>,
    pub status: String,
    #[serde(rename = "issueTitle")]
    pub issue_title: Option<String>,
}

/// Resolve WSL distro (cached).
/// `wsl --list --quiet` outputs UTF-16LE on Windows; must decode accordingly.
#[cfg(target_os = "windows")]
fn wsl_distro() -> String {
    use std::sync::OnceLock;
    static DISTRO: OnceLock<String> = OnceLock::new();
    DISTRO.get_or_init(|| {
        if let Ok(output) = std::process::Command::new("wsl")
            .args(["--list", "--quiet"])
            .output()
        {
            if output.status.success() {
                // wsl --list outputs UTF-16LE on Windows; decode accordingly
                let out = if output.stdout.len() >= 2 && output.stdout[0] == 0xFF && output.stdout[1] == 0xFE {
                    // Has BOM — skip it
                    let u16s: Vec<u16> = output.stdout[2..].chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else if output.stdout.iter().any(|&b| b == 0) {
                    // No BOM but contains null bytes — likely UTF-16LE
                    let u16s: Vec<u16> = output.stdout.chunks_exact(2)
                        .map(|c| u16::from_le_bytes([c[0], c[1]]))
                        .collect();
                    String::from_utf16_lossy(&u16s)
                } else {
                    String::from_utf8_lossy(&output.stdout).into_owned()
                };
                // Find first non-empty, non-docker distro
                let distros: Vec<String> = out.lines()
                    .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
                    .filter(|l| !l.is_empty())
                    .collect();
                log(&format!("[wsl] session: available distros: {:?}", distros));
                if let Some(distro) = distros.iter().find(|d| !d.to_lowercase().contains("docker")) {
                    log(&format!("[wsl] session: detected distro: {distro}"));
                    return distro.clone();
                }
                if let Some(distro) = distros.first() {
                    return distro.clone();
                }
            }
        }
        log("[wsl] session: fallback to Ubuntu-24.04");
        "Ubuntu-24.04".to_string()
    }).clone()
}

/// Launch a terminal running the given claude command string.
/// Handles Windows (wt/cmd+wsl) and Linux (x-terminal-emulator/gnome-terminal/xterm).
async fn launch_terminal(claude_cmd: &str, use_wsl: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        if !use_wsl {
            // Native Windows: open cmd with claude command directly
            log(&format!("[terminal] native Windows: {claude_cmd}"));
            let wt_result = Command::new("wt")
                .args(["new-tab", "cmd", "/k", claude_cmd])
                .spawn();
            match wt_result {
                Ok(_) => return Ok(()),
                Err(e) => {
                    log(&format!("[terminal] wt failed, falling back to cmd: {e}"));
                    Command::new("cmd")
                        .args(["/c", "start", "cmd", "/k", claude_cmd])
                        .spawn()
                        .map_err(|e| format!("Failed to open terminal: {e}"))?;
                    return Ok(());
                }
            }
        }

        // WSL mode
        let full_cmd = format!(
            "unset CLAUDECODE && export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && {}",
            claude_cmd
        );
        let distro = wsl_distro();
        let script_path = std::env::temp_dir().join(format!("forge-term-{}.sh", uuid::Uuid::new_v4()));
        std::fs::write(&script_path, &full_cmd)
            .map_err(|e| format!("Failed to write temp script: {e}"))?;
        let wsl_script = to_wsl_path(&script_path.to_string_lossy());

        log(&format!("[terminal] wt new-tab wsl -d {} -- bash -l {}", distro, wsl_script));
        let wt_result = Command::new("wt")
            .args(["new-tab", "wsl", "-d", &distro, "--", "bash", "-l", &wsl_script])
            .spawn();

        match wt_result {
            Ok(_) => return Ok(()),
            Err(e) => {
                log(&format!("[terminal] wt failed, falling back to cmd: {e}"));
                Command::new("cmd")
                    .args(["/c", "start", "wsl", "-d", &distro, "--", "bash", "-l", &wsl_script])
                    .spawn()
                    .map_err(|e| format!("Failed to open terminal: {e}"))?;
                return Ok(());
            }
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let full_cmd = format!(
            "unset CLAUDECODE && export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && {}",
            claude_cmd
        );
        let terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
        for term in &terminals {
            if Command::new(term)
                .args(["-e", "bash", "-lc", &full_cmd])
                .spawn()
                .is_ok()
            {
                return Ok(());
            }
        }
        return Err("No terminal emulator found".to_string());
    }
}

pub async fn start_session(
    repo_path: String,
    branch_name: String,
    selected_issues: Vec<SelectedIssue>,
    selected_tasks: Vec<SelectedTask>,
    forge_url: String,
    forge_token: String,
    project_slug: String,
) -> Result<(), String> {
    log(&format!("[start_session] repo={repo_path} branch={branch_name}"));

    // Create an isolated worktree for this session
    let wt_path = worktree::create_worktree(&repo_path, &branch_name).await?;
    let wsl_path = to_wsl_path(&wt_path);
    log(&format!("[start_session] worktree={wsl_path}"));

    let mut prompt = format!(
        "You are working on Forge issues/tasks. Read .forge/knowledge.json for codebase context.\n\n\
         You are in a git worktree on branch `{}`. Do NOT run `git checkout` — you are already on the correct branch.\n\n",
        branch_name
    );

    if !selected_issues.is_empty() {
        prompt.push_str("Selected Issues:\n");
        for issue in &selected_issues {
            prompt.push_str(&format!(
                "- [{}] {} (priority: {}, status: {})\n",
                issue.document_id, issue.title, issue.priority, issue.status
            ));
            if let Some(ref desc) = issue.description {
                if !desc.is_empty() {
                    prompt.push_str(&format!("  Description: {}\n", desc));
                }
            }
            if let Some(ref ac) = issue.acceptance_criteria {
                if !ac.is_empty() {
                    prompt.push_str(&format!("  Acceptance Criteria: {}\n", ac.join("; ")));
                }
            }
        }
        prompt.push('\n');
    }

    if !selected_tasks.is_empty() {
        prompt.push_str("Selected Tasks:\n");
        for task in &selected_tasks {
            prompt.push_str(&format!(
                "- [{}] {} (status: {})",
                task.document_id, task.title, task.status
            ));
            if let Some(ref parent) = task.issue_title {
                prompt.push_str(&format!(" (parent: {})", parent));
            }
            prompt.push('\n');
            if let Some(ref desc) = task.description {
                if !desc.is_empty() {
                    prompt.push_str(&format!("  Description: {}\n", desc));
                }
            }
        }
        prompt.push('\n');
    }

    prompt.push_str(
        "Use forge_issues/forge_tasks/forge_comments MCP tools to update status as you work.\n\
         Update task status to in_progress when starting, done when complete.\n\
         Update issue status to in_progress when starting work, resolved when all tasks done.\n",
    );

    let mcp_config_path = write_mcp_config(&forge_url, &forge_token, &project_slug, None)?;
    let mcp_config_str = mcp_config_path.to_string_lossy().to_string();

    // On Windows with native claude, use Windows paths and cmd syntax
    #[cfg(target_os = "windows")]
    if super::spawn::has_native_claude() {
        let win_wt_path = super::platform::to_windows_path(&wt_path);
        let escaped_prompt = prompt.replace('"', "\\\"");
        let claude_cmd = format!(
            "cd /d \"{}\" && claude --permission-mode bypassPermissions --mcp-config \"{}\" --append-system-prompt \"{}\"",
            win_wt_path, mcp_config_str, escaped_prompt
        );
        log("[start_session] launching native terminal");
        return launch_terminal(&claude_cmd, false).await;
    }

    let escaped_prompt = prompt.replace('\'', "'\\''");
    let mcp_wsl_path = to_wsl_path(&mcp_config_str);

    let claude_cmd = format!(
        "cd '{}' && claude --permission-mode bypassPermissions --mcp-config '{}' --append-system-prompt '{}'",
        wsl_path, mcp_wsl_path, escaped_prompt
    );

    log("[start_session] launching terminal");
    launch_terminal(&claude_cmd, true).await
}

pub async fn open_terminal(
    repo_path: String,
    system_prompt: Option<String>,
    claude_session_id: Option<String>,
) -> Result<(), String> {
    // On Windows with native claude, use Windows paths and cmd syntax
    #[cfg(target_os = "windows")]
    if super::spawn::has_native_claude() {
        let win_path = super::platform::to_windows_path(&repo_path);
        let mut claude_cmd = format!(
            "cd /d \"{}\" && claude --permission-mode bypassPermissions",
            win_path
        );
        if let Some(ref session_id) = claude_session_id {
            claude_cmd = format!("{} --resume {}", claude_cmd, session_id);
        } else if let Some(ref prompt) = system_prompt {
            let escaped = prompt.replace('"', "\\\"");
            claude_cmd = format!("{} --append-system-prompt \"{}\"", claude_cmd, escaped);
        }
        log(&format!("[open_terminal] native: {claude_cmd}"));
        return launch_terminal(&claude_cmd, false).await;
    }

    // WSL / Linux / Mac path
    let wsl_path = to_wsl_path(&repo_path);
    let mut claude_cmd = format!(
        "cd '{}' && claude --permission-mode bypassPermissions",
        wsl_path
    );
    if let Some(ref session_id) = claude_session_id {
        claude_cmd = format!("{} --resume {}", claude_cmd, session_id);
    } else if let Some(prompt) = system_prompt {
        let escaped = prompt.replace('\'', "'\\''");
        claude_cmd = format!("{} --append-system-prompt '{}'", claude_cmd, escaped);
    }

    log(&format!("[open_terminal] {claude_cmd}"));
    launch_terminal(&claude_cmd, true).await
}
