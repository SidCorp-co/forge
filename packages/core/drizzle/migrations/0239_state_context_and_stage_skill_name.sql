-- ISS-1000 — remove the two stored keys that a person could set and nothing read.
--
--   agentConfig.stateContext
--     A model override and a spend cap per jobType. Validated by
--     `projects/state-context.ts`, merged by `mergeStateContext`, written through the
--     scoped `stateContext` field on PATCH /projects/:id, MCP `forge_config`
--     action=update and the "Per-job context" settings section — and read by nothing
--     in `jobs/`, `pipeline/` or `prompt/`. The live model and budget path is
--     `pipelineConfig.states[*].model` and `states[*].budget`, through
--     `resolveStageOverrides` and `jobs/budget-check.ts`. One project on this fleet
--     stored one, carrying a model and a $7/run cap that no dispatch ever consulted.
--
--   pipelineConfig.states.<any stage>.skillName
--     Declared on `stageConfigSchema` and read by no symbol: `StageOverrides` does not
--     carry the field, and the driver skill name comes from `autonomousStepFor`. Zero
--     projects on this fleet store one; the statement runs anyway, because a document
--     written before this deploy is not bound by a count taken before it. It walks EVERY
--     key of `states` rather than the four the schema now names: a document holding a
--     stage ISS-897 deleted would otherwise keep a `skillName` the raw reads still show.
--
-- Deletion only, and only of keys with no reader — nothing here is data a reader would
-- want back. Every other key of every document is untouched. Follows
-- `0234_pipeline_config_phantom_keys.sql`, which retired `states.<non-entry>.mode` and
-- the three recovery keys the same way.

DO $$
DECLARE
  with_state_context bigint;
  with_skill_name bigint;
  changed_ac bigint;
  changed_pc bigint;
BEGIN
  SELECT count(*) INTO with_state_context
  FROM projects
  WHERE agent_config ? 'stateContext';

  SELECT count(*) INTO with_skill_name
  FROM projects p
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_each(
      CASE
        WHEN jsonb_typeof(p.agent_config -> 'pipelineConfig' -> 'states') = 'object'
          THEN p.agent_config -> 'pipelineConfig' -> 'states'
        ELSE '{}'::jsonb
      END
    ) AS e(stage, cfg)
    WHERE jsonb_typeof(cfg) = 'object' AND cfg ? 'skillName'
  );

  UPDATE projects
  SET agent_config = agent_config #- '{stateContext}'
  WHERE agent_config ? 'stateContext';

  GET DIAGNOSTICS changed_ac = ROW_COUNT;

  -- EVERY `jsonb_each` over a stored `states` carries the same CASE, with no
  -- exception for one an earlier clause looks like it has already proved: a
  -- `states` that is an array, a string or a JSON null makes `jsonb_each` RAISE,
  -- and one raise inside this block rolls the whole deploy back. `AND` promises
  -- no evaluation order, so a guard that depends on a sibling conjunct running
  -- first is depending on a plan rather than on the statement.
  UPDATE projects p
  SET agent_config = jsonb_set(
    p.agent_config,
    '{pipelineConfig,states}',
    (
      SELECT jsonb_object_agg(
        e.stage,
        CASE WHEN jsonb_typeof(e.cfg) = 'object' THEN e.cfg - 'skillName' ELSE e.cfg END
      )
      FROM jsonb_each(
        CASE
          WHEN jsonb_typeof(p.agent_config -> 'pipelineConfig' -> 'states') = 'object'
            THEN p.agent_config -> 'pipelineConfig' -> 'states'
          ELSE '{}'::jsonb
        END
      ) AS e(stage, cfg)
    )
  )
  WHERE EXISTS (
    SELECT 1
    FROM jsonb_each(
      CASE
        WHEN jsonb_typeof(p.agent_config -> 'pipelineConfig' -> 'states') = 'object'
          THEN p.agent_config -> 'pipelineConfig' -> 'states'
        ELSE '{}'::jsonb
      END
    ) AS e(stage, cfg)
    WHERE jsonb_typeof(e.cfg) = 'object' AND e.cfg ? 'skillName'
  );

  GET DIAGNOSTICS changed_pc = ROW_COUNT;

  RAISE NOTICE
    'ISS-1000: removed stateContext from % project(s) (% carried one); rewrote the states map of % project(s), % of which carried a stage skillName',
    changed_ac, with_state_context, changed_pc, with_skill_name;
END $$;
