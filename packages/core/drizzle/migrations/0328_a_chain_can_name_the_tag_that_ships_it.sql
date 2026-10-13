-- ISS-1391 / ADR 0004 — the last entry of a release chain may name the tag that ships the project.
--
-- `projects_release_chain_ok` (0312) refuses every key but `branch` and `from`. A project whose code
-- reaches production only when a `vX.Y.Z` tag containing it is cut had no truthful shape to declare,
-- so its tracker let a run close an issue no tag carried. The function now also accepts `tag`:
--   * on the LAST entry only (the one that is live), and
--   * a string of 1..100 characters from `A-Za-z0-9._/*-`, which `release-tag.ts` documents as a glob
--     where `*` matches any run of characters.
-- The zod schema (`release-chain.ts`) holds the same three rules and names them; this is the same
-- shape held where a write that goes around the API still meets it.
--
-- CLASSIFICATION: additive. `CREATE OR REPLACE` swaps one IMMUTABLE predicate for a strictly more
-- permissive one: every chain it accepted it still accepts, no row is read, rewritten or revalidated,
-- no column moves, and the previous image keeps working against it (it never writes `tag`).
-- Rollback: `drizzle/rollback/0328_down.sql`, which refuses by name while any project declares a tag.
CREATE OR REPLACE FUNCTION projects_release_chain_ok(chain jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
  SELECT chain IS NOT NULL
     AND jsonb_typeof(chain) = 'array'
     AND jsonb_array_length(chain) <= 8
     AND NOT EXISTS (
       SELECT 1
         FROM jsonb_array_elements(chain) WITH ORDINALITY AS e(v, n)
        WHERE jsonb_typeof(e.v) IS DISTINCT FROM 'object'
           OR jsonb_typeof(e.v -> 'branch') IS DISTINCT FROM 'string'
           OR length(e.v ->> 'branch') = 0
           OR (e.n = 1) = jsonb_exists(e.v, 'from')
           OR (jsonb_exists(e.v, 'from')
               AND (jsonb_typeof(e.v -> 'from') IS DISTINCT FROM 'string'
                    OR (e.v ->> 'from') NOT IN ('merge-branch', 'cherry-pick')))
           OR (jsonb_exists(e.v, 'tag')
               AND (e.n <> jsonb_array_length(chain)
                    OR jsonb_typeof(e.v -> 'tag') IS DISTINCT FROM 'string'
                    OR length(e.v ->> 'tag') NOT BETWEEN 1 AND 100
                    OR (e.v ->> 'tag') !~ '^[A-Za-z0-9._/*-]+$'))
           OR EXISTS (
                SELECT 1 FROM jsonb_object_keys(e.v) AS k
                 WHERE k NOT IN ('branch', 'from', 'tag'))
     )
     AND (SELECT count(DISTINCT v ->> 'branch') FROM jsonb_array_elements(chain) AS v)
       = jsonb_array_length(chain);
$fn$;
