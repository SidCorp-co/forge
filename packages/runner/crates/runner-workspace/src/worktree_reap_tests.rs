//! The reaper over trees a run adopted and trees cut for one, against a real repository
//! (ISS-1016).

use super::*;
use runner_core::ledger::{CheckoutReturn, NewRun, TreeOrigin};

async fn git(dir: &Path, args: &[&str]) {
    let out = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .await
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A repository with an `origin`, and a clean tree under `.claude/worktrees/<name>` on a branch
/// of its own that `origin` holds: the shape the reaper takes once no run holds it.
async fn a_repo_with_pushed_trees(tag: &str, names: &[&str]) -> (PathBuf, PathBuf, Vec<PathBuf>) {
    let base = std::env::temp_dir().join(format!(
        "forge-reap-{tag}-{}-{}",
        std::process::id(),
        runner_core::agent_activity::now_ms()
    ));
    let (root, bare) = (base.join("repo"), base.join("origin.git"));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&bare).unwrap();
    git(&bare, &["init", "-q", "--bare", "-b", "main"]).await;
    git(&root, &["init", "-q", "-b", "main"]).await;
    git(&root, &["config", "user.email", "t@t"]).await;
    git(&root, &["config", "user.name", "t"]).await;
    std::fs::write(root.join("a.txt"), "a").unwrap();
    git(&root, &["add", "a.txt"]).await;
    git(&root, &["commit", "-q", "-m", "a"]).await;
    git(&root, &["remote", "add", "origin", &bare.to_string_lossy()]).await;
    git(&root, &["push", "-q", "origin", "main"]).await;
    let mut trees = Vec::new();
    for name in names {
        let wt = root.join(".claude/worktrees").join(name);
        git(
            &root,
            &["worktree", "add", "-q", "-b", name, &wt.to_string_lossy()],
        )
        .await;
        git(&wt, &["push", "-q", "origin", name]).await;
        trees.push(wt);
    }
    (base, root, trees)
}

/// A run declared over `wt`, closed by its master and released as `how`, as the sweep leaves it.
fn a_closed_run(
    led: &mut Ledger,
    run_id: &str,
    wt: &Path,
    origin: TreeOrigin,
    how: CheckoutReturn,
) {
    led.create_run_group(NewRun {
        run_id: run_id.into(),
        project_id: "proj-1".into(),
        master_session_id: format!("master-{run_id}"),
        worktree_path: wt.to_path_buf(),
        boot_id: "boot-1".into(),
        issue_keys: vec![format!("ISS-{run_id}")],
        role: None,
        requirement: None,
        worktree_origin: origin,
    })
    .unwrap();
    led.end_run(run_id, "master", "the master said so").unwrap();
    led.mark_checkout_returned_observed(run_id, how).unwrap();
}

/// FB-522's batch tree, read by the reaper once the run declared over it has ended: clean, pushed
/// and past any age, it is still never taken, because the run never took it. A tree cut for a run
/// whose release kept it over work since pushed is, in the same shape, still the reaper's.
#[tokio::test]
async fn the_reaper_never_takes_a_tree_a_run_adopted() {
    let (base, root, trees) =
        a_repo_with_pushed_trees("adopted", &["batch-iss-82", "left-behind"]).await;
    let (adopted, left) = (&trees[0], &trees[1]);
    let mut led = Ledger::open(&base.join("ledger.db")).unwrap();
    a_closed_run(
        &mut led,
        "1",
        adopted,
        TreeOrigin::Adopted,
        CheckoutReturn::AdoptedKept,
    );
    a_closed_run(
        &mut led,
        "2",
        left,
        TreeOrigin::Created,
        CheckoutReturn::KeptWithWork,
    );

    let held = HeldTrees::from_ledger(&led).unwrap();
    let reaped = reap_repo(&root, Duration::ZERO, &held).await;

    assert!(
        adopted.join("a.txt").exists(),
        "the reaper removed {}, a tree run 1 was declared over when it already stood",
        adopted.display()
    );
    assert!(
        reaped
            .held
            .iter()
            .any(|(p, run)| p == adopted && run == "1"),
        "{reaped:?}"
    );
    assert_eq!(reaped.removed, vec![left.clone()], "{reaped:?}");
    assert!(!left.exists(), "a tree nobody adopted is still reaped");
    let _ = std::fs::remove_dir_all(&base);
}
