-- ISS-897 — the staged surface leaves the data with the schema that stopped accepting it.
--
-- Two writes, one migration, because `pipelineConfigSchema` strips unknown keys: a project
-- that saved its settings after the schema change would drop these keys anyway, one project
-- at a time, leaving the fleet half-stripped for as long as nobody opened a settings page.

-- 1. `tested` was the release gate's status. It is `released` now: merged to the base branch,
--    run and verified on staging, waiting for production. It moves EVERY issue at `tested`,
--    whatever the count when it runs — measured 76 across 9 projects on the live replica
--    2026-09-03, every one of them at a real gate (`states.tested = {enabled:true,
--    mode:'manual'}`). `merged_at` is deliberately untouched: none of these has been
--    released, and the column is what unblocks their dependents.
--
--    NOT moved, and deliberately: 8 issues sit at `testing`/`developed`/`approved`/
--    `confirmed`/`clarified` — mid-flight under the lane this removes, in projects this
--    issue does not own. Nothing dispatches them afterwards. Moving them to `open` would
--    fire 8 unrequested drive jobs across those projects and `needs_info` would park them
--    with no reason and no comment, so this records the residual rather than picking one
--    on their owners' behalf (docs/proposals/release-step-contract.md).
UPDATE issues SET status = 'released', updated_at = now() WHERE status = 'tested';

-- 2. Staged configuration leaves `agentConfig.pipelineConfig`. `states` keeps only the four
--    statuses this lane reaches; `sessionGroup` and `skipComplexities` leave the survivors.
UPDATE projects
SET agent_config = jsonb_set(
  agent_config,
  '{pipelineConfig}',
  (
    (agent_config -> 'pipelineConfig')
      - 'autoTriage' - 'autoClarify' - 'autoPlan' - 'autoCode'
      - 'autoReview' - 'autoTest' - 'autoFix' - 'autoRelease'
      - 'sessionGroups' - 'mergeStates' - 'mode'
  ) || jsonb_build_object(
    'states',
    coalesce(
      (
        SELECT jsonb_object_agg(k, v - 'sessionGroup' - 'skipComplexities')
        FROM jsonb_each(coalesce(agent_config -> 'pipelineConfig' -> 'states', '{}'::jsonb)) AS s(k, v)
        WHERE k IN ('open', 'in_progress', 'needs_info', 'released')
      ),
      '{}'::jsonb
    )
  )
)
WHERE agent_config -> 'pipelineConfig' IS NOT NULL
  AND jsonb_typeof(agent_config -> 'pipelineConfig') = 'object';
