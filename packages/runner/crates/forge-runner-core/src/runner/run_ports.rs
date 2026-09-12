/*
 * The production halves of `run_session`'s two ports.
 *
 * `run_session::start` takes a `Spawner` and a `CoreSessions` so its ORDER can
 * be tested against a spawn that fails and a core that is not there. These are
 * the implementations the daemon passes, and they hold no policy: one opens a
 * pane, one posts a group of issues to core.
 */

use std::path::Path;

use crate::daemon::{session_tokens, terminal};
use crate::error::{Error, Result};
use crate::runner::run_session::{CoreSessions, Spawner};
use crate::transport::{run_sessions, CoreClient};

/// A run's pane, opened through the same primitive a master's pane uses.
pub struct TmuxSpawner {
    pub env: Vec<(String, String)>,
}

#[async_trait::async_trait]
impl Spawner for TmuxSpawner {
    async fn spawn(
        &self,
        session_name: &str,
        cwd: &Path,
        argv: &[String],
        session_id: &str,
    ) -> Result<u32> {
        // cm:guard the capability is minted HERE, on the daemon's side of the port, and never by the run — `run_session` is handed an id and mints nothing, which is what keeps a run authenticating as itself rather than as the box (ISS-933 criterion 5).
        // cm:guard a mint that fails REFUSES the spawn rather than opening an unhooked pane, matching the master path: a pane that cannot report its turn boundaries is one nothing can ever decide is finished, and it is held for the life of the box.
        let mut env = self.env.clone();
        let store = session_tokens::default_path()
            .map(session_tokens::SessionTokens::at)
            .ok_or_else(|| {
                Error::Other(
                    "run_session: cannot resolve the control token map, so this pane could not report a turn boundary".into(),
                )
            })?;
        let token = store.mint(session_id).map_err(|e| {
            Error::Other(format!(
                "run_session: cannot mint a control capability for {session_name}: {e}"
            ))
        })?;
        env.push((session_tokens::TOKEN_ENV.to_string(), token));
        // cm:guard `ensure` ADOPTS a session that already exists and reports which it did; discarding that bool is what let a run read another project's pane pid back as its own. `start` refuses a taken name before it writes anything, so this is the belt behind that brace and should be unreachable — it is here because this is the only place that knows for certain (forge-vm 2026-09-09: sidpeak and pixelight both carrying an ISS-368).
        if !terminal::ensure(session_name, cwd, argv, &env, None).await? {
            return Err(Error::Other(format!(
                "run_session: {session_name} already existed and was adopted rather than created — refusing to report another run's pid as this run's"
            )));
        }
        // cm:guard the pid is READ BACK from tmux and a missing one is an error, never a zero or a guess. The ledger's whole value is that a recorded run with no pid is a KNOWN unstarted run; a fabricated pid makes an unstarted run indistinguishable from a dead one, and recovery then closes the loop over a process that may still be writing.
        terminal::pane_pid(session_name)
            .await
            .ok_or_else(|| Error::Other(format!("run_session: {session_name} has no pane pid")))
    }

    async fn name_taken(&self, session_name: &str) -> bool {
        terminal::alive(session_name).await
    }
}

/// Core's record of a run session, opened over the box's own credential.
pub struct CoreRunSessions<'a> {
    pub client: &'a CoreClient,
    pub project_id: String,
}

#[async_trait::async_trait]
impl CoreSessions for CoreRunSessions<'_> {
    async fn open(
        &self,
        run_id: &str,
        issue_keys: &[String],
        name: &str,
    ) -> Result<(String, String)> {
        run_sessions::open(self.client, &self.project_id, run_id, issue_keys, name).await
    }
}

#[cfg(test)]
mod tests {
    const SOURCE: &str = include_str!("run_ports.rs");

    /// The body of `TmuxSpawner::spawn`, which is what the rules below are about.
    // cm:guard asserted on the SOURCE because the failure is a pane's ENVIRONMENT, which exists only after a real tmux server has forked a real agent: a behavioural test would need both, and the bug it is guarding against — passing `&self.env` instead of the extended one — compiles, runs, spawns the pane and loses the capability with nothing anywhere reporting it.
    fn spawn_body() -> &'static str {
        SOURCE
            .split("    ) -> Result<u32> {")
            .nth(1)
            .expect("the spawn body")
            .split("\n    }")
            .next()
            .expect("its closing brace")
    }

    #[test]
    fn the_pane_is_opened_with_the_capability_and_not_the_bare_env() {
        let body = spawn_body();
        assert!(
            body.contains("terminal::ensure(session_name, cwd, argv, &env,"),
            "the pane must be opened with the EXTENDED env — `&self.env` drops the capability, and a pane cannot be told one afterwards, so its hooks report nothing for its whole life and nothing on the box can ever decide it is finished; body was: {body}"
        );
        assert!(
            !body.contains("&self.env,"),
            "`&self.env` reaching `ensure` is the whole defect this test exists for"
        );
    }

    // cm:guard the ORDER is the assertion: a mint after the spawn is a capability the pane has already started without.
    #[test]
    fn the_capability_is_minted_before_the_pane_is_opened() {
        let body = spawn_body();
        let minted = body.find("TOKEN_ENV").expect("the capability is pushed");
        let opened = body.find("terminal::ensure").expect("the pane is opened");
        assert!(
            minted < opened,
            "the capability must be in the environment BEFORE the pane exists"
        );
    }
}
