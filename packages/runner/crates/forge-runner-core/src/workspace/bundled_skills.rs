//! Skills embedded in the runner binary (agent-driven pipeline, phase 0).
//!
//! The canonical autonomous skill set ships *inside* this binary rather than
//! arriving over a sync protocol, so it cannot drift from the code that
//! depends on it: `packages/runner/skills/` is walked by `build.rs` and the
//! resulting table is `include_str!`-ed in. At daemon start the set is
//! materialised into a version-keyed directory under the user data dir.
//!
//! Nothing consumes the extracted tree yet — wiring it into a worktree is
//! phase 3, gated on `pipelineConfig.mode`. Extracting early is deliberate:
//! it makes the mechanism observable (and its failures loud) a release before
//! anything depends on it.
//!
//! Design notes in `docs/proposals/agent-driven-pipeline.md`.

use std::collections::BTreeSet;
use std::path::PathBuf;

use crate::config::SkillSettings;
use crate::error::{Error, Result};

include!(concat!(env!("OUT_DIR"), "/bundled_skills.rs"));

/// One embedded skill: the directory name under `packages/runner/skills/` plus
/// whatever its frontmatter declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledSkill {
    pub name: String,
    /// Frontmatter `survives_kill_switch: true`. Mirrors Claude Code's own
    /// per-skill survivor flag: the global switch exists to disable a bad
    /// release without shipping a binary, but a skill the pipeline cannot run
    /// without must not be switchable off by accident.
    pub survives_kill_switch: bool,
}

/// What `ensure_extracted` did, for logging and for tests.
#[derive(Debug, Clone)]
pub struct Extracted {
    pub root: PathBuf,
    pub installed: Vec<String>,
    pub suppressed: Vec<String>,
}

/// `~/.local/share/forge-runner/bundled-skills/<version>/`.
///
// cm:guard the version segment is load-bearing: two runner versions on one box
// must never share an extraction dir, or a downgrade serves the newer skill
// bodies to the older binary and the mismatch is invisible.
pub fn root() -> Result<PathBuf> {
    let base = dirs_next::data_dir()
        .or_else(dirs_next::config_dir)
        .ok_or_else(|| Error::Config("no data dir".into()))?;
    Ok(base
        .join("forge-runner")
        .join("bundled-skills")
        .join(env!("CARGO_PKG_VERSION")))
}

/// Every skill embedded in this binary, in directory order.
pub fn skills() -> Vec<BundledSkill> {
    let mut names: BTreeSet<&str> = BTreeSet::new();
    for (rel, _) in BUNDLED_FILES {
        if let Some(name) = rel.split('/').next() {
            names.insert(name);
        }
    }
    names
        .into_iter()
        .map(|name| BundledSkill {
            name: name.to_string(),
            survives_kill_switch: BUNDLED_FILES
                .iter()
                .find(|(rel, _)| *rel == format!("{name}/SKILL.md"))
                .is_some_and(|(_, body)| frontmatter_flag(body, "survives_kill_switch")),
        })
        .collect()
}

/// Read a boolean key out of the leading `---` frontmatter block. Deliberately
/// not a YAML parse: the only keys this needs are flat booleans, and adding a
/// yaml dependency would change `Cargo.lock` for the runner's version-locked
/// release build.
fn frontmatter_flag(body: &str, key: &str) -> bool {
    let mut lines = body.lines();
    if lines.next().map(str::trim) != Some("---") {
        return false;
    }
    for line in lines {
        let line = line.trim();
        if line == "---" {
            return false;
        }
        if let Some(value) = line
            .strip_prefix(key)
            .and_then(|r| r.trim().strip_prefix(':'))
        {
            return value.trim() == "true";
        }
    }
    false
}

/// Which skills this config leaves enabled. `overrides` wins over the global
/// switch in both directions, so one bad skill can be disabled on its own
/// without taking the set down.
fn enabled(cfg: &SkillSettings) -> (Vec<BundledSkill>, Vec<String>) {
    let mut on = Vec::new();
    let mut off = Vec::new();
    for skill in skills() {
        let allowed = match cfg.bundled_overrides.get(&skill.name) {
            Some(&explicit) => explicit,
            None => !cfg.bundled_disabled || skill.survives_kill_switch,
        };
        if allowed {
            on.push(skill);
        } else {
            off.push(skill.name.clone());
        }
    }
    (on, off)
}

