/*
 * The production halves of `reconcile`'s five ports.
 *
 * Each one answers by reading something back — a tmux pane, a core row, a
 * membership list. None of them answers from the response to the write that
 * changed the thing, which is the whole of criterion 13 and the reason the
 * traits exist rather than the calls sitting inline.
 */

use crate::daemon::master::Masters;
use crate::daemon::recovery::{Heartbeat, MasterLiveness, MasterPresence, ProcessLiveness};
use crate::daemon::terminal;
use crate::error::Result;
use crate::runner::close_loop::{LeaseKeeper, Outcome, RunCloser, SessionReader};
use crate::transport::{run_sessions, CoreClient};

pub struct PaneMasters<'a> {
    pub masters: &'a Masters,
}

#[async_trait::async_trait]
impl MasterLiveness for PaneMasters<'_> {
    async fn state(&self, master_session_id: &str) -> MasterPresence {
        match self.masters.pane_for_session(master_session_id) {
            Some(name) => pane_presence(&name).await,
            None => MasterPresence::Unknown,
        }
    }

    async fn live_master_for_project(&self, project_id: &str) -> Option<String> {
        let (session_id, name) = self.masters.live_for_project(project_id)?;
        terminal::pane_pid(&name).await.map(|_| session_id)
    }
}

/// What tmux says of the pane named `name`: the one reading both recovery and
/// the master sweep take, so neither ends a master the other still holds.
pub async fn pane_presence(name: &str) -> MasterPresence {
    match terminal::pane_pid(name).await {
        Some(_) => MasterPresence::Alive,
        None => absent_or_unanswered(name).await,
    }
}

/// What a pane `pane_pid` read nothing for is.
///
/// `pane_pid` answers `None` alike for a pane tmux does not have and for a tmux
/// that could not be asked, and recovery writes `Gone` on the run's row as the
/// end of its subagent. So absence is taken only from a session list tmux did
/// give that lacks the name. An empty list is no answer, the same way
/// `terminal::has_session` reads a server nobody reached (ISS-1265, ISS-1312).
async fn absent_or_unanswered(name: &str) -> MasterPresence {
    let listed = terminal::names_with_prefix("").await;
    if listed.is_empty() {
        MasterPresence::Unanswered
    } else if listed.iter().any(|n| n == name) {
        MasterPresence::Alive
    } else {
        MasterPresence::Gone
    }
}

pub struct SignalProbe;

#[async_trait::async_trait]
impl ProcessLiveness for SignalProbe {
    #[cfg(unix)]
    async fn is_gone(&self, pid: u32) -> bool {
        use nix::errno::Errno;
        use nix::sys::signal::kill;
        use nix::unistd::Pid;

        let Ok(raw) = i32::try_from(pid) else {
            return false;
        };
        matches!(kill(Pid::from_raw(raw), None), Err(Errno::ESRCH))
    }

    #[cfg(not(unix))]
    async fn is_gone(&self, _pid: u32) -> bool {
        false
    }

    async fn host(&self, pid: u32, start: &str) -> crate::daemon::subagent_host::HostRead {
        use crate::daemon::subagent_host::{Hosts, ProcHosts};
        ProcHosts::system().read(pid, start)
    }
}

pub struct CoreRunState<'a> {
    pub client: &'a CoreClient,
}

#[async_trait::async_trait]
impl SessionReader for CoreRunState<'_> {
    async fn is_terminal(&self, agent_session_id: &str) -> Result<bool> {
        run_sessions::is_terminal(self.client, agent_session_id).await
    }
}

#[async_trait::async_trait]
impl RunCloser for CoreRunState<'_> {
    async fn close(
        &self,
        agent_session_id: &str,
        outcome: Outcome,
        detail: &str,
        checkpoint: Option<serde_json::Value>,
    ) -> Result<()> {
        run_sessions::close(
            self.client,
            agent_session_id,
            outcome,
            Some(detail),
            checkpoint,
        )
        .await
    }
}

#[async_trait::async_trait]
impl LeaseKeeper for CoreRunState<'_> {
    async fn release(&self, project_id: Option<&str>, issue_key: &str) -> Result<()> {
        run_sessions::release_lease(self.client, project_id, issue_key).await
    }

    async fn is_returned(&self, project_id: Option<&str>, issue_key: &str) -> Result<bool> {
        // THIS box's half, not the fleet's: the close loop is asking whether it
        // gave the lease back, and an issue another box legitimately holds must
        // not stop this one from ever marking its own run closed (ISS-1109).
        Ok(
            !run_sessions::lease_state(self.client, project_id, issue_key)
                .await?
                .held_by_this_device,
        )
    }

    async fn issue_is_over(
        &self,
        project_id: Option<&str>,
        issue_key: &str,
    ) -> Result<Option<bool>> {
        // The same call `is_returned` makes, which is why the question lives on
        // this trait: the issue's own status rides back on the lease read
        // rather than costing a route of its own (ISS-1245).
        Ok(
            run_sessions::lease_state(self.client, project_id, issue_key)
                .await?
                .issue_over,
        )
    }
}

/// Telling core this box still holds a run.
pub struct CoreBeat<'a> {
    pub client: &'a CoreClient,
}

#[async_trait::async_trait]
impl Heartbeat for CoreBeat<'_> {
    async fn beat(&self, session_id: &str) -> Result<()> {
        run_sessions::beat(self.client, session_id).await
    }
}
