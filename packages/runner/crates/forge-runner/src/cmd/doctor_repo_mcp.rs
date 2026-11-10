//! What a human opening `claude` in a bound checkout would find, read for `forge-runner doctor`.
//! Split from `doctor.rs` so that file stays under the runner's 800-line gate (ISS-1193).

/// What a human opening `claude` in a bound checkout would find.
#[derive(Debug, PartialEq, Eq)]
pub(super) enum RepoMcp {
    HasForge,
    NoForgeEntry,
    /// Git tracks the file and it holds no `forge` server: the runner refuses to write one there.
    TrackedNoForge,
    /// Git tracks the file and its `forge` server carries an `Authorization` header: a credential
    /// in a file that is committed, as an older runner wrote it (ISS-1193).
    TrackedCredential,
    Missing,
    Unreadable(String),
}

pub(super) fn repo_mcp_state(repo_path: &std::path::Path) -> RepoMcp {
    let path = repo_path.join(".mcp.json");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return RepoMcp::Missing,
    };
    let doc = match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(doc) => doc,
        Err(e) => {
            return RepoMcp::Unreadable(format!("{} is not valid JSON ({e})", path.display()))
        }
    };
    let tracked = runner_workspace::mcp::config::git_tracks(repo_path, ".mcp.json");
    let forge = doc.pointer("/mcpServers/forge");
    let bearer = forge
        .and_then(|f| f.pointer("/headers/Authorization"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|v| !v.trim().is_empty());
    match (tracked, forge.is_some()) {
        (true, true) if bearer => RepoMcp::TrackedCredential,
        (true, false) => RepoMcp::TrackedNoForge,
        (_, true) => RepoMcp::HasForge,
        (false, false) => RepoMcp::NoForgeEntry,
    }
}

#[cfg(test)]
mod repo_mcp_tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;

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

    const LEAKED: &str = r#"{"mcpServers":{"forge":{"type":"http","url":"https://core.example/mcp","headers":{"Authorization":"Bearer fake-iss1193-token"}}}}"#;

    #[test]
    fn a_committed_forge_credential_is_named_and_an_ignored_one_is_not() {
        let repo = std::env::temp_dir().join(format!("doctor-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        std::fs::write(repo.join(".mcp.json"), LEAKED).unwrap();
        assert_eq!(
            repo_mcp_state(&repo),
            RepoMcp::HasForge,
            "an untracked file holding the credential is what the runner writes on purpose"
        );
        git(&repo, &["add", "--", ".mcp.json"]);
        git(&repo, &["commit", "-q", "-m", "leak"]);
        git(
            &repo,
            &["update-index", "--skip-worktree", "--", ".mcp.json"],
        );
        assert_eq!(repo_mcp_state(&repo), RepoMcp::TrackedCredential);
        std::fs::write(repo.join(".mcp.json"), r#"{"mcpServers":{}}"#).unwrap();
        assert_eq!(repo_mcp_state(&repo), RepoMcp::TrackedNoForge);
        std::fs::remove_dir_all(&repo).unwrap();
    }
}
