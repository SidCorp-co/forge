//! `checkout.ancestry.read`: core asks this box whether commits are ancestors of others.
//!
//! A project with no source host binding is read through the checkout this box binds to it, so
//! core asks here whether the commit an issue's mark names is in a release it verified shipping,
//! and decides what to do with the answer. This only reads and reports: for each pair asked, what
//! `git merge-base --is-ancestor` said, or why it could not say. Ancestry between two commits the
//! checkout holds never changes, so origin is fetched only when a commit asked about is missing,
//! and the answer says whether it was.

use std::collections::BTreeSet;
use std::path::Path;
use std::time::Duration;

use runner_platform::clock;
use runner_platform::config::Config;
use runner_platform::git::{git, git_line, origin_url, strip_userinfo};
use runner_transport::CoreClient;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::process::Command;

use crate::checkout_frame::{serve, Channel, Frame};
use crate::head_read::{bound_checkout, rfc3339_utc};

/// Core waits thirty seconds for the answer; a fetch that has not finished well before that is
/// a failed read, never an answer core has stopped waiting for.
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
pub(crate) struct Pair {
    pub commit: String,
    pub release: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AncestryFrame {
    request_id: String,
    project_id: String,
    #[serde(default)]
    runner_id: Option<String>,
    #[serde(default)]
    repo_path: Option<String>,
    pairs: Vec<Pair>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Ancestor(bool),
    Unreadable(String),
}

#[derive(Debug)]
pub(crate) struct Reading {
    pub origin: String,
    pub fetched: bool,
    pub answers: Vec<(Pair, Verdict)>,
}

impl Frame for AncestryFrame {
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
        Channel::Ancestry,
        data,
        async |frame: &AncestryFrame| {
            let reading = answer(frame).await?;
            Ok(success_body(&frame.project_id, &reading, clock::now_secs()))
        },
    )
    .await;
}

fn success_body(project_id: &str, reading: &Reading, now: i64) -> Value {
    json!({
        "projectId": project_id,
        "origin": reading.origin,
        "readAt": rfc3339_utc(now),
        "via": "runner-checkout",
        "fetched": reading.fetched,
        "answers": reading.answers.iter().map(|(pair, verdict)| match verdict {
            Verdict::Ancestor(yes) => json!({ "commit": pair.commit, "release": pair.release, "ancestor": yes }),
            Verdict::Unreadable(why) => json!({ "commit": pair.commit, "release": pair.release, "error": strip_userinfo(why) }),
        }).collect::<Vec<_>>(),
    })
}

async fn answer(frame: &AncestryFrame) -> Result<Reading, String> {
    let cfg = Config::load().map_err(|e| format!("this box's config could not be read: {e}"))?;
    let repo = bound_checkout(&cfg.bindings, &frame.project_id, frame.repo_path.as_deref())?;
    read_ancestry(&repo, &frame.pairs).await
}

fn is_commit(sha: &str) -> bool {
    sha.len() == 40
        && sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

async fn holds(repo: &Path, sha: &str) -> bool {
    let object = format!("{sha}^{{commit}}");
    git(repo, &["cat-file", "-e", &object])
        .await
        .is_some_and(|out| out.status.success())
}

async fn fetch(repo: &Path, origin: &str) -> Result<(), String> {
    let mut cmd = Command::new("git");
    runner_platform::git::non_interactive(
        cmd.arg("-C").arg(repo).args(["fetch", "--quiet", "origin"]),
    );
    match tokio::time::timeout(FETCH_TIMEOUT, cmd.output()).await {
        Err(_) => Err(format!(
            "`git fetch origin` in {} ({origin}) did not finish within {}s",
            repo.display(),
            FETCH_TIMEOUT.as_secs()
        )),
        Ok(Err(e)) => Err(format!("git could not be run in {}: {e}", repo.display())),
        Ok(Ok(out)) if out.status.success() => Ok(()),
        Ok(Ok(out)) => Err(format!(
            "`git fetch origin` in {} ({origin}) failed: {}",
            repo.display(),
            tail(&out.stderr)
        )),
    }
}

fn tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let text = text.trim();
    let start = text.char_indices().rev().nth(299).map_or(0, |(i, _)| i);
    text[start..].to_string()
}

