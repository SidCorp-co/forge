//! [`write_master_session`]: a master pane over a checkout whose git tracks `.mcp.json` is handed
//! the `forge` server in its session config, since the runner writes none into that file
//! (ISS-1193); over an untracked one, the session config is what core declares, as before.

use super::*;
use std::process::Command;

const FAKE_TOKEN: &str = "fake-iss1193-master-token";

struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch() -> Scratch {
    let dir = std::env::temp_dir().join(format!("forge-master-mcp-{}", uuid::Uuid::new_v4()));
    for sub in ["repo", "mcp", "master"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    Scratch(dir)
}

fn git(dir: &Path, args: &[&str]) {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["-c", "user.email=t@example.invalid", "-c", "user.name=t"])
        .args(["-c", "commit.gpgsign=false"])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {out:?}");
}

/// A checkout holding `.mcp.json` (committed where `tracked`), and the checkout credential the
/// provision left for its panes.
fn placed_over(s: &Scratch, mcp_json: &str, tracked: bool) -> PathBuf {
    let repo = s.0.join("repo");
    git(&repo, &["init", "-q"]);
    std::fs::write(repo.join(".mcp.json"), mcp_json).unwrap();
    if tracked {
        git(&repo, &["add", "--", ".mcp.json"]);
        git(&repo, &["commit", "-q", "-m", "servers"]);
    }
    let borrow = s.0.join("master").join("forge-cli.json");
    write_cli_borrow_at(&borrow, "https://core.example/", Some(FAKE_TOKEN)).unwrap();
    borrow
}

fn declared() -> serde_json::Map<String, Value> {
    let doc = serde_json::json!({ "linear": { "type": "http", "url": "https://mcp.linear.example/mcp" } });
    doc.as_object().unwrap().clone()
}

fn session_doc(path: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

const COMMITTED: &str =
    r#"{"mcpServers":{"linear":{"type":"http","url":"https://mcp.linear.example/mcp"}}}"#;

#[test]
fn a_master_over_a_tracked_mcp_json_is_handed_forge_in_its_session_config() {
    let s = scratch();
    let borrow = placed_over(&s, COMMITTED, true);
    let repo = s.0.join("repo");
    let path = write_master_session_in(&s.0.join("mcp"), Some(&borrow), &repo, "proj", &declared())
        .unwrap()
        .expect("no session config was written");
    let doc = session_doc(&path);
    let forge = &doc["mcpServers"]["forge"];
    assert!(
        forge.is_object(),
        "the master pane over a tracked .mcp.json carries no `forge` server: {doc}"
    );
    assert_eq!(forge["url"], "https://core.example/mcp");
    assert_eq!(
        forge["headers"]["Authorization"],
        format!("Bearer {FAKE_TOKEN}")
    );
    assert_eq!(forge["headers"]["X-Forge-Project-Slug"], "proj");
    assert!(
        doc["mcpServers"]["linear"].is_object(),
        "a declared server was dropped: {doc}"
    );

    let reach = pane_reach_in(&repo, Some(&path), false);
    assert_eq!(reach.forge(), ForgeReach::Declared, "{}", reach.verdict());
    assert_eq!(
        read_session_config_in(&s.0.join("mcp"), "proj", &declared()),
        SessionConfigRead::Matches,
        "the sweep reads the runner's own `forge` entry as a stale pane"
    );
}

#[test]
fn a_master_over_a_tracked_mcp_json_declaring_nothing_still_gets_forge() {
    let s = scratch();
    let borrow = placed_over(&s, COMMITTED, true);
    let none = serde_json::Map::new();
    let path = write_master_session_in(
        &s.0.join("mcp"),
        Some(&borrow),
        &s.0.join("repo"),
        "proj",
        &none,
    )
    .unwrap()
    .expect("no session config was written for a pane that needs `forge`");
    assert!(session_doc(&path)["mcpServers"]["forge"].is_object());
    assert_eq!(
        read_session_config_in(&s.0.join("mcp"), "proj", &none),
        SessionConfigRead::Matches
    );
}

#[test]
fn a_master_over_an_untracked_mcp_json_is_handed_only_what_core_declares() {
    let s = scratch();
    let borrow = placed_over(&s, COMMITTED, false);
    let path = write_master_session_in(
        &s.0.join("mcp"),
        Some(&borrow),
        &s.0.join("repo"),
        "proj",
        &declared(),
    )
    .unwrap()
    .unwrap();
    assert!(
        session_doc(&path)["mcpServers"].get("forge").is_none(),
        "`forge` is added beside the checkout's own .mcp.json, which already carries it"
    );
    let none = serde_json::Map::new();
    assert_eq!(
        write_master_session_in(
            &s.0.join("mcp"),
            Some(&borrow),
            &s.0.join("repo"),
            "proj",
            &none
        )
        .unwrap(),
        None,
        "a project declaring nothing over an untracked .mcp.json gets a session config"
    );
}

#[test]
fn a_tracked_checkout_with_no_credential_left_gets_no_forge() {
    let s = scratch();
    placed_over(&s, COMMITTED, true);
    let missing = s.0.join("master").join("absent.json");
    let path = write_master_session_in(
        &s.0.join("mcp"),
        Some(&missing),
        &s.0.join("repo"),
        "proj",
        &declared(),
    )
    .unwrap()
    .unwrap();
    assert!(session_doc(&path)["mcpServers"].get("forge").is_none());
}
