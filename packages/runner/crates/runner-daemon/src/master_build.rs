//! Whether a resident master pane runs what this box would place now.
//!
//! A pane loads the runner's hooks and its forge-master skill, and Claude
//! Code's plugins, once, when it starts; none of them reloads in a running
//! pane. An update that replaces the daemon therefore leaves every pane it
//! adopted on the build and the plugins it was placed under, and before
//! ISS-1379 nothing said so: the old panes went on being nudged and went on
//! running what the update was installed to replace.
//!
//! This is the judgement and nothing else. When a pane judged outdated may be
//! replaced is `master.rs`'s, and it never replaces one holding work.

use std::path::Path;

use runner_core::ledger::MasterRow;

/// What this box would place a pane under now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    /// This process's build, as `update::VERSION_LINE` reads.
    pub build: String,
    /// The installed plugin set, as [`plugin_set`] writes it; `None` where it
    /// could not be read.
    pub plugins: Option<String>,
}

impl Standing {
    /// This process's build and the plugins Claude Code would load for a pane
    /// in `repo`.
    pub fn this_box(repo: &Path) -> Self {
        Standing {
            build: runner_update::VERSION_LINE.to_string(),
            plugins: runner_workspace::plugin_sync::claude_config_dir()
                .and_then(|dir| plugin_set(&dir, repo)),
        }
    }
}

/// A pane's verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Judged {
    Current,
    /// Outdated, and why, naming what it was placed under and what stands now.
    Outdated(String),
}

/// Judge the pane `row` records against what stands now.
///
/// A pane whose placement build was never recorded is outdated: it was placed
/// by a build that did not record one, which is older than this one, or
/// adopted by a box that never placed it. Where either plugin set is unknown
/// the build alone decides, since an unread set is no evidence of a change.
pub fn judge(row: Option<&MasterRow>, now: &Standing) -> Judged {
    let Some(build) = row.and_then(|r| r.placed_build.as_deref()) else {
        return Judged::Outdated(format!(
            "this box never recorded the build it was placed under, and runs {} now",
            now.build
        ));
    };
    if build != now.build {
        return Judged::Outdated(format!(
            "placed under runner {build}, and this box runs {} now",
            now.build
        ));
    }
    let placed = row.and_then(|r| r.placed_plugins.as_deref());
    match (placed, now.plugins.as_deref()) {
        (Some(placed), Some(installed)) if placed != installed => Judged::Outdated(format!(
            "placed with plugins [{placed}], and [{installed}] are installed now"
        )),
        _ => Judged::Current,
    }
}

/// The plugins Claude Code would load for a session in `repo`, read from
/// `installed_plugins.json` under the Claude config directory `config`: every
/// user-scoped install, and every install scoped to `repo` itself, each as its
/// id, version and the first eight characters of its commit, sorted and joined.
/// `None` where the file cannot be read or does not have the shape Claude Code
/// writes.
pub fn plugin_set(config: &Path, repo: &Path) -> Option<String> {
    let raw =
        std::fs::read_to_string(config.join("plugins").join("installed_plugins.json")).ok()?;
    let doc: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let plugins = doc.get("plugins")?.as_object()?;
    let mut set = Vec::new();
    for (id, installs) in plugins {
        for install in installs.as_array()? {
            let scope = install.get("scope").and_then(|s| s.as_str()).unwrap_or("");
            let here = install
                .get("projectPath")
                .and_then(|p| p.as_str())
                .is_some_and(|p| Path::new(p) == repo);
            if scope != "user" && !here {
                continue;
            }
            let version = install
                .get("version")
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let sha = install
                .get("gitCommitSha")
                .and_then(|v| v.as_str())
                .map(|s| s.get(..8).unwrap_or(s))
                .unwrap_or("-");
            set.push(format!("{id} {version} {sha}"));
        }
    }
    set.sort();
    Some(set.join(", "))
}
