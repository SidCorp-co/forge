-- ISS-1348 (owner, 2026-11-19). A room agent asks a person for a secret through one door: the slot it
-- names (a variable at one environment, a testing profile's credential, an integration's credential),
-- the thread that asked and the link that opens that one field. Where it asked for a one-time write
-- URL, the token's SHA-256 (never the token), when it expires and when and from where it was used. A
-- value saved through either door fills the asks waiting on its slot, by fingerprint alone, and their
-- threads hear so, through the new outbox event `secret.slotFilled`. No value is ever kept here.
--
-- ROLLBACK: DROP TABLE IF EXISTS "support_secret_asks";
--   DELETE FROM "outbox_event_types" WHERE "type" = 'secret.slotFilled' (only while no row carries it).

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "support_secret_asks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE cascade,
	"room_id" uuid NOT NULL REFERENCES "support_rooms"("id") ON DELETE cascade,
	"thread" text NOT NULL,
	"kind" text NOT NULL,
	"slot" jsonb NOT NULL,
	"slot_key" text NOT NULL,
	"link" text NOT NULL,
	"write_hash" text,
	"write_expires_at" timestamp with time zone,
	"write_used_at" timestamp with time zone,
	"write_used_from" text,
	"filled_at" timestamp with time zone,
	"filled_fingerprint" text,
	"filled_via" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_secret_asks_kind_chk" CHECK ("kind" IN ('variable', 'testing', 'integration')),
	CONSTRAINT "support_secret_asks_via_chk" CHECK ("filled_via" IS NULL OR "filled_via" IN ('page', 'presigned')),
	CONSTRAINT "support_secret_asks_write_chk" CHECK (("write_hash" IS NULL) = ("write_expires_at" IS NULL))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "support_secret_asks_write_uq" ON "support_secret_asks" ("write_hash") WHERE write_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_secret_asks_open_idx" ON "support_secret_asks" ("slot_key", "created_at") WHERE filled_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "support_secret_asks_thread_idx" ON "support_secret_asks" ("room_id", "thread", "created_at");--> statement-breakpoint
INSERT INTO "outbox_event_types" ("type") VALUES ('secret.slotFilled') ON CONFLICT DO NOTHING;
