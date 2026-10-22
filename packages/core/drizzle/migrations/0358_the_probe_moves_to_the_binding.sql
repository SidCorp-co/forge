-- ISS-1339 — the live commit endpoint leaves the project's environments. A release reads its probes
-- from `verify` on the live deploy binding and nowhere else, so `environments.live.commitUrl` and
-- `environments.live.commitPath` go from every row:
--
-- 1. An empty value (JSON null, '' or a path with no url) carries nothing and is removed everywhere.
-- 2. A stored url is removed where its project has an active live deploy binding on an active
--    connection, every such binding declares its own `verify`, and one of them declares a probe with
--    the same url and commitPath: those releases read the binding already, so no verdict moves.
-- 3. Any other row holding a url aborts the deploy, naming it, and nothing is written: that
--    project's release reads the stored url today, and removing it would make a probed release an
--    unverified one in silence.
--
-- Rollback: nothing to restore for 1. For 2, the url and commitPath are the binding probe the row was
-- matched against; restore one project's pair, scoped by its id, from that probe.
DO $$
DECLARE
  stray record;
  stripped integer;
  declare_this text;
BEGIN
  WITH held AS (
    SELECT p.id, p.slug,
           p.environments->'live'->>'commitUrl' AS url,
           NULLIF(p.environments->'live'->>'commitPath', '') AS path
      FROM projects p
     WHERE jsonb_typeof(p.environments->'live') = 'object'
       AND COALESCE(p.environments->'live'->>'commitUrl', '') <> ''
  ),
  live_bindings AS (
    SELECT b.project_id,
           CASE WHEN b.config ? 'verify' THEN b.config->'verify' ELSE c.config->'verify' END AS verify
      FROM integration_bindings b
      JOIN integration_connections c ON c.id = b.connection_id
     WHERE b.role = 'deploy' AND 'live' = ANY(b.stages) AND b.active AND c.active
  )
  SELECT h.id, h.slug, h.url, h.path INTO stray
    FROM held h
   WHERE NOT EXISTS (SELECT 1 FROM live_bindings l WHERE l.project_id = h.id)
      OR EXISTS (
           SELECT 1 FROM live_bindings l
            WHERE l.project_id = h.id
              AND COALESCE(jsonb_typeof(l.verify), 'null') <> 'object')
      OR NOT EXISTS (
           SELECT 1
             FROM live_bindings l
            CROSS JOIN LATERAL jsonb_array_elements(
                    CASE WHEN jsonb_typeof(l.verify->'probes') = 'array' THEN l.verify->'probes'
                         ELSE '[]'::jsonb END) AS probe
            WHERE l.project_id = h.id
              AND probe->>'url' = h.url
              AND probe->>'commitPath' IS NOT DISTINCT FROM h.path)
   ORDER BY h.slug, h.id
   LIMIT 1;
  IF FOUND THEN
    declare_this := CASE WHEN stray.path IS NULL
      THEN format('{"probes":[{"url":"%s"}]}', stray.url)
      ELSE format('{"probes":[{"url":"%s","commitPath":"%s"}]}', stray.url, stray.path) END;
    RAISE EXCEPTION '0358: project % (%) stores environments.live.commitUrl % (commitPath %), which its release still reads: no active live deploy binding of it declares that probe in verify.probes, or one of them declares no verify at all. Declare % as verify on each of its live deploy bindings, or clear the stored value, then deploy again',
      stray.slug, stray.id, stray.url, COALESCE(stray.path, '(whole body)'), declare_this;
  END IF;

  UPDATE projects
     SET environments = jsonb_set(environments, '{live}', (environments->'live') - 'commitUrl' - 'commitPath')
   WHERE jsonb_typeof(environments->'live') = 'object'
     AND (environments->'live' ? 'commitUrl' OR environments->'live' ? 'commitPath');
  GET DIAGNOSTICS stripped = ROW_COUNT;

  RAISE NOTICE '0358: environments.live.commitUrl and commitPath removed from % project row(s); every release reads its probe from the live deploy binding', stripped;
END $$;
