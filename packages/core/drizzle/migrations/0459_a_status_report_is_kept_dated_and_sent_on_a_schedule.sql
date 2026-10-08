-- A project's status report is kept as dated history and sent on a schedule. `status_reports` holds
-- each stored read, immutable but for its producer references going null with their rows; one row per
-- (schedule, period) is what makes a period's delivery idempotent. A `status_report` schedule reads its
-- cron in `schedules.time_zone`, and each recipient's notice links to the report it carries through
-- `notifications.status_report_id`. The schedule kind and the notification type are vocabularies with
-- no CHECK in the database (`SCHEDULE_KINDS`, `NOTIFICATION_TYPES`), so neither needs a statement here.
--
-- ROLLBACK: ALTER TABLE notifications DROP COLUMN status_report_id; ALTER TABLE schedules DROP COLUMN
-- time_zone; DROP TABLE status_reports; DROP FUNCTION status_report_guard().
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "status_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"producer_kind" text NOT NULL,
	"produced_by" uuid,
	"schedule_id" uuid,
	"period" timestamp with time zone,
	"as_of" timestamp with time zone NOT NULL,
	"days" integer NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_reports_producer_chk" CHECK ("status_reports"."producer_kind" IN ('person', 'schedule') AND ("status_reports"."producer_kind" = 'schedule') = ("status_reports"."period" IS NOT NULL)),
	CONSTRAINT "status_reports_days_chk" CHECK ("status_reports"."days" BETWEEN 1 AND 90),
	CONSTRAINT "status_reports_report_chk" CHECK (jsonb_typeof("status_reports"."report") = 'object')
);
--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_produced_by_users_id_fk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_produced_by_users_id_fk" FOREIGN KEY ("produced_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_reports" DROP CONSTRAINT IF EXISTS "status_reports_schedule_id_schedules_id_fk";--> statement-breakpoint
ALTER TABLE "status_reports" ADD CONSTRAINT "status_reports_schedule_id_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "status_reports_project_as_of_idx" ON "status_reports" USING btree ("project_id","as_of");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "status_reports_schedule_period_uq" ON "status_reports" USING btree ("schedule_id","period") WHERE schedule_id IS NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "status_report_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."project_id" IS DISTINCT FROM OLD."project_id"
     OR NEW."producer_kind" IS DISTINCT FROM OLD."producer_kind"
     OR NEW."period" IS DISTINCT FROM OLD."period"
     OR NEW."as_of" IS DISTINCT FROM OLD."as_of"
     OR NEW."days" IS DISTINCT FROM OLD."days"
     OR NEW."report" IS DISTINCT FROM OLD."report"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (NEW."produced_by" IS DISTINCT FROM OLD."produced_by" AND NEW."produced_by" IS NOT NULL)
     OR (NEW."schedule_id" IS DISTINCT FROM OLD."schedule_id" AND NEW."schedule_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'STATUS_REPORT_IMMUTABLE: status report % read at % is never changed; store a new one', OLD."id", OLD."as_of" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "status_reports_guard" ON "status_reports";--> statement-breakpoint
CREATE TRIGGER "status_reports_guard" BEFORE UPDATE ON "status_reports" FOR EACH ROW EXECUTE FUNCTION "status_report_guard"();--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "time_zone" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "status_report_id" uuid;--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_status_report_id_status_reports_id_fk";--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_status_report_id_status_reports_id_fk" FOREIGN KEY ("status_report_id") REFERENCES "public"."status_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_status_report_idx" ON "notifications" USING btree ("status_report_id") WHERE status_report_id IS NOT NULL;
