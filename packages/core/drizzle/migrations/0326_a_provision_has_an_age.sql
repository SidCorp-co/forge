-- ISS-1359 — a provision has an age, so one that stopped advancing can be read as stalled.
--
-- `runners.provision_status` was advanced only by a box's report and nothing recorded WHEN. The one
-- timestamp on the row, `updated_at`, is bumped by every heartbeat, so a row wedged at `cloning` for
-- weeks read as touched a second ago. This column is written by the three writers of
-- `provision_status` (a bind, the box's report, a terminal failure report) and by nothing else.
--
-- The backfill dates each row by the last thing the row itself says happened: a queued or in-flight
-- row by when its provision was requested, any other by when it last reached `ready`; `updated_at`
-- is the last resort, never the first. A row that stood at `cloning` before this ran therefore reads
-- stalled the moment this is applied, which is the state it was already in.
-- Rollback: revert the code and keep this migration — it is additive and old code ignores it.
ALTER TABLE "runners" ADD COLUMN "provision_status_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "runners"
   SET "provision_status_at" = CASE
         WHEN "provision_status" IN ('queued', 'cloning', 'syncing_skills', 'writing_mcp')
           THEN COALESCE("provision_requested_at", "updated_at")
         ELSE COALESCE("provisioned_at", "provision_requested_at", "updated_at")
       END
 WHERE "provision_status" IS NOT NULL;
