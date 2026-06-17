-- Agent-chat ("My conversations") file attachments (ISS-499).
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0123, 0121, 0120).
--
-- session_attachments — files a user attaches to an interactive chat turn.
-- Mirrors comment_attachments (user notNull, device nullable audit shape).
-- FK -> agent_sessions ON DELETE CASCADE so deleting a session drops its files.
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS "session_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"uploader_id" uuid NOT NULL,
	"uploader_device_id" uuid,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
	ALTER TABLE "session_attachments" ADD CONSTRAINT "session_attachments_session_id_agent_sessions_id_fk"
		FOREIGN KEY ("session_id") REFERENCES "agent_sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "session_attachments" ADD CONSTRAINT "session_attachments_uploader_id_users_id_fk"
		FOREIGN KEY ("uploader_id") REFERENCES "users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
	ALTER TABLE "session_attachments" ADD CONSTRAINT "session_attachments_uploader_device_id_devices_id_fk"
		FOREIGN KEY ("uploader_device_id") REFERENCES "devices"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE INDEX IF NOT EXISTS "session_attachments_session_id_idx" ON "session_attachments" ("session_id");
CREATE INDEX IF NOT EXISTS "session_attachments_uploader_device_id_idx" ON "session_attachments" ("uploader_device_id");
