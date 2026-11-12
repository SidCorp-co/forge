-- ISS-1225 (owner ruling 2026-11-12). Production monitoring comes into Forge as an integration: a
-- project binds a monitoring connection (a Prometheus and an Alertmanager its owner runs) with the new
-- binding role `monitoring`, and a project's host runs a Prometheus agent that remote-writes to
-- `POST /api/monitoring/write` with the project's own agent token, one per project, kept as the
-- SHA-256 of its secret; minting a new one replaces the old.
--   1. integration_bindings_role_chk takes `monitoring` beside deploy, service and source; every
--      row stored today holds one of those three, so none is refused.
--   2. monitoring_agent_tokens, a new table: no row is changed.
--   3. monitoring_connections, a new table holding a connection's server readiness as last read and
--      the hashes of the two tokens Forge mints for it (sd, alerts): no row is changed.
--
-- ROLLBACK (only while no binding holds role `monitoring`):
--   DROP TABLE IF EXISTS monitoring_connections;
--   DROP TABLE IF EXISTS monitoring_agent_tokens;
--   ALTER TABLE integration_bindings DROP CONSTRAINT integration_bindings_role_chk;
--   ALTER TABLE integration_bindings ADD CONSTRAINT integration_bindings_role_chk
--     CHECK (role IN ('deploy', 'service', 'source'));

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "integration_bindings" DROP CONSTRAINT IF EXISTS "integration_bindings_role_chk";--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_role_chk" CHECK (role IN ('deploy', 'service', 'source', 'monitoring'));--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitoring_agent_tokens" (
  "project_id" uuid PRIMARY KEY NOT NULL,
  "token_hash" text NOT NULL,
  "prefix" text NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "monitoring_agent_tokens_token_hash_chk" CHECK ("token_hash" ~ '^[0-9a-f]{64}$')
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitoring_agent_tokens_project_id_projects_id_fk') THEN
    ALTER TABLE "monitoring_agent_tokens" ADD CONSTRAINT "monitoring_agent_tokens_project_id_projects_id_fk"
      FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitoring_agent_tokens_created_by_users_id_fk') THEN
    ALTER TABLE "monitoring_agent_tokens" ADD CONSTRAINT "monitoring_agent_tokens_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitoring_agent_tokens_token_hash_uq" ON "monitoring_agent_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "monitoring_connections" (
  "connection_id" uuid PRIMARY KEY NOT NULL,
  "readiness" jsonb,
  "sd_token_hash" text,
  "sd_token_prefix" text,
  "sd_token_created_at" timestamp with time zone,
  "alerts_token_hash" text,
  "alerts_token_prefix" text,
  "alerts_token_created_at" timestamp with time zone,
  CONSTRAINT "monitoring_connections_token_hash_chk" CHECK (("sd_token_hash" IS NULL OR "sd_token_hash" ~ '^[0-9a-f]{64}$') AND ("alerts_token_hash" IS NULL OR "alerts_token_hash" ~ '^[0-9a-f]{64}$'))
);--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'monitoring_connections_connection_id_integration_connections_id_fk') THEN
    ALTER TABLE "monitoring_connections" ADD CONSTRAINT "monitoring_connections_connection_id_integration_connections_id_fk"
      FOREIGN KEY ("connection_id") REFERENCES "public"."integration_connections"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitoring_connections_sd_token_hash_uq" ON "monitoring_connections" USING btree ("sd_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "monitoring_connections_alerts_token_hash_uq" ON "monitoring_connections" USING btree ("alerts_token_hash");
