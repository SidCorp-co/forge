-- A workflow is a standing subject (REQ-68 BC-5): its page shows its step, who it waits on and what is
-- next, and the steward writes its note and runs its acts on it like a requirement or a feedback item.
--   steward_notes.subject_kind      admits `workflow`.
--   steward_runs.subject_kind       admits `workflow`.
--
-- ROLLBACK: restore the three-kind CHECKs (0511 for steward_notes, 0508 for steward_runs). A workflow
-- note or run aborts that rollback by name, as the old CHECKs admit no `workflow` row.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "steward_notes" DROP CONSTRAINT IF EXISTS "steward_notes_subject_kind_chk";--> statement-breakpoint
ALTER TABLE "steward_notes" ADD CONSTRAINT "steward_notes_subject_kind_chk" CHECK ("steward_notes"."subject_kind" IN ('requirement', 'feedback', 'issue', 'workflow'));--> statement-breakpoint
ALTER TABLE "steward_runs" DROP CONSTRAINT IF EXISTS "steward_runs_subject_kind_chk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_subject_kind_chk" CHECK ("steward_runs"."subject_kind" IN ('requirement', 'feedback', 'issue', 'workflow'));
