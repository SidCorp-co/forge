-- A health check learns two things: whether the credential is recognised (the connection's, read
-- alike by every binding of it) and whether one binding's own target is there (its GitLab project's
-- visibility and hooks, its GitHub repository and installation, its Coolify applications, its
-- Autoflow site). Both were written to `integration_connections`, so whichever project probed last
-- spoke for every project on the connection: sidpeak's missing GitLab hook read as adminhub-api's
-- source standing (ISS-983). The binding's part now lands in `integration_binding_health`, one row
-- per binding, which the integrations adapter owns: an observation, never part of the binding
-- document `integration_bindings` holds.
--
-- A GitLab connection's `inbound_endpoint_observed` was the hook list of whichever project probed
-- last, and moves to the binding's health row; a GitHub connection keeps its own, which is the App's.
--
-- A stored reading on a connection of the four providers whose check reads a binding's target is
-- cleared where its status is one both halves write, so it cannot be told apart as the credential's
-- or one binding's: `degraded` and `error` on GitLab, GitHub and Coolify, and `needs_reauth` on
-- Autoflow (an expired token, or a token for another site than the binding's shop). It reads
-- unverified until the hourly health sweep probes each binding, a never-probed one first. `ok`,
-- and a `needs_reauth` or `needs_scope` only the credential earns, are kept.
--
-- ROLLBACK: DROP TABLE IF EXISTS "integration_binding_health". The cleared connection readings are
-- not restored; the next sweep rewrites them.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_binding_health" (
  "binding_id" uuid PRIMARY KEY NOT NULL REFERENCES "integration_bindings"("id") ON DELETE CASCADE,
  "status" text,
  "detail" text,
  "says" jsonb,
  "checked_at" timestamp with time zone,
  "inbound_endpoint_observed" jsonb
);--> statement-breakpoint
UPDATE "integration_connections"
   SET "last_health_status" = NULL, "last_health_detail" = NULL, "last_health_says" = NULL, "last_health_at" = NULL
 WHERE ("provider" IN ('gitlab', 'github', 'coolify') AND "last_health_status" IN ('degraded', 'error'))
    OR ("provider" = 'autoflow' AND "last_health_status" = 'needs_reauth');--> statement-breakpoint
UPDATE "integration_connections"
   SET "inbound_endpoint_observed" = NULL
 WHERE "provider" = 'gitlab' AND "inbound_endpoint_observed" IS NOT NULL;
