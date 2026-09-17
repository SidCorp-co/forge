-- ISS-1071 — the way back from 0259_integration_agent_access.sql.
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
--     < packages/core/drizzle/rollback/0259_down.sql
--
-- The file is REDIRECTED INTO the container's stdin. `-f 0259_down.sql` would make psql look
-- for the file INSIDE the disposable container, which has no checkout mounted, so recovery
-- would stop before executing a single statement.
--   DELETE FROM drizzle.__drizzle_migrations WHERE hash = '<0259 hash>';
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
      '(iss1071_removed_mcp_sentinels, iss1071_agent_access_set). 0259 creates both and '
      'deliberately does not drop them, because a grant cannot be inverted back into an '
      'mcpServers map. Without them this file cannot restore anything and will not pretend '
      'to: recover them from a backup taken after 0259 ran, or reconstruct each project''s '
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
-- A binding created after 0259 ran has no image row; its baseline is the column's own
-- default, `none`. At `all` it is a grant somebody made deliberately, and it stops this file
-- exactly like any other. At `none` it matches that baseline and passes HERE — which is not
-- the same as being safe, because going back ADDS access to a denied row rather than removing
-- it. Section 1b is where that case is refused; this one only ever asks about a grant that
-- moved away from what 0259 set.
DO $$
DECLARE moved text; n int;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s): 0259 set %L, now %L',
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
      'changed. Decide each row by hand. Editing the project''s own mcpServers map is NOT one of '
      'the ways out, and this message used to say it was: section 3 restores every key from '
      'iss1071_removed_mcp_sentinels with ||, so a <provider>: false written by hand there is '
      'overwritten by the image''s true moments later and the access being revoked is handed '
      'back. Three ways out that hold. (a) Put the grant back to the value 0259 set and re-run '
      'this file. (b) To keep a newer DENIAL, delete the binding or set active = false: the old '
      'model states agent access per PROJECT and cannot say that one binding of a provider is '
      'denied while another is granted, so there is no map edit that expresses it. (c) To deny '
      'the provider across the WHOLE project, edit the image rather than the map - UPDATE '
      'iss1071_removed_mcp_sentinels SET value = to_jsonb(false) for that project_id, scope and '
      'server_name - because section 3 replays the image, then update iss1071_agent_access_set '
      'to match. A core-mediated grant had no representation in the old model at all and is lost '
      'on the way back whichever of the three is taken.', n, moved;
  END IF;
END $$;

-- === 1b. refuse a DENIAL the old model cannot say ========================
--
-- Refusal 1 asks whether a grant moved AWAY from what 0259 set. This one asks the other
-- question, which that check reads as a pass: a binding created AFTER the forward run has no
-- image row, so its baseline is the column default `none` and it matches. The comment above
-- called that "losing nothing", and it is exactly backwards. Going back does not take access
-- away from such a row, it ADDS it: the old model had no way to deny a single binding, so a
-- core-mediated one an operator deliberately left closed becomes agent-callable the moment the
-- column is dropped, and a direct-MCP one becomes injectable as soon as another binding's
-- restored `<provider>: true` sentinel re-enables its project's whole active set.
--
-- That is the forward file's own rule run backwards: a row the old schema cannot represent
-- stops the rollback naming the row, rather than being dropped so the DDL succeeds.
--
-- cm:guard the kinds below are 0259's own classification, copied deliberately. The forward file
-- builds `iss1071_provider_agent_path` and DROPS it at the end, so it is not here to read, and
-- this file is a photograph pinned to that migration — a provider added later is not one 0259
-- ever classified, and falls to the `IS NULL` arm, which refuses rather than assumes.
--
-- `b.active` is part of the predicate, not an oversight: an inactive binding injects nothing and
-- answers nothing, so going back adds no access to it and there is nothing to refuse. It is also
-- what makes "deactivate it" a way out this message can honestly offer — and a refusal whose
-- advertised escape does not clear it is the affordance defect that teaches operators to reach
-- for the one escape that always works, which is deleting the check.
DO $$
DECLARE denied text; n int;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s, agent path %s)',
                           b.id, p.slug, b.provider, coalesce(k.kind, 'UNKNOWN to 0259')),
                    ', ' ORDER BY b.id), count(*)
    INTO denied, n
    FROM integration_bindings b
    JOIN projects p ON p.id = b.project_id
    LEFT JOIN iss1071_agent_access_set a ON a.binding_id = b.id
    LEFT JOIN (VALUES
      ('coolify', 'core-mediated'), ('google', 'core-mediated'),
      ('postman', 'direct-mcp'), ('sentry', 'direct-mcp'), ('epodsystem', 'direct-mcp'),
      ('rocketchat', 'none'), ('github', 'none'), ('agent', 'none')
    ) AS k(provider, kind) ON k.provider = b.provider
   WHERE a.binding_id IS NULL
     AND b.active
     AND b.agent_access = 'none'
     AND k.kind IS DISTINCT FROM 'none';
  IF denied IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071 rollback: % binding(s) were created after 0259 ran and are denied '
      'to agents: %. The model being restored cannot express that denial — it gates a direct-MCP '
      'provider per PROJECT, through an mcpServers sentinel, and does not gate a core-mediated '
      'one at all — so dropping the column would hand agents access somebody deliberately '
      'withheld, silently and with nothing left to show it was ever withheld. Nothing has been '
      'changed. Two ways out per row, and BOTH of them work — delete the binding, or set '
      'active = false on it, either of which leaves nothing for an agent to reach. If instead it '
      'may be reached after the rollback, say so where this file reads decisions from: INSERT it '
      'into iss1071_agent_access_set (binding_id, project_slug, provider, agent_access, forced) '
      'with agent_access ''all'', and set the column to ''all'' to match. Setting the column '
      'ALONE does not work and is not a way out: section 1 then refuses it as a grant that moved '
      'away from the image. A provider reported UNKNOWN to 0259 was added after this migration '
      'and must be decided the same way, by hand.', n, denied;
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
-- since is kept: this file puts back what 0259 took and touches nothing else.
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

-- The image tables are NOT dropped here either. They are the only record of what 0259 removed
-- and set, and an operator who rolls back at 02:00 and forward again at 09:00 needs to be able
-- to read them in between. 0259 begins with `DROP TABLE IF EXISTS` on both, so a re-run derives
-- them fresh and cannot be poisoned by what is left here.

COMMIT;
