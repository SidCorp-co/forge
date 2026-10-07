//! `checkout.head.read`: core asks this box for a project's default-branch head.
//!
//! The runner is the one with git access to a project that has no source host
//! binding (an SSH key, or a bare repository on this disk), so core asks it
//! and decides what to do with the answer. This only reads and reports: the
//! sha `origin` holds for the branch, or why it could not be read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runner_platform::clock;
use runner_platform::config::{Binding, Config};
use runner_platform::git::{git_line, origin_url, strip_userinfo};
use runner_transport::CoreClient;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::checkout_frame::{serve, Channel, Frame};

/// A remote that does not answer is a failed read, never a held frame.
const LS_REMOTE_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeadReadFrame {
    request_id: String,
    project_id: String,
    branch: String,
    /// The runner row core chose; logged so a refusal names the row it was asked through.
    #[serde(default)]
    runner_id: Option<String>,
    /// The checkout core names in its evidence: the one this box reads, never another binding.
    #[serde(default)]
    repo_path: Option<String>,
}

impl Frame for HeadReadFrame {
    fn request_id(&self) -> &str {
        &self.request_id
    }
    fn project_id(&self) -> &str {
        &self.project_id
    }
    fn runner_id(&self) -> Option<&str> {
        self.runner_id.as_deref()
    }
}

pub(crate) async fn handle(client: &CoreClient, data: Value) {
    serve(
        client,
        Channel::Head,
        data,
        async |frame: &HeadReadFrame| {
            let (sha, origin) =
                answer(&frame.project_id, frame.repo_path.as_deref(), &frame.branch).await?;
            Ok(success_body(
                &frame.project_id,
                &frame.branch,
                &sha,
                &origin,
                clock::now_secs(),
            ))
        },
    )
    .await;
}

fn success_body(project_id: &str, branch: &str, sha: &str, origin: &str, now: i64) -> Value {
    json!({
        "projectId": project_id,
        "sha": sha,
        "ref": format!("refs/heads/{branch}"),
        "readAt": rfc3339_utc(now),
        "via": "runner-checkout",
        "origin": strip_userinfo(origin),
    })
}

/// The binding is read from the config file now, not from the daemon's start:
/// a `forge-runner bind` or a provision since then is a binding this box holds.
async fn answer(
    project_id: &str,
    repo_path: Option<&str>,
    branch: &str,
) -> Result<(String, String), String> {
    let cfg = Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
    let repo = bound_checkout(&cfg.bindings, project_id, repo_path)?;
    read_head(&repo, branch).await
}

/// The checkout core named, as long as this box binds it to the project. With none named (a core
/// that predates naming it), only a project bound once here is unambiguous; anything else is said.
pub(crate) fn bound_checkout(
    bindings: &HashMap<String, Binding>,
    project_id: &str,
    repo_path: Option<&str>,
) -> Result<PathBuf, String> {
    let mut held: Vec<&Path> = bindings
        .values()
        .filter(|b| b.project_id.as_deref() == Some(project_id))
        .map(|b| b.repo_path.as_path())
        .collect();
    held.sort();
    let listed = || {
        held.iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    };
    if held.is_empty() {
        return Err(format!(
            "this box holds no checkout bound to project {project_id} — `forge-runner bind <slug> --path <checkout>` binds one"
        ));
    }
    match repo_path {
        Some(named) => held
            .iter()
            .find(|p| **p == Path::new(named))
            .map(|p| p.to_path_buf())
            .ok_or_else(|| {
                format!(
                    "core asked for the checkout {named}, which this box does not bind to project {project_id} (it binds {})",
                    listed()
                )
            }),
        None if held.len() == 1 => Ok(held[0].to_path_buf()),
        None => Err(format!(
            "core named no checkout to read and this box binds {} to project {project_id}, so which one it meant is not known — update forge-core",
            listed()
        )),
    }
}

fn branch_refusal(branch: &str) -> Option<String> {
    let bad = branch.is_empty()
        || branch.starts_with('-')
        || branch.contains("..")
        || branch.chars().any(|c| c.is_whitespace() || c.is_control())
        || branch.starts_with('/')
        || branch.ends_with('/');
    bad.then(|| format!("branch {branch:?} is not a branch name this box will pass to git"))
}

