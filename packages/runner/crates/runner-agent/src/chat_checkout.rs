//! How a confined chat session sees its checkout (`checkout` on `agent:start` / `agent:send`,
//! REQ-75 r5 BC-27), and the working copy a support room granted `build` works in.
//!
//! Core names the view per turn from the room's grant: `read` (the checkout, read-only), `none`
//! (an empty folder) or `build` (the room's own working copy of the development branch, which
//! the session writes). Absent, the checkout is writable, as every chat door was before. A view
//! this box cannot honour is refused by name before anything is spawned: a session never runs
//! with more of the checkout than its room was granted.

use std::path::{Path, PathBuf};

use runner_platform::git::non_interactive;
use tokio::process::Command;

use serde::Deserialize;

use crate::CheckoutView;

/// The tag every refusal here carries, so core and an operator can find it in a failed turn.
const TAG: &str = "[CHAT_CHECKOUT_MODE]";

/// The fields a turn frame names its view with: `checkout` (`read`, `none`, `build` or `own`;
/// absent, the writable checkout), for `build` and `own` the branch `buildBase` and the copy's key
/// `buildKey`, and for `own` the hosts `ownHosts` its git and `gh` reach.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ViewFields {
    #[serde(default)]
    pub checkout: Option<String>,
    #[serde(default)]
    pub build_base: Option<String>,
    #[serde(default)]
    pub build_key: Option<String>,
    #[serde(default)]
    pub own_hosts: Option<Vec<String>>,
}

impl ViewFields {
    pub(crate) fn view(&self, confined: bool) -> Result<CheckoutView, String> {
        let view = view_of(
            self.checkout.as_deref(),
            self.build_base.as_deref(),
            self.build_key.as_deref(),
            confined,
        )?;
        Ok(match view {
            CheckoutView::Own { key, base, .. } => CheckoutView::Own {
                key,
                base,
                hosts: self.own_hosts.clone().unwrap_or_default(),
            },
            other => other,
        })
    }
}

/// The view a turn runs under and the directory it runs in: the checkout, or for `build` the
/// room's working copy, made the first time.
pub(crate) async fn resolve(
    fields: &ViewFields,
    confined: bool,
    repo_path: String,
) -> Result<(CheckoutView, String), String> {
    match fields.view(confined)? {
        CheckoutView::Build { key, base } => {
            let base_dir = runner_platform::config::base_dir().map_err(|e| {
                format!("{TAG} this box cannot name the folder its working copies live in: {e}")
            })?;
            let dir = ensure_working_copy(Path::new(&repo_path), &base_dir, &key, &base).await?;
            Ok((
                CheckoutView::Build { key, base },
                dir.to_string_lossy().into_owned(),
            ))
        }
        CheckoutView::Own { key, base, hosts } => {
            let base_dir = runner_platform::config::base_dir().map_err(|e| {
                format!("{TAG} this box cannot name the folder its own clones live in: {e}")
            })?;
            let dir = ensure_own_clone(Path::new(&repo_path), &base_dir, &key, &base).await?;
            Ok((
                CheckoutView::Own { key, base, hosts },
                dir.to_string_lossy().into_owned(),
            ))
        }
        view => Ok((view, repo_path)),
    }
}

/// [`resolve`], with a view this box cannot honour failing the turn by name: `None`, and nothing
/// is spawned with more of the checkout than the room was granted.
pub(crate) async fn turn_view(
    client: &runner_transport::CoreClient,
    session_id: &str,
    view: &ViewFields,
    confined: bool,
    repo_path: String,
) -> Option<(CheckoutView, String)> {
    match resolve(view, confined, repo_path).await {
        Ok(found) => Some(found),
        Err(msg) => {
            tracing::error!("[chat {session_id}] {msg}");
            crate::chat::patch_failed(client, session_id, None, &msg).await;
            None
        }
    }
}

