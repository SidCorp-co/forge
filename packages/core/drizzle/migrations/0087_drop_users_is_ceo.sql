-- Remove the global cross-tenant super-admin flag.
--
-- `users.is_ceo` granted a user the ability to see every project across all
-- tenants and to call the system-wide `forge_admin_*` / cross-project metrics
-- MCP tools. The permission model is now strictly owner/member: every user is
-- owner of their own projects (full access in their scope), invited members
-- are scoped to the projects they belong to, and the formerly system-admin
-- tools are bounded to the caller's visible projects. There is no replacement
-- flag.
--
-- The column was never written by application code (set out-of-band via SQL),
-- so there is nothing to migrate — the application no longer selects it.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0082_runners_repo_path / 0083_device_skills /
-- 0084_skill_override_fork headers). The runtime migrator applies this row
-- from _journal.json. Apply only after the code that stops selecting
-- `is_ceo` is deployed.

ALTER TABLE "users" DROP COLUMN IF EXISTS "is_ceo";
