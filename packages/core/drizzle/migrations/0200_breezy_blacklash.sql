-- The `host='remote'` lane and the `antigravity` runner type are gone: the
-- adapter, its HMAC callback, the skills-zip capability URL and the event
-- normaliser were deleted 2026-09-04. What survives in these columns is a
-- constant, and a constant column is a second copy of a fact the code holds.
--
-- Measured on forge-beta before this was written: 65 runner rows, every one
-- host='device' / type='claude-code', ZERO with a NULL device_id.
--
-- A deployment that DOES hold such rows stops here and is told so. Deleting
-- them to make `SET NOT NULL` succeed would be the silent substitution
-- CLAUDE.md forbids: the operator would find their runners gone with no
-- record of it, at the moment they were reading a green deploy. Failing here
-- costs them one command and keeps the decision theirs.
DO $$
DECLARE offending int;
BEGIN
  SELECT count(*) INTO offending FROM "runners" WHERE "host" = 'remote' OR "device_id" IS NULL;
  IF offending > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'raise_exception',
      MESSAGE = format('migration 0200: %s runner row(s) are host=''remote'' or carry no device', offending),
      DETAIL  = 'The remote runner lane was removed, so these rows can no longer dispatch and `device_id` is about to become NOT NULL. This migration will not delete them for you.',
      HINT    = 'Review them, then run: DELETE FROM runners WHERE host = ''remote'' OR device_id IS NULL;  and re-deploy.';
  END IF;
END $$;
--> statement-breakpoint
-- The FK was created inline by `0031_iss271_runners.sql` as
-- `runners_device_id_fkey`; drizzle-kit generated a DROP for the name its own
-- convention WOULD have used, which has never existed here. Both names are
-- dropped so a database built either way lands on one FK, not two — a
-- surviving `ON DELETE SET NULL` alongside the new cascade would violate the
-- NOT NULL below the first time a device row is deleted.
ALTER TABLE "runners" DROP CONSTRAINT IF EXISTS "runners_device_id_fkey";
--> statement-breakpoint
ALTER TABLE "runners" DROP CONSTRAINT IF EXISTS "runners_device_id_devices_id_fk";
--> statement-breakpoint
DROP INDEX "runners_remote_name_uq";--> statement-breakpoint
DROP INDEX "runners_project_device_type_uq";--> statement-breakpoint
ALTER TABLE "runners" ALTER COLUMN "device_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "runners" ADD CONSTRAINT "runners_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runners_project_device_type_uq" ON "runners" USING btree ("project_id","device_id","type");--> statement-breakpoint
ALTER TABLE "runners" DROP COLUMN "host";--> statement-breakpoint
ALTER TABLE "schedules" DROP COLUMN "runner";
