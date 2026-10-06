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
        own_dir(project_slug),
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

/// The directory of the binary serving this daemon, which a pane's `forge-runner` has to resolve
/// to. A pane inherits a PATH this daemon did not choose, and on a box running two runners (a
/// prod and a dev one under different config dirs) the first `forge-runner` on it is whichever
/// was installed to `~/.local/bin`, so every `forge-runner api|run|gate` a skill or a nudge has
/// the agent type would reach the other box's build.
fn own_dir(project_slug: &str) -> Option<std::path::PathBuf> {
    match runner_platform::exe::own() {
        Ok(exe) => exe.path.parent().map(std::path::Path::to_path_buf),
        Err(e) => {
            let reached = runner_platform::exe::on_path("forge-runner")
                .map(|p| p.display().to_string())
                .unwrap_or_else(|| "nothing".into());
            tracing::error!(
                "[terminal] a pane for {project_slug} is starting and {e}: its `forge-runner` resolves on the inherited PATH to {reached}, which may not be the build serving this daemon"
            );
            None
        }
    }
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
/// front where one is found beside `claude` or in a usual install directory,
/// and the serving binary's own directory in front of all of it.
fn pane_path(
    daemon_path: Option<std::ffi::OsString>,
    home: Option<std::path::PathBuf>,
    claude_dir: Option<std::path::PathBuf>,
    own_dir: Option<std::path::PathBuf>,
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
    if let Some(own) = own_dir {
        dirs.retain(|d| d != &own);
        dirs.insert(0, own);
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

#[cfg(test)]
mod tests {
    use super::pane_path;
    use std::path::{Path, PathBuf};

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("forge-pane-path-{}", uuid::Uuid::new_v4())))
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn runnable(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn first_runnable(path: &str, name: &str) -> Option<PathBuf> {
        std::env::split_paths(path)
            .map(|d| d.join(name))
            .find(|f| runner_platform::exe::is_runnable(f))
    }

    #[test]
    fn a_pane_resolves_forge_runner_to_the_daemon_binary_ahead_of_an_earlier_one_on_path() {
        let root = Scratch::new();
        let other = root.0.join("local-bin");
        let own = root.0.join("dev-runner-bin");
        runnable(&other, "forge-runner");
        runnable(&other, "node");
        runnable(&own, "forge-runner");
        let inherited = std::env::join_paths([&other, &own]).unwrap();

        let found = pane_path(Some(inherited), None, None, Some(own.clone()));
        let path = found.path.expect("a pane PATH");

        assert_eq!(
            first_runnable(&path, "forge-runner"),
            Some(own.join("forge-runner")),
            "pane PATH {path} resolves forge-runner to another box's build"
        );
        assert_eq!(
            std::env::split_paths(&path).filter(|d| d == &own).count(),
            1,
            "the daemon's directory is named once, not appended beside where it already stood: {path}"
        );
        assert!(found.missing.is_empty());
    }

    #[test]
    fn two_daemons_on_one_box_each_hand_their_panes_their_own_binary() {
        let root = Scratch::new();
        let prod = root.0.join("prod");
        let dev = root.0.join("dev");
        runnable(&prod, "forge-runner");
        runnable(&dev, "forge-runner");
        let inherited = std::env::join_paths([&prod, &dev]).unwrap();

        for own in [&prod, &dev] {
            let path = pane_path(Some(inherited.clone()), None, None, Some(own.clone()))
                .path
                .unwrap();
            assert_eq!(
                first_runnable(&path, "forge-runner"),
                Some(own.join("forge-runner"))
            );
        }
    }

    #[test]
    fn a_daemon_that_cannot_name_itself_leaves_the_inherited_order() {
        let root = Scratch::new();
        let other = root.0.join("local-bin");
        runnable(&other, "forge-runner");
        runnable(&other, "node");
        let inherited = std::env::join_paths([&other]).unwrap();

        let path = pane_path(Some(inherited), None, None, None).path.unwrap();
        assert_eq!(std::env::split_paths(&path).next(), Some(other));
    }

    #[test]
    fn the_live_pane_env_leads_with_this_process_directory() {
        let dir = runner_platform::exe::own()
            .unwrap()
            .path
            .parent()
            .unwrap()
            .to_path_buf();
        let env = super::pane_env("p", "s");
        let path = env
            .iter()
            .find(|(k, _)| k == "PATH")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        assert_eq!(
            std::env::split_paths(&path).next(),
            Some(dir),
            "pane PATH {path}"
        );
    }
}
