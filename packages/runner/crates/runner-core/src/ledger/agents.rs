use super::*;

/// Which subagent holds which run: binding, its session, and the reads keyed by agent or master.
impl Ledger {
    /// A `SubagentStart` of this run's subagent at `at_ms`: it is running in a
    /// live process again, so an earlier end of its host no longer speaks for
    /// it. Where the lead's hook named where the subagent writes, that is kept
    /// too, so what it writes before its first stop can be heard.
    pub fn note_subagent_started(
        &self,
        run_id: &str,
        at_ms: i64,
        transcript: Option<&str>,
    ) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET agent_transcript = COALESCE(?3, agent_transcript),
                        host_ended_by = CASE WHEN host_ended_at_ms <= ?2 THEN NULL
                                             ELSE host_ended_by END,
                        host_ended_at_ms = CASE WHEN host_ended_at_ms <= ?2 THEN NULL
                                                ELSE host_ended_at_ms END
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, at_ms, transcript],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn reparent_run(&mut self, run_id: &str, master_session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET master_session_id = ?2 WHERE run_id = ?1",
                params![run_id, master_session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_for_master(&self, master_session_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    pub fn attach_session(&self, run_id: &str, session_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET session_id = ?2 WHERE run_id = ?1",
                params![run_id, session_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Bind open run `run_id` to subagent `agent_id`, which has answered to
    /// no run before, open or ended. A subagent that already answered to one
    /// and starts again is its master waking it (`SendMessage`), which makes
    /// no Agent call and so passes no dispatch gate: the run a master declared
    /// is for the Agent call the gate lets through, never for a resume
    /// (ISS-1366, superseding ISS-1378's resume binding).
    pub fn bind_agent(&self, run_id: &str, agent_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET agent_id = ?2
                  WHERE run_id = ?1 AND agent_id IS NULL AND ended_by IS NULL
                    AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.agent_id = ?2)",
                params![run_id, agent_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// The run subagent `agent_id` answered to last, open or ended: where it
    /// has one, a start of it is a resume.
    pub fn last_run_of_agent(&self, agent_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!(
                    "{SELECT_RUN} WHERE agent_id = ?1 ORDER BY ended_by IS NULL DESC, created_at DESC LIMIT 1"
                ),
                params![agent_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    /// This master's open runs on this boot that a subagent holds, the latest
    /// declared first.
    pub fn held_runs_for_master(&self, master_session_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NOT NULL
                   AND ended_by IS NULL ORDER BY created_at DESC, rowid DESC"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id, boot_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// The run this master declared that no subagent has bound yet, if any.
    pub fn unbound_run_for_master(
        &self,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL ORDER BY created_at LIMIT 1"),
                params![master_session_id, boot_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn ended_with_open_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND ended_by IS NOT NULL AND session_id IS NOT NULL
                   AND session_terminal_at IS NULL AND close_refused_at IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    pub fn declared_without_session(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1 AND session_id IS NULL AND ended_by IS NULL ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map(params![boot_id], map_run).map_err(sql_err)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(sql_err)?);
        }
        Ok(out)
    }

    /// The newest unended run declared over exactly the checkout `tree`, if one is.
    ///
    /// A run is its checkout: a call made from inside one is that run's, whatever process makes it,
    /// which is the one fact a subagent's shell carries without being told (adminhub-api's ISS-49
    /// and ISS-85 judges, 2026-10-30, sent `self` and ids of their own making for want of it). Only
    /// the checkout itself matches, never one that encloses it: a pool job's tree inside a master's
    /// checkout is not a run declared over that checkout.
    pub fn open_run_at_tree(&self, tree: &Path) -> Result<Option<Run>> {
        let wanted = std::fs::canonicalize(tree).unwrap_or_else(|_| tree.to_path_buf());
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE ended_by IS NULL ORDER BY created_at DESC, run_id"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_run).map_err(sql_err)?;
        for row in rows {
            let run = row.map_err(sql_err)?;
            let held = std::fs::canonicalize(&run.worktree_path)
                .unwrap_or_else(|_| run.worktree_path.clone());
            if held == wanted {
                return Ok(Some(run));
            }
        }
        Ok(None)
    }

    /// The run bound to this subagent, if one is.
    pub fn run_for_agent(&self, agent_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE agent_id = ?1 AND ended_by IS NULL LIMIT 1"),
                params![agent_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }
}
