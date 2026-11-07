-- ISS-1104 — core records the forge-plugin version a caller names in `x-forge-plugin`, and when it
-- last heard it, on the row its request authenticated as: the paired box a box token belongs to,
-- else the personal access token itself. Both start empty: no caller has named a version yet.
--
-- ROLLBACK: ALTER TABLE "devices" DROP COLUMN IF EXISTS "plugin_version", DROP COLUMN IF EXISTS "plugin_seen_at";
--           ALTER TABLE "personal_access_tokens" DROP COLUMN IF EXISTS "plugin_version", DROP COLUMN IF EXISTS "plugin_seen_at";

ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "plugin_version" text;
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "plugin_seen_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "plugin_version" text;
--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "plugin_seen_at" timestamp with time zone;
