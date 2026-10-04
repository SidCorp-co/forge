//! The credential a repository is configured to push with, named rather than
//! inherited.
//!
//! Every git call the release path makes used to spawn bare `git` and hope the
//! child resolved the checkout's `core.sshCommand`. It does not always: git
//! documents `GIT_SSH_COMMAND` as taking precedence over `core.sshCommand`, so
//! one variable in the environment the daemon was started with silently
//! substitutes another identity (ISS-1250).
//!
//! So the credential is read once, from the repository's own configuration —
//! how the box itself is set up to push — and handed to every git call that
//! touches a remote. Where the repository configures none, an inherited
//! `GIT_SSH_COMMAND` is taken back off the child, so the check and the push
//! cannot offer different identities.

use std::path::Path;

use tokio::process::Command;

/// The credential offered to a git child, and where this box found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoCred {
    ssh_command: Option<String>,
    source: String,
}

impl RepoCred {
    /// Resolve it for a project's checkout.
    pub async fn of(at: &Path) -> Self {
        if let Some(configured) = configured(at).await {
            return Self {
                source: format!("the repository's own core.sshCommand (`{configured}`)"),
                ssh_command: Some(configured),
            };
        }
        Self {
            ssh_command: None,
            source: "no credential this box can name, so the repository's own configuration \
                     decides and any inherited GIT_SSH_COMMAND is taken off the call"
                .into(),
        }
    }

    /// What this credential is, in the words a failure carries. A remote that
    /// refuses an identity is unreadable from outside the process unless the
    /// refusal says which identity was offered.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Put it on a git child, or take an inherited one off.
    pub fn apply(&self, cmd: &mut Command) {
        match &self.ssh_command {
            Some(ssh) => cmd.env("GIT_SSH_COMMAND", ssh),
            None => cmd.env_remove("GIT_SSH_COMMAND"),
        };
    }
}

async fn configured(at: &Path) -> Option<String> {
    let out = Command::new("git")
        .args(["config", "--get", "core.sshCommand"])
        .current_dir(at)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}
