-- Retire the `deploying` issue status (unify gate model): review now exits
-- straight to `testing`. The former `developed → deploying → testing` hop is
-- gone — `deploying` always auto-skipped to `testing` anyway. Hand-written data
-- migration (applied from meta/_journal.json), companion to 0127.
--
--   1. Re-park any issue stranded at `deploying` onto `testing`, so no row holds
--      a status that no longer exists in the enum.
--   2. Drop any `deploying` key from every project's pipelineConfig.states.
--   3. Repoint any mergeStates that referenced `deploying` onto `testing`.
--   4. Delete dangling skill_registrations bound to the removed `pass` /
--      `staging` / `deploying` stages (e.g. a leftover forge-staging@pass on a
--      project the 0127 reset didn't reach) — those stages can never dispatch.

-- 1) Re-park stranded issues.
UPDATE "issues" SET "status" = 'testing' WHERE "status" = 'deploying';
--> statement-breakpoint

-- 2) Drop the `deploying` states entry where present.
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config",
  '{pipelineConfig,states}',
  ("agent_config" #> '{pipelineConfig,states}') - 'deploying'
)
WHERE jsonb_typeof("agent_config" #> '{pipelineConfig,states}') = 'object'
  AND ("agent_config" #> '{pipelineConfig,states}') ? 'deploying';
--> statement-breakpoint

-- 3) Repoint stale mergeStates off `deploying`.
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config", '{pipelineConfig,mergeStates,baseBranch}', '"testing"'::jsonb
)
WHERE ("agent_config" #> '{pipelineConfig,mergeStates,baseBranch}') = '"deploying"'::jsonb;
--> statement-breakpoint

UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config", '{pipelineConfig,mergeStates,productionBranch}', '"released"'::jsonb
)
WHERE ("agent_config" #> '{pipelineConfig,mergeStates,productionBranch}') = '"deploying"'::jsonb;
--> statement-breakpoint

-- 4) Remove skill registrations bound to retired stages (pass/staging/deploying).
DELETE FROM "skill_registrations" WHERE "stage" IN ('pass', 'staging', 'deploying');
