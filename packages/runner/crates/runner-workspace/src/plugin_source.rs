//! Which plugin checkout the panes this runner spawns load: `[plugins] checkout` and `ref`.
//!
//! Runners on one box share the Claude config dir, so a plugin registered there is every
//! runner's. A runner whose `[plugins] checkout` names a marketplace checkout hands each pane it
//! spawns a `--plugin-dir` for every plugin it serves from there, and a `--settings` turning off
//! the registered plugins of the same names, so a pane never runs both sets of hooks.
//!
//! Claude Code skips a `--plugin-dir` that does not exist with nothing but a warning, and by then
//! the registered plugin is off: that pane would run with neither. So the directories are checked
//! again at every spawn, and a missing one refuses the spawn rather than starting it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use runner_platform::config::PluginSettings;

/// One plugin a checkout serves: its name and the directory `--plugin-dir` is handed.
#[derive(Debug, Clone, PartialEq)]
pub struct ServedPlugin {
    pub name: String,
    pub dir: PathBuf,
}

/// A `[plugins] checkout` this runner resolved and accepted.
#[derive(Debug, Clone, PartialEq)]
pub struct PluginSource {
    pub checkout: PathBuf,
    pub git_ref: Option<String>,
    pub plugins: Vec<ServedPlugin>,
}

impl PluginSource {
    pub fn serves(&self, name: &str) -> bool {
        self.plugins.iter().any(|p| p.name == name)
    }
}

const MARKETPLACE: &str = ".claude-plugin/marketplace.json";
const PLUGIN_MANIFEST: &str = ".claude-plugin/plugin.json";
const GIT_TIMEOUT: Duration = Duration::from_secs(120);

/// `[plugins] checkout` and `ref` resolved against this box, `None` where no checkout is set.
/// Every way the pair can be wrong is refused here naming the key, the value and what is valid.
pub async fn resolve(settings: &PluginSettings) -> Result<Option<PluginSource>, String> {
    let Some(checkout) = settings.checkout.as_deref() else {
        if let Some(r) = &settings.git_ref {
            return Err(format!(
                "`[plugins] ref = \"{r}\"` names the branch a plugin checkout is kept at, and no \
                 `[plugins] checkout` is set: set `checkout` to that checkout's absolute path, or \
                 remove `ref`"
            ));
        }
        return Ok(None);
    };
    if !settings.enabled {
        return Err(format!(
            "`[plugins] checkout = \"{}\"` is set while `[plugins] enabled = false`: a device \
             opted out of plugins loads none. Remove `checkout`, or set `enabled = true`",
            checkout.display()
        ));
    }
    if let Some(pin) = &settings.pinned_ref {
        return Err(format!(
            "`[plugins] pinned_ref = \"{pin}\"` pins the marketplace clone, which `[plugins] \
             checkout` replaces: name the branch to keep the checkout at with `ref`, and remove \
             `pinned_ref`"
        ));
    }
    let plugins = read_checkout(checkout, &settings.plugin_names)?;
    if let Some(r) = settings.git_ref.as_deref() {
        check_ref(checkout, r).await?;
    }
    Ok(Some(PluginSource {
        checkout: checkout.to_path_buf(),
        git_ref: settings.git_ref.clone(),
        plugins,
    }))
}

/// The plugins `names` the marketplace checkout at `checkout` serves, each found in its
/// `marketplace.json` and in a directory inside it whose `plugin.json` carries that name.
pub fn read_checkout(checkout: &Path, names: &[String]) -> Result<Vec<ServedPlugin>, String> {
    let at = |why: String| format!("`[plugins] checkout = \"{}\"` {why}", checkout.display());
    if !checkout.is_absolute() {
        return Err(at(
            "is a relative path: name the plugin checkout by an absolute path".into(),
        ));
    }
    if !checkout.is_dir() {
        return Err(at("is not a directory on this box".into()));
    }
    let manifest = checkout.join(MARKETPLACE);
    let raw = std::fs::read_to_string(&manifest).map_err(|e| {
        at(format!(
            "is not a plugin marketplace checkout: {} cannot be read ({e})",
            manifest.display()
        ))
    })?;
    let doc: serde_json::Value = serde_json::from_str(&raw)
        .map_err(|e| at(format!("holds a {MARKETPLACE} that is not JSON ({e})")))?;
    let listed = doc
        .get("plugins")
        .and_then(|p| p.as_array())
        .ok_or_else(|| at(format!("holds a {MARKETPLACE} with no `plugins` list")))?;
    if names.is_empty() {
        return Err(at(
            "serves nothing: `[plugins] plugin_names` is empty, so no plugin is named to load from it"
                .into(),
        ));
    }
    names
        .iter()
        .map(|name| served(checkout, listed, name).map_err(at))
        .collect()
}

