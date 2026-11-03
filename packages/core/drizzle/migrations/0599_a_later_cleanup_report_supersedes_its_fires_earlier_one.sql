-- A later cleanup report from the same schedule fire supersedes its earlier one (ISS-912): the earlier
-- is kept and names the report standing in its place, and nothing that decides (the list, the landing
-- rule's `lastReport`, green coverage) reads it again.
--   cleanup_reports.superseded_by   the later report from the same fire; null while this one is current.
-- Reports already filed are read the same way: each one a fire filed is superseded by the next it filed,
-- so fire e23d2b1f's report 571cd8d7 (a sha naming no commit) reads superseded by f74d6fcc.
--
-- ROLLBACK: ALTER TABLE "cleanup_reports" DROP CONSTRAINT IF EXISTS "cleanup_reports_superseded_chk";
-- ALTER TABLE "cleanup_reports" DROP COLUMN IF EXISTS "superseded_by";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "cleanup_reports" ADD COLUMN IF NOT EXISTS "superseded_by" uuid REFERENCES "cleanup_reports"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "cleanup_reports" DROP CONSTRAINT IF EXISTS "cleanup_reports_superseded_chk";--> statement-breakpoint
ALTER TABLE "cleanup_reports" ADD CONSTRAINT "cleanup_reports_superseded_chk" CHECK ("cleanup_reports"."superseded_by" <> "cleanup_reports"."id");--> statement-breakpoint
UPDATE "cleanup_reports" r
   SET "superseded_by" = n."next_id"
  FROM (
    SELECT "id", lead("id") OVER (PARTITION BY "schedule_run_id" ORDER BY "created_at", "id") AS "next_id"
      FROM "cleanup_reports"
     WHERE "schedule_run_id" IS NOT NULL
  ) n
 WHERE r."id" = n."id" AND n."next_id" IS NOT NULL AND r."superseded_by" IS NULL;
