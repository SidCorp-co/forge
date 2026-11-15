-- ISS-1243 (owner, 2026-11-15), items 10, 14 and 21. Two new tables; no row standing today is changed.
--   1. chat_temporary_accounts: one per chat identity (source, namespace, external id) that wrote
--      with no Forge account, made on its first message. It is no users row: no email, password,
--      token, OAuth account or grant, so it can never sign in or act. linked_user_id and linked_at
--      are set once a link or a naming confirms the person's Forge account.
--   2. support_master_asks: a room agent's question to its project's master (or a followed
--      project's), asked in its turn, with the answer and when it came; the wait is read from them.
--   3. outbox_event_types takes `support.masterAsked`, the event an ask wakes its master by.
--
-- ROLLBACK:
--   DELETE FROM outbox_event_types WHERE type = 'support.masterAsked'; (once no outbox row holds it)
--   DROP TABLE IF EXISTS support_master_asks;
--   DROP TABLE IF EXISTS chat_temporary_accounts;

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_temporary_accounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source" text NOT NULL,
  "external_namespace" text NOT NULL,
  "external_id" text NOT NULL,
  "external_label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "linked_user_id" uuid,
  "linked_at" timestamp with time zone,
  CONSTRAINT "chat_temporary_accounts_linked_chk" CHECK ("linked_user_id" IS NULL OR "linked_at" IS NOT NULL)
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_temporary_accounts_linked_user_id_users_id_fk') THEN
    ALTER TABLE "chat_temporary_accounts" ADD CONSTRAINT "chat_temporary_accounts_linked_user_id_users_id_fk"
      FOREIGN KEY ("linked_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chat_temporary_accounts_identity_uq" ON "chat_temporary_accounts" USING btree ("source", "external_namespace", "external_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_master_asks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "room_id" uuid NOT NULL,
  "thread" text NOT NULL,
  "project_id" uuid NOT NULL,
  "session_id" uuid,
  "turn_id" uuid,
  "question" text NOT NULL,
  "asked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "answer" text,
  "answered_at" timestamp with time zone,
  "answered_by" uuid,
  CONSTRAINT "support_master_asks_answered_chk" CHECK (("answer" IS NULL) = ("answered_at" IS NULL))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_master_asks_room_id_support_rooms_id_fk') THEN
    ALTER TABLE "support_master_asks" ADD CONSTRAINT "support_master_asks_room_id_support_rooms_id_fk"
      FOREIGN KEY ("room_id") REFERENCES "public"."support_rooms"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_master_asks_project_id_projects_id_fk') THEN
    ALTER TABLE "support_master_asks" ADD CONSTRAINT "support_master_asks_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_master_asks_session_id_agent_sessions_id_fk') THEN
    ALTER TABLE "support_master_asks" ADD CONSTRAINT "support_master_asks_session_id_agent_sessions_id_fk"
      FOREIGN KEY ("session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'support_master_asks_answered_by_users_id_fk') THEN
    ALTER TABLE "support_master_asks" ADD CONSTRAINT "support_master_asks_answered_by_users_id_fk"
      FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_master_asks_open_idx" ON "support_master_asks" USING btree ("project_id", "asked_at") WHERE answered_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_master_asks_thread_idx" ON "support_master_asks" USING btree ("room_id", "thread");--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('support.masterAsked') ON CONFLICT DO NOTHING;
