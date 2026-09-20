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
            Some(name) => match terminal::pane_pid(&name).await {
                Some(_) => MasterPresence::Alive,
                None => MasterPresence::Gone,
            },
            None => MasterPresence::Unknown,
        }
    }

    async fn live_master_for_project(&self, project_id: &str) -> Option<String> {
        let (session_id, name) = self.masters.live_for_project(project_id)?;
        terminal::pane_pid(&name).await.map(|_| session_id)
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
    async fn release(&self, issue_key: &str) -> Result<()> {
        run_sessions::release_lease(self.client, issue_key).await
    }

    async fn is_returned(&self, issue_key: &str) -> Result<bool> {
        // THIS box's half, not the fleet's: the close loop is asking whether it
        // gave the lease back, and an issue another box legitimately holds must
        // not stop this one from ever marking its own run closed (ISS-1109).
        Ok(!run_sessions::lease_state(self.client, issue_key)
            .await?
            .held_by_this_device)
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::master::Masters as Registry;

    #[tokio::test]
    async fn a_session_this_registry_has_no_entry_for_is_unknown_and_never_gone() {
        let registry = Registry::new();
        let port = PaneMasters { masters: &registry };

        assert_eq!(
            port.state("a-session-this-box-never-registered").await,
            MasterPresence::Unknown,
            "an empty registry is this box having no record, not a pane that ended — a daemon restart empties it while every master is still running"
        );
    }

    #[tokio::test]
    async fn a_registered_pane_tmux_does_not_have_is_gone_rather_than_unknown() {
        let registry = Registry::new();
        registry.remember_for_test("proj-1", "sess-1", "forge-no-such-pane-iss1050");
        let port = PaneMasters { masters: &registry };

        assert_eq!(
            port.state("sess-1").await,
            MasterPresence::Gone,
            "the registry named a pane and tmux has no such pane; that is an observation, and softening it would leave every dead master unrecoverable"
        );
    }
}
