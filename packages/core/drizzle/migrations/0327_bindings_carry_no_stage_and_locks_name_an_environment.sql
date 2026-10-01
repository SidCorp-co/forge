-- A binding names no stage: the environment a deploy binding serves is the project document's
-- environments.<name>.deployment.binding (ISS-8). A deploy lock is keyed by that environment's
-- name, so its check takes any environment slug rather than preview|live (ISS-12). No row is
-- rewritten (design D8): a stored preview|live lock is itself a slug.

ALTER TABLE "integration_bindings" DROP CONSTRAINT "integration_bindings_role_stages_chk";--> statement-breakpoint
ALTER TABLE "deploy_locks" DROP CONSTRAINT "deploy_locks_environment_chk";--> statement-breakpoint
ALTER TABLE "integration_bindings" DROP COLUMN "stages";--> statement-breakpoint
ALTER TABLE "deploy_locks" ADD CONSTRAINT "deploy_locks_environment_chk" CHECK (environment ~ '^[a-z][a-z0-9-]{0,62}$');
