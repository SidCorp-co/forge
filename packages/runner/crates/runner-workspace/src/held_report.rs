//! Say on the issue when this box is holding a checkout nothing else has.
//!
//! A run that exits leaves a checkout, and the release decides what becomes of
//! it. Where the commits there are on no remote, or this box cannot tell, that
//! is work on one machine only, and the only record of it would otherwise be a
//! line in this box's journal. A hold nobody can see is the same shape as the
//! failure ISS-1250 is about — work that exists and no surface says so.
//!
//! Which question decides the directory matters, and this module got it wrong
//! twice. First it asked `salvage::publication_of` — is the work on a remote —
//! and wrote "run X keeps <path>" off the answer, though the release turns on
//! `salvage::fate_of` (ISS-1188) and removed those directories seconds later.
//! Then it read `fate_of` correctly and did not SEND the reading, so the
//! comment core wrote from it still said "has not been released" about every
//! one of them, four times in one evening on mowment (ISS-1250, reopened).
//! `Held::kept` is that reading, and it travels: core's schema requires it and
//! the posted sentence turns on it. `assets/held-worktree-wire.jsonl` pins the
//! payload both suites read.
//!
//! This pass reports and moves nothing. It says what one reading found — the
//! directory's fate and the work's publication — and never what the release
//! will then do: that is `worktree::remove_at`'s to log, once it has happened.

use crate::repo_cred::RepoCred;
use crate::salvage::{self, Fate, Publication};
use crate::worktree::Kind;
use runner_core::ledger::{Incarnation, Ledger, Run};
use runner_transport::{run_sessions, CoreClient};

/// What the box says about a checkout an exited run left behind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub worktree: String,
    pub branch: Option<String>,
    pub head: String,
    pub commits_unpushed: Option<u32>,
    pub reason: String,
    /// Whether the reading this report took REFUSES the checkout's removal.
    /// Sent as `kept`, and required by core, because the sentence a person
    /// reads on the issue turns on it and nothing else carries it.
    ///
    /// It is one half of the release's decision and never the whole of it:
    /// `false` says retention does not hold the directory here, not that the
    /// directory goes. `runner/terminate.rs` preserves a repository's own main
    /// working tree whatever retention says, and refuses a checkout whose diff
    /// it could not preserve, so a report that read `false` as "released" would
    /// be making the opposite mistake to the one this issue is about
    /// (consult 754b50 F1).
    pub kept: bool,
}

impl Held {
    pub fn to_json(&self) -> serde_json::Value {
        let mut v = serde_json::json!({
            "worktree": self.worktree,
            "head": self.head,
            "reason": self.reason,
            "kept": self.kept,
        });
        let obj = v.as_object_mut().expect("json! object");
        if let Some(b) = &self.branch {
            obj.insert("branch".into(), b.clone().into());
        }
        if let Some(c) = self.commits_unpushed {
            obj.insert("commitsUnpushed".into(), c.into());
        }
        v
    }
}

/// What reporting a held checkout needs of core.
#[allow(async_fn_in_trait)]
pub trait HeldReporter {
    async fn report(&self, session_id: &str, held: &Held) -> runner_platform::error::Result<()>;
}

/// The live implementation, over this box's device credential.
pub struct CoreHeld<'a>(pub &'a CoreClient);

impl HeldReporter for CoreHeld<'_> {
    async fn report(&self, session_id: &str, held: &Held) -> runner_platform::error::Result<()> {
        run_sessions::report_held_worktree(self.0, session_id, held.to_json()).await
    }
}

pub async fn at_risk(run: &Run) -> Option<Held> {
    let worktree = run.worktree_path.as_path();
    if !worktree.is_absolute() || !worktree.exists() {
        return None;
    }
    // Every line below reads git at the path, and at a path that is no
    // checkout's top level git answers for the checkout around it: sid-desk's
    // ISS-684 report named the parent's `staging` at the parent's HEAD
    // (ISS-1250, judge j3). What is at the path is asked first.
    if let Kind::Enclosed(top) = crate::worktree::kind_at(worktree).await {
        tracing::warn!(
            "[held-report] run {}: {} stands, but git, asked at the path, answers for the \
             enclosing checkout {}, so nothing this box would read from it is this checkout's — \
             no report is taken from it",
            run.run_id,
            worktree.display(),
            top.display()
        );
        return None;
    }
    // The credential is read at the path too, so it is resolved only here,
    // once the path has answered for itself (consult on 9ecec0c09 F1).
    let cred = &RepoCred::of(worktree).await;
    let head = git_line(worktree, &["rev-parse", "HEAD"]).await?;
    // A detached checkout answers `HEAD`, which is no branch at all, and a
    // report naming it as one sends a reader looking for a branch that is not
    // there — the one shape `Fate::NeedsARef` exists for.
    let branch = git_line(worktree, &["rev-parse", "--abbrev-ref", "HEAD"])
        .await
        .filter(|b| b != "HEAD");
    // Publication first, and the order is load-bearing rather than incidental.
    // `publication_of` runs `git fetch --prune --all`, which writes exactly the
    // `refs/remotes/*` that retention counts against, so a fate read before it
    // answers about a ref state the very next line replaces: a fetch can name
    // HEAD that nothing named a moment ago, and `--prune` can unname it. Read
    // the other way round, the sentence pairs a stale directory reading with a
    // fresh one about the work — two readings taken at different times, which
    // is the defect this issue exists to remove, wearing its reporting face.
    let publication = salvage::publication_of(worktree, cred).await;
    let fate = salvage::fate_of(worktree).await;
    let kept = matches!(fate, Fate::Kept { .. });
    if !kept && publication == Publication::Published {
        return None;
    }
    let named_by = match fate {
        Fate::Named => salvage::named_by(worktree).await,
        _ => None,
    };
    let remote = match publication {
        Publication::Unpublished { .. } => salvage::has_a_remote(worktree).await,
        _ => None,
    };
    Some(Held {
        worktree: worktree.display().to_string(),
        branch,
        head,
        commits_unpushed: match &publication {
            Publication::Unpublished { commits } => Some(*commits),
            _ => None,
        },
        reason: why(&fate, named_by.as_deref(), &publication, remote),
        kept,
    })
}

