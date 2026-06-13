//! ISS-305 — write an auto-provisioned git push credential locally so the
//! runner can `git push` without manual SSH/token setup (kills the
//! read-only-HTTPS blocker that stalled merge/release loops).
//!
//! Strategy for HTTPS transport (the only one core provisions today): store the
//! `https://user:token@host` line in a dedicated `0600` credentials file under
//! the runner config dir, then point git's `store` helper at it scoped to that
//! host (`git config --global credential.https://<host>.helper "store --file=…"`).
//! This is host-scoped, survives reboots, and never touches the user's other
//! credential helpers.

use std::path::PathBuf;
use std::process::Command;

use crate::auth::pairing::GitCredential;
use crate::error::{Error, Result};

/// Path to the dedicated forge-runner git credentials file.
pub fn git_credentials_path() -> Result<PathBuf> {
    let dir = dirs_next::config_dir()
        .ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))?;
    Ok(dir.join("forge-runner").join("git-credentials"))
}

/// Percent-encode the userinfo portion of a credential URL (RFC 3986 sub-delims
/// + `@`/`:`/`/` must be escaped so a token containing them can't break the URL).
fn encode_userinfo(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Persist `cred` and configure git to use it. Returns a short human note.
pub fn write_git_credential(cred: &GitCredential) -> Result<String> {
    if cred.transport != "https" {
        // Only HTTPS is provisioned today; SSH deploy-key support can slot in here.
        return Err(Error::Other(format!(
            "unsupported git credential transport: {}",
            cred.transport
        )));
    }

    let path = git_credentials_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
        restrict_dir(parent);
    }

    let line = format!(
        "https://{}:{}@{}\n",
        encode_userinfo(&cred.username),
        encode_userinfo(&cred.password),
        cred.host,
    );
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, line.as_bytes())?;
    restrict_file(&tmp);
    std::fs::rename(&tmp, &path)?;

    // Scope the store helper to this host so we never shadow the user's other
    // credentials. `--global` so it applies regardless of repo cwd.
    let helper = format!("store --file={}", path.display());
    let key = format!("credential.https://{}.helper", cred.host);
    let out = Command::new("git")
        .args(["config", "--global", &key, &helper])
        .output()
        .map_err(|e| Error::Other(format!("git config: {e}")))?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git config failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }

    Ok(cred
        .instructions
        .clone()
        .unwrap_or_else(|| format!("git push enabled for https://{}", cred.host)))
}

/// Dir holding per-project SSH deploy keys delivered during provision.
pub fn ssh_keys_dir() -> Result<PathBuf> {
    let dir = dirs_next::config_dir()
        .ok_or_else(|| Error::Config("cannot resolve OS config dir".into()))?;
    Ok(dir.join("forge-runner").join("keys"))
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
