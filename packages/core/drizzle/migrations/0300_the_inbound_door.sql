-- ISS-1140 — the inbound door becomes a fact a binding's health answers for.
--
-- Three columns' worth of silence, all additive:
--
-- `integration_deliveries.status` gains 'refused'. A call turned away at
-- `POST /api/webhooks/in/:slug` for a missing or invalid signature is refused correctly and
-- recorded nowhere, so "GitHub never called" and "a call reached us and we turned it away" read
-- identically from inside Forge. 'refused' is a status of its own rather than 'failed', which
-- already means a delivery we accepted and then could not process — the circuit breaker counts
-- outbound rows under that name and must not start counting door refusals.
--
-- `integration_connections.last_health_detail` holds the sentence the probe produced. The health
-- sweep discards `HealthCheckResult.message` today, so an operator reading `last_health_status`
-- an hour later has the verdict and not one word of why.
--
-- `integration_connections.inbound_endpoint_observed` holds what the provider itself says about
-- where it will call in — for GitHub, `GET /app/hook/config`. It is what was OBSERVED, never a
-- verdict: the App's webhook URL carries one project slug, one connection may serve bindings in
-- several projects, and whether the observed URL is the URL a given binding needs is therefore a
-- per-binding question answered at read time against this stored observation.
--
-- Additive, statement by statement. The widened check accepts every row the narrow one did; both
-- columns are nullable with no default, so no row is rewritten and code that does not know them
-- runs unchanged. Running it backwards drops two empty-to-old-code columns and narrows the check,
-- which fails against any row already written as 'refused' — so the way back is the previous
-- image against this schema, not this migration reversed.
ALTER TABLE "integration_deliveries" DROP CONSTRAINT IF EXISTS "integration_deliveries_status_chk";--> statement-breakpoint
ALTER TABLE "integration_deliveries" ADD CONSTRAINT "integration_deliveries_status_chk"
  CHECK ("status" IN ('pending', 'ok', 'failed', 'refused'));--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN IF NOT EXISTS "last_health_detail" text;--> statement-breakpoint
ALTER TABLE "integration_connections" ADD COLUMN IF NOT EXISTS "inbound_endpoint_observed" jsonb;
