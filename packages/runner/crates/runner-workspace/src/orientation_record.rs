//! Every bound checkout's orientation brought to this build's shape at daemon
//! start, and the record of each write of it.
//!
//! Orientation used to be written only at bind, at a project-config change
//! and at a chat-turn refresh, so a box that upgraded onto a build moving it
//! (`.forge/orientation.md` under skip-worktree → `CLAUDE.local.md` plus
//! `claudeMdExcludes`) kept the old shape in every checkout until somebody
//! re-bound each one: on 2026-10-06 none of seven converted in 240 s after the
//! restart. A daemon start is the one moment every build change passes
//! through (an update's handover execs a new process), so each start writes
//! every bound checkout's orientation once, under the checkout's provision
//! lock. The write is idempotent: a second start over what the first left
//! writes nothing and records [`Outcome::Current`].
//!
//! The level-triggered shape of a controller that reconciles the whole set it
//! owns on start rather than waiting for the next event about each item
//! (kubernetes-sigs/controller-runtime `pkg/internal/controller/controller.go`,
//! `Start`: the sources' initial list enqueues every object before workers
//! run), and of `systemd-tmpfiles --create` run at every boot
//! (systemd `units/systemd-tmpfiles-setup.service.in`): declared local state is
//! applied idempotently at start, never only on change.
//!
//! `forge-runner status` is another process, so every outcome goes into
//! [`RECORD`] in the runner's config directory; a checkout that could not be
//! converted is named there and in the journal, never skipped.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::orientation::{self, Oriented, Refused};
use crate::provision::{checkout_lock, Contended};
use crate::record_file;

pub const RECORD: &str = "orientation.json";

/// The record's shape. A reader refuses any other by name.
pub const RECORD_VERSION: u32 = 1;

/// What one orientation write did, or why there was none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Outcome {
    /// An older runner's skip-worktree mark was lifted and the committed file
    /// restored; this instance's orientation is now in `CLAUDE.local.md`.
    Converted { note: String },
    /// A file was written: a first orientation, or another build's or project's replaced.
    Written,
    /// The checkout already held exactly this orientation; nothing was written.
    Current,
    /// The write was refused, by name.
    Refused { detail: String },
    /// The checkout is bound with no project id, so whose orientation it carries cannot be said.
    NoProject,
    /// The bound path holds no directory yet; its provision writes the orientation once it does.
    NoCheckout,
    /// Another process on this box holds the checkout's provision lock, and that provision writes it.
    Held,
    /// The checkout's provision lock could not be taken at all.
    Failed { detail: String },
}

impl Outcome {
    pub fn of(said: &Result<Oriented, Refused>) -> Self {
        match said {
            Ok(Oriented::Converted(note)) => Outcome::Converted { note: note.clone() },
            Ok(Oriented::Written) => Outcome::Written,
            Ok(Oriented::Current) => Outcome::Current,
            Err(e) => Outcome::Refused {
                detail: e.to_string(),
            },
        }
    }

    /// Whether the checkout carries this build's orientation now.
    pub fn oriented(&self) -> bool {
        matches!(
            self,
            Outcome::Converted { .. } | Outcome::Written | Outcome::Current
        )
    }

    /// What this outcome says about `path`, in the words `status` and the
    /// journal both print.
    pub fn says(&self, path: &Path, build: &str) -> String {
        let shown = path.display();
        match self {
            Outcome::Converted { note } => format!("converted by {build}: {note} ← {shown}"),
            Outcome::Written => format!("written by {build} ← {shown}"),
            Outcome::Current => {
                format!("already this build's, which checked it and wrote nothing ({build}) ← {shown}")
            }
            Outcome::Refused { detail } => {
                format!("NOT CONVERTED — {detail} (checked by {build}) ← {shown}")
            }
            Outcome::NoProject => format!(
                "NOT CONVERTED — config.toml binds it with no project_id, so whose orientation it carries cannot be said; `forge-runner bind <slug> --path {shown}` (checked by {build})"
            ),
            Outcome::NoCheckout => format!(
                "NOT CONVERTED — no directory there yet, so there is nothing to write into; its provision writes the orientation once it is cloned (checked by {build}) ← {shown}"
            ),
            Outcome::Held => format!(
                "NOT CONVERTED HERE — another process on this box is provisioning that checkout, and that provision writes its orientation (checked by {build}) ← {shown}"
            ),
            Outcome::Failed { detail } => {
                format!("NOT CONVERTED — {detail} (checked by {build}) ← {shown}")
            }
        }
    }
}

/// Which write point an outcome came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Point {
    Start,
    Provision,
}

