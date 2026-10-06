//! The environment a pane's shell is started with.

/// What a pane's shell is started with. `$FORGE_PROJECT_ID` and `$FORGE_PROJECT_SLUG` are what a
/// skill installed on disk names the project by: core writes the id into every brief it renders,
/// but a skill file is the same bytes for every project, and a pane without them sends
/// `projects//…` to Forge.
pub fn pane_env(project_id: &str, project_slug: &str) -> Vec<(String, String)> {
    let mut env = pane_env_from(|k| std::env::var_os(k));
    let found = pane_path(
        std::env::var_os("PATH"),
        std::env::var_os("HOME").map(std::path::PathBuf::from),
        claude_dir(),
    );
    for name in &found.missing {
        tracing::error!(
            "[terminal] a pane for {project_slug} is starting and no `{name}` resolves on this daemon's PATH or in the usual install directories: every plugin hook in it that runs `{name}` fails with `{name}: not found`. Install it, or put its directory on the runner service's PATH, and restart the pane"
        );
    }
    if let Some(path) = found.path {
        env.push(("PATH".into(), path));
    }
    env.push(("FORGE_PROJECT_ID".into(), project_id.into()));
    env.push(("FORGE_PROJECT_SLUG".into(), project_slug.into()));
    env
}

/// The binaries a pane's plugin hooks are run with. A pane inherits the tmux
/// server's environment, and the server is started by `systemd-run --user`,
/// whose PATH holds none of a user's install directories.
const PANE_BINARIES: [&str; 1] = ["node"];

/// The PATH a pane is started with, and the pane binaries it still cannot
/// reach.
#[derive(Debug, PartialEq, Eq)]
struct PanePath {
    path: Option<String>,
    missing: Vec<&'static str>,
}

fn claude_dir() -> Option<std::path::PathBuf> {
    let bin = std::path::Path::new(runner_platform::process::resolve_claude_bin());
    bin.is_absolute()
        .then(|| bin.parent().map(std::path::Path::to_path_buf))
        .flatten()
}

/// This daemon's PATH, with the directory of each pane binary it lacks put in
/// front where one is found beside `claude` or in a usual install directory.
fn pane_path(
    daemon_path: Option<std::ffi::OsString>,
    home: Option<std::path::PathBuf>,
    claude_dir: Option<std::path::PathBuf>,
) -> PanePath {
    let mut dirs: Vec<std::path::PathBuf> = daemon_path
        .as_deref()
        .map(|p| std::env::split_paths(p).collect())
        .unwrap_or_default();
    let mut fallbacks: Vec<std::path::PathBuf> = claude_dir.into_iter().collect();
    if let Some(home) = home.as_deref() {
        fallbacks.push(home.join(".local/bin"));
        fallbacks.push(home.join(".volta/bin"));
        fallbacks.push(home.join(".bun/bin"));
        if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
            let mut versions: Vec<std::path::PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path().join("bin")))
                .collect();
            versions.sort();
            fallbacks.extend(versions.into_iter().rev());
        }
    }
    fallbacks.push("/usr/local/bin".into());
    fallbacks.push("/usr/bin".into());
    let mut missing = Vec::new();
    for name in PANE_BINARIES {
        if dirs
            .iter()
            .any(|d| runner_platform::exe::is_runnable(&d.join(name)))
        {
            continue;
        }
        match fallbacks
            .iter()
            .find(|d| runner_platform::exe::is_runnable(&d.join(name)))
        {
            Some(dir) => dirs.insert(0, dir.clone()),
            None => missing.push(name),
        }
    }
    let path = (!dirs.is_empty())
        .then(|| std::env::join_paths(&dirs).ok())
        .flatten()
        .map(|p| p.to_string_lossy().into_owned());
    PanePath { path, missing }
}

// a pane's `forge-runner hook|gate|run` finds its daemon through the config dir; the
// session server's unit inherits none of this process's environment, so a daemon run under its
// own `XDG_CONFIG_HOME` hands it on or its panes report to the box's default daemon (ISS-10)
fn pane_env_from(var: impl Fn(&str) -> Option<std::ffi::OsString>) -> Vec<(String, String)> {
    let mut env = Vec::new();
    if let Some(v) =
        runner_platform::process::mcp_tool_timeout_default(var("MCP_TOOL_TIMEOUT").as_deref())
    {
        env.push(("MCP_TOOL_TIMEOUT".into(), v.into()));
    }
    if let Some(x) = var("XDG_CONFIG_HOME") {
        if std::path::Path::new(&x).is_absolute() {
            env.push(("XDG_CONFIG_HOME".into(), x.to_string_lossy().into_owned()));
        }
    }
    env
}
