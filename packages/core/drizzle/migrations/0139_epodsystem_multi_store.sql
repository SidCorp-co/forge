-- ISS-558 — multi-store support for epodsystem integration.
-- Adds a `label` column to integration_bindings (empty string = default/unlabeled).
-- Replaces the unique index UNIQUE(project_id, provider, environment) with
-- UNIQUE(project_id, provider, environment, label) so non-epodsystem providers
-- (label='') keep the one-per-env invariant while epodsystem can hold N
-- labeled bindings per env.
ALTER TABLE "integration_bindings" ADD COLUMN IF NOT EXISTS "label" text NOT NULL DEFAULT '';
DROP INDEX IF EXISTS "integration_bindings_project_provider_env_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "integration_bindings_project_provider_env_label_uq"
  ON "integration_bindings" ("project_id", "provider", "environment", "label");
