//! Whether a run may stop: the three kernel conditions a run's stop is refused
//! for, decided from facts read elsewhere.
//!
//! Until ISS-297 only the forge-plugin's `turn/stop-check` hook refused a stop,
//! reading its lease through the plugin's own CLI; on a pane without the
//! plugin, or under the dev ruling that masters and runs act through the box
//! (FB-89), a run could end holding an issue nobody would hear about until the
//! sweep wrote its evidence afterwards. The runner's `SubagentStop` hook
//! (`forge-runner hook`) now asks this module, with facts from core (the
//! issue and its activity), the box's ledger, git and the process table.
//!
//! This module holds the decision and nothing else: no socket, no ledger, no
//! files, no network. `cmd/hook/stop.rs` supplies the facts and prints the
//! answer.
//!
//! The subject is a RUN: a subagent the box bound to a declared run. A pane's
//! own `Stop` is its master's turn, which holds no issue of its own, and is
//! never this gate's.

use std::path::Path;

use runner_platform::standing::Standing;

/// How many refusals in a row one run is given before its next stop is let
/// through. A condition the run cannot clear would otherwise hold it in a
/// loop for ever; the stop let through is journalled with what it left, so
/// the bound is a recorded release and not a quiet one.
pub const STOP_BOUND: usize = 3;

/// The box's journal of stop-gate outcomes, beside `config.toml`.
pub const JOURNAL: &str = "stop-gate.jsonl";

/// How many paths of a dirty tree a refusal names before it counts the rest.
const PATHS_SHOWN: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Condition {
    /// An issue the run holds in progress, with nothing written since the take.
    HeldUnwritten,
    /// The run's worktree has uncommitted changes.
    WorktreeDirty,
    /// A process the run started still stands in its worktree.
    ProcessRunning,
}

impl Condition {
    pub fn code(self) -> &'static str {
        match self {
            Condition::HeldUnwritten => "STOP_HELD_UNWRITTEN",
            Condition::WorktreeDirty => "STOP_WORKTREE_DIRTY",
            Condition::ProcessRunning => "STOP_PROCESS_RUNNING",
        }
    }
}

/// One row of core's per-issue activity (`GET /api/issues/:id/activity`),
/// reduced to what decides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activity {
    pub action: String,
    pub at_ms: i64,
    /// For `issue.statusChanged`, the status it moved to.
    pub to: Option<String>,
}

/// The move that takes an issue: `issue.statusChanged` to `in_progress`.
fn is_take(a: &Activity) -> bool {
    a.action == "issue.statusChanged" && a.to.as_deref() == Some("in_progress")
}

/// Whether a row is something written ON the issue. A status move is not —
/// the take is one, and so is core moving it back — and `record.wave` is the
/// master's record that it dispatched the run, not the run's work.
fn is_written(a: &Activity) -> bool {
    a.action != "issue.statusChanged" && a.action != "record.wave"
}

/// What one page of activity says about writing since the take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Since {
    Written,
    Unwritten,
    /// Nothing on this page decides it; read the page before it.
    ReadFurther,
}

/// Rows newest first. Written where a row that counts stands after both the
/// newest take and the run's declaration (`declared_ms`): a run dispatched on
/// an issue an earlier run already took has taken it at its declaration.
pub fn written_since(rows: &[Activity], declared_ms: i64) -> Since {
    for row in rows {
        if is_take(row) {
            return Since::Unwritten;
        }
        if is_written(row) {
            // Newest first: this row is the newest write, and every take is
            // older than it, so only the declaration can still stand after it.
            return if row.at_ms > declared_ms {
                Since::Written
            } else {
                Since::Unwritten
            };
        }
    }
    Since::ReadFurther
}

/// What one issue the run declared reads as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Issue {
    /// Not `in_progress`, or its lease was already returned: not held.
    NotHeld,
    HeldWritten,
    /// Held, nothing written since the take; `id` is core's uuid for it.
    HeldUnwritten {
        id: String,
    },
    /// Could not be read, and why.
    Unread(String),
}

