-- Integrations cutover A (ISS-399): make integration_deliveries binding-first.
--
-- After this issue, dispatch/read/REST paths resolve via binding -> connection
-- and write deliveries keyed on binding_id. New bindings created through the
-- connection/binding CRUD have NO backing project_integrations row, so
-- project_integration_id can no longer be NOT NULL. It stays populated on the
-- historical rows backfilled by 0101 and is dropped entirely in epic issue F.
--
-- ADDITIVE + REVERSIBLE (re-add NOT NULL / drop the index). Hand-written for the
-- same meta-snapshot reason as 0101; applied from _journal.json by the runtime
-- migrator. NOT yet applied to forge-beta until the cutover is live-verified
-- (ISS-404 guard).

ALTER TABLE "integration_deliveries" ALTER COLUMN "project_integration_id" DROP NOT NULL;
--> statement-breakpoint

-- Post-cutover idempotency key, mirroring integration_deliveries_request_id_uq
-- on the legacy column: a dispatch keyed by (binding_id, request_id) is deduped
-- at the DB level so a duplicate enqueue (agent-driven + auto-subscriber) cannot
-- double-insert.
CREATE UNIQUE INDEX IF NOT EXISTS "integration_deliveries_binding_request_id_uq"
  ON "integration_deliveries" ("binding_id", "request_id")
  WHERE "request_id" IS NOT NULL;
