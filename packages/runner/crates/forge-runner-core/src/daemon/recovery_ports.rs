/*
 * The production halves of `reconcile`'s four ports.
 *
 * Each one answers by reading something back — a tmux pane, a core row, a
 * membership list. None of them answers from the response to the write that
 * changed the thing, which is the whole of criterion 13 and the reason the
 * traits exist rather than the calls sitting inline.
 */

use crate::daemon::master::Masters;
use crate::daemon::recovery::{Heartbeat, MasterLiveness};
use crate::daemon::terminal;
use crate::error::Result;
use crate::runner::close_loop::{LeaseKeeper, SessionReader};
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
