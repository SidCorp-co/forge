//! The PATH a pane this box places is started with (ISS-1390).
//!
//! The pane server is started by `systemd-run --user`, so it takes the user
//! manager's environment and not the daemon's, and every pane inherits the
//! server's. After a reboot that is the system default: no `~/.local/bin`, so
//! no `forge-runner`, `forge`, `claude` or `node`. On 2026-10-05 and again on
//! 2026-10-06 every master on sid-xeon-1 came up that way, and every plugin
//! hook failed "non-blocking", which is every gate those hooks carry off with
//! nothing saying so.
//!
//! So the runner builds the PATH itself and hands it to each pane, and refuses
//! to place one in which a binary the pane is going to exec resolves nowhere,
//! naming the binary and the PATH it searched.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// What every pane execs: this box's own CLI, which the master skill and the
/// hooks name, and the agent itself.
pub const ALWAYS: [&str; 2] = ["forge-runner", "claude"];

/// What the plugin's hooks and CLI exec, owed only where plugins are on.
pub const WITH_PLUGINS: [&str; 2] = ["node", "forge"];

/// The binaries a pane has to resolve, by whether this box installs plugins.
pub fn required(plugins_enabled: bool) -> Vec<&'static str> {
    let mut all = ALWAYS.to_vec();
    if plugins_enabled {
        all.extend(WITH_PLUGINS);
    }
    all
}

/// The PATH a pane is started with: the directory of this box's own
/// executable, the directory of the `claude` it resolved, `$HOME/.local/bin`,
/// then the daemon's own PATH, each directory once and in that order.
pub fn build(
    own_exe: Option<&Path>,
    claude: Option<&Path>,
    home: Option<&Path>,
    inherited: Option<&OsStr>,
) -> OsString {
    let mut dirs: Vec<PathBuf> = Vec::new();
    let mut add = |d: PathBuf| {
        if !d.as_os_str().is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    };
    for exe in [own_exe, claude].into_iter().flatten() {
        if let Some(parent) = exe.parent() {
            add(parent.to_path_buf());
        }
    }
    if let Some(home) = home {
        add(home.join(".local").join("bin"));
    }
    if let Some(inherited) = inherited {
        for d in std::env::split_paths(inherited) {
            add(d);
        }
    }
    std::env::join_paths(dirs).unwrap_or_default()
}

/// Which of `required` resolve in none of `path`'s directories.
pub fn missing<'a>(path: &OsStr, required: &[&'a str]) -> Vec<&'a str> {
    let cwd = Path::new(".");
    required
        .iter()
        .copied()
        .filter(|bin| which::which_in(bin, Some(path), cwd).is_err())
        .collect()
}

/// Why a pane was not placed: the binaries its PATH could not supply.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unresolved {
    pub missing: Vec<String>,
    pub path: String,
    /// The `claude` this box resolved to an absolute path, whose directory
    /// the PATH carries, or `None` where it resolved to none.
    pub claude: Option<String>,
}

impl std::fmt::Display for Unresolved {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let named: Vec<String> = self.missing.iter().map(|b| format!("`{b}`")).collect();
        let claude_dir = self.claude.as_deref().map(Path::new).and_then(Path::parent);
        let claude_missing = self.missing.iter().any(|b| b == "claude");
        // A person is told first what is wrong with `claude` where it is
        // missing and resolved nowhere (ISS-1223, judge j2b F7).
        if claude_dir.is_none() && claude_missing {
            write!(
                f,
                "`claude` is not installed on this box, or not on the PATH the runner service starts with: it resolved to no absolute path. "
            )?;
        }
        let claude_clause = match claude_dir {
            Some(dir) => format!(
                " the directory of the `claude` it resolved ({}),",
                dir.display()
            ),
            None if claude_missing => String::new(),
            None => " no directory for `claude`, which resolved to no absolute path,".to_string(),
        };
        let dirs = format!(
            "this runner's own directory,{claude_clause} `$HOME/.local/bin` and the runner service's own PATH"
        );
        write!(
            f,
            "{} resolve{} in none of the directories on the PATH this box builds for a pane ({}), so no pane is placed rather than one whose hooks and commands fail. That PATH is {dirs}: put each one in one of them",
            named.join(", "),
            if self.missing.len() == 1 { "s" } else { "" },
            self.path
        )
    }
}

