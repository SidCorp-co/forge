-- ISS-305 — Runner browser-approve device-login (OAuth device-authorization
-- flow, cf. `claude login`) + auto git-credential provisioning.
--
--   * `device_login_codes` — short Crockford code minted by `forge-runner
--     login`, approved in a signed-in browser at `/pair?code=XXX`, polled by
--     the runner to receive a *device token* (not a user JWT). Mirrors the
--     `desktop_pairing_codes` shape so the two device-grant flows stay
--     auditable side-by-side.
--   * `devices.git_credential_ref` — non-secret label recording that a git push
--     credential was auto-provisioned for the device at login (e.g.
--     'https:github.com'); NULL means none. The secret material is returned
--     once at poll time and never stored here.
--
-- Numbered 0086 to leave 0085 for the in-flight `drop_users_is_ceo` migration
-- on another branch (see worktree-mode migration-collision note). Hand-written;
-- drizzle-kit generate is blocked by a pre-existing meta snapshot collision
-- (0024/0030, 0027/0029). The runtime migrator applies this row from
-- _journal.json.

CREATE TABLE IF NOT EXISTS "device_login_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code_hash" text NOT NULL,
	"device_label" text NOT NULL,
	"device_platform" text NOT NULL,
	"device_hostname" text,
	"created_ip" text,
	"created_user_agent" text,
	"approved_user_id" uuid,
	"approved_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_login_codes_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_login_codes" ADD CONSTRAINT "device_login_codes_approved_user_id_users_id_fk" FOREIGN KEY ("approved_user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_login_codes_expires_idx" ON "device_login_codes" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_login_codes_consumed_idx" ON "device_login_codes" ("consumed_at");--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "git_credential_ref" text;
