use super::*;

use std::process::Command;

struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("plugin-source-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        Scratch(dir)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args([
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "-c",
            "commit.gpgsign=false",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

fn write(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

/// A marketplace at `root` serving `forge` from `./plugin`, as forge-plugin lays itself out.
fn lay_out_marketplace(root: &Path, version: &str) {
    write(
        &root.join(MARKETPLACE),
        r#"{"name":"forge-local","plugins":[
            {"name":"forge","source":"./plugin"},
            {"name":"code-quality","source":"./packages/code-quality/claude-plugin"}]}"#,
    );
    write(
        &root.join("plugin").join(PLUGIN_MANIFEST),
        &format!(r#"{{"name":"forge","version":"{version}"}}"#),
    );
}

/// An upstream repository on branch `dev` and a clone of it, the checkout a runner is pointed at.
fn upstream_and_checkout(s: &Scratch) -> (PathBuf, PathBuf) {
    let upstream = s.0.join("upstream");
    std::fs::create_dir_all(&upstream).unwrap();
    git(&upstream, &["init", "--quiet", "-b", "dev"]);
    lay_out_marketplace(&upstream, "1.0.0");
    git(&upstream, &["add", "."]);
    git(&upstream, &["commit", "--quiet", "-m", "one"]);
    let checkout = s.0.join("checkout");
    git(
        &s.0,
        &[
            "clone",
            "--quiet",
            &upstream.to_string_lossy(),
            &checkout.to_string_lossy(),
        ],
    );
    (upstream, checkout)
}

fn settings(checkout: Option<&Path>, r: Option<&str>) -> PluginSettings {
    PluginSettings {
        checkout: checkout.map(Path::to_path_buf),
        git_ref: r.map(str::to_string),
        ..PluginSettings::default()
    }
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|n| (*n).to_string()).collect()
}

