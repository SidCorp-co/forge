//! `run declare --cut`: the box cuts the run's tree itself, so the ledger can say the run created
//! it and its release may give it back (ISS-1016).
//!
//! A declaration without `--cut` names a tree that already stands, and the run adopts it: its
//! close, the release sweep and the worktree reaper all leave it as it was. Before this, every
//! declared tree was released as the run's own, and a master that declared a run over its batch
//! tree to read one secret had the tree removed at the run's close (FB-522). Whether a standing
//! tree was cut for the run or is somebody's work cannot be read off the tree, so the only tree a
//! release takes is one this box itself cut for the run.

use std::path::Path;

use runner_platform::git::git;

/// The branch a declaration asks its tree to be cut on, and the ref to cut it from.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Cut<'a> {
    pub branch: &'a str,
    /// `HEAD` of the declaring master's checkout where none is named.
    pub from: Option<&'a str>,
}

/// The ref a cut starts from.
fn start(cut: Cut<'_>) -> &str {
    cut.from.unwrap_or("HEAD")
}

/// Why `worktree` cannot be cut from `checkout` for a run, or `None`.
pub(crate) fn cut_refusal(worktree: &str, checkout: Option<&Path>) -> Option<String> {
    let path = Path::new(worktree);
    if !path.is_absolute() {
        return Some(format!(
            "`{worktree}` is not an absolute path, and the tree a run works in is named by one: the \
             brief and the release read it from any directory. Nothing was recorded"
        ));
    }
    if path.exists() {
        return Some(format!(
            "{worktree} already exists, so it cannot be cut for this run. Declare it without \
             `--cut` to adopt it — an adopted tree is left in place when the run ends — or name a \
             path that does not exist yet. Nothing was recorded"
        ));
    }
    if checkout.is_none() {
        return Some(format!(
            "this box could not read the checkout of the master pane that declared, so it has no \
             repository to cut {worktree} from. Cut it with `git worktree add` and declare it \
             without `--cut`: it is then adopted, and left in place when the run ends. Nothing \
             was recorded"
        ));
    }
    None
}

/// Cut `worktree` on a new branch from `checkout`, or say why git would not.
pub(crate) async fn cut_tree(checkout: &Path, worktree: &str, cut: Cut<'_>) -> Result<(), String> {
    let from = start(cut);
    let typed = format!("git worktree add -b {} {worktree} {from}", cut.branch);
    match git(
        checkout,
        &["worktree", "add", "-b", cut.branch, worktree, from],
    )
    .await
    {
        Some(out) if out.status.success() => Ok(()),
        Some(out) => Err(format!(
            "`{typed}` in {} failed: {}. Nothing was recorded",
            checkout.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        )),
        None => Err(format!(
            "`{typed}` could not be started in {}. Nothing was recorded",
            checkout.display()
        )),
    }
}

/// Take back a tree this declaration cut and then could not record: nothing was written in it,
/// so its directory and its new branch go, and what git said about either is logged.
pub(crate) async fn uncut_tree(checkout: &Path, worktree: &str, branch: &str) {
    for args in [
        &["worktree", "remove", "--force", worktree][..],
        &["branch", "-D", branch][..],
    ] {
        match git(checkout, args).await {
            Some(out) if out.status.success() => {}
            Some(out) => tracing::warn!(
                "[control] the tree cut at {worktree} for a declaration that was not recorded \
                 could not be taken back: `git {}` said {}",
                args.join(" "),
                String::from_utf8_lossy(&out.stderr).trim()
            ),
            None => tracing::warn!(
                "[control] the tree cut at {worktree} for a declaration that was not recorded \
                 could not be taken back: `git {}` could not be started",
                args.join(" ")
            ),
        }
    }
}

#[cfg(test)]
#[path = "cut_tests.rs"]
mod tests;
