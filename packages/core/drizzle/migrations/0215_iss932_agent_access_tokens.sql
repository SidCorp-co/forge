-- ISS-932 — a paired box no longer holds a device-shaped credential. Its token
-- is an ordinary `personal_access_tokens` row carrying `device_id`.
--
-- A non-revoked device whose only credential is `token_hash` is a row this
-- schema CANNOT represent: it is a box that believes it is paired and, after
-- these DROPs, is not. `token_hash` is argon2 over a plaintext core never had,
-- so no backfill can mint the replacement — the box must re-run `forge login`.
-- Dropping the columns under it would take the fleet dark at deploy time with
-- nothing saying so, so this aborts and NAMES the rows instead.
--
-- Forward path, either one, then re-run the migration:
--   * retire the box:  UPDATE devices SET status = 'revoked' WHERE id = '<id>';
--   * keep it:         acknowledge the re-pair it now owes with
--                      UPDATE devices SET token_hash = '' WHERE id = '<id>';
--                      then run `forge login` on that machine after the deploy.
DO $$
DECLARE
  stranded text;
  n integer;
BEGIN
  SELECT count(*), string_agg(format('%s (%s, owner %s)', id, name, owner_id), E'\n  ')
    INTO n, stranded
    FROM devices
   WHERE status <> 'revoked' AND token_hash <> '';

  IF n > 0 THEN
    RAISE EXCEPTION
      'ISS-932: % paired device(s) still hold a device token this migration would delete without a replacement. Re-pair or revoke each, then re-run. Rows: %',
      n, stranded;
  END IF;
END $$;--> statement-breakpoint
DROP INDEX "devices_token_prefix_idx";--> statement-breakpoint
ALTER TABLE "device_login_codes" ADD COLUMN "agent_user_id" uuid;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "kind" text DEFAULT 'human' NOT NULL;--> statement-breakpoint
ALTER TABLE "device_login_codes" ADD CONSTRAINT "device_login_codes_agent_user_id_users_id_fk" FOREIGN KEY ("agent_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pat_device_id_idx" ON "personal_access_tokens" USING btree ("device_id");--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "token_hash";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "token_prefix";