/// The variable that names the `forge` CLI this daemon intends a pane to call
/// (ISS-1332).
pub const CLI_ENV: &str = "FORGE_CLI_PATH";

const CLI: &str = "forge";

/// The first `forge` on `path`, as the absolute path it was found at, or `None`
/// where there is none or the first is at a relative entry: a relative entry
/// names a different file from every directory a pane is in, and the next match
/// is another copy than the one the PATH puts first.
pub fn cli_on(path: &OsStr) -> Option<PathBuf> {
    for dir in std::env::split_paths(path) {
        if let Ok(found) = which::which_in(CLI, Some(&dir), Path::new(".")) {
            return (dir.is_absolute() && found.is_absolute()).then_some(found);
        }
    }
    None
}

/// What a pane placed now is started with from this module: its PATH, and the
/// `forge` that PATH resolves where it resolves one, or why no pane can be.
pub fn for_pane() -> Result<Vec<(String, String)>, Unresolved> {
    let own = crate::exe::own().ok().map(|o| o.path);
    let claude = PathBuf::from(crate::runner::process::resolve_claude_bin());
    let claude = claude.is_absolute().then_some(claude);
    #[expect(
        clippy::disallowed_methods,
        reason = "$HOME for $HOME/.local/bin on a pane's PATH, a read"
    )]
    let home = std::env::var_os("HOME").map(PathBuf::from);
    #[expect(clippy::disallowed_methods, reason = "the PATH a pane inherits")]
    let inherited = std::env::var_os("PATH");
    let path = build(
        own.as_deref(),
        claude.as_deref(),
        home.as_deref(),
        inherited.as_deref(),
    );
    let gone = missing(&path, &required_here());
    let shown = path.to_string_lossy().into_owned();
    if gone.is_empty() {
        let mut vars = vec![("PATH".to_string(), shown)];
        if let Some(cli) = cli_on(&path).as_deref().and_then(Path::to_str) {
            vars.push((CLI_ENV.to_string(), cli.to_string()));
        }
        Ok(vars)
    } else {
        Err(Unresolved {
            missing: gone.into_iter().map(str::to_string).collect(),
            path: shown,
            claude: claude.map(|c| c.to_string_lossy().into_owned()),
        })
    }
}

/// The paragraph of a master's brief on which `forge` to call, written from
/// what `env` is about to hand the pane, so it never describes a variable the
/// pane does not have.
pub fn cli_brief(env: &[(String, String)]) -> String {
    match env.iter().find(|(k, _)| k == CLI_ENV) {
        Some((_, path)) => format!(
            "\n## Which `forge`\n\nThis pane was started with `{CLI_ENV}={path}`, the `forge` CLI \
this daemon resolved on the PATH it built for you. Run it as `\"${CLI_ENV}\"` in place of the bare word \
`forge`, so the copy you call is the one this daemon intends. If `{CLI_ENV}` is unset, use the bare \
`forge`. If it is set and that path will not run, report the error and stop: do not fall through to \
another `forge`, which would run verbs from one build against a daemon from another.\n"
        ),
        None => format!(
            "\n## Which `forge`\n\n`{CLI_ENV}` was not exported to this pane: this daemon found no \
`forge` at an absolute entry of the PATH it built for you, so nothing here says which copy the bare word `forge` resolves \
to. If a `forge` command fails or answers as a different build than this daemon, report that and stop \
rather than reaching for another copy.\n"
        ),
    }
}

