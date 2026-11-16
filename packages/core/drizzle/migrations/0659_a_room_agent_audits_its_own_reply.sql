-- ISS-1250 (owner, 2026-11-16): a room agent audits its own reply right after posting it, with
-- support.audit, against one rubric. One new table; no row standing today is changed.
--   1. support_reply_verdicts: one verdict per audited reply (by its chat message id in its room), the
--      rubric lines it failed with who found each (the agent or code), the bot (the Rocket.Chat
--      connection) and the room's kind, and the room correction a failed one became in the lessons
--      store (corrections, REQ-50). A reply with no row was never audited.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS support_reply_verdicts;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_reply_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "project_id" uuid NOT NULL,
  "room_id" uuid NOT NULL,
  "room_kind" text NOT NULL,
  "bot" uuid NOT NULL,
  "conversation_id" uuid,
  "thread" text NOT NULL,
  "message" text NOT NULL,
  "verdict" text NOT NULL,
  "failed" text[] DEFAULT '{}'::text[] NOT NULL,
  "findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "correction_id" uuid,
  "audited_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "support_reply_verdicts_room_kind_chk" CHECK ("room_kind" IN ('support', 'operations', 'agent')),
  CONSTRAINT "support_reply_verdicts_verdict_chk" CHECK ("verdict" IN ('pass', 'fail') AND ("verdict" = 'fail') = (cardinality("failed") > 0))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_project_id_projects_id_fk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_room_id_support_rooms_id_fk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_room_id_support_rooms_id_fk"
      FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_conversation_id_conversations_id_fk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_conversation_id_conversations_id_fk"
      FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_reply_verdicts_correction_id_corrections_id_fk') THEN
    ALTER TABLE "support_reply_verdicts" ADD CONSTRAINT "support_reply_verdicts_correction_id_corrections_id_fk"
      FOREIGN KEY ("correction_id") REFERENCES "public"."corrections"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_reply_verdicts_message_uq" ON "support_reply_verdicts" USING btree ("room_id", "message");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_reply_verdicts_project_idx" ON "support_reply_verdicts" USING btree ("project_id", "audited_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_reply_verdicts_bot_idx" ON "support_reply_verdicts" USING btree ("bot", "audited_at");
