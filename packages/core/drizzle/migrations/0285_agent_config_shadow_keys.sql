-- ISS-1070 — the five keys of `projects.agent_config` that no reader reads.
--
--   agentConfig.repoPath, agentConfig.baseBranch, agentConfig.productionBranch
--     Shadow copies of real columns. `forge_config`'s own contract says `repoPath` and `baseBranch`
--     are served DIRECTLY from `projects.repo_path` and `projects.base_branch`, and ISS-1046 made
--     the third one `projects.live_branch`, readable only under `release_model = 'promote'`. Nothing
--     in this tree reads any of the jsonb copies.
--
--   agentConfig.activeDeviceId
--     The device a project defaults to is `projects.default_device_id`. No dispatcher has read this
--     key. Measured on this fleet 2026-09-18: one project stores one, and its column is NULL.
--
--   agentConfig.runnerFallback
--     ISS-232 Phase 3 replaced the type-chain fallback with a deterministic primary-then-standby
--     pick and left the surviving v1 rows alone. This finishes that retirement rather than leaving
--     it as a key the declared schema does not carry.
--
-- THEY ARE DELETED, NOT RECONCILED. The column is the source and the jsonb value goes without being
-- compared, merged or preferred. Two of the copies on this fleet already disagree with their column
-- — forge-dev's repoPath says `/home/kieutrung/tools/forge/jarvis-agents` against a column of
-- `/home/kieutrung/tools/forge`, and home-kieutrung-services-anhome's baseBranch says `main` against
-- a column of `release/stg` — so "keep whichever looks right" is a decision nobody is qualified to
-- make from a migration. Nothing below reads a `projects` column, let alone writes one.
--
-- NO BACKUP TABLE, deliberately, and this is the priced part. A key with no reader holds nothing a
-- reader would want back; 0239 retired `stateContext` on the same reasoning. The one value that is
-- not derivable from a column is forge-dev's `activeDeviceId`, so every removed document is printed
-- verbatim by RAISE NOTICE BEFORE anything is deleted, and the deploy log is its record: replaying
-- one is `UPDATE projects SET agent_config = agent_config || '<the logged document>'::jsonb`. The
-- cost is that a log nobody keeps is a record nobody has; the condition that ends it is the column
-- holding the value, which is what these five keys were copies of.
--
-- AN UNDECLARED KEY ABORTS. A key in neither the surviving schema nor the five above is one the
-- strict schema this change lands would refuse on every door while the column went on holding it,
-- so the deploy stops and names the project and the key rather than deleting a key nobody declared
-- (which would be the silent drop this whole change exists to remove) or leaving it (which would
-- leave a value with no door and no reader). Measured over all 32 project rows on 2026-09-18, the
-- only such key was `uxContractProfile`, which 0280 removes and which runs before this file.
--
-- Data only: no CREATE, no ALTER, no DROP. A RAISE anywhere below rolls the whole file back.

DO $iss1070$
DECLARE
  retired_keys CONSTANT text[] := ARRAY[
    'repoPath', 'baseBranch', 'productionBranch', 'activeDeviceId', 'runnerFallback'
  ];
  declared_keys CONSTANT text[] := ARRAY[
    'pipelineConfig', 'plugins', 'personaStyle', 'systemPrompt', 'rocketChatAnswerMode', 'categories'
  ];
  shaped RECORD;
  stray RECORD;
  doomed RECORD;
  changed_rows INT;
BEGIN
  -- A column that is not an object at all has no keys to walk, and `jsonb_object_keys` would fail
  -- on it with a message naming neither the project nor this migration. Named here instead.
  FOR shaped IN
    SELECT p.slug AS slug, p.id AS id, jsonb_typeof(p.agent_config) AS kind
      FROM projects p
     WHERE p.agent_config IS NOT NULL
       AND jsonb_typeof(p.agent_config) <> 'object'
     ORDER BY p.slug
  LOOP
    RAISE EXCEPTION
      'ISS-1070: project % (%) stores an agent_config that is a jsonb % rather than an object, so it has no keys and the declared schema cannot describe it. Nothing was deleted. Replace it with an object, or set it NULL, then deploy again.',
      shaped.slug, shaped.id, shaped.kind;
  END LOOP;

  -- Refuse first, delete second: every project is checked before any row changes.
  FOR stray IN
    SELECT p.slug AS slug, p.id AS id, k.key AS key
      FROM projects p
      CROSS JOIN LATERAL jsonb_object_keys(COALESCE(p.agent_config, '{}'::jsonb)) AS k(key)
     WHERE NOT (k.key = ANY(retired_keys))
       AND NOT (k.key = ANY(declared_keys))
     ORDER BY p.slug, k.key
  LOOP
    RAISE EXCEPTION
      'ISS-1070: project % (%) stores agent_config key ''%'', which is neither a key the declared schema carries (%) nor one this migration retires (%). The strict schema landing with this migration refuses that key on every door, so leaving it would strand a value nothing can write and nothing reads, and deleting it here would be the silent drop this change removes. Nothing was deleted. Either declare it in packages/core/src/projects/agent-config-schema.ts and give it a door, or remove it from that project''s column, then deploy again.',
      stray.slug, stray.id, stray.key,
      array_to_string(declared_keys, ', '),
      array_to_string(retired_keys, ', ');
  END LOOP;

  -- The record, printed before the deletion so an aborted run prints nothing and a completed one
  -- prints exactly what it removed.
  FOR doomed IN
    SELECT p.slug AS slug,
           p.id AS id,
           (SELECT jsonb_object_agg(k.key, p.agent_config -> k.key)
              FROM unnest(retired_keys) AS k(key)
             WHERE p.agent_config ? k.key) AS removed
      FROM projects p
     WHERE p.agent_config ?| retired_keys
     ORDER BY p.slug
  LOOP
    RAISE NOTICE
      'ISS-1070: removing % from project % (%) — the columns that own these values are untouched. To replay: UPDATE projects SET agent_config = agent_config || ''%''::jsonb WHERE id = ''%'';',
      doomed.removed, doomed.slug, doomed.id, doomed.removed, doomed.id;
  END LOOP;

  UPDATE projects
     SET agent_config = agent_config - retired_keys
   WHERE agent_config ?| retired_keys;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  RAISE NOTICE 'ISS-1070: % project row(s) had a shadow key removed', changed_rows;
END
$iss1070$;
