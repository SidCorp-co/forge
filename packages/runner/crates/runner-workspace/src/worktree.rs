//! What git says about the checkout a run was declared against, and giving
//! one back.
//!
//! This box cuts no checkout. A run's worktree is made by whoever dispatched
//! the run, at a path that dispatcher chose, and declared here
//! (`daemon/run_record.rs`), so every path in this module is read off a row
//! and put to git; none is built from a convention of this box's own.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tokio::process::Command;

use crate::worktree_processes::{Clearing, Loud, Say, Verdict};
use runner_platform::error::{Error, Result};

async fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))
}

/// What git says is at a path.
///
/// `git worktree remove` refuses a main working tree by design, so a caller
/// that learns this from a failed removal cannot tell a refusal that will
/// never succeed from one that might, and retries it forever (ISS-1183). The
/// question is put to git at the path itself rather than derived from the
/// path's shape, which is why it needs no repo root and why it holds wherever
/// the worktree sits: a checkout under `<repo>/.claude/worktrees/` answers
/// `Linked` exactly as one under `<repo>/.worktrees/` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    /// A linked worktree. `git worktree remove` takes it.
    Linked,
    /// The repository's main working tree. It is nobody's to remove.
    MainWorkingTree,
    /// A directory that is no checkout's top level, so git asked there climbed
    /// to the checkout around it and answered for that one, named here. A
    /// nested worktree whose `.git` file a recursive delete has already taken
    /// reads this way while its directory stands, and so does any stray
    /// directory under a repository's worktree roots. Nothing git says at the
    /// path is about the path: read as an answer, it recorded sid-desk's
    /// ISS-689 checkout as the repository's own working tree (ISS-1250).
    Enclosed(PathBuf),
    /// Git names no worktree here.
    NotAWorktree,
    /// Git could not be asked, which is not an answer.
    Unknown,
}

/// Ask git what `worktree` is.
///
/// The top level comes first: a path that is not its own top level is
/// answered for by whatever checkout encloses it, and neither directory below
/// is about the path. Then a main working tree's `--git-dir` and
/// `--git-common-dir` are the same directory; a linked worktree's `--git-dir`
/// is `<common>/worktrees/<name>` and differs. Both are resolved against the
/// checkout before they are compared, because git answers either one
/// relatively. A bare repository or a `.git` directory has no top level, git
/// refuses the question there, and that reads as no worktree.
pub async fn kind_at(worktree: &Path) -> Kind {
    if !worktree.is_dir() {
        return Kind::NotAWorktree;
    }
    let out = Command::new("git")
        .args([
            "rev-parse",
            "--show-toplevel",
            "--git-dir",
            "--git-common-dir",
        ])
        .current_dir(worktree)
        .stdin(Stdio::null())
        .output()
        .await;
    let Ok(out) = out else {
        return Kind::Unknown;
    };
    if !out.status.success() {
        return Kind::NotAWorktree;
    }
    kind_of(worktree, &String::from_utf8_lossy(&out.stdout))
}

/// What git's three-line answer means, split from the asking so the reading
/// is testable without a git that can be made to answer wrongly.
///
/// An answer that is not three paths is `Unknown` rather than a guess: the
/// caller refuses on that, and refusing costs an operator a sweep where
/// guessing could cost them a checkout.
///
/// Git's answers are joined to the directory the child ran in, which is
/// `worktree`, and every path in the comparison — the three answers and
/// `worktree` itself — is spelled by [`resolved_for_compare`] and by nothing
/// else. Two spellings of one path then compare equal: a symlinked or `..`
/// one, one whose leaf a removal has already taken, and on Windows a rootless
/// `/repo`, which only a spelling that walks to an ancestor gives a drive.
fn kind_of(worktree: &Path, answer: &str) -> Kind {
    let mut lines = answer.lines();
    let (Some(top), Some(git_dir), Some(common_dir)) = (lines.next(), lines.next(), lines.next())
    else {
        return Kind::Unknown;
    };
    let resolve = |p: &str| resolved_for_compare(&worktree.join(p));
    let top = resolve(top);
    if top != resolved_for_compare(worktree) {
        return Kind::Enclosed(top);
    }
    if resolve(git_dir) == resolve(common_dir) {
        Kind::MainWorkingTree
    } else {
        Kind::Linked
    }
}

