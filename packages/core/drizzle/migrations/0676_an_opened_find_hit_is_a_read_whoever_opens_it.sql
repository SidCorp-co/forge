-- ISS-1256 c4 (live judge on 0.4.0-dev.701). Opening a find hit is a read the module map counts,
-- whoever opens it: a person through Cmd-K, or an agent whose credential names no single run. Until
-- now a read was kept only against a run session, so both were recorded nowhere and a tree's Reads
-- stayed 0 after five opens.
--   1. run_context_reaches.agent_session_id drops NOT NULL: a row with no session is an open made
--      outside any run.
--   2. run_context_reaches.user_id, new and nullable: the account that read (the person, or the
--      credential's holder), kept on every row where the request named one.
--   3. run_context_reaches_reader_chk: a row with no session is an open (`how` get) for no issue, so
--      no prompt or search ever reads as a run's without its run.
-- No existing row is changed; every one holds a session and passes the new CHECK.
--
-- ROLLBACK (rows with no session must be deleted first):
--   DELETE FROM "run_context_reaches" WHERE "agent_session_id" IS NULL;
--   ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_reader_chk";
--   ALTER TABLE "run_context_reaches" DROP COLUMN IF EXISTS "user_id";
--   ALTER TABLE "run_context_reaches" ALTER COLUMN "agent_session_id" SET NOT NULL;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "run_context_reaches" ALTER COLUMN "agent_session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD COLUMN IF NOT EXISTS "user_id" uuid;--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE set null;--> statement-breakpoint
ALTER TABLE "run_context_reaches" DROP CONSTRAINT IF EXISTS "run_context_reaches_reader_chk";--> statement-breakpoint
ALTER TABLE "run_context_reaches" ADD CONSTRAINT "run_context_reaches_reader_chk" CHECK ("run_context_reaches"."agent_session_id" IS NOT NULL OR ("run_context_reaches"."how" = 'get' AND "run_context_reaches"."issue_id" IS NULL));
