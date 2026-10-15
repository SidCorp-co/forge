-- One GitHub App serves the whole instance, and an installation of it is recorded only once it is
-- proven. A connection owned by the instance is a third owner namespace beside a person and an org:
-- its owner id is the nil uuid, at most one active one exists per provider, and only a platform
-- admin manages it. An installation is a row of `github_app_installations`, recorded for the Forge
-- org whose admin installed it, proven by GitHub's own OAuth answer (`oauth`) or carried from a
-- binding that held it before this table existed (`bound_before`). GitHub's `installation` webhook
-- moves its state; a removed one is `gone` and its bindings read degraded, never deleted.
--
-- The owner-type CHECK is rebuilt to admit 'instance'; 0101 wrote it with 'user' and 'org'.
--
-- ROLLBACK: drop the table, the two instance constraints and the index, and rebuild the owner-type
-- CHECK with 'user' and 'org' once no row is owned by the instance.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT IF EXISTS "integration_connections_owner_type_chk";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_owner_type_chk" CHECK ("owner_type" IN ('user', 'org', 'instance'));--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT IF EXISTS "integration_connections_instance_owner_chk";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_instance_owner_chk" CHECK ("owner_type" <> 'instance' OR "owner_id" = '00000000-0000-0000-0000-000000000000');--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integration_connections_one_instance_provider_uq" ON "integration_connections" ("provider") WHERE "owner_type" = 'instance' AND "active" = true;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_app_installations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "connection_id" uuid NOT NULL REFERENCES "integration_connections"("id") ON DELETE CASCADE,
  "installation_id" bigint NOT NULL,
  "account_login" text NOT NULL,
  "account_type" text NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "recorded_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "proof" text NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "state_changed_at" timestamp with time zone,
  "removed_repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "github_app_installations_account_type_chk" CHECK ("account_type" IN ('User', 'Organization', 'Enterprise')),
  CONSTRAINT "github_app_installations_proof_chk" CHECK ("proof" IN ('oauth', 'bound_before')),
  CONSTRAINT "github_app_installations_state_chk" CHECK ("state" IN ('active', 'suspended', 'gone'))
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_app_installations_connection_installation_uq" ON "github_app_installations" ("connection_id", "installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_app_installations_org_idx" ON "github_app_installations" ("org_id");