/// Where the checkout a run was declared against actually is, according to
/// git's registry rather than to whether the path resolves.
///
/// An absent path is not proof of removal and never was. `git worktree move`
/// takes the directory and repoints the administrative entry, leaving a live,
/// registered worktree behind a path that no longer resolves; a rename, a
/// relocation, or a filesystem not mounted yet at boot does the same thing
/// without anybody deciding it. Reading that as *released* is how three runs
/// on sid-xeon-1 were recorded as having given back checkouts that were
/// sitting on disk holding a `wip(salvage)` commit (ISS-1193).
///
/// So the question an absent path asks is *is this worktree registered
/// somewhere else?*, and the registry is where it is put.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Residence {
    /// A linked worktree, registered at this very path.
    Linked,
    /// The repository's own main working tree. It is nobody's to remove.
    MainWorkingTree,
    /// The path is a directory that is no checkout's top level, and git asked
    /// there answered for the enclosing checkout named here — [`Kind::Enclosed`].
    /// Whatever it holds, nothing read at it is this checkout's.
    Enclosed(PathBuf),
    /// The path is a directory and git names no worktree at it. Something is
    /// there; a checkout is not.
    NotAWorktree,
    /// The path holds nothing and git's entry for this checkout names another
    /// path, which is there. The checkout moved; it was not removed.
    MovedTo(PathBuf),
    /// The path holds nothing and git still registers a worktree — here, or at
    /// the path it was moved to, which is not there either. Nothing removed
    /// it: `git worktree remove` takes the entry with the directory, and this
    /// entry is still standing. The path carried is the one git registers.
    RegisteredButMissing(PathBuf),
    /// The path holds nothing and git registers more than one entry that could
    /// be this checkout's. Git names a second worktree after the first's
    /// basename plus a digit, so a basename alone stops being an identity as
    /// soon as two exist — and answering `Gone` on a name that could belong to
    /// either is the guess this whole function exists to refuse.
    Ambiguous(Vec<PathBuf>),
    /// Neither a directory nor any entry that could name one. The only reading
    /// that means removed.
    Gone,
    /// The registry could not be read, which is not an answer.
    Unknown(String),
}

/// The administrative entry git keeps for one linked worktree: the name it was
/// filed under, and the checkout it currently points at.
///
/// `git worktree move` rewrites the second and leaves the first alone, so the
/// name is the identity that survives a move. Git derives it from the basename
/// of the path the worktree was added at, which is how a run's path finds its
/// own entry again after the directory beneath it has gone.
fn entry_points_at(gitdir: &Path) -> std::result::Result<Option<PathBuf>, String> {
    // `<checkout>/.git`, absolute, one line. The checkout is its parent.
    match std::fs::read_to_string(gitdir) {
        Ok(text) => Ok(Path::new(text.trim()).parent().map(Path::to_path_buf)),
        // Not every directory entry under `worktrees/` is a worktree's: git
        // writes other files there, and one that holds no `gitdir` names no
        // checkout. That is an answer, and a different thing from a read this
        // box was not allowed to take, which is not (ISS-1193).
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound) => Ok(None),
        Err(e) if e.raw_os_error() == Some(20) => Ok(None),
        Err(e) => Err(format!("{} could not be read: {e}", gitdir.display())),
    }
}

/// Whether the entry name `have` could be the one git filed `want` under.
///
/// Git names a linked worktree's administrative entry after the basename of
/// the path it was added at, and where that name is taken it appends a digit
/// and tries again. So the names that could belong to a path are its basename
/// and that basename followed by digits — and where more than one of them is
/// standing, none of them is an identity.
fn could_be_filed_as(have: &std::ffi::OsStr, want: &std::ffi::OsStr) -> bool {
    let (Some(have), Some(want)) = (have.to_str(), want.to_str()) else {
        return have == want;
    };
    have.strip_prefix(want)
        .is_some_and(|tail| tail.chars().all(|c| c.is_ascii_digit()))
}

