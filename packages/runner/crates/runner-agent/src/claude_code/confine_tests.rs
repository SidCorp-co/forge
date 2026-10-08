//! A chat session core marks `confined` holds its turn credential and nothing else this box
//! keeps; a session core does not mark runs as it always did.
//!
//! Each test plants a box — a home holding every credential the runner and the person's tools
//! keep, a checkout whose `.mcp.json` holds the workspace token, an environment carrying the
//! runner's own secrets — each value a marker naming what it is. The session command the
//! runner builds then runs a shell in place of `claude` that prints its environment and reads
//! every planted path by absolute path, and the test names each marker that came back.
//! Nothing real is printed: only markers are searched for, and only markers are named.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use super::confine::BoxView;
use super::session_command;
use crate::{Confinement, JobSpec, TurnCredential};
use runner_platform::confine::{availability, Availability};

const TURN: &str = "TURN-TOKEN-ours";

/// Every planted secret: its marker, what it is, and where the box keeps it (relative to the
/// planted home, or `repo/` for the checkout).
const FILES: &[(&str, &str, &str)] = &[
    (
        "LEAK-device-token",
        "the runner's device token",
        ".config/forge-runner/credentials.json",
    ),
    (
        "LEAK-stored-pat",
        "the box holder's stored PAT that `forge-runner api` falls back to",
        ".config/forge-runner/credentials.json",
    ),
    (
        "LEAK-borrowed-checkout-token",
        "a master pane's borrowed checkout credential",
        ".config/forge-runner/master/p/forge-cli.json",
    ),
    (
        "LEAK-other-session-mcp",
        "another session's MCP config, which carries its token",
        ".config/forge-runner/mcp/forge-mcp-p-other.json",
    ),
    (
        "LEAK-runner-secrets-env",
        "the runner's secrets.env",
        ".config/forge-runner/secrets.env",
    ),
    (
        "LEAK-forge-cli-account",
        "the `forge` CLI's account",
        ".config/forge/config.json",
    ),
    (
        "LEAK-gh-token",
        "`gh`'s GitHub token",
        ".config/gh/hosts.yml",
    ),
    (
        "LEAK-ssh-key",
        "the SSH key git pushes with",
        ".ssh/id_ed25519",
    ),
    (
        "LEAK-git-credentials",
        "git's stored credentials",
        ".git-credentials",
    ),
    (
        "LEAK-workspace-token",
        "the checkout's `.mcp.json` workspace token",
        "repo/.mcp.json",
    ),
];

/// Every planted variable of the runner's own environment: name, marker, what it is.
const ENV: &[(&str, &str, &str)] = &[
    (
        "FORGE_PAT",
        "LEAK-inherited-forge-pat",
        "the runner's own inherited $FORGE_PAT",
    ),
    ("GH_TOKEN", "LEAK-gh-env", "an inherited GitHub token"),
    (
        "OPS_MCP_TOKEN",
        "LEAK-ops-env",
        "an inherited secret loaded from secrets.env",
    ),
    (
        "FORGE_BORROW_FROM",
        "LEAK-borrow-env",
        "a master pane's borrowed-credential pointer",
    ),
    (
        "SSH_AUTH_SOCK",
        "LEAK-ssh-agent-env",
        "the SSH agent's socket",
    ),
    (
        "CLAUDE_CODE_MESSAGING_TOKEN",
        "LEAK-parent-session-env",
        "a parent Claude Code session's messaging token",
    ),
];

struct Planted {
    root: PathBuf,
    home: PathBuf,
    repo: PathBuf,
    mcp: PathBuf,
    config: PathBuf,
}

impl Drop for Planted {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut existing = std::fs::read_to_string(path).unwrap_or_default();
    existing.push_str(body);
    existing.push('\n');
    std::fs::write(path, existing).unwrap();
}

