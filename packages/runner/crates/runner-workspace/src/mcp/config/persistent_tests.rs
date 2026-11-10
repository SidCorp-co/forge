//! [`write_persistent`] against a checkout's git: a tracked `.mcp.json` is never handed the
//! credential (ISS-1193), and an untracked one or a folder outside git is written as before.

use super::*;
use std::process::Command;

const FAKE_TOKEN: &str = "fake-iss1193-token";
const CORE: &str = "https://core.example";

/// A scratch folder removed when the test ends, however it ends.
struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(name: &str) -> Scratch {
    let dir = std::env::temp_dir().join(format!("forge-mcp-{name}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    Scratch(dir)
}

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap()
}

fn git_ok(dir: &Path, args: &[&str]) -> String {
    let out = git(dir, args);
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// What a checkout like gwork commits: OAuth servers, no secret.
const COMMITTED: &str = r#"{
  "mcpServers": {
    "linear": { "type": "http", "url": "https://mcp.linear.example/mcp" }
  }
}
"#;

fn repo_tracking_mcp_json(name: &str) -> Scratch {
    let repo = scratch(name);
    git_ok(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".mcp.json"), COMMITTED).unwrap();
    git_ok(&repo, &["add", "--", ".mcp.json"]);
    git_ok(&repo, &["commit", "-q", "-m", "servers"]);
    repo
}

#[test]
fn a_tracked_mcp_json_is_never_handed_the_credential() {
    let repo = repo_tracking_mcp_json("tracked");
    let got = write_persistent(&repo, CORE, "proj", Some(FAKE_TOKEN));

    let held = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
    assert!(
        !held.contains("Authorization") && !held.contains(FAKE_TOKEN),
        "the tracked .mcp.json now holds the credential, and the next `git commit -a` carries it: {held}"
    );
    assert_eq!(held, COMMITTED, "the tracked file was rewritten");
    assert_eq!(
        git_ok(&repo, &["status", "--porcelain"]),
        "",
        "the checkout is left dirty"
    );

    let err = got.expect_err("a tracked .mcp.json was reported written").to_string();
    assert!(err.contains(".mcp.json"), "the refusal names no file: {err}");
    assert!(err.contains("tracks"), "the refusal does not say why: {err}");
    assert!(
        err.contains("git rm --cached"),
        "the refusal names no way out: {err}"
    );
    assert!(!err.contains(FAKE_TOKEN), "the refusal carries the credential: {err}");
}

#[test]
fn a_tracked_mcp_json_under_skip_worktree_is_still_tracked() {
    let repo = repo_tracking_mcp_json("skip-worktree");
    git_ok(&repo, &["update-index", "--skip-worktree", "--", ".mcp.json"]);
    let got = write_persistent(&repo, CORE, "proj", Some(FAKE_TOKEN));
    let held = std::fs::read_to_string(repo.join(".mcp.json")).unwrap();
    assert!(
        !held.contains(FAKE_TOKEN),
        "a skip-worktree mark read as untracked, and the credential went in: {held}"
    );
    assert!(got.is_err(), "a tracked .mcp.json was reported written");
}

#[test]
fn an_untracked_mcp_json_is_written_and_excluded_as_before() {
    let repo = scratch("untracked");
    git_ok(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".mcp.json"), COMMITTED).unwrap();

    let got = write_persistent(&repo, CORE, "proj", Some(FAKE_TOKEN)).unwrap();
    assert_eq!(got, PersistentMcp::Written);
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(repo.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        doc["mcpServers"]["forge"]["headers"]["Authorization"],
        format!("Bearer {FAKE_TOKEN}")
    );
    assert_eq!(
        doc["mcpServers"]["linear"]["url"], "https://mcp.linear.example/mcp",
        "a server already declared was dropped"
    );
    assert_eq!(
        git_ok(&repo, &["status", "--porcelain"]),
        "",
        "the written .mcp.json is not ignored"
    );
}

#[test]
fn a_folder_outside_git_is_written_as_before() {
    let dir = scratch("no-git");
    let got = write_persistent(&dir, CORE, "proj", Some(FAKE_TOKEN)).unwrap();
    assert_eq!(got, PersistentMcp::Written);
    let doc: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
    assert_eq!(
        doc["mcpServers"]["forge"]["headers"]["Authorization"],
        format!("Bearer {FAKE_TOKEN}")
    );
}
