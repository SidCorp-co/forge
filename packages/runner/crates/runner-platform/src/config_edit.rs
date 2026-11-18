//! Writing `config.toml` without losing what the writing build does not know (ISS-1304).
//!
//! A build reads the file into its own `Config`, which holds only the keys it was compiled with.
//! Serialising that struct over the file dropped every other key silently: `forge-runner bind` on
//! an older build rewrote the file without `[runner] claude_version`, and every placement on the
//! box was then refused `CLAUDE_VERSION_UNPINNED`.
//!
//! So the file is edited, never replaced. What this build changed is the difference between the
//! struct as read from the file and the struct being written; only that difference is applied to
//! the document on disk (`toml_edit`), and every other key, section and comment stays as it was.
//! A file that cannot be read as a document is refused by name, never overwritten.

use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};
use toml_edit::{DocumentMut, Item, Table};

use crate::error::{Error, Result};

/// Write `value` to the TOML file at `path`, changing only the keys `value` changes from what the
/// file holds; a missing file is written whole. Atomic (`.tmp` + rename).
pub fn write_lossless<T: Serialize + DeserializeOwned>(path: &Path, value: &T) -> Result<()> {
    let after = toml::to_string_pretty(value).map_err(|e| Error::Config(e.to_string()))?;
    let body = match std::fs::read_to_string(path) {
        Ok(on_disk) => merged::<T>(&on_disk, &after).map_err(|why| {
            Error::Config(format!(
                "[CONFIG_UNMERGEABLE] {} was not written: {why}, and replacing it would drop \
                 every key this build does not know",
                path.display()
            ))
        })?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => after,
        Err(e) => return Err(e.into()),
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("toml.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// `on_disk` with the change from `T` as read from it to `after` (a serialised `T`) applied.
fn merged<T: Serialize + DeserializeOwned>(
    on_disk: &str,
    after: &str,
) -> std::result::Result<String, String> {
    let mut doc: DocumentMut = on_disk
        .parse()
        .map_err(|e| format!("it is not a TOML document ({e})"))?;
    let read: T = toml::from_str(on_disk).map_err(|e| format!("it does not read ({e})"))?;
    let before = toml::to_string_pretty(&read).map_err(|e| e.to_string())?;
    let before: DocumentMut = before.parse().map_err(|e| format!("{e}"))?;
    let after: DocumentMut = after.parse().map_err(|e| format!("{e}"))?;
    apply(
        doc.as_table_mut(),
        Some(before.as_table()),
        after.as_table(),
    );
    Ok(doc.to_string())
}

/// Apply to `old` what changed from `before` to `after`: a key `after` no longer holds is
/// removed, a value it changed or added is set, a table it holds is walked. A key neither holds
/// is one this build does not know, and is left alone.
fn apply(old: &mut Table, before: Option<&Table>, after: &Table) {
    if let Some(before) = before {
        for (key, _) in before.iter() {
            if !after.contains_key(key) {
                old.remove(key);
            }
        }
    }
    for (key, wanted) in after.iter() {
        let was = before.and_then(|b| b.get(key));
        let Some(wanted_table) = wanted.as_table() else {
            if !was.is_some_and(|w| same(w, wanted)) {
                old.insert(key, wanted.clone());
            }
            continue;
        };
        let was_table = was.and_then(Item::as_table);
        let slot = old.get_mut(key).map(as_table_in_place);
        match slot {
            Some(Some(table)) => apply(table, was_table, wanted_table),
            _ => {
                let mut fresh = Table::new();
                fresh.set_implicit(true);
                apply(&mut fresh, was_table, wanted_table);
                if !fresh.is_empty() {
                    old.insert(key, Item::Table(fresh));
                }
            }
        }
    }
}

/// The table `item` holds, an inline one made a table first so it can take subtables; `None`
/// where it holds a value of another kind.
fn as_table_in_place(item: &mut Item) -> Option<&mut Table> {
    if let Some(inline) = item.as_inline_table() {
        *item = Item::Table(inline.clone().into_table());
    }
    item.as_table_mut()
}

/// Whether two values are the same value, however each is laid out.
fn same(a: &Item, b: &Item) -> bool {
    match (a.as_value(), b.as_value()) {
        (Some(a), Some(b)) => {
            a.clone().decorated("", "").to_string() == b.clone().decorated("", "").to_string()
        }
        _ => a.to_string() == b.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// What a build that predates `claude_version` knows of the file (0.18.0 on sid-xeon-1).
    #[derive(Debug, Default, Serialize, Deserialize)]
    struct OlderConfig {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        core_url: Option<String>,
        #[serde(default)]
        runner: OlderRunner,
        #[serde(default)]
        bindings: std::collections::BTreeMap<String, OlderBinding>,
    }

    #[derive(Debug, Default, Serialize, Deserialize)]
    struct OlderRunner {
        #[serde(default)]
        max_job_panes: u32,
    }

    #[derive(Debug, Default, Serialize, Deserialize)]
    struct OlderBinding {
        repo_path: String,
    }

    const ON_DISK: &str = r#"# this box's runner: pinned by hand, 2026-11-17
core_url = "https://core.example"

[runner]
max_job_panes = 4
# moved only by a passing canary
claude_version = "2.1.322"

[bindings.forge]
repo_path = "/p/forge"
project_id = "p-1"

[later]
flag = true
"#;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("forge-config-edit-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("config.toml")
    }

    /// ISS-1304: `bind` on a build whose struct has no `claude_version` wrote the file without
    /// it. Planted back (the struct serialised over the file), the pin, the comment and the
    /// unknown section are gone and this goes red.
    #[test]
    fn a_build_that_does_not_know_a_key_writes_the_file_and_the_key_survives() {
        let path = scratch("older");
        std::fs::write(&path, ON_DISK).unwrap();
        let mut older: OlderConfig = toml::from_str(ON_DISK).unwrap();
        older.bindings.insert(
            "orvio".into(),
            OlderBinding {
                repo_path: "/p/orvio".into(),
            },
        );
        older.runner.max_job_panes = 6;
        write_lossless(&path, &older).unwrap();

        let back = std::fs::read_to_string(&path).unwrap();
        let cfg: crate::config::Config = toml::from_str(&back).unwrap();
        assert_eq!(
            cfg.runner.claude_version.as_deref(),
            Some("2.1.322"),
            "the pin a newer build wrote was dropped by an older one:\n{back}"
        );
        assert_eq!(cfg.runner.max_job_panes, 6, "{back}");
        assert_eq!(
            cfg.bindings["orvio"].repo_path,
            std::path::Path::new("/p/orvio")
        );
        assert!(back.contains("# moved only by a passing canary"), "{back}");
        assert!(back.contains("[later]\nflag = true"), "{back}");
        let _ = std::fs::remove_file(&path);
    }

    /// What the struct removes is removed: an unbind takes its binding, a cleared key its line.
    #[test]
    fn a_key_the_writing_build_knows_and_clears_is_removed() {
        let path = scratch("clear");
        std::fs::write(&path, ON_DISK).unwrap();
        let mut older: OlderConfig = toml::from_str(ON_DISK).unwrap();
        older.bindings.remove("forge");
        older.core_url = None;
        write_lossless(&path, &older).unwrap();
        let back = std::fs::read_to_string(&path).unwrap();
        assert!(
            !back.contains("core_url") && !back.contains("/p/forge"),
            "{back}"
        );
        assert!(back.contains("claude_version = \"2.1.322\""), "{back}");
        let _ = std::fs::remove_file(&path);
    }

    /// A file that is not a document is refused by name and left as it was.
    #[test]
    fn a_file_that_does_not_parse_is_refused_by_name_and_kept() {
        let path = scratch("broken");
        std::fs::write(&path, "[runner\nclaude_version = 1").unwrap();
        let e = write_lossless(&path, &OlderConfig::default()).unwrap_err();
        assert!(e.to_string().contains("[CONFIG_UNMERGEABLE]"), "{e}");
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "[runner\nclaude_version = 1"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// No file yet: the struct is written whole, and an unchanged write changes nothing.
    #[test]
    fn a_missing_file_is_written_whole_and_an_unchanged_write_is_byte_for_byte() {
        let path = scratch("fresh");
        let _ = std::fs::remove_file(&path);
        let cfg: crate::config::Config =
            toml::from_str("[runner]\nclaude_version = \"2.1.322\"\n").unwrap();
        write_lossless(&path, &cfg).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.contains("claude_version = \"2.1.322\""), "{first}");
        std::fs::write(&path, ON_DISK).unwrap();
        let read: crate::config::Config = toml::from_str(ON_DISK).unwrap();
        write_lossless(&path, &read).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), ON_DISK);
        let _ = std::fs::remove_file(&path);
    }
}