fn served(
    checkout: &Path,
    listed: &[serde_json::Value],
    name: &str,
) -> Result<ServedPlugin, String> {
    let entry = listed
        .iter()
        .find(|p| p.get("name").and_then(|n| n.as_str()) == Some(name))
        .ok_or_else(|| {
            let has: Vec<&str> = listed
                .iter()
                .filter_map(|p| p.get("name").and_then(|n| n.as_str()))
                .collect();
            format!(
                "lists no plugin `{name}` in its {MARKETPLACE}; it lists {}",
                has.join(", ")
            )
        })?;
    let source = entry.get("source").and_then(|s| s.as_str());
    let rel = source
        .map(|s| Path::new(s.trim_start_matches("./")))
        .filter(|p| {
            p.components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        })
        .ok_or_else(|| {
            format!("serves `{name}` from {source:?}, which is not a directory inside the checkout")
        })?;
    let dir = checkout.join(rel);
    let declared = std::fs::read_to_string(dir.join(PLUGIN_MANIFEST))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("name")?.as_str().map(str::to_owned));
    if declared.as_deref() != Some(name) {
        return Err(format!(
            "serves `{name}` from {}, which holds no {PLUGIN_MANIFEST} naming `{name}`",
            dir.display()
        ));
    }
    Ok(ServedPlugin {
        name: name.to_string(),
        dir,
    })
}

/// `r` is a branch on `checkout`'s `origin`, and the branch the checkout has checked out.
async fn check_ref(checkout: &Path, r: &str) -> Result<(), String> {
    let shown = checkout.display();
    let tracking = format!("refs/remotes/origin/{r}");
    let commit = format!("{tracking}^{{commit}}");
    if git_out(checkout, &["rev-parse", "--verify", "--quiet", &commit])
        .await
        .is_err()
    {
        return Err(format!(
            "`[plugins] ref = \"{r}\"` is not a branch on {shown}'s origin: it has no {tracking}. \
             Name a branch `git -C {shown} branch -r` lists, or `git -C {shown} fetch origin {r}` \
             if it was pushed since"
        ));
    }
    on_branch(checkout, r).await
}

async fn on_branch(checkout: &Path, r: &str) -> Result<(), String> {
    let head = git_out(checkout, &["symbolic-ref", "--quiet", "HEAD"])
        .await
        .ok();
    if head.as_deref() == Some(format!("refs/heads/{r}").as_str()) {
        return Ok(());
    }
    let held = head.map_or_else(
        || "a detached HEAD".to_string(),
        |h| h.replace("refs/heads/", ""),
    );
    Err(format!(
        "`[plugins] ref = \"{r}\"`: {} has {held} checked out, not `{r}`, and the runner does not \
         move its owner's checkout off a branch. `git -C {} switch {r}`, or change `ref`",
        checkout.display(),
        checkout.display()
    ))
}

/// Keep the checkout at its `ref`: fetch it and fast-forward the branch, or say why not and leave
/// the checkout where it is. The short HEAD it then holds.
pub async fn sync(source: &PluginSource) -> Result<String, String> {
    let dir = source.checkout.as_path();
    if let Some(r) = source.git_ref.as_deref() {
        git_out(dir, &["fetch", "--quiet", "origin", r]).await?;
        on_branch(dir, r).await?;
        let upstream = format!("origin/{r}");
        git_out(dir, &["merge", "--ff-only", "--quiet", &upstream])
            .await
            .map_err(|e| {
                format!(
                    "{} could not be fast-forwarded to {upstream}, so it is left where it was: {e}",
                    dir.display()
                )
            })?;
    }
    git_out(dir, &["rev-parse", "--short", "HEAD"]).await
}

async fn git_out(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    runner_platform::git::non_interactive(&mut cmd);
    let out = tokio::time::timeout(GIT_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("git {} timed out", args.join(" ")))?
        .map_err(|e| format!("git {}: {e}", args.join(" ")))?;
    if out.status.success() {
        return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
    }
    Err(format!(
        "git {}: {}",
        args.join(" "),
        runner_platform::git::strip_userinfo(String::from_utf8_lossy(&out.stderr).trim())
    ))
}

/// What a pane is launched with to load a checkout's plugins: a `--plugin-dir` each, and the
/// registered plugins of the same names turned off. Empty where no checkout is set.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PluginLaunch {
    pub dirs: Vec<PathBuf>,
    pub disabled: Vec<String>,
}

