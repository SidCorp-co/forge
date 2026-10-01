-- The project document replaced every one of these columns, and no runtime code reads them (ISS-16).
-- They are dropped, not migrated (design D8): `scripts/export-legacy-project-config.mjs` prints what
-- a database still holds in them before the release, read-only, and the projects are re-entered
-- through the v1 API afterwards. `projects_release_chain_ok` was the release chain's CHECK function.

ALTER TABLE "projects" DROP CONSTRAINT "projects_release_chain_chk";--> statement-breakpoint
DROP FUNCTION "projects_release_chain_ok"(jsonb);--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "release_chain";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "repo_url";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "workspace_setup";--> statement-breakpoint
ALTER TABLE "projects" DROP COLUMN "environments";
