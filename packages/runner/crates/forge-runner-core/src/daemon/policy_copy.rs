//! The copy of the policy a run is decided under, as this box names it to core (ISS-1303).
//!
//! The policy, which work to take and in what order, is forge-plugin's, so the version that
//! decided a run is a copy of the `forge` plugin. What this box can say is the copy its master
//! pane loaded, because the pane's run subagents execute inside that process and Claude Code
//! loads its plugins once, when the pane starts. Core stamps what is said here and nothing else:
//! a project's designation is what a box was asked to run, which is not what ran.
//!
//! A copy is named only on evidence that it loaded. An install registry entry is not that:
//! `claude plugin list` reports a plugin no settings layer enables as disabled, so the install
//! registry alone would name a copy that never ran. Where one copy cannot be established the box
//! says which way it could not, and core records that instead of a guess.
//!
//! Core refuses a copy it cannot read and a refusal ends the run's declaration (ISS-1284), so the
//! bounds below are core's own, `packages/core/src/devices/policy-copy.ts`, held in one fixture
//! both sides assert.

use std::path::Path;

use serde_json::{json, Value};

use crate::error::Result;
use crate::runner::ledger::Ledger;

/// The plugin whose copy is the policy: forge-plugin's, named by the id Claude Code keys an
/// install by, `<name>@<marketplace>`.
pub const POLICY_PLUGIN: &str = "forge";

/// Why this box named no copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unnamed {
    /// What the pane loaded could not be read, or the pane was adopted and never placed.
    PluginsUnknown,
    /// No `forge` plugin is installed for this pane.
    PolicyPluginAbsent,
    /// A `forge` plugin is installed and no settings layer enables it for the repo.
    PolicyPluginNotEnabled,
    /// More than one enabled `forge` install applies, so which one loaded is not known.
    MoreThanOneCopy,
    /// An install is there and one of its fields is not one core can read.
    CopyUnreadable,
    /// The run was declared by a build that recorded no copy.
    NotRecorded,
}

impl Unnamed {
    const SENDABLE: [Unnamed; 6] = [
        Unnamed::PluginsUnknown,
        Unnamed::PolicyPluginAbsent,
        Unnamed::PolicyPluginNotEnabled,
        Unnamed::MoreThanOneCopy,
        Unnamed::CopyUnreadable,
        Unnamed::NotRecorded,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            Unnamed::PluginsUnknown => "plugins_unknown",
            Unnamed::PolicyPluginAbsent => "policy_plugin_absent",
            Unnamed::PolicyPluginNotEnabled => "policy_plugin_not_enabled",
            Unnamed::MoreThanOneCopy => "more_than_one_copy",
            Unnamed::CopyUnreadable => "copy_unreadable",
            Unnamed::NotRecorded => "not_recorded",
        }
    }

    fn from_wire(reason: &str) -> Option<Self> {
        Self::SENDABLE.into_iter().find(|u| u.wire() == reason)
    }
}

/// What a box says about the policy a run was decided under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyCopy {
    Named {
        plugin: String,
        version: String,
        commit: Option<String>,
    },
    Unnamed(Unnamed),
}

