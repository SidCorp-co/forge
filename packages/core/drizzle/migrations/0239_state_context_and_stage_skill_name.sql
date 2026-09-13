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
--     written before this deploy is not bound by a count taken before it.
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
  FROM projects
  WHERE agent_config -> 'pipelineConfig' -> 'states' -> 'open' ? 'skillName'
     OR agent_config -> 'pipelineConfig' -> 'states' -> 'in_progress' ? 'skillName'
     OR agent_config -> 'pipelineConfig' -> 'states' -> 'needs_info' ? 'skillName'
     OR agent_config -> 'pipelineConfig' -> 'states' -> 'awaiting_release' ? 'skillName';

  UPDATE projects
  SET agent_config = agent_config #- '{stateContext}'
  WHERE agent_config ? 'stateContext';

  GET DIAGNOSTICS changed_ac = ROW_COUNT;

  UPDATE projects
  SET agent_config =
    agent_config
      #- '{pipelineConfig,states,open,skillName}'
      #- '{pipelineConfig,states,in_progress,skillName}'
      #- '{pipelineConfig,states,needs_info,skillName}'
      #- '{pipelineConfig,states,awaiting_release,skillName}'
  WHERE agent_config ? 'pipelineConfig';

  GET DIAGNOSTICS changed_pc = ROW_COUNT;

  RAISE NOTICE
    'ISS-1000: removed stateContext from % project(s) (% carried one); rewrote % pipelineConfig document(s), % of which carried a stage skillName',
    changed_ac, with_state_context, changed_pc, with_skill_name;
END $$;
