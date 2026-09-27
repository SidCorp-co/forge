//! The publish check authenticates as the repository is configured to push, and
//! not as whatever the process that started the daemon was carrying.
//!
//! This has to be its own test binary. The thing under test is an environment
//! variable's precedence over a repository's configuration, and a test that set
//! `GIT_SSH_COMMAND` inside the library's own suite would set it for every other
//! test sharing that process. One process, one test, one variable.
//!
//! The transport is a shell script standing in for `ssh`: git runs
//! `$GIT_SSH_COMMAND <options> <host> <remote command>`, so a script that reads
//! the `-i` it was given and either execs the remote command or refuses is a
//! complete remote that needs no network, no daemon and no key pair. Its refusal
//! is worded as OpenSSH words it, because `salvage::stderr_brief` keeps the first
//! line of stderr and that line is what reached a person on `sid-xeon-1`:
//! `git@gitlab.com: Permission denied (publickey).` (ISS-1250).
//!
//! The control assertion is the point of the fixture. A `git fetch` spawned with
//! the ambient environment MUST come back refused: without it, a fetch that
//! succeeds proves nothing about which credential decided, and this file would
//! be green against the very code it was written to fail.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::process::Command;

use forge_runner_core::test_scratch::Scratch;
use forge_runner_core::workspace::repo_cred::RepoCred;
use forge_runner_core::workspace::salvage::{
    publication_of, publish, salvage_wip, Outcome, Publication, SalvageInput,
};

const DENIAL: &str = "Permission denied (publickey).";

#[test]
fn the_repositorys_own_credential_decides_the_publish_check_not_an_inherited_one() {
    let scratch = Scratch::new("pubcred");
    let root = scratch.path();

    let ssh = fake_ssh(root);
    let right = root.join("right-key");
    let wrong = root.join("wrong-key");
    std::fs::write(&right, "right\n").expect("key");
    std::fs::write(&wrong, "wrong\n").expect("key");
    // The fake transport accepts exactly the key with a marker beside it.
    std::fs::write(root.join("right-key.allowed"), "").expect("marker");

    let remote = root.join("remote.git");
    std::fs::create_dir_all(&remote).expect("remote");
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);

    let work = a_checkout(root, "work", &remote, &ssh, &right);

    // The daemon's own shape: a variable in the environment it was started with.
    std::env::set_var(
        "GIT_SSH_COMMAND",
        format!("{} -i {}", ssh.display(), wrong.display()),
    );

    let control = fetch_inheriting_the_environment(&work);
    assert!(
        control.contains(DENIAL),
        "the fixture cannot prove anything unless an inherited GIT_SSH_COMMAND really does \
         displace the repository's core.sshCommand — this fetch was supposed to be refused, and \
         git said: {control}"
    );

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");

    let cred = rt.block_on(RepoCred::of(None, &work));
    let seen = rt.block_on(publication_of(&work, &cred));
    assert_eq!(
        seen,
        Publication::Published,
        "the check must offer the credential the repository is configured to push with; it \
         offered {} and got {seen:?}",
        cred.source()
    );

    // The other half of the same rule: a check that IS refused says which
    // credential it offered, so the next occurrence is decidable from the log.
    let mis = a_checkout(root, "misconfigured", &remote, &ssh, &wrong);
    let mis_cred = rt.block_on(RepoCred::of(None, &mis));
    let refused = rt.block_on(publication_of(&mis, &mis_cred));
    let Publication::Unknown { why } = refused else {
        panic!("a remote that refuses the configured key cannot answer published: {refused:?}");
    };
    assert!(
        why.contains(DENIAL),
        "the refusal itself must survive into the reason: {why}"
    );
    assert!(
        why.contains(&wrong.display().to_string()),
        "a refusal that does not name the credential it offered is why this issue could not be \
         diagnosed from outside the process: {why}"
    );

    // The check and the push are the same claim, so they answer to the same
    // credential: a check that authenticates differently from the push it is
    // reasoning about is not a check.
    std::fs::write(work.join("b.txt"), "b\n").expect("file");
    git(&work, &["add", "b.txt"]);
    git(&work, &["commit", "-qm", "more"]);
    let after = rt.block_on(publish(&work, "main", &cred));
    assert_eq!(
        after,
        Publication::Published,
        "the push that publishes a held checkout's branch offered {} and did not land",
        cred.source()
    );

    // And so does the push a failed job's salvage makes.
    let (repo_root, dirty) = a_repo_with_a_dirty_worktree(root, &remote, &ssh, &right);
    let salvage_cred = rt.block_on(RepoCred::of(None, &dirty));
    let saved = rt.block_on(salvage_wip(SalvageInput {
        repo_root: &repo_root,
        base_branch: Some("main"),
        agent_branch: "ISS-1-x",
        job_id: "job-1",
        attempt: 0,
        failure: "spend limit",
        cred: &salvage_cred,
    }));
    assert_eq!(
        saved.outcome,
        Outcome::Pushed,
        "a salvage that commits and cannot push leaves the work on one box; it offered {} and \
         answered {:?}",
        salvage_cred.source(),
        saved.detail
    );
}

