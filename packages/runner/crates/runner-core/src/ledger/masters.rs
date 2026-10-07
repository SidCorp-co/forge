use super::*;

impl Ledger {
    pub fn note_master(
        &self,
        project_id: &str,
        pane_name: &str,
        conversation_id: Option<&str>,
        session_id: Option<&str>,
        boot_id: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO masters (project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(project_id) DO UPDATE SET
                   pane_name       = excluded.pane_name,
                   conversation_id = COALESCE(excluded.conversation_id, masters.conversation_id),
                   session_id      = COALESCE(excluded.session_id, masters.session_id),
                   boot_id         = excluded.boot_id,
                   last_seen_at    = excluded.last_seen_at",
                params![project_id, pane_name, conversation_id, session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn open_master_pass(&self, pass: &MasterPass) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO master_passes (project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    pass.project_id,
                    pass.session_id,
                    pass.pass_id,
                    pass.verb,
                    pass.issue_key,
                    pass.opened_at,
                    pass.opened_by,
                    pass.turns_at_nudge.map(|n| n as i64),
                ],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn master_passes(&self) -> Result<Vec<MasterPass>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge
                 FROM master_passes ORDER BY opened_at",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], map_master_pass)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn master_pass_for(&self, project_id: &str) -> Result<Option<MasterPass>> {
        self.conn
            .query_row(
                "SELECT project_id, session_id, pass_id, verb, issue_key, opened_at, opened_by, prompts_at_nudge
                 FROM master_passes WHERE project_id = ?1",
                params![project_id],
                map_master_pass,
            )
            .optional()
            .map_err(sql_err)
    }

    pub fn renudge_master_pass(&self, pass_id: &str, turns: Option<u64>) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE master_passes SET prompts_at_nudge = ?2 WHERE pass_id = ?1",
                params![pass_id, turns.map(|n| n as i64)],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn closed_master_pass(&self, pass_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "DELETE FROM master_passes WHERE pass_id = ?1",
                params![pass_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn issues_declared_since(
        &self,
        master_session_id: &str,
        since: i64,
    ) -> Result<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT DISTINCT i.issue_key FROM run_issues i JOIN runs r ON r.run_id = i.run_id
                 WHERE r.master_session_id = ?1 AND r.created_at >= ?2
                 ORDER BY i.issue_key",
            )
            .map_err(sql_err)?;
        let keys = stmt
            .query_map(params![master_session_id, since], |r| r.get(0))
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(sql_err)?;
        Ok(keys)
    }

    /// Record that this box placed `pane_name` for `project_id` with `inputs`
    /// handed to it, which is the pane's whole claim to being current
    /// (ISS-1379). Written at placement, before the pane's own `SessionStart`
    /// hook writes the rest of its row, so it creates the row where there is
    /// none yet.
    pub fn note_master_placed(
        &self,
        project_id: &str,
        pane_name: &str,
        boot_id: &str,
        inputs: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO masters (project_id, pane_name, boot_id, cold_started_at, last_seen_at,
                                      placed_inputs, placed_at)
                 VALUES (?1, ?2, ?3, ?5, ?5, ?4, ?5)
                 ON CONFLICT(project_id) DO UPDATE SET
                   pane_name      = excluded.pane_name,
                   boot_id        = excluded.boot_id,
                   last_seen_at   = excluded.last_seen_at,
                   placed_inputs  = excluded.placed_inputs,
                   placed_at      = excluded.placed_at",
                params![project_id, pane_name, boot_id, inputs, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Name `session_id` on the project's `masters` row as the session its
    /// pane answers to — the one this box serves it as, which its runs are
    /// recorded under — with what a carry onto it left `unattributed`. Answers
    /// whether the row moved; a project with no row gets none, since nothing
    /// here knows when its pane was started.
    pub fn note_master_session(
        &self,
        project_id: &str,
        session_id: &str,
        unattributed: Option<&str>,
    ) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE masters SET session_id = ?2, unattributed = ?3
                  WHERE project_id = ?1 AND (session_id IS NOT ?2 OR unattributed IS NOT ?3)",
                params![project_id, session_id, unattributed],
            )
            .map_err(sql_err)?;
        Ok(changed == 1)
    }

    /// What this box knows about one project's master pane.
    pub fn master_for_project(&self, project_id: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at,
                        placed_at, unattributed, placed_inputs
                 FROM masters WHERE project_id = ?1",
                params![project_id],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The master row whose pane carries this name, which is how a command
    /// holding only a slug reaches the project id.
    pub fn master_for_pane(&self, pane_name: &str) -> Result<Option<MasterRow>> {
        self.conn
            .query_row(
                "SELECT project_id, pane_name, conversation_id, session_id, boot_id, cold_started_at, last_seen_at,
                        placed_at, unattributed, placed_inputs
                 FROM masters WHERE pane_name = ?1",
                params![pane_name],
                map_master,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Open an episode: this project's resident master is stood down until
    /// somebody stands it up again.
    ///
    /// `why` is a `&str` and not an `Option<&str>`, which is the whole of the
    /// requirement at this boundary: a caller with no reason to give cannot
    /// reach the table. Nothing else in this crate writes `master_standing`, so
    /// that signature is the constraint the column cannot carry — `why` stays
    /// nullable because the episodes an older binary wrote with no reason are
    /// migrated rather than rewritten, and SQLite will not hold a NOT NULL
    /// column over a row that already violates it (ISS-1238).
    ///
    /// Re-recording an already-standing stand-down updates the open episode
    /// rather than opening a second one, so the interval a pane is later told
    /// is the whole of it. The conflict target is the partial index over open
    /// episodes, which is also what keeps "at most one open episode per
    /// project" true in the table rather than only in this method.
    pub fn stand_down_master(
        &self,
        project_id: &str,
        slug: &str,
        by: &str,
        why: &str,
    ) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO master_standing
                   (project_id, slug, stood_down_at, stood_down_by, why, stood_up_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL)
                 ON CONFLICT(project_id) WHERE stood_up_at IS NULL DO UPDATE SET
                   slug          = excluded.slug,
                   stood_down_by = excluded.stood_down_by,
                   why           = excluded.why",
                params![project_id, slug, now(), by, why],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Close the open episode, recording who ended the wait and on what
    /// argument. Answers whether a standing stand-down was lifted.
    ///
    /// The argument is required for the same reason the reason is: a lift
    /// overrides somebody's deliberate stop, and the half a later reader needs
    /// most is why that stop was judged safe to reverse.
    pub fn stand_up_master(&self, project_id: &str, by: &str, why: &str) -> Result<bool> {
        let changed = self
            .conn
            .execute(
                "UPDATE master_standing
                    SET stood_up_at = ?2, stood_up_by = ?3, stood_up_why = ?4
                  WHERE project_id = ?1 AND stood_up_at IS NULL",
                params![project_id, now(), by, why],
            )
            .map_err(sql_err)?;
        Ok(changed > 0)
    }

    /// The latest standing episode for this project, standing or lifted.
    pub fn master_standing(&self, project_id: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                &format!("{SELECT_STANDING} WHERE project_id = ?1 ORDER BY episode DESC LIMIT 1"),
                params![project_id],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// The latest standing episode for the project this box knows by this slug.
    ///
    /// Keyed by slug and not by project id because a command, and `status`,
    /// may hold only the slug — and a stand-down can be recorded for a project
    /// this box has never placed a master for, which is exactly the case a
    /// lookup going through the `masters` row cannot see.
    pub fn master_standing_for_slug(&self, slug: &str) -> Result<Option<MasterStanding>> {
        self.conn
            .query_row(
                &format!("{SELECT_STANDING} WHERE slug = ?1 ORDER BY episode DESC LIMIT 1"),
                params![slug],
                map_standing,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every episode this box has held for one project, newest first.
    ///
    /// What the append-only table is for: the current episode says what is
    /// being waited for, and the ones behind it say what the box was waiting
    /// for the last three times and what ended each wait.
    pub fn standing_history(&self, slug: &str) -> Result<Vec<MasterStanding>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_STANDING} WHERE slug = ?1 ORDER BY episode DESC"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![slug], map_standing)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// The latest episode for every project this box has ever held one for.
    pub fn standings(&self) -> Result<Vec<MasterStanding>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_STANDING}
                  WHERE episode IN (SELECT MAX(episode) FROM master_standing GROUP BY project_id)
                  ORDER BY slug"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_standing).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Record what this box has just established about a project's master
    /// pane authority.
    ///
    /// `since` moves only when the answer moves — a different verdict, or the
    /// same verdict about a different pane. A sweep that reaches the same
    /// verdict about the same pane refreshes `seen_at` alone, so the pair says
    /// how long this has stood rather than how recently it was looked at. That
    /// interval is the whole point: the incident this issue was filed from ran
    /// for four hours and nothing on the box could say so (ISS-1099).
    pub fn note_master_authority(
        &self,
        project_id: &str,
        slug: &str,
        pane: (&str, Option<&str>),
        verdict: &str,
        detail: Option<&str>,
    ) -> Result<()> {
        let (pane_name, pane_incarnation) = pane;
        self.conn
            .execute(
                "INSERT INTO master_authority (project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
                 ON CONFLICT(project_id) DO UPDATE SET
                   slug            = excluded.slug,
                   pane_name       = excluded.pane_name,
                   pane_incarnation = excluded.pane_incarnation,
                   verdict         = excluded.verdict,
                   detail          = excluded.detail,
                   since           = CASE WHEN master_authority.verdict         =  excluded.verdict
                                           AND master_authority.pane_name       =  excluded.pane_name
                                           AND master_authority.pane_incarnation IS excluded.pane_incarnation
                                          THEN master_authority.since
                                          ELSE excluded.since END,
                   seen_at         = excluded.seen_at",
                params![project_id, slug, pane_name, pane_incarnation, verdict, detail, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// The authority verdict for the project this box knows by this slug.
    ///
    /// Keyed by slug for the reason `master_standing_for_slug` is: a command,
    /// and `master status`, may hold only the slug.
    pub fn master_authority_for_slug(&self, slug: &str) -> Result<Option<MasterAuthority>> {
        self.conn
            .query_row(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority WHERE slug = ?1",
                params![slug],
                map_authority,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every project this box holds an authority verdict about.
    pub fn authorities(&self) -> Result<Vec<MasterAuthority>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT project_id, slug, pane_name, pane_incarnation, verdict, detail, since, seen_at
                 FROM master_authority ORDER BY slug",
            )
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_authority).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Stamp ONE lifted episode as told, once the pane it was kept for has been
    /// told the interval. A standing one is never stamped by this.
    ///
    /// By episode and not by project. A project can hold an older lifted
    /// episode no pane was ever placed for, and stamping every untold one
    /// because a later episode reached a pane would put a delivery on the
    /// record that never happened.
    ///
    /// This replaced a DELETE (ISS-1238). Deleting was enough while the row's
    /// only job was to carry an interval to the next pane; it also destroyed
    /// the one account of what the box had been waiting for and what ended the
    /// wait, one placement after the lift. The stamp does the same job — a pane
    /// is told once — and keeps the episode.
    pub fn note_standing_told(&self, project_id: &str, episode: i64) -> Result<()> {
        self.conn
            .execute(
                "UPDATE master_standing SET told_at = ?3
                  WHERE project_id = ?1 AND episode = ?2
                    AND stood_up_at IS NOT NULL AND told_at IS NULL",
                params![project_id, episode, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Clear the conversation this project's next pane would resume, so it
    /// cold-starts instead.
    pub fn forget_master_conversation(&self, project_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE masters SET conversation_id = NULL WHERE project_id = ?1",
                params![project_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Record what the sweep last said about why an unclosed run stands, and
    /// answer whether that is new. Unlike [`Ledger::note_kept`] it holds for an
    /// ended run too: a run that ended under another boot is still standing,
    /// and is exactly the one whose standing must be said once and not for
    /// ever (ISS-1220).
    pub fn note_standing(&self, run_id: &str, notice: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET kept_notice = ?2 WHERE run_id = ?1 AND kept_notice IS NOT ?2",
                params![run_id, notice],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }
}
