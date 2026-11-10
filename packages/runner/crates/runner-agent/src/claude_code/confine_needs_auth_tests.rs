//! Claude Code skips, at connect, every MCP server its needs-auth cache lists, keyed by the
//! server's name alone, and every chat session's server is named `forge` (ISS-1201). So a confined
//! session reads and writes a cache of its own: another pane's 401 on `forge` is never this pane's
//! skip, and this pane's 401 never reaches another pane or the box's own sessions.

use std::path::{Path, PathBuf};

use super::super::SessionCommand;
use super::{bwrap_or_skip, plant, spec, view, Planted, TURN};

/// What another pane wrote when its `forge` was answered 401.
const OTHER_PANES_ENTRY: &str = r#"{"forge":{"timestamp":1700000000000}}"#;

fn shared_cache(p: &Planted) -> PathBuf {
    p.home.join(".claude/mcp-needs-auth-cache.json")
}

/// The file bound over `target` by a `--bind`, read from the sandbox's arguments.
fn bound_over(args: &[String], target: &Path) -> Option<PathBuf> {
    let target = target.to_string_lossy();
    args.windows(3)
        .find(|w| w[0] == "--bind" && w[2] == target && w[1] != target)
        .map(|w| PathBuf::from(&w[1]))
}

/// The session's cache as the session sees it, then its own `forge` 401 written there.
fn probe_script(cache: &Path) -> Vec<String> {
    let script = format!(
        "cat '{f}' 2>/dev/null; echo; \
         printf '%s' '{{\"forge\":{{\"timestamp\":2}}}}' > '{f}' && echo CACHE-WRITTEN; true",
        f = cache.display()
    );
    vec!["-c".to_string(), script]
}

#[tokio::test]
async fn another_panes_forge_needs_auth_entry_is_not_in_a_new_panes_view_and_its_own_stays_its_own()
{
    if !bwrap_or_skip("another_panes_forge_needs_auth_entry_is_not_in_a_new_panes_view") {
        return;
    }
    let p = plant();
    let shared = shared_cache(&p);
    std::fs::write(&shared, OTHER_PANES_ENTRY).unwrap();
    let args = probe_script(&shared);
    let (mut cmd, _egress) = SessionCommand {
        spec: &spec(&p, true),
        program: std::ffi::OsStr::new("/bin/sh"),
        args: &args,
        repo: &p.repo.to_string_lossy(),
        credential: TURN,
        mcp_path: &p.mcp,
        bearer_dir: None,
        core_url: "https://core.example",
    }
    .build(Some(view(&p)))
    .await
    .expect("the session command is built");
    let sandbox: Vec<String> = cmd
        .as_std()
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let own = bound_over(&sandbox, &shared).unwrap_or_else(|| {
        panic!(
            "no file of the session's own is bound over Claude Code's needs-auth cache, so the \
             session reads the one every pane on this box shares: {sandbox:?}"
        )
    });
    assert!(
        !own.starts_with(p.home.join(".claude")),
        "the session's own needs-auth cache {} is in the shared Claude Code directory",
        own.display()
    );
    let out = cmd
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("the session ran");
    let seen = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        !seen.contains("1700000000000"),
        "the session read another pane's `forge` needs-auth entry, so Claude Code would skip its \
         `forge` server: {seen}"
    );
    assert!(
        seen.contains("CACHE-WRITTEN"),
        "the session cannot write its own needs-auth cache: {seen}"
    );
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        OTHER_PANES_ENTRY,
        "the session's own 401 reached the needs-auth cache every pane shares"
    );
    assert!(
        std::fs::read_to_string(&own)
            .unwrap()
            .contains("\"timestamp\":2"),
        "the session's write did not land in its own needs-auth cache"
    );
}

