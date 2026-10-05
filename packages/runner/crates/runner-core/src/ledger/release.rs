use super::*;

impl Ledger {
    pub fn mark_session_terminal_observed(&self, run_id: &str) -> Result<()> {
        self.stamp("session_terminal_at", run_id)
    }

    /// Record that the run no longer holds a checkout it owes back, and which
    /// of the two ways that came about.
    ///
    /// The one writer of both columns, so the pair cannot drift: `Gone` stamps
    /// `worktree_gone_at` as well, and `MainWorkingTreeKept` deliberately does
    /// not — the checkout is standing right there and a row saying otherwise
    /// is the state lying (ISS-1193).
    pub fn mark_checkout_returned_observed(&self, run_id: &str, how: CheckoutReturn) -> Result<()> {
        self.conn
            .execute(
                "UPDATE runs SET released_as = ?2 WHERE run_id = ?1 AND released_as IS NULL",
                params![run_id, how.wire()],
            )
            .map_err(sql_err)?;
        if how == CheckoutReturn::Gone {
            self.stamp("worktree_gone_at", run_id)?;
        }
        Ok(())
    }

    pub(crate) fn stamp(&self, column: &str, run_id: &str) -> Result<()> {
        debug_assert!(matches!(column, "session_terminal_at" | "worktree_gone_at"));
        self.conn
            .execute(
                &format!("UPDATE runs SET {column} = ?2 WHERE run_id = ?1 AND {column} IS NULL"),
                params![run_id, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    pub fn mark_lease_returned_observed(&self, run_id: &str, issue_key: &str) -> Result<()> {
        self.conn
            .execute(
                "UPDATE run_issues SET lease_returned_at = ?3
                 WHERE run_id = ?1 AND issue_key = ?2 AND lease_returned_at IS NULL",
                params![run_id, issue_key, now()],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Close a run on the record, with who ended it and why.
    /// Record that this run's release was refused, and answer WHEN the streak
    /// it belongs to began — which is this refusal's own stamp where it is the
    /// first, and the earlier one where it is not.
    ///
    /// The stamp is in the ledger rather than in the daemon's memory so that a
    /// restart inside the window resumes the refusal's age instead of starting
    /// it again, which is how a run kept its leases across restarts for as long
    /// as the box lived.
    ///
    /// A stamp LATER than the clock now reading it is a clock that moved
    /// backwards — ntp correcting a box that booted with a bad RTC is the
    /// ordinary way — and it is pulled back to now rather than kept. Kept, it
    /// would put the end of the window that many seconds further away every
    /// sweep until the clock caught up. The other direction is left alone: a
    /// clock jumping FORWARD past the window decides the refusal early, and
    /// early is the safe end of that trade — the leases come back and the
    /// checkout is untouched.
    ///
    /// Neither of those is what makes the window END, though, because a clock
    /// corrected backwards again and again is a clock that can hold any
    /// deadline off for ever. The attempt count is: it only ever goes up, no
    /// correction reaches it, and it is what decides a refusal on a box whose
    /// clock cannot be trusted at all.
    pub fn note_release_refusal(&mut self, run_id: &str, why: &str, at: i64) -> Result<Refusal> {
        self.conn
            .execute(
                "UPDATE runs SET release_refusal = ?2,
                        release_refused_at = MIN(COALESCE(release_refused_at, ?3), ?3),
                        release_attempts = release_attempts + 1
                  WHERE run_id = ?1",
                params![run_id, why, at],
            )
            .map_err(sql_err)?;
        let row: Option<(Option<i64>, i64)> = self
            .conn
            .query_row(
                "SELECT release_refused_at, release_attempts FROM runs WHERE run_id = ?1",
                params![run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(sql_err)?;
        let (since, attempts) = row.unwrap_or((Some(at), 1));
        let since = since.unwrap_or(at);
        Ok(Refusal {
            since,
            attempts,
            opened_the_streak: attempts <= 1,
        })
    }

    /// Say this refusal is one no retry gets past, and end the run over it,
    /// where nothing ended it before. An ending already on the row stands, as
    /// [`Ledger::end_run`] keeps it: a master's `run close` whose release is
    /// then refused is still the master's (ISS-1312 criterion 74).
    /// `refusal_wrote_ending` says which of the two it was, so a retraction
    /// takes back only an ending this decision wrote.
    ///
    /// One transaction, because the two halves are one decision: a box that
    /// stopped between them would come back holding a run that no sweep picks
    /// up — `release_terminal_at` takes it off the release path — and that no
    /// sweep finishes either, because `ended_by` is still unset. That is a
    /// wedged run again, wearing the mark that was meant to end one.
    pub fn conclude_release_refusal(
        &mut self,
        run_id: &str,
        at: i64,
        ended_by: &str,
        reason: &str,
    ) -> Result<()> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        tx.execute(
            "UPDATE runs SET release_terminal_at = ?2, work = 'done', incarnation = 'exited',
                    refusal_wrote_ending = CASE WHEN ended_by IS NULL THEN 1 ELSE 0 END,
                    ended_reason = CASE WHEN ended_by IS NULL THEN ?4 ELSE ended_reason END,
                    ended_by = COALESCE(ended_by, ?3)
              WHERE run_id = ?1",
            params![run_id, at, ended_by, reason],
        )
        .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(())
    }

    /// Say a standing refusal was overtaken by the world rather than decided,
    /// and answer whether there was one to settle.
    ///
    /// A refusal is decided by [`Ledger::conclude_release_refusal`] when the
    /// same refusal is taken again past its window or its attempt bound. It is
    /// forgotten by [`Ledger::forget_release_refusal`] when a later release
    /// gets through. Neither fires when the thing the refusal was about stops
    /// being true on its own — a master pruning the worktree a minute after the
    /// release was refused over it, which is `f0c38b4e` — and the row then
    /// keeps `release_refused_at` with a null `release_terminal_at` for ever,
    /// so the ledger reports a refusal that was never decided and the question
    /// "which runs are stranded" has no answer from the row (ISS-1242).
    ///
    /// `release_refusal` is kept verbatim, because what was refused is still
    /// the fact and an operator reading the row is owed it. The ending is left
    /// alone too: another path may already have written one, and this verb
    /// has no ending of its own to give.
    pub fn settle_release_refusal(&mut self, run_id: &str, at: i64) -> Result<bool> {
        let n = self
            .conn
            .execute(
                "UPDATE runs SET release_terminal_at = ?2, refusal_wrote_ending = 0
                  WHERE run_id = ?1
                    AND release_refused_at IS NOT NULL
                    AND release_terminal_at IS NULL",
                params![run_id, at],
            )
            .map_err(sql_err)?;
        Ok(n == 1)
    }

    /// Forget a refusal a release got past. The run's own ending, if it has
    /// one, is not this verb's business: a release that succeeded ended the run
    /// on purpose.
    pub fn forget_release_refusal(&mut self, run_id: &str) -> Result<()> {
        self.conn
            .execute(
                &format!("UPDATE runs SET {CLEAR_REFUSAL} WHERE run_id = ?1"),
                params![run_id],
            )
            .map_err(sql_err)?;
        Ok(())
    }

    /// Take back the decision that a run's release could not be made, so the
    /// next sweep attempts it again. Answers whether there was one to take back.
    ///
    /// The ending goes with it, in the same transaction, where the decision
    /// wrote it, because it was PART of that decision. Left in place it would
    /// say the run is over while its release is owed again — and
    /// `held_worktrees` reads exactly that to decide what the reaper may not
    /// touch, so the checkout being kept for the retry would stop being kept
    /// the moment an operator asked for one. An ending the decision found on
    /// the row, such as a master's `run close`, is not the decision's to take
    /// back, and the run returns to the state it was in before its release was
    /// refused (ISS-1312 criterion 74).
    pub fn retract_release_refusal(&mut self, run_id: &str) -> Result<bool> {
        let tx = self.conn.transaction().map_err(sql_err)?;
        let n = tx
            .execute(
                &format!(
                    "UPDATE runs SET {CLEAR_REFUSAL},
                            ended_by = CASE WHEN refusal_wrote_ending = 1 THEN NULL ELSE ended_by END,
                            ended_reason = CASE WHEN refusal_wrote_ending = 1 THEN NULL ELSE ended_reason END,
                            refusal_wrote_ending = NULL
                      WHERE run_id = ?1
                        AND (release_refused_at IS NOT NULL OR release_terminal_at IS NOT NULL)"
                ),
                params![run_id],
            )
            .map_err(sql_err)?;
        tx.commit().map_err(sql_err)?;
        Ok(n == 1)
    }
}
