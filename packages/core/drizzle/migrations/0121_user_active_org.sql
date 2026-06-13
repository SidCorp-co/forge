-- Active-org preference for the global org switcher (ISS-469).
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0120, 0116).
--
-- user_preferences.active_org_id — the org the user is currently "working in".
-- Nullable: null means no explicit choice yet (client resolves to the personal
-- org). FK ON DELETE SET NULL so deleting an org clears the pointer instead of
-- blocking the delete or leaving it dangling. Additive + idempotent.

ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "active_org_id" uuid;

DO $$ BEGIN
	ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_active_org_id_organizations_id_fk"
		FOREIGN KEY ("active_org_id") REFERENCES "organizations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
