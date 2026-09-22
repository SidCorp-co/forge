-- ISS-1186 — remove `pipelineConfig.deployOnLanding` from every stored project document.
--
-- The key armed a `transition` subscriber that dispatched a Coolify deployment the moment an issue
-- reached `developed`. ISS-1186 deletes that subscriber, so the key has no reader, and the schema
-- it was declared in no longer carries it. Two doors already refuse a caller who names it, by name
-- and with the reason. What neither door can reach is a document that already holds it.
--
-- It cannot be left. `GET /api/projects/:id/pipeline-config` and `forge_config` action=get both
-- answer with `pipelineConfigSchema.parse(stored)`, and a zod object strips a key it does not
-- declare. So a project carrying `deployOnLanding: true` would, from the moment ISS-1186 lands,
-- read back a document that does not mention it while the column went on holding it — a value an
-- operator set, that nothing reads and nothing shows. That is the shape ISS-994 named and 0234
-- removed on this same jsonb sub-key, and this file is 0234's twin.
--
-- Deletion only: `#-` on the one nested path, over the rows whose stored `pipelineConfig` actually
-- holds it, so a project that never had the key is not rewritten and no neighbouring key is
-- touched. No ALTER, no DROP, no reconciliation with any column — nothing owns this value.
--
-- PRICED, on 0285's precedent: the RAISE NOTICE below is the only record of a removed value, and
-- no backup table is added. What that costs is one operator toggle per project that had the switch
-- on, recoverable only while the deploy log is kept. What ends the condition is that there is
-- nothing to recover TO: the switch this value set is one the project's deploy rule forbids
-- turning on, so a value preserved past a revert would be a value nobody may act on.

DO $iss1186$
DECLARE
  doomed RECORD;
  changed bigint;
BEGIN
  -- Printed BEFORE the delete, so an aborted run prints nothing and a completed one prints exactly
  -- what it removed, with the statement that puts it back.
  FOR doomed IN
    SELECT p.slug AS slug,
           p.id AS id,
           p.agent_config -> 'pipelineConfig' -> 'deployOnLanding' AS value
      FROM projects p
     WHERE p.agent_config -> 'pipelineConfig' ? 'deployOnLanding'
     ORDER BY p.slug
  LOOP
    RAISE NOTICE
      'ISS-1186: removing pipelineConfig.deployOnLanding = % from project % (%). To replay: UPDATE projects SET agent_config = jsonb_set(agent_config, ''{pipelineConfig,deployOnLanding}'', ''%''::jsonb) WHERE id = ''%'';',
      doomed.value, doomed.slug, doomed.id, doomed.value, doomed.id;
  END LOOP;

  UPDATE projects
     SET agent_config = agent_config #- '{pipelineConfig,deployOnLanding}'
   WHERE agent_config -> 'pipelineConfig' ? 'deployOnLanding';

  GET DIAGNOSTICS changed = ROW_COUNT;
  RAISE NOTICE 'ISS-1186: % project row(s) carried deployOnLanding and no longer do', changed;
END
$iss1186$;
