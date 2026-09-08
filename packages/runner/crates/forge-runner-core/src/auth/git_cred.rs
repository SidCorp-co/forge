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

/// `git -c …` flags that point one host's credential lookups at this binary.
///
/// Used for the clone itself, where there is no repo yet to hold config.
// cm:guard the EMPTY helper value comes first and is not decoration — git collects `credential.<url>.helper` from system, then global, then local config and asks them IN THAT ORDER, so an ambient helper (a box with `gh` installed configures one) answers before a repo-local entry and the push lands as that identity instead. The empty value resets the list; measured 2026-09-08, without it `git credential fill` returned a personal `gho_` token for a repository this helper was configured for, and with it git fails loudly having asked nobody else.
// cm:guard `useHttpPath` is not optional either — without it git sends only the host, and `git-credential` cannot tell which repository is being fetched, so it refuses rather than guess. All three entries are written together or none of them are.
// cm:edge protocol -> packages/runner/crates/forge-runner/src/cmd/git_credential.rs — `!` makes git run this through a shell, so the exe path is quoted here; the subcommand name is the contract between the two.
pub fn credential_helper_git_args(host: &str) -> Vec<String> {
    let exe = std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| "forge-runner".to_string());
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
/// checkout resolves its credential the same way the clone did.
pub fn set_repo_credential_helper(repo_path: &std::path::Path, host: &str) {
    let key = format!("credential.https://{host}.helper");
    let args = credential_helper_git_args(host);
    let helper_value = args
        .get(3)
        .and_then(|v| v.split_once('=').map(|(_, v)| v.to_string()))
        .unwrap_or_default();

    // cm:guard `--replace-all` with the empty value, THEN `--add` ours — a plain `git config` would
    // leave whatever the key already held and re-create the ordering problem the reset exists for.
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
            Ok(o) => tracing::warn!(
                "[provision] git {} failed: {}",
                step.join(" "),
                String::from_utf8_lossy(&o.stderr).trim()
            ),
            Err(e) => tracing::warn!("[provision] spawn git {}: {e}", step.join(" ")),
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_host_only_for_https() {
        assert_eq!(
            https_host("https://github.com/SidCorp-co/epodsystem_cli.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(https_host("git@github.com:SidCorp-co/x.git"), None);
        assert_eq!(https_host("ssh://git@github.com/a/b"), None);
    }

    #[test]
    fn helper_args_reset_the_list_before_adding_ours_and_carry_use_http_path() {
        let args = credential_helper_git_args("github.com");
        assert_eq!(args.len(), 6);
        assert_eq!(args[1], "credential.https://github.com.helper=");
        assert!(args[3].starts_with("credential.https://github.com.helper=!"));
        assert!(args[3].contains("git-credential"));
        assert_eq!(args[5], "credential.https://github.com.useHttpPath=true");
    }

    #[test]
    fn a_path_with_a_space_survives_the_shell() {
        assert_eq!(
            shell_quote("/opt/my runner/forge"),
            "'/opt/my runner/forge'"
        );
    }

    fn tmp_repo(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("forge-gitcred-{tag}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        let out = Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(["init", "-q", "."])
            .output()
            .unwrap();
        assert!(out.status.success(), "git init: {out:?}");
        dir
    }

    fn local_config(repo: &std::path::Path, args: &[&str]) -> Vec<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(["config", "--local"])
            .args(args)
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn the_checkout_config_holds_the_reset_and_ours_in_that_order() {
        let repo = tmp_repo("shape");
        set_repo_credential_helper(&repo, "github.com");

        let helpers = local_config(
            &repo,
            &["--get-all", "credential.https://github.com.helper"],
        );
        assert_eq!(helpers.len(), 2, "expected a reset then ours: {helpers:?}");
        assert_eq!(helpers[0], "");
        assert!(helpers[1].starts_with('!'), "{}", helpers[1]);
        assert!(helpers[1].contains("git-credential"), "{}", helpers[1]);
        assert_eq!(
            local_config(&repo, &["credential.https://github.com.useHttpPath"]),
            vec!["true".to_string()]
        );

        std::fs::remove_dir_all(&repo).ok();
    }

    // cm:guard this test is the only place the RESET is proven against git itself rather than against our own argument list — `-c` flags and a config FILE are different code paths in git, and only the file one governs every fetch and push after the clone. It plants an ambient global helper that would answer, so a reset that stops working turns it red with `ambient` in the message.
    #[test]
    fn an_ambient_global_helper_is_not_asked_once_the_checkout_resets_the_list() {
        let repo = tmp_repo("order");
        set_repo_credential_helper(&repo, "github.com");

        let cfg = repo.join(".git").join("config");
        let body = std::fs::read_to_string(&cfg).unwrap();
        let ours = body
            .lines()
            .map(|l| {
                if l.trim_start().starts_with("helper = !") {
                    "\thelper = !printf 'username=local\\npassword=local\\n'".to_string()
                } else {
                    l.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&cfg, format!("{ours}\n")).unwrap();

        let global = repo.join("ambient-gitconfig");
        std::fs::write(
            &global,
            "[credential \"https://github.com\"]\n\thelper = !printf 'username=ambient\\npassword=ambient\\n'\n",
        )
        .unwrap();

        let out = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .env("GIT_CONFIG_GLOBAL", &global)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .args(["-c", "credential.interactive=never", "credential", "fill"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut ch| {
                use std::io::Write as _;
                ch.stdin
                    .as_mut()
                    .unwrap()
                    .write_all(b"protocol=https\nhost=github.com\npath=SidCorp-co/x.git\n\n")?;
                ch.wait_with_output()
            })
            .unwrap();
        let answer = String::from_utf8_lossy(&out.stdout);

        assert!(
            answer.contains("username=local"),
            "our helper did not answer: {answer}"
        );
        assert!(
            !answer.contains("ambient"),
            "the global helper was asked first: {answer}"
        );

        std::fs::remove_dir_all(&repo).ok();
    }
}
