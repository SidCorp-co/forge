-- ISS-1071 — whether an agent may use an integration becomes a column on the binding.
--
-- What it replaces: a sentinel key in `pipelineConfig.mcpServers`. A project opted a stage
-- into an integration by writing `postman: true` (or `sentry`, `epodsystem`,
-- `epodsystem_<label>`) into the project-default map or into a `states.<stage>.mcpServers`
-- map, and three per-provider resolvers read it at dispatch. The switch lived on a settings
-- tab away from the integration, and the only screen that edited that map offered a catalog
-- whose add-custom form refused the sentinel's only legal value — so a binding could report
-- Connected and healthy and reach no agent, with nowhere to ask why.
--
-- After this migration the grant is `integration_bindings.agent_access`, `'none' | 'all'`,
-- default `'none'`, and the sentinel keys are gone from every stored map.
--
-- DERIVED WHEN THIS RUNS, NEVER TRANSCRIBED WHEN IT WAS WRITTEN.
--
-- That is the whole lesson of 0253, which this file is otherwise modelled on. 0253 carried a
-- roster of 36 projects and 36 bindings measured the day before it shipped; the fleet moved
-- between the measurement and the deploy, and the coverage assertion it was right to have
-- fired on rows nobody had declared. Four deploys, about 85 minutes of a crash-looping beta
-- API. Every set this file reasons about — which providers exist in `integration_bindings`,
-- which projects declare a sentinel, which bindings carry a live credential — is a SELECT
-- against the database it is running in.
--
-- The one thing written down here is VOCABULARY, not a measurement: how each provider's
-- agent path is declared in `src/integrations/<provider>/adapter.ts`, which ships in this
-- same deploy and cannot move underneath it. A provider present in `integration_bindings`
-- that this file's vocabulary does not classify ABORTS by name (section 2) — that abort is
-- what keeps a provider added between writing and deploying from landing silently at `none`.
--
-- AN ASSERTION NAMES ITS ROWS. A bare constraint violation identifies one key and no row,
-- which costs the operator reading a crash loop the only thing they need.
--
-- ORDER. The sections below are not in the order a reader might expect: the before-image of
-- the sentinel maps (section 3) is built BEFORE the backfill (section 4), because the
-- backfill's rule for a `direct-mcp` provider is read out of that image rather than out of a
-- second scan of the same jsonb. One derivation, read three times — by the grant, by the
-- abort in section 5 and by the strip in section 6 — so those three cannot disagree about
-- what the fleet declared.
--
-- THE INDEX AND THE `when` ARE POSITIONAL, NOT IDENTITY. `0259` and `when: 1795564800000`
-- say only "one slot above whatever was highest when this was written". A rebase past another
-- migration invalidates both, and fixing it means FOUR things, not one: the `.sql` filename,
-- the `_journal.json` entry (idx, tag AND `when`, which is max(when) over every other entry
-- plus exactly 86400000), the `meta/NNNN_snapshot.json` filename, and a REGENERATED snapshot
-- (`pnpm db:generate` on the merged tree, keep the snapshot, discard the emitted `.sql`).
-- Renaming alone rots in silence: `migrations-journal.test.ts` checks the chain by `prevId`,
-- which a rename does not move, and the head snapshot then diffs against the wrong ancestor.
-- Nothing here is addressed by index — `mcp-sentinel-migration.test.ts` finds this file by
-- `iss1071_provider_agent_path` and its rollback by `iss1071_agent_access_set` — so a
-- renumber is those four edits and nothing else.
--
-- cm:guard the journal `when` for this entry is max(when) + 86400000 and NEVER a real
-- timestamp. `src/db/migrate.ts` reads the single highest `created_at` already applied and
-- skips every lower entry SILENTLY and forever, so a real timestamp lands below entries
-- already in the target database and the container serves new code against an old schema
-- (ISS-807).

-- === 1. the column and its rule ===========================================
-- Matches `integrationBindings.agentAccess` in `src/db/schema.ts` and
-- `agentAccessValues` / `AGENT_ACCESS_CHK` in `src/db/release-axes.ts`. The CLOSED answer is
-- the default: a binding created without anyone deciding reaches no agent.
ALTER TABLE "integration_bindings" ADD COLUMN "agent_access" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_bindings" ADD CONSTRAINT "integration_bindings_agent_access_chk" CHECK (agent_access IN ('none', 'all'));--> statement-breakpoint

