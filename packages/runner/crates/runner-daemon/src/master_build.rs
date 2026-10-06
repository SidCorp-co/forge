//! Whether a resident master pane runs what this box would place now.
//!
//! A pane loads the runner's hooks and its forge-master skill, and Claude
//! Code's plugins, once, when it starts; none of them reloads in a running
//! pane. An update that replaces the daemon therefore leaves every pane it
//! adopted on the build and the plugins it was placed under, and before
//! ISS-1379 nothing said so: the old panes went on being nudged and went on
//! running what the update was installed to replace.
//!
//! A rebuild is not itself a change to a pane: the dev runner is rebuilt on
//! most releases, and a pane is outdated only where something it was placed
//! with differs from what this box would hand one now — the skill text, the
//! hooks wiring, the environment, the MCP config, the command line, the
//! plugins, or the box↔master wire. The runner's own build decides only for a
//! pane placed before a build recorded those.
//!
//! This is the judgement and nothing else. When a pane judged outdated may be
//! replaced is core's (`masters/verdict.ts`), and it never replaces one holding
//! work.

use std::collections::BTreeMap;
use std::path::Path;

use runner_core::ledger::MasterRow;
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

    /// Each input both sides read whose value differs, named with what it was
    /// and what it is. An input only one side holds was unread on the other,
    /// which is no evidence of a change.
    pub fn changed(&self, now: &Inputs) -> Vec<String> {
        self.0
            .iter()
            .filter_map(|(name, placed)| {
                let now = now.0.get(name)?;
                (now != placed).then(|| format!("{name} (placed {placed}, now {now})"))
            })
            .collect()
    }
}

/// What this box would place a pane under now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Standing {
    /// This process's build, as `update::VERSION_LINE` reads.
    pub build: String,
    /// The installed plugin set, as [`plugin_set`] writes it; `None` where it
    /// could not be read.
    pub plugins: Option<String>,
    pub inputs: Inputs,
}

