-- A kept status report may be one report template's output instead of a project status read.
-- `template_id`, `template_version` and `document` (a `ReportDocument`: the template's runs, blocks and
-- the narrative as it was kept) are set together and only on a template report; such a report holds no
-- `report` (the ProjectStatus read) and no `days`, whose window is the template's params. The shape
-- check names which of the two a row is, so a row that is both or neither is refused by the database.
-- Existing rows are all project status reads and satisfy it unchanged. The immutability guard now
-- covers the three new columns.
--
-- ROLLBACK: DELETE FROM status_reports WHERE document IS NOT NULL; restore the 0459 guard function and
-- the two checks; ALTER TABLE status_reports ALTER COLUMN report SET NOT NULL, ALTER COLUMN days SET
-- NOT NULL; DROP the three columns and status_reports_shape_chk.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "status_reports" ADD COLUMN IF NOT EXISTS "template_id" text;--> statement-breakpoint
ALTER TABLE "status_reports" ADD COLUMN IF NOT EXISTS "template_version" integer;--> statement-breakpoint
ALTER TABLE "status_reports" ADD COLUMN IF NOT EXISTS "document" jsonb;--> statement-breakpoint
ALTER TABLE "status_reports" ALTER COLUMN "report" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "status_reports" ALTER COLUMN "days" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_days_chk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_days_chk" CHECK ("status_reports"."days" IS NULL OR "status_reports"."days" BETWEEN 1 AND 90);--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_report_chk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_report_chk" CHECK ("status_reports"."report" IS NULL OR jsonb_typeof("status_reports"."report") = 'object');--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_shape_chk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_shape_chk" CHECK (("status_reports"."document" IS NULL) = ("status_reports"."template_id" IS NULL) AND ("status_reports"."document" IS NULL) = ("status_reports"."template_version" IS NULL) AND ("status_reports"."document" IS NULL) = ("status_reports"."report" IS NOT NULL) AND ("status_reports"."report" IS NULL) = ("status_reports"."days" IS NULL) AND ("status_reports"."document" IS NULL OR jsonb_typeof("status_reports"."document") = 'object'));--> statement-breakpoint
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
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."produced_by" IS DISTINCT FROM OLD."produced_by" AND NEW."produced_by" IS NOT NULL)
     OR (NEW."schedule_id" IS DISTINCT FROM OLD."schedule_id" AND NEW."schedule_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'STATUS_REPORT_IMMUTABLE: status report % read at % is never changed; store a new one', OLD."id", OLD."as_of" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
