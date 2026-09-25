//! The credential a repository is configured to push with, named rather than
//! inherited.
//!
//! Provisioning writes one project deploy key to `keys/<projectId>` and points
//! the checkout's `core.sshCommand` at it (`workspace/provision.rs`). Every git
//! call the release path makes then used to spawn bare `git` and hope the child
//! resolved that setting. It does not always: git documents `GIT_SSH_COMMAND`
//! as taking precedence over `core.sshCommand`, so one variable in the
//! environment the daemon was started with silently substitutes the default
//! identity — measured here, and it answers with exactly the string a box on
//! `sid-xeon-1` logged, `git@gitlab.com: Permission denied (publickey).`
//! (ISS-1250). A child resolving a repository other than the provisioned one
//! reaches the same place by another road.
//!
//! So the credential is resolved once, from what this box knows rather than
//! from what a child happens to read, and handed to every git call that touches
//! a remote. Where none resolves, an inherited one is taken back off the child,
//! because the repository's own configuration is a better answer than a
//! variable nobody here set. The point is not which key wins: it is that the
//! check and the push cannot offer different ones, which is what made a working
//! push read as an unreadable remote.
//!
//! Which is why the repository's own `core.sshCommand` is read FIRST and the
//! provisioned key is only the fallback. The rule this answers to is that the
//! check authenticates as the repository is configured to PUSH, and the two
//! can diverge: a key rotated by hand, a repository adopted rather than cloned,
//! a `core.sshCommand` an operator edited. Preferring the key file would then
//! hand the daemon an identity the shell's own push does not use, which is this
//! defect again with the sides swapped (consult 27dbdd F1).

use std::path::{Path, PathBuf};

use tokio::process::Command;

/// The credential offered to a git child, and where this box found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoCred {
    ssh_command: Option<String>,
    source: String,
}

impl RepoCred {
    /// Resolve it for a project's checkout.
    pub async fn of(project_id: Option<&str>, at: &Path) -> Self {
        Self::resolved(crate::auth::git_cred::ssh_keys_dir().ok(), project_id, at).await
    }