-- === 2. the vocabulary, and the abort for a provider outside it ===========
--
-- The three kinds, as `capabilities.agentPath.kind` declares them:
--
--   core-mediated  coolify, google          — core makes the call; the agent asks core for it
--                                             through `forge_coolify_deploy` / `forge_google_sheets`
--   direct-mcp     postman, sentry, epodsystem — the provider's OWN MCP server, which means the
--                                             project's credential is written onto a runner box
--   none           rocketchat, github, agent — no agent path at all; the column is inert there
--
-- A real table rather than a `TEMP` one: `ON COMMIT DROP` survives only while one transaction
-- spans the whole file, and whether that holds is the migrator's business rather than this
-- file's. Dropped explicitly at the end; a failed run leaves it behind on purpose, where the
-- operator reading the abort can query it.
DROP TABLE IF EXISTS iss1071_provider_agent_path;--> statement-breakpoint
CREATE TABLE iss1071_provider_agent_path (
  provider text PRIMARY KEY,
  kind text NOT NULL
);--> statement-breakpoint

INSERT INTO iss1071_provider_agent_path (provider, kind) VALUES
  ('coolify', 'core-mediated'),
  ('google', 'core-mediated'),
  ('postman', 'direct-mcp'),
  ('sentry', 'direct-mcp'),
  ('epodsystem', 'direct-mcp'),
  ('rocketchat', 'none'),
  ('github', 'none'),
  -- `agent` carries no adapter at all; it is the provider `0253` names beside coolify and
  -- epodsystem as deploy-capable, and no agent reaches it. `none` is a reading, not a filler:
  -- there is no MCP server and no core tool for it to be granted.
  ('agent', 'none');--> statement-breakpoint

DO $$
DECLARE unknown_providers text; n int;
BEGIN
  SELECT string_agg(format('%s (%s binding(s))', g.provider, g.n), ', ' ORDER BY g.provider), count(*)
    INTO unknown_providers, n
    FROM (SELECT b.provider, count(*) AS n
            FROM integration_bindings b
            LEFT JOIN iss1071_provider_agent_path v ON v.provider = b.provider
           WHERE v.provider IS NULL
           GROUP BY b.provider) g;
  IF unknown_providers IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071: % provider(s) hold bindings and are not classified by this migration: %. '
      'Every binding needs a reading of how an agent reaches its provider, and there is no safe '
      'default: `none` would silently close a path that is open today, and `all` would silently '
      'hand a credential to a runner box. Add the provider to the VALUES list in 0259 with the '
      '`agentPath.kind` its adapter declares (core-mediated | direct-mcp | none) and redeploy. '
      'Do NOT widen a fallback.', n, unknown_providers;
  END IF;
END $$;--> statement-breakpoint

