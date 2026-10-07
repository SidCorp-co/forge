//! What each project on this box spent, in tokens and estimated dollars,
//! over the last 24 hours and 7 days (ISS-1375): read from the transcripts
//! Claude Code writes under `~/.claude/projects`, priced by the per-model
//! rates in the runner's `config.toml`.
//!
//! A report and nothing else: no threshold, alert or park hangs off it, and
//! the transcripts are opened for reading only. Of a line it keeps the usage
//! counts, the model, the time, the response's ids and the cwd; the message
//! content is never deserialized, so nothing a session said reaches a frame.

pub mod lines;
pub mod read;
pub mod sum;

use std::path::PathBuf;

use super::source::Unreadable;

pub const DAY_MS: i64 = 86_400_000;
pub const WEEK_MS: i64 = 7 * DAY_MS;

/// Transcript bytes a live view reads in one gather before it starts no
/// further line: this box held 4.6 GB of transcript modified within 7 days
/// on 2026-10-07, read at about 650 MB/s by a release build, so a gather
/// spends at most about 1.6 s here and the first totals come within five.
pub const BUDGET_BYTES: u64 = 1 << 30;

/// What a frame shows of spend.
#[derive(Debug, Clone)]
pub enum Spend {
    /// The transcript root itself could not be listed.
    Unreadable(Unreadable),
    /// Reading toward the first whole window: no totals are shown until
    /// every transcript in it has been read.
    Reading {
        root: PathBuf,
        read: u64,
        outstanding: u64,
        files: usize,
    },
    Read(Box<sum::Totals>),
}
