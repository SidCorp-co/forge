/*
 * The door on a platform that has no FIFO.
 *
 * Selected by `runner/mod.rs` for any non-unix target, so `ledger.rs` and
 * `blocked.rs` keep ONE shape of `Listening` and need no `cfg` of their own.
 */

use std::path::{Path, PathBuf};

use crate::error::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ring {
    Heard,
    NoListener,
}

#[derive(Debug)]
pub struct Listening {
    path: PathBuf,
}

impl Listening {
    pub fn path(&self) -> &Path {
        &self.path
    }
}

pub fn path_for(ledger_path: &Path, run_id: &str) -> PathBuf {
    ledger_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("doors")
        .join(format!("{run_id}.fifo"))
}

// cm:guard REFUSES by name and never answers `NoListener`, which is the one substitution that would be silent: `NoListener` is a live tier change a caller degrades to a park on, so returning it here would report a working fast path this platform does not have (ISS-964 criterion 11).
pub fn listen(_ledger_path: &Path, _run_id: &str) -> Result<Listening> {
    Err(no_fifo())
}

pub fn ring(_ledger_path: &Path, _run_id: &str) -> Result<Ring> {
    Err(no_fifo())
}

// cm:why the only operation that is vacuously true: a door this platform cannot open is a door there is nothing to take down, and a cleanup path that fails on it would abort an unwind over something that was never there.
pub fn take_down(_ledger_path: &Path, _run_id: &str) -> Result<()> {
    Ok(())
}

fn no_fifo() -> Error {
    Error::Other(
        "doorbell: this platform has no FIFO, so a bounded wait cannot be armed here — a run that must wait takes the human park instead".into(),
    )
}
