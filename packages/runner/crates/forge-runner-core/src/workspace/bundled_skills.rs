//! Skills embedded in the runner binary (agent-driven pipeline, phase 0).
//!
//! The canonical autonomous skill set ships *inside* this binary rather than
//! arriving over a sync protocol, so it cannot drift from the code that
//! depends on it: `packages/runner/skills/` is walked by `build.rs` and the
//! resulting table is `include_str!`-ed in. At daemon start the set is
//! materialised into a version-keyed directory under the user data dir.
//!
//! [`seed_into`] copies the extracted set into an autonomous job's worktree.
//! Only a `drive` job gets it, and only these names — a project cannot
//! shadow them (core refuses the write, `packages/core/src/skills/lock.ts`),
//! which is what makes seeding at job start safe here when it was not for the
//! staged lanes.
//!
//! Design notes in `docs/proposals/agent-driven-pipeline.md`.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

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

/// Names this binary ships, whether or not they are currently enabled. The
/// disk-sync prune predicate needs the full set: a name suppressed by the kill
/// switch is still not the server's to delete.
pub fn all_names() -> Vec<String> {
    skills().into_iter().map(|s| s.name).collect()
}

/// Copy the enabled bundled set into `<worktree>/.claude/skills/<name>/`.
///
/// Overwrites in place rather than clearing the tree: the worktree also holds
/// the project's own synced skills, and this owns only its own names.
// cm:guard no `.hash` marker is written for these dirs — that marker is what marks a dir server-managed, and a bundled skill that carried one would be pruned by the next `skill_sync` pass the moment the server manifest (which never lists it) came back
// cm:edge lockstep -> packages/runner/crates/forge-runner-core/src/workspace/skill_sync.rs — `find_prunable` must keep `all_names()`; drop that and the seeding here is undone on the next sync
pub fn seed_into(worktree: &Path, cfg: &SkillSettings) -> Result<Vec<String>> {
    let extracted = ensure_extracted(cfg)?;
    write_tree(
        &worktree.join(".claude").join("skills"),
        &extracted.installed,
    )?;
    Ok(extracted.installed)
}

/// Write the named subset of the embedded files under `dest_root`.
fn write_tree(dest_root: &Path, names: &[String]) -> Result<()> {
    let keep: BTreeSet<&str> = names.iter().map(String::as_str).collect();
    for (rel, body) in BUNDLED_FILES {
        let Some(owner) = rel.split('/').next() else {
            continue;
        };
        if !keep.contains(owner) {
            continue;
        }
        let dest = dest_root.join(rel);
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| Error::Config(format!("mkdir {parent:?}: {e}")))?;
        }
        std::fs::write(&dest, body).map_err(|e| Error::Config(format!("write {dest:?}: {e}")))?;
    }
    Ok(())
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

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("forge-bundled-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn write_tree_lays_out_only_the_named_skills() {
        let root = scratch("write-tree");
        write_tree(&root, &["forge-drive".to_string()]).unwrap();

        assert!(root.join("forge-drive/SKILL.md").is_file());
        assert!(!root.join("forge-review").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    // cm:guard the marker is what `skill_sync::find_prunable` reads to decide a dir is the server's to delete — a bundled skill that carried one would be removed by the first sync after the job that needs it
    #[test]
    fn write_tree_leaves_no_server_managed_marker() {
        let root = scratch("no-marker");
        write_tree(&root, &all_names()).unwrap();

        for name in all_names() {
            assert!(
                !root.join(&name).join(".hash").exists(),
                "{name} carries a .hash marker"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_tree_keeps_a_project_skill_sharing_the_directory() {
        let root = scratch("coexist");
        std::fs::create_dir_all(root.join("project-own")).unwrap();
        std::fs::write(root.join("project-own/SKILL.md"), "mine").unwrap();

        write_tree(&root, &all_names()).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("project-own/SKILL.md")).unwrap(),
            "mine"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn all_names_reports_every_skill_regardless_of_the_kill_switch() {
        assert!(all_names().contains(&"forge-drive".to_string()));
        assert_eq!(all_names().len(), skills().len());
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

    /// Measured on forge-beta 2026-08-24: 76 `drive` jobs had finished `done`
    /// and exactly ONE carried a row in `phase_journal`. The cause was not the
    /// agent ignoring its skill — the driver's instruction named
    /// `forge_step_start`, a staged-pipeline tool that writes no journal, while
    /// every other mention in the same file said `forge_phase`. So the resume
    /// point silently did not exist: a session that died restarted at phase 1.
    ///
    /// The proposition survived the move to REST on 2026-09-02 and the target
    /// changed: the driver must name the three `/api/pipeline-runs` endpoints
    /// that write the journal, and must NOT still name `forge_phase` beside
    /// them — an instruction offering both is the same failure in a subtler
    /// shape, with the agent free to pick the one the shell cannot reach.
    #[test]
    fn the_driver_declares_phases_with_the_call_that_writes_the_journal() {
        let driver = BUNDLED_FILES
            .iter()
            .find(|(rel, _)| *rel == "forge-drive/SKILL.md")
            .expect("the driver skill is embedded")
            .1;
        for needle in [
            "pipeline-runs/<run>/phases -X POST",
            "pipeline-runs/<run>/phases/end -X POST",
            "pipeline-runs/<run>/resume-point",
        ] {
            assert!(
                driver.contains(needle),
                "the driver must show `{needle}` where it tells the agent to declare a phase"
            );
        }
        for (rel, body) in BUNDLED_FILES {
            // `forge_` with an underscore is an MCP tool name and nothing else: the
            // binary, the skills and the env vars all spell it `forge-` or `FORGE_`.
            assert!(
                !body.contains("forge_"),
                "{rel} names an MCP tool; the bundled skills run in a shell that reaches REST \
                 and nothing else, so a tool name there is an instruction the agent cannot \
                 follow — and `forge_step_start` is why this is not pedantry: naming it in \
                 place of the phase call left 76 finished drive jobs sharing one journal row"
            );
        }
    }

    /// A plan records the branch that was taken; the branches weighed and
    /// dropped survive only if the plan carries them, because Forge keeps the
    /// issue rather than the conversation (ISS-883). This holds the
    /// SPECIFICATION only — that the shipped bodies still ask for the section.
    /// Whether a given plan's rejected branches are real is prose, and nothing
    /// here can read it.
    // cm:edge contract -> packages/runner/skills/forge-plan/SKILL.md — that body publishes this heading to whoever writes the next plan; a reword there with none here leaves the rule enforced under a name no plan uses
    // cm:edge contract -> packages/runner/skills/forge-drive/SKILL.md — the driver is the only body guaranteed to be read, so the requirement dropping out of it is the rule reaching nobody, whatever forge-plan still says
    #[test]
    fn the_plan_bodies_still_ask_for_the_rejected_branches() {
        for name in ["forge-plan", "forge-drive"] {
            let body = BUNDLED_FILES
                .iter()
                .find(|(rel, _)| *rel == format!("{name}/SKILL.md"))
                .expect("the skill is embedded")
                .1;
            assert!(
                body.contains("Rejected alternatives"),
                "{name} no longer names the section that keeps a rejected branch"
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
