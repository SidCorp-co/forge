use super::*;

impl Ledger {
    pub fn create_run_group(&mut self, new: NewRun) -> Result<Run> {
        if new.issue_keys.is_empty() {
            return Err(Error::Other(
                "ledger: a run must carry at least one issue".into(),
            ));
        }
        let tx = self.conn.transaction().map_err(sql_err)?;
        for key in &new.issue_keys {
            if let Some(holder) = Self::live_run_holding(&tx, &new.project_id, key, &new.boot_id)? {
                return Err(Error::Other(match Self::host_ended_by(&tx, &holder)? {
                    Some(by) => format!(
                        "ledger: issue {key} is held by run {holder}, which is not running: the Claude Code process its subagent ran in is gone{}. {}",
                        match by.as_str() {
                            HOST_PANE_STARTED => ", and its master's pane has since been started again",
                            HOST_PANE_GONE => ", with the master pane this box read as gone",
                            _ => "",
                        },
                        // Only the session the row names may close it, so the
                        // refusal offers `run close` to that session alone: a
                        // cold-started successor is refused its close as
                        // another master's (ISS-1312 criteria 48 and 49).
                        if Self::master_of(&tx, &holder)?.as_deref() == Some(new.master_session_id.as_str()) {
                            format!("Close it with `forge-runner run close {holder}` to free the issue now; otherwise recovery releases it on the first recovery sweep after core calls that run's session over")
                        } else {
                            "Recovery releases it on the first recovery sweep after core calls that run's session over. It was declared under another master session, so nothing this master can do frees it sooner".to_string()
                        }
                    ),
                    // A row an older binary wrote records no project, so the
                    // key it holds is nobody's in particular: saying the issue
                    // belongs to it asserts a holder this box cannot establish
                    // (ISS-1352).
                    None if Self::project_of(&tx, &holder)?.is_none() => format!(
                        "ledger: issue {key} is held by live run {holder}, whose row records no project, so this box cannot tell whether that run's {key} is this project's issue or another's. It stays held until that run ends, and `forge-runner status` names it where no master answers for it"
                    ),
                    None => format!("ledger: issue {key} already belongs to live run {holder}"),
                }));
            }
        }
        let path = new.worktree_path.to_string_lossy().to_string();
        if let Some(holder) = Self::live_run_at_path(&tx, &path, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: worktree {path} is already held by live run {holder}"
            )));
        }
        if let Some(pending) = Self::unbound_run_of(&tx, &new.master_session_id, &new.boot_id)? {
            return Err(Error::Other(format!(
                "ledger: run {pending} is declared under this master and no subagent has bound it yet — close it before declaring another"
            )));
        }
        tx.execute(
            "INSERT INTO runs (run_id, project_id, master_session_id, worktree_path, pid, boot_id, incarnation, work, created_at)
             VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, ?8)",
            params![
                new.run_id,
                new.project_id,
                new.master_session_id,
                path,
                new.boot_id,
                Incarnation::Live.wire(),
                Work::Runnable.wire(),
                now()
            ],
        )
        .map_err(sql_err)?;
        for key in &new.issue_keys {
            tx.execute(
                "INSERT INTO run_issues (run_id, issue_key) VALUES (?1, ?2)",
                params![new.run_id, key],
            )
            .map_err(sql_err)?;
        }
        tx.commit().map_err(sql_err)?;
        self.run(&new.run_id)?
            .ok_or_else(|| Error::Other("ledger: run vanished after commit".into()))
    }

    /// The live run holding `issue_key` of `project_id`. An issue key names an
    /// issue only inside its project, so another project's ISS-533 is another
    /// issue. A row that records no project cannot be told apart and still
    /// holds.
    pub(crate) fn live_run_holding(
        tx: &rusqlite::Transaction<'_>,
        project_id: &str,
        issue_key: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            &format!(
                "SELECT r.run_id FROM runs r JOIN run_issues i ON i.run_id = r.run_id
                  WHERE i.issue_key = ?1 AND r.incarnation = 'live' AND r.boot_id = ?2
                    AND (r.project_id = ?3 OR r.project_id IS NULL)
                    AND NOT {CLOSED_BY_ITS_MARKS}
                  LIMIT 1"
            ),
            params![issue_key, boot_id, project_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    /// The master session `run_id`'s row answers to.
    pub(crate) fn master_of(
        tx: &rusqlite::Transaction<'_>,
        run_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT master_session_id FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    /// The project `run_id`'s row records, where it records one.
    pub(crate) fn project_of(
        tx: &rusqlite::Transaction<'_>,
        run_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT project_id FROM runs WHERE run_id = ?1",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql_err)
    }

    /// How this box saw the master pane of `run_id` end, where it has.
    pub(crate) fn host_ended_by(
        tx: &rusqlite::Transaction<'_>,
        run_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT host_ended_by FROM runs
              WHERE run_id = ?1 AND host_ended_at_ms IS NOT NULL AND host_pid IS NOT NULL",
            params![run_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map(Option::flatten)
        .map_err(sql_err)
    }

    pub(crate) fn unbound_run_of(
        tx: &rusqlite::Transaction<'_>,
        master_session_id: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        tx.query_row(
            "SELECT run_id FROM runs
              WHERE master_session_id = ?1 AND boot_id = ?2 AND agent_id IS NULL AND ended_by IS NULL
              ORDER BY created_at LIMIT 1",
            params![master_session_id, boot_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(sql_err)
    }

    pub(crate) fn live_run_at_path(
        tx: &rusqlite::Transaction<'_>,
        path: &str,
        boot_id: &str,
    ) -> Result<Option<String>> {
        let wanted = std::fs::canonicalize(path).ok();
        let mut stmt = tx
            .prepare(&format!(
                "SELECT r.run_id, r.worktree_path FROM runs r
                  WHERE r.incarnation = 'live' AND r.boot_id = ?1 AND NOT {CLOSED_BY_ITS_MARKS}"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sql_err)?;
        for row in rows {
            let (run_id, held) = row.map_err(sql_err)?;
            if held == path {
                return Ok(Some(run_id));
            }
            if let (Some(w), Ok(h)) = (wanted.as_ref(), std::fs::canonicalize(&held)) {
                if &h == w {
                    return Ok(Some(run_id));
                }
            }
        }
        Ok(None)
    }

    pub fn held_worktrees(&self) -> Result<Vec<(PathBuf, String)>> {
        let mut stmt = self
            .conn
            // A checkout the release terminally refused to remove is not the
            // reaper's to remove either: the same refusal binds both, and
            // ending the run is what would otherwise hand it over (ISS-1188).
            //
            // `released_as IS NULL` narrows that to the refusals it was written
            // for. A run whose checkout git's registry says is back holds none
            // to protect, whatever its refusal said, and a settled refusal
            // (ISS-1242) stamps exactly that row — so without this the stamp
            // would tell the reaper to keep a checkout that is already gone.
            .prepare(
                "SELECT worktree_path, run_id FROM runs
                  WHERE ended_by IS NULL
                     OR (release_terminal_at IS NOT NULL AND released_as IS NULL)",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    PathBuf::from(row.get::<_, String>(0)?),
                    row.get::<_, String>(1)?,
                ))
            })
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Which run `typed` names: its whole id, or the start of exactly one.
    ///
    /// A person names a run the way this box writes one for them — its first
    /// eight characters (`short_id`), as masters' comments do — and was told
    /// "no run" for a run that stood (ISS-294's judge). A start shorter than
    /// that is said to be too short rather than resolved, so a stray few
    /// characters never close or brief a run nobody meant.
    pub fn run_named(&self, typed: &str) -> Result<Named> {
        if self.run(typed)?.is_some() {
            return Ok(Named::Whole(typed.to_string()));
        }
        if typed.is_empty() || !typed.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
            return Ok(Named::Nothing);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT run_id FROM runs WHERE substr(run_id, 1, ?2) = ?1 ORDER BY created_at, run_id")
            .map_err(sql_err)?;
        let len = i64::try_from(typed.chars().count()).unwrap_or(i64::MAX);
        let ids = stmt
            .query_map(params![typed, len], |row| row.get::<_, String>(0))
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<String>>>()
            .map_err(sql_err)?;
        Ok(match ids.as_slice() {
            [] => Named::Nothing,
            _ if typed.chars().count() < SHORT_ID_CHARS => Named::TooShort(ids),
            [one] => Named::Start(one.clone()),
            _ => Named::Ambiguous(ids),
        })
    }

    /// One run by id.
    pub fn run(&self, run_id: &str) -> Result<Option<Run>> {
        self.conn
            .query_row(
                &format!("{SELECT_RUN} WHERE run_id = ?1"),
                params![run_id],
                map_run,
            )
            .optional()
            .map_err(sql_err)
    }

    /// Every run whose close loop still has something owed.
    ///
    /// A run whose release was decided terminal leaves as soon as its leases
    /// are back, and not before: its checkout is staying on disk by decision,
    /// so `worktree_gone_at` will never be stamped and reading the three marks
    /// alone would keep answering "still owed" every sweep for ever. The leases
    /// are the half that must still be chased, because a lease nobody returns
    /// is an issue no run on this box can take (ISS-1188).
    ///
    /// A row whose three marks are all set but whose refusal was never decided
    /// is owed one more pass, and that disjunct is what gives it one: the rows
    /// ISS-1242 names were every one of them closed by the sweep AFTER their
    /// refusal, so a settle nothing selects them for settles nothing. The pass
    /// terminates because the settle stamps `release_terminal_at`, which the
    /// second clause then excludes on.
    pub fn unclosed_runs(&self) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE (session_terminal_at IS NULL OR released_as IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL)
                 OR (release_refused_at IS NOT NULL AND release_terminal_at IS NULL))
                 AND (release_terminal_at IS NULL
                 OR run_id IN (SELECT run_id FROM run_issues WHERE lease_returned_at IS NULL))
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt.query_map([], map_run).map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// The runs a master pane started now for `project_id` inherits: declared on
    /// this boot, not ended, and still holding the checkout they were given,
    /// whichever master session declared them (ISS-1312).
    pub fn inheritable_runs(&self, project_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE project_id = ?1 AND boot_id = ?2 AND ended_by IS NULL
                   AND released_as IS NULL AND release_terminal_at IS NULL
                 ORDER BY created_at"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![project_id, boot_id], map_run)
            .map_err(sql_err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(sql_err)
    }

    /// Every run no master on this box answers for, oldest first.
    ///
    /// The declaring session is compared with every `masters` row and not only
    /// its project's, because `run close` authorises by session alone: a run
    /// is answered for exactly when some pane's recorded session could close it.
    pub fn runs_no_master_answers_for(&self) -> Result<Vec<Unanswered>> {
        let ids: Vec<(String, bool, bool)> = {
            let mut stmt = self
                .conn
                .prepare(&format!(
                    "SELECT r.run_id, {CLOSED_BY_ITS_MARKS},
                            EXISTS (SELECT 1 FROM masters m
                                     WHERE m.project_id = r.project_id AND m.session_id IS NULL)
                       FROM runs r
                      WHERE r.ended_by IS NULL
                        AND NOT EXISTS (SELECT 1 FROM masters m WHERE m.session_id = r.master_session_id)
                      ORDER BY r.created_at, r.run_id"
                ))
                .map_err(sql_err)?;
            let rows = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(sql_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
                .map_err(sql_err)?
        };
        let mut out = Vec::with_capacity(ids.len());
        for (run_id, closed_by_its_marks, master_row_has_no_session) in ids {
            let Some(run) = self.run(&run_id)? else {
                continue;
            };
            out.push(Unanswered {
                issues: self.issues(&run_id)?,
                run,
                closed_by_its_marks,
                master_row_has_no_session,
            });
        }
        Ok(out)
    }

    /// End every run no master answers for that its marks already close, and
    /// answer the ones it ended.
    ///
    /// Such a row holds nothing — `live_run_holding` and `unclosed_runs` both
    /// pass over it — and no writer of `ended_by` ever reaches it: its master's
    /// close is refused to every pane, and recovery walks only `unclosed_runs`.
    /// On one box that left 51 rows open for up to six days (ISS-1355). The
    /// update repeats every guard of the selection in its own `WHERE`, so a
    /// row a pane took over, or whose project's master row lost its session,
    /// between the read and the write is left as the selection would leave it.
    pub fn end_closed_runs_no_master_answers_for(&self) -> Result<Vec<Unanswered>> {
        let mut ended = Vec::new();
        for u in self.runs_no_master_answers_for()? {
            if u.sweep_ends_it() && self.end_unanswered(&u)? {
                ended.push(u);
            }
        }
        Ok(ended)
    }

    /// End one run a read of [`Self::runs_no_master_answers_for`] found, if
    /// every guard that read applied still holds; answers whether it did.
    pub(crate) fn end_unanswered(&self, u: &Unanswered) -> Result<bool> {
        let reason = format!(
            "no master on this box can close it: it was declared under master session {}, which is no master session this box records, and its marks already close it — its session is over, its checkout was returned ({}) and every lease is back",
            short_id(&u.run.master_session_id),
            u.run.released_as.as_deref().unwrap_or("unrecorded")
        );
        let changed = self
            .conn
            .execute(
                &format!(
                    "UPDATE runs SET work = 'done', incarnation = 'exited',
                            ended_by = 'recovery', ended_reason = ?2
                      WHERE run_id = ?1 AND ended_by IS NULL AND project_id IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM masters m WHERE m.session_id = runs.master_session_id)
                        AND NOT EXISTS (SELECT 1 FROM masters m
                                         WHERE m.project_id = runs.project_id AND m.session_id IS NULL)
                        AND run_id IN (SELECT r.run_id FROM runs r WHERE r.run_id = ?1 AND {CLOSED_BY_ITS_MARKS})"
                ),
                params![u.run.run_id, reason],
            )
            .map_err(sql_err)?;
        Ok(changed == 1)
    }

    /// Record that the process the subagent of `run_id` lived in ended at
    /// `at_ms`, seen as `by`. Only a run with no process of its own is a
    /// subagent's, so a run with a pid is left alone. A new pane started is a
    /// later end than any before it and moves a mark already standing; a pane
    /// read gone on every sweep is the same end read again, and writes only
    /// where no mark stands. A row that records no process for its subagent is
    /// left alone: without one, nothing this box saw is that subagent's end.
    pub fn note_host_ended(&self, run_id: &str, at_ms: i64, by: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_ended_at_ms = ?2, host_ended_by = ?3
                  WHERE run_id = ?1 AND pid IS NULL AND ended_by IS NULL
                    AND host_pid IS NOT NULL
                    AND (?3 = ?4 OR host_ended_at_ms IS NULL)",
                params![run_id, at_ms, by, HOST_PANE_STARTED],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Record the Claude Code process `run_id`'s subagent runs in, as read above
    /// the process that just reported for it. The latest report stands, since a
    /// subagent resumed after its master was placed again runs in the new one.
    pub fn note_host(&self, run_id: &str, pid: u32, start: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_pid = ?2, host_start = ?3
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, pid, start],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Take back a [`HOST_PANE_GONE`] mark on an open run, because its master's
    /// pane has since read alive: the earlier read saw nothing end. A
    /// [`HOST_PANE_STARTED`] mark is a placement rather than a read of a pane,
    /// and stands (ISS-1312).
    pub fn withdraw_pane_gone(&self, run_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET host_ended_at_ms = NULL, host_ended_by = NULL
                  WHERE run_id = ?1 AND host_ended_by = ?2 AND ended_by IS NULL",
                params![run_id, HOST_PANE_GONE],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

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

    /// Bind open run `run_id` to subagent `agent_id`, which answers to no
    /// other open run. A run it answered to that has ended does not stop it:
    /// a master resumes a subagent it already ran for the next declaration,
    /// and that resume is the subagent taking the new run (ISS-1378).
    pub fn bind_agent(&self, run_id: &str, agent_id: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET agent_id = ?2
                  WHERE run_id = ?1 AND agent_id IS NULL AND ended_by IS NULL
                    AND NOT EXISTS (SELECT 1 FROM runs o
                                     WHERE o.agent_id = ?2 AND o.ended_by IS NULL)",
                params![run_id, agent_id],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
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

    pub fn record_resume_choice(
        &self,
        run_id: &str,
        master_session_id: &str,
        choice: &str,
        why: &str,
    ) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_choice = ?3, resume_choice_why = ?4
                  WHERE run_id = ?1 AND master_session_id = ?2
                    AND resume_owed_at IS NOT NULL AND resume_choice IS NULL",
                params![run_id, master_session_id, choice, why],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    pub fn owe_resume_choices(&self, master_session_id: &str, boot_id: &str) -> Result<usize> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET resume_owed_at = ?3
                  WHERE master_session_id = ?1 AND boot_id = ?2
                    AND ended_by IS NULL AND resume_choice IS NULL",
                params![master_session_id, boot_id, now()],
            )
            .map_err(sql_err)?;
        Ok(n)
    }

    pub fn choices_awaiting_report(&self, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE boot_id = ?1
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NOT NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn mark_resume_choice_said(&self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET resume_owed_at = NULL WHERE run_id = ?1",
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn runs_awaiting_choice(&self, master_session_id: &str, boot_id: &str) -> Result<Vec<Run>> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_RUN} WHERE master_session_id = ?1 AND boot_id = ?2
                   AND resume_owed_at IS NOT NULL AND resume_choice IS NULL"
            ))
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![master_session_id, boot_id], map_run)
            .map_err(sql_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(sql_err)?;
        Ok(rows)
    }

    pub fn liveness(run: &Run, this_boot: &str, pid_refuted: bool) -> Liveness {
        if run.boot_id != this_boot {
            return Liveness::Unknown;
        }
        match (run.incarnation, run.pid) {
            (Incarnation::Live | Incarnation::Starting, Some(_)) if !pid_refuted => Liveness::Alive,
            (Incarnation::Live | Incarnation::Starting, Some(_)) => Liveness::Dead,
            (Incarnation::Exited, _) => Liveness::Dead,
            (_, None) => Liveness::Unknown,
        }
    }

    /// A subagent run's subagent ended a turn. The run stays open: only its
    /// master's close or its master's death ends a subagent run (ISS-1246).
    ///
    /// The newest stop wins, so a replayed or reordered hook cannot move the
    /// time back; `transcript` is kept where a frame names none; and a notice
    /// already given is cleared only by a stop newer than the one it was about,
    /// so a replayed stop cannot have the same silence said twice.
    pub fn note_turn_end(
        &self,
        run_id: &str,
        at_ms: i64,
        transcript: Option<&str>,
    ) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET turn_ended_at_ms = MAX(COALESCE(turn_ended_at_ms, ?2), ?2),
                        agent_transcript = COALESCE(?3, agent_transcript),
                        kept_notice = CASE WHEN turn_ended_at_ms IS NULL OR ?2 > turn_ended_at_ms
                                           THEN NULL ELSE kept_notice END
                  WHERE run_id = ?1 AND ended_by IS NULL",
                params![run_id, at_ms, transcript],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Record what the box said about keeping a subagent run open. True only
    /// where this notice was not already the one standing, which is what lets
    /// the caller say it once rather than on every sweep.
    pub fn note_kept(&self, run_id: &str, notice: &str) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET kept_notice = ?2
                  WHERE run_id = ?1 AND ended_by IS NULL AND kept_notice IS NOT ?2",
                params![run_id, notice],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// End a run. The first ending recorded stands: a release that follows a
    /// master's `run close` finishes the run and leaves who ended it and why,
    /// where it wrote its own over the close (ISS-1312 criterion 74, run
    /// 172f356e).
    pub fn end_run(&self, run_id: &str, ended_by: &str, reason: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET work = 'done', incarnation = 'exited',
                        ended_reason = CASE WHEN ended_by IS NULL THEN ?3 ELSE ended_reason END,
                        ended_by = COALESCE(ended_by, ?2)
                 WHERE run_id = ?1",
                params![run_id, ended_by, reason],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn issues(&self, run_id: &str) -> Result<Vec<Membership>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT issue_key, lease_returned_at FROM run_issues WHERE run_id = ?1 ORDER BY issue_key",
            )
            .map_err(sql_err)?;
        let rows = stmt
            .query_map(params![run_id], |row| {
                Ok(Membership {
                    issue_key: row.get(0)?,
                    lease_returned_at: row.get(1)?,
                })
            })
            .map_err(sql_err)?;
        rows.collect::<std::result::Result<Vec<_>, _>>()
            .map_err(sql_err)
    }
}