impl PluginLaunch {
    /// The `--settings` JSON this launch needs, merged with every hook off where `hooks_off`;
    /// `None` where it needs none.
    pub fn settings(&self, hooks_off: bool) -> Option<String> {
        if self.disabled.is_empty() && !hooks_off {
            return None;
        }
        let mut doc = serde_json::Map::new();
        if hooks_off {
            doc.insert("disableAllHooks".into(), serde_json::Value::Bool(true));
        }
        if !self.disabled.is_empty() {
            let off = self
                .disabled
                .iter()
                .map(|id| (id.clone(), serde_json::Value::Bool(false)))
                .collect();
            doc.insert("enabledPlugins".into(), serde_json::Value::Object(off));
        }
        Some(serde_json::Value::Object(doc).to_string())
    }

    /// The flags this launch adds to a `claude` command line, each value its own argument.
    pub fn args(&self, hooks_off: bool) -> Vec<String> {
        let mut out = Vec::new();
        for dir in &self.dirs {
            out.push("--plugin-dir".to_string());
            out.push(dir.to_string_lossy().into_owned());
        }
        if let Some(settings) = self.settings(hooks_off) {
            out.push("--settings".to_string());
            out.push(settings);
        }
        out
    }
}

/// The launch `source` gives a pane now, its directories checked to still hold their plugins.
/// `claude_dir` is the Claude config dir the registered plugins are read from.
pub fn launch_for(
    source: Option<&PluginSource>,
    claude_dir: Option<&Path>,
) -> Result<PluginLaunch, String> {
    let Some(source) = source else {
        return Ok(PluginLaunch::default());
    };
    for p in &source.plugins {
        if !p.dir.join(PLUGIN_MANIFEST).is_file() {
            return Err(format!(
                "[PLUGIN_CHECKOUT_GONE] `[plugins] checkout = \"{}\"` serves `{}` from {}, which \
                 no longer holds {PLUGIN_MANIFEST}: no pane is started, because Claude Code would \
                 skip the directory and run the pane with no `{}` plugin at all",
                source.checkout.display(),
                p.name,
                p.dir.display(),
                p.name
            ));
        }
    }
    let names: Vec<&str> = source.plugins.iter().map(|p| p.name.as_str()).collect();
    Ok(PluginLaunch {
        dirs: source.plugins.iter().map(|p| p.dir.clone()).collect(),
        disabled: claude_dir.map_or_else(Vec::new, |d| registered_ids(d, &names)),
    })
}

/// Every plugin id `<name>@<marketplace>` for one of `names` that the Claude config dir `claude`
/// installs or enables, sorted: the ones a pane loading a checkout's copy turns off.
pub fn registered_ids(claude: &Path, names: &[&str]) -> Vec<String> {
    let keys = |path: PathBuf, field: &str| -> Vec<String> {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| {
                v.get(field)?
                    .as_object()
                    .map(|m| m.keys().cloned().collect())
            })
            .unwrap_or_default()
    };
    let mut ids: Vec<String> = keys(
        claude.join("plugins").join("installed_plugins.json"),
        "plugins",
    )
    .into_iter()
    .chain(keys(claude.join("settings.json"), "enabledPlugins"))
    .filter(|id| {
        id.split_once('@')
            .is_some_and(|(name, _)| names.contains(&name))
    })
    .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// The source this daemon resolved at start, which every pane it spawns loads from.
static INSTALLED: OnceLock<Option<PluginSource>> = OnceLock::new();

/// Record the source this daemon resolved; called once, at daemon start.
pub fn install(source: Option<PluginSource>) {
    if INSTALLED.set(source).is_err() {
        tracing::warn!("[plugins] the plugin source was already recorded for this process");
    }
}

pub fn installed() -> Option<&'static PluginSource> {
    INSTALLED.get().and_then(Option::as_ref)
}

/// The launch a pane this daemon spawns now takes, or the refusal naming why none can start.
pub fn pane_launch() -> Result<PluginLaunch, String> {
    launch_for(
        installed(),
        crate::plugin_sync::claude_config_dir().as_deref(),
    )
}

/// One `name@checkout version head` line per plugin `source` serves, for a digest of what a pane
/// loads: it moves when the checkout's HEAD or a plugin's version does.
pub fn identity(source: &PluginSource) -> Vec<String> {
    let head = std::process::Command::new("git")
        .arg("-C")
        .arg(&source.checkout)
        .args(["rev-parse", "HEAD"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "-".to_string());
    let head = head.get(..8).unwrap_or(&head).to_string();
    source
        .plugins
        .iter()
        .map(|p| {
            let version = std::fs::read_to_string(p.dir.join(PLUGIN_MANIFEST))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("version")?.as_str().map(str::to_owned))
                .unwrap_or_else(|| "?".to_string());
            format!("{}@checkout {version} {head}", p.name)
        })
        .collect()
}

#[cfg(test)]
#[path = "plugin_source_tests.rs"]
mod tests;
