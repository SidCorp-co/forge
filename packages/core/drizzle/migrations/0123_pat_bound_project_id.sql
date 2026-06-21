-- Project-scoped MCP tokens — bound_project_id (ISS-497).
-- Hand-written migration (applied from meta/_journal.json; drizzle-kit generate
-- is blocked by the pre-existing meta snapshot collision, see 0121, 0120, 0116).
--
-- personal_access_tokens.bound_project_id — NULL = user-level token (today's
-- behavior, zero backfill); set = project-level token bound to exactly this
-- project (the slug-omitted default AND an auth fence). FK ON DELETE CASCADE so
-- deleting a project drops the tokens bound to it. Additive + idempotent; every
-- pre-existing row stays NULL (user-level).

ALTER TABLE "personal_access_tokens" ADD COLUMN IF NOT EXISTS "bound_project_id" uuid;

DO $$ BEGIN
	ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_bound_project_id_projects_id_fk"
		FOREIGN KEY ("bound_project_id") REFERENCES "projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
