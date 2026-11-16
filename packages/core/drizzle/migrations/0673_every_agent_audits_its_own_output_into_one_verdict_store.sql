-- ISS-1251 (criteria 3 and 4). A master, a run and the steward audit their own output the way a room
-- agent audits its reply, and their verdicts are kept in the one store the capabilities page already
-- counts misses from:
--   1. support_reply_verdicts.agent: who audited, 'room' for every row standing today (the default),
--      or 'master' | 'run' | 'steward'. A room's row keeps its room, bot, thread and message; any other
--      row names its output (output_kind, output_ref: an issue's uuid, or the steward's run id) and the
--      account that audited (by_user_id), one verdict per output and role.
--   2. The room columns lose NOT NULL; a check holds a room row to all of them and any other row to
--      its output, so no row stands half one and half the other.
--   3. corrections.source takes 'self_audit': a failed self-audit whose output names an item becomes
--      a correction there, as a failed room audit becomes a room correction.
-- No existing row's value changes: every standing verdict reads agent 'room' and meets the check.
--
-- ROLLBACK (only while no non-room row stands):
--   DELETE FROM corrections WHERE source = 'self_audit';
--   ALTER TABLE corrections DROP CONSTRAINT IF EXISTS corrections_source_chk;
--   ALTER TABLE corrections ADD CONSTRAINT corrections_source_chk CHECK (source IN ('mockup_returned', 'mockup_accepted', 'suggestion_rejected', 'design_returned', 'revision_returned', 'verdict_failed', 'chat', 'room', 'feedback_triaged', 'feedback_declined'));
--   DROP INDEX IF EXISTS support_reply_verdicts_output_uq;
--   ALTER TABLE support_reply_verdicts DROP CONSTRAINT IF EXISTS support_reply_verdicts_agent_chk;
--   ALTER TABLE support_reply_verdicts DROP CONSTRAINT IF EXISTS support_reply_verdicts_output_kind_chk;
--   ALTER TABLE support_reply_verdicts DROP COLUMN IF EXISTS by_user_id, DROP COLUMN IF EXISTS output_ref, DROP COLUMN IF EXISTS output_kind, DROP COLUMN IF EXISTS agent;
--   ALTER TABLE support_reply_verdicts ALTER COLUMN room_id SET NOT NULL, ALTER COLUMN room_kind SET NOT NULL, ALTER COLUMN bot SET NOT NULL, ALTER COLUMN thread SET NOT NULL, ALTER COLUMN message SET NOT NULL;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ADD COLUMN IF NOT EXISTS "agent" text DEFAULT 'room' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ADD COLUMN IF NOT EXISTS "output_kind" text;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ADD COLUMN IF NOT EXISTS "output_ref" text;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ADD COLUMN IF NOT EXISTS "by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ALTER COLUMN "room_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ALTER COLUMN "room_kind" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ALTER COLUMN "bot" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ALTER COLUMN "thread" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "support_reply_verdicts" ALTER COLUMN "message" DROP NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_by_user_id_users_id_fk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_by_user_id_users_id_fk"
      FOREIGN KEY ("by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_agent_chk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_agent_chk" CHECK (
      "agent" IN ('room', 'master', 'run', 'steward')
      AND ("agent" = 'room') = ("room_id" IS NOT NULL AND "room_kind" IS NOT NULL AND "bot" IS NOT NULL AND "thread" IS NOT NULL AND "message" IS NOT NULL)
      AND ("agent" <> 'room') = ("output_kind" IS NOT NULL AND "output_ref" IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_output_kind_chk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_output_kind_chk" CHECK (
      "output_kind" IS NULL OR "output_kind" IN ('issue', 'steward_run'));
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_reply_verdicts_output_uq" ON "support_reply_verdicts" ("project_id", "agent", "output_kind", "output_ref") WHERE output_kind IS NOT NULL;--> statement-breakpoint
ALTER TABLE "corrections" DROP CONSTRAINT IF EXISTS "corrections_source_chk";--> statement-breakpoint
ALTER TABLE "corrections" ADD CONSTRAINT "corrections_source_chk" CHECK ("source" IN ('mockup_returned', 'mockup_accepted', 'suggestion_rejected', 'design_returned', 'revision_returned', 'verdict_failed', 'chat', 'room', 'feedback_triaged', 'feedback_declined', 'self_audit'));
