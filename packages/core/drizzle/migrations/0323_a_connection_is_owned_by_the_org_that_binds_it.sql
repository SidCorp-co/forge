-- ISS-1216 — a GitHub App minted before ISS-1115 stops being one person's.
--
-- Until ISS-1115 a GitHub App created from a project's Connect button was owned by whoever pressed
-- it (`owner_type = 'user'`), although it is bound to the project, used by its runners and shared
-- by that project's admins. ISS-1115 made a NEW App belong to the project's org and left the
-- existing ones where they were, so those stay reachable by one individual's principal only.
--
-- Data only: no column, constraint or index changes, so every row stays representable as it is.
-- That is why a row this cannot re-own is NAMED and left alone rather than aborting the deploy —
-- `dist/db/migrate.js` runs before the server in the same container command, so an abort here
-- would stop the API booting (the lesson 0304 carries). Nothing is deleted or rewritten except the
-- two owner columns of the rows below, and the other doors no longer need the owner to be the
-- reader: `integrations/reach.ts` gives the admins of a bound project the sight of it.
--
-- A connection is re-owned when ALL of these hold, so nobody loses a right they held:
--   * it is a github connection owned by an individual;
--   * every binding it has — any active state — sits on a project of ONE organization;
--   * that organization is not a personal one (a solo operator's App is rightly theirs);
--   * the individual who owns it is an owner or admin of that organization, so they keep the
--     right to change it.
-- Each re-owned row is NAMED with its previous owner, which is the whole of the way back:
--   UPDATE integration_connections SET owner_type = 'user', owner_id = '<previous owner>'
--    WHERE id = '<connection>';
-- Idempotent: a re-run finds the re-owned rows no longer individual-owned.
DO $$
DECLARE
  reowned record;
  left_alone record;
  moved int := 0;
  kept int := 0;
BEGIN
  FOR reowned IN
    SELECT conn.id AS connection_id, conn.owner_id AS previous_owner, shared.org_id
      FROM integration_connections conn
      JOIN (
        SELECT b.connection_id,
               (array_agg(DISTINCT p.org_id::text))[1]::uuid AS org_id,
               count(DISTINCT p.org_id) AS org_count
          FROM integration_bindings b
          JOIN projects p ON p.id = b.project_id
         GROUP BY b.connection_id
      ) shared ON shared.connection_id = conn.id
      JOIN organizations o ON o.id = shared.org_id AND o.is_personal = false
      JOIN organization_members m
        ON m.org_id = shared.org_id AND m.user_id = conn.owner_id AND m.role IN ('owner', 'admin')
     WHERE conn.provider = 'github'
       AND conn.owner_type = 'user'
       AND shared.org_count = 1
  LOOP
    UPDATE integration_connections
       SET owner_type = 'org', owner_id = reowned.org_id, updated_at = now()
     WHERE id = reowned.connection_id;
    moved := moved + 1;
    RAISE NOTICE 'ISS-1216: github connection % re-owned from user % to org %',
      reowned.connection_id, reowned.previous_owner, reowned.org_id;
  END LOOP;

  FOR left_alone IN
    SELECT conn.id AS connection_id,
           conn.owner_id,
           count(DISTINCT p.org_id) AS org_count,
           (array_agg(DISTINCT p.org_id::text))[1] AS first_org
      FROM integration_connections conn
      JOIN integration_bindings b ON b.connection_id = conn.id
      JOIN projects p ON p.id = b.project_id
      JOIN organizations o ON o.id = p.org_id
     WHERE conn.provider = 'github' AND conn.owner_type = 'user'
     GROUP BY conn.id, conn.owner_id
    HAVING bool_or(NOT o.is_personal)
  LOOP
    kept := kept + 1;
    RAISE NOTICE 'ISS-1216: github connection % stays owned by user %: %',
      left_alone.connection_id, left_alone.owner_id,
      CASE
        WHEN left_alone.org_count > 1 THEN
          'its bindings sit on projects of ' || left_alone.org_count || ' organizations, so no one org can own it'
        ELSE
          'its owner is not an owner or admin of organization ' || left_alone.first_org
      END;
  END LOOP;

  RAISE NOTICE 'ISS-1216: % github connection(s) re-owned to the org that binds them, % left with their owner and named above', moved, kept;
END $$;