/// One sentence carrying both facts: what is true of the work, then what this
/// box's reading says about the directory, which is the half the posted
/// sentence turns on and the one the last two versions of this got wrong.
///
/// Every clause here is an observation and none is an outcome. What becomes of
/// the directory is the release's to say and `worktree::remove_at`'s to log:
/// this pass runs before it, reads one half of what it decides on, and a
/// sentence promising a removal would be the same defect wearing the other
/// face (consult 754b50 F1, F2).
///
/// `named_by` and `remote` only NAME what the two readings found — the ref
/// holding the commits, and whether any remote exists to publish them to. A
/// push is never mentioned: this pass makes none, and whether the release has
/// tried one is not something it read (ISS-1250 judge, finding 2).
fn why(
    fate: &Fate,
    named_by: Option<&str>,
    publication: &Publication,
    remote: Option<bool>,
) -> String {
    let directory = match fate {
        Fate::Kept { why } => format!(
            "this reading refuses this checkout's removal: it cannot tell whether the commits \
             here are named by any ref besides this checkout's own HEAD ({why}), and not knowing \
             is not the same as knowing it is safe"
        ),
        Fate::NeedsARef { commits } => format!(
            "{commits} commit(s) here are named by this checkout's HEAD and by nothing else, so a \
             release must give them a ref of their own before it may take this directory"
        ),
        Fate::Named => match named_by {
            Some(name) => format!(
                "the commits here are named by {name}, which this repository keeps, so they do \
                 not depend on this directory"
            ),
            None => "the commits here are named by a ref this repository keeps, so they do not \
                     depend on this directory"
                .to_string(),
        },
    };
    let work = match (publication, remote) {
        (Publication::Published, _) => "the work here is on a remote".to_string(),
        (Publication::Unpublished { commits }, Some(false)) => format!(
            "{commits} commit(s) here are on no remote, and this repository has no remote to \
             publish them to"
        ),
        (Publication::Unpublished { commits }, _) => {
            format!("{commits} commit(s) here are on no remote")
        }
        (Publication::Unknown { why }, _) => {
            format!("this box cannot tell whether the work here is on a remote ({why})")
        }
    };
    format!("{work} — {directory}")
}

async fn git_line(dir: &std::path::Path, args: &[&str]) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

pub async fn report_held_worktrees(
    reporter: &impl HeldReporter,
    ledger: &mut Option<Ledger>,
    boot_id: &str,
) -> usize {
    if boot_id.is_empty() {
        return 0;
    }
    let Some(led) = ledger.as_mut() else {
        return 0;
    };
    let runs = match led.unclosed_runs() {
        Ok(rows) => rows,
        Err(e) => {
            tracing::warn!("[held-report] cannot read unclosed runs: {e}");
            return 0;
        }
    };
    let mut said = 0;
    for run in runs {
        if run.incarnation != Incarnation::Exited {
            continue;
        }
        let Some(session_id) = run.session_id.clone() else {
            continue;
        };
        let Some(held) = at_risk(&run).await else {
            continue;
        };
        match reporter.report(&session_id, &held).await {
            Ok(()) => {
                tracing::warn!(
                    "[held-report] run {}: this reading {} the removal of {} — {}",
                    run.run_id,
                    // One reading and what it answered, never what the release
                    // then does: "keeps" and "holds" both read as a claim about
                    // the directory's future (ISS-1250, judge j2 finding 4).
                    if held.kept { "refused" } else { "did not refuse" },
                    held.worktree,
                    held.reason
                );
                said += 1;
            }
            Err(e) => tracing::warn!(
                "[held-report] run {}: core would not take the report ({e}) — the next sweep reads the checkout again and reports what it reads then",
                run.run_id
            ),
        }
    }
    said
}
