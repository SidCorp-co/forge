//! Reading back what a call said, for the tests that are about the saying.
//!
//! Some of this crate's behaviour IS a line in the journal: a removal taken on
//! a box that could not read its own process table is indistinguishable from
//! one taken after a clear reading unless it says so (ISS-1271), and an outage
//! reported at the wrong level is the whole of ISS-1201. A test about those
//! needs a subscriber it can read, and the subscriber has to be installed
//! around the call rather than for the process, because `cargo test` runs the
//! cases of one file in one process and a global writer would mix them.
//!
//! It lives here rather than beside its first caller because the same function
//! already existed eight times in this crate — in `workspace::worktree`,
//! `runner::close_loop`, `daemon::headroom`, `daemon::pool_jobs`,
//! `daemon::session_tokens`, `daemon::recovery`, `daemon::mod` and twice in
//! `daemon::master` — several of them saying in a comment that the shared one
//! was out of reach from where it was needed, and one counting itself as the
//! third when it was the sixth. A ninth copy would commit the same defect a
//! ninth time. `workspace::worktree`'s is folded in here; the rest are not,
//! because they are outside the file scope this change declared, and the
//! residual is written down in
//! `docs/proposals/ownership-of-a-process-living-in-a-worktree.md`.

use std::sync::{Arc, Mutex};

/// What was said, readable while the capture is still open.
#[derive(Clone)]
pub(crate) struct Captured(Arc<Mutex<Vec<u8>>>);

impl Captured {
    pub(crate) fn said(&self) -> String {
        String::from_utf8_lossy(&self.0.lock().unwrap().clone()).into_owned()
    }
}

impl std::io::Write for Captured {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Capture this thread's log until the guard drops.
///
/// The guard form is what an `async` test needs: the subscriber is a
/// thread-local default, so it covers the awaits inside the scope, where a
/// closure taken by value would have to drive a second runtime inside the
/// first and `block_on` refuses that by name.
pub(crate) fn capturing() -> (Captured, tracing::subscriber::DefaultGuard) {
    let buf = Captured(Arc::new(Mutex::new(Vec::new())));
    let made = buf.clone();
    let sub = tracing_subscriber::fmt()
        .with_writer(move || made.clone())
        .with_ansi(false)
        .finish();
    // A `tracing` build that never had a subscriber set optimises the level
    // away, and every assertion under it would then read an empty capture as
    // "the line is not said" rather than as "nothing was recording".
    crate::daemon::keep_tracing_capturable();
    (buf, tracing::subscriber::set_default(sub))
}

/// Everything `f` logs, as the default subscriber renders it.
pub(crate) fn logged_while(f: impl FnOnce()) -> String {
    let (said, guard) = capturing();
    f();
    drop(guard);
    said.said()
}