/// The shape a failed code job leaves: a repository with a linked worktree on
/// the agent's branch holding an uncommitted change, reachable only over the
/// fake transport.
fn a_repo_with_a_dirty_worktree(
    root: &Path,
    remote: &Path,
    ssh: &Path,
    key: &Path,
) -> (PathBuf, PathBuf) {
    let repo = a_checkout(root, "salvage-root", remote, ssh, key);
    let wt = repo.join(".claude").join("worktrees").join("iss-1");
    std::fs::create_dir_all(wt.parent().expect("parent")).expect("mkdir");
    git(
        &repo,
        &["worktree", "add", &wt.to_string_lossy(), "-b", "ISS-1-x"],
    );
    std::fs::write(wt.join("work.txt"), "unsaved\n").expect("file");
    (repo, wt)
}

/// A checkout of the bare remote, reached only over the fake transport, pinned
/// by its own `core.sshCommand` to one key.
fn a_checkout(root: &Path, name: &str, remote: &Path, ssh: &Path, key: &Path) -> PathBuf {
    let work = root.join(name);
    std::fs::create_dir_all(&work).expect("work");
    git(&work, &["init", "-q", "-b", "main"]);
    git(&work, &["config", "user.email", "t@t"]);
    git(&work, &["config", "user.name", "t"]);
    git(
        &work,
        &[
            "config",
            "core.sshCommand",
            &format!("{} -i {}", ssh.display(), key.display()),
        ],
    );
    std::fs::write(work.join("a.txt"), "a\n").expect("file");
    git(&work, &["add", "a.txt"]);
    git(&work, &["commit", "-qm", "base"]);
    git(
        &work,
        &[
            "remote",
            "add",
            "origin",
            &format!("ssh://git@fake{}", remote.display()),
        ],
    );
    // Publish from the checkout that holds the right key; the misconfigured one
    // is created after that push and its HEAD is the same commit.
    let _ = Command::new("git")
        .args(["push", "-q", "origin", "HEAD:refs/heads/main"])
        .current_dir(&work)
        .output();
    work
}

fn fake_ssh(root: &Path) -> PathBuf {
    let path = root.join("fake-ssh");
    std::fs::write(
        &path,
        "#!/bin/sh\n\
         key=\"\"; prev=\"\"; cmd=\"\"\n\
         for a in \"$@\"; do\n\
         \tif [ \"$prev\" = \"-i\" ]; then key=\"$a\"; fi\n\
         \tprev=\"$a\"; cmd=\"$a\"\n\
         done\n\
         if [ ! -f \"$key.allowed\" ]; then\n\
         \techo \"git@fake: Permission denied (publickey).\" >&2\n\
         \texit 255\n\
         fi\n\
         exec sh -c \"$cmd\"\n",
    )
    .expect("script");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("mode");
    path
}

fn fetch_inheriting_the_environment(work: &Path) -> String {
    let out = Command::new("git")
        .args(["fetch", "--prune", "--quiet", "--all"])
        .current_dir(work)
        .output()
        .expect("git");
    String::from_utf8_lossy(&out.stderr).into_owned()
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .output()
        .expect("git");
    assert!(
        out.status.success(),
        "git {args:?} in {}: {}",
        dir.display(),
        String::from_utf8_lossy(&out.stderr)
    );
}
