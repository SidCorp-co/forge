//! What a resident master pane is handed, for core's judgement of whether it
//! runs what this box would place now.
//!
//! A pane loads the runner's hooks and its forge-master skill, and Claude
//! Code's plugins, once, when it starts; none of them reloads in a running
//! pane. An update that replaces the daemon therefore leaves every pane it
//! adopted on what it was placed under.
//!
//! A rebuild is not itself a change to a pane: the dev runner is rebuilt on
//! most releases, and a pane is outdated only where something it was placed
//! with differs from what this box would hand one now — the skill text, the
//! hooks wiring, the environment, the MCP config, the command line, the
//! plugins, or the box↔master wire.
//!
//! This reads the inputs and nothing else. Whether they make a pane outdated,
//! and when it may be replaced, is core's (`masters/verdict.ts:outdatedWhy`),
//! and it never replaces one holding work.

use std::collections::BTreeMap;
use std::path::Path;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The version of what a placed master and this box say to each other that no
/// input below carries: the control-socket verbs a pane's `forge-runner api`
/// reaches, the hook events it reports, and the standing prompt's contract.
/// Bumped only when that protocol changes, never for a rebuild alone; a bump
/// marks every pane placed under the old one outdated.
pub const MASTER_WIRE: u32 = 1;

/// How many hex characters of an input's digest are kept: enough that two
/// different inputs do not read alike, few enough to read in a verdict.
const DIGEST_CHARS: usize = 12;

/// What a pane is handed, as a placement hands it or a sweep reads it would be
/// handed now.
pub struct Handed<'a> {
    pub slug: &'a str,
    pub repo: &'a Path,
    /// The environment its shell is started with, without the capability token
    /// minted for it, which is new for every pane and says nothing about what
    /// it runs.
    pub env: &'a [(String, String)],
    /// The servers its MCP config declares; `None` where they could not be read.
    pub servers: Option<&'a serde_json::Map<String, Value>>,
}

/// What a pane was placed with that a rebuild can change, each input by name
/// with its digest — or, for `wire`, [`MASTER_WIRE`] itself. An input that
/// could not be read is absent rather than guessed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Inputs(pub BTreeMap<String, String>);

fn digest(bytes: &[u8]) -> String {
    let full = hex::encode(Sha256::digest(bytes));
    full[..DIGEST_CHARS].to_string()
}

impl Inputs {
    /// The inputs `handed` gives a pane on this box now.
    pub fn of(handed: &Handed<'_>) -> Self {
        let mut map = BTreeMap::new();
        map.insert("wire".to_string(), MASTER_WIRE.to_string());
        map.insert(
            "skill".to_string(),
            digest(runner_workspace::master_skill::ASSET.as_bytes()),
        );
        if let Some(hooks) = runner_platform::exe::own().ok().and_then(|exe| {
            runner_workspace::hook_install::merged(None, &exe.path.to_string_lossy()).ok()
        }) {
            map.insert("hooks".to_string(), digest(hooks.as_bytes()));
        }
        let mut env: Vec<String> = handed.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
        env.sort();
        map.insert("env".to_string(), digest(env.join("\0").as_bytes()));
        if let Some(servers) = handed.servers {
            let doc = serde_json::json!({ "mcpServers": Value::Object(servers.clone()) });
            map.insert("mcp".to_string(), digest(doc.to_string().as_bytes()));
        }
        let config = runner_workspace::mcp::config::session_path(handed.slug);
        let argv = runner_workspace::terminal::pane_argv(Some(&config), None);
        map.insert("launch".to_string(), digest(argv.join("\0").as_bytes()));
        if let Some(plugins) = runner_workspace::plugin_sync::claude_config_dir()
            .and_then(|dir| plugin_set(&dir, handed.repo))
        {
            map.insert("plugins".to_string(), digest(plugins.as_bytes()));
        }
        Inputs(map)
    }

    /// The text the ledger keeps them as.
    pub fn to_record(&self) -> String {
        serde_json::to_string(&self.0).expect("a map of strings serialises")
    }

    /// The inputs a ledger record holds, or `None` where the text is not one
    /// [`Inputs::to_record`] writes.
    pub fn from_record(text: &str) -> Option<Self> {
        serde_json::from_str(text).ok().map(Inputs)
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

    #[test]
    fn the_inputs_read_twice_on_one_box_agree_and_survive_the_ledger() {
        let env = vec![("FORGE_PROJECT_ID".to_string(), "p".to_string())];
        let servers = serde_json::Map::new();
        let handed = Handed {
            slug: "p",
            repo: Path::new("/nonexistent"),
            env: &env,
            servers: Some(&servers),
        };
        let a = Inputs::of(&handed);
        assert_eq!(a, Inputs::of(&handed));
        assert_eq!(Inputs::from_record(&a.to_record()), Some(a.clone()));
        for name in ["wire", "skill", "env", "mcp", "launch"] {
            assert!(a.0.contains_key(name), "{name} is not among {a:?}");
        }
        let other_env = vec![("FORGE_PROJECT_ID".to_string(), "q".to_string())];
        let b = Inputs::of(&Handed {
            env: &other_env,
            ..handed
        });
        let differing: Vec<_> =
            a.0.iter()
                .filter(|(k, v)| b.0.get(*k) != Some(*v))
                .collect();
        assert_eq!(differing.len(), 1, "{differing:?}");
        assert_eq!(differing[0].0, "env");
    }

    #[test]
    fn a_placement_the_ledger_records_reads_back_as_the_inputs_placed() {
        let dir =
            std::env::temp_dir().join(format!("forge-master-inputs-{}", uuid::Uuid::new_v4()));
        let led = runner_core::ledger::Ledger::open(&dir.join("ledger.sqlite")).expect("ledger");
        let with = Inputs(BTreeMap::from([("wire".to_string(), "1".to_string())]));
        led.note_master_placed("p", "forge-master-p", "boot", &with.to_record())
            .expect("placement recorded");
        let row = led.master_for_project("p").expect("read").expect("row");
        assert_eq!(
            row.placed_inputs.as_deref().and_then(Inputs::from_record),
            Some(with)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
