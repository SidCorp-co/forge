-- An alert says when its level last changed (REQ-22 BC-1). The operator console showed each alert's
-- level and the age of its oldest contributor, but not when the alert crossed into warn or crit, or
-- from warn into crit, so an operator could not tell a fresh crit from one hours old. An ops alert's
-- notification now keeps the moment its level was last set: on the crossing out of ok, and again on
-- an escalation; its resolution keeps the moment it went back to ok.
--
-- Backfill: an open ops alert's level is taken as set when it was created, the only moment its row
-- recorded. An escalation before this migration is not recoverable and reads as the crossing.
--
-- ROLLBACK: drop the column; the console then shows no change time.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "level_changed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "notifications" SET "level_changed_at" = "created_at" WHERE "type" = 'ops_alert' AND "level_changed_at" IS NULL;