impl Point {
    pub fn word(self) -> &'static str {
        match self {
            Point::Start => "at daemon start",
            Point::Provision => "at provision",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub slug: String,
    pub path: PathBuf,
    pub at_ms: i64,
    pub point: Point,
    /// The build that made this write, `<version> (<commit>)`.
    pub build: String,
    pub outcome: Outcome,
}

impl Entry {
    pub fn now(slug: &str, path: &Path, point: Point, outcome: Outcome) -> Self {
        Self {
            slug: slug.to_string(),
            path: path.to_path_buf(),
            at_ms: runner_core::agent_activity::now_ms(),
            point,
            build: format!(
                "{} ({})",
                runner_update::CURRENT_VERSION,
                runner_update::BUILD_COMMIT
            ),
            outcome,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub version: u32,
    pub entries: Vec<Entry>,
}

pub type Read = record_file::Read<Record>;

pub fn record_path(dir: &Path) -> PathBuf {
    dir.join(RECORD)
}

pub fn read(dir: &Path) -> Read {
    record_file::read(&record_path(dir), RECORD_VERSION)
}

/// How a write merges into what the record already holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Merge {
    /// The start sweep's whole census, begun at `since_ms`: a line it does not
    /// cover is a checkout no longer bound and goes, unless it was recorded
    /// after the census began.
    Census { since_ms: i64 },
    /// One write point, one checkout: every other line stands.
    Upsert,
}

fn merged(held: Vec<Entry>, new: Vec<Entry>, merge: Merge) -> Vec<Entry> {
    let mut out: Vec<Entry> = held
        .into_iter()
        .filter(|e| !new.iter().any(|n| n.slug == e.slug && n.path == e.path))
        .filter(|e| match merge {
            Merge::Census { since_ms } => e.at_ms >= since_ms,
            Merge::Upsert => true,
        })
        .collect();
    out.extend(new);
    out.sort_by(|a, b| (&a.slug, &a.path).cmp(&(&b.slug, &b.path)));
    out
}

pub fn record(dir: &Path, entries: Vec<Entry>, merge: Merge) -> Result<(), String> {
    record_file::rewrite(dir, RECORD, RECORD_VERSION, |held: Option<Record>| Record {
        version: RECORD_VERSION,
        entries: merged(held.map(|r| r.entries).unwrap_or_default(), entries, merge),
    })
}

/// Record `entries` where `dir` names a record, saying so where it cannot.
pub fn save(dir: Option<&Path>, entries: Vec<Entry>, merge: Merge) {
    let Some(dir) = dir else {
        tracing::warn!(
            "[orientation] no config directory resolves on this box, so `forge-runner status` cannot be told what the orientation write did"
        );
        return;
    };
    if let Err(e) = record(dir, entries, merge) {
        tracing::warn!(
            "[orientation] the record could not be written, so `forge-runner status` reports an older one: {e}"
        );
    }
}

pub fn log(entry: &Entry) {
    let slug = &entry.slug;
    let said = entry.outcome.says(&entry.path, &entry.build);
    let when = entry.point.word();
    match &entry.outcome {
        Outcome::Converted { .. } | Outcome::Written => {
            tracing::info!("[orientation] {slug} {when}: {said}")
        }
        Outcome::Current => tracing::debug!("[orientation] {slug} {when}: {said}"),
        _ => tracing::warn!("[orientation] {slug} {when}: {said}"),
    }
}

/// One checkout this box is bound to, and the project whose orientation it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bound {
    pub slug: String,
    pub project_id: Option<String>,
    pub repo: PathBuf,
    /// What core served for the project; `None` where it was not reached.
    pub orientation: Option<String>,
}

async fn converge_one(b: &Bound, lock_dir: Option<&Path>) -> Outcome {
    if b.project_id.is_none() {
        return Outcome::NoProject;
    }
    if !b.repo.is_dir() {
        return Outcome::NoCheckout;
    }
    let Some(lock_dir) = lock_dir else {
        return Outcome::Failed {
            detail: "no config directory resolves on this box, so the checkout's provision lock cannot be taken and a provision running beside this write could not be kept out".into(),
        };
    };
    let _held = match checkout_lock(lock_dir, &b.repo, Contended::LeaveIt).await {
        Ok(Some(held)) => held,
        Ok(None) => return Outcome::Held,
        Err(detail) => return Outcome::Failed { detail },
    };
    Outcome::of(&orientation::write_orientation(
        &b.repo,
        b.orientation.as_deref(),
        &b.slug,
    ))
}

/// Write every bound checkout's orientation once, at daemon start, and record
/// a line for each. `census_from` is when the set was read, and `None` where
/// it is not the whole census, which then prunes nothing.
pub async fn converge_every(
    bound: &[Bound],
    lock_dir: Option<&Path>,
    record_dir: Option<&Path>,
    census_from: Option<i64>,
) -> Vec<Entry> {
    let mut entries = Vec::with_capacity(bound.len());
    for b in bound {
        let entry = Entry::now(
            &b.slug,
            &b.repo,
            Point::Start,
            converge_one(b, lock_dir).await,
        );
        log(&entry);
        entries.push(entry);
    }
    let merge = match census_from {
        Some(since_ms) => Merge::Census { since_ms },
        None => Merge::Upsert,
    };
    save(record_dir, entries.clone(), merge);
    entries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_census_drops_an_unbound_checkout_and_keeps_a_line_written_after_it_began() {
        let at = |slug: &str, ms: i64| Entry {
            at_ms: ms,
            ..Entry::now(slug, Path::new("/x"), Point::Start, Outcome::Current)
        };
        let held = vec![at("gone", 10), at("bound-later", 50), at("kept", 10)];
        let out = merged(held, vec![at("kept", 40)], Merge::Census { since_ms: 30 });
        let slugs: Vec<_> = out.iter().map(|e| (e.slug.as_str(), e.at_ms)).collect();
        assert_eq!(slugs, vec![("bound-later", 50), ("kept", 40)]);
    }

    #[test]
    fn a_newer_builds_record_is_refused_by_name_and_left_standing() {
        let dir = std::env::temp_dir().join(format!("forge-orient-rec-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(record_path(&dir), r#"{"version":9,"entries":[]}"#).unwrap();
        let err = record(&dir, vec![], Merge::Upsert).unwrap_err();
        assert!(
            err.contains("newer build's record") && err.contains("version 9"),
            "{err}"
        );
        assert!(matches!(read(&dir), Read::Unreadable(w) if w.contains("version 9")));
    }
}
