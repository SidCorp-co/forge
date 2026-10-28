-- A plan says when it was last written (ISS-642, REQ-2 BC-4): where gate plan_approval is enforced,
-- the work reaches build only once the issue passed `approved` after its plan's last write
-- (issue-lifecycle, the back edge design-check -> in_progress), so that write needs a time of its own.
--   issues.plan_written_at   stamped by the trigger on every write that changes `plan`, by any
--                            writer; NULL while the issue has never held a plan. Nothing else
--                            writes it: an update naming the column alone keeps the stamp it had.
-- Backfill, before the trigger exists: the newest `issue.updated` activity row naming `plan` among
-- its fields, else the issue's own created_at (a plan written at the create, or before the activity
-- log recorded field changes). The fallback is the earliest the plan can have been written, so an
-- issue that passed approved at any point after its create reads as having passed it since.
--
-- ROLLBACK: DROP TRIGGER issues_plan_written_at_trg ON issues; DROP FUNCTION issue_plan_written_at();
-- ALTER TABLE issues DROP COLUMN plan_written_at. The build-step gate then has no plan time to read.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN IF NOT EXISTS "plan_written_at" timestamp with time zone;--> statement-breakpoint
DROP TRIGGER IF EXISTS issues_plan_written_at_trg ON "issues";--> statement-breakpoint
UPDATE "issues" i
   SET "plan_written_at" = COALESCE(
         (SELECT max(a."created_at") FROM "activity_log" a
           WHERE a."issue_id" = i."id"
             AND a."action" = 'issue.updated'
             AND a."payload" -> 'fields' ? 'plan'),
         i."created_at")
 WHERE i."plan" IS NOT NULL AND i."plan_written_at" IS NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION issue_plan_written_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.plan_written_at := CASE WHEN NEW.plan IS NULL THEN NULL ELSE now() END;
  ELSIF NEW.plan IS DISTINCT FROM OLD.plan THEN
    NEW.plan_written_at := now();
  ELSE
    NEW.plan_written_at := OLD.plan_written_at;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER issues_plan_written_at_trg BEFORE INSERT OR UPDATE OF "plan", "plan_written_at" ON "issues" FOR EACH ROW EXECUTE FUNCTION issue_plan_written_at();
