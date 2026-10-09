//! A preview's checkout cut, refused and seeded as the box does it, on real git repositories.

use super::*;

async fn sh(dir: &Path, script: &str) -> String {
    let out = Command::new("sh")
        .current_dir(dir)
        .args(["-c", script])
        .output()
        .await
        .expect("sh runs");
    assert!(
        out.status.success(),
        "{script}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// An origin with two commits and a checkout of it that holds only the first: the box's binding.
async fn world() -> (PathBuf, String, String) {
    let root = std::env::temp_dir().join(format!("forge-checkout-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let c = "-c user.email=a@b -c user.name=a";
    sh(&root, &format!("git init -q -b main origin && cd origin && echo one > a.txt && git add a.txt && git {c} commit -q -m one")).await;
    sh(&root, "git clone -q origin repo").await;
    let later = sh(
        &root,
        &format!(
            "cd origin && echo two >> a.txt && git {c} commit -q -am two && git rev-parse HEAD"
        ),
    )
    .await;
    let repo = root.join("repo").to_string_lossy().into_owned();
    (root, repo, later)
}

fn sketch(repo: &str, name: &str, branch: &str) -> Checkout {
    Checkout::Sketch {
        repo_path: repo.into(),
        path: format!("{repo}/.claude/worktrees/{name}"),
        branch: branch.into(),
        base: None,
    }
}

#[tokio::test]
async fn a_sketch_is_cut_on_its_own_branch_and_a_plain_push_is_refused() {
    let (root, repo, _) = world().await;
    let c = sketch(&repo, "sketch-fb-52-abcdef", "sketch/fb-52-abcdef");
    let at = cut(&c).await.expect("the sketch is cut");
    assert_eq!(
        sh(&at, "git rev-parse --abbrev-ref HEAD").await,
        "sketch/fb-52-abcdef"
    );
    let push = Command::new("git")
        .current_dir(&at)
        .args(["push"])
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .unwrap();
    assert!(!push.status.success(), "a sketch branch never pushes");
    assert!(
        String::from_utf8_lossy(&push.stderr).contains(NEVER_PUSHED),
        "{}",
        String::from_utf8_lossy(&push.stderr)
    );
    // a second start of the same preview takes the checkout as it stands
    assert_eq!(cut(&c).await.unwrap(), at);
    remove(&c).await;
    assert!(!at.exists(), "an abandoned sketch's checkout is removed");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_checkout_outside_the_bindings_worktrees_or_on_another_branch_is_refused() {
    let (root, repo, _) = world().await;
    let outside = Checkout::Sketch {
        repo_path: repo.clone(),
        path: format!("{repo}/../elsewhere"),
        branch: "sketch/fb-52-abcdef".into(),
        base: None,
    };
    let f = cut(&outside).await.unwrap_err();
    assert_eq!(f.reason, "WORKTREE_GONE");
    assert!(f.detail.contains(".claude/worktrees/"), "{}", f.detail);
    let nested = sketch(&repo, "a\\b", "sketch/fb-52-abcdef");
    assert_eq!(cut(&nested).await.unwrap_err().reason, "WORKTREE_GONE");
    let relative = sketch("repo", "sketch-fb-52-abcdef", "sketch/fb-52-abcdef");
    assert_eq!(cut(&relative).await.unwrap_err().reason, "WORKTREE_GONE");
    let main = sketch(&repo, "x", "main");
    assert!(cut(&main).await.unwrap_err().detail.contains("not sketch/"));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_reproduce_fetches_the_commit_the_box_lacks_and_checks_it_out_detached() {
    let (root, repo, later) = world().await;
    let c = Checkout::Reproduce {
        repo_path: repo.clone(),
        path: format!("{repo}/.claude/worktrees/reproduce-fb-52-abcdef"),
        sha: later.clone(),
    };
    let at = cut(&c).await.expect("the build is checked out");
    assert_eq!(sh(&at, "git rev-parse HEAD").await, later);
    assert_eq!(sh(&at, "cat a.txt").await, "one\ntwo");
    assert!(
        c.removed_on(Some("idle")),
        "a reproduce's checkout is the box's to remove"
    );
    remove(&c).await;
    assert!(!at.exists());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_commit_nobody_has_is_ref_not_found_with_gits_own_words() {
    let (root, repo, _) = world().await;
    let c = Checkout::Reproduce {
        repo_path: repo.clone(),
        path: format!("{repo}/.claude/worktrees/reproduce-fb-52-zzzzzz"),
        sha: "0d91ae7c74f70295ede115463b17559e650b5207".into(),
    };
    let f = cut(&c).await.unwrap_err();
    assert_eq!(f.reason, "REF_NOT_FOUND");
    assert!(f.detail.contains("cannot fetch 0d91ae7c"), "{}", f.detail);
    assert!(
        f.detail.contains("git fetch"),
        "git's output is carried: {}",
        f.detail
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn the_demo_seed_runs_in_the_checkout_with_its_environment_and_a_failing_one_is_named() {
    let (root, repo, _) = world().await;
    let mut env = serde_json::Map::new();
    env.insert("FORGE_ENVIRONMENT".into(), "demo".into());
    let dir = PathBuf::from(&repo);
    // the seed runs under the box's own shell: `sh -c` here, `cmd /C` on Windows
    let (writes, fails) = if cfg!(windows) {
        (
            "echo seeded-%FORGE_ENVIRONMENT%> seeded.txt",
            "echo no database 1>&2 & exit 3",
        )
    } else {
        (
            "echo seeded-$FORGE_ENVIRONMENT > seeded.txt",
            "echo no database >&2; exit 3",
        )
    };
    seed(&dir, writes, &env, Duration::from_secs(10))
        .await
        .expect("the seed runs");
    assert_eq!(sh(&dir, "cat seeded.txt").await, "seeded-demo");
    let f = seed(&dir, fails, &env, Duration::from_secs(10))
        .await
        .unwrap_err();
    assert_eq!(f.reason, "DEV_SERVER_EXITED");
    assert!(
        f.detail.contains("demo seed") && f.detail.contains("no database"),
        "{}",
        f.detail
    );
    let _ = std::fs::remove_dir_all(&root);
}
