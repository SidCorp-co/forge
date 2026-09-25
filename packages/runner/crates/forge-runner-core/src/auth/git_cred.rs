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
/// checkout resolves its credential the same way the clone did.
pub fn set_repo_credential_helper(repo_path: &std::path::Path, host: &str) {
    let key = format!("credential.https://{host}.helper");
    let args = credential_helper_git_args(host);
    let Some(helper_value) = args
        .get(3)
        .and_then(|v| v.split_once('=').map(|(_, v)| v.to_string()))
    else {
        tracing::error!(
            "[provision] no program could be named for {host}'s credential helper, so {}'s git config is left as it is — an empty helper would refuse every fetch and push in it",
            repo_path.display()
        );
        return;
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

    /// The helper goes into a checkout's own `.git/config` and outlives the
    /// daemon that wrote it, so the one thing it may never name is a path that
    /// was true only while one process lived (ISS-1200).
    #[test]
    fn the_helper_names_a_program_that_can_actually_be_run() {
        let args = credential_helper_git_args("github.com");
        let helper = args[3].split_once("helper=!").expect("the helper clause").1;
        let program = helper
            .strip_suffix(" git-credential")
            .expect("the verb the helper invokes")
            .trim_matches('\'')
            .replace(r"'\''", "'");
        assert!(
            crate::exe::is_runnable(std::path::Path::new(&program)),
            "the helper names {program:?}, which nothing on this box can run"
        );
        assert!(
            !program.ends_with(crate::exe::DELETED_SUFFIX),
            "the kernel's annotation was persisted into a checkout: {program:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_runner_under_a_path_this_cannot_write_gets_no_helper_at_all() {
        use std::os::unix::ffi::OsStrExt;

        let path = std::path::PathBuf::from(std::ffi::OsStr::from_bytes(b"/opt/forge-\xff-runner"));
        let got = helper_from(Ok(crate::exe::OwnExe {
            path: path.clone(),
            replaced_from: None,
        }));
        assert_eq!(
            got, None,
            "display() renders those bytes as U+FFFD, and a helper carrying that names a file nothing can run"
        );
    }

    #[test]
    fn a_runner_this_can_write_is_named_exactly_as_it_stands() {
        let path = std::path::PathBuf::from("/opt/Forge Runner/forge-runner");
        let got = helper_from(Ok(crate::exe::OwnExe {
            path: path.clone(),
            replaced_from: None,
        }));
        assert_eq!(got.as_deref(), Some("/opt/Forge Runner/forge-runner"));
    }

    #[test]
    fn a_path_with_a_space_survives_the_shell() {
        assert_eq!(
            shell_quote("/opt/my runner/forge"),
            "'/opt/my runner/forge'"
        );
    }

    fn tmp_repo(tag: &str) -> crate::test_scratch::Scratch {
        let dir = crate::test_scratch::Scratch::new(&format!("gitcred-{tag}"));
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
    }

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
    }
}
