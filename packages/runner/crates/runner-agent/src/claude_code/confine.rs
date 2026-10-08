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
//!
//! What it can read it cannot send anywhere it likes either: a chat answers text a stranger may
//! have written — an issue body, feedback, an attachment, a file in the checkout — and a shell
//! that obeys it could post the checkout to any host. Its network is the egress proxy's, which
//! reaches the model's endpoint, Forge core, the MCP servers it was handed and what this box's
//! `[runner] chat_egress_allow` adds, and refuses every other host by name.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use runner_platform::confine::egress::{Egress, Host, Upstream};
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
    /// This runner's own binary, which runs the egress bridge inside the sandbox.
    pub runner_exe: Option<PathBuf>,
    /// Where each session's egress socket directory is made.
    pub egress_dir: PathBuf,
    /// `[runner] chat_egress_allow` from this box's config.
    pub egress_allow: Vec<String>,
}

impl BoxView {
    pub fn current() -> Result<Self> {
        let home = dirs_home()?;
        let config = runner_platform::config::Config::load().map_err(|e| {
            Error::Other(format!(
                "[CHAT_EGRESS_CONFIG] this runner's config, which names the hosts a chat session \
                 may reach, cannot be read: {e}"
            ))
        })?;
        Ok(Self {
            home,
            inherited: std::env::vars_os().collect(),
            runner_config: runner_platform::config::Config::path().ok(),
            claude_bin: Some(PathBuf::from(runner_platform::process::resolve_claude_bin())),
            temp_dir: std::env::temp_dir(),
            runner_exe: runner_platform::exe::own().ok().map(|own| own.path),
            egress_dir: runner_platform::config::base_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("forge-runner"))
                .join("egress"),
            egress_allow: config.runner.chat_egress_allow,
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
    /// The core this runner talks to, which the session's MCP server and `forge-runner api`
    /// reach.
    pub core_url: &'a str,
    /// Where this session's egress proxy listens.
    pub egress_socket: PathBuf,
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
    runner_platform::confine::private_dirs(&view.home, &view.temp_dir, |name| {
        view.var(name).map(OsStr::to_os_string)
    })
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

/// The sandbox a confined chat session runs in. Refused by name where this runner cannot name
/// its own binary, which the sandbox's network runs through. `/run/systemd/resolve` stays
/// empty: its resolver socket would answer a lookup for any name, and a name is a message.
pub(crate) fn chat_sandbox(view: &BoxView, handed: &Handed<'_>) -> Result<Sandbox> {
    let bridge = view.runner_exe.clone().ok_or_else(|| {
        Error::Other(
            "[CHAT_CONFINEMENT_UNAVAILABLE] this runner cannot name its own binary, which carries \
             a confined chat session's network, so the session would have none"
                .into(),
        )
    })?;
    let emptied = emptied(view);
    let mut mounts: Vec<Mount> = emptied.iter().cloned().map(Mount::Empty).collect();
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

    Ok(Sandbox {
        mounts,
        env: chat_env(view, handed),
        cwd: handed.repo.to_path_buf(),
        egress: Some(Egress {
            socket: handed.egress_socket.clone(),
            bridge,
        }),
    })
}

/// The Anthropic hosts a session reaches by default: the API, and where a claude.ai login
/// refreshes its token.
const MODEL_HOSTS: &[&str] = &["https://api.anthropic.com", "https://platform.claude.com"];

/// Where a model endpoint is moved, each replacing nothing but adding its host.
const MODEL_ENDPOINT_VARS: &[&str] = &[
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_VERTEX_BASE_URL",
];

/// Every host a confined session may reach: the model's endpoint as this box's Claude Code login
/// names it, the core, each URL-typed MCP server it was handed, and the box's configured extras.
/// An entry that names no host is refused by name rather than dropped.
pub(crate) fn egress_allow(view: &BoxView, handed: &Handed<'_>) -> Result<Vec<Host>> {
    let refuse = |what: &str, why: String| {
        Error::Other(format!(
            "[CHAT_EGRESS_CONFIG] {what} cannot be allowed to a confined chat session: {why}"
        ))
    };
    let mut out: Vec<Host> = Vec::new();
    for url in MODEL_HOSTS {
        out.push(Host::parse(url).map_err(|e| refuse("the model's endpoint", e))?);
    }
    for name in MODEL_ENDPOINT_VARS {
        if let Some(url) = view.var(name) {
            let url = url.to_string_lossy();
            out.push(Host::parse(&url).map_err(|e| refuse(&format!("${name}"), e))?);
        }
    }
    out.push(Host::parse(handed.core_url).map_err(|e| refuse("the core URL", e))?);
    let config = std::fs::read_to_string(handed.mcp_config).unwrap_or_default();
    let config: serde_json::Value = serde_json::from_str(&config).unwrap_or_default();
    if let Some(servers) = config.get("mcpServers").and_then(|s| s.as_object()) {
        for (name, server) in servers {
            if let Some(url) = server.get("url").and_then(|u| u.as_str()) {
                out.push(Host::parse(url).map_err(|e| refuse(&format!("MCP server `{name}`"), e))?);
            }
        }
    }
    for entry in &view.egress_allow {
        out.push(Host::parse(entry).map_err(|e| refuse("`[runner] chat_egress_allow`", e))?);
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// This box's own upstream proxy, which the egress proxy chains through.
pub(crate) fn upstream(view: &BoxView) -> Result<Option<Upstream>> {
    Upstream::from_env(|name| view.var(name).map(|v| v.to_string_lossy().into_owned()))
        .map_err(|why| Error::Other(format!("[CHAT_EGRESS_CONFIG] {why}")))
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