/// The spelling of `path` that two callers naming the same checkout both
/// arrive at.
///
/// Neither side of the comparison this serves can be trusted to spell a path
/// the way the other does. Git answers out of its own registry; the ledger
/// holds whatever [`path`] built out of the repo root it was given. macOS
/// resolves `/var` to `/private/var`, Windows hands back a long name where the
/// caller holds an 8.3 one, and either can differ in its separators. Comparing
/// those raw is how a checkout git still registers reads as one nobody
/// registers — which on a path whose directory is not named after its branch
/// is a false `Gone`, and a false release (ISS-1193).
///
/// `canonicalize` settles all of that and needs the file to be there, and the
/// whole subject here is a path that is not. So the longest ANCESTOR that does
/// exist is canonicalised and the rest re-attached: a checkout that has gone
/// still sits under a repository that has not, and that is enough to settle
/// the spelling of everything above it.
///
/// Where NO ancestor canonicalises, the input comes back as it came, because
/// nothing was found to settle it with. That is the condition, and it is not a
/// category of path: a relative name nothing exists under reaches it, and so
/// does an absolute one on a drive or a share this box cannot reach, while a
/// relative name under a directory that IS there resolves like any other.
/// Reading it as *relative* would also mislead about `/x` on Windows, which
/// means the current drive's `x` and canonicalises against it exactly as the
/// platform intends.
///
/// The spelling this returns is the one that COMPARES, so it is also the one
/// the refusals carry. On Windows that is the verbatim `\\?\` form, which is
/// uglier to read than git's answer and is the only one a caller can hold
/// against a row; the refusals name the ledger's own path beside it.
///
/// `pub(crate)`: [`worktree_processes`](crate::worktree_processes) compares a
/// path a process still sits in against one whose directory is already gone,
/// which is this same problem from the other side and not a second one to
/// solve twice.
pub(crate) fn resolved_for_compare(path: &Path) -> PathBuf {
    if let Ok(real) = path.canonicalize() {
        return real;
    }
    let mut tail = Vec::new();
    let mut at = path;
    while let (Some(parent), Some(name)) = (at.parent(), at.file_name()) {
        tail.push(name);
        if let Ok(real) = parent.canonicalize() {
            let mut out = real;
            for part in tail.iter().rev() {
                out.push(part);
            }
            return out;
        }
        at = parent;
    }
    path.to_path_buf()
}

