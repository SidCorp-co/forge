//! The box credential wired into git: the credential helper entries that send every HTTPS fetch
//! and push of a checkout to `forge-runner git-credential`.

use runner_platform::error::Result;

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
    helper_from(runner_platform::exe::own())
}

/// The same with the resolution handed in, so every arm is reachable from a
/// test while this process's own binary is present.
fn helper_from(own: Result<runner_platform::exe::OwnExe>) -> Option<String> {
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
        Err(e) => match runner_platform::exe::on_path("forge-runner") {
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

/// Whether `relay` is Forge's git relay URL for the repository an HTTPS `origin` names on its host:
/// `https://host/owner/repo` and `https://<core>/…/api/git/host/owner/repo.git` (REQ-73 BC-5). An
/// SSH or local origin is never relayed — the box reaches it with its own access.
pub fn relays_origin(origin: &str, relay: &str) -> bool {
    let Some((authority, path)) = origin
        .trim()
        .strip_prefix("https://")
        .and_then(|rest| rest.split_once('/'))
    else {
        return false;
    };
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    if host.is_empty() || !path.contains('/') {
        return false;
    }
    let relay = relay.trim().to_ascii_lowercase();
    let tail = format!("/api/git/{host}/{path}.git").to_ascii_lowercase();
    relay.starts_with("https://") && relay.ends_with(&tail)
}

/// Points a checkout whose origin still names the host itself at Forge's relay for the same
/// repository, since core hands no credential for that host directly once its binding is relayed.
/// `Ok(true)` when origin was moved; any other origin is left as it is.
pub fn point_origin_at_relay(
    repo_path: &std::path::Path,
    origin: Option<&str>,
    relay: &str,
) -> std::result::Result<bool, String> {
    if !origin.is_some_and(|o| relays_origin(o, relay)) {
        return Ok(false);
    }
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(repo_path)
        .args(["remote", "set-url", "origin", relay.trim()])
        .output()
        .map_err(|e| format!("spawn git remote set-url origin: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "git remote set-url origin {} in {} failed: {}",
            relay.trim(),
            repo_path.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(true)
}

/// Points a checkout whose origin is still its host at Forge's relay, and its credential helper at
/// Forge's host, so the box's next fetch asks core for a relay ticket rather than the host's token.
pub async fn reach_through_relay(slug: &str, repo: &std::path::Path, relay: Option<&str>) {
    let Some(relay) = relay else { return };
    let origin = runner_platform::git::origin_url(repo).await;
    let moved = match point_origin_at_relay(repo, origin.as_deref(), relay) {
        Ok(moved) => moved,
        Err(e) => return tracing::warn!("[relay] {slug}: {e}"),
    };
    if !moved {
        return;
    }
    let helped = https_host(relay)
        .ok_or_else(|| format!("{relay} is not HTTPS, so no credential helper answers for it"))
        .and_then(|host| set_repo_credential_helper(repo, &host));
    match helped {
        Ok(()) => tracing::info!(
            "[relay] {slug}: origin now reaches its repository through Forge ({relay})"
        ),
        Err(e) => tracing::warn!("[relay] {slug}: origin moved to {relay}, but {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELAY: &str = "https://forge.example/api/git/gitlab.com/acme/api.git";

    #[test]
    fn the_relay_of_the_same_repository_is_recognised_in_every_https_spelling() {
        for origin in [
            "https://gitlab.com/acme/api",
            "https://gitlab.com/acme/api.git",
            "https://oauth2:secret@gitlab.com/acme/api.git",
            "https://GitLab.com/Acme/API.git/",
        ] {
            assert!(relays_origin(origin, RELAY), "{origin}");
        }
        assert!(relays_origin(
            "https://gitlab.com/acme/api.git",
            "https://forge.example/base/api/git/gitlab.com/acme/api.git"
        ));
    }

    #[test]
    fn another_repository_transport_or_relay_scheme_is_left_alone() {
        for origin in [
            "https://gitlab.com/acme/other.git",
            "https://github.com/acme/api.git",
            "git@gitlab.com:acme/api.git",
            "ssh://git@gitlab.com/acme/api.git",
            "/srv/git/api.git",
            RELAY,
        ] {
            assert!(!relays_origin(origin, RELAY), "{origin}");
        }
        assert!(!relays_origin(
            "https://gitlab.com/acme/api.git",
            "http://forge.example/api/git/gitlab.com/acme/api.git"
        ));
    }

    #[test]
    fn a_checkout_on_the_host_is_moved_to_the_relay_and_only_that_one() {
        let dir = std::env::temp_dir().join(format!("forge-relay-origin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| {
            let o = std::process::Command::new("git")
                .arg("-C")
                .arg(&dir)
                .args(args)
                .output()
                .unwrap();
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        };
        git(&["init", "-q"]);
        git(&["remote", "add", "origin", "https://gitlab.com/acme/api.git"]);
        let origin = git(&["remote", "get-url", "origin"]);
        assert_eq!(point_origin_at_relay(&dir, Some(&origin), RELAY), Ok(true));
        assert_eq!(git(&["remote", "get-url", "origin"]), RELAY);
        // already the relay: nothing to move
        assert_eq!(point_origin_at_relay(&dir, Some(RELAY), RELAY), Ok(false));
        assert_eq!(point_origin_at_relay(&dir, None, RELAY), Ok(false));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
