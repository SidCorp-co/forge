-- ISS-410 (epic ISS-404, F5) — DESTRUCTIVE / IRREVERSIBLE final integrations
-- cleanup. Applied LAST, only after F1–F4 are terminal and live-verified, so the
-- reversible legacy state survives until all additive work is confirmed.
--
-- The ISS-399 cutover repointed every dispatch/read/REST path onto the
-- connection/binding model; integration_deliveries.project_integration_id has
-- been NULL-tolerant (0102) and unread since. Now retire it for good:
--   1. DROP COLUMN integration_deliveries.project_integration_id — Postgres
--      auto-drops the 3 dependent objects (the integration_created /
--      integration_status_created indexes and the legacy
--      integration_deliveries_request_id_uq partial unique) plus the FK to
--      project_integrations. The post-cutover idempotency guard
--      integration_deliveries_binding_request_id_uq (created in 0102) is on
--      binding_id and is untouched.
--   2. DROP TABLE project_integrations — once the column/FK above is gone
--      nothing references it; this also drops its own indexes.
--
-- Clean break (jarvis-agents style): dropped WITHOUT reconciliation. Hand-written
-- because drizzle-kit generate is blocked by a pre-existing meta-snapshot
-- collision (see 0084–0102 headers); the runtime migrator applies this row from
-- _journal.json.

ALTER TABLE "integration_deliveries" DROP COLUMN IF EXISTS "project_integration_id";
--> statement-breakpoint
DROP TABLE IF EXISTS "project_integrations";