/// `<common>/worktrees`, where every linked worktree's entry lives.
async fn admin_root(repo: &Path) -> std::result::Result<PathBuf, String> {
    let out = Command::new("git")
        .args(["rev-parse", "--git-common-dir"])
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("git could not be run in {}: {e}", repo.display()))?;
    if !out.status.success() {
        return Err(format!(
            "git names no repository at {}: {}",
            repo.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if said.is_empty() {
        return Err(format!(
            "git answered nothing when asked for {}'s common directory",
            repo.display()
        ));
    }
    let common = Path::new(&said);
    let common = if common.is_absolute() {
        common.to_path_buf()
    } else {
        repo.join(common)
    };
    Ok(common.join("worktrees"))
}

/// Put the absent path's question to git: registered here, moved, or gone.
///
/// `repo` is the repository whose registry is asked. A repository that cannot
/// be asked answers [`Residence::Unknown`] and NOT [`Residence::Gone`]: the
/// caller refuses on that, and a refusal costs an operator one `run release`
/// where a guess costs them the ability to trust any row in the ledger.
pub async fn residence_of(repo: &Path, worktree: &Path) -> Residence {
    match kind_at(worktree).await {
        Kind::Linked => return Residence::Linked,
        Kind::MainWorkingTree => return Residence::MainWorkingTree,
        Kind::Enclosed(top) => return Residence::Enclosed(top),
        Kind::Unknown => {
            return Residence::Unknown(format!(
                "git could not be asked what {} is",
                worktree.display()
            ))
        }
        // Something IS at the path and git says it is no checkout. That is an
        // answer already, and a different one from the absence below; only the
        // absence is the question this function exists to put to the registry.
        Kind::NotAWorktree if worktree.is_dir() => return Residence::NotAWorktree,
        Kind::NotAWorktree => {}
    }
    let admin = match admin_root(repo).await {
        Ok(a) => a,
        Err(why) => return Residence::Unknown(why),
    };
    // One spelling, taken once, and every path compared against it is put
    // through the same reading — so there is no second way to decide that two
    // paths are the same checkout.
    let want_at = resolved_for_compare(worktree);
    let Some(want) = want_at.file_name().map(std::ffi::OsStr::to_os_string) else {
        return Residence::Unknown(format!("{} names no entry", worktree.display()));
    };
    let entries = match std::fs::read_dir(&admin) {
        Ok(e) => e,
        // No entries directory at all: this repository holds no linked
        // worktree, so it registers none at the path either. Any OTHER reason
        // the directory would not open is a read this box could not take, and
        // a read nobody took says nothing about what is registered.
        Err(e) if matches!(e.kind(), std::io::ErrorKind::NotFound) => return Residence::Gone,
        Err(e) => return Residence::Unknown(format!("{} could not be read: {e}", admin.display())),
    };
    let mut could_be_ours = Vec::new();
    for e in entries {
        let e = match e {
            Ok(e) => e,
            Err(why) => {
                return Residence::Unknown(format!(
                    "{} could not be listed to the end: {why}",
                    admin.display()
                ))
            }
        };
        // Both sides of the comparison below go through the one reading, so
        // there is no second way to decide two paths are one checkout. Git
        // hands back an already-resolved path on Linux and macOS, so no test
        // on those platforms can turn THIS call red; it earns its place on
        // Windows, where git answers forward slashes and a long name and
        // `canonicalize` answers the verbatim form. The `runner
        // (windows-latest)` job is its witness, and it is named here so the
        // next reader does not read a local green as evidence for it.
        let at = match entry_points_at(&e.path().join("gitdir")) {
            Ok(Some(at)) => resolved_for_compare(&at),
            Ok(None) => continue,
            Err(why) => return Residence::Unknown(why),
        };
        if at == want_at {
            return Residence::RegisteredButMissing(at);
        }
        if could_be_filed_as(&e.file_name(), &want) {
            could_be_ours.push(at);
        }
    }
    match could_be_ours.len() {
        0 => Residence::Gone,
        1 if could_be_ours[0].is_dir() => Residence::MovedTo(could_be_ours.remove(0)),
        // The entry survived and the checkout it names did not. That is the
        // same standing as an entry over an absent directory here: nothing
        // took this checkout back, and pruning the entry is an operator's act.
        1 => Residence::RegisteredButMissing(could_be_ours.remove(0)),
        _ => Residence::Ambiguous(could_be_ours),
    }
}

/// Give a linked checkout back, and say so.
///
/// `why` is the caller's reason and is not decoration: a removal that logs
/// nothing leaves exactly the evidence a KEEP leaves — an empty directory —
/// and two of those on this box took four hours of an operator's day to tell
/// apart, with the answer never established from the journal at all
/// (ISS-1250). The refusal is said too, for the same reason in reverse: a
/// directory still standing because git would not take it is not a directory
/// nobody asked about.
///
/// What is LIVING in the checkout is given back before the directory is. A
/// removal that is only a filesystem act leaves every process a run started in
/// its tree still bound to its port and still holding whatever it held, with
/// the tree that named it gone (ISS-1271), so this refuses rather than removing
/// over a resident it could not end. The refusal is bounded and does not bring
/// ISS-1188 back: `terminate::release` wraps every error this returns in
/// `ledger::note_release_refusal`, and one still standing past
/// `RELEASE_GRACE_SECS` or `RELEASE_ATTEMPT_BOUND` goes through
/// `close_loop::close`, which returns the run's leases, before the run is ended
/// over it. So a process nothing can kill costs an operator a window, not a box.
pub async fn remove_at(repo: &str, worktree: &std::path::Path, why: &str) -> Result<()> {
    remove_at_clearing(repo, worktree, why, &Clearing::this_box()).await
}

/// [`remove_at`], with the reading and the signalling supplied, which is how
/// every arm of it is exercised without a test having to make a real process
/// behave that way.
pub async fn remove_at_clearing(
    repo: &str,
    worktree: &std::path::Path,
    why: &str,
    clearing: &Clearing<'_>,
) -> Result<()> {
    match clearing.clear(worktree).await.verdict(worktree) {
        Verdict::Refuse(said) => {
            tracing::warn!("[worktree] {repo}: {said}");
            return Err(Error::Other(said));
        }
        // The level is the verdict's, because a removal that ended something
        // and one that only said how complete its reading was are not the
        // same event — and the second is every removal on a box with other
        // people's processes on it (ISS-1271, the judging run's observation 2).
        Verdict::Take(Some(Say {
            loud: Loud::Notable,
            said,
        })) => tracing::warn!("[worktree] {repo}: {said}"),
        Verdict::Take(Some(Say {
            loud: Loud::Routine,
            said,
        })) => tracing::info!("[worktree] {repo}: {said}"),
        Verdict::Take(None) => {}
    }
    let out = git(
        repo,
        &["worktree", "remove", &worktree.to_string_lossy(), "--force"],
    )
    .await?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr).trim().to_string();
        // Whether anything is still standing is read, not assumed: git refuses
        // a path it has no record of just as it refuses one it will not give
        // up, and those two leave opposite directories behind. A sentence that
        // asserted the wrong one would be this issue's own defect — a claim
        // about state nobody measured — committed by the line written to end it
        // (consult 09d909 F1).
        let standing = worktree.exists();
        tracing::warn!(
            "[worktree] {repo}: git would not remove {} ({said}) — {}",
            worktree.display(),
            if standing {
                "the directory is still there"
            } else {
                "and there is no directory at that path either"
            }
        );
        return Err(Error::Other(format!("git worktree remove failed: {said}")));
    }
    tracing::info!("[worktree] {repo}: removed {} — {why}", worktree.display());
    Ok(())
}
