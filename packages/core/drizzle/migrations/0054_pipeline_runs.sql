-- ISS-101 — Introduce `pipeline_runs` as a first-class entity grouping every
-- job/agent_session of one pipeline walk. Picker orders by
-- (priority, run.started_at, job.queued_at) so all jobs of the oldest run
-- drain before a newer same-priority run gets its first dispatch.
--
-- Hard cutover: `pipeline_run_id` is NOT NULL on `jobs` and `agent_sessions`.
-- No NULL fallback in app code; existing rows are backfilled below.
--
-- Every statement is split with `--> statement-breakpoint` per the README;
-- every DDL and INSERT is idempotent so a re-run against a partially-applied
-- state converges cleanly.

CREATE TABLE IF NOT EXISTS "pipeline_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "issue_id" uuid REFERENCES "issues"("id") ON DELETE CASCADE,
  "kind" text NOT NULL DEFAULT 'issue',
  "status" text NOT NULL DEFAULT 'running',
  "current_step" text,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pipeline_runs_kind_chk" CHECK ("kind" IN ('issue','pm','interactive','system')),
  CONSTRAINT "pipeline_runs_status_chk" CHECK ("status" IN ('running','paused','completed','failed','cancelled')),
  CONSTRAINT "pipeline_runs_issue_kind_chk" CHECK (
    ("kind" = 'issue' AND "issue_id" IS NOT NULL) OR ("kind" <> 'issue' AND "issue_id" IS NULL)
  )
  -- 'system' kind covers one-shot project-scoped jobs without an issueId:
  -- schedule.run, skill.push, MCP/CLI custom jobs, etc. They satisfy the
  -- jobs.pipeline_run_id NOT NULL constraint without being conflated with
  -- the PM coordinator (kind='pm').
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pipeline_runs_project_status_idx" ON "pipeline_runs" ("project_id", "status");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pipeline_runs_issue_idx" ON "pipeline_runs" ("issue_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "pipeline_runs_started_at_idx" ON "pipeline_runs" ("project_id", "started_at");
--> statement-breakpoint

-- At most one open issue-run per issue. Gives the orchestrator a cheap
-- ON CONFLICT DO NOTHING anchor when two callers race to open the run.
CREATE UNIQUE INDEX IF NOT EXISTS "pipeline_runs_issue_open_uq" ON "pipeline_runs" ("issue_id")
  WHERE "kind" = 'issue' AND "status" IN ('running', 'paused');
--> statement-breakpoint

ALTER TABLE "jobs"
  ADD COLUMN IF NOT EXISTS "pipeline_run_id" uuid REFERENCES "pipeline_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint

ALTER TABLE "agent_sessions"
  ADD COLUMN IF NOT EXISTS "pipeline_run_id" uuid REFERENCES "pipeline_runs"("id") ON DELETE RESTRICT;
--> statement-breakpoint

-- 3a) Issue runs — one per issue that has any job or session. Idempotent via
-- the partial unique index (a re-run becomes a no-op for issues whose open
-- run already exists). Completed runs are not subject to the unique index;
-- we guard with NOT EXISTS to avoid duplicate completed rows on re-run.
INSERT INTO "pipeline_runs" ("project_id", "issue_id", "kind", "status", "started_at", "finished_at")
SELECT
  i.project_id,
  i.id,
  'issue',
  CASE
    WHEN i.status IN ('released', 'closed', 'pipeline_failed')
     AND NOT EXISTS (
       SELECT 1 FROM jobs WHERE issue_id = i.id AND status IN ('queued', 'dispatched', 'running')
     )
    THEN 'completed'
    ELSE 'running'
  END,
  COALESCE(
    LEAST(
      (SELECT MIN(queued_at) FROM jobs WHERE issue_id = i.id),
      (SELECT MIN(created_at) FROM agent_sessions WHERE (metadata->>'issueId') = i.id::text)
    ),
    now()
  ),
  CASE WHEN i.status IN ('released', 'closed', 'pipeline_failed') THEN now() ELSE NULL END
FROM issues i
WHERE (
    EXISTS (SELECT 1 FROM jobs WHERE issue_id = i.id)
    OR EXISTS (SELECT 1 FROM agent_sessions WHERE (metadata->>'issueId') = i.id::text)
  )
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_runs pr WHERE pr.kind = 'issue' AND pr.issue_id = i.id
  );