    /// The same with the keys directory handed in, so both arms are reachable
    /// from a test without moving this process's own config dir.
    async fn resolved(keys_dir: Option<PathBuf>, project_id: Option<&str>, at: &Path) -> Self {
        if let Some(configured) = configured(at).await {
            return Self {
                source: format!("the repository's own core.sshCommand (`{configured}`)"),
                ssh_command: Some(configured),
            };
        }
        if let Some(key) = provisioned_key(keys_dir, project_id) {
            return Self {
                ssh_command: Some(crate::auth::git_cred::ssh_command(&key)),
                source: format!(
                    "the deploy key this box provisioned for this project ({}), the repository \
                     itself configuring none",
                    key.display()
                ),
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

fn provisioned_key(keys_dir: Option<PathBuf>, project_id: Option<&str>) -> Option<PathBuf> {
    let id = project_id.map(str::trim).filter(|s| !s.is_empty())?;
    let path = keys_dir?.join(id);
    path.is_file().then_some(path)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    /// What the child was told, as `Command` records it: `Some` for a value
    /// set, `None` for one removed. Read from the std `Command` underneath,
    /// because that is where the overrides live and nothing else can see them.
    fn told(cred: &RepoCred) -> Vec<(String, Option<String>)> {
        let mut cmd = Command::new("git");
        cred.apply(&mut cmd);
        cmd.as_std()
            .get_envs()
            .map(|(k, v)| {
                (
                    k.to_string_lossy().into_owned(),
                    v.map(|v| v.to_string_lossy().into_owned()),
                )
            })
            .collect()
    }

    fn a_repo(scratch: &Scratch, ssh_command: Option<&str>) -> std::path::PathBuf {
        let repo = scratch.join("repo");
        std::fs::create_dir_all(&repo).expect("mkdir");
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .expect("git")
        };
        git(&["init", "-q", "-b", "main"]);
        if let Some(value) = ssh_command {
            git(&["config", "core.sshCommand", value]);
        }
        repo
    }

    /// consult 27dbdd F1 — the two can name different keys, and only one of
    /// them is the one the push uses.
    #[tokio::test]
    async fn the_repositorys_own_configuration_outranks_the_key_this_box_provisioned() {
        let scratch = Scratch::new("cred-order");
        let keys = scratch.join("keys");
        std::fs::create_dir_all(&keys).expect("mkdir");
        std::fs::write(keys.join("proj-1"), "key\n").expect("key");
        let repo = a_repo(&scratch, Some("ssh -i /repo/own/key"));

        let cred = RepoCred::resolved(Some(keys), Some("proj-1"), &repo).await;

        assert_eq!(
            told(&cred),
            vec![(
                "GIT_SSH_COMMAND".to_string(),
                Some("ssh -i /repo/own/key".to_string())
            )],
            "the rule is that the check authenticates as the repository is configured to PUSH, \
             so a key file that has drifted from that configuration must not win"
        );
    }

    #[tokio::test]
    async fn the_deploy_key_this_box_provisioned_answers_for_a_repository_configuring_none() {
        let scratch = Scratch::new("cred-key");
        let keys = scratch.join("keys");
        std::fs::create_dir_all(&keys).expect("mkdir");
        let key = keys.join("proj-1");
        std::fs::write(&key, "key\n").expect("key");
        let repo = a_repo(&scratch, None);

        let cred = RepoCred::resolved(Some(keys), Some("proj-1"), &repo).await;

        assert_eq!(
            told(&cred),
            vec![(
                "GIT_SSH_COMMAND".to_string(),
                Some(crate::auth::git_cred::ssh_command(&key))
            )],
            "a repository that configures nothing is still a project this box holds a key for"
        );
        assert!(
            cred.source().contains(&key.display().to_string()),
            "a refusal has to be able to name the key it offered: {}",
            cred.source()
        );
    }

    /// The failure this issue is about, in one assertion: git documents
    /// `GIT_SSH_COMMAND` as beating `core.sshCommand`, so a value in the
    /// environment the daemon was started with decides every fetch and push
    /// unless something takes it off the call.
    #[tokio::test]
    async fn where_nothing_resolves_an_inherited_credential_is_taken_off_the_call() {
        let scratch = Scratch::new("cred-none");
        let repo = a_repo(&scratch, None);

        let cred = RepoCred::resolved(None, None, &repo).await;

        assert_eq!(
            told(&cred),
            vec![("GIT_SSH_COMMAND".to_string(), None)],
            "leaving an inherited GIT_SSH_COMMAND on the call is how a repository's own \
             configuration stops deciding: {}",
            cred.source()
        );
    }

    #[tokio::test]
    async fn a_project_id_that_names_no_key_on_this_box_falls_through_rather_than_inventing_a_path()
    {
        let scratch = Scratch::new("cred-missing");
        let keys = scratch.join("keys");
        std::fs::create_dir_all(&keys).expect("mkdir");
        let repo = a_repo(&scratch, None);

        let cred = RepoCred::resolved(Some(keys), Some("proj-nothing-here"), &repo).await;

        assert_eq!(
            told(&cred),
            vec![("GIT_SSH_COMMAND".to_string(), None)],
            "a key file that is not there is not a credential, and pointing ssh at it would \
             refuse every remote on the box"
        );
    }

    #[tokio::test]
    async fn an_empty_project_id_is_not_a_key_named_by_the_empty_string() {
        let scratch = Scratch::new("cred-empty");
        let keys = scratch.join("keys");
        std::fs::create_dir_all(&keys).expect("mkdir");
        let repo = a_repo(&scratch, None);

        let cred = RepoCred::resolved(Some(keys), Some("   "), &repo).await;

        assert_eq!(
            told(&cred),
            vec![("GIT_SSH_COMMAND".to_string(), None)],
            "`keys/` itself is a directory, and a blank id must not resolve to it"
        );
    }
}