fn plant() -> Planted {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("confine-{}-{nanos}", std::process::id()));
    let home = root.join("home");
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let init = std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap();
    assert!(init.success(), "git init failed");
    write(&repo.join("README"), "a file the session works on");
    for (marker, _, at) in FILES {
        let path = match at.strip_prefix("repo/") {
            Some(rel) => repo.join(rel),
            None => home.join(at),
        };
        write(&path, marker);
    }
    let config = home.join(".config/forge-runner/config.toml");
    write(&config, "core_url = \"https://core.example\"");
    write(&home.join(".claude/settings.json"), "{}");
    let mcp = home.join(".config/forge-runner/mcp/forge-mcp-p-s1.json");
    write(&mcp, &format!("{{\"token\":\"{TURN}\"}}"));
    Planted {
        root,
        home,
        repo,
        mcp,
        config,
    }
}

fn view(p: &Planted) -> BoxView {
    let mut inherited: Vec<(OsString, OsString)> = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), p.home.clone().into_os_string()),
    ];
    for (name, marker, _) in ENV {
        inherited.push(((*name).into(), (*marker).into()));
    }
    BoxView {
        home: p.home.clone(),
        inherited,
        runner_config: Some(p.config.clone()),
        claude_bin: None,
        temp_dir: std::env::temp_dir(),
    }
}

fn spec(p: &Planted, confined: bool) -> JobSpec {
    JobSpec {
        job_id: "s1".into(),
        project_id: String::new(),
        project_slug: Some("p".into()),
        repo_path: p.repo.clone(),
        prompt: Some("hi".into()),
        system_prompt: None,
        model: None,
        permission_mode: None,
        mcp_servers_override: None,
        resume_id: None,
        counts_against_session_cap: false,
        credential: Some(TurnCredential(TURN.into())),
        confinement: confined.then(Confinement::default),
    }
}

/// What the session saw: its environment, every planted path read by absolute path, a search
/// of the planted tree, how many processes it can see, and whether it could write its own
/// checkout and the git config the runner's own `git` reads.
async fn run_probe(p: &Planted, confined: bool) -> (String, std::process::Command) {
    let mut paths: Vec<String> = FILES
        .iter()
        .map(|(_, _, at)| match at.strip_prefix("repo/") {
            Some(rel) => p.repo.join(rel),
            None => p.home.join(at),
        })
        .map(|f| f.display().to_string())
        .collect();
    paths.push(p.config.display().to_string());
    let script = format!(
        "env; for f in {files}; do cat \"$f\" 2>/dev/null; echo; done; \
         grep -rs LEAK- '{root}' '{home}' 2>/dev/null; \
         echo \"PROCS=$(ls -d /proc/[0-9]* | wc -l)\"; \
         echo written > '{repo}/written-by-session' 2>/dev/null && echo CHECKOUT-WRITABLE; \
         echo '[core] sshCommand = tamper' >> '{repo}/.git/config' 2>/dev/null && echo GIT-CONFIG-WRITABLE; \
         true",
        files = paths
            .iter()
            .map(|f| format!("'{f}'"))
            .collect::<Vec<_>>()
            .join(" "),
        root = p.root.display(),
        home = p.home.display(),
        repo = p.repo.display(),
    );
    let args = vec!["-c".to_string(), script];
    let cmd = session_command(
        &spec(p, confined),
        std::ffi::OsStr::new("/bin/sh"),
        &args,
        &p.repo.to_string_lossy(),
        TURN,
        &p.mcp,
        Some(view(p)),
    )
    .await
    .expect("the session command is built");
    let mut cmd = cmd;
    let out = cmd
        .stdin(std::process::Stdio::null())
        .output()
        .await
        .expect("the session ran");
    let seen = String::from_utf8_lossy(&out.stdout).into_owned();
    (seen, std::process::Command::new(cmd.as_std().get_program()))
}

/// Every planted credential the session saw, named by what it is. Only markers are named.
fn leaks(seen: &str) -> Vec<String> {
    let mut out: Vec<String> = FILES
        .iter()
        .filter(|(marker, _, _)| seen.contains(marker))
        .map(|(marker, what, at)| format!("{what} ({at}, {marker})"))
        .collect();
    out.extend(
        ENV.iter()
            .filter(|(_, marker, _)| seen.contains(marker))
            .map(|(name, marker, what)| format!("{what} (${name}, {marker})")),
    );
    out
}