/// The view a turn names, or why it cannot be honoured. `confined` is the turn's own flag: the
/// views exist only inside a sandbox, so a turn outside one naming a view is refused, never run
/// with the box's whole view.
pub(crate) fn view_of(
    checkout: Option<&str>,
    build_base: Option<&str>,
    build_key: Option<&str>,
    confined: bool,
) -> Result<CheckoutView, String> {
    let Some(mode) = checkout else {
        return Ok(CheckoutView::Write);
    };
    if !confined {
        return Err(format!(
            "{TAG} this turn names the checkout view `{mode}` and is not confined; a view is a \
             sandbox's mounts, so an unconfined session would see the whole checkout instead"
        ));
    }
    match mode {
        "read" => Ok(CheckoutView::Read),
        "none" => Ok(CheckoutView::None),
        "build" | "own" => {
            let key = build_key.unwrap_or_default();
            if !valid_key(key) {
                return Err(format!(
                    "{TAG} a `{mode}` view names its working copy by `buildKey`, letters, \
                     digits and - (1 to 64); this turn sent {key:?}"
                ));
            }
            let base = build_base.unwrap_or_default();
            if let Some(why) = branch_refusal(base) {
                return Err(format!("{TAG} a `{mode}` view's `buildBase`: {why}"));
            }
            let (key, base) = (key.to_string(), base.to_string());
            Ok(if mode == "own" {
                CheckoutView::Own {
                    key,
                    base,
                    hosts: Vec::new(),
                }
            } else {
                CheckoutView::Build { key, base }
            })
        }
        other => Err(format!(
            "{TAG} `{other}` is not a checkout view this box knows; it shows `read`, `none`, \
             `build` or `own`, or the writable checkout when none is named"
        )),
    }
}

fn valid_key(key: &str) -> bool {
    (1..=64).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Why `branch` is not a branch name this box passes to git, or `None`.
pub(crate) fn branch_refusal(branch: &str) -> Option<String> {
    let bad = branch.is_empty()
        || branch.len() > 200
        || branch.starts_with('-')
        || branch.starts_with('/')
        || branch.ends_with('/')
        || branch.ends_with(".lock")
        || branch.contains("..")
        || branch.contains("@{")
        || branch
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "~^:?*[\\".contains(c));
    bad.then(|| format!("{branch:?} is not a branch name this box will pass to git"))
}

/// Where the working copy kept under `key` lives on this box.
pub fn working_copy(base_dir: &Path, key: &str) -> PathBuf {
    base_dir.join("support-builds").join(key)
}

/// The room's working copy, made from `repo`'s `origin/<base>` the first time a turn needs it.
/// One already there is left as it is: the session's edits, and the branch an earlier build
/// pushed, live in it.
pub(crate) async fn ensure_working_copy(
    repo: &Path,
    base_dir: &Path,
    key: &str,
    base: &str,
) -> Result<PathBuf, String> {
    let path = working_copy(base_dir, key);
    if path.join(".git").exists() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "{TAG} the working copies' folder {} could not be made: {e}",
                parent.display()
            )
        })?;
    }
    git(repo, &["fetch", "origin", base]).await.map_err(|e| {
        format!(
            "{TAG} origin/{base} could not be fetched into {}: {e}",
            repo.display()
        )
    })?;
    let remote = format!("origin/{base}");
    let at = path.to_string_lossy().into_owned();
    git(repo, &["worktree", "add", "--detach", &at, &remote])
        .await
        .map_err(|e| format!("{TAG} the working copy {at} could not be made from {remote}: {e}"))?;
    Ok(path)
}

/// Where an owner-mode agent's own clone kept under `key` lives on this box.
pub fn own_clone(base_dir: &Path, key: &str) -> PathBuf {
    base_dir.join("owner-copies").join(key)
}

