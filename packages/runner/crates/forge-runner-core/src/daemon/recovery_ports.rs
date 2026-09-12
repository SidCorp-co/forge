/*
 * The production halves of `reconcile`'s five ports.
 *
 * Each one answers by reading something back — a tmux pane, a core row, a
 * membership list. None of them answers from the response to the write that
 * changed the thing, which is the whole of criterion 13 and the reason the
 * traits exist rather than the calls sitting inline.
 */

use crate::daemon::master::Masters;
use crate::daemon::recovery::{Heartbeat, MasterLiveness, ProcessLiveness};
use crate::daemon::terminal;
use crate::error::Result;
use crate::runner::close_loop::{LeaseKeeper, Outcome, RunCloser, SessionReader};
use crate::transport::{run_sessions, CoreClient};

/// Whether a master's pane is still on this box.
// cm:guard the registry is consulted for the NAME and tmux for the answer. An in-process map cannot be the liveness authority — a daemon restart empties it while every master is still running (the ISS-919 B1 hole), so a reconcile that trusted it would close the loop over every live run on the box after any restart. The sweep re-registers masters before it reaches the reconcile, which is what makes the name lookup a cache miss rather than a wrong answer.
pub struct PaneMasters<'a> {
    pub masters: &'a Masters,
}

#[async_trait::async_trait]
impl MasterLiveness for PaneMasters<'_> {
    async fn is_alive(&self, master_session_id: &str) -> bool {
        match self.masters.pane_for_session(master_session_id) {
            Some(name) => terminal::pane_pid(&name).await.is_some(),
            None => false,
        }
    }

    // cm:guard the registry names the candidate and TMUX decides, exactly as `is_alive` above does and for the same reason: re-parenting a park onto a master that is registered but no longer running would move the run from a parent that is gone to another one that is, and the next sweep would have to move it again.
    async fn live_master_for_project(&self, project_id: &str) -> Option<String> {
        let (session_id, name) = self.masters.live_for_project(project_id)?;
        terminal::pane_pid(&name).await.map(|_| session_id)
    }
}

/// Whether a recorded pid is gone, asked of the kernel with signal 0.
// cm:guard ONLY `ESRCH` refutes a pid. Every other errno — `EPERM` above all, which says the process is there and owned by somebody else — answers false, because `reconcile` turns a true into a closed loop: worktree released, leases returned, a live agent's tree taken out from under it (ISS-964 criterion 35).
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

    // cm:guard a box that cannot ask refutes NOTHING, which leaves `reconcile` exactly as it was before this port existed: the master test alone. Answering true here would close the loop over every run on a Windows box on the first sweep.
    #[cfg(not(unix))]
    async fn is_gone(&self, _pid: u32) -> bool {
        false
    }
}

/// Core's own answers: is a session terminal, and is an issue still held.
// cm:guard one struct serves BOTH traits because both answers come from the same place and neither takes a run id — the session id and the issue key are the identifiers the close loop already carries, so nothing here has to hold a second identity for a fact core owns.
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
    async fn close(&self, agent_session_id: &str, outcome: Outcome, detail: &str) -> Result<()> {
        run_sessions::close(self.client, agent_session_id, outcome, Some(detail)).await
    }
}

#[async_trait::async_trait]
impl LeaseKeeper for CoreRunState<'_> {
    async fn release(&self, issue_key: &str) -> Result<()> {
        run_sessions::release_lease(self.client, issue_key).await
    }

    // cm:guard asks core AGAIN rather than reading what `release` answered. A dropped response over a return that landed still ends with the mark set, and a cheerful 200 over one that did not does not — the only difference between this and a master's report (ISS-933 criterion 13).
    async fn is_returned(&self, issue_key: &str) -> Result<bool> {
        Ok(!run_sessions::lease_held(self.client, issue_key).await?)
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
