//! Whether the `forge` CLI standing in a bound checkout resolves the project
//! the checkout is bound to.
//!
//! The CLI finds a checkout's project by the name of its repository's root
//! folder: `$XDG_CONFIG_HOME` (else `~/.config`) `/forge/projects/<name>/
//! config.json`, whose `slug` is the project every tracker call from that
//! checkout reaches (forge-plugin `src/resolve/settings.mjs:entryUnder`). On
//! 2026-09-30 mowment's record held `slug: forge-dev`, so every `forge` call a
//! mowment master made read and wrote another project's issues. The runner's
//! binding key is a local name and may differ from core's slug by design (this
//! box binds `anhome` to core's `home-kieutrung-services-anhome`), so the
//! record is compared with core's slug for the bound project, never with the
//! binding key.
//!
//! The layout is forge-plugin's, not this repository's: a change there moves
//! the path read here, and nothing in this repository would say so.

use std::path::{Path, PathBuf};

use super::source::Unreadable;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Slug {
    Matches {
        record: PathBuf,
        slug: String,
    },
    Drift {
        record: PathBuf,
        cli: String,
        core: String,
    },
    /// No record, so the CLI in this checkout resolves no project at all.
    NoRecord {
        record: PathBuf,
    },
    /// A record whose `slug` the CLI would read, and no slug from core to hold
    /// it against.
    CoreUnknown {
        record: PathBuf,
        cli: String,
    },
    Unreadable(Unreadable),
}

/// The forge CLI's configuration directory, by its own rule: any non-empty
/// `XDG_CONFIG_HOME`, else `~/.config`.
pub fn cli_config_dir(
    var: impl Fn(&str) -> Option<String>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    let base = match var("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(x) => PathBuf::from(x),
        None => home?.join(".config"),
    };
    Some(base.join("forge"))
}

pub fn record_path(cli_dir: &Path, repo: &Path) -> Option<PathBuf> {
    let name = repo.file_name()?;
    Some(cli_dir.join("projects").join(name).join("config.json"))
}

pub fn read(cli_dir: Option<&Path>, repo: &Path, core_slug: Option<&str>) -> Slug {
    let Some(record) = cli_dir.and_then(|d| record_path(d, repo)) else {
        return Slug::Unreadable(Unreadable::new(
            "forge CLI project record",
            format!(
                "no configuration directory resolves for the forge CLI, or {} has no folder name",
                repo.display()
            ),
        ));
    };
    let text = match std::fs::read_to_string(&record) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Slug::NoRecord { record },
        Err(e) => return Slug::Unreadable(Unreadable::new(record.display().to_string(), e)),
    };
    let cli = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(v) => match v.get("slug").and_then(serde_json::Value::as_str) {
            Some(s) => s.to_string(),
            None => {
                return Slug::Unreadable(Unreadable::new(
                    record.display().to_string(),
                    "the record carries no `slug`, so the CLI here resolves no project",
                ))
            }
        },
        Err(e) => {
            return Slug::Unreadable(Unreadable::new(
                record.display().to_string(),
                format!("does not parse: {e}"),
            ))
        }
    };
    match core_slug {
        Some(core) if core == cli => Slug::Matches { record, slug: cli },
        Some(core) => Slug::Drift {
            record,
            cli,
            core: core.to_string(),
        },
        None => Slug::CoreUnknown { record, cli },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use forge_runner_core::test_scratch::Scratch;

    fn plant(cli: &Path, name: &str, body: &str) {
        let dir = cli.join("projects").join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("config.json"), body).unwrap();
    }

    /// Criterion 12 — the mowment shape.
    #[test]
    fn a_record_naming_another_project_is_drift_naming_both_slugs() {
        let s = Scratch::new("top-slug");
        plant(s.path(), "mowment", r#"{"slug":"forge-dev"}"#);
        let got = read(Some(s.path()), Path::new("/w/mowment"), Some("mowment"));
        let Slug::Drift { record, cli, core } = got else {
            panic!("{got:?}")
        };
        assert_eq!((cli.as_str(), core.as_str()), ("forge-dev", "mowment"));
        assert!(record.ends_with("projects/mowment/config.json"));
    }

    /// The anhome shape: a binding key that is not core's slug is not drift.
    #[test]
    fn a_record_naming_cores_slug_matches_whatever_the_binding_is_called() {
        let s = Scratch::new("top-slug-ok");
        plant(
            s.path(),
            "anhome",
            r#"{"slug":"home-kieutrung-services-anhome"}"#,
        );
        let got = read(
            Some(s.path()),
            Path::new("/w/anhome"),
            Some("home-kieutrung-services-anhome"),
        );
        assert!(matches!(got, Slug::Matches { .. }), "{got:?}");
    }

    /// Criterion 13.
    #[test]
    fn no_record_is_said_as_none_never_as_matching() {
        let s = Scratch::new("top-slug-none");
        let got = read(Some(s.path()), Path::new("/w/sidpeak"), Some("sidpeak"));
        assert!(matches!(got, Slug::NoRecord { .. }), "{got:?}");
    }

    /// Criterion 22.
    #[test]
    fn a_record_that_does_not_parse_or_names_no_slug_is_unreadable() {
        let s = Scratch::new("top-slug-bad");
        plant(s.path(), "a", "{nope");
        plant(s.path(), "b", r#"{"language":"vi"}"#);
        for repo in ["/w/a", "/w/b"] {
            let got = read(Some(s.path()), Path::new(repo), Some("x"));
            assert!(matches!(got, Slug::Unreadable(_)), "{repo}: {got:?}");
        }
    }

    #[test]
    fn the_cli_directory_follows_the_clis_own_rule() {
        let home = Some(PathBuf::from("/home/u"));
        let set = |v: &'static str| move |k: &str| (k == "XDG_CONFIG_HOME").then(|| v.to_string());
        assert_eq!(
            cli_config_dir(set("/x"), home.clone()),
            Some(PathBuf::from("/x/forge"))
        );
        assert_eq!(
            cli_config_dir(set(""), home.clone()),
            Some(PathBuf::from("/home/u/.config/forge"))
        );
        assert_eq!(cli_config_dir(|_| None, None), None);
    }
}
