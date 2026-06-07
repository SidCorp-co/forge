-- Integrations: Connection / Binding model (docs/integrations/connection-binding.md).
--
-- ADDITIVE foundation. Splits the credential (connection, owned by a generic
-- principal) from the per-project+env link (binding). project_integrations is
-- KEPT and every current read/dispatch path keeps using it until the REST
-- cutover issue flips reads to bindings — so this migration cannot break a live
-- deploy. Backfill is 1:1 and idempotent (reuses pi.id as both connection.id and
-- binding.id, so deliveries.binding_id := project_integration_id is trivial).
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta snapshot
-- collision (see 0099-0100 headers). The runtime migrator applies this row from
-- _journal.json.

CREATE TABLE IF NOT EXISTS "integration_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_type" text NOT NULL DEFAULT 'user',
  "owner_id" uuid NOT NULL,
  "provider" text NOT NULL,
  "display_name" text,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secrets_enc" bytea,
  "oauth_installation_id" text,
  "active" boolean NOT NULL DEFAULT true,
  "breaker_opened_at" timestamptz,
  "last_health_status" text,
  "last_health_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_connections_owner_type_chk" CHECK ("owner_type" IN ('user', 'org'))
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_bindings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "connection_id" uuid NOT NULL REFERENCES "integration_connections"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "environment" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "integration_secret" text,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "integration_bindings_environment_chk" CHECK ("environment" IN ('staging', 'prod'))
);
--> statement-breakpoint

ALTER TABLE "integration_deliveries" ADD COLUMN IF NOT EXISTS "binding_id" uuid;
--> statement-breakpoint

DO $$ BEGIN
  ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_binding_id_fk"
    FOREIGN KEY ("binding_id") REFERENCES "integration_bindings"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_connections_owner_provider_idx"
  ON "integration_connections" ("owner_type", "owner_id", "provider");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_connections_active_provider_idx"
  ON "integration_connections" ("provider", "active")
  WHERE "active" = true;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_bindings_connection_idx"
  ON "integration_bindings" ("connection_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_bindings_project_provider_idx"
  ON "integration_bindings" ("project_id", "provider");
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "integration_bindings_project_provider_env_uq"
  ON "integration_bindings" ("project_id", "provider", "environment");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_deliveries_binding_created_idx"
  ON "integration_deliveries" ("binding_id", "created_at" DESC);
--> statement-breakpoint

-- Backfill 1:1 from project_integrations. connection.id = binding.id = pi.id so
-- the mapping is trivial and the whole block is re-runnable.
INSERT INTO "integration_connections"
  (id, owner_type, owner_id, provider, config, secrets_enc, active,
   breaker_opened_at, last_health_status, last_health_at, created_at, updated_at)
SELECT pi.id, 'user', p.owner_id, pi.provider, pi.config, pi.secrets_enc, pi.active,
   pi.breaker_opened_at, pi.last_health_status, pi.last_health_at, pi.created_at, pi.updated_at
FROM "project_integrations" pi
JOIN "projects" p ON p.id = pi.project_id
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

INSERT INTO "integration_bindings"
  (id, connection_id, project_id, provider, environment, config, integration_secret, active,
   created_at, updated_at)
SELECT pi.id, pi.id, pi.project_id, pi.provider, pi.environment, pi.config, pi.integration_secret,
   pi.active, pi.created_at, pi.updated_at
FROM "project_integrations" pi
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint

UPDATE "integration_deliveries"
SET binding_id = project_integration_id
WHERE binding_id IS NULL;
