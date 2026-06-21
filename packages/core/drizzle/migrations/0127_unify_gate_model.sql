-- Unify the pipeline gate model: `tested` ("Awaiting release") is the SINGLE
-- production approval gate. The retired `pass` / `staging` issue statuses are
-- removed from the lifecycle in code (status enum, state machine, configurable
-- STAGE_NAMES). This one-shot, hand-written data migration (applied from
-- meta/_journal.json) makes the live data consistent with that change:
--   1. Re-park every issue stranded at `pass`/`staging` onto `tested`, so no row
--      holds a status that no longer exists — and nothing auto-ships when the
--      former pass/staging -> released drain edges disappear.
--   2. Normalize every project's pipelineConfig.states to the canonical default
--      (all stages enabled + auto; `tested` = the only manual gate), dropping
--      the `pass`/`staging` entries while PRESERVING per-stage sessionGroup /
--      skipComplexities and every other pipelineConfig key.
--   3. Force all autoX step toggles on and drop the retired `autoStage` toggle.
--   4. Repoint any mergeStates that still referenced pass/staging onto the
--      canonical tested/released so the StageName enum no longer rejects them.

-- 1) Re-park stranded issues onto the canonical gate.
UPDATE "issues" SET "status" = 'tested' WHERE "status" IN ('pass', 'staging');
--> statement-breakpoint

-- 2) Normalize per-stage modes: drop pass/staging, force tested = manual, every
--    other stage = {enabled:true, mode:'auto'}; `value || {...}` merges so
--    sessionGroup / skipComplexities and any other sub-keys survive.
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config",
  '{pipelineConfig,states}',
  COALESCE((
    SELECT jsonb_object_agg(
      key,
      CASE
        WHEN key = 'tested' THEN value || '{"enabled":true,"mode":"manual"}'::jsonb
        ELSE value || '{"enabled":true,"mode":"auto"}'::jsonb
      END
    )
    FROM jsonb_each(("agent_config" #> '{pipelineConfig,states}') - 'pass' - 'staging')
  ), '{}'::jsonb)
)
WHERE jsonb_typeof("agent_config" #> '{pipelineConfig,states}') = 'object';
--> statement-breakpoint

-- 2b) Guarantee the `tested` gate exists even for a project that never had a
--     states entry for it (e.g. one normalized down to an empty object above).
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config",
  '{pipelineConfig,states,tested}',
  '{"enabled":true,"mode":"manual"}'::jsonb
)
WHERE jsonb_typeof("agent_config" #> '{pipelineConfig,states}') = 'object'
  AND ("agent_config" #> '{pipelineConfig,states,tested}') IS NULL;
--> statement-breakpoint

-- 3) All step toggles on; drop the retired `autoStage`.
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config",
  '{pipelineConfig}',
  (("agent_config" #> '{pipelineConfig}')
    || '{"autoTriage":true,"autoClarify":true,"autoPlan":true,"autoCode":true,"autoReview":true,"autoTest":true,"autoFix":true,"autoRelease":true}'::jsonb)
    - 'autoStage'
)
WHERE jsonb_typeof("agent_config" #> '{pipelineConfig}') = 'object';
--> statement-breakpoint

-- 4) Repoint stale mergeStates off the retired statuses.
UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config", '{pipelineConfig,mergeStates,baseBranch}', '"tested"'::jsonb
)
WHERE ("agent_config" #> '{pipelineConfig,mergeStates,baseBranch}') IN ('"pass"'::jsonb, '"staging"'::jsonb);
--> statement-breakpoint

UPDATE "projects"
SET "agent_config" = jsonb_set(
  "agent_config", '{pipelineConfig,mergeStates,productionBranch}', '"released"'::jsonb
)
WHERE ("agent_config" #> '{pipelineConfig,mergeStates,productionBranch}') IN ('"pass"'::jsonb, '"staging"'::jsonb);
