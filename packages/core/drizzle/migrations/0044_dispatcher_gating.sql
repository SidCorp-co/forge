-- ISS-40 PR-E: Dispatcher 4-layer gating defaults + indexes.
--
-- This migration only backfills configuration defaults so existing rows
-- enforce the new caps without manual intervention, and adds two partial
-- indexes that speed up the per-project / per-runner gate queries. No new
-- tables — Layer-2 cross-issue dependencies reuse `issue_dependencies`
-- (added by `0041_pm_agent.sql`); only rows with `kind='blocks'` gate
-- dispatch.
--
-- Idempotent: re-running this migration is a no-op on databases that
-- already have the defaults / indexes.

-- Layer 3 default: per-project max concurrent issues = 3.
-- Stored under projects.agent_config.pipelineConfig.maxConcurrentIssues so
-- we don't add a new column. Only set if not already configured.
--
-- Note: `jsonb_set` does NOT auto-create intermediate object keys (only the
-- leaf), so a row with `agent_config = {}` or NULL would silently skip the
-- update. Using deep-merge with the `||` operator + `jsonb_build_object`
-- handles the nested-create correctly.
UPDATE "projects"
   SET "agent_config" = COALESCE("agent_config", '{}'::jsonb)
                      || jsonb_build_object(
                           'pipelineConfig',
                           COALESCE("agent_config" -> 'pipelineConfig', '{}'::jsonb)
                             || jsonb_build_object('maxConcurrentIssues', 3))
 WHERE COALESCE("agent_config" #> '{pipelineConfig,maxConcurrentIssues}', 'null'::jsonb) = 'null'::jsonb;
--> statement-breakpoint

-- Layer 4 default for claude-code runners: max 2 concurrent jobs per runner.
-- One device usually has 1 CPU core free for an interactive shell.
UPDATE "runners"
   SET "capabilities" = jsonb_set(
         COALESCE("capabilities", '{}'::jsonb),
         '{maxConcurrent}',
         '2'::jsonb,
         true)
 WHERE "type" = 'claude-code'
   AND COALESCE("capabilities" -> 'maxConcurrent', 'null'::jsonb) = 'null'::jsonb;
--> statement-breakpoint

-- Layer 4 default for antigravity runners: max 5 concurrent jobs per runner.
-- Cloud runners scale; cap is more about cost than CPU.
UPDATE "runners"
   SET "capabilities" = jsonb_set(
         COALESCE("capabilities", '{}'::jsonb),
         '{maxConcurrent}',
         '5'::jsonb,
         true)
 WHERE "type" = 'antigravity'
   AND COALESCE("capabilities" -> 'maxConcurrent', 'null'::jsonb) = 'null'::jsonb;
--> statement-breakpoint

-- Layer 1 / Layer 3 lookups: count active sessions per issue / per project.
CREATE INDEX IF NOT EXISTS "agent_sessions_project_status_issue_idx"
  ON "agent_sessions" ("project_id", "status")
  WHERE "status" IN ('queued', 'running');
--> statement-breakpoint

-- Layer 4 lookup: count in-flight jobs per runner.
CREATE INDEX IF NOT EXISTS "jobs_runner_active_idx"
  ON "jobs" ("runner_id")
  WHERE "status" IN ('dispatched', 'running');
