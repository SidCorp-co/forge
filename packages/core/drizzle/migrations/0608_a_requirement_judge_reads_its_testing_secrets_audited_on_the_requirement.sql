-- ISS-975 — a judge run declared at a requirement (`forge-runner run declare --requirement REQ-n
-- --role qa`) reads the testing secrets of the environment the requirement is weighed on, and that
-- read is audited on the requirement. A run over an issue audits its read on the issue's activity
-- (`issues/testing-secret-audit.ts`); a requirement has no activity log, so each read is a row here,
-- naming the run, the box that declared it and the person its credential acts for, the refs read
-- (never values) and how the environment was named. Insert-only. The scrubber reads the refs by
-- session, as it reads a run's issue reads.
--
-- ROLLBACK:
--   DROP TABLE IF EXISTS "requirement_secret_reads";

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "requirement_secret_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "requirement_id" uuid NOT NULL REFERENCES "requirements"("id") ON DELETE CASCADE,
  "session_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "box_run_id" text,
  "device_id" uuid NOT NULL,
  "declared_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL,
  "basis" text NOT NULL,
  "environment" text NOT NULL,
  "profile" text NOT NULL,
  "refs" text[] NOT NULL,
  "token_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "requirement_secret_reads_basis_chk" CHECK ("basis" IN ('landing', 'judgedOn', 'production'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requirement_secret_reads_requirement_idx" ON "requirement_secret_reads" ("requirement_id", "created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requirement_secret_reads_session_idx" ON "requirement_secret_reads" ("session_id");
