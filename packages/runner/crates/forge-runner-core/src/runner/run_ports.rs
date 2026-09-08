/*
 * The production halves of `run_session`'s two ports.
 *
 * `run_session::start` takes a `Spawner` and a `CoreSessions` so its ORDER can
 * be tested against a spawn that fails and a core that is not there. These are
 * the implementations the daemon passes, and they hold no policy: one opens a
 * pane, one posts a group of issues to core.
 */

use std::path::Path;

use crate::daemon::terminal;
use crate::error::{Error, Result};
use crate::runner::run_session::{CoreSessions, Spawner};
use crate::transport::{run_sessions, CoreClient};

/// A run's pane, opened through the same primitive a master's pane uses.
pub struct TmuxSpawner {
    pub env: Vec<(String, String)>,
}

#[async_trait::async_trait]
impl Spawner for TmuxSpawner {
    async fn spawn(&self, session_name: &str, cwd: &Path, argv: &[String]) -> Result<u32> {
        terminal::ensure(session_name, cwd, argv, &self.env, None).await?;
        // cm:guard the pid is READ BACK from tmux and a missing one is an error, never a zero or a guess. The ledger's whole value is that a recorded run with no pid is a KNOWN unstarted run; a fabricated pid makes an unstarted run indistinguishable from a dead one, and recovery then closes the loop over a process that may still be writing.
        terminal::pane_pid(session_name)
            .await
            .ok_or_else(|| Error::Other(format!("run_session: {session_name} has no pane pid")))
    }
}

/// Core's record of a run session, opened over the box's own credential.
pub struct CoreRunSessions<'a> {
    pub client: &'a CoreClient,
    pub project_id: String,
}

#[async_trait::async_trait]
impl CoreSessions for CoreRunSessions<'_> {
    async fn open(&self, run_id: &str, issue_keys: &[String], name: &str) -> Result<String> {
        run_sessions::open(self.client, &self.project_id, run_id, issue_keys, name).await
    }
}