/// The sha `origin` holds for `refs/heads/<branch>`, and origin's URL as git resolves it.
pub(crate) async fn read_head(repo: &Path, branch: &str) -> Result<(String, String), String> {
    if let Some(why) = branch_refusal(branch) {
        return Err(why);
    }
    if !repo.exists() {
        return Err(format!(
            "the bound checkout {} does not exist",
            repo.display()
        ));
    }
    if git_line(repo, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        != Some("true")
    {
        return Err(format!(
            "the bound checkout {} is not a git work tree",
            repo.display()
        ));
    }
    let origin = origin_url(repo)
        .await
        .map(|url| strip_userinfo(&url))
        .ok_or_else(|| {
            format!(
                "the bound checkout {} has no `origin` remote",
                repo.display()
            )
        })?;
    let wanted = format!("refs/heads/{branch}");
    let mut ls = Command::new("git");
    runner_platform::git::non_interactive(ls.arg("-C").arg(repo).args([
        "ls-remote",
        "origin",
        "--",
        &wanted,
    ]));
    let out = match tokio::time::timeout(LS_REMOTE_TIMEOUT, ls.output()).await {
        Err(_) => {
            return Err(format!(
                "`git ls-remote origin` in {} ({origin}) did not answer within {}s",
                repo.display(),
                LS_REMOTE_TIMEOUT.as_secs()
            ))
        }
        Ok(Err(e)) => return Err(format!("git could not be run in {}: {e}", repo.display())),
        Ok(Ok(out)) => out,
    };
    if !out.status.success() {
        let tail: String = String::from_utf8_lossy(&out.stderr)
            .trim()
            .chars()
            .rev()
            .take(300)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!(
            "`git ls-remote origin` in {} ({origin}) failed: {tail}",
            repo.display()
        ));
    }
    parse_ls_remote(&String::from_utf8_lossy(&out.stdout), &wanted)
        .ok_or_else(|| format!("origin ({origin}) of {} holds no {wanted}", repo.display()))
        .map(|sha| (sha, origin))
}

fn parse_ls_remote(stdout: &str, wanted: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        let (sha, name) = line.split_once('\t')?;
        (name.trim() == wanted
            && sha.len() == 40
            && sha
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
        .then(|| sha.to_string())
    })
}