fn bwrap_or_skip(test: &str) -> bool {
    match availability() {
        Availability::Available => true,
        Availability::Unavailable(why) => match std::env::var("FORGE_TEST_SKIP_BWRAP") {
            Ok(v) if v == "1" => {
                eprintln!(
                    "SKIPPED {test}: this box cannot confine ({why}) and FORGE_TEST_SKIP_BWRAP=1 \
                     opted this run out — nothing was asserted"
                );
                false
            }
            _ => panic!(
                "BWRAP_UNAVAILABLE: {test} needs bubblewrap to start a sandbox ({why}) — install \
                 it, or set FORGE_TEST_SKIP_BWRAP=1 to skip it by name"
            ),
        },
    }
}

#[tokio::test]
async fn a_confined_chat_session_holds_its_turn_token_and_no_other_credential_of_this_box() {
    if !bwrap_or_skip("a_confined_chat_session_holds_its_turn_token_and_no_other_credential") {
        return;
    }
    let p = plant();
    let (seen, _) = run_probe(&p, true).await;
    let leaked = leaks(&seen);
    assert!(
        leaked.is_empty(),
        "a confined chat session could read credentials it was never handed: {}",
        leaked.join("; ")
    );
    assert!(
        seen.lines().any(|l| l == format!("FORGE_PAT={TURN}")),
        "the session's $FORGE_PAT is not its turn credential"
    );
    assert!(
        seen.contains("core_url = \"https://core.example\""),
        "the runner's config.toml, which `forge-runner api` reads its core URL from, is not readable"
    );
    let procs: usize = seen
        .lines()
        .find_map(|l| l.strip_prefix("PROCS="))
        .and_then(|n| n.trim().parse().ok())
        .expect("the probe counted processes");
    assert!(
        procs <= 8,
        "the session sees {procs} processes, so another process's /proc/<pid>/environ is in reach"
    );
    assert!(
        seen.contains("CHECKOUT-WRITABLE") && p.repo.join("written-by-session").is_file(),
        "the session cannot write the checkout it was bound to"
    );
    let git_config = std::fs::read_to_string(p.repo.join(".git/config")).unwrap();
    assert!(
        !seen.contains("GIT-CONFIG-WRITABLE") && !git_config.contains("tamper"),
        "the session wrote the checkout's .git/config, which the runner's own `git fetch` reads with every credential the daemon holds"
    );
}

#[tokio::test]
async fn a_session_core_does_not_confine_runs_with_the_box_as_before() {
    let p = plant();
    let (seen, program) = run_probe(&p, false).await;
    assert_eq!(
        program.get_program(),
        "/bin/sh",
        "an unconfined session was wrapped in a sandbox"
    );
    assert!(
        seen.lines().any(|l| l == format!("FORGE_PAT={TURN}")),
        "an unconfined session's $FORGE_PAT is not the credential it was started with"
    );
    assert!(
        seen.contains("LEAK-workspace-token") && seen.contains("LEAK-stored-pat"),
        "an unconfined session no longer reads the box as it did, so this test's planted box is not one it can see"
    );
}

#[tokio::test]
async fn a_confined_session_handed_no_credential_is_refused_rather_than_given_the_boxs() {
    let runner = super::ClaudeCodeRunner::new("http://127.0.0.1:9", "device-token", 1);
    let p = plant();
    let mut spec = spec(&p, true);
    spec.credential = None;
    let (tx, _rx) = tokio::sync::mpsc::channel(4);
    let err = crate::Runner::start(&runner, spec, tx)
        .await
        .expect_err("a confined session with no credential of its own was started");
    assert!(
        err.to_string().contains("CHAT_CONFINEMENT_NO_CREDENTIAL"),
        "the refusal does not name itself: {err}"
    );
}
