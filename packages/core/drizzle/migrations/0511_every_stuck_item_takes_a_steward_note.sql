-- Every stuck item takes a steward note, an issue included, and a refused act is not retried on the
-- same standing (REQ-48 BC-5, BC-7).
--   steward_notes.subject_kind      admits `issue`: the standing read lists stuck issues and the steward
--                                    diagnoses them, so each gets its two-line note like a requirement.
--   steward_runs.failure_kind       why a failed run failed: `refused` (a door refused an act; only a
--                                    moved standing changes that, so the sweep never starts it again on
--                                    the same basis) or `error` (the turn or its job did not finish,
--                                    tried again an hour later). Set exactly when the run failed; a run
--                                    that failed before this column reads `error`.
--
-- ROLLBACK: ALTER TABLE steward_runs DROP COLUMN failure_kind; restore the two-kind
-- steward_notes_subject_kind_chk (0507). An issue note aborts that rollback by name, as the old CHECK
-- admits no `issue` row.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "steward_notes" DROP CONSTRAINT IF EXISTS "steward_notes_subject_kind_chk";--> statement-breakpoint
ALTER TABLE "steward_notes" ADD CONSTRAINT "steward_notes_subject_kind_chk" CHECK ("steward_notes"."subject_kind" IN ('requirement', 'feedback', 'issue'));--> statement-breakpoint
ALTER TABLE "steward_runs" ADD COLUMN IF NOT EXISTS "failure_kind" text;--> statement-breakpoint
UPDATE "steward_runs" SET "failure_kind" = 'error' WHERE "state" = 'failed' AND "failure_kind" IS NULL;--> statement-breakpoint
ALTER TABLE "steward_runs" DROP CONSTRAINT IF EXISTS "steward_runs_failure_kind_chk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_failure_kind_chk" CHECK ("steward_runs"."failure_kind" IS NULL OR "steward_runs"."failure_kind" IN ('refused', 'error'));--> statement-breakpoint
ALTER TABLE "steward_runs" DROP CONSTRAINT IF EXISTS "steward_runs_failure_kind_set_chk";--> statement-breakpoint
ALTER TABLE "steward_runs" ADD CONSTRAINT "steward_runs_failure_kind_set_chk" CHECK (("steward_runs"."state" = 'failed') = ("steward_runs"."failure_kind" IS NOT NULL));