/// What this box requires of a pane's PATH: by its config in a running
/// daemon, and by what a test installed in a test build, where the binary is
/// the test harness rather than `forge-runner`.
#[cfg(not(test))]
fn required_here() -> Vec<&'static str> {
    required(
        crate::config::Config::load()
            .map(|c| c.plugins.enabled)
            .unwrap_or(true),
    )
}

#[cfg(test)]
fn required_here() -> Vec<&'static str> {
    testing::REQUIRED.with(|r| r.borrow().clone())
}

#[cfg(test)]
pub(crate) mod testing {
    use std::cell::RefCell;

    thread_local! {
        pub(super) static REQUIRED: RefCell<Vec<&'static str>> = const { RefCell::new(Vec::new()) };
    }

    /// Require `bins` of every pane this thread places until dropped.
    pub(crate) struct Requiring;

    impl Requiring {
        pub(crate) fn installed(bins: &[&'static str]) -> Self {
            REQUIRED.with(|r| *r.borrow_mut() = bins.to_vec());
            Self
        }
    }

    impl Drop for Requiring {
        fn drop(&mut self) {
            REQUIRED.with(|r| r.borrow_mut().clear());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn executable(path: &Path) {
        std::fs::write(path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(path).unwrap().permissions();
        std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
        std::fs::set_permissions(path, perms).unwrap();
    }

    /// A box with its own HOME: `forge-runner`, `forge` and `node` in
    /// `~/.local/bin`, `claude` under a versions directory, as sid-xeon-1 lays
    /// them out.
    struct Planted {
        root: crate::test_scratch::Scratch,
    }

    impl Planted {
        fn new() -> Self {
            let root = crate::test_scratch::Scratch::new("pane-path");
            let bin = root.join("home/.local/bin");
            std::fs::create_dir_all(&bin).unwrap();
            for b in ["forge-runner", "forge", "node"] {
                executable(&bin.join(b));
            }
            let versions = root.join("home/.local/share/claude/versions");
            std::fs::create_dir_all(&versions).unwrap();
            executable(&versions.join("claude"));
            Self { root }
        }
        fn home(&self) -> PathBuf {
            self.root.join("home")
        }
        fn own(&self) -> PathBuf {
            self.home().join(".local/bin/forge-runner")
        }
        fn claude(&self) -> PathBuf {
            self.home().join(".local/share/claude/versions/claude")
        }
    }

    /// ISS-1390 criterion 1.
    #[test]
    fn the_built_path_leads_with_the_runner_claude_and_local_bin_then_the_daemons_own() {
        let p = Planted::new();
        let inherited = format!(
            "{}:/usr/bin:{}",
            p.home().join(".local/bin").display(),
            "/bin"
        );
        let built = build(
            Some(&p.own()),
            Some(&p.claude()),
            Some(&p.home()),
            Some(OsStr::new(&inherited)),
        );
        let dirs: Vec<PathBuf> = std::env::split_paths(&built).collect();
        assert_eq!(
            dirs,
            vec![
                p.home().join(".local/bin"),
                p.home().join(".local/share/claude/versions"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/bin"),
            ],
            "each directory once, in that order"
        );
    }

    /// ISS-1390 criteria 3, 4 and 5, as a set.
    #[test]
    fn a_binary_missing_from_every_directory_is_named() {
        let p = Planted::new();
        // The daemon's own PATH is a directory this test plants, never the
        // host's: a runner image with a system `node` in /usr/bin kept
        // resolving it after the planted one was removed (PR #840, CI).
        let system = p.root.join("system-bin");
        std::fs::create_dir_all(&system).unwrap();
        executable(&system.join("sh-on-the-boot-path"));
        let built = build(
            Some(&p.own()),
            Some(&p.claude()),
            Some(&p.home()),
            Some(system.as_os_str()),
        );
        assert!(missing(&built, &required(true)).is_empty());
        assert!(
            missing(&built, &["sh-on-the-boot-path"]).is_empty(),
            "the daemon's own PATH is searched too"
        );
        std::fs::remove_file(p.home().join(".local/bin/node")).unwrap();
        assert_eq!(missing(&built, &required(true)), vec!["node"]);
        assert!(
            missing(&built, &required(false)).is_empty(),
            "with plugins off a missing node refuses nothing"
        );
        let bare = build(None, None, None, Some(system.as_os_str()));
        assert_eq!(
            missing(&bare, &required(false)),
            vec!["forge-runner", "claude"]
        );
    }

    #[test]
    fn the_refusal_names_each_binary_and_the_path_searched() {
        let said = Unresolved {
            missing: vec!["node".into(), "forge".into()],
            path: "/a:/b".into(),
            claude: Some("/opt/claude/bin/claude".into()),
        }
        .to_string();
        for part in [
            "`node`, `forge` resolve in none",
            "(/a:/b)",
            "no pane is placed",
            "the directory of the `claude` it resolved (/opt/claude/bin)",
        ] {
            assert!(said.contains(part), "`{part}` missing: {said}");
        }
    }

    /// ISS-1223 criterion 36 (judge j2b F7): where the missing `claude`
    /// resolved nowhere, the refusal opens by saying so in a person's terms,
    /// before any list of directories.
    #[test]
    fn a_missing_claude_that_resolved_nowhere_is_said_first() {
        let said = Unresolved {
            missing: vec!["claude".into(), "node".into()],
            path: "/a:/b".into(),
            claude: None,
        }
        .to_string();
        assert!(
            said.starts_with("`claude` is not installed on this box, or not on the PATH the runner service starts with: it resolved to no absolute path."),
            "{said}"
        );
    }

    /// ISS-1223 criterion 26: where `claude` resolved to no absolute path,
    /// no directory of it is on the PATH, and the refusal says so rather than
    /// naming the directory of a `claude` it resolved.
    #[test]
    fn a_refusal_with_no_claude_resolved_does_not_claim_one() {
        let said = Unresolved {
            missing: vec!["claude".into()],
            path: "/a:/b".into(),
            claude: None,
        }
        .to_string();
        assert!(!said.contains("the `claude` it resolved"), "{said}");
        assert!(said.contains("it resolved to no absolute path"), "{said}");
    }

    fn forge_in(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        executable(&dir.join("forge"));
    }

    /// ISS-1332 criteria 1 and 2.
    #[test]
    fn the_cli_is_the_first_forge_on_the_path() {
        let p = Planted::new();
        let second = p.root.join("second");
        forge_in(&second);
        let path = std::env::join_paths([p.home().join(".local/bin"), second.clone()]).unwrap();
        assert_eq!(
            cli_on(&path),
            Some(p.home().join(".local/bin/forge")),
            "the first, as found and not as a symlink resolves"
        );
        let reversed = std::env::join_paths([second.clone(), p.home().join(".local/bin")]).unwrap();
        assert_eq!(cli_on(&reversed), Some(second.join("forge")));
    }

    /// ISS-1332 criterion 3.
    #[test]
    fn a_path_with_no_forge_exports_nothing() {
        let p = Planted::new();
        let empty = p.root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert_eq!(cli_on(empty.as_os_str()), None);
        assert_eq!(cli_on(OsStr::new("")), None);
    }

    /// ISS-1332 criteria 5 and 6.
    #[test]
    fn a_forge_at_a_relative_entry_is_not_exported_and_the_next_match_is_not_taken() {
        let p = Planted::new();
        let here = std::env::current_dir().unwrap();
        let up = "../".repeat(here.components().count().saturating_sub(1));
        let relative = PathBuf::from(format!(
            "{up}{}",
            p.home()
                .join(".local/bin")
                .to_string_lossy()
                .trim_start_matches('/')
        ));
        assert!(relative.is_relative());
        assert!(
            which::which_in("forge", Some(&relative), Path::new(".")).is_ok(),
            "the relative entry does resolve a forge from here, so the refusal below is the rule's and not a miss"
        );
        let later = p.root.join("later");
        forge_in(&later);
        let path = std::env::join_paths([relative.clone(), later.clone()]).unwrap();
        assert_eq!(
            cli_on(&path),
            None,
            "relative first: nothing, and not the later copy"
        );
        let path = std::env::join_paths([later.clone(), relative]).unwrap();
        assert_eq!(cli_on(&path), Some(later.join("forge")));
    }

    fn world(
        p: &Planted,
    ) -> (
        crate::auth::cred_store::ScopedVar,
        crate::auth::cred_store::ScopedVar,
    ) {
        use crate::auth::cred_store::ScopedVar;
        (
            ScopedVar::set("HOME", p.home()),
            ScopedVar::set("PATH", p.root.join("system-bin")),
        )
    }

    /// ISS-1332 criterion 1, as `for_pane` hands it on: the variable is the
    /// `forge` the PATH it built resolves, an absolute path to an executable.
    #[test]
    fn a_pane_is_handed_the_forge_its_path_resolves() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let p = Planted::new();
        std::fs::create_dir_all(p.root.join("system-bin")).unwrap();
        let _w = world(&p);
        let _claude = crate::runner::process::testing::StubClaude::installed(&p.claude());
        let _req = testing::Requiring::installed(&["forge"]);
        let vars = for_pane().expect("a forge resolves");
        let cli = vars
            .iter()
            .find(|(k, _)| k == CLI_ENV)
            .map(|(_, v)| PathBuf::from(v))
            .expect("the variable is handed");
        assert_eq!(cli, p.home().join(".local/bin/forge"));
        assert!(cli.is_absolute() && cli.is_file());
        let path = vars
            .iter()
            .find(|(k, _)| k == "PATH")
            .expect("and the PATH");
        assert_eq!(cli_on(OsStr::new(&path.1)), Some(cli));
    }

    /// ISS-1332 criteria 3 and 4: with plugins off and no `forge` anywhere the
    /// pane is placed, and has no variable rather than an empty one.
    #[test]
    fn a_pane_with_no_forge_is_placed_without_the_variable() {
        let _env = crate::auth::cred_store::ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let p = Planted::new();
        std::fs::create_dir_all(p.root.join("system-bin")).unwrap();
        std::fs::remove_file(p.home().join(".local/bin/forge")).unwrap();
        let _w = world(&p);
        let _claude = crate::runner::process::testing::StubClaude::installed(&p.claude());
        let _req = testing::Requiring::installed(&[]);
        let vars = for_pane().expect("plugins are off, so nothing requires forge");
        assert!(vars.iter().any(|(k, _)| k == "PATH"));
        assert!(
            !vars.iter().any(|(k, _)| k == CLI_ENV),
            "no variable, which is not an empty one: {vars:?}"
        );
    }

    /// ISS-1332 criteria 7 and 8: the brief is written from what is exported.
    #[test]
    fn the_brief_names_the_variable_and_the_ladder_where_it_is_exported() {
        let said = cli_brief(&[(CLI_ENV.to_string(), "/home/x/.local/bin/forge".to_string())]);
        for part in [
            "FORGE_CLI_PATH=/home/x/.local/bin/forge",
            "\"$FORGE_CLI_PATH\"",
            "If `FORGE_CLI_PATH` is unset, use the bare `forge`",
            "report the error and stop",
            "do not fall through to another `forge`",
        ] {
            assert!(said.contains(part), "`{part}` missing: {said}");
        }
    }

    #[test]
    fn the_brief_says_none_was_exported_where_none_was() {
        let said = cli_brief(&[("PATH".to_string(), "/a".to_string())]);
        assert!(
            said.contains("`FORGE_CLI_PATH` was not exported to this pane"),
            "{said}"
        );
        assert!(
            !said.contains("\"$FORGE_CLI_PATH\""),
            "it names no variable the pane lacks: {said}"
        );
    }
}
