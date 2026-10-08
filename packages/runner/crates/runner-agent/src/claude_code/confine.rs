//! What a confined chat session is left holding: its turn credential, the checkout it was bound
//! to, Claude Code's own install and login, and nothing else this box keeps.
//!
//! Core asks for it on a chat door's turn (`confined` on `agent:start` / `agent:send`), whose
//! own token cannot file an issue. The box's other credentials can — the token in the
//! checkout's `.mcp.json`, the PAT `forge-runner api` falls back to, the device token, the
//! `forge` CLI's account, `gh`'s token and the SSH key git pushes with — and the session's
//! shell runs as the user that owns all of them. So they are not in its view at all: the home,
//! `/tmp`, `/var` and `/run` are empty in the sandbox, the few paths a session needs are bound
//! back, and its environment is built from a list rather than inherited.
//!
//! The checkout is writable, its git directory is not: the runner's own `git fetch` runs in that
//! directory with every credential the daemon holds, so a `core.sshCommand` or a hook a chat
//! wrote there would be code the daemon runs for it.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use runner_platform::confine::{Mount, Sandbox};
use runner_platform::error::{Error, Result};

/// The facts of this box a session's sandbox is cut from: read from this process in
/// production, planted in a test.
#[derive(Debug, Clone)]
pub(crate) struct BoxView {
    pub home: PathBuf,
    /// The environment the session would otherwise have inherited.
    pub inherited: Vec<(OsString, OsString)>,
    /// `config.toml`, read by `forge-runner api` inside the session for the core URL. It holds
    /// no credential: those are in `credentials.json` beside it, which stays out of view.
    pub runner_config: Option<PathBuf>,
    /// The `claude` binary as resolved, so its install is bound back wherever it lives.
    pub claude_bin: Option<PathBuf>,
    pub temp_dir: PathBuf,
}

impl BoxView {
    pub fn current() -> Result<Self> {
        let home = dirs_home()?;
        Ok(Self {
            home,
            inherited: std::env::vars_os().collect(),
            runner_config: runner_platform::config::Config::path().ok(),
            claude_bin: Some(PathBuf::from(runner_platform::process::resolve_claude_bin())),
            temp_dir: std::env::temp_dir(),
        })
    }

    fn var(&self, name: &str) -> Option<&OsStr> {
        self.inherited
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_os_str())
            .filter(|v| !v.is_empty())
    }
}

fn dirs_home() -> Result<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| {
            Error::Other(
                "[CHAT_CONFINEMENT_UNAVAILABLE] this runner has no $HOME, so the home a chat \
                 session must not see cannot be named"
                    .into(),
            )
        })
}

/// What core and the runner handed this one session.
pub(crate) struct Handed<'a> {
    pub repo: &'a Path,
    pub credential: &'a str,
    pub mcp_config: &'a Path,
    pub reads: &'a [PathBuf],
    pub project_slug: Option<&'a str>,
    pub project_id: &'a str,
    /// The checkout's git directories, read outside the sandbox: `--absolute-git-dir` and
    /// `--git-common-dir`. Empty where the checkout is not a git repository.
    pub git_dirs: Vec<PathBuf>,
    /// `user.name` and `user.email` as git reads them outside, so a commit inside is still
    /// attributed: the session does not see `~/.gitconfig`.
    pub git_identity: Option<(String, String)>,
}

/// Variables a session inherits by name: locale, terminal, proxies and trust roots, and Claude
/// Code's own login. Nothing else the runner holds reaches it — not a `CLAUDE_CODE_*` variable a
/// parent Claude Code session left in the runner's environment (its session id, its messaging
/// socket and token), which is why that family is named one by one rather than by prefix.
const PASSED: &[&str] = &[
    "PATH",
    "LANG",
    "LANGUAGE",
    "TZ",
    "TERM",
    "USER",
    "LOGNAME",
    "SHELL",
    "XDG_CONFIG_HOME",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "MCP_TIMEOUT",
    "MCP_TOOL_TIMEOUT",
];

const PASSED_PREFIXES: &[&str] = &["LC_", "ANTHROPIC_", "CLAUDE_CODE_DISABLE_"];

fn passed(name: &OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    PASSED.contains(&name) || PASSED_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Directories emptied in the session's view: the home, the shared temp and runtime trees,
/// and wherever this box's XDG variables move its config, data, state or cache.
fn emptied(view: &BoxView) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = vec![
        view.home.clone(),
        "/tmp".into(),
        "/var".into(),
        "/run".into(),
        view.temp_dir.clone(),
    ];
    for name in [
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "XDG_RUNTIME_DIR",
        "TMPDIR",
    ] {
        if let Some(dir) = view.var(name) {
            out.push(PathBuf::from(dir));
        }
    }
    let mut kept: Vec<PathBuf> = Vec::new();
    for dir in out {
        let fresh = !kept.iter().any(|k| dir.starts_with(k));
        if dir.is_absolute() && dir != Path::new("/") && dir.is_dir() && fresh {
            kept.retain(|k| !k.starts_with(&dir));
            kept.push(dir);
        }
    }
    kept
}