async fn is_ancestor(repo: &Path, pair: &Pair) -> Verdict {
    let Some(out) = git(
        repo,
        &["merge-base", "--is-ancestor", &pair.commit, &pair.release],
    )
    .await
    else {
        return Verdict::Unreadable(format!("git could not be run in {}", repo.display()));
    };
    match out.status.code() {
        Some(0) => Verdict::Ancestor(true),
        Some(1) => Verdict::Ancestor(false),
        _ => Verdict::Unreadable(format!(
            "`git merge-base --is-ancestor {} {}` failed: {}",
            pair.commit,
            pair.release,
            tail(&out.stderr)
        )),
    }
}

/// For each pair, whether `commit` is an ancestor of `release` in `repo`, after fetching origin if
/// either is missing. A commit still missing after that is unreadable for its pair, never a "no".
pub(crate) async fn read_ancestry(repo: &Path, pairs: &[Pair]) -> Result<Reading, String> {
    if let Some(bad) = pairs
        .iter()
        .flat_map(|p| [&p.commit, &p.release])
        .find(|sha| !is_commit(sha))
    {
        return Err(format!(
            "{bad:?} is not a 40-hex lowercase commit this box will pass to git"
        ));
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
    let shas: BTreeSet<&str> = pairs
        .iter()
        .flat_map(|p| [p.commit.as_str(), p.release.as_str()])
        .collect();
    let mut missing = BTreeSet::new();
    for sha in shas {
        if !holds(repo, sha).await {
            missing.insert(sha.to_string());
        }
    }
    let mut fetched = false;
    let mut fetch_failed = None;
    if !missing.is_empty() {
        match fetch(repo, &origin).await {
            Ok(()) => {
                fetched = true;
                let mut still = BTreeSet::new();
                for sha in &missing {
                    if !holds(repo, sha).await {
                        still.insert(sha.clone());
                    }
                }
                missing = still;
            }
            Err(why) => fetch_failed = Some(why),
        }
    }
    let mut answers = Vec::with_capacity(pairs.len());
    for pair in pairs {
        let absent: Vec<&str> = [&pair.commit, &pair.release]
            .into_iter()
            .filter(|sha| missing.contains(*sha))
            .map(String::as_str)
            .collect();
        let verdict = if absent.is_empty() {
            is_ancestor(repo, pair).await
        } else {
            let after = match &fetch_failed {
                Some(why) => format!("and the fetch that would bring it failed: {why}"),
                None => format!("even after fetching origin ({origin})"),
            };
            Verdict::Unreadable(format!(
                "the checkout {} holds no commit {} {after}",
                repo.display(),
                absent.join(" or ")
            ))
        };
        answers.push((pair.clone(), verdict));
    }
    Ok(Reading {
        origin,
        fetched,
        answers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
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

    fn commit(dir: &Path, n: &str) -> String {
        std::fs::write(dir.join("a"), n).unwrap();
        git(dir, &["add", "a"]);
        git(dir, &["commit", "-q", "-m", n]);
        git(dir, &["rev-parse", "HEAD"])
    }

    struct World {
        seed: PathBuf,
        bare: PathBuf,
        checkout: PathBuf,
        /// `one` <- `two` on dev, and `side` off `one` on a branch of its own.
        one: String,
        two: String,
        side: String,
    }

    fn world() -> World {
        let root = std::env::temp_dir().join(format!("forge-ancestry-{}", uuid::Uuid::new_v4()));
        let seed = root.join("seed");
        std::fs::create_dir_all(&seed).unwrap();
        git(&seed, &["init", "-q", "-b", "dev"]);
        let one = commit(&seed, "one");
        let two = commit(&seed, "two");
        git(&seed, &["checkout", "-q", "-b", "side", &one]);
        let side = commit(&seed, "side");
        git(&seed, &["checkout", "-q", "dev"]);
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
        World {
            seed,
            bare,
            checkout,
            one,
            two,
            side,
        }
    }

    fn pair(commit: &str, release: &str) -> Pair {
        Pair {
            commit: commit.to_string(),
            release: release.to_string(),
        }
    }

    #[tokio::test]
    async fn an_ancestor_is_yes_and_a_descendant_or_a_sibling_is_no() {
        let w = world();
        let reading = read_ancestry(
            &w.checkout,
            &[
                pair(&w.one, &w.two),
                pair(&w.two, &w.two),
                pair(&w.two, &w.one),
                pair(&w.side, &w.two),
            ],
        )
        .await
        .expect("read");
        let verdicts: Vec<_> = reading.answers.iter().map(|(_, v)| v).collect();
        assert_eq!(
            verdicts,
            vec![
                &Verdict::Ancestor(true),
                &Verdict::Ancestor(true),
                &Verdict::Ancestor(false),
                &Verdict::Ancestor(false),
            ]
        );
        assert!(
            !reading.fetched,
            "every commit was held, so nothing was fetched"
        );
        assert!(
            reading.origin.ends_with("remotes/repo.git"),
            "{}",
            reading.origin
        );
    }

    #[tokio::test]
    async fn a_commit_the_checkout_lacks_is_fetched_from_origin_and_then_answered() {
        let w = world();
        let three = commit(&w.seed, "three");
        git(&w.seed, &["push", "-q", w.bare.to_str().unwrap(), "dev"]);
        let reading = read_ancestry(&w.checkout, &[pair(&w.two, &three)])
            .await
            .expect("read");
        assert!(reading.fetched);
        assert_eq!(reading.answers[0].1, Verdict::Ancestor(true));
    }

    #[tokio::test]
    async fn a_commit_origin_does_not_hold_is_unreadable_never_a_no() {
        let w = world();
        let nowhere = "0123456789abcdef0123456789abcdef01234567";
        let reading = read_ancestry(&w.checkout, &[pair(nowhere, &w.two), pair(&w.one, &w.two)])
            .await
            .expect("read");
        assert!(reading.fetched);
        match &reading.answers[0].1 {
            Verdict::Unreadable(why) => {
                assert!(
                    why.contains(nowhere) && why.contains("even after fetching"),
                    "{why}"
                )
            }
            other => panic!("expected unreadable, read {other:?}"),
        }
        assert_eq!(reading.answers[1].1, Verdict::Ancestor(true));
    }

    #[tokio::test]
    async fn a_failed_fetch_is_named_on_the_pairs_it_left_unread() {
        let w = world();
        git(
            &w.checkout,
            &["remote", "set-url", "origin", "/nonexistent/forge/repo.git"],
        );
        let nowhere = "0123456789abcdef0123456789abcdef01234567";
        let reading = read_ancestry(&w.checkout, &[pair(nowhere, &w.two), pair(&w.one, &w.two)])
            .await
            .expect("read");
        assert!(!reading.fetched);
        match &reading.answers[0].1 {
            Verdict::Unreadable(why) => assert!(why.contains("fetch"), "{why}"),
            other => panic!("expected unreadable, read {other:?}"),
        }
        assert_eq!(reading.answers[1].1, Verdict::Ancestor(true));
    }

    #[tokio::test]
    async fn a_sha_git_could_read_as_an_option_or_a_ref_is_refused_before_git_runs() {
        let w = world();
        for bad in [
            "--output=/tmp/x",
            "HEAD",
            "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
            "",
        ] {
            let why = read_ancestry(&w.checkout, &[pair(bad, &w.two)])
                .await
                .unwrap_err();
            assert!(why.contains("40-hex"), "{bad}: {why}");
        }
    }

    #[tokio::test]
    async fn a_path_that_is_no_checkout_is_said() {
        let w = world();
        let gone = w.checkout.join("gone");
        let why = read_ancestry(&gone, &[pair(&w.one, &w.two)])
            .await
            .unwrap_err();
        assert!(why.contains("does not exist"), "{why}");
    }

    #[test]
    fn the_success_body_keeps_its_wire_shape() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let reading = Reading {
            origin: "https://host/org/repo.git".into(),
            fetched: true,
            answers: vec![
                (pair(&a, &b), Verdict::Ancestor(false)),
                (
                    pair(&b, &a),
                    Verdict::Unreadable("https://u:tok@host/x failed".into()),
                ),
            ],
        };
        assert_eq!(
            success_body("p-1", &reading, 1_818_633_600),
            json!({
                "projectId": "p-1",
                "origin": "https://host/org/repo.git",
                "readAt": "2027-08-19T00:00:00Z",
                "via": "runner-checkout",
                "fetched": true,
                "answers": [
                    { "commit": a, "release": b, "ancestor": false },
                    { "commit": b, "release": a, "error": "https://host/x failed" },
                ],
            })
        );
    }
}