pub struct Facts<'a> {
    pub run_id: &'a str,
    pub tree: &'a Path,
    /// The `forge-runner` a hint names: the binary judging the stop, so the
    /// hint runs as written where `forge-runner` is not on PATH.
    pub runner: &'a str,
    /// Each declared issue by key, with what it read as.
    pub issues: Vec<(String, Issue)>,
    /// The tree's uncommitted paths, or why they could not be read.
    pub dirty: Result<Vec<String>, String>,
    /// The processes standing in the tree since the declaration, or why not read.
    pub standing: Result<Vec<Standing>, String>,
    /// How many of this run's stops were refused in a row before this one.
    pub refused_in_a_row: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// Nothing holds the stop.
    Passed,
    /// Refused, with the reason the run is shown.
    Refused(String),
    /// A condition stands, and the bound lets the stop through anyway.
    LetGo,
}

impl Outcome {
    pub fn wire(&self) -> &'static str {
        match self {
            Outcome::Passed => "passed",
            Outcome::Refused(_) => "refused",
            Outcome::LetGo => "let_go",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub outcome: Outcome,
    /// Every condition that stood, refused or let go.
    pub conditions: Vec<Condition>,
    /// Every reading that could not be made. None of them refuses a stop.
    pub unread: Vec<String>,
}

/// The dirty hint stages the paths the gate saw, every one of them and by
/// name: a bare `git add -A` stages whatever else the tree holds, and the
/// plugin's bash guard refuses it (`stage-everything`) where a pane has it.
fn dirty_line(tree: &Path, paths: &[String]) -> String {
    let shown = paths.iter().take(PATHS_SHOWN).cloned().collect::<Vec<_>>();
    let more = paths.len().saturating_sub(PATHS_SHOWN);
    let more = if more > 0 {
        format!(", and {more} more")
    } else {
        String::new()
    };
    let quoted = sh_quote(&tree.display().to_string());
    let staged = paths
        .iter()
        .map(|p| sh_quote(p))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{} has uncommitted changes: {}{more}.\n  Clear it: first delete what the run made and no \
         longer needs (scratch files, logs, output) and take those paths out of the `git add` line \
         below; then run the lines below, with the commit message in place of the middle line. \
         {}\ngit -C {quoted} add -A -- {staged} && git -C {quoted} commit -F - <<'{TEXT_END}'\n\
         {COMMIT_TEXT}\n{TEXT_END}",
        tree.display(),
        shown.join(", "),
        as_written()
    )
}

/// The line that ends a hint's heredoc: the run's text is everything above it.
pub const TEXT_END: &str = "FORGE_TEXT";
/// The line of the held hint a run replaces with where its work stands.
pub const HELD_TEXT: &str = "<where the work stands>";
/// The line of the dirty hint a run replaces with its commit message.
pub const COMMIT_TEXT: &str = "<what the commit holds>";

/// What a hint says about the text a run puts in it. The text travels in a
/// quoted heredoc, so neither the shell nor JSON is the run's to quote: the
/// hints of 75c90007e wrapped it in single quotes, and an apostrophe, a double
/// quote or a line break broke them (ISS-297).
fn as_written() -> String {
    format!(
        "Write it as it reads: apostrophes, quotes and line breaks need no escaping, and only a \
         line reading {TEXT_END} alone ends it."
    )
}

