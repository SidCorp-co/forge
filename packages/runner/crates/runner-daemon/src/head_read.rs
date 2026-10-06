//! `checkout.head.read`: core asks this box for a project's default-branch head.
//!
//! The runner is the one with git access to a project that has no source host
//! binding (an SSH key, or a bare repository on this disk), so core asks it
//! and decides what to do with the answer. This only reads and reports: the
//! sha `origin` holds for the branch, or why it could not be read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runner_platform::config::{Binding, Config};
use runner_platform::git::{git_line, origin_url, strip_userinfo};
use runner_transport::{checkout_head, CoreClient};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

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

pub(crate) async fn handle(client: &CoreClient, data: Value) {
    let frame: HeadReadFrame = match serde_json::from_value(data.clone()) {
        Ok(f) => f,
        Err(e) => return answer_undecodable(client, &data, &e).await,
    };
    let body = match answer(&frame.project_id, frame.repo_path.as_deref(), &frame.branch).await {
        Ok((sha, origin)) => json!({
            "projectId": frame.project_id,
            "sha": sha,
            "ref": format!("refs/heads/{}", frame.branch),
            "readAt": rfc3339_utc(runner_platform::clock::now_secs()),
            "via": "runner-checkout",
            "origin": strip_userinfo(&origin),
        }),
        Err(error) => {
            let error = strip_userinfo(&error);
            tracing::warn!(
                "[head] project={} runner={}: {error}",
                frame.project_id,
                frame.runner_id.as_deref().unwrap_or("-")
            );
            json!({ "projectId": frame.project_id, "error": error })
        }
    };
    post(client, &frame.request_id, &frame.project_id, &body).await;
}

async fn post(client: &CoreClient, request_id: &str, project_id: &str, body: &Value) {
    if let Err(e) = checkout_head::answer(client, request_id, body).await {
        tracing::warn!("[head] project={project_id}: the answer did not reach core: {e}");
    }
}

/// A frame this build cannot read is answered, naming what failed to decode, so core settles it
/// with that and not with its wait's "this runner is older than core". Only a frame without the
/// `requestId` and `projectId` an answer is filed under goes unanswered, and that is said here.
async fn answer_undecodable(client: &CoreClient, data: &Value, e: &serde_json::Error) {
    let field = |name: &str| data.get(name).and_then(Value::as_str).map(str::to_string);
    let (Some(request_id), Some(project_id)) = (field("requestId"), field("projectId")) else {
        tracing::warn!(
            "[head] undecodable checkout.head.read with no requestId and projectId to answer it under, so core waits it out: {e}"
        );
        return;
    };
    let error = format!(
        "the checkout.head.read frame could not be decoded by forge-runner {}: {e} — this core sends a frame this runner does not read",
        runner_update::CURRENT_VERSION
    );
    tracing::warn!("[head] project={project_id}: {error}");
    post(
        client,
        &request_id,
        &project_id,
        &json!({ "projectId": project_id, "error": error }),
    )
    .await;
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
fn bound_checkout(
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
fn rfc3339_utc(secs: i64) -> String {
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

    /// A fake core taking every POST, recording path and body.
    async fn fake_core() -> (
        CoreClient,
        std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    let n = sock.read(&mut chunk).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buf).to_string();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let len = head
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= len {
                            let path = head.split_whitespace().nth(1).unwrap_or("").to_string();
                            log.lock().unwrap().push((path, body.to_string()));
                            break;
                        }
                    }
                }
                let reply = "{\"settled\":true}";
                let head = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    reply.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(reply.as_bytes()).await;
                let _ = sock.shutdown().await;
            }
        });
        (CoreClient::new(format!("http://{addr}"), "token"), seen)
    }

    #[tokio::test]
    async fn an_undecodable_frame_is_answered_naming_the_field() {
        let (client, seen) = fake_core().await;
        handle(
            &client,
            json!({ "requestId": "r-1", "projectId": "p-1", "branch": null }),
        )
        .await;
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1, "one answer posted: {seen:?}");
        assert_eq!(seen[0].0, "/api/devices/me/checkout-heads/r-1");
        let body: Value = serde_json::from_str(&seen[0].1).unwrap();
        assert_eq!(body["projectId"], "p-1");
        let error = body["error"].as_str().unwrap_or_default();
        assert!(
            error.contains("could not be decoded") && error.contains("string"),
            "{error}"
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
