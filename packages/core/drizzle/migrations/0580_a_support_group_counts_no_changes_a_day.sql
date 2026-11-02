-- A support group counts no changes a day (ISS-876, owner 2026-11-02: no daily cap on handing
-- work). `fixesPerUserPerDay` left the `limits` of a Rocket.Chat `support` and `agent` block, whose
-- schema is strict, so a stored document still holding it would no longer validate. The key is
-- stripped from every binding's and connection's config where it stands, and a `limits` left empty
-- goes with it; a binding whose document changed takes a new revision. Nothing else changes.
--
-- ROLLBACK: none needed; the key carried a limit no code reads any more.

SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE FUNCTION pg_temp.without_daily_cap(c jsonb, block text) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(c -> block -> 'limits') IS DISTINCT FROM 'object'
      OR NOT (c -> block -> 'limits' ? 'fixesPerUserPerDay') THEN c
    WHEN (c -> block -> 'limits') - 'fixesPerUserPerDay' = '{}'::jsonb THEN c #- ARRAY[block, 'limits']
    ELSE c #- ARRAY[block, 'limits', 'fixesPerUserPerDay']
  END
$$;--> statement-breakpoint
UPDATE integration_bindings
   SET config = pg_temp.without_daily_cap(pg_temp.without_daily_cap(config, 'support'), 'agent'),
       revision = revision + 1,
       updated_at = now()
 WHERE pg_temp.without_daily_cap(pg_temp.without_daily_cap(config, 'support'), 'agent') <> config;--> statement-breakpoint
UPDATE integration_connections
   SET config = pg_temp.without_daily_cap(pg_temp.without_daily_cap(config, 'support'), 'agent'),
       updated_at = now()
 WHERE pg_temp.without_daily_cap(pg_temp.without_daily_cap(config, 'support'), 'agent') <> config;--> statement-breakpoint
DROP FUNCTION pg_temp.without_daily_cap(jsonb, text);