impl Standing {
    /// This process's build, the plugins Claude Code would load for a pane in
    /// `handed.repo`, and every input [`Inputs::of`] reads.
    pub fn this_box(handed: &Handed<'_>) -> Self {
        Standing {
            build: runner_update::VERSION_LINE.to_string(),
            plugins: runner_workspace::plugin_sync::claude_config_dir()
                .and_then(|dir| plugin_set(&dir, handed.repo)),
            inputs: Inputs::of(handed),
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
/// A pane whose inputs were recorded is outdated where one of them differs
/// from what this box would hand a pane now, and by nothing else: a rebuild
/// that changes none of them leaves it current.
///
/// A pane placed by a build that recorded no inputs is judged as it was before
/// they were: by its build and plugins. A pane whose placement build was never
/// recorded either is outdated: it was placed by a build that did not record
/// one, which is older than this one, or adopted by a box that never placed
/// it. Where either plugin set is unknown the build alone decides, since an
/// unread set is no evidence of a change.
pub fn judge(row: Option<&MasterRow>, now: &Standing) -> Judged {
    if let Some(record) = row.and_then(|r| r.placed_inputs.as_deref()) {
        let Some(placed) = Inputs::from_record(record) else {
            return Judged::Outdated(format!(
                "the record of what it was placed with is not one this build reads ({record}), so whether it runs on what this box hands a pane now is not known"
            ));
        };
        let changed = placed.changed(&now.inputs);
        return if changed.is_empty() {
            Judged::Current
        } else {
            Judged::Outdated(changed_why(&changed))
        };
    }
    by_build(row, now)
}

/// The account of a pane whose inputs `changed`, in the words core's verdict
/// uses for the same reading.
pub fn changed_why(changed: &[String]) -> String {
    format!(
        "what it runs on changed since it was placed: {}",
        changed.join("; ")
    )
}

fn by_build(row: Option<&MasterRow>, now: &Standing) -> Judged {
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

    fn inputs(pairs: &[(&str, &str)]) -> Inputs {
        Inputs(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        )
    }

    fn placed(build: &str, with: Option<&Inputs>) -> MasterRow {
        MasterRow {
            project_id: "p".into(),
            pane_name: "forge-master-p".into(),
            conversation_id: None,
            session_id: None,
            boot_id: "b".into(),
            cold_started_at: 0,
            last_seen_at: 0,
            placed_build: Some(build.into()),
            placed_plugins: None,
            placed_at: Some(0),
            outdated: None,
            unattributed: None,
            placed_inputs: with.map(Inputs::to_record),
        }
    }

    fn standing(build: &str, inputs: Inputs) -> Standing {
        Standing {
            build: build.into(),
            plugins: None,
            inputs,
        }
    }

    const BASE: &[(&str, &str)] = &[
        ("wire", "1"),
        ("skill", "aaaaaaaaaaaa"),
        ("hooks", "bbbbbbbbbbbb"),
        ("env", "cccccccccccc"),
        ("mcp", "dddddddddddd"),
        ("launch", "eeeeeeeeeeee"),
    ];

    #[test]
    fn a_rebuild_that_changes_nothing_a_pane_runs_on_leaves_it_current() {
        let was = inputs(BASE);
        let row = placed("forge-runner 0.4.0-dev.69 (abc)", Some(&was));
        let now = standing("forge-runner 0.4.0-dev.71 (def)", was.clone());
        assert_eq!(
            judge(Some(&row), &now),
            Judged::Current,
            "a rebuild alone drained a master whose skill, hooks, env, MCP config, launch and wire are all unchanged"
        );
    }

    #[test]
    fn a_changed_skill_makes_it_outdated_and_is_named() {
        let row = placed("same", Some(&inputs(BASE)));
        let mut now = inputs(BASE);
        now.0.insert("skill".into(), "ffffffffffff".into());
        let Judged::Outdated(why) = judge(Some(&row), &standing("same", now)) else {
            panic!("a pane placed with an older skill text was read as current");
        };
        assert_eq!(
            why,
            "what it runs on changed since it was placed: skill (placed aaaaaaaaaaaa, now ffffffffffff)"
        );
    }

    #[test]
    fn a_wire_bump_makes_every_pane_outdated() {
        let row = placed("same", Some(&inputs(BASE)));
        let mut now = inputs(BASE);
        now.0.insert("wire".into(), "2".into());
        assert!(matches!(
            judge(Some(&row), &standing("same", now)),
            Judged::Outdated(why) if why.contains("wire (placed 1, now 2)")
        ));
    }

    #[test]
    fn an_input_unread_on_one_side_is_no_evidence_of_a_change() {
        let row = placed("a", Some(&inputs(BASE)));
        let now = inputs(&BASE[..4]);
        assert_eq!(judge(Some(&row), &standing("b", now)), Judged::Current);
    }

    #[test]
    fn a_pane_placed_before_inputs_were_recorded_is_judged_by_its_build() {
        let row = placed("forge-runner 0.4.0-dev.69", None);
        let now = standing("forge-runner 0.4.0-dev.71", inputs(BASE));
        assert_eq!(
            judge(Some(&row), &now),
            Judged::Outdated(
                "placed under runner forge-runner 0.4.0-dev.69, and this box runs forge-runner 0.4.0-dev.71 now".into()
            )
        );
    }

    #[test]
    fn an_unreadable_placement_record_is_outdated_by_name() {
        let mut row = placed("a", None);
        row.placed_inputs = Some("not json".into());
        assert!(matches!(
            judge(Some(&row), &standing("a", inputs(BASE))),
            Judged::Outdated(why) if why.contains("(not json)")
        ));
    }

    #[test]
    fn a_placement_the_ledger_records_is_judged_current_by_the_next_build() {
        let dir =
            std::env::temp_dir().join(format!("forge-master-inputs-{}", uuid::Uuid::new_v4()));
        let led = runner_core::ledger::Ledger::open(&dir.join("ledger.sqlite")).expect("ledger");
        let with = inputs(BASE);
        led.note_master_placed(
            "p",
            "forge-master-p",
            "boot",
            ("dev.69", None, &with.to_record()),
        )
        .expect("placement recorded");
        let row = led.master_for_project("p").expect("read").expect("row");
        assert_eq!(
            row.placed_inputs.as_deref(),
            Some(with.to_record().as_str())
        );
        assert_eq!(
            judge(Some(&row), &standing("dev.71", with)),
            Judged::Current
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

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
        assert_eq!(a.changed(&b).len(), 1, "{:?}", a.changed(&b));
        assert!(a.changed(&b)[0].starts_with("env (placed "));
    }
}