/// `YYYY-MM-DDTHH:MM:SSZ` for `secs` since the epoch.
pub(crate) fn rfc3339_utc(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    // civil_from_days (Howard Hinnant), the inverse of `clock::days_from_civil`.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .arg("-C")
            .arg(dir)
            .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
            .args(args)
            .env_remove("GIT_DIR")
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A clone whose origin is a local bare repository holding `dev` one commit ahead of the clone.
    fn clone_of_local_bare() -> (PathBuf, String) {
        let root = std::env::temp_dir().join(format!("forge-head-{}", uuid::Uuid::new_v4()));
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "dev"]);
        std::fs::write(seed.join("a"), "1").unwrap();
        git(&seed, &["add", "a"]);
        git(&seed, &["commit", "-q", "-m", "one"]);
        let bare = root.join("remotes/repo.git");
        git(
            &root,
            &[
                "clone",
                "-q",
                "--bare",
                seed.to_str().unwrap(),
                bare.to_str().unwrap(),
            ],
        );
        let checkout = root.join("repo");
        git(
            &root,
            &[
                "clone",
                "-q",
                bare.to_str().unwrap(),
                checkout.to_str().unwrap(),
            ],
        );
        std::fs::write(seed.join("a"), "2").unwrap();
        git(&seed, &["commit", "-q", "-am", "two"]);
        git(&seed, &["push", "-q", bare.to_str().unwrap(), "dev"]);
        let head = git(&seed, &["rev-parse", "HEAD"]);
        (checkout, head)
    }

    #[tokio::test]
    async fn the_head_is_read_from_the_checkouts_origin_not_its_local_branch() {
        let (checkout, head) = clone_of_local_bare();
        let (sha, origin) = read_head(&checkout, "dev").await.expect("read");
        assert_eq!(sha, head);
        assert!(origin.ends_with("remotes/repo.git"), "{origin}");
    }

    #[tokio::test]
    async fn a_branch_absent_at_origin_is_said() {
        let (checkout, _) = clone_of_local_bare();
        let why = read_head(&checkout, "main").await.unwrap_err();
        assert!(
            why.contains("refs/heads/main") && why.contains("origin"),
            "{why}"
        );
    }

    #[tokio::test]
    async fn a_branch_git_would_read_as_an_option_is_refused_before_git_runs() {
        let (checkout, _) = clone_of_local_bare();
        for bad in ["--upload-pack=x", "a b", "a..b", ""] {
            let why = read_head(&checkout, bad).await.unwrap_err();
            assert!(why.contains("branch"), "{bad}: {why}");
        }
    }

    #[tokio::test]
    async fn a_path_that_is_no_checkout_is_said() {
        let dir = std::env::temp_dir().join(format!("forge-head-none-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let why = read_head(&dir, "dev").await.unwrap_err();
        assert!(why.contains(&dir.display().to_string()), "{why}");
        let missing = dir.join("gone");
        let why = read_head(&missing, "dev").await.unwrap_err();
        assert!(why.contains("does not exist"), "{why}");
    }

    #[test]
    fn the_read_time_is_rfc3339_utc() {
        assert_eq!(rfc3339_utc(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_utc(1_818_633_600), "2027-08-19T00:00:00Z");
        assert_eq!(rfc3339_utc(951_782_400 + 3_661), "2000-02-29T01:01:01Z");
    }

    fn bound(entries: &[(&str, &str, &str)]) -> HashMap<String, Binding> {
        entries
            .iter()
            .map(|(slug, path, project)| {
                (
                    (*slug).to_string(),
                    Binding {
                        repo_path: PathBuf::from(path),
                        branch: None,
                        project_id: Some((*project).to_string()),
                    },
                )
            })
            .collect()
    }

    #[test]
    fn the_checkout_core_names_is_the_one_read() {
        let b = bound(&[
            ("a", "/w/old", "p"),
            ("b", "/w/epod", "p"),
            ("c", "/w/x", "q"),
        ]);
        assert_eq!(
            bound_checkout(&b, "p", Some("/w/epod")).unwrap(),
            PathBuf::from("/w/epod")
        );
        let why = bound_checkout(&b, "p", Some("/w/x")).unwrap_err();
        assert!(
            why.contains("/w/x") && why.contains("/w/epod, /w/old"),
            "{why}"
        );
    }

    #[test]
    fn with_no_checkout_named_only_a_single_binding_is_read() {
        let one = bound(&[("a", "/w/epod", "p")]);
        assert_eq!(
            bound_checkout(&one, "p", None).unwrap(),
            PathBuf::from("/w/epod")
        );
        let two = bound(&[("a", "/w/old", "p"), ("b", "/w/epod", "p")]);
        let why = bound_checkout(&two, "p", None).unwrap_err();
        assert!(why.contains("named no checkout"), "{why}");
        let why = bound_checkout(&one, "q", Some("/w/epod")).unwrap_err();
        assert!(why.contains("forge-runner bind"), "{why}");
    }

    const SECRET: &str = "ghp_planted0000000000000000000000000000";

    #[tokio::test]
    async fn a_credential_in_origin_never_leaves_the_box() {
        let (checkout, _) = clone_of_local_bare();
        let with_token = format!("https://x-access-token:{SECRET}@127.0.0.1:1/org/repo.git");
        git(&checkout, &["remote", "set-url", "origin", &with_token]);
        let why = read_head(&checkout, "dev").await.unwrap_err();
        assert!(!why.contains(SECRET), "{why}");
        assert!(why.contains("https://127.0.0.1:1/org/repo.git"), "{why}");
    }

    #[tokio::test]
    async fn origin_is_read_as_git_resolves_it_the_way_bind_reads_it() {
        let (checkout, head) = clone_of_local_bare();
        let bare = git(&checkout, &["config", "--get", "remote.origin.url"]);
        git(
            &checkout,
            &["remote", "set-url", "origin", "planted:repo.git"],
        );
        git(
            &checkout,
            &[
                "config",
                &format!("url.{}.insteadOf", bare.trim_end_matches("repo.git")),
                "planted:",
            ],
        );
        let (sha, origin) = read_head(&checkout, "dev").await.expect("read");
        assert_eq!(sha, head);
        assert_eq!(origin, bare, "origin as `git remote get-url` resolves it");
    }

    #[test]
    fn the_success_body_keeps_its_wire_shape() {
        let body = success_body(
            "p-1",
            "dev",
            "0123456789012345678901234567890123456789",
            &format!("https://x-access-token:{SECRET}@host/org/repo.git"),
            1_818_633_600,
        );
        assert_eq!(
            body,
            json!({
                "projectId": "p-1",
                "sha": "0123456789012345678901234567890123456789",
                "ref": "refs/heads/dev",
                "readAt": "2027-08-19T00:00:00Z",
                "via": "runner-checkout",
                "origin": "https://host/org/repo.git",
            })
        );
    }

    #[tokio::test]
    async fn a_checkout_with_no_origin_is_said() {
        let dir =
            std::env::temp_dir().join(format!("forge-head-noorigin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q"]);
        let why = read_head(&dir, "dev").await.unwrap_err();
        assert!(why.contains("origin"), "{why}");
    }
}