-- A stage may not be called `default`, because `scope` below uses that word for the
-- project-default map and a stage of the same name would collapse onto it — the strip in
-- section 6 would then rewrite the wrong map and the rollback would restore it there.
-- No fleet status is called `default`; if one ever is, this says so rather than guessing.
DO $$
DECLARE bad text;
BEGIN
  SELECT string_agg(format('%s (%s)', p.id, p.slug), ', ' ORDER BY p.slug) INTO bad
    FROM projects p
    CROSS JOIN LATERAL jsonb_each(
      CASE WHEN jsonb_typeof(p.agent_config #> '{pipelineConfig,states}') = 'object'
           THEN p.agent_config #> '{pipelineConfig,states}' ELSE '{}'::jsonb END) AS s
   WHERE s.key = 'default';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071: project(s) declare a pipeline stage literally named `default`: %. '
      'This migration records a removed sentinel under `scope`, where the word `default` names '
      'the PROJECT-DEFAULT mcpServers map, so a stage of that name would be indistinguishable '
      'from it and its map would be rewritten in the wrong place. Rename the stage, or widen '
      '`scope` in 0259 to carry the two apart — never let them collide.', bad;
  END IF;
END $$;--> statement-breakpoint

-- === 3. the before-image of every sentinel, taken before anything moves ====
--
-- NOT DROPPED AT THE END, and that is deliberate. `0259_down.sql` restores the stored maps
-- from this table, and a grant cannot be inverted back into one: a project default, a stage
-- declaration, an explicit `false` and three different `epodsystem_*` names all collapse onto
-- one binary column. The image is the only thing that knows which of those was there.
--
-- WHAT COUNTS AS A SENTINEL: an integration name (`postman`, `sentry`, `epodsystem`, or any
-- `epodsystem_<label>`) carrying a JSON BOOLEAN. `true` is the opt-in the resolvers read;
-- `false` is a switch someone turned off, which is still a sentinel and still has to go.
--
-- An OBJECT under one of those names is a custom server spec someone wrote by hand and is
-- left completely alone — `isIntegrationSentinelName` is about the name, but only a literal
-- boolean is the shorthand. Catalog names (`playwright`, `chrome-devtools-mcp`) are not
-- touched at all. Anything else under an integration name — a string, a number, a null, an
-- array — is a shape `pipeline-config-schema.ts` refuses, so it is neither removed nor
-- granted on; it is announced by NOTICE at the end rather than quietly repaired, because
-- silently fixing malformed config this migration was not asked to touch is the same defect
-- as silently defaulting a row.
DROP TABLE IF EXISTS iss1071_removed_mcp_sentinels;--> statement-breakpoint
CREATE TABLE iss1071_removed_mcp_sentinels (
  project_id uuid,
  project_slug text,
  scope text,
  server_name text,
  value jsonb,
  removed_at timestamptz DEFAULT now()
);--> statement-breakpoint

INSERT INTO iss1071_removed_mcp_sentinels (project_id, project_slug, scope, server_name, value)
SELECT p.id, p.slug, 'default', e.key, e.value
  FROM projects p
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(p.agent_config #> '{pipelineConfig,mcpServers}') = 'object'
         THEN p.agent_config #> '{pipelineConfig,mcpServers}' ELSE '{}'::jsonb END) AS e
 WHERE (e.key IN ('postman', 'sentry', 'epodsystem') OR left(e.key, 11) = 'epodsystem_')
   AND jsonb_typeof(e.value) = 'boolean';--> statement-breakpoint

INSERT INTO iss1071_removed_mcp_sentinels (project_id, project_slug, scope, server_name, value)
SELECT p.id, p.slug, s.key, e.key, e.value
  FROM projects p
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(p.agent_config #> '{pipelineConfig,states}') = 'object'
         THEN p.agent_config #> '{pipelineConfig,states}' ELSE '{}'::jsonb END) AS s
  CROSS JOIN LATERAL jsonb_each(
    CASE WHEN jsonb_typeof(s.value #> '{mcpServers}') = 'object'
         THEN s.value #> '{mcpServers}' ELSE '{}'::jsonb END) AS e
 WHERE (e.key IN ('postman', 'sentry', 'epodsystem') OR left(e.key, 11) = 'epodsystem_')
   AND jsonb_typeof(e.value) = 'boolean';--> statement-breakpoint

-- === 4. the backfill — today's reachability, exactly ======================
--
-- CORE-MEDIATED GETS `all`, EVERY ROW. `forge_coolify_deploy` and `forge_google_sheets`
-- answer any project member's agent today with no gate at all — no sentinel, no map, nothing
-- to read. `none` here would not be preserving a state, it would be TAKING AWAY a path that
-- is open, on every coolify and google binding in the fleet, in a migration nobody asked to
-- change behaviour. Unqualified by `active` on purpose: `listAgentGrantedBindings` still
-- filters an inactive binding and an inactive connection, so a grant on one reaches nothing
-- and a re-activation does not silently become a decision this migration made.
UPDATE integration_bindings b
   SET agent_access = 'all'
  FROM iss1071_provider_agent_path v
 WHERE v.provider = b.provider
   AND v.kind = 'core-mediated';--> statement-breakpoint

-- DIRECT-MCP GETS `all` ONLY WHERE THE PROJECT DECLARED IT, at its own default map — which is
-- precisely the condition the three resolvers read today. A stage-scoped declaration is NOT
-- this rule: it is section 5's question, because a column with no stage axis cannot hold it.
--
-- `epodsystem` matches on any `epodsystem_<label>` key as well as the bare name. That is a
-- widening WITHIN one provider on one project — a labelled sentinel named one store and the
-- column grants every epodsystem binding the project holds — and it is announced by NOTICE in
-- section 7 rather than left for someone to find. The narrower reading is unavailable: the
-- label-to-server-name map (`labelToMcpSuffix`, dashes to underscores) is not injective, and
-- a grant derived through a non-injective map is a guess wearing a rule's clothes.
UPDATE integration_bindings b
   SET agent_access = 'all'
  FROM iss1071_provider_agent_path v
 WHERE v.provider = b.provider
   AND v.kind = 'direct-mcp'
   AND EXISTS (
     SELECT 1 FROM iss1071_removed_mcp_sentinels s
      WHERE s.project_id = b.project_id
        AND s.scope = 'default'
        AND s.value = 'true'::jsonb
        AND CASE WHEN left(s.server_name, 11) = 'epodsystem_' THEN 'epodsystem' ELSE s.server_name END = b.provider);--> statement-breakpoint

-- A `none`-path provider keeps the column's own default. Nothing is written here, because
-- there is nothing to write: rocketchat, github and agent have no agent path, so the column
-- is inert on them and `grantHolds` refuses whatever it reads.

-- What this migration SET, so the way back can tell a rollback from an overwrite.
--
-- `0259_down.sql` has to restore the maps and drop the column, and it may only do that while
-- the column still says what this run left. A grant somebody changed afterwards is a decision
-- the image cannot represent — the map it would restore is not the state that grant came
-- from — so the rollback refuses by name rather than guessing. This table is how it knows.
-- Kept for the same reason as the image above.
DROP TABLE IF EXISTS iss1071_agent_access_set;--> statement-breakpoint
CREATE TABLE iss1071_agent_access_set (
  binding_id uuid PRIMARY KEY,
  project_slug text NOT NULL,
  provider text NOT NULL,
  agent_access text NOT NULL,
  forced boolean NOT NULL,
  set_at timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

INSERT INTO iss1071_agent_access_set (binding_id, project_slug, provider, agent_access, forced)
SELECT b.id, p.slug, b.provider, b.agent_access, v.kind = 'core-mediated'
  FROM integration_bindings b
  JOIN projects p ON p.id = b.project_id
  JOIN iss1071_provider_agent_path v ON v.provider = b.provider;--> statement-breakpoint

-- === 5. the one shape a binary grant cannot represent =====================
--
-- A project that declares a direct-MCP sentinel on SOME stage, does NOT declare it at the
-- project default, and holds an active binding of that provider whose connection is active
-- and carries a credential. That is per-stage scoping actually in use: today the credential
-- reaches the named stage and no other. `all` would widen a live credential to stages that
-- never had it; `none` would break a lane somebody is working in. Neither is preservation,
-- and the column has no third value — by design, because a scope nothing reads is how the
-- sentinel became a switch nobody could find.
--
-- THE BOUNDARY, AND IT IS THE WHOLE POINT. A stage-only sentinel over NO such binding is
-- REPRESENTABLE and must not abort: nothing was reachable, so `none` is exactly what was
-- true, the sentinel is removed and the project loses nothing. An abort that fired there
-- would be an over-broad abort, which is the shape that crash-loops a deploy.
--
-- Measured 2026-09-17, over the 36 of ~48 fleet projects one credential could see: three
-- carry a sentinel (mowment, pixelight, butlocs, all `epodsystem`, all at the project
-- default) and ZERO carry a per-stage declaration or a per-stage `false`. So this is expected
-- to fire on nothing. It is still derived at run time, because 12 projects were invisible to
-- that measurement and the fleet moves — which is the whole of what 0253 paid to learn.
DO $$
DECLARE scoped text; n int;
BEGIN
  SELECT string_agg(format('%s / %s (stage %L declares %L, binding %s)',
                           x.slug, x.provider, x.scope, x.server_name, x.binding_id),
                    ', ' ORDER BY x.slug, x.provider, x.scope, x.binding_id), count(*)
    INTO scoped, n
    FROM (
      SELECT DISTINCT p.slug, prov.provider, s.scope, s.server_name, b.id AS binding_id
        FROM iss1071_removed_mcp_sentinels s
        JOIN projects p ON p.id = s.project_id
        CROSS JOIN LATERAL (
          SELECT CASE WHEN left(s.server_name, 11) = 'epodsystem_' THEN 'epodsystem'
                      ELSE s.server_name END AS provider) prov
        JOIN iss1071_provider_agent_path v ON v.provider = prov.provider AND v.kind = 'direct-mcp'
        JOIN integration_bindings b
          ON b.project_id = s.project_id AND b.provider = prov.provider AND b.active
        JOIN integration_connections c
          ON c.id = b.connection_id AND c.active AND c.secrets_enc IS NOT NULL
       WHERE s.scope <> 'default'
         AND s.value = 'true'::jsonb
         AND NOT EXISTS (
           SELECT 1 FROM iss1071_removed_mcp_sentinels d
            WHERE d.project_id = s.project_id
              AND d.scope = 'default'
              AND d.value = 'true'::jsonb
              AND CASE WHEN left(d.server_name, 11) = 'epodsystem_' THEN 'epodsystem'
                       ELSE d.server_name END = prov.provider)
    ) x;
  IF scoped IS NOT NULL THEN
    RAISE EXCEPTION 'ISS-1071: % per-stage integration grant(s) cannot be represented by a binary '
      'column: %. Each names a project that opts one STAGE into a provider whose credential is '
      'live, and does not opt the project in by default — so granting would widen that credential '
      'to stages that never had it, and closing would break a lane in use. `agent_access` has two '
      'values on purpose. The way out is a decision, not a default: either move the sentinel to '
      'the project-default `mcpServers` map (the grant then covers the project, which is what the '
      'column can say), or delete the per-stage sentinel (the lane closes, deliberately), then '
      'redeploy. Do NOT widen this assertion — a stage-only sentinel over no live binding is '
      'representable and is deliberately not named here.', n, scoped;
  END IF;
END $$;--> statement-breakpoint

-- === 6. the sentinels leave the stored maps ===============================
--
-- Only the keys section 3 recorded, and only from the map each was found in. `jsonb - text[]`
-- removes those keys and nothing else, so a catalog name, a hand-written object spec and an
-- object stored UNDER an integration name all survive byte for byte — none of them is in the
-- image, so none of them is in the key list.
DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN
    SELECT project_id, scope, array_agg(server_name) AS names
      FROM iss1071_removed_mcp_sentinels
     GROUP BY project_id, scope
  LOOP
    IF r.scope = 'default' THEN
      UPDATE projects
         SET agent_config = jsonb_set(agent_config, '{pipelineConfig,mcpServers}',
                                      (agent_config #> '{pipelineConfig,mcpServers}') - r.names)
       WHERE id = r.project_id;
    ELSE
      UPDATE projects
         SET agent_config = jsonb_set(agent_config,
                                      ARRAY['pipelineConfig', 'states', r.scope, 'mcpServers'],
                                      (agent_config #> ARRAY['pipelineConfig', 'states', r.scope, 'mcpServers']) - r.names)
       WHERE id = r.project_id;
    END IF;
    n := n + 1;
  END LOOP;
  IF n > 0 THEN
    RAISE NOTICE 'ISS-1071: cleared integration sentinels from % mcpServers map(s); the before-image '
      'is in iss1071_removed_mcp_sentinels, which 0259_down.sql restores from and this migration '
      'deliberately does not drop.', n;
  END IF;
END $$;--> statement-breakpoint

-- === 7. what an operator has to be told ===================================
--
-- 7·0. THE GRANTS NOBODY CHOSE.
--
-- Every `core-mediated` binding got `all` by force in section 4, from a rule in this file
-- rather than from anything the project declared — there WAS nothing to declare, which is the
-- defect. An operator reading the deploy log should be able to see which rows changed under
-- them, by name, without querying anything. A rule applied in silence is the same defect as a
-- default applied in silence.
DO $$
DECLARE forced text; n int;
BEGIN
  SELECT string_agg(format('%s (project %s, provider %s)', a.binding_id, a.project_slug, a.provider),
                    ', ' ORDER BY a.project_slug, a.provider, a.binding_id), count(*)
    INTO forced, n
    FROM iss1071_agent_access_set a
   WHERE a.forced AND a.agent_access = 'all';
  IF forced IS NOT NULL THEN
    RAISE NOTICE 'ISS-1071: % binding(s) take agent_access=all by FORCE rather than from a '
      'declaration, because their provider is core-mediated and reaches agents today through a '
      'core tool with no gate at all — closing them would remove a path that is open: %', n, forced;
  END IF;
END $$;--> statement-breakpoint

-- 7·1. THE GRANT A LABELLED SENTINEL WIDENED.
DO $$
DECLARE widened text; n int;
BEGIN
  SELECT string_agg(format('%s (%s epodsystem binding(s) granted from %s)', g.slug, g.bindings, g.names),
                    ', ' ORDER BY g.slug), count(*)
    INTO widened, n
    FROM (
      SELECT p.slug,
             (SELECT count(*) FROM integration_bindings b
               WHERE b.project_id = p.id AND b.provider = 'epodsystem' AND b.agent_access = 'all') AS bindings,
             string_agg(DISTINCT s.server_name, ' + ' ORDER BY s.server_name) AS names
        FROM iss1071_removed_mcp_sentinels s
        JOIN projects p ON p.id = s.project_id
       WHERE s.scope = 'default' AND s.value = 'true'::jsonb
         AND left(s.server_name, 11) = 'epodsystem_'
       GROUP BY p.id, p.slug
    ) g
   WHERE g.bindings > 1;
  IF widened IS NOT NULL THEN
    RAISE NOTICE 'ISS-1071: on % project(s) a LABELLED epodsystem sentinel granted more than one '
      'epodsystem binding, because agent_access has no label axis and the label-to-server-name map '
      'is not injective: %. Set the grant back to `none` on any binding whose store an agent should '
      'not reach — Settings -> Integrations, where the binding is.', n, widened;
  END IF;
END $$;--> statement-breakpoint

-- 7·2. AN INTEGRATION NAME CARRYING SOMETHING THAT IS NEITHER A SENTINEL NOR A SPEC.
--
-- Neither removed nor granted on, and not repaired either: `pipeline-config-schema.ts` admits
-- `true | false | object` and nothing else, so this is malformed config that predates the
-- schema check. It is named here so it does not become this migration's silent leftover.
DO $$
DECLARE odd text; n int;
BEGIN
  SELECT string_agg(format('%s / %s: %s = %s (%s)', x.slug, x.scope, x.key, x.value, x.kind),
                    ', ' ORDER BY x.slug, x.scope, x.key), count(*)
    INTO odd, n
    FROM (
      SELECT p.slug, 'default' AS scope, e.key, e.value, jsonb_typeof(e.value) AS kind
        FROM projects p
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(p.agent_config #> '{pipelineConfig,mcpServers}') = 'object'
               THEN p.agent_config #> '{pipelineConfig,mcpServers}' ELSE '{}'::jsonb END) AS e
       WHERE (e.key IN ('postman', 'sentry', 'epodsystem') OR left(e.key, 11) = 'epodsystem_')
         AND jsonb_typeof(e.value) NOT IN ('boolean', 'object')
      UNION ALL
      SELECT p.slug, s.key AS scope, e.key, e.value, jsonb_typeof(e.value) AS kind
        FROM projects p
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(p.agent_config #> '{pipelineConfig,states}') = 'object'
               THEN p.agent_config #> '{pipelineConfig,states}' ELSE '{}'::jsonb END) AS s
        CROSS JOIN LATERAL jsonb_each(
          CASE WHEN jsonb_typeof(s.value #> '{mcpServers}') = 'object'
               THEN s.value #> '{mcpServers}' ELSE '{}'::jsonb END) AS e
       WHERE (e.key IN ('postman', 'sentry', 'epodsystem') OR left(e.key, 11) = 'epodsystem_')
         AND jsonb_typeof(e.value) NOT IN ('boolean', 'object')
    ) x;
  IF odd IS NOT NULL THEN
    RAISE NOTICE 'ISS-1071: % mcpServers entr(ies) carry an integration name with a value that is '
      'neither the `true`/`false` shorthand nor an object spec, so they are LEFT EXACTLY AS THEY '
      'ARE — neither removed nor granted on: %. They are malformed against '
      '`pipeline-config-schema.ts`; fix them where the project config is edited.', n, odd;
  END IF;
END $$;--> statement-breakpoint

-- === 8. the vocabulary has done its job ===================================
-- The two image tables STAY: `0259_down.sql` is unusable without them.
DROP TABLE iss1071_provider_agent_path;