/// The executables on the session's `PATH` that live in an emptied directory, bound back
/// read-only. A `bin` whose parent holds `lib` is a prefix (`~/.nvm/versions/node/vN`), whose
/// scripts resolve into that `lib`, so the prefix is bound; `~/.local` is not, since it holds
/// every application's data.
fn tool_dirs(view: &BoxView, emptied: &[PathBuf]) -> Vec<PathBuf> {
    let under_emptied = |p: &Path| emptied.iter().any(|e| p.starts_with(e));
    let mut out: Vec<PathBuf> = Vec::new();
    if let Some(path) = view.var("PATH") {
        for dir in std::env::split_paths(path) {
            if !dir.is_absolute() || !under_emptied(&dir) || !dir.is_dir() {
                continue;
            }
            let prefix = dir
                .parent()
                .filter(|_| dir.file_name() == Some(OsStr::new("bin")))
                .filter(|p| *p != view.home && *p != view.home.join(".local"))
                .filter(|p| p.join("lib").is_dir());
            out.push(prefix.map_or(dir.clone(), Path::to_path_buf));
        }
    }
    if let Some(bin) = view.claude_bin.as_deref() {
        if let Ok(real) = bin.canonicalize() {
            if let Some(dir) = real.parent().filter(|d| under_emptied(d)) {
                out.push(dir.to_path_buf());
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

/// The sandbox a confined chat session runs in.
pub(crate) fn chat_sandbox(view: &BoxView, handed: &Handed<'_>) -> Sandbox {
    let emptied = emptied(view);
    let mut mounts: Vec<Mount> = emptied.iter().cloned().map(Mount::Empty).collect();
    let resolve = Path::new("/run/systemd/resolve");
    if resolve.is_dir() {
        mounts.push(Mount::Read(resolve.to_path_buf()));
    }
    for dir in tool_dirs(view, &emptied) {
        mounts.push(Mount::Read(dir));
    }
    for file in view
        .runner_config
        .iter()
        .map(PathBuf::as_path)
        .chain([handed.mcp_config])
        .chain(handed.reads.iter().map(PathBuf::as_path))
    {
        if file.exists() {
            mounts.push(Mount::Read(file.to_path_buf()));
        }
    }
    let claude_dir = view
        .var("CLAUDE_CONFIG_DIR")
        .map_or_else(|| view.home.join(".claude"), PathBuf::from);
    let mut writable = vec![claude_dir];
    if view.var("CLAUDE_CONFIG_DIR").is_none() {
        writable.push(view.home.join(".claude.json"));
    }
    writable.push(handed.repo.to_path_buf());
    for path in writable.into_iter().filter(|p| p.exists()) {
        mounts.push(Mount::Write(path));
    }
    for dir in &handed.git_dirs {
        if dir.exists() {
            mounts.push(Mount::Read(dir.clone()));
        }
    }
    let settings = handed.repo.join(".claude");
    if settings.is_dir() {
        mounts.push(Mount::Read(settings));
    }
    let workspace_mcp = handed.repo.join(".mcp.json");
    if workspace_mcp.is_file() {
        mounts.push(Mount::Hide(workspace_mcp));
    }

    Sandbox {
        mounts,
        env: chat_env(view, handed),
        cwd: handed.repo.to_path_buf(),
    }
}

fn chat_env(view: &BoxView, handed: &Handed<'_>) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = view
        .inherited
        .iter()
        .filter(|(k, _)| passed(k))
        .cloned()
        .collect();
    let mut set = |k: &str, v: &OsStr| {
        env.retain(|(name, _)| name != k);
        env.push((k.into(), v.to_os_string()));
    };
    set("HOME", view.home.as_os_str());
    set("TMPDIR", OsStr::new("/tmp"));
    set("FORGE_PAT", OsStr::new(handed.credential));
    if let Some(slug) = handed.project_slug {
        set("FORGE_PROJECT_SLUG", OsStr::new(slug));
    }
    if !handed.project_id.is_empty() {
        set("FORGE_PROJECT_ID", OsStr::new(handed.project_id));
    }
    set("GIT_TERMINAL_PROMPT", OsStr::new("0"));
    set("GIT_ASKPASS", OsStr::new(""));
    set("GCM_INTERACTIVE", OsStr::new("never"));
    // The install is bound read-only, so an update could only fail.
    set("DISABLE_AUTOUPDATER", OsStr::new("1"));
    if let Some((name, email)) = &handed.git_identity {
        for k in ["GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"] {
            set(k, OsStr::new(name));
        }
        for k in ["GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"] {
            set(k, OsStr::new(email));
        }
    }
    if view.var("MCP_TIMEOUT").is_none() {
        set("MCP_TIMEOUT", OsStr::new("15000"));
    }
    if let Some(v) =
        runner_platform::process::mcp_tool_timeout_default(view.var("MCP_TOOL_TIMEOUT"))
    {
        set("MCP_TOOL_TIMEOUT", OsStr::new(v));
    }
    env
}

/// The checkout's git directories and identity, read with the runner's own view.
pub(crate) async fn read_git(repo: &Path) -> (Vec<PathBuf>, Option<(String, String)>) {
    use runner_platform::git::git_line;
    let mut dirs: Vec<PathBuf> = Vec::new();
    for arg in ["--absolute-git-dir", "--git-common-dir"] {
        if let Some(line) = git_line(repo, &["rev-parse", "--path-format=absolute", arg]).await {
            let dir = PathBuf::from(line);
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
    }
    let name = git_line(repo, &["config", "user.name"]).await;
    let email = git_line(repo, &["config", "user.email"]).await;
    (dirs, name.zip(email))
}
