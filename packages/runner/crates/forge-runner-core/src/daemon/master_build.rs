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

use crate::runner::ledger::MasterRow;

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
            build: crate::update::VERSION_LINE.to_string(),
            plugins: crate::workspace::plugin_sync::claude_config_dir()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;

    fn row(build: Option<&str>, plugins: Option<&str>) -> MasterRow {
        MasterRow {
            project_id: "proj-1".into(),
            pane_name: "forge-master-p".into(),
            conversation_id: Some("conv".into()),
            session_id: Some("sess".into()),
            boot_id: "boot-a".into(),
            cold_started_at: 1,
            last_seen_at: 1,
            placed_build: build.map(str::to_string),
            placed_plugins: plugins.map(str::to_string),
            placed_at: build.map(|_| 1),
            outdated: None,
            unattributed: None,
        }
    }

    fn now(build: &str, plugins: Option<&str>) -> Standing {
        Standing {
            build: build.into(),
            plugins: plugins.map(str::to_string),
        }
    }

    #[test]
    fn a_pane_placed_under_another_build_is_outdated_naming_both() {
        let said = judge(
            Some(&row(Some("0.9.1 (aaaa)"), Some("p 1 x"))),
            &now("0.9.2 (bbbb)", Some("p 1 x")),
        );
        let Judged::Outdated(why) = said else {
            panic!("criterion 21: {said:?}")
        };
        assert!(
            why.contains("0.9.1 (aaaa)") && why.contains("0.9.2 (bbbb)"),
            "{why}"
        );
    }

    #[test]
    fn a_pane_placed_under_another_plugin_set_is_outdated_naming_both() {
        let said = judge(
            Some(&row(Some("0.9.2 (bbbb)"), Some("forge 3.36.1 867ef128"))),
            &now("0.9.2 (bbbb)", Some("forge 3.36.2 9a0b1c2d")),
        );
        let Judged::Outdated(why) = said else {
            panic!("criterion 22: {said:?}")
        };
        assert!(
            why.contains("forge 3.36.1 867ef128") && why.contains("forge 3.36.2 9a0b1c2d"),
            "{why}"
        );
    }

    #[test]
    fn a_pane_whose_build_was_never_recorded_is_outdated() {
        for r in [None, Some(row(None, None))] {
            assert!(
                matches!(
                    judge(r.as_ref(), &now("0.9.2 (bbbb)", None)),
                    Judged::Outdated(_)
                ),
                "criterion 23: {r:?}"
            );
        }
    }

    #[test]
    fn an_unread_plugin_set_leaves_the_build_to_judge() {
        let same = row(Some("0.9.2 (bbbb)"), Some("forge 3.36.1 867ef128"));
        assert_eq!(
            judge(Some(&same), &now("0.9.2 (bbbb)", None)),
            Judged::Current
        );
        let unread_then = row(Some("0.9.2 (bbbb)"), None);
        assert_eq!(
            judge(
                Some(&unread_then),
                &now("0.9.2 (bbbb)", Some("forge 3.36.2 9a0b1c2d"))
            ),
            Judged::Current,
            "criterion 24"
        );
        assert!(matches!(
            judge(Some(&unread_then), &now("0.9.3 (cccc)", None)),
            Judged::Outdated(_)
        ));
        assert_eq!(
            judge(
                Some(&row(Some("0.9.2 (bbbb)"), Some("forge 3.36.1 867ef128"))),
                &now("0.9.2 (bbbb)", Some("forge 3.36.1 867ef128"))
            ),
            Judged::Current
        );
    }

    #[test]
    fn the_plugin_set_is_the_user_installs_and_this_repos_own_sorted() {
        let config = Scratch::new("master-build-plugins");
        std::fs::create_dir_all(config.join("plugins")).unwrap();
        std::fs::write(
            config.join("plugins").join("installed_plugins.json"),
            r#"{"version":2,"plugins":{
                "forge@forge-local":[{"scope":"user","version":"3.36.542","gitCommitSha":"867ef128cec692bbcf4780066fddc2bd350e06a0"}],
                "codemap@forge":[{"scope":"user","version":"0.20.0","gitCommitSha":"c98b3fff96a28129a55c786ad22cb0773aa61112"}],
                "here@m":[{"scope":"project","projectPath":"/repo/a","version":"1.0.0"}],
                "elsewhere@m":[{"scope":"project","projectPath":"/repo/b","version":"2.0.0"}]
            }}"#,
        )
        .unwrap();
        assert_eq!(
            plugin_set(&config, Path::new("/repo/a")).as_deref(),
            Some("codemap@forge 0.20.0 c98b3fff, forge@forge-local 3.36.542 867ef128, here@m 1.0.0 -")
        );
        assert_eq!(
            plugin_set(&config.join("absent"), Path::new("/repo/a")),
            None
        );
        std::fs::write(
            config.join("plugins").join("installed_plugins.json"),
            r#"{"plugins":["not","a","map"]}"#,
        )
        .unwrap();
        assert_eq!(
            plugin_set(&config, Path::new("/repo/a")),
            None,
            "a shape Claude Code does not write is unread, not empty"
        );
    }
}
