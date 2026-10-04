//! Per-project git SSH deploy keys delivered during provision, written under the runner config
//! dir and wired into git through `core.sshCommand`.

use std::path::PathBuf;

use crate::error::Result;

/// Dir holding per-project SSH deploy keys delivered during provision.
pub fn ssh_keys_dir() -> Result<PathBuf> {
    Ok(crate::config::base_dir()?.join("keys"))
}

/// Write a project's git SSH private key to a `0600` file and return its path.
/// One key per project (`keys/<projectId>`); rewritten on each provision so a
/// rotated server-side key takes effect. The caller wires it into git via
/// [`ssh_command`] (clone env + repo-local `core.sshCommand`).
pub fn write_project_ssh_key(project_id: &str, private_key: &str) -> Result<PathBuf> {
    let dir = ssh_keys_dir()?;
    std::fs::create_dir_all(&dir)?;
    restrict_dir(&dir);
    let path = dir.join(project_id);
    // OpenSSH refuses a key file without a trailing newline.
    let body = if private_key.ends_with('\n') {
        private_key.to_string()
    } else {
        format!("{private_key}\n")
    };
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, body.as_bytes())?;
    restrict_file(&tmp);
    std::fs::rename(&tmp, &path)?;
    restrict_file(&path);
    Ok(path)
}

/// The `GIT_SSH_COMMAND` / `core.sshCommand` value pinning git to one key.
/// `IdentitiesOnly` stops ssh-agent keys leaking in; `accept-new` trusts the
/// host on first contact without a prompt (runners are unattended).
pub fn ssh_command(key_path: &std::path::Path) -> String {
    format!(
        "ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new",
        key_path.display()
    )
}

/// Host of an `https://` git URL, which is the scope a credential config entry
/// takes. `None` for any other transport.
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.trim().strip_prefix("https://")?;
    let host = rest.split('/').next()?;
    let host = host.rsplit('@').next()?;
    if host.is_empty() {
        None
    } else {
        Some(host.to_string())
    }
}

/// The program the persisted helper names, or `None` where this box can name
/// none — which is a helper not written rather than one written dead.
///
/// The helper outlives the daemon that wrote it: it goes into a checkout's own
/// `.git/config` and every later fetch and push resolves through it, so a path
/// that was true only while one process lived is the worst thing to put there.
fn helper_program() -> Option<String> {
    helper_from(crate::exe::own())
}

/// The same with the resolution handed in, so every arm is reachable from a
/// test while this process's own binary is present.
fn helper_from(own: Result<crate::exe::OwnExe>) -> Option<String> {
    match own {
        Ok(exe) => {
            if let Some(was) = &exe.replaced_from {
                tracing::warn!(
                    "[git-cred] the binary this process started on ({}) was replaced while it ran — the credential helper names {}, the build standing there now",
                    was.display(),
                    exe.path.display()
                );
            }
            named(&exe.path)
        }
        Err(e) => match crate::exe::on_path("forge-runner") {
            Some(found) => {
                tracing::warn!(
                    "[git-cred] {e} — the credential helper names {}, resolved on PATH instead",
                    found.display()
                );
                named(&found)
            }
            None => {
                tracing::error!(
                    "[git-cred] {e}, and PATH resolves no `forge-runner` either — no credential helper is written for this host, rather than one that fails on every fetch and push"
                );
                None
            }
        },
    }
}

/// The path as the text a helper may carry, or nothing.
///
/// Never `display()`: it replaces bytes it cannot render, so a helper built
/// from it names a different file and fails on every fetch and push — which is
/// the refusal `hook_install::install` already makes for the same class
/// (consult 7bbe98 F1).
fn named(path: &std::path::Path) -> Option<String> {
    match path.to_str() {
        Some(text) => Some(text.to_string()),
        None => {
            tracing::error!(
                "[git-cred] the runner's own path is not valid UTF-8 ({}), so no credential helper is written for this host rather than one naming a different file",
                path.display()
            );
            None
        }
    }
}

/// The `-c` overrides that point git at this runner's helper for `host`, or
/// nothing at all where no program can be named.
pub fn credential_helper_git_args(host: &str) -> Vec<String> {
    let Some(exe) = helper_program() else {
        return Vec::new();
    };
    let helper = format!("!{} git-credential", shell_quote(&exe));
    vec![
        "-c".into(),
        format!("credential.https://{host}.helper="),
        "-c".into(),
        format!("credential.https://{host}.helper={helper}"),
        "-c".into(),
        format!("credential.https://{host}.useHttpPath=true"),
    ]
}

/// Persist the same entries repo-locally, so every later fetch and push in this
/// checkout resolves its credential the same way the clone did. `Err` names the
/// step that did not land, so a caller that cannot carry on without the helper says so.
pub fn set_repo_credential_helper(
    repo_path: &std::path::Path,
    host: &str,
) -> std::result::Result<(), String> {
    let key = format!("credential.https://{host}.helper");
    let args = credential_helper_git_args(host);
    let Some(helper_value) = args
        .get(3)
        .and_then(|v| v.split_once('=').map(|(_, v)| v.to_string()))
    else {
        return Err(format!(
            "no program could be named for {host}'s credential helper, so {}'s git config is left as it is — an empty helper would refuse every fetch and push in it",
            repo_path.display()
        ));
    };

    let steps: Vec<Vec<String>> = vec![
        vec![
            "config".into(),
            "--replace-all".into(),
            key.clone(),
            String::new(),
        ],
        vec!["config".into(), "--add".into(), key, helper_value],
        vec![
            "config".into(),
            format!("credential.https://{host}.useHttpPath"),
            "true".into(),
        ],
    ];
    for step in steps {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(repo_path)
            .args(&step)
            .output();
        match out {
            Ok(o) if o.status.success() => {}
            Ok(o) => {
                return Err(format!(
                    "git {} failed: {}",
                    step.join(" "),
                    String::from_utf8_lossy(&o.stderr).trim()
                ))
            }
            Err(e) => return Err(format!("spawn git {}: {e}", step.join(" "))),
        }
    }
    Ok(())
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

#[cfg(unix)]
fn restrict_file(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o600));
}
#[cfg(unix)]
fn restrict_dir(p: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o700));
}
#[cfg(not(unix))]
fn restrict_file(_p: &std::path::Path) {}
#[cfg(not(unix))]
fn restrict_dir(_p: &std::path::Path) {}
