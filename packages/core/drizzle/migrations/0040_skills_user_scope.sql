-- ISS-2A: forward-compat for Phase 2 user-scope skills.
--
-- Adds nullable `user_id` FK + a CHECK constraint that pins each row to
-- exactly one of the three scopes:
--   - global  → project_id NULL, user_id NULL
--   - project → project_id NOT NULL, user_id NULL
--   - user    → project_id NULL,    user_id NOT NULL
--
-- The `skillScopes` enum stays at ['global', 'project'] in app code today;
-- adding 'user' later is a code-only change because the constraint already
-- accepts that case.
--
-- Reversible: DROP CONSTRAINT, DROP COLUMN. No data migration since user_id
-- is nullable.

ALTER TABLE "skills"
  ADD COLUMN "user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "skills"
  ADD CONSTRAINT "skills_scope_check" CHECK (
    (scope = 'global'  AND project_id IS NULL AND user_id IS NULL) OR
    (scope = 'project' AND project_id IS NOT NULL AND user_id IS NULL) OR
    (scope = 'user'    AND project_id IS NULL AND user_id IS NOT NULL)
  );
--> statement-breakpoint

CREATE INDEX "skills_user_id_idx" ON "skills" USING btree ("user_id");
