//! Single-writer access to a repo ROOT, keyed by path.
//!
//! Worktrees isolate the agent SESSIONS from each other, and nothing here
//! changes that. What they do not isolate is the root: `workspace::refresh`
//! runs `fetch`, `checkout --` and `merge --ff-only` against it on EVERY job,
//! worktree lane included, and `worktree::create` mutates the root's `.git`.
//! Two jobs starting at once on one box therefore write the same index.
//!
//! Until now nothing here needed a lock because core pinned one job per runner.
//! This is what has to exist before that pin can be lifted.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

/// One `tokio` mutex per repo root, created on first use and then kept.
///
/// The entry is never evicted. A daemon serves a bounded set of bindings, an
/// empty mutex is two words, and reclaiming one would need a second lock to
/// decide it is unused — the leak that is not worth its own race.
#[derive(Clone, Default)]
pub struct RepoLocks {
    inner: Arc<Mutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>>,
}

/// Held for as long as the holder may still write to the root.
pub type RepoGuard = OwnedMutexGuard<()>;

impl RepoLocks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Is this root currently held? Used only to decide whether a caller is
    /// about to WAIT, so it can say so before it blocks.
    ///
    /// Racy by construction: the answer can be stale the moment it returns.
    /// That is acceptable for a log line and is NOT acceptable as a gate — take
    /// the guard to gate.
    pub fn is_busy(&self, repo: &Path) -> bool {
        let map = self.inner.lock().expect("repo lock registry poisoned");
        map.get(repo).is_some_and(|m| m.try_lock().is_err())
    }

    /// Wait for exclusive access to `repo`.
    // cm:guard the registry mutex is a std one and MUST be released before the await — holding a blocking lock across an await point stalls the whole runtime and would deadlock the second job on this same root. Clone the Arc out, then drop the map guard, then await.
    pub async fn acquire(&self, repo: &Path) -> RepoGuard {
        let slot = {
            let mut map = self.inner.lock().expect("repo lock registry poisoned");
            map.entry(repo.to_path_buf())
                .or_insert_with(|| Arc::new(AsyncMutex::new(())))
                .clone()
        };
        slot.lock_owned().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn two_jobs_on_one_root_never_overlap() {
        let locks = RepoLocks::new();
        let root = PathBuf::from("/repo/a");
        let inside = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));

        let mut tasks = Vec::new();
        for _ in 0..8 {
            let (locks, root) = (locks.clone(), root.clone());
            let (inside, peak) = (inside.clone(), peak.clone());
            tasks.push(tokio::spawn(async move {
                let _g = locks.acquire(&root).await;
                let n = inside.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(5)).await;
                inside.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for t in tasks {
            t.await.unwrap();
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "two holders entered at once");
    }

    // cm:guard the point of keying on the PATH is that unrelated repos stay parallel. A registry that returned one shared mutex would pass the test above and silently serialise the whole box, which is the cap=1 behaviour this exists to remove.
    #[tokio::test]
    async fn two_roots_do_not_block_each_other() {
        let locks = RepoLocks::new();
        let held = locks.acquire(Path::new("/repo/a")).await;

        let other = tokio::time::timeout(
            Duration::from_millis(250),
            locks.acquire(Path::new("/repo/b")),
        )
        .await;

        assert!(other.is_ok(), "a second root had to wait on the first");
        drop(held);
    }

    #[tokio::test]
    async fn a_released_root_is_takeable_again() {
        let locks = RepoLocks::new();
        let root = PathBuf::from("/repo/a");
        let first = locks.acquire(&root).await;
        assert!(locks.is_busy(&root));
        drop(first);

        let second = tokio::time::timeout(Duration::from_millis(250), locks.acquire(&root)).await;
        assert!(second.is_ok(), "the lock was not released with its guard");
    }

    #[tokio::test]
    async fn is_busy_is_false_for_a_root_nobody_has_touched() {
        let locks = RepoLocks::new();
        assert!(!locks.is_busy(Path::new("/repo/never-seen")));
    }
}