/// An owner-mode agent's own clone of `repo`'s `origin/<base>`, made the first time a turn needs
/// it (ISS-765): a standalone repository, its own git directory and objects, whose `origin` is
/// the checkout's, so nothing the session writes in it reaches the checkout's git directory. This
/// box runs git in it only here, before the session has written anything; one already there is
/// left as it is, the session's branches and commits in it.
pub(crate) async fn ensure_own_clone(
    repo: &Path,
    base_dir: &Path,
    key: &str,
    base: &str,
) -> Result<PathBuf, String> {
    let path = own_clone(base_dir, key);
    if path.join(".git").exists() {
        return Ok(path);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            format!(
                "{TAG} the own clones' folder {} could not be made: {e}",
                parent.display()
            )
        })?;
    }
    git(repo, &["fetch", "origin", base]).await.map_err(|e| {
        format!(
            "{TAG} origin/{base} could not be fetched into {}: {e}",
            repo.display()
        )
    })?;
    let origin = git(repo, &["remote", "get-url", "origin"])
        .await
        .map_err(|e| format!("{TAG} the checkout {} names no origin: {e}", repo.display()))?;
    let at = path.to_string_lossy().into_owned();
    let from = repo.to_string_lossy().into_owned();
    git(
        base_dir,
        &["clone", "--no-hardlinks", "--no-checkout", "--", &from, &at],
    )
    .await
    .map_err(|e| format!("{TAG} the own clone {at} could not be made: {e}"))?;
    let tracking = format!("+refs/remotes/origin/{base}:refs/remotes/origin/{base}");
    let made = async {
        git(&path, &["remote", "set-url", "origin", &origin]).await?;
        git(&path, &["fetch", "--no-tags", &from, &tracking]).await?;
        git(
            &path,
            &[
                "checkout",
                "-B",
                base,
                &format!("refs/remotes/origin/{base}"),
            ],
        )
        .await?;
        git(
            &path,
            &["branch", &format!("--set-upstream-to=origin/{base}")],
        )
        .await
    }
    .await;
    if let Err(e) = made {
        // half a clone is never handed to a session: the next turn makes it again
        let _ = std::fs::remove_dir_all(&path);
        return Err(format!(
            "{TAG} the own clone {at} could not be set to origin/{base}: {e}"
        ));
    }
    Ok(path)
}

