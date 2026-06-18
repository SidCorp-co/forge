-- Unified notification system (ISS-510) — explicit severity + auto-resolve.
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0120, 0125).
--
-- notifications.severity      — contract severity ('info'|'success'|'warning'|
--                               'error'); drives toast tone + bell hue. Nullable:
--                               legacy rows predate it.
-- notifications.resolution_key — stable per-condition key (e.g.
--                               'issue:<id>:status') so a later resolver can
--                               auto-clear the matching unread rows.
-- notifications.resolved_at    — set when auto-resolve marks the row read.
-- All additive + idempotent.

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "severity" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolution_key" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "resolved_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_resolution_key_read_idx" ON "notifications" ("resolution_key","read");
