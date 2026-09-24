//! Forge Runner core library.
//!
//! Holds everything the daemon does, with zero CLI/GUI coupling so a thin
//! GUI/tray frontend can later drive the same logic over a local socket.

pub mod api;
pub mod auth;
pub mod config;
pub mod daemon;
pub mod error;
pub mod exe;
pub mod mcp;
pub mod observability;
#[cfg(test)]
pub mod platform_scope;
pub mod runner;
pub mod transport;
pub mod update;
pub mod workspace;

pub use error::{Error, Result};

#[cfg(test)]
mod compiled_everywhere {
    use crate::platform_scope;
    use std::path::{Path, PathBuf};

    /// Nothing this workspace compiles on every platform may name an API only
    /// unix has.
    ///
    /// The Windows job found this once, by failing to compile a helper that
    /// nine of its own cases shared. Nothing found the nine, and nothing here
    /// could have: a gate running on Linux cannot represent a compiler that
    /// does not run on Linux, so its green was not weak evidence about Windows
    /// — it was none at all. What IS readable from any platform is the source,
    /// so the source is what this reads.
    ///
    /// A module a parent drops or swaps for a non-unix target is not an
    /// exception to be listed here: it is read off the declaration, so it
    /// cannot go stale as files move.
    #[test]
    fn nothing_compiled_on_every_platform_names_an_api_only_unix_has() {
        let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../forge-runner/src");

        let mut files = Vec::new();
        collect(&core, &mut files);
        collect(&bin, &mut files);
        assert!(
            files.len() > 50,
            "the sweep found {} file(s) under {} — it is reading the wrong tree, and a sweep \
             that reads nothing passes for the same reason a clean one does",
            files.len(),
            core.display()
        );

        let read = |path: &Path| std::fs::read_to_string(path).expect("a file the sweep listed");
        let mut skip: Vec<PathBuf> = Vec::new();
        for path in &files {
            skip.extend(platform_scope::modules_not_compiled_off_unix(
                path,
                &read(path),
            ));
        }

        let mut found = Vec::new();
        for path in &files {
            if skip.iter().any(|s| path == s || path.starts_with(s)) {
                continue;
            }
            for hit in platform_scope::unguarded_unix_lines(&read(path)) {
                found.push(format!("{}:{}: {}", path.display(), hit.line, hit.text));
            }
        }

        assert!(
            found.is_empty(),
            "these lines are compiled on every platform and name something only unix has, so \
             the platforms that are not unix cannot build this workspace at all:\n  {}\n\nPut \
             the call inside a `#[cfg(unix)]` block, or give the whole case a cfg and say in \
             that module's own exception list what it needs unix for.",
            found.join("\n  ")
        );
    }

    fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                collect(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
}
