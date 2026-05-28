-- Step-handoff storage (proposal Y, ratchet 2026-05-28).
--
-- Per-issue, per-state structured output. Each row is one handoff payload
-- written by the agent at the end of a pipeline step; downstream states pick
-- it up via the dispatcher prefetch. Lifecycle is tied to the issue (cascade)
-- and to the specific pipeline_run that produced it (cascade), so an
-- abandoned issue or a cancelled run never leaves orphans.
--
-- `kind` is a discriminator so the table can absorb other per-issue per-run
-- structured artifacts later (blocker notes, retrospectives, cross-step
-- decisions) without another table. v1 only writes kind='handoff'.
--
-- The unique constraint is partial so handoff rows respect natural-key
-- uniqueness (issue, step, attempt) while future kinds can have multiple
-- rows per (issue, step, attempt) without contention.
--
-- Hand-written; drizzle-kit generate is blocked by a pre-existing meta
-- snapshot collision (see 0080_upload_tickets header). The runtime migrator
-- applies this row from _journal.json regardless.

CREATE TABLE IF NOT EXISTS "issue_step_contexts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "issue_id" uuid NOT NULL REFERENCES "issues"("id") ON DELETE CASCADE,
  "pipeline_run_id" uuid NOT NULL REFERENCES "pipeline_runs"("id") ON DELETE CASCADE,
  "kind" text NOT NULL,
  "step" text,
  "attempt" integer NOT NULL DEFAULT 1,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "issue_step_contexts_handoff_uq"
  ON "issue_step_contexts" ("issue_id", "step", "attempt")
  WHERE "kind" = 'handoff';

CREATE INDEX IF NOT EXISTS "issue_step_contexts_issue_kind_idx"
  ON "issue_step_contexts" ("issue_id", "kind");

CREATE INDEX IF NOT EXISTS "issue_step_contexts_run_idx"
  ON "issue_step_contexts" ("pipeline_run_id");
