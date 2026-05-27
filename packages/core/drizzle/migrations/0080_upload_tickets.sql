-- Short-lived, single-use capability tickets for out-of-band attachment uploads
-- (the presigned-URL pattern). `forge_uploads` mints a row; the holder PUTs file
-- bytes to /api/uploads/:id with NO bearer token — possession of the unguessable
-- id, not-yet-expired, not-yet-consumed IS the authorization. All upload params
-- live server-side here so the capability URL cannot be tampered with.
--
-- Hand-written (drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision at 0024/0030 + 0027/0029); the runtime migrator applies this from
-- _journal.json regardless.

CREATE TABLE IF NOT EXISTS "upload_tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "uploader_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "uploader_device_id" uuid REFERENCES "devices"("id") ON DELETE SET NULL,
  "name" text NOT NULL,
  "mime" text NOT NULL,
  "max_bytes" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_tickets_target_idx" ON "upload_tickets" ("target_type","target_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "upload_tickets_expires_at_idx" ON "upload_tickets" ("expires_at");
