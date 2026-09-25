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

use crate::error::{Error, Result};

async fn git(repo: &str, args: &[&str]) -> Result<std::process::Output> {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| Error::Other(format!("git {}: {e}", args.join(" "))))
}

/// A fixture for tests that need a checkout git registers: a new branch in a
/// linked worktree at `<repo>/.worktrees/<branch>`, a slash in the branch
/// becoming a dash in the directory.
#[cfg(test)]
pub(crate) async fn create(repo: &str, branch: &str, start_point: Option<&str>) -> Result<PathBuf> {
    let rel = format!(".worktrees/{}", branch.replace('/', "-"));
    let mut argv = vec!["worktree", "add", rel.as_str(), "-b", branch];
    argv.extend(start_point);
    let out = git(repo, &argv).await?;
    if !out.status.success() {
        return Err(Error::Other(format!(
            "git worktree add failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )));
    }
    Ok(PathBuf::from(repo).join(rel))
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
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// A linked worktree. `git worktree remove` takes it.
    Linked,
    /// The repository's main working tree. It is nobody's to remove.
    MainWorkingTree,
    /// Git names no worktree here.
    NotAWorktree,
    /// Git could not be asked, which is not an answer.
    Unknown,
}

/// Ask git what `worktree` is.
///
/// A main working tree's `--git-dir` and `--git-common-dir` are the same
/// directory; a linked worktree's `--git-dir` is `<common>/worktrees/<name>`
/// and differs. Both are resolved against the checkout before they are
/// compared, because git answers either one relatively.
pub async fn kind_at(worktree: &Path) -> Kind {
    if !worktree.is_dir() {
        return Kind::NotAWorktree;
    }
    let out = Command::new("git")
        .args(["rev-parse", "--git-dir", "--git-common-dir"])
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

/// What git's two-line answer means, split from the asking so the reading is
/// testable without a git that can be made to answer wrongly.
///
/// An answer that is not two paths is `Unknown` rather than a guess: the
/// caller refuses on that, and refusing costs an operator a sweep where
/// guessing could cost them a checkout.
fn kind_of(worktree: &Path, answer: &str) -> Kind {
    let mut lines = answer.lines();
    let (Some(git_dir), Some(common_dir)) = (lines.next(), lines.next()) else {
        return Kind::Unknown;
    };
    let resolve = |p: &str| {
        let p = Path::new(p);
        let abs = if p.is_absolute() {
            p.to_path_buf()
        } else {
            worktree.join(p)
        };
        abs.canonicalize().unwrap_or(abs)
    };
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
fn resolved_for_compare(path: &Path) -> PathBuf {
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
pub async fn remove_at(repo: &str, worktree: &std::path::Path, why: &str) -> Result<()> {
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    async fn run(dir: &Path, args: &[&str]) {
        Command::new("git")
            .args(args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .output()
            .await
            .unwrap();
    }

    /// The spelling a caller naming `<root>/<tail>` arrives at, built without
    /// going anywhere near the function under test: the root is there on every
    /// platform, so canonicalising IT settles `/var` against `/private/var`,
    /// an 8.3 name against its long one and the separators, and the tail this
    /// fixture chose is joined on after. A test that called
    /// `resolved_for_compare` to say what it expected would pass whatever that
    /// function did.
    fn named_as_any_caller_would(root: &Path, tail: &str) -> PathBuf {
        let mut at = root.canonicalize().expect("the repository is there");
        for part in tail.split('/') {
            at.push(part);
        }
        at
    }

    /// A repo of this test's own on `main` with one commit, removed when it drops.
    async fn repo(tag: &str) -> crate::test_scratch::Scratch {
        let root = crate::test_scratch::Scratch::new(&format!("worktree-{tag}"));
        run(&root, &["init", "-b", "main"]).await;
        run(&root, &["config", "user.email", "t@t"]).await;
        run(&root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "one\n").unwrap();
        run(&root, &["add", "."]).await;
        run(&root, &["commit", "-m", "init"]).await;
        root
    }

    #[tokio::test]
    async fn git_names_the_repo_root_a_main_working_tree_and_its_worktrees_linked() {
        let root = repo("kind").await;
        let r = root.to_string_lossy().to_string();
        let linked = create(&r, "ISS-8", None).await.unwrap();

        assert_eq!(
            kind_at(&root).await,
            Kind::MainWorkingTree,
            "the repo root is the one path `git worktree remove` refuses by design"
        );
        assert_eq!(kind_at(&linked).await, Kind::Linked);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn where_a_worktree_sits_does_not_change_what_it_is() {
        let root = repo("kindnested").await;
        let nested = root.join(".claude/worktrees/ISS-9");
        std::fs::create_dir_all(nested.parent().unwrap()).unwrap();
        run(
            &root,
            &["worktree", "add", &nested.to_string_lossy(), "-b", "ISS-9"],
        )
        .await;

        assert_eq!(
            kind_at(&nested).await,
            Kind::Linked,
            "a worktree nested INSIDE the repository is still a linked worktree — \
             the answer comes from git, not from the shape of the path"
        );
        assert_eq!(
            kind_at(&root).await,
            Kind::MainWorkingTree,
            "and the repository holding it is still the main working tree"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_answer_that_is_not_two_paths_identifies_nothing() {
        let wt = Path::new("/repo");
        assert_eq!(kind_of(wt, ""), Kind::Unknown, "no answer at all");
        assert_eq!(
            kind_of(wt, "/repo/.git\n"),
            Kind::Unknown,
            "one path cannot say whether it is the common dir or this tree's own"
        );
        assert_eq!(
            kind_of(wt, "/repo/.git\n/repo/.git\n"),
            Kind::MainWorkingTree
        );
        assert_eq!(
            kind_of(wt, "/repo/.git/worktrees/a\n/repo/.git\n"),
            Kind::Linked
        );
        assert_eq!(
            kind_of(wt, ".git\n.git\n"),
            Kind::MainWorkingTree,
            "git answers relatively in the main tree, and both sides resolve the same way"
        );
    }

    #[tokio::test]
    async fn a_directory_that_is_no_repository_is_named_as_such_and_an_absent_one_too() {
        let plain = crate::test_scratch::Scratch::new("worktree-kind-plain");

        assert_eq!(kind_at(&plain).await, Kind::NotAWorktree);
        assert_eq!(kind_at(&plain.join("nope")).await, Kind::NotAWorktree);
        let _ = std::fs::remove_dir_all(&plain);
    }

    #[tokio::test]
    async fn a_worktree_git_moved_is_found_at_its_new_path_and_not_called_gone() {
        let root = repo("moved").await;
        let r = root.to_string_lossy().to_string();
        let old = create(&r, "ISS-964", None).await.unwrap();
        let new = root.join(".claude/worktrees/ISS-964");
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        run(
            &root,
            &[
                "worktree",
                "move",
                &old.to_string_lossy(),
                &new.to_string_lossy(),
            ],
        )
        .await;

        assert!(!old.exists(), "the fixture must have moved it");
        assert_eq!(
            residence_of(&root, &old).await,
            Residence::MovedTo(named_as_any_caller_would(
                &root,
                ".claude/worktrees/ISS-964"
            )),
            "`git worktree move` repoints the entry and leaves its name alone, so a path that \
             no longer resolves is a moved checkout and not a removed one — named the way a \
             caller holding a row would name it, not the way git happened to spell it"
        );
        assert_eq!(residence_of(&root, &new).await, Residence::Linked);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Capture what `tracing` was told while `f` ran, the way
    /// `runner/close_loop.rs` does it — a journal line is the deliverable here,
    /// so asserting on the return value would prove nothing about it.
    pub(crate) fn logged_while(f: impl FnOnce()) -> String {
        use std::sync::{Arc, Mutex};
        #[derive(Clone)]
        struct Buf(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf(Arc::new(Mutex::new(Vec::new())));
        let made = buf.clone();
        let sub = tracing_subscriber::fmt()
            .with_writer(move || made.clone())
            .with_ansi(false)
            .finish();
        crate::daemon::keep_tracing_capturable();
        tracing::subscriber::with_default(sub, f);
        let out = buf.0.lock().unwrap().clone();
        String::from_utf8_lossy(&out).into_owned()
    }

    /// ISS-1250 — a keep and a removal left the same evidence.
    ///
    /// Two checkouts went from this box inside one sweep and what took them
    /// was never established: the journal held a line saying each was kept and
    /// no line saying either was removed. The reason travels with the path
    /// because "removed X" alone does not tell a person whether their work
    /// went with it.
    #[test]
    fn a_removal_names_the_path_it_took_and_why() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let root = rt.block_on(repo("logremove"));
        let r = root.to_string_lossy().to_string();
        let wt = rt.block_on(create(&r, "ISS-11", None)).unwrap();

        let said = logged_while(|| {
            rt.block_on(remove_at(
                &r,
                &wt,
                "run run-7 is over and its commits are on origin",
            ))
            .expect("git takes it");
        });
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            said.contains(&wt.display().to_string()),
            "a removal that names no path is indistinguishable from a keep: {said}"
        );
        assert!(
            said.contains("run run-7 is over and its commits are on origin"),
            "and the reason is the caller's, carried through: {said}"
        );
    }

    /// The other half of that conditional: git refuses a LOCKED checkout, and
    /// that directory really is still standing. Without this the branch saying
    /// so is never executed, and a sentence no test reaches is a sentence that
    /// can quietly become wrong again.
    #[test]
    fn a_removal_git_refuses_over_a_lock_says_the_directory_stands() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let root = rt.block_on(repo("logheld"));
        let r = root.to_string_lossy().to_string();
        let held = root.join(".worktrees/ISS-locked");
        rt.block_on(run(
            &root,
            &["worktree", "add", &held.to_string_lossy(), "-b", "ISS-locked"],
        ));
        rt.block_on(run(&root, &["worktree", "lock", &held.to_string_lossy()]));

        let said = logged_while(|| {
            let out = rt.block_on(remove_at(&r, &held, "run run-9 is over"));
            assert!(out.is_err(), "git will not remove a locked checkout");
        });
        let there = held.exists();
        let _ = rt.block_on(run(&root, &["worktree", "unlock", &held.to_string_lossy()]));
        let _ = std::fs::remove_dir_all(&root);

        assert!(there, "the fixture must leave the directory standing");
        assert!(
            said.contains("the directory is still there"),
            "a refusal over a lock leaves the checkout, and the line must say so: {said}"
        );
    }

    #[test]
    fn a_removal_git_will_not_take_is_said_too() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let root = rt.block_on(repo("logrefuse"));
        let r = root.to_string_lossy().to_string();
        let never = root.join(".worktrees/ISS-never-registered");

        let said = logged_while(|| {
            let out = rt.block_on(remove_at(&r, &never, "run run-8 is over"));
            assert!(out.is_err(), "git registers nothing at this path");
        });
        let _ = std::fs::remove_dir_all(&root);

        assert!(
            said.contains(&never.display().to_string()),
            "a directory still standing because git refused is not a directory nobody asked \
             about: {said}"
        );
        assert!(
            said.contains("no directory at that path either"),
            "git refused a path it never registered and nothing is there, so the line may not \
             say one is: {said}"
        );
        assert!(
            !said.contains("the directory is still there"),
            "the standing claim must be measured, not assumed: {said}"
        );
    }

    #[tokio::test]
    async fn only_a_removal_git_took_part_in_reads_as_gone() {
        let root = repo("removed").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "ISS-8", None).await.unwrap();
        assert_eq!(residence_of(&root, &wt).await, Residence::Linked);

        remove_at(&r, &wt, "this test is done with it")
            .await
            .expect("git takes it");
        assert_eq!(
            residence_of(&root, &wt).await,
            Residence::Gone,
            "`git worktree remove` takes the administrative entry with the directory, and the \
             entry's absence is what says the checkout is gone"
        );
        assert_eq!(
            residence_of(&root, &root.join(".worktrees/ISS-never")).await,
            Residence::Gone,
            "and a path git never registered is in the same standing"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_directory_deleted_out_from_under_git_is_still_registered() {
        let root = repo("byhand").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "ISS-9", None).await.unwrap();
        std::fs::remove_dir_all(&wt).expect("the operator's rm -rf");

        assert_eq!(
            residence_of(&root, &wt).await,
            Residence::RegisteredButMissing(named_as_any_caller_would(&root, ".worktrees/ISS-9")),
            "the entry is still standing, so nothing took this checkout back — pruning it is \
             an operator's decision and not a release's"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_repository_that_cannot_be_asked_answers_unknown_and_never_gone() {
        let root = repo("noregistry").await;
        let absent = root.join(".worktrees/ISS-7");
        let not_a_repo = crate::test_scratch::Scratch::new("worktree-notarepo");

        assert!(matches!(
            residence_of(&not_a_repo, &absent).await,
            Residence::Unknown(_)
        ));
        assert!(matches!(
            residence_of(Path::new("/nonexistent-repo"), &absent).await,
            Residence::Unknown(_)
        ));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&not_a_repo);
    }

    #[tokio::test]
    async fn a_directory_that_is_no_checkout_is_said_to_be_one_rather_than_gone() {
        let root = repo("plaindir").await;
        let plain = root.join("docs");
        std::fs::create_dir_all(&plain).unwrap();

        assert_eq!(
            residence_of(&root, &root).await,
            Residence::MainWorkingTree,
            "the repository's own checkout is nobody's to give back"
        );

        let outside = crate::test_scratch::Scratch::new("worktree-outside");
        assert_eq!(
            residence_of(&root, &outside).await,
            Residence::NotAWorktree,
            "something is at the path and git says it is no checkout — which is an answer, \
             and a different one from the absence the registry is asked about"
        );
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::remove_dir_all(&outside);
    }
    #[tokio::test]
    async fn two_checkouts_sharing_a_basename_leave_neither_of_them_identified() {
        let root = repo("dedup").await;
        let a = root.join("one/ISS-964");
        let b = root.join("two/ISS-964");
        for p in [&a, &b] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        }
        run(
            &root,
            &["worktree", "add", &a.to_string_lossy(), "-b", "ISS-964-a"],
        )
        .await;
        run(
            &root,
            &["worktree", "add", &b.to_string_lossy(), "-b", "ISS-964-b"],
        )
        .await;
        // Git filed the second under the first's basename plus a digit, so the
        // basename now names two entries and identifies neither.
        let filed: Vec<String> = std::fs::read_dir(root.join(".git/worktrees"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert!(
            filed.iter().any(|n| n == "ISS-964") && filed.iter().any(|n| n == "ISS-9641"),
            "the fixture rests on git's own deduplication: {filed:?}"
        );

        let elsewhere = root.join("three/ISS-964");
        std::fs::create_dir_all(elsewhere.parent().unwrap()).unwrap();
        run(
            &root,
            &[
                "worktree",
                "move",
                &b.to_string_lossy(),
                &elsewhere.to_string_lossy(),
            ],
        )
        .await;

        match residence_of(&root, &b).await {
            Residence::Ambiguous(candidates) => assert_eq!(
                candidates.len(),
                2,
                "both entries could be this path's, and saying which would be a guess"
            ),
            other => panic!(
                "a name two checkouts share may not read as proof either of them was removed: \
                 {other:?}"
            ),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_registry_this_box_may_not_read_is_unknown_rather_than_empty() {
        let root = repo("unreadable").await;
        let r = root.to_string_lossy().to_string();
        let wt = create(&r, "ISS-5", None).await.unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        let admin = root.join(".git/worktrees");

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o000)).unwrap();
            let said = residence_of(&root, &wt).await;
            std::fs::set_permissions(&admin, std::fs::Permissions::from_mode(0o755)).unwrap();
            assert!(
                matches!(said, Residence::Unknown(_)),
                "a directory this box could not open registers nothing it can SEE, which is not \
                 the same as registering nothing: {said:?}"
            );
        }
        assert_eq!(
            residence_of(&root, &wt).await,
            Residence::RegisteredButMissing(named_as_any_caller_would(&root, ".worktrees/ISS-5")),
            "and once it can be read, the entry standing there is the answer"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_moved_checkout_whose_new_path_is_gone_is_still_a_registration() {
        let root = repo("movedgone").await;
        let r = root.to_string_lossy().to_string();
        let old = create(&r, "ISS-6", None).await.unwrap();
        let new = root.join(".claude/worktrees/ISS-6");
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        run(
            &root,
            &[
                "worktree",
                "move",
                &old.to_string_lossy(),
                &new.to_string_lossy(),
            ],
        )
        .await;
        std::fs::remove_dir_all(&new).expect("and then the destination goes, unpruned");

        assert_eq!(
            residence_of(&root, &old).await,
            Residence::RegisteredButMissing(named_as_any_caller_would(
                &root,
                ".claude/worktrees/ISS-6"
            )),
            "the entry outlived both paths, so nothing took this checkout back — a destination \
             that is not there is not a reason to call the run released"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
    #[test]
    fn two_spellings_of_one_path_resolve_together_even_where_the_leaf_is_gone() {
        let base = crate::test_scratch::Scratch::new("worktree-spelling");
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();

        // The shape macOS puts every temp path through: a directory reached by
        // two names, one of them a link. Built by hand so the mechanism is
        // under test on whatever platform is running it, rather than only on
        // the one that ships it.
        let link = base.join("by-another-name");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(not(unix))]
        std::os::windows::fs::symlink_dir(&real, &link).unwrap();

        assert_eq!(
            resolved_for_compare(&link),
            resolved_for_compare(&real),
            "one directory reached by two names is one directory"
        );
        assert_eq!(
            resolved_for_compare(&link.join(".worktrees/ISS-3")),
            resolved_for_compare(&real.join(".worktrees/ISS-3")),
            "and it stays one directory under a leaf that is not there — which is the ONLY \
             kind of path this is ever asked about, and the kind `canonicalize` alone cannot \
             answer for"
        );
        assert_eq!(
            resolved_for_compare(&real.join("a/b/c")),
            real.canonicalize().unwrap().join("a").join("b").join("c"),
            "the tail below the last existing ancestor is re-attached whole, not dropped"
        );

        // The fallback's condition is that NO ancestor canonicalises, which is
        // not the same as the path being relative — the pair below is here so
        // the two cannot be confused again. Asserting it over
        // `/no-such-root/x` passed on Linux for the wrong reason (`/` exists,
        // and re-attaching the tail under it reproduces the input) and went red
        // on Windows for the right one, where `/x` is the CURRENT DRIVE's `x`.
        let nothing_under = Path::new("forge-no-such-dir-1193/x/y");
        assert_eq!(
            resolved_for_compare(nothing_under),
            nothing_under.to_path_buf(),
            "a path with no ancestor to settle it against comes back as it came, rather than \
             being reported as something it was not"
        );

        // The same shape of name, under something that IS there: relative was
        // never the criterion.
        let settled = real.join("no-such-leaf/x");
        assert_eq!(
            resolved_for_compare(&settled),
            real.canonicalize().unwrap().join("no-such-leaf").join("x"),
            "an ancestor that resolves settles the spelling whatever the path's shape, so the \
             case above is the condition and not the category"
        );

        // Whatever it returns, it returns again: a spelling that two callers
        // are supposed to meet at is worth nothing if it moves when it is read
        // twice. This holds on every platform and over every branch above,
        // including the one no assertion here can reach on its own.
        for p in [
            &real,
            &link,
            &real.join(".worktrees/ISS-3"),
            &link.join("a/b/c"),
            nothing_under,
            &settled,
        ] {
            let once = resolved_for_compare(p);
            assert_eq!(
                resolved_for_compare(&once),
                once,
                "resolving {} twice must not move it",
                p.display()
            );
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn a_repository_reached_by_a_link_still_identifies_its_own_checkout() {
        // macOS puts every temp path behind a `/var` -> `/private/var` link and
        // Windows hands back a long name where the caller holds an 8.3 one, so
        // on those boxes git's spelling of a path and the ledger's are two
        // different strings for one checkout. Neither happens under /tmp on
        // Linux, so the shape is built by hand here rather than left to the
        // platform that ships it (ISS-1193).
        let base = crate::test_scratch::Scratch::new("worktree-linkedroot");
        let real = base.join("real");
        std::fs::create_dir_all(&real).unwrap();
        for args in [
            &["init", "-b", "main"][..],
            &["config", "user.email", "t@t"][..],
            &["config", "user.name", "t"][..],
        ] {
            run(&real, args).await;
        }
        std::fs::write(real.join("f.txt"), "one\n").unwrap();
        run(&real, &["add", "f.txt"]).await;
        run(&real, &["commit", "-m", "init"]).await;

        let link = base.join("by-another-name");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, &link).unwrap();
        #[cfg(not(unix))]
        std::os::windows::fs::symlink_dir(&real, &link).unwrap();

        // Two checkouts sharing a basename, so git files the second under the
        // first's name plus a digit and the BASENAME can no longer settle
        // which is which. Only the exact-path reading can, and it is the one
        // that needs both spellings to meet.
        let ours = link.join("one/ISS-964");
        let other = link.join("two/ISS-964");
        for p in [&ours, &other] {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        }
        run(
            &link,
            &["worktree", "add", &ours.to_string_lossy(), "-b", "ours"],
        )
        .await;
        run(
            &link,
            &["worktree", "add", &other.to_string_lossy(), "-b", "other"],
        )
        .await;
        std::fs::remove_dir_all(&ours).expect("the operator's rm -rf");

        assert_eq!(
            residence_of(&link, &ours).await,
            Residence::RegisteredButMissing(named_as_any_caller_would(&real, "one/ISS-964")),
            "the run's path and git's answer are two spellings of one checkout, and the exact \
             reading has to see through that — falling back to the basename here would name \
             the OTHER checkout, or both of them"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
