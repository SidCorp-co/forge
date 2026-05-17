-- ISS-150 — MCP audit log. One row per MCP tool call, regardless of whether
-- the principal was a device or a PAT user.
--
-- This first cut is a plain (non-partitioned) table. Monthly RANGE partitioning
-- with 90-day retention was described in the plan; we defer it to a follow-up
-- so the smaller change is reviewable independently. Until then, retention is
-- enforced by a periodic `DELETE FROM mcp_audit_log WHERE created_at < now() - interval '90 days'`
-- scheduled tick (see packages/core/src/auth/mcp-audit.ts).
--
-- Immutability: app role should hold only INSERT + SELECT once partitioning
-- lands. With a single-role DB connection (DATABASE_URL) we cannot enforce
-- a separate write/admin grant here without operator coordination — the
-- threat-model doc (docs/security/mcp-threat-model.md) describes the
-- recommended REVOKE pattern for self-hosted operators.
--
-- Rollback: DROP TABLE "mcp_audit_log";

CREATE TABLE IF NOT EXISTS "mcp_audit_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "token_id" uuid REFERENCES "personal_access_tokens"("id") ON DELETE SET NULL,
  "device_id" uuid REFERENCES "devices"("id") ON DELETE SET NULL,
  "tool" text NOT NULL,
  "action" text,
  "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL,
  "result_code" text NOT NULL,
  "request_id" text,
  "ip" text,
  "user_agent" text,
  "payload_digest" varchar(64),
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "mcp_audit_token_idx"
  ON "mcp_audit_log" ("token_id", "created_at");
CREATE INDEX IF NOT EXISTS "mcp_audit_user_idx"
  ON "mcp_audit_log" ("user_id", "created_at");
CREATE INDEX IF NOT EXISTS "mcp_audit_project_idx"
  ON "mcp_audit_log" ("project_id", "created_at");