--> statement-breakpoint

-- 3b) Stamp jobs with their issue's run.
UPDATE "jobs" AS j
SET "pipeline_run_id" = pr.id
FROM "pipeline_runs" AS pr
WHERE pr.kind = 'issue'
  AND pr.issue_id = j.issue_id
  AND j.pipeline_run_id IS NULL;
--> statement-breakpoint

-- 3c) Stamp issue-linked agent_sessions via metadata.issueId.
UPDATE "agent_sessions" AS s
SET "pipeline_run_id" = pr.id
FROM "pipeline_runs" AS pr
WHERE pr.kind = 'issue'
  AND pr.issue_id::text = (s.metadata->>'issueId')
  AND s.pipeline_run_id IS NULL;
--> statement-breakpoint

-- 3d) PM jobs (issue_id NULL): one one-shot 'pm' run per job. We carry the
-- originating job id in metadata so the follow-up UPDATE can pair each new
-- run with its job deterministically. Guard with NOT EXISTS to make the
-- INSERT idempotent on re-run.
INSERT INTO "pipeline_runs" ("project_id", "issue_id", "kind", "status", "started_at", "finished_at", "metadata")
SELECT
  j.project_id,
  NULL,
  'pm',
  CASE WHEN j.status IN ('queued', 'dispatched', 'running') THEN 'running' ELSE 'completed' END,
  j.queued_at,
  CASE WHEN j.status IN ('queued', 'dispatched', 'running') THEN NULL ELSE COALESCE(j.finished_at, now()) END,
  jsonb_build_object('backfill_job_id', j.id::text)
FROM "jobs" AS j
WHERE j.type = 'pm'
  AND j.pipeline_run_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_runs pr
    WHERE pr.kind = 'pm' AND (pr.metadata->>'backfill_job_id') = j.id::text
  );
--> statement-breakpoint

UPDATE "jobs" AS j
SET "pipeline_run_id" = pr.id
FROM "pipeline_runs" AS pr
WHERE pr.kind = 'pm'
  AND (pr.metadata->>'backfill_job_id') = j.id::text
  AND j.pipeline_run_id IS NULL;
--> statement-breakpoint

-- 3e) Agent sessions linked to jobs (e.g. PM-spawned sessions with no
-- metadata.issueId): inherit the run from the linking job.
UPDATE "agent_sessions" AS s
SET "pipeline_run_id" = j.pipeline_run_id
FROM "jobs" AS j
WHERE j.agent_session_id = s.id
  AND s.pipeline_run_id IS NULL
  AND j.pipeline_run_id IS NOT NULL;
--> statement-breakpoint

-- 3f) Remaining agent_sessions are interactive (user-driven chat). One
-- one-shot 'interactive' run per session, paired via metadata tag for
-- idempotent re-runs.
INSERT INTO "pipeline_runs" ("project_id", "issue_id", "kind", "status", "started_at", "finished_at", "metadata")
SELECT
  s.project_id,
  NULL,
  'interactive',
  CASE WHEN s.status IN ('queued', 'running', 'idle') THEN 'running' ELSE 'completed' END,
  s.created_at,
  CASE WHEN s.status IN ('completed', 'failed') THEN s.updated_at ELSE NULL END,
  jsonb_build_object('backfill_session_id', s.id::text)
FROM "agent_sessions" AS s
WHERE s.pipeline_run_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pipeline_runs pr
    WHERE pr.kind = 'interactive' AND (pr.metadata->>'backfill_session_id') = s.id::text
  );
--> statement-breakpoint

UPDATE "agent_sessions" AS s
SET "pipeline_run_id" = pr.id
FROM "pipeline_runs" AS pr
WHERE pr.kind = 'interactive'
  AND (pr.metadata->>'backfill_session_id') = s.id::text
  AND s.pipeline_run_id IS NULL;
--> statement-breakpoint

ALTER TABLE "jobs" ALTER COLUMN "pipeline_run_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "agent_sessions" ALTER COLUMN "pipeline_run_id" SET NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "jobs_pipeline_run_idx" ON "jobs" ("pipeline_run_id");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "agent_sessions_pipeline_run_idx" ON "agent_sessions" ("pipeline_run_id");
