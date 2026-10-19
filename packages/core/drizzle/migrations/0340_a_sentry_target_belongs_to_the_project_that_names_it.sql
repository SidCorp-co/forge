-- ISS-1380 — a Sentry target lives on the binding that names it, not on the connection many share.
--
-- `targets` (the Sentry projects an agent may read) was stored on the CONNECTION, and every project
-- bound to that connection resolved, read and was prompted with the whole list: with `agent_access`
-- 'all' on two bindings, project A's agent could name project B's target and read B's Sentry issues.
-- The code now takes `targets` from the binding alone. This moves each connection's existing targets
-- onto the binding that was inheriting them, so no project loses a target it had.
--
-- DATA ONLY. No DDL, no snapshot: `integration_connections.config` and `integration_bindings.config`
-- are jsonb, and the only rows touched are Sentry's.
--
-- WHICH BINDING GETS THEM. A binding that already holds its own `targets` key was never reading the
-- connection's list (the binding's wins in `effectiveConfig`, and an explicitly EMPTY list wins too:
-- that binding resolved none), so it is left as it is. The bindings WITHOUT one are the ones
-- inheriting; where some are active only those count, and an inactive one passed over is named in a
-- NOTICE, since it keeps no target. The one exception is the legacy pair below,
-- which an empty `targets: []` on the binding did NOT override, so there an empty list still inherits.
-- Then:
--   exactly one inheriting binding  -> the connection's targets move onto it.
--   no binding inheriting, some exist (every one holds its own) -> the connection's copy was overridden
--                                       everywhere; it is removed, and a NOTICE says so.
--   several inheriting, or the connection has no binding at all -> THE DEPLOY ABORTS NAMING THE
--                                       CONNECTION. Which project owns which target cannot be known from
--                                       this data; copying the list to every binding would keep exactly
--                                       the reach this change removes, and dropping it would lose it.
--                                       Giving each of its bindings its own `config.targets` clears it:
--                                       the migration then removes the connection's overridden copy.
--
-- THE LEGACY PAIR. A connection with `organizationSlug` / `projectSlug` and no (or an empty) `targets`
-- resolved one target labelled `default` from them. That target is written onto the binding with only
-- the slugs the connection had, so it keeps resolving. Where `targets` is non-empty the pair was never
-- read; it is removed with the rest and a NOTICE names the connection. That removal is the one thing
-- this migration does that running it backwards does not put back, and nothing ever read it.
--
-- Beta, read-only on 2026-10-14: 285258bc (anhome) and 3f651769 (forge) hold one binding each and are
-- assigned; 618c5684 holds 11 targets for 5 bound projects and aborts until each of those bindings
-- carries its own.
--
-- ROLLBACK: revert the code and keep this migration. The previous release reads `connection.config`
-- under `binding.config`, so targets held on the binding still resolve for it.

DO $iss1380$
DECLARE
  conn record;
  moving jsonb;
  has_targets boolean;
  inheriting uuid[];
  total_bindings integer;
  detail text;