impl PolicyCopy {
    /// The copy this pane loaded, from the files Claude Code reads when it starts: the install
    /// registry under `config` and the settings layers, user then the repo's own two.
    ///
    /// Nothing here is guessed. A file that is there and cannot be read could be the one that
    /// changes the answer, so it names nothing, and a plugin no layer enables is not a copy that
    /// ran (verified against `claude plugin list`: an installed plugin with no `enabledPlugins`
    /// entry reports `disabled`, and a later settings layer overrides an earlier one).
    pub fn at_placement(config: &Path, repo: &Path) -> PolicyCopy {
        let unknown = PolicyCopy::Unnamed(Unnamed::PluginsUnknown);
        let Some(registry) = read_json(&config.join("plugins").join("installed_plugins.json"))
        else {
            return unknown;
        };
        let Some(plugins) = registry.get("plugins").and_then(Value::as_object) else {
            return unknown;
        };
        let mut applicable: Vec<(&str, &Value)> = Vec::new();
        for (id, installs) in plugins {
            let is_policy = id
                .split_once('@')
                .is_some_and(|(name, _)| name == POLICY_PLUGIN);
            if !is_policy {
                continue;
            }
            let Some(installs) = installs.as_array() else {
                return unknown;
            };
            for install in installs {
                let scope = install.get("scope").and_then(Value::as_str).unwrap_or("");
                let here = install
                    .get("projectPath")
                    .and_then(Value::as_str)
                    .is_some_and(|p| Path::new(p) == repo);
                if scope == "user" || here {
                    applicable.push((id.as_str(), install));
                }
            }
        }
        if applicable.is_empty() {
            return PolicyCopy::Unnamed(Unnamed::PolicyPluginAbsent);
        }
        let mut layers = Vec::new();
        for path in [
            config.join("settings.json"),
            repo.join(".claude").join("settings.json"),
            repo.join(".claude").join("settings.local.json"),
        ] {
            match std::fs::read_to_string(&path) {
                Ok(text) => match serde_json::from_str::<Value>(&text) {
                    Ok(doc) => layers.push(doc),
                    Err(_) => return unknown,
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return unknown,
            }
        }
        let enabled: Vec<&(&str, &Value)> = applicable
            .iter()
            .filter(|(id, _)| enabled_in(&layers, id))
            .collect();
        match enabled.as_slice() {
            [] => PolicyCopy::Unnamed(Unnamed::PolicyPluginNotEnabled),
            [(id, install)] => {
                let version = install.get("version").and_then(Value::as_str);
                let commit = match install.get("gitCommitSha") {
                    None => None,
                    Some(sha) => match sha.as_str() {
                        Some(sha) => Some(sha),
                        None => return PolicyCopy::Unnamed(Unnamed::CopyUnreadable),
                    },
                };
                match version {
                    Some(version) => named_if_readable(id, version, commit),
                    None => PolicyCopy::Unnamed(Unnamed::CopyUnreadable),
                }
            }
            _ => PolicyCopy::Unnamed(Unnamed::MoreThanOneCopy),
        }
    }

    /// The copy a pane placed now in `repo` loads, from this box's own Claude config directory.
    /// Where this box has none, nothing could be read and nothing is named.
    pub fn placed_under(repo: &Path) -> PolicyCopy {
        crate::workspace::plugin_sync::claude_config_dir()
            .map_or(PolicyCopy::Unnamed(Unnamed::PluginsUnknown), |config| {
                PolicyCopy::at_placement(&config, repo)
            })
    }

    /// The open body's `policy` field.
    pub fn to_wire(&self) -> Value {
        match self {
            PolicyCopy::Named {
                plugin,
                version,
                commit,
            } => {
                let mut body = json!({ "named": true, "plugin": plugin, "version": version });
                if let Some(commit) = commit {
                    body["commit"] = json!(commit);
                }
                body
            }
            PolicyCopy::Unnamed(why) => json!({ "named": false, "reason": why.wire() }),
        }
    }

    /// What the ledger holds: the wire form, as text.
    pub fn to_stored(&self) -> String {
        self.to_wire().to_string()
    }

    /// Read back what `to_stored` wrote. A value this build cannot read is `copy_unreadable`, never
    /// a copy and never a silent none, and one core would refuse is never read as a copy.
    pub fn from_stored(text: &str) -> PolicyCopy {
        let unreadable = PolicyCopy::Unnamed(Unnamed::CopyUnreadable);
        let Ok(Value::Object(body)) = serde_json::from_str::<Value>(text) else {
            return unreadable;
        };
        let only = |allowed: &[&str]| body.keys().all(|k| allowed.contains(&k.as_str()));
        match body.get("named").and_then(Value::as_bool) {
            Some(true) if only(&["named", "plugin", "version", "commit"]) => {
                let (Some(plugin), Some(version)) = (
                    body.get("plugin").and_then(Value::as_str),
                    body.get("version").and_then(Value::as_str),
                ) else {
                    return unreadable;
                };
                let commit = match body.get("commit") {
                    None => None,
                    Some(c) => match c.as_str() {
                        Some(c) => Some(c),
                        None => return unreadable,
                    },
                };
                named_if_readable(plugin, version, commit)
            }
            Some(false) if only(&["named", "reason"]) => body
                .get("reason")
                .and_then(Value::as_str)
                .and_then(Unnamed::from_wire)
                .map_or(unreadable, PolicyCopy::Unnamed),
            _ => unreadable,
        }
    }
}

/// Fix the copy a run is declared under: what the project's master pane was placed with, which is
/// what its run subagents execute inside (ISS-1303). A pane this build never placed, or a project
/// with no pane on record, loaded something this box cannot say, and says so.
///
/// Written with the declaration so that a pane placed again, or a plugin updated on disk, before
/// the sweep opens the run at core does not change what the run was decided under. A failed write
/// leaves the row unrecorded, which the open reports as `not_recorded`; it does not refuse a
/// declaration over telemetry.
pub fn stamp_declaration(led: &Ledger, run_id: &str, project_id: &str) {
    let copy = match led.master_placed_policy(project_id) {
        Ok(Some(stored)) => PolicyCopy::from_stored(&stored),
        Ok(None) => PolicyCopy::Unnamed(Unnamed::PluginsUnknown),
        Err(e) => {
            tracing::error!(
                "[policy] {project_id}: cannot read the pane's placement back ({e}); run {run_id} will open as {}",
                Unnamed::NotRecorded.wire()
            );
            return;
        }
    };
    if let Err(e) = led.record_policy_copy(run_id, &copy.to_stored()) {
        tracing::error!(
            "[policy] run {run_id}: its policy copy could not be written ({e}); it will open as {}",
            Unnamed::NotRecorded.wire()
        );
    }
}

/// What the open sends for a declared run: the copy its row holds, or `not_recorded` for a row a
/// build that recorded none declared.
pub fn for_open(led: &Ledger, run_id: &str) -> Result<PolicyCopy> {
    Ok(match led.policy_copy_of(run_id)? {
        Some(stored) => PolicyCopy::from_stored(&stored),
        None => PolicyCopy::Unnamed(Unnamed::NotRecorded),
    })
}

/// `plugin_id` is `<name>@<marketplace>`, each part what Claude Code names a plugin or a
/// marketplace by, so core's own bounds hold.
fn valid_plugin_id(id: &str) -> bool {
    let part = |p: &str| {
        let mut chars = p.chars();
        p.len() <= 64
            && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    id.split_once('@')
        .is_some_and(|(name, marketplace)| part(name) && part(marketplace))
}

/// `major.minor.patch` with an optional `-prerelease` and `+build`, at most 64 characters.
fn valid_semver(v: &str) -> bool {
    let tail = |t: &str| {
        !t.is_empty()
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-'))
    };
    let (rest, build) = match v.split_once('+') {
        Some((rest, build)) => (rest, Some(build)),
        None => (v, None),
    };
    let (core, pre) = match rest.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (rest, None),
    };
    let numbers: Vec<&str> = core.split('.').collect();
    v.len() <= 64
        && numbers.len() == 3
        && numbers
            .iter()
            .all(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        && pre.is_none_or(tail)
        && build.is_none_or(tail)
}

/// Seven to forty lower-case hex characters, which is what a pinned ref is held to.
fn valid_commit(c: &str) -> bool {
    (7..=40).contains(&c.len()) && c.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f'))
}

/// A copy exactly as it would be sent, or `copy_unreadable` where core would refuse any part.
fn named_if_readable(plugin: &str, version: &str, commit: Option<&str>) -> PolicyCopy {
    if valid_plugin_id(plugin) && valid_semver(version) && commit.is_none_or(valid_commit) {
        PolicyCopy::Named {
            plugin: plugin.to_string(),
            version: version.to_string(),
            commit: commit.map(str::to_string),
        }
    } else {
        PolicyCopy::Unnamed(Unnamed::CopyUnreadable)
    }
}

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

/// Whether the settings layers, in order, leave `id` enabled: the last layer that states it wins
/// and one that never does is not enabled.
fn enabled_in(layers: &[Value], id: &str) -> bool {
    layers
        .iter()
        .filter_map(|l| l.get("enabledPlugins")?.get(id)?.as_bool())
        .next_back()
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_scratch::Scratch;
    use std::fs;

    /// The fixture both sides read. A Rust test writes against it and
    /// `packages/core/src/devices/policy-copy.test.ts` parses the same bytes, so a shape change on
    /// either side fails a test rather than quietly parting the producer from the consumer.
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../../core/src/devices/policy-copy.fixture.json"
    );

    const SHA: &str = "867ef128cec692bbcf4780066fddc2bd350e06a0";
    const SHA_OTHER: &str = "c98b3fff96a28129a55c786ad22cb0773aa61112";

    fn fixture() -> Value {
        serde_json::from_str(&fs::read_to_string(FIXTURE).expect("the shared fixture is there"))
            .expect("the shared fixture is JSON")
    }

    /// A Claude config directory and a repo, each in its own scratch.
    struct Placed {
        config: Scratch,
        repo: Scratch,
    }

    impl Placed {
        fn new(tag: &str) -> Self {
            let b = Placed {
                config: Scratch::new(&format!("{tag}-cfg")),
                repo: Scratch::new(&format!("{tag}-repo")),
            };
            fs::create_dir_all(b.config.path().join("plugins")).unwrap();
            fs::create_dir_all(b.repo.path().join(".claude")).unwrap();
            b
        }
        fn registry(&self, body: &str) {
            fs::write(
                self.config
                    .path()
                    .join("plugins")
                    .join("installed_plugins.json"),
                body,
            )
            .unwrap();
        }
        fn user_settings(&self, body: &str) {
            fs::write(self.config.path().join("settings.json"), body).unwrap();
        }
        fn project_settings(&self, body: &str) {
            fs::write(self.repo.path().join(".claude").join("settings.json"), body).unwrap();
        }
        fn local_settings(&self, body: &str) {
            fs::write(
                self.repo.path().join(".claude").join("settings.local.json"),
                body,
            )
            .unwrap();
        }
        fn placed(&self) -> PolicyCopy {
            PolicyCopy::at_placement(self.config.path(), self.repo.path())
        }
    }

    fn user_install(id: &str, version: &str, sha: Option<&str>) -> String {
        match sha {
            Some(sha) => format!(
                r#""{id}":[{{"scope":"user","version":"{version}","gitCommitSha":"{sha}"}}]"#
            ),
            None => format!(r#""{id}":[{{"scope":"user","version":"{version}"}}]"#),
        }
    }

    fn registry_of(installs: &[String]) -> String {
        format!(r#"{{"version":2,"plugins":{{{}}}}}"#, installs.join(","))
    }

    fn named(plugin: &str, version: &str, commit: Option<&str>) -> PolicyCopy {
        PolicyCopy::Named {
            plugin: plugin.into(),
            version: version.into(),
            commit: commit.map(str::to_string),
        }
    }

    // Criterion 7: an enabled forge install is the copy, with the registry's own commit.

    #[test]
    fn an_enabled_forge_install_is_named_with_the_commit_its_install_recorded() {
        let b = Placed::new("named");
        b.registry(&registry_of(&[
            user_install("forge@forge-local", "3.36.542", Some(SHA)),
            user_install("forge-codemap@forge", "0.20.0", Some(SHA_OTHER)),
        ]));
        b.user_settings(
            r#"{"enabledPlugins":{"forge@forge-local":true,"forge-codemap@forge":true}}"#,
        );
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542", Some(SHA))
        );
    }

    #[test]
    fn a_plugin_named_for_forge_is_not_the_policy() {
        let b = Placed::new("not-forge");
        b.registry(&registry_of(&[user_install(
            "forge-codemap@forge",
            "0.20.0",
            Some(SHA),
        )]));
        b.user_settings(r#"{"enabledPlugins":{"forge-codemap@forge":true}}"#);
        assert_eq!(b.placed(), PolicyCopy::Unnamed(Unnamed::PolicyPluginAbsent));
    }

    // Criterion 8: enabled is what `claude plugin list` reports.

    #[test]
    fn an_install_no_settings_layer_states_is_not_enabled() {
        let b = Placed::new("unstated");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        b.user_settings("{}");
        assert_eq!(
            b.placed(),
            PolicyCopy::Unnamed(Unnamed::PolicyPluginNotEnabled)
        );
    }

    #[test]
    fn a_missing_user_settings_file_states_nothing() {
        let b = Placed::new("no-settings");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        assert_eq!(
            b.placed(),
            PolicyCopy::Unnamed(Unnamed::PolicyPluginNotEnabled)
        );
    }

    #[test]
    fn the_repos_own_settings_can_disable_what_the_user_enabled() {
        let b = Placed::new("project-off");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        b.project_settings(r#"{"enabledPlugins":{"forge@forge-local":false}}"#);
        assert_eq!(
            b.placed(),
            PolicyCopy::Unnamed(Unnamed::PolicyPluginNotEnabled)
        );
    }

    #[test]
    fn the_last_layer_that_states_the_plugin_wins() {
        let b = Placed::new("local-on");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        b.project_settings(r#"{"enabledPlugins":{"forge@forge-local":false}}"#);
        b.local_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542", Some(SHA))
        );
    }

    #[test]
    fn a_layer_that_does_not_state_the_plugin_leaves_the_earlier_answer_standing() {
        let b = Placed::new("silent-layer");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        b.project_settings(r#"{"model":"opus","enabledPlugins":{"other@m":false}}"#);
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542", Some(SHA))
        );
    }

    // Criterion 9: where one copy cannot be established it says why, and does not choose.

    #[test]
    fn two_enabled_forge_installs_are_not_chosen_between() {
        let b = Placed::new("two");
        b.registry(&registry_of(&[
            user_install("forge@forge-local", "3.36.542", Some(SHA)),
            user_install("forge@forge", "3.30.0", Some(SHA_OTHER)),
        ]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true,"forge@forge":true}}"#);
        assert_eq!(b.placed(), PolicyCopy::Unnamed(Unnamed::MoreThanOneCopy));
    }

    #[test]
    fn a_second_forge_install_that_is_not_enabled_does_not_make_it_ambiguous() {
        let b = Placed::new("one-of-two");
        b.registry(&registry_of(&[
            user_install("forge@forge-local", "3.36.542", Some(SHA)),
            user_install("forge@forge", "3.30.0", Some(SHA_OTHER)),
        ]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true,"forge@forge":false}}"#);
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542", Some(SHA))
        );
    }

    #[test]
    fn an_install_scoped_to_another_repo_does_not_apply() {
        let b = Placed::new("other-repo");
        b.registry(&format!(
            r#"{{"plugins":{{"forge@forge-local":[{{"scope":"project","projectPath":"/elsewhere","version":"3.36.542","gitCommitSha":"{SHA}"}}]}}}}"#
        ));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        assert_eq!(b.placed(), PolicyCopy::Unnamed(Unnamed::PolicyPluginAbsent));
    }

    #[test]
    fn an_install_scoped_to_this_repo_applies() {
        let b = Placed::new("this-repo");
        let repo = b.repo.path().display().to_string();
        b.registry(&format!(
            r#"{{"plugins":{{"forge@forge-local":[{{"scope":"project","projectPath":{repo:?},"version":"3.36.542","gitCommitSha":"{SHA}"}}]}}}}"#
        ));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542", Some(SHA))
        );
    }

    #[test]
    fn an_unreadable_registry_or_settings_file_names_nothing() {
        let absent = Placed::new("no-registry");
        assert_eq!(
            absent.placed(),
            PolicyCopy::Unnamed(Unnamed::PluginsUnknown)
        );

        let torn = Placed::new("torn-registry");
        torn.registry("{ not json");
        assert_eq!(torn.placed(), PolicyCopy::Unnamed(Unnamed::PluginsUnknown));

        let shape = Placed::new("wrong-shape");
        shape.registry(r#"{"plugins":["not","a","map"]}"#);
        assert_eq!(shape.placed(), PolicyCopy::Unnamed(Unnamed::PluginsUnknown));

        // A settings file that is there and cannot be read could be the one that disables it.
        let settings = Placed::new("torn-settings");
        settings.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542",
            Some(SHA),
        )]));
        settings.user_settings("{ not json");
        assert_eq!(
            settings.placed(),
            PolicyCopy::Unnamed(Unnamed::PluginsUnknown)
        );
    }

    // Criterion 10: nothing core would refuse is ever sent as a copy.

    #[test]
    fn an_install_core_would_refuse_is_copy_unreadable_and_never_a_copy() {
        for (version, sha) in [
            ("latest", Some(SHA)),
            ("unknown", Some(SHA)),
            ("3.36", Some(SHA)),
            ("3.36.542", Some("not-a-sha")),
            ("3.36.542", Some("abc12")),
            ("3.36.542", Some("867EF128CEC692BBCF4780066FDDC2BD350E06A0")),
        ] {
            let b = Placed::new("refusable");
            b.registry(&registry_of(&[user_install(
                "forge@forge-local",
                version,
                sha,
            )]));
            b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
            assert_eq!(
                b.placed(),
                PolicyCopy::Unnamed(Unnamed::CopyUnreadable),
                "version {version:?} commit {sha:?}"
            );
        }
    }

    #[test]
    fn an_install_that_recorded_no_commit_is_named_without_one() {
        let b = Placed::new("no-sha");
        b.registry(&registry_of(&[user_install(
            "forge@forge-local",
            "3.36.542-rc.1",
            None,
        )]));
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        assert_eq!(
            b.placed(),
            named("forge@forge-local", "3.36.542-rc.1", None)
        );
    }

    #[test]
    fn an_install_with_no_version_is_copy_unreadable() {
        let b = Placed::new("no-version");
        b.registry(r#"{"plugins":{"forge@forge-local":[{"scope":"user"}]}}"#);
        b.user_settings(r#"{"enabledPlugins":{"forge@forge-local":true}}"#);
        assert_eq!(b.placed(), PolicyCopy::Unnamed(Unnamed::CopyUnreadable));
    }

    // Criteria 11 and 12: the copy is fixed at the declaration and read from the row.

    fn declared(led: &mut Ledger, run_id: &str, project: &str) {
        led.create_run_group(crate::runner::ledger::NewRun {
            run_id: run_id.into(),
            project_id: project.into(),
            // One master holds one unbound declaration at a time, so each run has its own.
            master_session_id: format!("sess-{run_id}"),
            worktree_path: format!("/w/{run_id}").into(),
            boot_id: "boot-a".into(),
            issue_keys: vec![format!("ISS-{}", run_id.len())],
        })
        .expect("the run is declared");
    }

    fn placed_under(led: &Ledger, copy: &PolicyCopy) {
        led.note_master_placed(
            "p",
            "forge-master-p",
            "boot-a",
            "0.17.0",
            None,
            Some(&copy.to_stored()),
        )
        .unwrap();
    }

    #[test]
    fn a_declared_run_carries_the_copy_its_pane_was_placed_under_not_the_one_placed_since() {
        let mut led = Ledger::open_in_memory().unwrap();
        let before = named("forge@forge-local", "3.30.0", Some("aaaaaaaa"));
        let after = named("forge@forge-local", "3.36.542", Some(SHA));
        placed_under(&led, &before);
        declared(&mut led, "run-1", "p");
        stamp_declaration(&led, "run-1", "p");
        // The pane is placed again under a newer copy before the sweep opens the run.
        placed_under(&led, &after);
        assert_eq!(for_open(&led, "run-1").unwrap(), before);
        // And a run declared after that one is decided under the new copy.
        declared(&mut led, "run-22", "p");
        stamp_declaration(&led, "run-22", "p");
        assert_eq!(for_open(&led, "run-22").unwrap(), after);
        assert_eq!(
            for_open(&led, "run-1").unwrap(),
            before,
            "the first stamp stands"
        );
    }

    #[test]
    fn a_stamp_is_written_once_and_a_second_never_replaces_the_first() {
        let mut led = Ledger::open_in_memory().unwrap();
        placed_under(&led, &named("forge@forge-local", "3.30.0", None));
        declared(&mut led, "run-1", "p");
        stamp_declaration(&led, "run-1", "p");
        placed_under(&led, &named("forge@forge-local", "3.36.542", None));
        stamp_declaration(&led, "run-1", "p");
        assert_eq!(
            for_open(&led, "run-1").unwrap(),
            named("forge@forge-local", "3.30.0", None)
        );
    }

    #[test]
    fn a_pane_this_build_never_placed_names_nothing() {
        let mut led = Ledger::open_in_memory().unwrap();
        // The pane's own SessionStart wrote its row; nothing placed it, so nothing recorded a copy.
        led.note_master("p", "forge-master-p", Some("conv"), Some("sess"), "boot-a")
            .unwrap();
        declared(&mut led, "run-1", "p");
        stamp_declaration(&led, "run-1", "p");
        assert_eq!(
            for_open(&led, "run-1").unwrap(),
            PolicyCopy::Unnamed(Unnamed::PluginsUnknown)
        );
        // A project with no pane on record at all says the same.
        declared(&mut led, "run-22", "q");
        stamp_declaration(&led, "run-22", "q");
        assert_eq!(
            for_open(&led, "run-22").unwrap(),
            PolicyCopy::Unnamed(Unnamed::PluginsUnknown)
        );
    }

    #[test]
    fn a_run_declared_by_a_build_that_recorded_no_copy_opens_not_recorded() {
        let mut led = Ledger::open_in_memory().unwrap();
        declared(&mut led, "run-1", "p");
        assert_eq!(
            for_open(&led, "run-1").unwrap(),
            PolicyCopy::Unnamed(Unnamed::NotRecorded)
        );
    }

    #[test]
    fn a_stored_copy_this_build_cannot_read_is_not_sent_as_one() {
        let mut led = Ledger::open_in_memory().unwrap();
        declared(&mut led, "run-1", "p");
        led.record_policy_copy("run-1", r#"{"named":true,"plugin":"forge"}"#)
            .unwrap();
        assert_eq!(
            for_open(&led, "run-1").unwrap(),
            PolicyCopy::Unnamed(Unnamed::CopyUnreadable)
        );
    }

    // Criterion 14: one fixture, both sides.

    #[test]
    fn every_body_core_accepts_is_the_exact_body_this_side_produces() {
        let fixture = fixture();
        let accepted = fixture["accepted"].as_array().expect("accepted bodies");
        assert!(accepted.len() >= 8, "the fixture lost a case");
        for case in accepted {
            let body = &case["body"];
            let copy = PolicyCopy::from_stored(&body.to_string());
            assert_eq!(&copy.to_wire(), body, "{}", case["case"]);
            assert_eq!(
                PolicyCopy::from_stored(&copy.to_stored()),
                copy,
                "what the ledger holds reads back as the same copy: {}",
                case["case"]
            );
        }
    }

    #[test]
    fn nothing_core_refuses_is_ever_read_back_as_a_copy() {
        let fixture = fixture();
        let refused = fixture["refused"].as_array().expect("refused bodies");
        assert!(refused.len() >= 10, "the fixture lost a case");
        for case in refused {
            assert_eq!(
                PolicyCopy::from_stored(&case["body"].to_string()),
                PolicyCopy::Unnamed(Unnamed::CopyUnreadable),
                "a stored value this side would not send must not become one: {}",
                case["case"]
            );
        }
    }

    #[test]
    fn every_reason_this_side_can_send_is_in_the_fixture() {
        let fixture = fixture();
        let in_fixture: Vec<String> = fixture["accepted"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|c| c["body"]["reason"].as_str().map(str::to_string))
            .collect();
        for why in Unnamed::SENDABLE {
            assert!(
                in_fixture.iter().any(|r| r == why.wire()),
                "{} is sent by this side and core's test never reads it",
                why.wire()
            );
        }
    }
}
