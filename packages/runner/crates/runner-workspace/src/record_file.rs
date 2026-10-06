//! A versioned JSON record a daemon writes into the runner's config directory
//! for `forge-runner status`, another process, to read back: the forge-master
//! install ([`crate::master_skill`]) and the orientation each checkout carries
//! ([`crate::orientation_record`]).

use std::path::Path;

use serde::{de::DeserializeOwned, Serialize};

/// What reading a record found.
#[derive(Debug, PartialEq, Eq)]
pub enum Read<R> {
    Absent,
    Unreadable(String),
    Record(R),
}

/// The words an [`Read::Unreadable`] carries for a newer build's record, which
/// a writer refuses to overwrite.
const NEWER: &str = "which this build does not read";

/// Read the record at `path`, refusing by name any `version` but `version`
/// rather than reading a newer build's record as this one's.
pub fn read<R: DeserializeOwned>(path: &Path, version: u32) -> Read<R> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Read::Absent,
        Err(e) => return Read::Unreadable(format!("{}: {e}", path.display())),
    };
    let doc: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return Read::Unreadable(format!("{}: does not parse: {e}", path.display())),
    };
    match doc.get("version").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(version) => {}
        Some(v) => {
            return Read::Unreadable(format!(
                "{}: version {v}, {NEWER} (it reads {version})",
                path.display()
            ))
        }
        None => return Read::Unreadable(format!("{}: carries no version", path.display())),
    }
    match serde_json::from_value(doc) {
        Ok(r) => Read::Record(r),
        Err(e) => Read::Unreadable(format!("{}: does not parse: {e}", path.display())),
    }
}

/// Replace `dir/name` with `next(what it holds)` under an exclusive lock, so
/// two processes writing at once cannot drop each other's line. A torn or
/// foreign file is read as none; a newer build's is refused, not overwritten.
pub fn rewrite<R: Serialize + DeserializeOwned>(
    dir: &Path,
    name: &str,
    version: u32,
    next: impl FnOnce(Option<R>) -> R,
) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let lock_path = dir.join(format!("{name}.lock"));
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&lock_path)
        .map_err(|e| format!("{}: {e}", lock_path.display()))?;
    lock.lock()
        .map_err(|e| format!("{}: {e}", lock_path.display()))?;
    let path = dir.join(name);
    let held = match read::<R>(&path, version) {
        Read::Absent => None,
        Read::Record(r) => Some(r),
        Read::Unreadable(why) if why.contains(NEWER) => {
            return Err(format!("not overwriting a newer build's record — {why}"));
        }
        Read::Unreadable(_) => None,
    };
    let body = serde_json::to_string_pretty(&next(held)).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{name}.{}.tmp", std::process::id()));
    let written = std::fs::write(&tmp, body).and_then(|()| std::fs::rename(&tmp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written.map_err(|e| format!("{}: {e}", path.display()))
}
