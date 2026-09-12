-- Remove the feedback→candidates→improvement-draft chain. The CLI feedback path
-- (`forge_feedback` → `feedback_reports`) supersedes it and `feedback_reports` is
-- NOT touched here: all 288 rows stay, and every candidate was derived from one.
--
-- Measured on the live DB 2026-09-12 before writing this:
--   memory_candidates          74 rows, ALL signal_type='agent_self_report', ALL status='accruing'
--                              (newest 2026-08-30; nothing graduated, ever)
--   repeated_fix_type          0 rows, ever
--   handoff_gap_rescue         0 rows, ever
--   reopen_loop                0 rows, ever — the enum value had no producer at all
--   improvement_message_drafts 0 rows
--
-- The 74 candidates are DERIVED data: feedback_reports.candidate_id is set on exactly
-- 74 rows, so each one is reconstructible from its source report. Nothing original dies.

-- Refuse rather than clean away. A row this migration cannot account for means the
-- measurement above no longer holds, and dropping the table would destroy evidence
-- nobody has read. Abort naming the count instead.
DO $$
DECLARE unexpected bigint;
BEGIN
  SELECT count(*) INTO unexpected
  FROM memory_candidates
  WHERE signal_type <> 'agent_self_report' OR status <> 'accruing';

  IF unexpected > 0 THEN
    RAISE EXCEPTION
      'memory_candidates holds % row(s) outside the agent_self_report/accruing set this migration was written against — inspect them before dropping the table',
      unexpected;
  END IF;
END $$;
--> statement-breakpoint

DO $$
DECLARE drafts bigint;
BEGIN
  SELECT count(*) INTO drafts FROM improvement_message_drafts;
  IF drafts > 0 THEN
    RAISE EXCEPTION
      'improvement_message_drafts holds % row(s); it was empty when this migration was written — read them before dropping',
      drafts;
  END IF;
END $$;
--> statement-breakpoint

-- `feedback_reports` keeps every row; only the pointer into the dropped table goes.
ALTER TABLE "feedback_reports" DROP COLUMN IF EXISTS "candidate_id";
--> statement-breakpoint

DROP TABLE IF EXISTS "improvement_message_drafts";
--> statement-breakpoint

DROP TABLE IF EXISTS "memory_candidates";