/// Run git in `dir`, non-interactively; the trimmed stdout, or the stderr of a failure.
pub(crate) async fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    non_interactive(cmd.arg("-C").arg(dir).args(args));
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("git could not run: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(format!(
            "git {} failed: {}",
            args.first().copied().unwrap_or(""),
            err.trim().chars().take(400).collect::<String>()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_view_named_is_the_writable_checkout_every_chat_door_had() {
        assert_eq!(view_of(None, None, None, true), Ok(CheckoutView::Write));
        assert_eq!(view_of(None, None, None, false), Ok(CheckoutView::Write));
    }

    #[test]
    fn read_and_none_are_honoured_confined_and_refused_unconfined() {
        assert_eq!(
            view_of(Some("read"), None, None, true),
            Ok(CheckoutView::Read)
        );
        assert_eq!(
            view_of(Some("none"), None, None, true),
            Ok(CheckoutView::None)
        );
        let err = view_of(Some("read"), None, None, false).unwrap_err();
        assert!(
            err.starts_with(TAG) && err.contains("not confined"),
            "{err}"
        );
    }

    #[test]
    fn an_unknown_view_is_refused_by_name() {
        let err = view_of(Some("everything"), None, None, true).unwrap_err();
        assert!(
            err.starts_with(TAG) && err.contains("`everything`"),
            "{err}"
        );
    }

    #[test]
    fn a_build_view_needs_its_key_and_a_base_git_would_take() {
        assert_eq!(
            view_of(Some("build"), Some("dev"), Some("room-1"), true),
            Ok(CheckoutView::Build {
                key: "room-1".into(),
                base: "dev".into()
            })
        );
        for (base, key) in [
            (Some("dev"), None),
            (Some("dev"), Some("../escape")),
            (None, Some("room-1")),
            (Some("-c core.sshCommand=x"), Some("room-1")),
            (Some("a..b"), Some("room-1")),
        ] {
            let err = view_of(Some("build"), base, key, true).unwrap_err();
            assert!(err.starts_with(TAG), "{base:?} {key:?}: {err}");
        }
    }

    #[test]
    fn an_own_view_needs_its_key_and_base_and_carries_the_hosts_core_named() {
        let fields = ViewFields {
            checkout: Some("own".into()),
            build_base: Some("dev".into()),
            build_key: Some("own-b1".into()),
            own_hosts: Some(vec!["https://github.com".into()]),
        };
        assert_eq!(
            fields.view(true),
            Ok(CheckoutView::Own {
                key: "own-b1".into(),
                base: "dev".into(),
                hosts: vec!["https://github.com".into()],
            })
        );
        let err = fields.view(false).unwrap_err();
        assert!(err.starts_with(TAG) && err.contains("`own`"), "{err}");
        for (base, key) in [
            (Some("dev"), None),
            (None, Some("own-b1")),
            (Some("a..b"), Some("own-b1")),
        ] {
            let err = view_of(Some("own"), base, key, true).unwrap_err();
            assert!(
                err.starts_with(TAG) && err.contains("`own`"),
                "{base:?} {key:?}: {err}"
            );
        }
    }

    /// An owner-mode agent's own clone (ISS-765) is a repository of its own: its git directory is
    /// not the checkout's, its `origin` is the checkout's origin, its branch tracks `origin/<base>`,
    /// and a second turn keeps what the session wrote in it.
    #[tokio::test]
    async fn an_own_clone_is_a_standalone_repository_of_origin_made_once() {
        let t = crate::chat_checkout_test_repo::Repos::new();
        let base_dir = t.root.join("base");
        let path = ensure_own_clone(&t.clone, &base_dir, "own-b1", "dev")
            .await
            .expect("the own clone was not made");
        assert_eq!(path, own_clone(&base_dir, "own-b1"));
        assert!(path.join("README").is_file(), "the own clone is empty");
        assert!(
            path.join(".git").is_dir(),
            "the own clone's git directory is not its own"
        );
        let common = t.git(
            &path,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
        );
        assert_eq!(PathBuf::from(common), path.join(".git"));
        assert_eq!(
            t.git(&path, &["remote", "get-url", "origin"]),
            t.origin.to_string_lossy(),
            "the own clone's origin is not the checkout's origin"
        );
        assert_eq!(
            t.git(&path, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/dev"
        );
        std::fs::write(path.join("edit.txt"), "kept").unwrap();
        let again = ensure_own_clone(&t.clone, &base_dir, "own-b1", "dev")
            .await
            .unwrap();
        assert!(
            again.join("edit.txt").is_file(),
            "a second turn remade the own clone"
        );
        let missing = ensure_own_clone(&t.clone, &base_dir, "own-b2", "no-such-branch")
            .await
            .unwrap_err();
        assert!(missing.starts_with(TAG), "{missing}");
        assert!(
            !own_clone(&base_dir, "own-b2").exists(),
            "a failed own clone was left half made"
        );
    }

    #[test]
    fn the_working_copy_sits_under_the_boxs_own_folder_by_key() {
        assert_eq!(
            working_copy(Path::new("/b"), "room-1"),
            PathBuf::from("/b/support-builds/room-1")
        );
    }

    #[tokio::test]
    async fn a_working_copy_is_made_from_origin_once_and_then_kept() {
        let t = crate::chat_checkout_test_repo::Repos::new();
        let base_dir = t.root.join("base");
        let path = ensure_working_copy(&t.clone, &base_dir, "room-1", "dev")
            .await
            .expect("the working copy was not made");
        assert!(path.join("README").is_file(), "the working copy is empty");
        std::fs::write(path.join("edit.txt"), "kept").unwrap();
        let again = ensure_working_copy(&t.clone, &base_dir, "room-1", "dev")
            .await
            .unwrap();
        assert_eq!(again, path);
        assert!(
            again.join("edit.txt").is_file(),
            "a second turn remade the working copy and lost the session's edit"
        );
    }
}
