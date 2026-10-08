-- A template report a schedule stored says how its narrative came to be: the model wrote it at the
-- first call, wrote it at the one retry that carried the refusal of the first, or it was not written,
-- with the reason (`StatusReportNarrative` in @forge/contracts/status-reports). Only a schedule's
-- template report holds one; a saved report and a project status read hold none, so every existing
-- row satisfies the check unchanged. The immutability guard now covers the new column.
--
-- ROLLBACK: restore the 0463 guard function; ALTER TABLE status_reports DROP CONSTRAINT
-- status_reports_narrative_chk, DROP COLUMN narrative_outcome.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "status_reports" ADD COLUMN IF NOT EXISTS "narrative_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_narrative_chk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_narrative_chk" CHECK ("status_reports"."narrative_outcome" IS NULL OR ("status_reports"."document" IS NOT NULL AND "status_reports"."producer_kind" = 'schedule' AND jsonb_typeof("status_reports"."narrative_outcome") = 'object' AND "status_reports"."narrative_outcome"->>'path' IN ('written', 'retried', 'not_written')));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "status_report_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."producer_kind" IS DISTINCT FROM OLD."producer_kind"
     OR NEW."period" IS DISTINCT FROM OLD."period"
     OR NEW."as_of" IS DISTINCT FROM OLD."as_of"
     OR NEW."days" IS DISTINCT FROM OLD."days"
     OR NEW."report" IS DISTINCT FROM OLD."report"
     OR NEW."template_id" IS DISTINCT FROM OLD."template_id"
     OR NEW."template_version" IS DISTINCT FROM OLD."template_version"
     OR NEW."document" IS DISTINCT FROM OLD."document"
     OR NEW."narrative_outcome" IS DISTINCT FROM OLD."narrative_outcome"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."produced_by" IS DISTINCT FROM OLD."produced_by" AND NEW."produced_by" IS NOT NULL)
     OR (NEW."schedule_id" IS DISTINCT FROM OLD."schedule_id" AND NEW."schedule_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'STATUS_REPORT_IMMUTABLE: status report % read at % is never changed; store a new one', OLD."id", OLD."as_of" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