BEGIN
  FOR conn IN
    SELECT id, display_name, config
      FROM integration_connections
     WHERE provider = 'sentry'
       AND (config ? 'targets' OR config ? 'organizationSlug' OR config ? 'projectSlug')
     ORDER BY created_at, id
  LOOP
    IF conn.config ? 'targets' AND jsonb_typeof(conn.config -> 'targets') NOT IN ('array', 'null') THEN
      RAISE EXCEPTION 'ISS-1380: Sentry connection % (%) holds a `targets` that is a %, not a list, so its targets cannot be placed on a binding. Correct it to a list of {label, organizationSlug, projectSlug} and redeploy.',
        conn.id, coalesce(conn.display_name, 'unnamed'), jsonb_typeof(conn.config -> 'targets');
    END IF;

    has_targets := CASE WHEN jsonb_typeof(conn.config -> 'targets') = 'array'
                        THEN jsonb_array_length(conn.config -> 'targets') > 0 ELSE false END;

    IF has_targets THEN
      moving := conn.config -> 'targets';
      IF (conn.config ->> 'organizationSlug') IS NOT NULL OR (conn.config ->> 'projectSlug') IS NOT NULL THEN
        RAISE NOTICE 'ISS-1380: Sentry connection % keeps no legacy organizationSlug/projectSlug: its non-empty targets were always read in their place', conn.id;
      END IF;
    ELSIF coalesce(conn.config ->> 'organizationSlug', '') <> '' OR coalesce(conn.config ->> 'projectSlug', '') <> '' THEN
      moving := jsonb_build_array(
        jsonb_strip_nulls(jsonb_build_object(
          'label', 'default',
          'organizationSlug', nullif(conn.config ->> 'organizationSlug', ''),
          'projectSlug', nullif(conn.config ->> 'projectSlug', '')
        ))
      );
    ELSE
      moving := NULL;
    END IF;

    IF moving IS NOT NULL THEN
      SELECT count(*) INTO total_bindings FROM integration_bindings WHERE connection_id = conn.id;

      SELECT coalesce(array_agg(b.id ORDER BY b.created_at, b.id), ARRAY[]::uuid[]) INTO inheriting
        FROM integration_bindings b
       WHERE b.connection_id = conn.id
         AND NOT (CASE WHEN jsonb_typeof(b.config -> 'targets') = 'array' THEN (has_targets OR jsonb_array_length(b.config -> 'targets') > 0) ELSE false END)
         AND (b.active OR NOT EXISTS (
               SELECT 1 FROM integration_bindings a
                WHERE a.connection_id = conn.id AND a.active
                  AND NOT (CASE WHEN jsonb_typeof(a.config -> 'targets') = 'array' THEN (has_targets OR jsonb_array_length(a.config -> 'targets') > 0) ELSE false END)));

      IF cardinality(inheriting) > 1 OR total_bindings = 0 THEN
        SELECT string_agg(format('binding %s (project %s, %s)', b.id, b.project_id,
                                 CASE WHEN b.active THEN 'active' ELSE 'inactive' END), '; ' ORDER BY b.created_at, b.id)
          INTO detail
          FROM integration_bindings b WHERE b.connection_id = conn.id;
        RAISE EXCEPTION 'ISS-1380: Sentry connection % (%, host %) holds % target(s) that cannot be assigned to exactly one binding: %. Which project owns which target cannot be told from this data, and copying them to every binding would keep the cross-project reach this change removes. Give each of its bindings its own config.targets (a binding holding its own is not inheriting; the connection''s copy is then removed) and redeploy. Nothing was changed.',
          conn.id, coalesce(conn.display_name, 'unnamed'), coalesce(conn.config ->> 'host', 'unset'),
          jsonb_array_length(moving),
          coalesce(detail, 'no binding at all');
      ELSIF cardinality(inheriting) = 1 THEN
        UPDATE integration_bindings
           SET config = config || jsonb_build_object('targets', moving), updated_at = now()
         WHERE id = inheriting[1];
        SELECT string_agg(format('binding %s (project %s)', b.id, b.project_id), '; ' ORDER BY b.created_at, b.id)
          INTO detail
          FROM integration_bindings b
         WHERE b.connection_id = conn.id AND b.id <> inheriting[1] AND NOT b.active
           AND NOT (CASE WHEN jsonb_typeof(b.config -> 'targets') = 'array' THEN (has_targets OR jsonb_array_length(b.config -> 'targets') > 0) ELSE false END);
        IF detail IS NOT NULL THEN
          RAISE NOTICE 'ISS-1380: Sentry connection % moved its targets onto active binding %; inactive % inherited them too and is left with no target, so turning it back on needs its own config.targets',
            conn.id, inheriting[1], detail;
        END IF;
      ELSE
        RAISE NOTICE 'ISS-1380: Sentry connection % holds targets every one of its % binding(s) already overrides with its own; the connection''s copy is removed', conn.id, total_bindings;
      END IF;
    END IF;

    UPDATE integration_connections
       SET config = config - 'targets' - 'organizationSlug' - 'projectSlug', updated_at = now()
     WHERE id = conn.id;
  END LOOP;
END
$iss1380$;