/// Where the box has no needs-auth cache yet, the bind still needs a target. The runner makes it
/// as Claude Code would read an absent one, `{}`, owner-only and writable: bubblewrap would
/// otherwise make an empty read-only file there, which the box's own Claude Code could not write.
#[tokio::test]
async fn a_missing_needs_auth_cache_is_made_empty_and_writable_rather_than_left_to_bubblewrap() {
    if !bwrap_or_skip("a_missing_needs_auth_cache_is_made_empty_and_writable") {
        return;
    }
    use std::os::unix::fs::PermissionsExt;
    let p = plant();
    let shared = shared_cache(&p);
    assert!(!shared.exists(), "the planted box already holds a cache");
    let args = probe_script(&shared);
    let (mut cmd, _egress) = SessionCommand {
        spec: &spec(&p, true),
        program: std::ffi::OsStr::new("/bin/sh"),
        args: &args,
        repo: &p.repo.to_string_lossy(),
        credential: TURN,
        mcp_path: &p.mcp,
        bearer_dir: None,
        core_url: "https://core.example",
    }
    .build(Some(view(&p)))
    .await
    .expect("the session command is built");
    let out = cmd
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("the session ran");
    let seen = String::from_utf8_lossy(&out.stdout).into_owned();
    assert!(
        seen.contains("CACHE-WRITTEN"),
        "the session cannot write its own needs-auth cache: {seen}"
    );
    assert_eq!(
        std::fs::read_to_string(&shared).unwrap(),
        "{}",
        "the box's needs-auth cache is not the empty one the runner made"
    );
    let mode = std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o600,
        "the box's needs-auth cache is not owner-only and writable"
    );
}

/// A resident pane's own `forge` 401 between turns (its turn token is revoked when the turn ends)
/// is its own cache's entry, kept by Claude Code for fifteen minutes. The runner clears that entry
/// as it hands the pane its next turn's token, so the next turn reaches `forge` again.
#[tokio::test]
async fn a_resident_panes_own_forge_entry_is_cleared_with_its_next_turns_bearer() {
    if !bwrap_or_skip("a_resident_panes_own_forge_entry_is_cleared_with_its_next_turns_bearer") {
        return;
    }
    let p = plant();
    let shared = shared_cache(&p);
    let bearer_dir = p.root.join("bearer");
    std::fs::create_dir_all(&bearer_dir).unwrap();
    runner_workspace::mcp::config::refresh_bearer(&bearer_dir, "turn-one").unwrap();
    let mut s = spec(&p, true);
    s.keep_resident = true;
    let script = format!(
        "printf '%s' '{{\"forge\":{{\"timestamp\":2}},\"other\":{{\"timestamp\":3}}}}' > '{f}'; \
         echo WRITTEN; sleep 2; cat '{f}'; echo",
        f = shared.display()
    );
    let args = vec!["-c".to_string(), script];
    let (mut cmd, _egress) = SessionCommand {
        spec: &s,
        program: std::ffi::OsStr::new("/bin/sh"),
        args: &args,
        repo: &p.repo.to_string_lossy(),
        credential: "turn-one",
        mcp_path: &p.mcp,
        bearer_dir: Some(&bearer_dir),
        core_url: "https://core.example",
    }
    .build(Some(view(&p)))
    .await
    .expect("the session command is built");
    let child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .expect("the session started");
    tokio::time::sleep(std::time::Duration::from_millis(900)).await;
    runner_workspace::mcp::config::refresh_bearer(&bearer_dir, "turn-two").unwrap();
    let out = child.wait_with_output().await.expect("the session ran");
    let seen = String::from_utf8_lossy(&out.stdout).into_owned();
    let mut lines = seen.lines();
    assert_eq!(
        lines.next(),
        Some("WRITTEN"),
        "the session did not write: {seen}"
    );
    let after = lines.next().unwrap_or_default();
    assert!(
        !after.contains("forge"),
        "the pane's own `forge` needs-auth entry outlived the next turn's bearer, so Claude Code \
         skips `forge` on that turn: {seen}"
    );
    assert!(
        after.contains("other"),
        "clearing `forge` dropped another server's needs-auth entry: {seen}"
    );
}
