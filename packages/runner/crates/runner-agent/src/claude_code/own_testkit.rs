//! An owner-mode channel agent's session as this runner spawns it (ISS-765), for `forge-runner`'s
//! end-to-end test of it: that test holds this build's real egress bridge and `git-credential`
//! helper, which this crate cannot run. Not an interface; nothing but that test calls it.

use std::ffi::OsString;
use std::path::PathBuf;

use super::confine::BoxView;
use super::SessionCommand;
use crate::{CheckoutView, Confinement, JobSpec, TurnCredential};

/// A planted box and the owner-mode session to spawn on it.
pub struct OwnBox {
    /// The box's home, holding whatever the test planted in it.
    pub home: PathBuf,
    /// The session's own clone, which it runs in.
    pub clone: PathBuf,
    /// The checkout view's development branch and key.
    pub base: String,
    pub key: String,
    /// The repository hosts core named for the view.
    pub hosts: Vec<String>,
    /// The session's MCP config.
    pub mcp: PathBuf,
    /// `config.toml`, naming the core.
    pub runner_config: PathBuf,
    /// The `forge-runner` binary: the bridge, the credential helper and the `gh` shim's target.
    pub runner_exe: PathBuf,
    /// Where the session's egress socket directory is made.
    pub egress_dir: PathBuf,
    /// The environment the runner itself holds.
    pub inherited: Vec<(OsString, OsString)>,
    pub project_id: String,
    pub core_url: String,
    /// The session's turn token.
    pub turn: String,
}

/// Run `script` under `/bin/sh` as the owner-mode session on `b`, and what it printed.
pub async fn run(b: &OwnBox, script: &str) -> Result<std::process::Output, String> {
    let spec = JobSpec {
        job_id: "own-s1".into(),
        project_id: b.project_id.clone(),
        project_slug: Some("p".into()),
        repo_path: b.clone.clone(),
        prompt: Some("hi".into()),
        system_prompt: None,
        model: None,
        permission_mode: None,
        mcp_servers_override: None,
        resume_id: None,
        counts_against_session_cap: false,
        credential: Some(TurnCredential(b.turn.clone())),
        confinement: Some(Confinement {
            reads: vec![],
            checkout: CheckoutView::Own {
                key: b.key.clone(),
                base: b.base.clone(),
                hosts: b.hosts.clone(),
            },
        }),
        hooks_off: false,
        keep_resident: false,
    };
    let view = BoxView {
        home: b.home.clone(),
        inherited: b.inherited.clone(),
        runner_config: Some(b.runner_config.clone()),
        claude_bin: None,
        temp_dir: std::env::temp_dir(),
        runner_exe: Some(b.runner_exe.clone()),
        egress_dir: b.egress_dir.clone(),
        egress_allow: vec![],
    };
    let args = vec!["-c".to_string(), script.to_string()];
    // the egress bridge stands until the session has ended: dropped at the end of this scope
    let (mut cmd, _egress) = SessionCommand {
        spec: &spec,
        program: std::ffi::OsStr::new("/bin/sh"),
        args: &args,
        repo: &b.clone.to_string_lossy(),
        credential: &b.turn,
        mcp_path: &b.mcp,
        bearer_dir: None,
        core_url: &b.core_url,
    }
    .build(Some(view))
    .await
    .map_err(|e| e.to_string())?;
    cmd.stdin(std::process::Stdio::null())
        .output()
        .await
        .map_err(|e| e.to_string())
}
