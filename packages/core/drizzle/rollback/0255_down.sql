-- ISS-1071 — the way back from 0255_integration_agent_access.sql.
--
-- NOT run by `db/migrate.js`. This file is applied BY HAND, against the database, BEFORE the
-- previous image is started — never after. The previous image's boot migrator knows only its
-- own migrations, so starting it against the new schema makes it loop; and the runtime image
-- installs only openssh-keygen, openssh-client and git, so there is no `psql` inside it.
-- Reach the database from a one-off container on the app's own network:
--
--   docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}' <core-container>
--   docker run --rm --network <that-network> -i postgres:16 \
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     < packages/core/drizzle/rollback/0255_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0255_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted, so recovery
-- would stop before executing a single statement.
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0255 hash>';
--
-- Then start the previous image.
--
-- THE MAPS ARE RESTORED FROM THE IMAGE, NEVER FROM THE COLUMN. The forward map is not
-- injective and not even close: a project default, a per-stage declaration, an explicit
-- `false` and three different `epodsystem_*` names all land on one binary `agent_access`.
-- Nothing can read a grant and say which of those was there. `iss1071_removed_mcp_sentinels`
-- holds the before-image the forward run took, key by key, map by map, and that is the only
-- thing this file writes back.
--
-- AND IT REFUSES WHERE THE IMAGE NO LONGER SPEAKS FOR THE ROW. Three refusals below, each
-- naming its rows and changing nothing: a grant moved since the forward run, a map whose
-- parent object is gone, and a missing image table. A rollback that guesses past any of them
-- is the silent substitution the forward file exists to refuse, run backwards.

BEGIN;

-- === 0. the image has to be there ========================================
DO $$
BEGIN
  IF to_regclass('public.iss1071_removed_mcp_sentinels') IS NULL
     OR to_regclass('public.iss1071_agent_access_set') IS NULL THEN
    RAISE EXCEPTION 'ISS-1071 rollback: the before-image tables are missing '
      '(iss1071_removed_mcp_sentinels, iss1071_agent_access_set). 0255 creates both and '
      'deliberately does not drop them, because a grant cannot be inverted back into an '
      'mcpServers map. Without them this file cannot restore anything and will not pretend '
      'to: recover them from a backup taken after 0255 ran, or reconstruct each project''s '
      'map by hand from its own history before rolling back.';
  END IF;
END $$;

-- === 1. refuse a grant that moved after the forward run ==================
--
-- The image is a photograph of one moment. If somebody has changed `agent_access` since — a
-- person on the Integrations screen, another migration, a script — then the map this file
-- would put back is not the state that grant came from, and dropping the column throws the
-- newer decision away with no record that it existed.
--
-- A binding created after 0255 ran has no image row; its baseline is the column's own
-- default, `none`. At `none` it is losing nothing and passes. At `all` it is a grant somebody
-- made deliberately, and it stops this file exactly like any other.
DO $$
DECLARE moved text; n int;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s): 0255 set %L, now %L',
                           b.id, coalesce(a.project_slug, p.slug), b.provider,
                           coalesce(a.agent_access, 'none'), b.agent_access),
                    ', ' ORDER BY b.id), count(*)
    INTO moved, n
    FROM integration_bindings b
    JOIN projects p ON p.id = b.project_id
    LEFT JOIN iss1071_agent_access_set a ON a.binding_id = b.id
   WHERE b.agent_access IS DISTINCT FROM coalesce(a.agent_access, 'none');
  IF moved IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071 rollback: % binding(s) carry an agent_access this migration did not '
      'set: %. The sentinel map in the image is the state the ORIGINAL grant came from, so '
      'restoring it would silently discard whatever was decided afterwards — and the column is '
      'about to be dropped, so nothing would record that it ever existed. Nothing has been '
      'changed. Decide each row by hand: either put the grant back to the value 0255 set and '
      're-run this file, or write the newer decision into the project''s own mcpServers map '
      'first (a `direct-mcp` grant is a `<provider>: true` sentinel; a `core-mediated` one had '
      'no representation at all and is simply lost on the way back) and update '
      'iss1071_agent_access_set to match before re-running.', n, moved;
  END IF;
END $$;