#[tokio::test]
async fn no_checkout_resolves_to_nothing_and_launches_with_no_flag() {
    assert_eq!(resolve(&PluginSettings::default()).await, Ok(None));
    let launch = launch_for(None, Some(Path::new("/nonexistent"))).unwrap();
    assert_eq!(launch, PluginLaunch::default());
    assert!(launch.args(false).is_empty());
    assert_eq!(launch.settings(false), None);
    assert_eq!(
        launch.settings(true).as_deref(),
        Some(r#"{"disableAllHooks":true}"#),
        "a hooks-off session with no checkout must keep the settings it was spawned with before"
    );
}

#[tokio::test]
async fn a_checkout_on_its_ref_resolves_to_the_plugin_directory_its_marketplace_names() {
    let s = Scratch::new();
    let (_, checkout) = upstream_and_checkout(&s);
    let source = resolve(&settings(Some(&checkout), Some("dev")))
        .await
        .unwrap()
        .expect("a valid checkout resolved to nothing");
    assert_eq!(
        source.plugins,
        vec![ServedPlugin {
            name: "forge".into(),
            dir: checkout.join("plugin")
        }]
    );
    assert!(source.serves("forge") && !source.serves("code-quality"));
}

#[tokio::test]
async fn a_ref_with_no_checkout_is_refused_by_name() {
    let err = resolve(&settings(None, Some("dev"))).await.unwrap_err();
    assert!(err.contains("`[plugins] ref = \"dev\"`"), "{err}");
    assert!(err.contains("no `[plugins] checkout` is set"), "{err}");
}

#[tokio::test]
async fn a_checkout_beside_a_disabled_channel_or_a_pin_is_refused_by_name() {
    let s = Scratch::new();
    let (_, checkout) = upstream_and_checkout(&s);
    let mut off = settings(Some(&checkout), None);
    off.enabled = false;
    let err = resolve(&off).await.unwrap_err();
    assert!(err.contains("`[plugins] enabled = false`"), "{err}");
    let mut pinned = settings(Some(&checkout), None);
    pinned.pinned_ref = Some("abc123".into());
    let err = resolve(&pinned).await.unwrap_err();
    assert!(err.contains("`[plugins] pinned_ref = \"abc123\"`"), "{err}");
}

#[test]
fn a_path_that_is_not_a_marketplace_checkout_is_refused_naming_what_it_lacks() {
    let s = Scratch::new();
    let err = read_checkout(Path::new("plugins/forge"), &names(&["forge"])).unwrap_err();
    assert!(err.contains("is a relative path"), "{err}");
    let err = read_checkout(&s.0.join("absent"), &names(&["forge"])).unwrap_err();
    assert!(err.contains("is not a directory on this box"), "{err}");
    let err = read_checkout(&s.0, &names(&["forge"])).unwrap_err();
    assert!(
        err.contains("is not a plugin marketplace checkout"),
        "{err}"
    );
    assert!(err.contains(MARKETPLACE), "{err}");
    assert!(
        err.starts_with(&format!("`[plugins] checkout = \"{}\"`", s.0.display())),
        "{err}"
    );
}

#[test]
fn a_plugin_the_marketplace_does_not_list_or_cannot_serve_is_refused_by_name() {
    let s = Scratch::new();
    lay_out_marketplace(&s.0, "1.0.0");
    let err = read_checkout(&s.0, &names(&["forge-dev"])).unwrap_err();
    assert!(err.contains("lists no plugin `forge-dev`"), "{err}");
    assert!(err.contains("it lists forge, code-quality"), "{err}");
    let err = read_checkout(&s.0, &names(&["code-quality"])).unwrap_err();
    assert!(
        err.contains("holds no .claude-plugin/plugin.json naming `code-quality`"),
        "{err}"
    );
    let err = read_checkout(&s.0, &[]).unwrap_err();
    assert!(err.contains("`[plugins] plugin_names` is empty"), "{err}");
    write(
        &s.0.join(MARKETPLACE),
        r#"{"plugins":[{"name":"forge","source":"../elsewhere"}]}"#,
    );
    let err = read_checkout(&s.0, &names(&["forge"])).unwrap_err();
    assert!(err.contains("not a directory inside the checkout"), "{err}");
}

#[tokio::test]
async fn a_ref_that_is_not_a_branch_on_origin_is_refused_by_name() {
    let s = Scratch::new();
    let (_, checkout) = upstream_and_checkout(&s);
    let err = resolve(&settings(Some(&checkout), Some("nope")))
        .await
        .unwrap_err();
    assert!(
        err.contains("`[plugins] ref = \"nope\"` is not a branch"),
        "{err}"
    );
    assert!(err.contains("refs/remotes/origin/nope"), "{err}");
}

#[tokio::test]
async fn a_checkout_holding_another_branch_than_its_ref_is_refused_and_not_moved() {
    let s = Scratch::new();
    let (_, checkout) = upstream_and_checkout(&s);
    git(&checkout, &["switch", "--quiet", "-c", "mine"]);
    let err = resolve(&settings(Some(&checkout), Some("dev")))
        .await
        .unwrap_err();
    assert!(err.contains("has mine checked out, not `dev`"), "{err}");
    assert_eq!(git(&checkout, &["branch", "--show-current"]), "mine");
}

#[tokio::test]
async fn the_sweep_fast_forwards_the_checkout_to_its_ref() {
    let s = Scratch::new();
    let (upstream, checkout) = upstream_and_checkout(&s);
    let source = resolve(&settings(Some(&checkout), Some("dev")))
        .await
        .unwrap()
        .unwrap();
    lay_out_marketplace(&upstream, "1.0.1");
    git(&upstream, &["commit", "--quiet", "-am", "two"]);
    let tip = git(&upstream, &["rev-parse", "--short", "HEAD"]);
    assert_eq!(sync(&source).await.as_deref(), Ok(tip.as_str()));
    let line = identity(&source);
    assert_eq!(line.len(), 1);
    assert!(line[0].starts_with("forge@checkout 1.0.1 "), "{line:?}");
}

#[tokio::test]
async fn a_checkout_that_cannot_fast_forward_is_left_where_it_was() {
    let s = Scratch::new();
    let (upstream, checkout) = upstream_and_checkout(&s);
    let source = resolve(&settings(Some(&checkout), Some("dev")))
        .await
        .unwrap()
        .unwrap();
    git(
        &upstream,
        &["commit", "--quiet", "--allow-empty", "-m", "theirs"],
    );
    git(
        &checkout,
        &["commit", "--quiet", "--allow-empty", "-m", "mine"],
    );
    let before = git(&checkout, &["rev-parse", "HEAD"]);
    let err = sync(&source).await.unwrap_err();
    assert!(
        err.contains("could not be fast-forwarded to origin/dev"),
        "{err}"
    );
    assert_eq!(git(&checkout, &["rev-parse", "HEAD"]), before);
}

#[test]
fn a_launch_turns_off_the_registered_plugins_of_the_names_it_serves_and_no_other() {
    let s = Scratch::new();
    lay_out_marketplace(&s.0.join("co"), "1.0.0");
    let claude = s.0.join("claude");
    write(
        &claude.join("plugins").join("installed_plugins.json"),
        r#"{"version":2,"plugins":{"forge@forge-local":[],"forge-codemap@forge":[]}}"#,
    );
    write(
        &claude.join("settings.json"),
        r#"{"enabledPlugins":{"forge@forge-local":true,"forge@other":true,"rust@x":true}}"#,
    );
    let source = PluginSource {
        checkout: s.0.join("co"),
        git_ref: None,
        plugins: vec![ServedPlugin {
            name: "forge".into(),
            dir: s.0.join("co").join("plugin"),
        }],
    };
    let launch = launch_for(Some(&source), Some(&claude)).unwrap();
    assert_eq!(launch.disabled, vec!["forge@forge-local", "forge@other"]);
    let dir = s.0.join("co").join("plugin").to_string_lossy().into_owned();
    let off = r#"{"enabledPlugins":{"forge@forge-local":false,"forge@other":false}}"#;
    assert_eq!(
        launch.args(false),
        vec!["--plugin-dir", dir.as_str(), "--settings", off]
    );
    assert_eq!(
        launch.settings(true).as_deref(),
        Some(
            r#"{"disableAllHooks":true,"enabledPlugins":{"forge@forge-local":false,"forge@other":false}}"#
        )
    );
}

#[test]
fn a_pane_is_refused_when_the_checkout_no_longer_holds_its_plugin() {
    let s = Scratch::new();
    let source = PluginSource {
        checkout: s.0.clone(),
        git_ref: None,
        plugins: vec![ServedPlugin {
            name: "forge".into(),
            dir: s.0.join("plugin"),
        }],
    };
    let err = launch_for(Some(&source), None).unwrap_err();
    assert!(err.starts_with("[PLUGIN_CHECKOUT_GONE]"), "{err}");
    assert!(err.contains("no pane is started"), "{err}");
}