/// `s` as one POSIX shell word, so a hint's command runs as written whatever
/// the path holds.
fn sh_quote(s: &str) -> String {
    if !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-+:@%,=".contains(&b))
    {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn standing_line(tree: &Path, standing: &[Standing]) -> String {
    let each = standing
        .iter()
        .map(|s| format!("pid {} ({})", s.pid, s.command))
        .collect::<Vec<_>>()
        .join(", ");
    let pids = standing
        .iter()
        .map(|s| s.pid.to_string())
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "{} started since this run was declared still {} in {}: {each}.\n  Clear it: wait for it \
         to finish, or stop it (`kill {pids}`).",
        if standing.len() == 1 {
            "A process".to_string()
        } else {
            format!("{} processes", standing.len())
        },
        if standing.len() == 1 {
            "stands"
        } else {
            "stand"
        },
        tree.display()
    )
}

fn held_line(key: &str, id: &str, runner: &str) -> String {
    format!(
        "{key} is in_progress under this run, and nothing has been written on it since it was \
         taken.\n  Clear it: write where the work stands on it as a comment: run the lines below as \
         they are, with your own words in place of the middle line. {}\n\
         {runner} api issues/{id}/comments -f body=@- <<'{TEXT_END}'\n{HELD_TEXT}\n{TEXT_END}\n  \
         A record or its `workState` counts as written too; or move the issue on.",
        as_written()
    )
}

pub fn decide(f: &Facts<'_>) -> Verdict {
    let mut lines: Vec<(Condition, String)> = Vec::new();
    let mut unread = Vec::new();
    let runner = sh_quote(f.runner);
    for (key, issue) in &f.issues {
        match issue {
            Issue::HeldUnwritten { id } => {
                lines.push((Condition::HeldUnwritten, held_line(key, id, &runner)));
            }
            Issue::Unread(why) => unread.push(format!("{key}: {why}")),
            Issue::NotHeld | Issue::HeldWritten => {}
        }
    }
    match &f.dirty {
        Ok(paths) if !paths.is_empty() => {
            lines.push((Condition::WorktreeDirty, dirty_line(f.tree, paths)));
        }
        Ok(_) => {}
        Err(why) => unread.push(format!("the worktree: {why}")),
    }
    match &f.standing {
        Ok(standing) if !standing.is_empty() => {
            lines.push((Condition::ProcessRunning, standing_line(f.tree, standing)));
        }
        Ok(_) => {}
        Err(why) => unread.push(format!("the process table: {why}")),
    }
    let conditions: Vec<Condition> = lines.iter().map(|(c, _)| *c).collect();
    let outcome = if lines.is_empty() {
        Outcome::Passed
    } else if f.refused_in_a_row >= STOP_BOUND {
        Outcome::LetGo
    } else {
        Outcome::Refused(reason(f, &lines))
    };
    Verdict {
        outcome,
        conditions,
        unread,
    }
}

fn reason(f: &Facts<'_>, lines: &[(Condition, String)]) -> String {
    let items = lines
        .iter()
        .map(|(c, line)| format!("- {}: {line}", c.code()))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Refused by the runner's stop gate: run {} is stopping while it holds work. Clear each \
         item below, then stop again.\n\n{items}\n\nThis is refusal {} of {STOP_BOUND} in a row \
         for this run; the stop after the last is let through and recorded on this box as \
         having left this work standing.",
        crate::ledger::short_id(f.run_id),
        f.refused_in_a_row + 1
    )
}

/// One journal line for a judged stop.
pub fn journal_line(at_ms: i64, run_id: &str, v: &Verdict) -> String {
    serde_json::json!({
        "at": at_ms,
        "run": run_id,
        "outcome": v.outcome.wire(),
        "conditions": v.conditions.iter().map(|c| c.code()).collect::<Vec<_>>(),
        "unread": v.unread,
    })
    .to_string()
}

/// How many of `run_id`'s stops the journal records refused since its last
/// one that was not. A line this build cannot read is passed over.
pub fn refused_in_a_row(journal: &str, run_id: &str) -> usize {
    let mut n = 0;
    for line in journal.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("run").and_then(serde_json::Value::as_str) != Some(run_id) {
            continue;
        }
        if v.get("outcome").and_then(serde_json::Value::as_str) == Some("refused") {
            n += 1;
        } else {
            n = 0;
        }
    }
    n
}

/// `git status --porcelain=v1 -z` split into its paths, a rename's source
/// dropped (its destination is the change).
pub fn porcelain_paths(z: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fields = z.split('\0').filter(|s| !s.is_empty());
    while let Some(entry) = fields.next() {
        let (code, path) = (
            entry.get(..2).unwrap_or(""),
            entry.get(3..).unwrap_or(entry),
        );
        out.push(path.to_string());
        if code.starts_with('R') || code.starts_with('C') {
            fields.next();
        }
    }
    out
}

#[cfg(test)]
mod tests;
