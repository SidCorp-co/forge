//! The resume choice a master owes for each run it inherited: owed, chosen, reported (ISS-853).

use super::*;

impl Ledger {
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
}