-- === 2. refuse a map whose parent object is gone =========================
--
-- `jsonb_set` does NOT create intermediate levels. If `pipelineConfig` — or, for a per-stage
-- entry, `states.<stage>` — is no longer an object, the restore below matches the row and
-- writes nothing, and a rollback that reports success while putting one project's sentinels
-- nowhere is worse than one that stops.
DO $$
DECLARE gone text; n int;
BEGIN
  SELECT string_agg(format('%s (%s) scope %L', x.project_id, x.project_slug, x.scope), ', '
                    ORDER BY x.project_slug, x.scope), count(*)
    INTO gone, n
    FROM (
      SELECT DISTINCT s.project_id, s.project_slug, s.scope
        FROM iss1071_removed_mcp_sentinels s
        JOIN projects p ON p.id = s.project_id
       WHERE CASE WHEN s.scope = 'default'
                  THEN jsonb_typeof(p.agent_config #> '{pipelineConfig}') IS DISTINCT FROM 'object'
                  ELSE jsonb_typeof(p.agent_config #> ARRAY['pipelineConfig', 'states', s.scope])
                         IS DISTINCT FROM 'object' END
    ) x;
  IF gone IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071 rollback: % stored map(s) the image belongs to no longer exist: %. '
      '`jsonb_set` does not create the levels above the key it writes, so restoring into these '
      'would change nothing and report success. Nothing has been changed. Recreate the missing '
      '`pipelineConfig` (or `pipelineConfig.states.<stage>`) object on each project named above, '
      'then re-run this file.', n, gone;
  END IF;
END $$;

-- A project the image names and the database no longer holds is not a refusal: there is no
-- map to restore and nothing was lost by not restoring it. It is still said out loud, because
-- the row count below will not otherwise add up for whoever is reading this at 2am.
DO $$
DECLARE dropped text; n int;
BEGIN
  SELECT string_agg(format('%s (%s)', g.project_id, g.project_slug), ', ' ORDER BY g.project_slug), count(*)
    INTO dropped, n
    FROM (SELECT DISTINCT s.project_id, s.project_slug
            FROM iss1071_removed_mcp_sentinels s
            LEFT JOIN projects p ON p.id = s.project_id
           WHERE p.id IS NULL) g;
  IF dropped IS NOT NULL THEN
    RAISE NOTICE 'ISS-1071 rollback: % project(s) in the before-image no longer exist and are '
      'skipped — their sentinels have no map to go back into: %', n, dropped;
  END IF;
END $$;

-- === 3. the sentinels go back where the forward run found them ===========
--
-- Key by key, with the value the image holds — `true` and `false` alike, a `false` being a
-- switch somebody turned off and as much a part of the map as an opt-in. Merged with `||`
-- rather than assigned, so a catalog name or a hand-written object spec added to that map
-- since is kept: this file puts back what 0255 took and touches nothing else.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT s.project_id, s.scope, jsonb_object_agg(s.server_name, s.value) AS patch
      FROM iss1071_removed_mcp_sentinels s
      JOIN projects p ON p.id = s.project_id
     GROUP BY s.project_id, s.scope
  LOOP
    IF r.scope = 'default' THEN
      UPDATE projects
         SET agent_config = jsonb_set(agent_config, '{pipelineConfig,mcpServers}',
               coalesce(agent_config #> '{pipelineConfig,mcpServers}', '{}'::jsonb) || r.patch)
       WHERE id = r.project_id;
    ELSE
      UPDATE projects
         SET agent_config = jsonb_set(agent_config,
               ARRAY['pipelineConfig', 'states', r.scope, 'mcpServers'],
               coalesce(agent_config #> ARRAY['pipelineConfig', 'states', r.scope, 'mcpServers'], '{}'::jsonb) || r.patch)
       WHERE id = r.project_id;
    END IF;
    n := n + 1;
  END LOOP;
  RAISE NOTICE 'ISS-1071 rollback: restored % mcpServers map(s) from the before-image', n;
END $$;

-- === 4. the column goes ==================================================
ALTER TABLE "integration_bindings" DROP CONSTRAINT IF EXISTS "integration_bindings_agent_access_chk";
ALTER TABLE "integration_bindings" DROP COLUMN "agent_access";

-- The image tables are NOT dropped here either. They are the only record of what 0255 removed
-- and set, and an operator who rolls back at 02:00 and forward again at 09:00 needs to be able
-- to read them in between. 0255 begins with `DROP TABLE IF EXISTS` on both, so a re-run derives
-- them fresh and cannot be poisoned by what is left here.

COMMIT;
