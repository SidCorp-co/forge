-- The `host='remote'` lane and the `antigravity` runner type are gone: the
-- adapter, its HMAC callback, the skills-zip capability URL and the event
-- normaliser were deleted 2026-09-04. What survives in these columns is a
-- constant, and a constant column is a second copy of a fact the code holds.
--
-- Measured on forge-beta before this was written: 65 runner rows, every one
-- host='device' / type='claude-code', ZERO with a NULL device_id — so the
-- NOT NULL below tightens a column already total there. This DELETE is for the
-- deployments that are not forge-beta: without it `SET NOT NULL` aborts the
-- whole migration on the first remote runner row, and the container then
-- serves new code against the old schema. A binding to no device cannot
-- dispatch now that the adapter is gone, so removing it is the honest cleanup.
DELETE FROM "runners" WHERE "host" = 'remote' OR "device_id" IS NULL;
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
