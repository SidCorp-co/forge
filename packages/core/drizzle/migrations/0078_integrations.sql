-- ISS-234 — Integration Framework foundation (Layer 1+2). Two tables back the
-- generic per-project, per-environment integration model that the Coolify
-- adapter (and future Sentry / Human-Task adapters) plug into.
--
-- project_integrations holds one row per (project, provider, environment).
-- secrets_enc is the AES-256-GCM ciphertext produced by src/integrations/vault.ts
-- (format <iv:12><tag:16><ciphertext>). integration_secret is the HMAC key the
-- inbound webhook router uses to verify provider callbacks; kept separate from
-- the legacy projects.webhookSecret so adapters get scoped credentials.
--
-- integration_deliveries is the audit log + dedup table for every outbound
-- dispatch and inbound webhook handled by an adapter. The circuit-breaker
-- scans recent rows (status='failed' within 5 minutes) to decide whether to
-- flip the parent project_integrations.active flag to false.

CREATE TABLE IF NOT EXISTS "project_integrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "provider" text NOT NULL,
  "environment" text NOT NULL,
  "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "secrets_enc" bytea,
  "integration_secret" text,
  "active" boolean NOT NULL DEFAULT true,
  "breaker_opened_at" timestamptz,
  "last_health_status" text,
  "last_health_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "project_integrations_environment_chk" CHECK ("environment" IN ('staging', 'prod')),
  CONSTRAINT "project_integrations_project_provider_env_uq" UNIQUE ("project_id", "provider", "environment")
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "project_integrations_project_provider_idx"
  ON "project_integrations" ("project_id", "provider");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "project_integrations_active_provider_idx"
  ON "project_integrations" ("provider", "active")
  WHERE "active" = true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "integration_deliveries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_integration_id" uuid NOT NULL REFERENCES "project_integrations"("id") ON DELETE CASCADE,
  "direction" text NOT NULL,
  "event_name" text NOT NULL,
  "request_id" text,
  "status" text NOT NULL DEFAULT 'pending',
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "response" jsonb,
  "error_message" text,
  "duration_ms" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "integration_deliveries_direction_chk" CHECK ("direction" IN ('outbound', 'inbound')),
  CONSTRAINT "integration_deliveries_status_chk" CHECK ("status" IN ('pending', 'ok', 'failed'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_deliveries_integration_created_idx"
  ON "integration_deliveries" ("project_integration_id", "created_at" DESC);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "integration_deliveries_integration_status_created_idx"
  ON "integration_deliveries" ("project_integration_id", "status", "created_at" DESC)
  WHERE "direction" = 'outbound';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "integration_deliveries_request_id_uq"
  ON "integration_deliveries" ("project_integration_id", "request_id")
  WHERE "request_id" IS NOT NULL;
