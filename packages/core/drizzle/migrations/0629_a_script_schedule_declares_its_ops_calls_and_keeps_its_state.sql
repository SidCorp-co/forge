-- A script schedule reads its project's production through declared read-only calls and files
-- deduplicated feedback on a breach confirmed twice (REQ-87, ISS-1125).
--
-- `schedules.ops`: the calls a script schedule declares on its project's forge-ops target, checked
-- read-only on every save and again before every firing (`schedules/script-ops.ts`).
-- `schedules.script_state`: the small JSON object a script keeps between firings (ctx.state), at most
-- 16 KiB; written only by a firing that succeeded.
-- `schedule_runs.ops_calls`, `filings`, `state_after`: what a firing called (name and outcome), what it
-- filed or joined, and the state it left where it changed it (null where it did not).
--
-- ROLLBACK: ALTER TABLE schedule_runs DROP CONSTRAINT IF EXISTS schedule_runs_script_record_chk; ALTER TABLE schedule_runs DROP COLUMN IF EXISTS ops_calls, DROP COLUMN IF EXISTS filings, DROP COLUMN IF EXISTS state_after; ALTER TABLE schedules DROP CONSTRAINT IF EXISTS schedules_script_doors_chk; ALTER TABLE schedules DROP COLUMN IF EXISTS ops, DROP COLUMN IF EXISTS script_state;
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "ops" jsonb;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "script_state" jsonb;
--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_script_doors_chk" CHECK (("ops" IS NULL OR ("kind" = 'script' AND jsonb_typeof("ops") = 'object')) AND ("script_state" IS NULL OR ("kind" = 'script' AND jsonb_typeof("script_state") = 'object' AND octet_length("script_state"::text) <= 16384)));
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "ops_calls" jsonb;
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "filings" jsonb;
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD COLUMN IF NOT EXISTS "state_after" jsonb;
--> statement-breakpoint
ALTER TABLE "schedule_runs" ADD CONSTRAINT "schedule_runs_script_record_chk" CHECK (("ops_calls" IS NULL OR jsonb_typeof("ops_calls") = 'array') AND ("filings" IS NULL OR jsonb_typeof("filings") = 'array') AND ("state_after" IS NULL OR jsonb_typeof("state_after") = 'object'));