/// Materialise the enabled set under [`root`]. Idempotent: a marker recording
/// the version and the enabled set short-circuits the common case, and a
/// changed set (someone flipped the kill switch) forces a clean re-extract
/// rather than leaving a disabled skill on disk.
pub fn ensure_extracted(cfg: &SkillSettings) -> Result<Extracted> {
    let root = root()?;
    let (on, suppressed) = enabled(cfg);
    let installed: Vec<String> = on.iter().map(|s| s.name.clone()).collect();
    let fingerprint = format!("{}\n{}", env!("CARGO_PKG_VERSION"), installed.join(","));
    let marker = root.join(".complete");

    if std::fs::read_to_string(&marker).is_ok_and(|f| f == fingerprint) {
        return Ok(Extracted {
            root,
            installed,
            suppressed,
        });
    }

    if root.exists() {
        std::fs::remove_dir_all(&root)
            .map_err(|e| Error::Config(format!("clear {root:?}: {e}")))?;
    }

    let keep: BTreeSet<&str> = on.iter().map(|s| s.name.as_str()).collect();
    for (rel, body) in BUNDLED_FILES {
        let Some(owner) = rel.split('/').next() else {
            continue;
        };
        if !keep.contains(owner) {
            continue;
        }
        let dest = root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Config(format!("mkdir {parent:?}: {e}")))?;
        }
        std::fs::write(&dest, body).map_err(|e| Error::Config(format!("write {dest:?}: {e}")))?;
    }

    // cm:guard write the marker LAST — a crash mid-extract must leave the dir
    // unmarked so the next start re-extracts, never half a skill set treated as
    // complete.
    std::fs::write(&marker, &fingerprint)
        .map_err(|e| Error::Config(format!("write {marker:?}: {e}")))?;

    Ok(Extracted {
        root,
        installed,
        suppressed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(disabled: bool, overrides: &[(&str, bool)]) -> SkillSettings {
        SkillSettings {
            auto_pull: true,
            bundled_disabled: disabled,
            bundled_overrides: overrides
                .iter()
                .map(|(k, v)| (k.to_string(), *v))
                .collect::<HashMap<_, _>>(),
        }
    }

    #[test]
    fn every_embedded_skill_has_a_skill_md() {
        for skill in skills() {
            assert!(
                BUNDLED_FILES
                    .iter()
                    .any(|(rel, _)| *rel == format!("{}/SKILL.md", skill.name)),
                "{} has embedded files but no SKILL.md",
                skill.name
            );
        }
    }

    #[test]
    fn the_driver_and_the_reviewer_survive_the_kill_switch() {
        let (on, off) = enabled(&cfg(true, &[]));
        let names: Vec<&str> = on.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"forge-drive"), "driver must survive");
        assert!(names.contains(&"forge-review"), "reviewer must survive");
        assert!(
            off.contains(&"forge-plan".to_string()),
            "a non-survivor must actually be suppressed, else the switch is a no-op"
        );
    }

    #[test]
    fn an_override_disables_one_skill_without_touching_the_rest() {
        let (on, off) = enabled(&cfg(false, &[("forge-plan", false)]));
        assert_eq!(off, vec!["forge-plan".to_string()]);
        assert!(on.len() > 1, "only the overridden skill may be suppressed");
    }

    #[test]
    fn an_override_can_revive_a_skill_the_global_switch_disabled() {
        let (on, _) = enabled(&cfg(true, &[("forge-plan", true)]));
        assert!(on.iter().any(|s| s.name == "forge-plan"));
    }

    /// The selection tests above prove which skills are chosen; only this one
    /// proves a body actually reaches the disk, which is the whole mechanism.
    #[test]
    fn extraction_writes_real_bodies_and_is_idempotent() {
        let first = ensure_extracted(&cfg(false, &[])).expect("extract");
        let driver = first.root.join("forge-drive/SKILL.md");
        let body = std::fs::read_to_string(&driver).expect("driver body on disk");
        assert!(
            body.starts_with("---"),
            "frontmatter survived the round trip"
        );
        assert!(first.root.join(".complete").exists());

        let second = ensure_extracted(&cfg(false, &[])).expect("re-extract");
        assert_eq!(first.installed, second.installed);

        // Flipping the switch must rewrite the tree, not leave a disabled skill
        // behind — a stale body on disk is indistinguishable from a live one.
        let narrowed = ensure_extracted(&cfg(false, &[("forge-plan", false)])).expect("narrow");
        assert!(!narrowed.root.join("forge-plan/SKILL.md").exists());
        assert!(narrowed.root.join("forge-drive/SKILL.md").exists());

        ensure_extracted(&cfg(false, &[])).expect("restore");
    }

    #[test]
    fn frontmatter_flag_reads_only_the_leading_block() {
        assert!(frontmatter_flag(
            "---\nsurvives_kill_switch: true\n---\nbody",
            "survives_kill_switch"
        ));
        assert!(!frontmatter_flag(
            "---\nname: x\n---\nsurvives_kill_switch: true",
            "survives_kill_switch"
        ));
        assert!(!frontmatter_flag("no frontmatter", "survives_kill_switch"));
    }
}
