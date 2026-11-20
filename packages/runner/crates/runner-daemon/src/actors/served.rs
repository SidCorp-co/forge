//! The update loop told when core serves another runner build (ISS-1358): the
//! heartbeat names the build `install/latest.json` serves on every beat, and the
//! loop checks again the moment that differs from the build it last read, rather
//! than waiting out its six-hour timer. The check itself, its probation and its
//! rollback are the timer's, unchanged.

use runner_transport::heartbeat::ServedRelease;
use tokio::sync::watch;

/// What the heartbeat last heard core serve, for the update loop to read.
pub(crate) type Served = watch::Receiver<Option<ServedRelease>>;

/// Whether `served` is a build the update loop has not read yet: a beat naming
/// a build other than the one the last check read. A beat naming none — a core
/// that serves no build, or one older than this — moves nothing.
pub(crate) fn moved(checked: Option<&ServedRelease>, served: Option<&ServedRelease>) -> bool {
    served.is_some_and(|s| checked != Some(s))
}

/// The next build the heartbeat names. Once the heartbeat is gone this never
/// answers, and the timer alone drives the loop.
pub(crate) async fn next(rx: &mut Served) -> Option<ServedRelease> {
    match rx.changed().await {
        Ok(()) => rx.borrow_and_update().clone(),
        Err(_) => std::future::pending().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(version: &str, commit: Option<&str>) -> ServedRelease {
        ServedRelease {
            version: version.into(),
            commit: commit.map(Into::into),
        }
    }

    #[test]
    fn a_build_other_than_the_one_last_read_moves_the_loop_and_nothing_else_does() {
        let dev9 = build("0.18.0-dev.9", Some("ee"));
        let dev10 = build("0.18.0-dev.10", Some("dd"));
        assert!(moved(None, Some(&dev9)), "nothing read yet");
        assert!(moved(Some(&dev9), Some(&dev10)), "a new dev build");
        assert!(
            moved(Some(&dev9), Some(&build("0.18.0-dev.9", Some("ff")))),
            "the same number rebuilt from another commit"
        );
        assert!(!moved(Some(&dev9), Some(&dev9)), "the build already read");
        assert!(!moved(Some(&dev9), None), "a core naming no build");
    }

    #[tokio::test]
    async fn each_build_the_heartbeat_names_reaches_the_loop_and_a_gone_heartbeat_falls_silent() {
        let (tx, mut rx) = watch::channel(None);
        tx.send_replace(Some(build("0.18.0-dev.10", None)));
        assert_eq!(next(&mut rx).await, Some(build("0.18.0-dev.10", None)));
        drop(tx);
        let silent = tokio::time::timeout(std::time::Duration::from_millis(50), next(&mut rx));
        assert!(
            silent.await.is_err(),
            "a gone heartbeat must not spin the loop"
        );
    }
}
