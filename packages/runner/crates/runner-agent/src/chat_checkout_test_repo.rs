//! A bare `origin` holding `dev` and `master`, and a checkout cloned from it: what the working
//! copy and the build tests run against. Removed when dropped.

use std::path::{Path, PathBuf};
use std::process::Command;

pub(crate) struct Repos {
    pub root: PathBuf,
    pub origin: PathBuf,
    pub clone: PathBuf,
}

fn run(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("git did not run");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

impl Repos {
    pub fn new() -> Self {
        let root = std::env::temp_dir().join(format!("forge-build-test-{}", uuid::Uuid::new_v4()));
        let origin = root.join("origin.git");
        let seed = root.join("seed");
        let clone = root.join("clone");
        std::fs::create_dir_all(&seed).unwrap();
        run(&root, &["init", "--bare", "-b", "dev", "origin.git"]);
        run(&seed, &["init", "-b", "dev"]);
        run(&seed, &["config", "user.name", "Box Owner"]);
        run(&seed, &["config", "user.email", "box@example.test"]);
        std::fs::write(seed.join("README"), "hello\n").unwrap();
        run(&seed, &["add", "README"]);
        run(&seed, &["commit", "-m", "seed"]);
        run(
            &seed,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        run(&seed, &["push", "origin", "dev"]);
        run(&seed, &["push", "origin", "dev:master"]);
        run(
            &root,
            &["clone", "-b", "dev", origin.to_str().unwrap(), "clone"],
        );
        run(&clone, &["config", "user.name", "Box Owner"]);
        run(&clone, &["config", "user.email", "box@example.test"]);
        Self {
            root,
            origin,
            clone,
        }
    }

    /// The sha `origin` holds for `branch`, or `None`.
    pub fn origin_head(&self, branch: &str) -> Option<String> {
        let out = Command::new("git")
            .arg("-C")
            .arg(&self.origin)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .output()
            .ok()?;
        out.status
            .success()
            .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    pub fn git(&self, dir: &Path, args: &[&str]) -> String {
        run(dir, args)
    }
}

impl Drop for Repos {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}
